'use strict';
// Быстрая сверка больших таблиц по агрегатам (как column validation в Google DVT):
// COUNT(*), COUNT/SUM/MIN/MAX по числам, MIN/MAX по датам, суммарная длина строк и LOB —
// по всей таблице или по группам (месяц/год даты или значение колонки).
// Построчное сравнение затем запускается только для разошедшихся групп.
const { connect } = require('../db');
const { loadMeta } = require('../meta');
const { filterMeta } = require('../meta/objects');
const { getConnection, publicConnection } = require('../lib/store');
const { GROUP } = require('../lib/typemap');
const { canonDecimal, canonDateTime } = require('../lib/normalize');
const { periodWhere, andWhere } = require('../lib/period');

function kindOf(ca, cb) {
  const ga = GROUP[ca.family], gb = GROUP[cb.family];
  if (ga === 'number' && gb === 'number') return (ca.family === 'float' || cb.family === 'float') ? 'float' : 'number';
  if (ga === 'datetime' && gb === 'datetime') return 'datetime';
  if (ca.family === 'binary' && cb.family === 'binary') return 'binary';
  if (ga === 'string' && gb === 'string') return 'string';
  return 'count';
}

// Выражения агрегатов для одной колонки
function aggExprs(db, c, kind, other, opts) {
  const q = db.quote(c.name);
  const t = String(c.dataType || '').toUpperCase();
  const out = [{ agg: 'count', sql: db.type === 'postgres' && kind === 'string' && opts.emptyAsNull ? `count(NULLIF(${q}::text, ''))` : `COUNT(${q})` }];
  if (kind === 'number' || kind === 'float') {
    const v = db.type === 'postgres' && c.family === 'bool' ? `${q}::int` : q;
    out.push({ agg: 'sum', sql: `SUM(${v})` }, { agg: 'min', sql: `MIN(${v})` }, { agg: 'max', sql: `MAX(${v})` });
  } else if (kind === 'datetime') {
    if (db.type === 'oracle') {
      const fmt = t === 'DATE' ? "'YYYY-MM-DD HH24:MI:SS'" : "'YYYY-MM-DD HH24:MI:SS.FF6'";
      const v = /TIME ZONE/.test(t) ? `SYS_EXTRACT_UTC(${q})` : q;
      out.push({ agg: 'min', sql: `TO_CHAR(MIN(${v}), ${fmt})` }, { agg: 'max', sql: `TO_CHAR(MAX(${v}), ${fmt})` });
    } else {
      out.push({ agg: 'min', sql: `MIN(${q})::text` }, { agg: 'max', sql: `MAX(${q})::text` });
    }
  } else if (kind === 'string') {
    const trim = c.isChar || other.isChar || opts.trimTrailingSpaces;
    if (db.type === 'oracle') {
      const len = ['CLOB', 'NCLOB'].includes(t) ? `DBMS_LOB.GETLENGTH(${q})` : (trim ? `LENGTH(RTRIM(${q}))` : `LENGTH(${q})`);
      out.push({ agg: 'len', sql: `SUM(${len})` });
    } else {
      const v = `${q}::text`;
      out.push({ agg: 'len', sql: `SUM(length(${trim ? `rtrim(${v})` : v}))` });
    }
  } else if (kind === 'binary') {
    out.push({ agg: 'len', sql: db.type === 'oracle' ? (t === 'BLOB' ? `SUM(DBMS_LOB.GETLENGTH(${q}))` : `SUM(UTL_RAW.LENGTH(${q}))`) : `SUM(octet_length(${q}))` });
  }
  return out;
}

// Выражение группы и условие WHERE для одной группы
function groupExpr(db, col, gran) {
  const q = db.quote(col.name);
  if (gran === 'value') return db.type === 'oracle' ? `TO_CHAR(${q})` : `${q}::text`;
  const unit = gran === 'year' ? 'YYYY' : 'MM';
  if (db.type === 'oracle') return `TO_CHAR(TRUNC(${q}, '${unit}'), '${gran === 'year' ? 'YYYY' : 'YYYY-MM'}')`;
  return `to_char(date_trunc('${gran === 'year' ? 'year' : 'month'}', ${q}), '${gran === 'year' ? 'YYYY' : 'YYYY-MM'}')`;
}
function groupWhere(db, col, gran, value) {
  const q = db.quote(col.name);
  if (value === null) return `${q} IS NULL`;
  const lit = `'${String(value).replace(/'/g, "''")}'`;
  if (gran === 'value') return db.type === 'oracle' ? `TO_CHAR(${q}) = ${lit}` : `${q}::text = ${lit}`;
  const start = gran === 'year' ? `${value}-01-01` : `${value}-01`;
  if (db.type === 'oracle') {
    return `${q} >= TO_DATE('${start}', 'YYYY-MM-DD') AND ${q} < ADD_MONTHS(TO_DATE('${start}', 'YYYY-MM-DD'), ${gran === 'year' ? 12 : 1})`;
  }
  return `${q} >= DATE '${start}' AND ${q} < DATE '${start}' + INTERVAL '${gran === 'year' ? '1 year' : '1 month'}'`;
}

