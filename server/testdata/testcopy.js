'use strict';
// Тестовая копия: срез базы (согласованная часть по внешним ключам) и/или маскирование персональных данных.
const { connect } = require('../db');
const { getConnection } = require('../lib/store');
const { loadMeta } = require('../meta');
const { runTransfer } = require('../copy/transfer');
const { makeLiteral } = require('../compare/syncdata');
const { makeMasker, detectColumn, METHODS } = require('./mask');

const K = x => String(x || '').toLowerCase();

// ---------- поиск персональных данных ----------
async function runPiiScan(p, ctx) {
  const db = await connect(getConnection(p.sourceId));
  try {
    const meta = await loadMeta(db, p.sourceSchema, {}, null);
    const tables = p.tables && p.tables.length ? meta.tables.filter(t => p.tables.map(K).includes(K(t.name))) : meta.tables;
    const rules = [];
    for (const [i, t] of tables.entries()) {
      ctx.checkCancel();
      ctx.progress(i, tables.length, `Поиск персональных данных: ${t.name}`);
      const text = t.columns.filter(c => ['string', 'text'].includes(c.family));
      let sample = null;
      if (text.length) {
        const sql = `SELECT ${text.map(c => db.quote(c.name)).join(', ')} FROM ${db.qualify(p.sourceSchema, t.name)}`;
        sample = await db.fetchAll(db.type === 'postgres' ? `${sql} LIMIT 200` : `SELECT * FROM (${sql}) WHERE ROWNUM <= 200`, 200).catch(() => null);
      }
      for (const c of t.columns) {
        const idx = text.indexOf(c);
        const d = detectColumn(t.name, c, sample && idx >= 0 ? sample.rows.map(r => r[idx]) : null);
        if (!d) continue;
        const ex = sample && idx >= 0 ? sample.rows.map(r => r[idx]).find(v => v != null && v !== '') : null;
        const mask = makeMasker('preview')(d.method);
        rules.push({ table: t.name, column: c.name, type: c.type, method: d.method, reason: d.reason, example: ex != null ? String(ex).slice(0, 60) : null, masked: ex != null ? String(mask(ex)).slice(0, 60) : null });
      }
    }
    ctx.log(`Найдено колонок с персональными данными: ${rules.length}`);
    return { summary: { tables: tables.length, columns: rules.length }, rules, methods: METHODS };
  } finally { await db.close(); }
}

// ---------- срез ----------
/**
 * Вычисляет, какие строки каких таблиц войдут в срез.
 * Возвращает Map(таблица → { all: bool, keys: Set(JSON кортежей PK) | null, where: [условия] }).
 */
async function computeSubset(db, schema, meta, sub, ctx) {
  const byName = new Map(meta.tables.map(t => [K(t.name), t]));
  const lit = makeLiteral(db.type, { lobSkipped: 0 });
  const maxRows = Number(sub.maxRows) || 100000;
  const S = new Map(); // таблица → { all, keys:Set, pk:[cols] }
  const tq = t => db.qualify(schema, t.name);
  const keyCols = t => (t.pk ? t.pk.columns : (t.uniques && t.uniques[0] ? t.uniques[0].columns : null));
  const tupleIn = (t, cols, tuples) => {
    const cdefs = cols.map(c => t.columns.find(x => K(x.name) === K(c)) || { family: 'string' });
    const list = tuples.map(tp => (cols.length === 1 ? lit(tp[0], cdefs[0]) : `(${tp.map((v, i) => lit(v, cdefs[i])).join(', ')})`));
    const lhs = cols.length === 1 ? db.quote(cols[0]) : `(${cols.map(c => db.quote(c)).join(', ')})`;
    const parts = [];
    for (let i = 0; i < list.length; i += 1000) parts.push(`${lhs} IN (${list.slice(i, i + 1000).join(', ')})`);
    return parts.length ? `(${parts.join(' OR ')})` : '1 = 0';
  };
  const whereOf = t => {
    const s = S.get(K(t.name));
    if (!s) return null;
    if (s.all) return s.where || '1 = 1';
    return tupleIn(t, s.pk, [...s.keys].map(k => JSON.parse(k)));
  };
  const fetchTuples = async (t, cols, where, limit) => {
    const sql = `SELECT DISTINCT ${cols.map(c => db.quote(c)).join(', ')} FROM ${tq(t)} WHERE ${where} AND ${cols.map(c => `${db.quote(c)} IS NOT NULL`).join(' AND ')}`;
    const r = await db.fetchAll(sql, limit + 1);
    return r.rows.map(row => row.map(v => (v instanceof Date ? v : v)));
  };
  const addKeys = async (t, where, why) => {
    const pk = keyCols(t);
    const k = K(t.name);
    if (!pk) { if (!S.has(k)) { S.set(k, { all: true, where, why, noKey: true }); return true; } const s = S.get(k); if (s.where && s.where !== where && !s.where.includes(where)) { s.where = `(${s.where}) OR (${where})`; return true; } return false; }
    if (!S.has(k)) S.set(k, { all: false, keys: new Set(), pk, why });
    const s = S.get(k);
    if (s.all) return false;
    const before = s.keys.size;
    const rows = await fetchTuples(t, pk, where, maxRows);
    if (rows.length > maxRows) ctx.log(`${t.name}: больше ${maxRows} строк — взяты первые ${maxRows}`, 'warning');
    for (const r of rows.slice(0, maxRows)) if (s.keys.size < maxRows) s.keys.add(JSON.stringify(r));
    return s.keys.size > before;
  };

  const root = byName.get(K(sub.root));
  if (!root) throw new Error(`Таблица ${sub.root} не найдена`);
  await addKeys(root, sub.where || '1 = 1', 'корень среза');
  for (const n of sub.fullTables || []) { const t = byName.get(K(n)); if (t) S.set(K(t.name), { all: true, why: 'целиком (справочник)' }); }

  // вниз: дочерние строки выбранных
  if (sub.children !== false) {
    let frontier = [root], depth = 0;
    while (frontier.length && depth < (Number(sub.depth) || 2)) {
      const next = [];
      for (const parent of frontier) {
        for (const child of meta.tables) {
          for (const fk of child.fks || []) {
            if (K(fk.refTable) !== K(parent.name) || child === parent) continue;
            if (S.get(K(child.name)) && S.get(K(child.name)).all) continue;
            ctx.checkCancel();
            const pw = whereOf(parent); if (!pw) continue;
            const vals = await fetchTuples(parent, fk.refColumns, pw, maxRows);
            if (!vals.length) continue;
            const changed = await addKeys(child, tupleIn(child, fk.columns, vals), `строки, ссылающиеся на ${parent.name}`);
            if (changed) next.push(child);
          }
        }
      }
      frontier = next; depth++;
    }
  }
  // вверх: всё, на что ссылаются выбранные строки (замыкание)
  for (let iter = 0; iter < 30; iter++) {
    let changed = false;
    for (const [k] of [...S]) {
      const t = byName.get(k);
      for (const fk of t.fks || []) {
        const parent = byName.get(K(fk.refTable));
        if (!parent || parent === t || (S.get(K(parent.name)) && S.get(K(parent.name)).all)) continue;
        ctx.checkCancel();
        const vals = await fetchTuples(t, fk.columns, whereOf(t), maxRows);
        if (!vals.length) continue;
        if (await addKeys(parent, tupleIn(parent, fk.refColumns, vals), `на них ссылается ${t.name}`)) changed = true;
      }
    }
    if (!changed) break;
  }
  const out = new Map();
  for (const [k, s] of S) { const t = byName.get(k); out.set(t.name, { where: whereOf(t), rows: s.all ? null : s.keys.size, all: s.all, why: s.why, noKey: !!s.noKey }); }
  return out;
}

