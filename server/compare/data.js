'use strict';
// Сравнение данных таблиц между любыми парами Oracle/PostgreSQL.
// Режимы:
//  merge    — потоковый merge-join двух отсортированных по ключу выборок (основной, O(1) памяти);
//  map      — если порядок сортировки в СУБД различается (кодировки/типы ключа), приёмник грузится в хеш-таблицу;
//  multiset — таблица без ключа: сравнение мультимножеств хешей строк.
const crypto = require('crypto');
const { connect } = require('../db');
const { loadMeta } = require('../meta');
const { getConnection, getSettings, publicConnection } = require('../lib/store');
const { selectExpr, orderExpr, pairMode, makeNormalizer, keyComparator } = require('../lib/normalize');
const { GROUP } = require('../lib/typemap');

class OrderMismatch extends Error {}

const MAX_SHOW = 300; // обрезка длинных значений в отчёте
const short = v => (v == null ? null : (v.length > MAX_SHOW ? v.slice(0, MAX_SHOW) + `… (${v.length} симв.)` : v));

function buildPlan(ta, tb, spec, opts, K) {
  const exclude = new Set((opts.excludeColumns || []).map(x => K(x)));
  const excl = c => exclude.has(K(c.name)) || exclude.has(K(`${ta.name}.${c.name}`));
  const mapB = new Map(tb.columns.map(c => [K(c.name), c]));
  const pairs = [];
  const onlySource = [], onlyTarget = [];
  for (const ca of ta.columns) {
    const cb = mapB.get(K(ca.name));
    if (!cb) { onlySource.push(ca.name); continue; }
    mapB.delete(K(ca.name));
    if (excl(ca)) continue;
    const isLob = ['text', 'binary', 'xml'].includes(ca.family) || ['text', 'binary', 'xml'].includes(cb.family);
    if (isLob && opts.compareLobs === false) continue;
    if (ca.dataType === 'BFILE') continue;
    const mode = pairMode(ca, cb);
    pairs.push({ name: ca.name, a: ca, b: cb, mode, normA: makeNormalizer(mode, opts, ca.isChar || cb.isChar), normB: makeNormalizer(mode, opts, ca.isChar || cb.isChar) });
  }
  for (const cb of mapB.values()) onlyTarget.push(cb.name);

  // Ключ: явно заданный → PK источника → PK приёмника → первый уникальный
  let keyNames = spec.keyColumns && spec.keyColumns.length ? spec.keyColumns
    : ta.pk ? ta.pk.columns : tb.pk ? tb.pk.columns : (ta.uniques[0] || tb.uniques[0] || {}).columns;
  keyNames = keyNames || [];
  const keys = [];
  for (const kn of keyNames) {
    const p = pairs.find(x => K(x.name) === K(kn));
    if (!p) { keys.length = 0; break; }
    keys.push(p);
  }
  const values = pairs.filter(p => !keys.includes(p));
  return { keys, values, onlySource, onlyTarget };
}

function buildSelect(db, schema, table, cols, keys, where, ordered) {
  const list = cols.map(c => selectExpr(db, c)).join(', ');
  let sql = `SELECT ${list} FROM ${db.qualify(schema, table)}`;
  if (where) sql += ` WHERE ${where}`;
  if (ordered && keys.length) sql += ` ORDER BY ${keys.map(k => orderExpr(db, k)).join(', ')}`;
  return sql;
}

