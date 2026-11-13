'use strict';
// Юнит-тесты функций (и по желанию процедур) прямо по подключениям — методика plsql2pg без файлов:
// базовый вызов + изменение по одному параметру (не больше 60 вызовов на функцию), каждый вызов в SAVEPOINT
// с откатом, ответ Oracle — эталон. Набор с ответами Oracle можно сохранить и повторять без Oracle.
const { connect } = require('../db');
const { getConnection, publicConnection } = require('../lib/store');
const { canonDecimal, canonDateTime } = require('../lib/normalize');
const { pgRoutine } = require('./calctemplate');

const UNSUPPORTED = /PL\/SQL (TABLE|RECORD)|REF CURSOR|OBJECT|^TABLE$|VARRAY|UNDEFINED|ROWID|BLOB|BFILE|RAW|LONG|XMLTYPE|ANYDATA/i;

function typeClass(t) {
  const u = String(t || '').toUpperCase();
  if (UNSUPPORTED.test(u)) return null;
  if (/BOOLEAN/.test(u)) return 'bool';
  if (/PLS_INTEGER|BINARY_INTEGER|^INTEGER$|NATURAL|POSITIVE|SIMPLE_INTEGER|^SMALLINT/.test(u)) return 'int';
  if (/NUMBER|FLOAT|BINARY_DOUBLE|BINARY_FLOAT|DECIMAL|NUMERIC|REAL|DOUBLE/.test(u)) return 'num';
  if (/DATE|TIMESTAMP/.test(u)) return 'date';
  if (/CHAR|CLOB|STRING/.test(u)) return 'str';
  return null;
}

const VALUES = {
  int: [1, 0, -1, 2, 100, null],
  num: [1, 0, -1, 2.5, 0.001, 123456.789, null],
  str: ['abc', 'Русский текст', ' с пробелами ', '0', null],
  bool: [true, false, null],
};
const DATE_VARIANTS = ['2024-02-29 00:00:00', '2026-12-31 00:00:00', '2026-01-01 13:45:00', null];

/** Вызовы для одной подпрограммы: базовый + по одному изменённому параметру */
function generateCalls(args, max = 60) {
  const ins = args.map((a, i) => ({ ...a, i })).filter(a => a.mode !== 'OUT');
  let dateNo = 0;
  const base = [], alts = [];
  for (const a of ins) {
    const c = typeClass(a.type);
    if (!c) return { skip: `неподдерживаемый тип параметра ${a.name}: ${a.type}` };
    if (c === 'date') {
      const b = dateNo++ === 1 ? '2026-03-31 00:00:00' : '2026-03-01 00:00:00';
      base.push(b); alts.push(DATE_VARIANTS.filter(v => v !== b));
    } else {
      const vals = a.mode === 'IN/OUT' && (c === 'num' || c === 'int') ? [0, ...VALUES[c].filter(v => v !== 0)] : VALUES[c];
      base.push(vals[0]); alts.push(vals.slice(1));
    }
  }
  const calls = [base.slice()];
  for (let k = 0; k < ins.length && calls.length < max; k++) {
    for (const v of alts[k]) { if (calls.length >= max) break; const c = base.slice(); c[k] = v; calls.push(c); }
  }
  return { calls, ins };
}

// ---------- Литералы ----------
const q = s => `'${String(s).replace(/'/g, "''")}'`;
function oraLit(v, type) {
  if (v === null || v === undefined) return 'NULL';
  const c = typeClass(type);
  if (c === 'bool') return v ? 'TRUE' : 'FALSE';
  if (c === 'date') return /TIMESTAMP/i.test(type) ? `TO_TIMESTAMP(${q(v)}, 'YYYY-MM-DD HH24:MI:SS')` : `TO_DATE(${q(v)}, 'YYYY-MM-DD HH24:MI:SS')`;
  if (c === 'num' || c === 'int') return String(v);
  return q(v);
}
function pgLit(v, pgType) {
  const t = pgType || 'text';
  if (v === null || v === undefined) return `NULL::${t}`;
  if (typeof v === 'boolean') return `${v}::${t}`;
  return `CAST(${q(v)} AS ${t})`;
}
function oraRetExpr(t) {
  const c = typeClass(t);
  if (c === 'num' || c === 'int') return { decl: 'NUMBER', conv: v => `TO_CHAR(${v}, 'TM9')` };
  if (c === 'date') return /TIMESTAMP/i.test(t) ? { decl: 'TIMESTAMP(6)', conv: v => `TO_CHAR(${v}, 'YYYY-MM-DD HH24:MI:SS.FF6')` } : { decl: 'DATE', conv: v => `TO_CHAR(${v}, 'YYYY-MM-DD HH24:MI:SS')` };
  if (c === 'bool') return { decl: 'BOOLEAN', conv: v => `CASE WHEN ${v} THEN 'true' WHEN NOT ${v} THEN 'false' END` };
  return { decl: 'VARCHAR2(32767)', conv: v => v };
}

