'use strict';
// Поиск по всей базе: значение во всех таблицах, текст в коде (процедуры, представления, триггеры), имена объектов и колонок.
const { connect } = require('../db');
const { getConnection } = require('../lib/store');
const { loadMeta } = require('../meta');

const K = x => String(x || '').toLowerCase();
const NUM = /^-?\d+(\.\d+)?$/;

/** Фрагменты текста с совпадениями: [{ line, text }] */
function matchLines(src, needle, { caseSensitive, regex } = {}) {
  const out = [];
  const re = regex ? new RegExp(needle, caseSensitive ? 'g' : 'gi') : null;
  const n = caseSensitive ? needle : needle.toLowerCase();
  String(src || '').split(/\r?\n/).forEach((l, i) => {
    const hit = re ? (re.lastIndex = 0, re.test(l)) : (caseSensitive ? l : l.toLowerCase()).includes(n);
    if (hit) out.push({ line: i + 1, text: l.trim().slice(0, 300) });
  });
  return out;
}

async function searchCode(db, schema, p) {
  const hits = [];
  const push = (type, name, src) => { const m = matchLines(src, p.text, p); if (m.length) hits.push({ type, object: name, count: m.length, lines: m.slice(0, 20) }); };
  if (db.type === 'postgres') {
    const fn = await db.query(`SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS n, CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS t, n.nspname AS s, p.prosrc AS src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ($1::text IS NULL OR n.nspname = $1) AND n.nspname NOT IN ('pg_catalog','information_schema') AND p.prolang <> 13`, [p.allSchemas ? null : schema]);
    for (const r of fn) push(r.t, `${r.s}.${r.n}`, r.src);
    const vw = await db.query(`SELECT c.relname AS n, n.nspname AS s, CASE c.relkind WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'VIEW' END AS t, pg_get_viewdef(c.oid, true) AS src
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('v','m') AND ($1::text IS NULL OR n.nspname = $1) AND n.nspname NOT IN ('pg_catalog','information_schema')`, [p.allSchemas ? null : schema]);
    for (const r of vw) push(r.t, `${r.s}.${r.n}`, r.src);
    const tg = await db.query(`SELECT t.tgname AS n, c.relname AS tb, pg_get_triggerdef(t.oid, true) AS src FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND ($1::text IS NULL OR n.nspname = $1)`, [p.allSchemas ? null : schema]);
    for (const r of tg) push('TRIGGER', `${r.tb}.${r.n}`, r.src);
    const ck = await db.query(`SELECT conname AS n, conrelid::regclass::text AS tb, pg_get_constraintdef(c.oid) AS src FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE contype = 'c' AND ($1::text IS NULL OR n.nspname = $1)`, [p.allSchemas ? null : schema]);
    for (const r of ck) push('CHECK', `${r.tb}.${r.n}`, r.src);
  } else {
    const own = p.allSchemas ? null : schema.toUpperCase();
    const rows = await db.query(`SELECT owner, name, type, line, text FROM all_source WHERE (${own ? 'owner = :o' : `owner NOT IN ('SYS','SYSTEM','XDB','MDSYS','CTXSYS','ORDSYS','WMSYS','APEX_PUBLIC_USER','DBSNMP','OUTLN','GSMADMIN_INTERNAL','LBACSYS','DVSYS','AUDSYS','OJVMSYS','ORDDATA','OLAPSYS')`}) AND ${p.caseSensitive ? 'INSTR(text, :t) > 0' : 'INSTR(UPPER(text), UPPER(:t)) > 0'} ORDER BY owner, name, type, line`, own ? { o: own, t: p.text } : { t: p.text });
    const by = new Map();
    for (const r of rows) { const k = `${r.type}|${r.owner}.${r.name}`; if (!by.has(k)) by.set(k, []); by.get(k).push({ line: Number(r.line), text: String(r.text).trim().slice(0, 300) }); }
    for (const [k, lines] of by) { const [type, object] = k.split('|'); hits.push({ type, object, count: lines.length, lines: lines.slice(0, 20) }); }
    const vw = await db.query(`SELECT owner, view_name AS n, text_vc AS src FROM all_views WHERE ${own ? 'owner = :o' : "owner NOT IN ('SYS','SYSTEM','XDB','MDSYS','CTXSYS')"}`, own ? { o: own } : {}).catch(() => []);
    for (const r of vw) push('VIEW', `${r.owner}.${r.n}`, r.src);
    const mv = await db.query(`SELECT owner, mview_name AS n, query AS src FROM all_mviews WHERE ${own ? 'owner = :o' : "owner NOT IN ('SYS','SYSTEM')"}`, own ? { o: own } : {}).catch(() => []);
    for (const r of mv) push('MATERIALIZED VIEW', `${r.owner}.${r.n}`, r.src);
    const jobs = await db.query(`SELECT owner, job_name AS n, job_action AS src FROM all_scheduler_jobs WHERE ${own ? 'owner = :o' : '1 = 1'}`, own ? { o: own } : {}).catch(() => []);
    for (const r of jobs) push('JOB', `${r.owner}.${r.n}`, r.src);
  }
  return hits;
}

