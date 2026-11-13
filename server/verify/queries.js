'use strict';
// Сравнение результатов запросов в двух базах (как Data Compare по запросам в DBeaver)
// + время выполнения: какие запросы в PostgreSQL стали медленнее.
// Источники запросов: свои пары (Oracle SQL / PostgreSQL SQL), все общие представления, топ из V$SQL / pg_stat_statements.
const crypto = require('crypto');
const { connect } = require('../db');
const { getConnection, publicConnection } = require('../lib/store');
const { canonDecimal, canonDateTime, stableJson } = require('../lib/normalize');

const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const DT_RE = /^-?\d{4}-\d\d-\d\d([ T]\d\d:\d\d(:\d\d(\.\d+)?)?)?\s*(Z|[+-]\d\d(:?\d\d)?)?$/;

// Нормализация без знания типов колонки — по самому значению
function makeGenericNorm(opts) {
  const digits = opts.floatPrecision || 15;
  return v => {
    if (v === null || v === undefined) return null;
    if (Buffer.isBuffer(v)) return 'md5:' + crypto.createHash('md5').update(v).digest('hex');
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (v instanceof Date) return canonDateTime(v);
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : canonDecimal(String(Number(v.toPrecision(digits))));
    if (typeof v === 'object') return stableJson(v);
    let s = String(v);
    if (NUM_RE.test(s.trim())) return canonDecimal(s);
    if (DT_RE.test(s.trim())) return canonDateTime(s);
    if (opts.trimTrailingSpaces) s = s.replace(/ +$/, '');
    if (s === '' && opts.emptyAsNull) return null;
    return s;
  };
}

function eqVal(a, b, tol) {
  if (a === b) return true;
  if (a === null || b === null || !(tol.abs || tol.rel)) return false;
  if (!NUM_RE.test(a) || !NUM_RE.test(b)) return false;
  const x = Number(a), y = Number(b), d = Math.abs(x - y);
  return d <= tol.abs || d <= tol.rel * Math.max(Math.abs(x), Math.abs(y));
}

async function timed(db, sql, maxRows) {
  const t0 = process.hrtime.bigint();
  const r = await db.fetchAll(sql.trim().replace(/;\s*$/, ''), maxRows);
  r.ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return r;
}