// ---------- Сопоставление ошибок Oracle и PostgreSQL ----------
function errorsMatch(oraCode, pgState) {
  const c = Number(oraCode);
  if (!pgState) return false;
  if (c === 100 || c === -1403) return pgState === 'P0002';
  if (c === -1422) return pgState === 'P0003';
  if (c === -1476) return pgState === '22012';
  if (c === -1) return pgState === '23505';
  if (c === -1722 || c === -6502 || c === -1858 || c === -1861 || c === -1847 || c === -1830) return pgState.startsWith('22');
  if (c <= -20000 && c >= -20999) return pgState === `45${String(-c - 20000).padStart(3, '0')}` || pgState === 'P0001';
  if (c === -1400) return pgState === '23502';
  if (c === -2291 || c === -2292) return pgState === '23503';
  return null; // сопоставление неизвестно
}

function normVal(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return canonDecimal(s);
  if (/^\d{4}-\d\d-\d\d([ T]\d\d:\d\d(:\d\d(\.\d+)?)?)?/.test(s)) return canonDateTime(s);
  if (s === 't') return 'true';
  if (s === 'f') return 'false';
  return String(v);
}
function valuesEqual(a, b) {
  const x = normVal(a), y = normVal(b);
  if (x === y) return true;
  if (x === null || y === null) return false;
  const nx = Number(x), ny = Number(y);
  if (Number.isFinite(nx) && Number.isFinite(ny) && /^[-\d.]+$/.test(x) && /^[-\d.]+$/.test(y)) return Math.abs(nx - ny) <= 1e-9 * Math.max(1, Math.abs(nx), Math.abs(ny));
  return false;
}

function judge(o, g) {
  if (!o || !g) return { status: 'no-result' };
  if (g.err === '42883') return { status: 'not-found' };
  if (o.err && g.err) {
    const m = errorsMatch(o.err, g.err);
    if (m === true) return { status: 'pass', note: 'обе базы выдали одинаковую ошибку' };
    if (m === null) return { status: 'pass', note: `обе ошиблись (ORA${o.err} / ${g.err}) — соответствие кодов неизвестно` };
    return { status: 'fail', note: `разные ошибки: ORA${o.err} / ${g.err}` };
  }
  if (o.err || g.err) return { status: 'fail', note: o.err ? `ошибка только в Oracle: ${o.msg}` : `ошибка только в PostgreSQL: ${g.msg}` };
  const ov = String(o.value ?? '').split('|'), gv = String(g.value ?? '').split('|');
  const same = o.value == null && g.value == null ? true : ov.length === gv.length && ov.every((v, i) => valuesEqual(v === '' ? null : v, gv[i] === '' ? null : gv[i]));
  return { status: same ? 'pass' : 'fail' };
}

// ---------- Oracle ----------
async function oracleFunctions(db, owner, p) {
  const sel = (p.objects || []).map(o => ({ type: o.type, name: o.name }));
  const pkgs = sel.filter(o => o.type === 'package').map(o => o.name);
  const singles = sel.filter(o => o.type === 'function' || o.type === 'procedure').map(o => o.name);
  const binds = { o: owner };
  let filter = '';
  if (pkgs.length || singles.length) {
    const ps = pkgs.map((x, i) => (binds[`p${i}`] = x, `:p${i}`));
    const ss = singles.map((x, i) => (binds[`s${i}`] = x, `:s${i}`));
    filter = `AND (${[ps.length ? `package_name IN (${ps.join(',')})` : '', ss.length ? `(package_name IS NULL AND object_name IN (${ss.join(',')}))` : ''].filter(Boolean).join(' OR ')})`;
  }
  const rows = await db.query(`
    SELECT package_name AS pkg, object_name AS name, NVL(overload, '1') AS overload, position, argument_name, data_type, in_out
    FROM all_arguments WHERE owner = :o AND data_level = 0 ${filter}
    ORDER BY package_name NULLS FIRST, object_name, TO_NUMBER(NVL(overload, '1')), position`, binds);
  const map = new Map();
  for (const r of rows) {
    const k = `${r.pkg || ''}.${r.name}`;
    let f = map.get(k);
    if (!f) { f = { package: r.pkg, name: r.name, overload: r.overload, args: [], returns: null, overloads: 1 }; map.set(k, f); }
    if (r.overload !== f.overload) { f.overloads++; continue; }
    if (Number(r.position) === 0) f.returns = r.data_type;
    else if (r.argument_name || r.data_type) f.args.push({ name: r.argument_name, type: r.data_type, mode: r.in_out });
  }
  return [...map.values()].filter(f => f.returns || p.includeProcedures);
}