function canon(v, kind) {
  if (v === null || v === undefined) return null;
  if (kind === 'datetime') return canonDateTime(v);
  return canonDecimal(String(v));
}
function equalVals(a, b, kind, agg, tol) {
  if (a === b) return true;
  if (a === null || b === null) {
    // SUM по пустому набору: NULL и 0 считаем равными
    return agg === 'sum' || agg === 'len' ? (a ?? '0') === (b ?? '0') : false;
  }
  if (kind === 'datetime' || agg === 'count') return false;
  const x = Number(a), y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const d = Math.abs(x - y);
  const rel = kind === 'float' ? Math.max(tol.rel, 1e-9) : tol.rel;
  return d <= tol.abs || d <= rel * Math.max(Math.abs(x), Math.abs(y));
}

async function aggTable(src, tgt, ta, tb, spec, p, K) {
  const opts = { emptyAsNull: p.emptyAsNull ?? src.type !== tgt.type, trimTrailingSpaces: !!p.trimTrailingSpaces };
  const mapB = new Map(tb.columns.map(c => [K(c.name), c]));
  const exclude = new Set((p.excludeColumns || []).map(K));
  const cols = [];
  for (const ca of ta.columns) {
    const cb = mapB.get(K(ca.name));
    if (!cb || exclude.has(K(ca.name)) || exclude.has(K(`${ta.name}.${ca.name}`))) continue;
    if (['LONG', 'LONG RAW', 'BFILE'].includes(String(ca.dataType).toUpperCase())) continue;
    const kind = kindOf(ca, cb);
    const ea = aggExprs(src, ca, kind, cb, opts), eb = aggExprs(tgt, cb, kind, ca, opts);
    cols.push({ name: ca.name, kind, a: ea, b: eb });
  }
  const gcolName = spec.groupBy || (p.groupBy && p.groupBy[ta.name]);
  const gran = spec.granularity || p.granularity || 'month';
  const ga = gcolName ? ta.columns.find(c => K(c.name) === K(gcolName)) : null;
  const gb = gcolName ? tb.columns.find(c => K(c.name) === K(gcolName)) : null;
  if (gcolName && (!ga || !gb)) throw new Error(`Колонка группировки ${gcolName} не найдена`);
  const effGran = ga && GROUP[ga.family] !== 'datetime' ? 'value' : gran;

  const periodDesc = new Set();
  const build = (db, schema, table, side, gcol) => {
    const sel = [`COUNT(*) AS c_rows`];
    cols.forEach((c, i) => (side === 'a' ? c.a : c.b).forEach((e, j) => sel.push(`${e.sql} AS c${i}_${j}`)));
    const g = gcol ? groupExpr(db, gcol, effGran) : null;
    let sql = `SELECT ${g ? `${g} AS grp, ` : ''}${sel.join(', ')} FROM ${db.qualify(schema, table)}`;
    const pw = periodWhere(db, side === 'a' ? ta : tb, p.period, side === 'a' ? 'source' : 'target');
    if (pw.applied) periodDesc.add(pw.parts.join(', '));
    const where = andWhere(side === 'a' ? (spec.sourceWhere || p.sourceWhere) : (spec.targetWhere || p.targetWhere), pw.where);
    if (where) sql += ` WHERE ${where}`;
    if (g) sql += ` GROUP BY ${g}`;
    return sql;
  };
  const t0 = Date.now();
  const [ra, rb] = await Promise.all([
    src.query(build(src, p.sourceSchema, ta.name, 'a', ga)),
    tgt.query(build(tgt, p.targetSchema, tb.name, 'b', gb)),
  ]);
  const tol = { abs: Number(p.absTolerance) || 0, rel: Number(p.relTolerance) || 0 };
  const byGroup = (rows) => new Map(rows.map(r => [r.grp === undefined ? '*' : r.grp, r]));
  const A = byGroup(ra), B = byGroup(rb);
  const keys = [...new Set([...A.keys(), ...B.keys()])].sort((x, y) => String(x).localeCompare(String(y)));
  const groups = [];
  let rowsA = 0, rowsB = 0;
  for (const g of keys) {
    const x = A.get(g), y = B.get(g);
    const diffs = [];
    const na = x ? Number(x.c_rows) : 0, nb = y ? Number(y.c_rows) : 0;
    rowsA += na; rowsB += nb;
    if (na !== nb) diffs.push({ column: '*', agg: 'count(*)', source: String(na), target: String(nb) });
    if (x && y) {
      cols.forEach((c, i) => c.a.forEach((e, j) => {
        const va = canon(x[`c${i}_${j}`], c.kind), vb = canon(y[`c${i}_${j}`], c.kind);
        if (!equalVals(va, vb, c.kind, e.agg, tol)) diffs.push({ column: c.name, agg: e.agg, source: va, target: vb });
      }));
    }
    groups.push({ group: g === '*' ? null : g, rowsSource: na, rowsTarget: nb, ok: !diffs.length, diffs });
  }
  const bad = groups.filter(g => !g.ok);
  const res = {
    table: ta.name, targetTable: tb.name, status: bad.length ? 'different' : 'equal', groupBy: gcolName || null, granularity: gcolName ? effGran : null,
    rowsSource: rowsA, rowsTarget: rowsB, groups: groups.length, badGroups: bad.length, columns: cols.length,
    diffColumns: [...new Set(bad.flatMap(g => g.diffs.map(d => d.column)))],
    periodFilter: [...periodDesc].join('; ') || undefined,
    ms: Date.now() - t0, groupsDetail: (p.showAllGroups ? groups : bad).slice(0, 500),
  };
  // Условия для построчной проверки только разошедшихся групп
  if (bad.length && ga) {
    const lim = bad.slice(0, 50);
    res.sourceWhere = lim.map(g => `(${groupWhere(src, ga, effGran, g.group)})`).join(' OR ');
    res.targetWhere = lim.map(g => `(${groupWhere(tgt, gb, effGran, g.group)})`).join(' OR ');
    if (bad.length > 50) res.note = `Для построчной проверки взяты первые 50 групп из ${bad.length}`;
  }
  return res;
}