function compareResults(ra, rb, q, opts) {
  const norm = makeGenericNorm(opts);
  const tol = { abs: Number(opts.absTolerance) || 0, rel: Number(opts.relTolerance) || 0 };
  const maxDiffs = Number(opts.maxDiffs) || 50;
  const na = ra.rows.map(r => r.map(norm)), nb = rb.rows.map(r => r.map(norm));
  const res = { columnsSource: ra.columns, columnsTarget: rb.columns, missing: 0, extra: 0, different: 0, diffs: [] };
  if (ra.columns.length !== rb.columns.length) res.note = `Разное число колонок: ${ra.columns.length} и ${rb.columns.length}`;
  const cols = ra.columns.map(c => c.toLowerCase());
  const keyNames = (q.keyColumns || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const keyIdx = keyNames.map(k => cols.indexOf(k)).filter(i => i >= 0);
  const show = r => Object.fromEntries(ra.columns.map((c, i) => [c, r[i]]));
  const push = d => { if (res.diffs.length < maxDiffs) res.diffs.push(d); };
  const rowDiff = (x, y) => {
    const out = [];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if (!eqVal(x[i] ?? null, y[i] ?? null, tol)) out.push({ name: ra.columns[i] || rb.columns[i] || `#${i + 1}`, source: x[i] ?? null, target: y[i] ?? null });
    return out;
  };
  if (keyIdx.length) {
    const kf = r => keyIdx.map(i => r[i]).join('\u0001');
    const mb = new Map(nb.map(r => [kf(r), r]));
    for (const r of na) {
      const k = kf(r), o = mb.get(k);
      if (!o) { res.missing++; push({ type: 'missing_in_target', row: show(r) }); continue; }
      mb.delete(k);
      const d = rowDiff(r, o);
      if (d.length) { res.different++; push({ type: 'different', key: Object.fromEntries(keyIdx.map(i => [ra.columns[i], r[i]])), columns: d }); }
    }
    res.extra = mb.size;
    for (const r of [...mb.values()].slice(0, maxDiffs)) push({ type: 'extra_in_target', row: show(r) });
  } else if (q.ordered) {
    const n = Math.max(na.length, nb.length);
    for (let i = 0; i < n; i++) {
      if (i >= nb.length) { res.missing++; push({ type: 'missing_in_target', position: i + 1, row: show(na[i]) }); continue; }
      if (i >= na.length) { res.extra++; push({ type: 'extra_in_target', position: i + 1, row: show(nb[i]) }); continue; }
      const d = rowDiff(na[i], nb[i]);
      if (d.length) { res.different++; push({ type: 'different', position: i + 1, columns: d }); }
    }
  } else {
    // как мультимножества: порядок строк не важен
    const bag = new Map();
    for (const r of nb) { const k = JSON.stringify(r); const e = bag.get(k); if (e) e.n++; else bag.set(k, { n: 1, r }); }
    const unmatchedA = [];
    for (const r of na) {
      const k = JSON.stringify(r), e = bag.get(k);
      if (e && e.n > 0) { e.n--; continue; }
      unmatchedA.push(r);
    }
    const unmatchedB = [];
    for (const e of bag.values()) for (let i = 0; i < e.n; i++) unmatchedB.push(e.r);
    // с допуском: пробуем сопоставить оставшиеся строки попарно
    if ((tol.abs || tol.rel) && unmatchedA.length && unmatchedB.length && unmatchedA.length * unmatchedB.length < 4e6) {
      for (let i = unmatchedA.length - 1; i >= 0; i--) {
        const j = unmatchedB.findIndex(y => !rowDiff(unmatchedA[i], y).length);
        if (j >= 0) { unmatchedA.splice(i, 1); unmatchedB.splice(j, 1); }
      }
    }
    res.missing = unmatchedA.length; res.extra = unmatchedB.length;
    unmatchedA.slice(0, maxDiffs).forEach(r => push({ type: 'missing_in_target', row: show(r) }));
    unmatchedB.slice(0, maxDiffs).forEach(r => push({ type: 'extra_in_target', row: show(r) }));
  }
  return res;
}

async function runQueryCompare(p, ctx) {
  const srcConn = getConnection(p.sourceId), tgtConn = getConnection(p.targetId);
  const src = await connect(srcConn), tgt = await connect(tgtConn);
  const maxRows = Number(p.maxRows) || 200000;
  const results = [];
  try {
    const queries = [...(p.queries || [])].filter(q => q.sqlSource && q.sqlSource.trim());
    if (p.includeViews) {
      const K = x => String(x).toLowerCase();
      const vs = src.type === 'oracle'
        ? await src.query(`SELECT view_name AS name FROM all_views WHERE owner = :o ORDER BY 1`, { o: p.sourceSchema })
        : await src.query(`SELECT viewname AS name FROM pg_views WHERE schemaname = $1 ORDER BY 1`, [p.sourceSchema]);
      const vt = tgt.type === 'oracle'
        ? await tgt.query(`SELECT view_name AS name FROM all_views WHERE owner = :o`, { o: p.targetSchema })
        : await tgt.query(`SELECT viewname AS name FROM pg_views WHERE schemaname = $1`, [p.targetSchema]);
      const mt = new Map(vt.map(v => [K(v.name), v.name]));
      for (const v of vs) {
        const t = mt.get(K(v.name));
        if (!t) { results.push({ name: `VIEW ${v.name}`, status: 'error', error: 'Представления нет в приёмнике' }); continue; }
        queries.push({ name: `VIEW ${v.name}`, sqlSource: `SELECT * FROM ${src.qualify(p.sourceSchema, v.name)}`, sqlTarget: `SELECT * FROM ${tgt.qualify(p.targetSchema, t)}`, view: true });
      }
    }
    let i = 0;
    for (const q of queries) {
      ctx.checkCancel();
      ctx.progress(i++, queries.length, q.name || `Запрос ${i}`);
      const r = { name: q.name || `Запрос ${i}`, sqlSource: q.sqlSource, sqlTarget: q.sqlTarget || q.sqlSource, status: 'equal' };
      try {
        const runs = Math.max(1, Math.min(Number(p.repeat) || 1, 10));
        let ra, rb, msA = [], msB = [];
        for (let k = 0; k < runs; k++) {
          ra = await timed(src, r.sqlSource, maxRows); msA.push(ra.ms);
          rb = await timed(tgt, r.sqlTarget, maxRows); msB.push(rb.ms);
        }
        const med = a => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
        r.msSource = Math.round(med(msA) * 10) / 10; r.msTarget = Math.round(med(msB) * 10) / 10;
        r.ratio = r.msSource > 0 ? Math.round((r.msTarget / r.msSource) * 100) / 100 : null;
        r.rowsSource = ra.rows.length; r.rowsTarget = rb.rows.length;
        r.truncated = ra.truncated || rb.truncated;
        Object.assign(r, compareResults(ra, rb, q, { ...p, emptyAsNull: p.emptyAsNull ?? src.type !== tgt.type }));
        if (r.missing || r.extra || r.different || r.note) r.status = 'different';
        r.slow = r.msTarget > 100 && r.ratio != null && r.ratio >= (Number(p.slowRatio) || 2);
        if (r.slow && tgt.type === 'postgres' && p.explainSlow !== false) {
          try { r.plan = (await tgt.query(`EXPLAIN ${r.sqlTarget.replace(/;\s*$/, '')}`)).map(x => x['QUERY PLAN']).join('\n'); } catch { /* */ }
        }
        ctx.log(`${r.name}: ${r.status === 'equal' ? 'совпадает' : `отличается (нет ${r.missing}, лишних ${r.extra}, разных ${r.different})`}; ${r.msSource} мс → ${r.msTarget} мс${r.slow ? ' — МЕДЛЕННЕЕ' : ''}`, r.status === 'equal' && !r.slow ? 'info' : 'warning');
      } catch (e) {
        if (e.cancelled) throw e;
        r.status = 'error'; r.error = e.message;
        if (src.type === 'postgres') await src.exec('ROLLBACK').catch(() => {});
        if (tgt.type === 'postgres') await tgt.exec('ROLLBACK').catch(() => {});
        ctx.log(`${r.name}: ${e.message}`, 'error');
      }
      results.push(r);
      ctx.setPartialResult({ summary: summarize(results), queries: results });
    }
  } finally { await src.close(); await tgt.close(); }
  return { summary: summarize(results), source: { ...publicConnection(srcConn), schema: p.sourceSchema }, target: { ...publicConnection(tgtConn), schema: p.targetSchema }, queries: results };
}

function summarize(r) {
  return {
    queries: r.length, equal: r.filter(x => x.status === 'equal').length, different: r.filter(x => x.status === 'different').length,
    error: r.filter(x => x.status === 'error').length, slow: r.filter(x => x.slow).length,
    msSource: Math.round(r.reduce((s, x) => s + (x.msSource || 0), 0)), msTarget: Math.round(r.reduce((s, x) => s + (x.msTarget || 0), 0)),
  };
}

// Топ запросов из статистики СУБД — заготовка для набора
async function topSql(db, schema, limit = 30) {
  if (db.type === 'oracle') {
    const rows = await db.query(`
      SELECT sql_id, executions, ROUND(elapsed_time / 1000 / GREATEST(executions, 1), 1) AS avg_ms, sql_fulltext
      FROM v$sql
      WHERE parsing_schema_name = :s AND command_type = 3 AND executions > 0
        AND sql_text NOT LIKE '%v$%' AND sql_text NOT LIKE '/* SQL Analyze%'
      ORDER BY elapsed_time DESC FETCH FIRST ${Number(limit) || 30} ROWS ONLY`, { s: schema });
    return rows.map(r => ({ id: r.sql_id, executions: Number(r.executions), avgMs: Number(r.avg_ms), sql: String(r.sql_fulltext), hasBinds: /:\w+/.test(String(r.sql_fulltext)) }));
  }
  const rows = await db.query(`
    SELECT queryid::text AS id, calls, round(mean_exec_time::numeric, 1) AS avg_ms, query
    FROM pg_stat_statements WHERE query ~* '^\\s*(select|with)' ORDER BY total_exec_time DESC LIMIT ${Number(limit) || 30}`);
  return rows.map(r => ({ id: r.id, executions: Number(r.calls), avgMs: Number(r.avg_ms), sql: r.query, hasBinds: /\$\d/.test(r.query) }));
}

module.exports = { runQueryCompare, topSql, compareResults, makeGenericNorm };
