'use strict';
// Шаблон сверки расчёта раздела: по выбранным процедурам пакетов (ish_dan → ras → arh, цепочка gt → ku → tfu → pt)
// строятся вызовы для Oracle (блок с переменными для OUT-параметров — код и текст ошибки) и для PostgreSQL
// (CALL пакет_процедура(…) с плейсхолдерами для INOUT), шаги очистки периода (del_*) и список таблиц результата.
const { connect } = require('../db');
const { getConnection } = require('../lib/store');

const lc = s => String(s || '').toLowerCase();
const qo = s => `"${String(s).replace(/"/g, '""')}"`;
const isDate = t => /DATE|TIMESTAMP/i.test(t || '');
const isNum = t => /NUMBER|INTEGER|FLOAT|DOUBLE|DECIMAL|PLS_INTEGER|BINARY_INTEGER|NUMERIC|SMALLINT|BIGINT|REAL|INT/i.test(t || '');

// Аргументы процедуры Oracle (первый overload)
async function oracleArgs(db, owner, pkg, proc) {
  const r = await db.query(`
    SELECT argument_name, position, data_type, in_out, NVL(overload, '1') AS overload
    FROM all_arguments
    WHERE owner = :o AND object_name = :p AND ${pkg ? 'package_name = :k' : 'package_name IS NULL'} AND data_level = 0
    ORDER BY TO_NUMBER(NVL(overload, '1')), position`, pkg ? { o: owner, p: proc, k: pkg } : { o: owner, p: proc });
  const first = r.length ? r[0].overload : null;
  const args = r.filter(a => a.overload === first);
  const ret = args.find(a => Number(a.position) === 0);
  return { args: args.filter(a => Number(a.position) > 0).map(a => ({ name: a.argument_name, type: a.data_type, mode: a.in_out })), returns: ret ? ret.data_type : null };
}

// Сигнатура в PostgreSQL: пакет_процедура в схеме приёмника или процедура в схеме пакета
async function pgRoutine(db, schema, pkg, proc) {
  const cands = pkg ? [[schema, `${lc(pkg)}_${lc(proc)}`], [lc(pkg), lc(proc)], ['public', `${lc(pkg)}_${lc(proc)}`]] : [[schema, lc(proc)], ['public', lc(proc)]];
  for (const [nsp, name] of cands) {
    const r = await db.query(`
      SELECT n.nspname, p.proname, p.prokind,
             COALESCE(p.proargmodes::text[], array_fill('i'::text, ARRAY[p.pronargs::int])) AS modes,
             ARRAY(SELECT format_type(t, NULL) FROM unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[])) WITH ORDINALITY u(t, k) ORDER BY k) AS types
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.proname = $2 ORDER BY p.pronargs DESC LIMIT 1`, [nsp, name]).catch(() => []);
    if (r.length) return { schema: r[0].nspname, name: r[0].proname, kind: r[0].prokind, modes: r[0].modes, types: r[0].types };
  }
  return { missing: true, expected: `${cands[0][0]}.${cands[0][1]}` };
}

function buildCalls(call, ora, pg, owner, from, to) {
  const notes = [];
  // значения аргументов по позиции
  let dateIdx = 0;
  const vals = ora.args.map(a => {
    if (a.mode !== 'IN') return null;
    if (isDate(a.type)) { const d = dateIdx++ === 1 ? to : from; return { o: `DATE '${d}'`, p: `DATE '${d}'` }; }
    if (isNum(a.type)) return { o: '0', p: '0' };
    return { o: 'NULL', p: 'NULL' };
  });
  // --- Oracle
  const decl = [], outs = [];
  const oArgs = ora.args.map((a, i) => {
    if (a.mode === 'IN') return vals[i].o;
    const v = `o${i + 1}`;
    decl.push(`${v} ${isNum(a.type) ? 'NUMBER' : isDate(a.type) ? 'DATE' : 'VARCHAR2(4000)'}${a.mode === 'IN/OUT' && isNum(a.type) ? ' := 0' : ''};`);
    outs.push(isDate(a.type) ? `TO_CHAR(${v}, 'YYYY-MM-DD HH24:MI:SS')` : v);
    return v;
  });
  const target = `${qo(owner)}.${call.package ? qo(call.package) + '.' : ''}${qo(call.procedure)}`;
  const oCall = ora.returns ? `o0 := ${target}(${oArgs.join(', ')});` : `${target}(${oArgs.join(', ')});`;
  if (ora.returns) { decl.unshift(`o0 ${isNum(ora.returns) ? 'NUMBER' : isDate(ora.returns) ? 'DATE' : 'VARCHAR2(4000)'};`); outs.unshift('o0'); }
  const oracle = `${decl.length ? `DECLARE ${decl.join(' ')} ` : ''}BEGIN\n  ${oCall}${outs.length ? `\n  DBMS_OUTPUT.PUT_LINE('OUT:' || ${outs.join(" || '|' || ")});` : ''}\nEND;`;
  // --- PostgreSQL
  let postgres;
  if (pg.missing) {
    postgres = `-- В PostgreSQL нет ${pg.expected} — поставьте пакет ${call.package || call.procedure}`;
    notes.push(`Нет в PostgreSQL: ${pg.expected}`);
  } else {
    const pgIn = pg.modes.map((m, i) => ({ m, t: pg.types[i] }));
    if (pg.modes.length !== ora.args.length) notes.push(`${pg.name}: число параметров отличается от Oracle (${pg.modes.length} и ${ora.args.length}) — проверьте вызов`);
    const pArgs = [];
    for (const [i, a] of pgIn.entries()) {
      if (pg.kind === 'f' && a.m === 'o') continue; // OUT функции не передаются
      const oa = ora.args[i];
      if (a.m === 'i' || a.m === 'v') pArgs.push(oa && vals[i] ? vals[i].p : (isDate(a.t) ? `DATE '${from}'` : isNum(a.t) ? '0' : 'NULL'));
      else pArgs.push(isNum(a.t) ? '0' : 'NULL');
    }
    const name = `${pg.schema}.${pg.name}`;
    postgres = pg.kind === 'p' ? `CALL ${name}(${pArgs.join(', ')})` : `SELECT * FROM ${name}(${pArgs.join(', ')})`;
  }
  return { oracle, postgres, notes, outCount: outs.length };
}