async function runAggCompare(p, ctx) {
  const srcConn = getConnection(p.sourceId), tgtConn = getConnection(p.targetId);
  const K = x => String(x).toLowerCase();
  const src = await connect(srcConn), tgt = await connect(tgtConn);
  const results = [];
  try {
    ctx.progress(0, 0, 'Чтение структуры…');
    let A = await loadMeta(src, p.sourceSchema, {}, null);
    const B = await loadMeta(tgt, p.targetSchema, {}, null);
    const specs = (p.tables && p.tables.length ? p.tables : A.tables.map(t => t.name)).map(x => (typeof x === 'string' ? { source: x } : x));
    A = filterMeta(A, specs.map(s => ({ type: 'table', name: s.source })), K);
    const mapA = new Map(A.tables.map(t => [K(t.name), t])), mapB = new Map(B.tables.map(t => [K(t.name), t]));
    let i = 0;
    for (const s of specs) {
      ctx.checkCancel();
      ctx.progress(i++, specs.length, s.source);
      const ta = mapA.get(K(s.source)), tb = mapB.get(K(s.target || s.source));
      if (!ta || !tb) { results.push({ table: s.source, status: 'error', error: !ta ? 'Нет в источнике' : 'Нет в приёмнике' }); continue; }
      try {
        const r = await aggTable(src, tgt, ta, tb, s, p, K);
        results.push(r);
        ctx.log(`${ta.name}: ${r.status === 'equal' ? 'агрегаты совпадают' : `расхождения в ${r.badGroups} из ${r.groups} групп (${r.diffColumns.join(', ')})`} — ${r.ms} мс`, r.status === 'equal' ? 'info' : 'warning');
      } catch (e) {
        if (e.cancelled) throw e;
        results.push({ table: ta.name, status: 'error', error: e.message });
        ctx.log(`${ta.name}: ${e.message}`, 'error');
      }
      ctx.setPartialResult({ summary: summarize(results), tables: results });
    }
  } finally { await src.close(); await tgt.close(); }

  // Построчная проверка только расхождений
  let detail = null;
  if (p.detailOnMismatch) {
    const bad = results.filter(r => r.status === 'different');
    if (bad.length) {
      ctx.log(`Построчная проверка расхождений: таблиц ${bad.length}`);
      const { runDataCompare } = require('../compare/data');
      const sub = Object.create(ctx); sub.setPartialResult = () => {};
      const r = await runDataCompare({
        sourceId: p.sourceId, targetId: p.targetId, sourceSchema: p.sourceSchema, targetSchema: p.targetSchema,
        tables: bad.map(b => ({ source: b.table, target: b.targetTable, sourceWhere: b.sourceWhere, targetWhere: b.targetWhere })),
        absTolerance: p.absTolerance, relTolerance: p.relTolerance, emptyAsNull: p.emptyAsNull, period: p.period,
      }, sub);
      detail = { summary: r.summary, tables: r.tables };
    }
  }
  return {
    summary: summarize(results),
    source: { ...publicConnection(srcConn), schema: p.sourceSchema }, target: { ...publicConnection(tgtConn), schema: p.targetSchema },
    tables: results, detail,
  };
}

function summarize(r) {
  return {
    tables: r.length, equal: r.filter(x => x.status === 'equal').length, different: r.filter(x => x.status === 'different').length,
    error: r.filter(x => x.status === 'error').length, rowsSource: r.reduce((s, x) => s + (x.rowsSource || 0), 0), rowsTarget: r.reduce((s, x) => s + (x.rowsTarget || 0), 0),
  };
}

module.exports = { runAggCompare, aggExprs, groupExpr, groupWhere };