async function runOracleCall(db, owner, f, values, ins) {
  const full = `"${owner}".${f.package ? `"${f.package}".` : ''}"${f.name}"`;
  let k = 0;
  const decl = [], outs = [];
  const args = f.args.map((a, i) => {
    if (a.mode === 'OUT' || a.mode === 'IN/OUT') {
      const v = `o${i}`;
      const r = oraRetExpr(a.type);
      const init = a.mode === 'IN/OUT' ? ` := ${oraLit(values[k++], a.type)}` : '';
      decl.push(`${v} ${r.decl}${init};`);
      outs.push(r.conv(v));
      return v;
    }
    return oraLit(values[k++], a.type);
  });
  let body;
  if (f.returns) {
    const r = oraRetExpr(f.returns);
    decl.unshift(`r ${r.decl};`);
    body = `r := ${full}(${args.join(', ')});\n  :res := ${[r.conv('r'), ...outs].join(" || '|' || ")};`;
  } else body = `${full}(${args.join(', ')});\n  :res := ${outs.length ? outs.join(" || '|' || ") : 'NULL'};`;
  const block = `DECLARE ${decl.join(' ')}
BEGIN
  SAVEPOINT dbc_ut;
  ${body}
  :err := 0;
  BEGIN ROLLBACK TO SAVEPOINT dbc_ut; EXCEPTION WHEN OTHERS THEN NULL; END;
EXCEPTION WHEN OTHERS THEN
  :err := SQLCODE; :msg := SQLERRM;
  BEGIN ROLLBACK TO SAVEPOINT dbc_ut; EXCEPTION WHEN OTHERS THEN NULL; END;
END;`;
  const { oracledb } = require('../db/oracle');
  const r = await db.raw.execute(block, {
    res: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 32767 },
    err: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    msg: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 4000 },
  });
  const o = r.outBinds;
  return o.err ? { err: String(o.err), msg: o.msg } : { value: o.res };
}

async function runPgCall(db, sig, f, values, ins) {
  if (sig.missing) return { err: '42883', msg: `нет ${sig.expected}` };
  const name = `${db.quote(sig.schema)}.${db.quote(sig.name)}`;
  const args = [];
  let k = 0;
  sig.modes.forEach((m, i) => {
    if (sig.kind === 'f' && m === 'o') return;
    const oa = f.args[i];
    if (m === 'o') { args.push(`NULL::${sig.types[i]}`); return; }
    const v = oa && oa.mode !== 'OUT' ? values[k++] : null;
    args.push(pgLit(v, sig.types[i]));
  });
  const sql = sig.kind === 'p' ? `CALL ${name}(${args.join(', ')})` : `SELECT ${name}(${args.join(', ')})::text AS r`;
  await db.exec('SAVEPOINT dbc_ut');
  try {
    const r = await db.exec(sql);
    let value = null;
    if (r.rows && r.rows.length) {
      const row = r.rows[0];
      value = sig.kind === 'p' ? Object.values(row).map(v => (v == null ? '' : String(v))).join('|') : row.r;
      if (sig.kind === 'f' && typeof value === 'string' && /^\(.*\)$/.test(value) && f.args.some(a => a.mode !== 'IN')) value = value.slice(1, -1).split(',').map(s => s.replace(/^"|"$/g, '')).join('|');
    }
    await db.exec('ROLLBACK TO SAVEPOINT dbc_ut');
    return { value };
  } catch (e) {
    await db.exec('ROLLBACK TO SAVEPOINT dbc_ut').catch(() => {});
    return { err: e.code || 'XX000', msg: e.message };
  }
}