// ---------- задача «Тестовая копия» ----------
async function runTestCopy(p, ctx) {
  const src = await connect(getConnection(p.sourceId));
  let where = {}, tables = p.tables && p.tables.length ? p.tables : null, plan = [];
  try {
    const meta = await loadMeta(src, p.sourceSchema, {}, null);
    if (p.subset && p.subset.enabled) {
      ctx.progress(0, 0, 'Расчёт среза…');
      const sub = await computeSubset(src, p.sourceSchema, meta, p.subset, ctx);
      tables = [...sub.keys()];
      for (const [t, s] of sub) { if (s.where && s.where !== '1 = 1') where[t] = s.where; plan.push({ table: t, rows: s.rows, all: s.all, why: s.why, noKey: s.noKey }); }
      ctx.log(`Срез: таблиц ${tables.length}, строк по ключам ${plan.reduce((x, r) => x + (r.rows || 0), 0)} (+ таблицы целиком: ${plan.filter(r => r.all).length})`);
      const skipped = meta.tables.filter(t => !sub.has(t.name)).map(t => t.name);
      if (skipped.length) ctx.log(`Не вошли в срез (не связаны с ${p.subset.root}): ${skipped.join(', ')}`);
    }
  } finally { await src.close(); }

  // маскирование при записи
  let rowTransform = null, masked = 0;
  const rules = (p.masking && p.masking.enabled ? p.masking.rules || [] : []).filter(r => r.method && r.method !== 'keep');
  if (rules.length) {
    const masker = makeMasker(p.masking.secret || 'dbcompare-' + p.sourceId);
    const byTable = new Map();
    for (const r of rules) { if (!byTable.has(K(r.table))) byTable.set(K(r.table), new Map()); byTable.get(K(r.table)).set(K(r.column), masker(r.method, r)); }
    rowTransform = (table, columns) => {
      const m = byTable.get(K(table)); if (!m) return null;
      const fns = columns.map(c => m.get(K(c)) || null);
      if (!fns.some(Boolean)) return null;
      return row => { masked++; return row.map((v, i) => (fns[i] ? fns[i](v) : v)); };
    };
    ctx.log(`Маскирование: колонок ${rules.length} в ${byTable.size} таблицах`);
  }
  const res = await runTransfer({ ...p, tables: tables || undefined, where, rowTransform, mode: p.mode || 'truncate', createTables: p.createTables !== false, disableFk: p.disableFk !== false }, ctx);
  return { ...res, summary: { ...res.summary, maskedRows: masked, maskedColumns: rules.length, subset: !!(p.subset && p.subset.enabled) }, subset: plan };
}

module.exports = { runPiiScan, runTestCopy, computeSubset };