async function searchValues(db, schema, meta, p, ctx) {
  const hits = [];
  const isNum = NUM.test(p.text.trim());
  const tables = p.tables && p.tables.length ? meta.tables.filter(t => p.tables.map(K).includes(K(t.name))) : meta.tables;
  const limit = Number(p.maxPerTable) || 20;
  let scanned = 0;
  for (const [i, t] of tables.entries()) {
    ctx.checkCancel();
    ctx.progress(i, tables.length, `Поиск: ${t.name}`);
    const conds = [], binds = db.type === 'oracle' ? {} : [];
    const bind = v => { if (db.type === 'oracle') { const k = `b${Object.keys(binds).length}`; binds[k] = v; return `:${k}`; } binds.push(v); return `$${binds.length}`; };
    const cols = [];
    for (const c of t.columns) {
      if (['string', 'text'].includes(c.family) || (c.family === 'json' && !p.exact)) {
        const col = db.quote(c.name);
        const expr = db.type === 'postgres' && c.family === 'json' ? `${col}::text` : col;
        if (p.exact) conds.push(`${expr} = ${bind(p.text)}`);
        else conds.push(p.caseSensitive ? `${expr} LIKE ${bind(`%${p.text}%`)}` : db.type === 'postgres' ? `${expr} ILIKE ${bind(`%${p.text}%`)}` : `UPPER(${expr}) LIKE UPPER(${bind(`%${p.text}%`)})`);
        cols.push(c.name);
      } else if (isNum && ['int', 'numeric', 'float'].includes(c.family)) {
        conds.push(`${db.quote(c.name)} = ${bind(Number(p.text))}`); cols.push(c.name);
      }
    }
    if (!conds.length) continue;
    scanned++;
    const sql = `SELECT * FROM ${db.qualify(schema, t.name)} WHERE ${conds.join(' OR ')}`;
    try {
      const r = await db.fetchAll(db.type === 'postgres' ? `${sql} LIMIT ${limit}` : `SELECT * FROM (${sql}) WHERE ROWNUM <= ${limit}`, limit, binds);
      if (!r.rows.length) continue;
      const needle = p.caseSensitive ? p.text : p.text.toLowerCase();
      const matched = new Set();
      for (const row of r.rows) r.columns.forEach((c, j) => { const v = row[j]; if (v != null && (p.exact ? String(v) === p.text : (p.caseSensitive ? String(v) : String(v).toLowerCase()).includes(needle))) matched.add(c); });
      hits.push({ table: t.name, columns: [...matched], rows: r.rows.length, more: r.rows.length >= limit, sample: r.rows.slice(0, 5).map(row => Object.fromEntries(r.columns.map((c, j) => [c, row[j] instanceof Date ? row[j].toISOString() : row[j]]))), sql: sql.replace(/\$\d+|:b\d+/g, () => (isNum ? p.text : `'%${p.text}%'`)) });
    } catch (e) { ctx.log(`${t.name}: ${e.message.split('\n')[0]}`, 'warning'); }
  }
  return { hits, scanned };
}

async function runSearch(p, ctx) {
  if (!p.text || !String(p.text).trim()) throw new Error('Введите, что искать');
  const conn = getConnection(p.connId);
  const db = await connect(conn);
  try {
    const mode = p.mode || 'value';
    if (mode === 'code') {
      const hits = await searchCode(db, p.schema, p);
      ctx.log(`Найдено в ${hits.length} объектах`);
      return { summary: { mode, objects: hits.length, lines: hits.reduce((s, h) => s + h.count, 0) }, hits };
    }
    const meta = await loadMeta(db, p.schema, {}, null);
    if (mode === 'name') {
      const n = p.text.toLowerCase();
      const hits = [];
      for (const t of meta.tables) {
        if (K(t.name).includes(n)) hits.push({ type: 'TABLE', object: t.name, detail: `${t.columns.length} колонок` });
        for (const c of t.columns) if (K(c.name).includes(n) || K(c.comment).includes(n)) hits.push({ type: 'COLUMN', object: `${t.name}.${c.name}`, detail: c.type });
      }
      for (const v of meta.views) if (K(v.name).includes(n)) hits.push({ type: 'VIEW', object: v.name });
      for (const r of meta.routines) if (K(r.name).includes(n)) hits.push({ type: r.type || 'ROUTINE', object: r.name });
      for (const s of meta.sequences) if (K(s.name).includes(n)) hits.push({ type: 'SEQUENCE', object: s.name });
      return { summary: { mode, objects: hits.length }, hits };
    }
    const r = await searchValues(db, p.schema, meta, p, ctx);
    ctx.log(`Просмотрено таблиц: ${r.scanned}, найдено в ${r.hits.length}`);
    return { summary: { mode, tables: r.scanned, found: r.hits.length, rows: r.hits.reduce((s, h) => s + h.rows, 0) }, hits: r.hits };
  } finally { await db.close(); }
}

module.exports = { runSearch, matchLines };