async function compareTable(src, tgt, ta, tb, spec, p, ctx, maxDiffs, fetchSize, K) {
  const t0 = Date.now();
  const plan = buildPlan(ta, tb, spec, p, K);
  const res = {
    table: ta.name, targetTable: tb.name, status: 'equal', mode: '', sourceRows: 0, targetRows: 0,
    missing: 0, extra: 0, different: 0, columns: plan.keys.length + plan.values.length,
    keyColumns: plan.keys.map(k => k.name), onlySourceColumns: plan.onlySource, onlyTargetColumns: plan.onlyTarget,
    diffColumns: {}, diffs: [], ms: 0, error: null, note: '',
  };
  const all = [...plan.keys, ...plan.values];
  if (!all.length) { res.status = 'skipped'; res.note = 'Нет общих колонок'; return res; }

  const colsA = all.map(x => x.a), colsB = all.map(x => x.b);
  const keysA = plan.keys.map(x => x.a), keysB = plan.keys.map(x => x.b);
  const nk = plan.keys.length;
  const whereA = spec.sourceWhere || p.sourceWhere || '';
  const whereB = spec.targetWhere || p.targetWhere || '';

  const normRow = (row, side) => all.map((c, i) => (side === 'a' ? c.normA : c.normB)(row[i]));
  const keyObj = nr => Object.fromEntries(plan.keys.map((k, i) => [k.name, nr[i]]));
  const rowObj = nr => Object.fromEntries(all.map((c, i) => [c.name, short(nr[i])]));
  const pushDiff = (d) => { if (res.diffs.length < maxDiffs) res.diffs.push(d); };
  const compareValues = (na, nb) => {
    const cols = [];
    for (let i = nk; i < all.length; i++) {
      if (na[i] !== nb[i]) {
        cols.push({ name: all[i].name, source: short(na[i]), target: short(nb[i]) });
        res.diffColumns[all[i].name] = (res.diffColumns[all[i].name] || 0) + 1;
      }
    }
    return cols;
  };
  const tick = () => {
    ctx.checkCancel();
    ctx.progress(undefined, undefined, `${ta.name}: ${res.sourceRows} / ${res.targetRows} строк`);
  };

  // ---------- multiset: без ключа ----------
  if (!nk) {
    res.mode = 'multiset';
    res.note = 'Нет первичного/уникального ключа — сравниваются наборы строк целиком';
    const h = nr => crypto.createHash('md5').update(JSON.stringify(nr)).digest('base64');
    const bag = new Map();
    for await (const batch of tgt.stream(buildSelect(tgt, p.targetSchema, tb.name, colsB, [], whereB, false), [], fetchSize)) {
      for (const r of batch) { const k = h(normRow(r, 'b')); bag.set(k, (bag.get(k) || 0) + 1); res.targetRows++; }
      tick();
    }
    for await (const batch of src.stream(buildSelect(src, p.sourceSchema, ta.name, colsA, [], whereA, false), src.type === 'oracle' ? {} : [], fetchSize)) {
      for (const r of batch) {
        res.sourceRows++;
        const nr = normRow(r, 'a');
        const k = h(nr);
        const c = bag.get(k);
        if (c) { if (c === 1) bag.delete(k); else bag.set(k, c - 1); }
        else { res.missing++; pushDiff({ type: 'missing_in_target', key: null, row: rowObj(nr) }); }
      }
      tick();
    }
    for (const c of bag.values()) res.extra += c;
    if (res.extra && res.diffs.length < maxDiffs) {
      // второй проход по приёмнику — показать примеры лишних строк
      for await (const batch of tgt.stream(buildSelect(tgt, p.targetSchema, tb.name, colsB, [], whereB, false), [], fetchSize)) {
        for (const r of batch) {
          const nr = normRow(r, 'b');
          const k = h(nr);
          if (bag.get(k)) { bag.set(k, bag.get(k) - 1); pushDiff({ type: 'extra_in_target', key: null, row: rowObj(nr) }); }
          if (res.diffs.length >= maxDiffs) break;
        }
        if (res.diffs.length >= maxDiffs) break;
      }
    }
    finish(res, t0);
    return res;
  }

  // Совместимы ли ключи для merge-join (одинаковая «группа» типов у обеих сторон)
  const keyModes = plan.keys.map(k => k.mode);
  const mergeable = plan.keys.every(k => GROUP[k.a.family] === GROUP[k.b.family]) && !p.forceMapMode;
  const cmps = keyModes.map(m => keyComparator(m));
  const cmpKey = (x, y) => {
    for (let i = 0; i < nk; i++) {
      const a = x[i], b = y[i];
      if (a === b) continue;
      if (a === null) return 1;   // NULL в конце (ASC NULLS LAST — по умолчанию в обеих СУБД)
      if (b === null) return -1;
      const c = cmps[i](a, b);
      if (c) return c;
    }
    return 0;
  };

  if (mergeable) {
    try {
      res.mode = 'merge';
      await mergeJoin();
      finish(res, t0);
      return res;
    } catch (e) {
      if (!(e instanceof OrderMismatch)) throw e;
      ctx.log(`${ta.name}: порядок сортировки в СУБД различается (${e.message}) — переключаюсь на режим хеш-таблицы`, 'warning');
      Object.assign(res, { sourceRows: 0, targetRows: 0, missing: 0, extra: 0, different: 0, diffs: [], diffColumns: {} });
    }
  }
  res.mode = 'map';
  await mapJoin();
  finish(res, t0);
  return res;

  // ---------- merge-join ----------
  async function mergeJoin() {
    const itA = rowIter(src, buildSelect(src, p.sourceSchema, ta.name, colsA, keysA, whereA, true), 'a');
    const itB = rowIter(tgt, buildSelect(tgt, p.targetSchema, tb.name, colsB, keysB, whereB, true), 'b');
    try {
      await mergeLoop(itA, itB);
    } finally {
      // закрыть курсоры, даже если вышли по ошибке/отмене
      await itA.return().catch(() => {}); await itB.return().catch(() => {});
    }
  }

  async function mergeLoop(itA, itB) {
    let a = await itA.next(), b = await itB.next();
    let prevA = null, prevB = null, n = 0;
    while (!a.done || !b.done) {
      if (++n % 5000 === 0) tick();
      if (!a.done && prevA && cmpKey(prevA, a.value) > 0) throw new OrderMismatch('источник');
      if (!b.done && prevB && cmpKey(prevB, b.value) > 0) throw new OrderMismatch('приёмник');
      let c;
      if (a.done) c = 1; else if (b.done) c = -1; else c = cmpKey(a.value, b.value);
      if (c === 0) {
        const cols = compareValues(a.value, b.value);
        if (cols.length) { res.different++; pushDiff({ type: 'different', key: keyObj(a.value), columns: cols }); }
        prevA = a.value; prevB = b.value;
        res.sourceRows++; res.targetRows++;
        a = await itA.next(); b = await itB.next();
      } else if (c < 0) {
        res.missing++; pushDiff({ type: 'missing_in_target', key: keyObj(a.value), row: rowObj(a.value) });
        res.sourceRows++; prevA = a.value; a = await itA.next();
      } else {
        res.extra++; pushDiff({ type: 'extra_in_target', key: keyObj(b.value), row: rowObj(b.value) });
        res.targetRows++; prevB = b.value; b = await itB.next();
      }
    }
  }

  // ---------- хеш-таблица ----------
  async function mapJoin() {
    const sep = '\u0001';
    const keyStr = nr => nr.slice(0, nk).map(v => (v === null ? '\u0000' : v)).join(sep);
    const valHash = nr => crypto.createHash('md5').update(JSON.stringify(nr.slice(nk))).digest('base64');
    const target = new Map();
    for await (const batch of tgt.stream(buildSelect(tgt, p.targetSchema, tb.name, colsB, [], whereB, false), [], fetchSize)) {
      for (const r of batch) { const nr = normRow(r, 'b'); target.set(keyStr(nr), valHash(nr)); res.targetRows++; }
      tick();
    }
    const needDetail = new Map(); // key -> source normalized row (для расшифровки отличий)
    for await (const batch of src.stream(buildSelect(src, p.sourceSchema, ta.name, colsA, [], whereA, false), src.type === 'oracle' ? {} : [], fetchSize)) {
      for (const r of batch) {
        res.sourceRows++;
        const nr = normRow(r, 'a');
        const k = keyStr(nr);
        const hb = target.get(k);
        if (hb === undefined) { res.missing++; pushDiff({ type: 'missing_in_target', key: keyObj(nr), row: rowObj(nr) }); continue; }
        target.delete(k);
        if (hb !== valHash(nr)) {
          res.different++;
          if (needDetail.size < maxDiffs) needDetail.set(k, nr);
        }
      }
      tick();
    }
    res.extra = target.size;
    const extraKeys = new Set([...target.keys()].slice(0, maxDiffs));
    if (needDetail.size || extraKeys.size) {
      for await (const batch of tgt.stream(buildSelect(tgt, p.targetSchema, tb.name, colsB, [], whereB, false), [], fetchSize)) {
        for (const r of batch) {
          const nb = normRow(r, 'b');
          const k = keyStr(nb);
          if (needDetail.has(k)) pushDiff({ type: 'different', key: keyObj(nb), columns: compareValues(needDetail.get(k), nb) });
          else if (extraKeys.has(k)) pushDiff({ type: 'extra_in_target', key: keyObj(nb), row: rowObj(nb) });
        }
        tick();
      }
    }
  }

  async function* rowIter(db, sql, side) {
    for await (const batch of db.stream(sql, db.type === 'oracle' ? {} : [], fetchSize)) {
      for (const r of batch) yield normRow(r, side);
    }
  }
}