const show = (f, values) => `${f.package ? f.package + '.' : ''}${f.name}(${values.map(v => (v === null ? 'NULL' : typeof v === 'string' ? `'${v}'` : String(v))).join(', ')})`;

async function runUnitTests(p, ctx) {
  const tgtConn = getConnection(p.targetId);
  if (tgtConn.type !== 'postgres') throw new Error('Приёмник должен быть PostgreSQL');
  const useSuite = p.suite && p.suite.functions;
  const srcConn = useSuite ? null : getConnection(p.sourceId);
  if (srcConn && srcConn.type !== 'oracle') throw new Error('Источник должен быть Oracle (ответы Oracle — эталон)');
  const src = srcConn ? await connect(srcConn) : null;
  const tgt = await connect(tgtConn);
  const maxCalls = Math.min(Number(p.maxCalls) || 60, 200);
  const functions = [];
  try {
    let list;
    if (useSuite) list = p.suite.functions;
    else {
      ctx.progress(0, 0, 'Функции Oracle…');
      list = (await oracleFunctions(src, p.sourceSchema, p)).map(f => {
        const g = generateCalls(f.args, maxCalls);
        return { ...f, skip: g.skip || null, calls: g.calls ? g.calls.map((values, n) => ({ n: n + 1, values })) : [], ins: g.ins };
      });
    }
    await tgt.exec('BEGIN');
    let fi = 0;
    for (const f of list) {
      ctx.checkCancel();
      ctx.progress(fi++, list.length, `${f.package ? f.package + '.' : ''}${f.name}`);
      const res = { package: f.package, name: f.name, returns: f.returns, args: f.args, skip: f.skip, overloads: f.overloads, calls: [], passed: 0, failed: 0, notFound: 0 };
      if (f.skip) { functions.push(res); continue; }
      const sig = await pgRoutine(tgt, p.targetSchema, f.package, f.name);
      res.pgName = sig.missing ? sig.expected : `${sig.schema}.${sig.name}`;
      const ins = f.ins || f.args.map((a, i) => ({ ...a, i })).filter(a => a.mode !== 'OUT');
      for (const c of f.calls) {
        ctx.checkCancel();
        const o = useSuite ? c.expected : (src ? await runOracleCall(src, p.sourceSchema, f, c.values, ins).catch(e => ({ err: 'X', msg: e.message })) : null);
        const g = await runPgCall(tgt, sig, f, c.values, ins);
        const j = judge(o, g);
        if (j.status === 'pass') res.passed++; else if (j.status === 'not-found') res.notFound++; else res.failed++;
        res.calls.push({ n: c.n, call: show(f, c.values), values: c.values, expected: o, actual: g, status: j.status, note: j.note });
        if (j.status === 'not-found') break; // нет функции — дальше нет смысла
      }
      if (src) await src.rollback().catch(() => {});
      functions.push(res);
      ctx.log(`${res.package ? res.package + '.' : ''}${res.name}: прошло ${res.passed} из ${res.calls.length}${res.notFound ? ' — функция не найдена в PostgreSQL' : ''}`, res.failed || res.notFound ? 'warning' : 'info');
    }
  } finally {
    await tgt.exec('ROLLBACK').catch(() => {});
    if (src) await src.close();
    await tgt.close();
  }
  // Набор для повторных прогонов без Oracle
  const suite = {
    functions: functions.filter(f => !f.skip && f.calls.length).map(f => ({
      package: f.package, name: f.name, returns: f.returns, args: f.args,
      calls: f.calls.filter(c => c.expected).map(c => ({ n: c.n, values: c.values, expected: c.expected, ignore: false })),
    })),
  };
  const tested = functions.filter(f => !f.skip);
  const summary = {
    functions: tested.length, skipped: functions.length - tested.length,
    calls: tested.reduce((s, f) => s + f.calls.length, 0), failed: tested.reduce((s, f) => s + f.failed, 0),
    passed: tested.reduce((s, f) => s + f.passed, 0), notFound: tested.filter(f => f.notFound).length,
    fullyPassed: tested.filter(f => f.calls.length && !f.failed && !f.notFound).length, withoutOracle: !!useSuite,
  };
  return { summary, target: { ...publicConnection(tgtConn), schema: p.targetSchema }, source: srcConn ? { ...publicConnection(srcConn), schema: p.sourceSchema } : null, functions, suite };
}

module.exports = { runUnitTests, generateCalls, errorsMatch, judge, typeClass, pgLit, oraLit };