async function buildTemplate(p) {
  const s = getConnection(p.sourceId), t = getConnection(p.targetId);
  if (s.type !== 'oracle') throw new Error('Шаблон строится по процедурам Oracle — источник должен быть Oracle');
  const src = await connect(s), tgt = await connect(t);
  const from = p.dateFrom, to = p.dateTo;
  if (!/^\d{4}-\d\d-\d\d$/.test(from || '') || !/^\d{4}-\d\d-\d\d$/.test(to || '')) throw new Error('Укажите период в формате ГГГГ-ММ-ДД');
  try {
    const gen = async list => {
      const o = [], g = [], notes = [];
      for (const c of list || []) {
        const ora = await oracleArgs(src, p.sourceSchema, c.package || null, c.procedure);
        if (!ora.args.length && !ora.returns) notes.push(`${c.package ? c.package + '.' : ''}${c.procedure}: аргументы не найдены в ALL_ARGUMENTS`);
        const pg = tgt.type === 'postgres' ? await pgRoutine(tgt, p.targetSchema, c.package, c.procedure) : { missing: true, expected: '?' };
        const r = buildCalls(c, ora, pg, p.sourceSchema, from, to);
        o.push(`-- ${c.package ? c.package + '.' : ''}${c.procedure}\n${r.oracle}`);
        g.push(`-- ${c.package ? c.package + '.' : ''}${c.procedure}\n${r.postgres}`);
        notes.push(...r.notes);
      }
      return { oracle: o.join('\n/\n'), postgres: g.join('\n/\n'), notes };
    };
    const main = await gen(p.calls);
    const clean = await gen(p.cleanup);
    // Таблицы, с которыми работают выбранные пакеты
    const pkgs = [...new Set([...(p.calls || []), ...(p.cleanup || [])].map(c => c.package || c.procedure))];
    const tabs = pkgs.length ? await src.query(`
      SELECT DISTINCT referenced_name AS name FROM all_dependencies
      WHERE owner = :o AND referenced_owner = :o AND referenced_type = 'TABLE' AND name IN (${pkgs.map((_, i) => `:p${i}`).join(',')})
      ORDER BY 1`, Object.fromEntries([['o', p.sourceSchema], ...pkgs.map((x, i) => [`p${i}`, x])])) : [];
    const tables = tabs.map(x => x.name);
    const suggested = tables.filter(n => /(_RAB|_ARCH|_ARH|PROTOKOL|_RES|ITOGO)/i.test(n));
    return { sourceSteps: main.oracle, targetSteps: main.postgres, sourcePre: clean.oracle, targetPre: clean.postgres, notes: [...main.notes, ...clean.notes], tables, suggested };
  } finally { await src.close(); await tgt.close(); }
}

// Пакеты и их процедуры — для выбора в интерфейсе
async function listProcedures(db, schema) {
  if (db.type !== 'oracle') {
    const r = await db.query(`SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.prokind IN ('p','f') ORDER BY 1`, [schema]);
    return r.map(x => ({ package: null, procedure: x.name }));
  }
  const r = await db.query(`
    SELECT CASE WHEN object_type = 'PACKAGE' THEN object_name END AS pkg,
           CASE WHEN object_type = 'PACKAGE' THEN procedure_name ELSE object_name END AS proc, object_type
    FROM all_procedures
    WHERE owner = :o AND ((object_type = 'PACKAGE' AND procedure_name IS NOT NULL) OR object_type IN ('PROCEDURE','FUNCTION'))
    ORDER BY 1 NULLS FIRST, 2`, { o: schema });
  const seen = new Set();
  return r.filter(x => { const k = `${x.pkg}.${x.proc}`; if (seen.has(k)) return false; seen.add(k); return true; }).map(x => ({ package: x.pkg, procedure: x.proc }));
}

module.exports = { buildTemplate, buildCalls, listProcedures, pgRoutine };