function finish(res, t0) {
  res.ms = Date.now() - t0;
  res.status = res.missing || res.extra || res.different ? 'different' : 'equal';
}

async function runDataCompare(p, ctx) {
  const settings = getSettings();
  const srcConn = getConnection(p.sourceId);
  const tgtConn = getConnection(p.targetId);
  const K = p.caseSensitive ? (x => String(x)) : (x => String(x).toLowerCase());
  const maxDiffs = Number(p.maxDiffs || settings.maxDiffsPerTable || 200);
  const fetchSize = Number(settings.fetchSize || 2000);
  const parallel = Math.max(1, Math.min(Number(p.parallel || 2), 8));
  const opts = { ...p, emptyAsNull: p.emptyAsNull ?? srcConn.type !== tgtConn.type };

  ctx.log(`Источник: ${srcConn.name} / ${p.sourceSchema}; приёмник: ${tgtConn.name} / ${p.targetSchema}`);
  ctx.progress(0, 0, 'Чтение структуры таблиц…');
  let A, B;
  {
    const [s, t] = await Promise.all([connect(srcConn), connect(tgtConn)]);
    try {
      [A, B] = await Promise.all([loadMeta(s, p.sourceSchema, {}, null), loadMeta(t, p.targetSchema, {}, null)]);
    } finally { await Promise.all([s.close(), t.close()]); }
  }
  const mapA = new Map(A.tables.map(t => [K(t.name), t]));
  const mapB = new Map(B.tables.map(t => [K(t.name), t]));

  // Список таблиц: явно заданные или все общие
  let specs = (p.tables && p.tables.length) ? p.tables.map(x => (typeof x === 'string' ? { source: x } : x))
    : A.tables.filter(t => mapB.has(K(t.name))).map(t => ({ source: t.name }));
  const results = [];
  const queue = [];
  for (const s of specs) {
    const ta = mapA.get(K(s.source));
    const tb = mapB.get(K(s.target || s.source));
    if (!ta || !tb) {
      results.push({ table: s.source, targetTable: s.target || s.source, status: 'error', error: !ta ? 'Нет в источнике' : 'Нет в приёмнике', diffs: [] });
      continue;
    }
    queue.push({ s, ta, tb });
  }
  const total = queue.length;
  let done = 0;
  ctx.progress(0, total, `Таблиц к сравнению: ${total}`);

  const sub = Object.create(ctx);
  sub.progress = (_c, _t, msg) => ctx.progress(done, total, msg);

  async function worker() {
    const [src, tgt] = await Promise.all([connect(srcConn), connect(tgtConn)]);
    try {
      while (queue.length) {
        ctx.checkCancel();
        const { s, ta, tb } = queue.shift();
        try {
          const r = await compareTable(src, tgt, ta, tb, s, opts, sub, maxDiffs, fetchSize, K);
          results.push(r);
          ctx.log(`${ta.name}: ${r.status === 'equal' ? 'совпадает' : `отличия — нет в приёмнике ${r.missing}, лишних ${r.extra}, различаются ${r.different}`} (${r.sourceRows}/${r.targetRows} строк, ${r.mode}, ${r.ms} мс)`, r.status === 'equal' ? 'info' : 'warning');
        } catch (e) {
          if (e.cancelled) throw e;
          results.push({ table: ta.name, targetTable: tb.name, status: 'error', error: e.message, diffs: [] });
          ctx.log(`${ta.name}: ошибка — ${e.message}`, 'error');
        }
        done++;
        ctx.progress(done, total, `Готово ${done} из ${total}`);
        ctx.setPartialResult({ summary: summarize(results), tables: results });
      }
    } finally { await Promise.all([src.close(), tgt.close()]); }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, total || 1) }, worker));

  results.sort((a, b) => a.table.localeCompare(b.table));
  return {
    summary: summarize(results),
    source: { ...publicConnection(srcConn), schema: p.sourceSchema },
    target: { ...publicConnection(tgtConn), schema: p.targetSchema },
    options: { emptyAsNull: opts.emptyAsNull, trimTrailingSpaces: !!opts.trimTrailingSpaces, compareLobs: opts.compareLobs !== false, maxDiffs },
    tables: results,
  };
}

function summarize(results) {
  const s = { tables: results.length, equal: 0, different: 0, error: 0, skipped: 0, sourceRows: 0, targetRows: 0, missing: 0, extra: 0, differentRows: 0 };
  for (const r of results) {
    s[r.status] = (s[r.status] || 0) + 1;
    s.sourceRows += r.sourceRows || 0; s.targetRows += r.targetRows || 0;
    s.missing += r.missing || 0; s.extra += r.extra || 0; s.differentRows += r.different || 0;
  }
  return s;
}

module.exports = { runDataCompare };
