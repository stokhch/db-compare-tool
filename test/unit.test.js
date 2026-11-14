'use strict';
const assert = require('assert');
const { canonDecimal, canonDateTime, makeNormalizer, compareDecimal, keyComparator } = require('../server/lib/normalize');
const { oracleFamily, pgFamily, compatibility, oracleToPgType, pgToOracleType } = require('../server/lib/typemap');
const { createTableSql, topoOrder } = require('../server/copy/transfer');
const { parseTestReport } = require('../server/copy/ora2pg');
require('../server/db/oracle'); require('../server/copy/datapump');

let n = 0; const t = (name, fn) => { fn(); n++; };

t('canonDecimal', () => {
  const cases = { '1.500': '1.5', '0001': '1', '-0.0': '0', '.5': '0.5', '1E+3': '1000', '1.2e-3': '0.0012', '-12.340': '-12.34', '100': '100', '1e+25': '10000000000000000000000000', '0': '0' };
  for (const [a, b] of Object.entries(cases)) assert.strictEqual(canonDecimal(a), b, a);
});
t('compareDecimal', () => {
  assert(compareDecimal('9', '10') < 0); assert(compareDecimal('-10', '-9') < 0); assert(compareDecimal('1.05', '1.5') < 0);
  assert(compareDecimal('-1', '0') < 0); assert.strictEqual(compareDecimal('2.50', '2.5'), 0);
});
t('canonDateTime: Oracle DATE vs PG timestamp/date', () => {
  assert.strictEqual(canonDateTime('2024-01-02 03:04:05'), '2024-01-02 03:04:05.000000');      // Oracle TO_CHAR DATE
  assert.strictEqual(canonDateTime('2024-01-02 03:04:05.120000'), '2024-01-02 03:04:05.120000'); // Oracle TIMESTAMP FF6
  assert.strictEqual(canonDateTime('2024-01-02 03:04:05.12'), '2024-01-02 03:04:05.120000');     // PG timestamp
  assert.strictEqual(canonDateTime('2024-01-02'), '2024-01-02 00:00:00.000000');                 // PG date
  assert.strictEqual(canonDateTime('2024-05-05 09:00:00+00'), '2024-05-05 09:00:00.000000');     // PG timestamptz (UTC)
  assert.strictEqual(canonDateTime('2024-05-05 12:00:00+03'), '2024-05-05 09:00:00.000000');
  assert.strictEqual(canonDateTime('2024-05-05 02:00:00.5-05:30'), '2024-05-05 07:30:00.500000');
});
t('normalizer: кросс-СУБД значения', () => {
  const num = makeNormalizer('number', {});
  assert.strictEqual(num('100.50'), num(100.5));     // Oracle NUMBER (строка) vs PG float/int
  assert.strictEqual(num('1'), num(true));            // NUMBER(1) vs boolean
  const str = makeNormalizer('string', { emptyAsNull: true }, true);
  assert.strictEqual(str('IT   '), 'IT');              // CHAR с пробелами
  assert.strictEqual(str(''), null);                   // Oracle '' = NULL
  const bin = makeNormalizer('binary', {});
  assert.strictEqual(bin(Buffer.from('abc')), bin(Buffer.from('abc')));
  const fl = makeNormalizer('float', {});
  assert.strictEqual(fl(0.1 + 0.2), fl('0.3'));
  const js = makeNormalizer('json', {});
  assert.strictEqual(js('{"b":1, "a":2}'), js('{"a":2,"b":1}'));
});
t('key comparator = бинарный порядок UTF-8', () => {
  const c = keyComparator('string');
  const sorted = ['z', 'a', 'B', 'ё', 'Ё', 'я', '10', '9'].sort(c);
  assert.deepStrictEqual(sorted, ['10', '9', 'B', 'a', 'z', 'Ё', 'я', 'ё']); // как ORDER BY ... COLLATE "C"
});
const oc = (o) => { const c = { scale: null, precision: null, length: null, ...o }; c.family = oracleFamily(c); return c; };
const pc = (o) => { const c = { scale: null, precision: null, length: null, ...o }; c.family = pgFamily(c); return c; };
t('семейства и совместимость Oracle↔PG', () => {
  const n10 = oc({ dataType: 'NUMBER', type: 'NUMBER(10)', precision: 10, scale: 0 });
  assert.strictEqual(n10.family, 'int');
  assert.strictEqual(compatibility(n10, pc({ udt: 'int8', type: 'bigint', scale: 0 }), false).level, 'ok');
  assert.strictEqual(compatibility(n10, pc({ udt: 'int4', type: 'integer', scale: 0 }), false).level, 'error');
  const n122 = oc({ dataType: 'NUMBER', type: 'NUMBER(12,2)', precision: 12, scale: 2 });
  assert.strictEqual(compatibility(n122, pc({ udt: 'numeric', type: 'numeric(12,2)', precision: 12, scale: 2 }), false).level, 'ok');
  assert.strictEqual(compatibility(n122, pc({ udt: 'int8', type: 'bigint', scale: 0 }), false).level, 'error');
  const v100 = oc({ dataType: 'VARCHAR2', type: 'VARCHAR2(100 CHAR)', length: 100 });
  assert.strictEqual(compatibility(v100, pc({ udt: 'varchar', type: 'character varying(100)', length: 100 }), false).level, 'ok');
  assert.strictEqual(compatibility(v100, pc({ udt: 'varchar', type: 'character varying(50)', length: 50 }), false).level, 'error');
  assert.strictEqual(compatibility(v100, pc({ udt: 'text', type: 'text' }), false).level, 'ok');
  const d = oc({ dataType: 'DATE', type: 'DATE' });
  assert.strictEqual(compatibility(d, pc({ udt: 'timestamp', type: 'timestamp(0) without time zone', fsp: 0 }), false).level, 'ok');
  assert.strictEqual(compatibility(d, pc({ udt: 'date', type: 'date' }), false).level, 'warning');
  const clob = oc({ dataType: 'CLOB', type: 'CLOB' });
  assert.strictEqual(compatibility(clob, pc({ udt: 'text', type: 'text' }), false).level, 'ok');
  const n1 = oc({ dataType: 'NUMBER', type: 'NUMBER(1)', precision: 1, scale: 0 });
  assert.strictEqual(compatibility(n1, pc({ udt: 'bool', type: 'boolean' }), false).level, 'ok');
  assert.strictEqual(compatibility(oc({ dataType: 'BLOB', type: 'BLOB' }), pc({ udt: 'bytea', type: 'bytea' }), false).level, 'ok');
  assert.strictEqual(compatibility(oc({ dataType: 'BLOB', type: 'BLOB' }), pc({ udt: 'text', type: 'text' }), false).level, 'error');
});
t('маппинг типов для DDL', () => {
  assert.strictEqual(oracleToPgType(oc({ dataType: 'NUMBER', precision: 4, scale: 0 })), 'smallint');
  assert.strictEqual(oracleToPgType(oc({ dataType: 'NUMBER', precision: 9, scale: 0 })), 'integer');
  assert.strictEqual(oracleToPgType(oc({ dataType: 'NUMBER', precision: 18, scale: 0 })), 'bigint');
  assert.strictEqual(oracleToPgType(oc({ dataType: 'NUMBER', precision: 12, scale: 2 })), 'numeric(12,2)');
  assert.strictEqual(oracleToPgType(oc({ dataType: 'VARCHAR2', length: 200 })), 'varchar(200)');
  assert.strictEqual(oracleToPgType(oc({ dataType: 'DATE' })), 'timestamp(0)');
  assert.strictEqual(oracleToPgType(oc({ dataType: 'TIMESTAMP(6) WITH TIME ZONE', fsp: 6 })), 'timestamp(6) with time zone');
  assert.strictEqual(pgToOracleType(pc({ udt: 'varchar', length: 100 })), 'VARCHAR2(100 CHAR)');
  assert.strictEqual(pgToOracleType(pc({ udt: 'text' })), 'CLOB');
  assert.strictEqual(pgToOracleType(pc({ udt: 'bool' })), 'NUMBER(1)');
});
t('DDL Oracle -> PG и порядок по FK', () => {
  const fakePg = { type: 'postgres', quote: s => `"${s}"`, qualify: (a, b) => `"${a}"."${b}"`, normName: s => s.toLowerCase() };
  const tbl = { name: 'EMP', pk: { name: 'EMP_PK', columns: ['ID'] }, fks: [], columns: [
    oc({ name: 'ID', dataType: 'NUMBER', precision: 10, scale: 0, nullable: false }),
    oc({ name: 'NAME', dataType: 'VARCHAR2', length: 100, nullable: true })] };
  const sql = createTableSql(tbl, 'oracle', fakePg, 'app');
  assert(sql.includes('"app"."emp"') && sql.includes('"id" bigint NOT NULL') && sql.includes('PRIMARY KEY ("id")'), sql);
  const order = topoOrder([{ name: 'C', fks: [{ refTable: 'B' }] }, { name: 'B', fks: [{ refTable: 'A' }] }, { name: 'A', fks: [] }], x => x.toLowerCase());
  assert.deepStrictEqual(order.map(x => x.name), ['A', 'B', 'C']);
});
t('разбор отчёта ora2pg TEST', () => {
  const s = parseTestReport('[TEST ROWS COUNT]\nORACLEDB:A:1\nPOSTGRES:a:1\n[ERRORS ROWS COUNT]\nOK, Oracle and PostgreSQL have the same number of rows.\n[TEST INDEXES COUNT]\n[ERRORS INDEXES COUNT]\nTable departments don\'t have the same number of indexes in Oracle (2) and in PostgreSQL (1).\n');
  assert.strictEqual(s.length, 2); assert(s[0].ok); assert(!s[1].ok && s[1].messages.length === 1);
});
console.log(`OK: ${n} групп тестов пройдено`);

// --- подсказки к ошибкам подключения ---
const { hintFor } = require('../server/lib/errhint');
const hintCases = [
  [{ code: '28P01', message: 'password authentication failed for user "x"' }, /Неверный пароль/],
  [{ code: '3D000', message: 'database "a" does not exist' }, /Такой базы нет/],
  [{ message: 'ORA-01017: invalid username/password; logon denied' }, /Неверное имя пользователя или пароль Oracle/],
  [{ message: 'NJS-518: cannot connect to Oracle Database. Service "XE" is not registered with the listener' }, /Service name/],
  [{ message: 'NJS-116: password verifier type 0x939 is not supported by node-oracledb in Thin mode' }, /Instant Client/],
  [{ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:5432' }, /отклонил подключение/],
];
for (const [e, re] of hintCases) assert(re.test(hintFor(e) || ''), e.message);
console.log('OK: подсказки к ошибкам подключения');

// --- литералы скрипта синхронизации данных ---
const { makeLiteral } = require('../server/compare/syncdata');
{
  const st = { lobSkipped: 0 };
  const ora = makeLiteral('oracle', st), pg = makeLiteral('postgres', st);
  assert.strictEqual(ora("it's", { family: 'string', dataType: 'VARCHAR2' }), "'it''s'");
  assert.strictEqual(ora('2024-01-02 03:04:05.120000', { family: 'datetime', dataType: 'DATE' }), "TO_DATE('2024-01-02 03:04:05', 'YYYY-MM-DD HH24:MI:SS')");
  assert.strictEqual(ora('2024-01-02 03:04:05.12+00', { family: 'datetime', dataType: 'TIMESTAMP(6)' }), "TO_TIMESTAMP('2024-01-02 03:04:05.120000', 'YYYY-MM-DD HH24:MI:SS.FF')");
  assert.strictEqual(ora(true, { family: 'int', dataType: 'NUMBER' }), '1');
  assert.strictEqual(ora('x'.repeat(2500), { family: 'text', dataType: 'CLOB' }).split('TO_CLOB(').length - 1, 3);
  assert.strictEqual(ora(Buffer.from('ab'), { family: 'binary', dataType: 'BLOB' }), "HEXTORAW('6162')");
  assert.strictEqual(pg('1', { family: 'bool', udt: 'bool' }), 'true');
  assert.strictEqual(pg('2024-01-02 03:04:05', { family: 'datetimetz', udt: 'timestamptz' }), "'2024-01-02 03:04:05.000000+00'");
  assert.strictEqual(pg(Buffer.from('ab'), { family: 'binary', udt: 'bytea' }), "'\\x6162'::bytea");
  assert.strictEqual(pg('12.50', { family: 'numeric', udt: 'numeric' }), '12.50');
  assert.strictEqual(pg(null, { family: 'text' }), 'NULL');
}
// --- фильтр объектов ---
const { filterMeta } = require('../server/meta/objects');
{
  const meta = { tables: [{ name: 'EMP' }, { name: 'DEPT' }], views: [{ name: 'V_EMP' }], mviews: [], sequences: [{ name: 'S1' }],
    routines: [{ key: 'PKG.CALC', name: 'PKG.CALC', kind: 'package routine', package: 'PKG' }, { key: 'F1', name: 'F1', kind: 'function' }],
    triggers: [], types: [], packages: ['PKG'], invalid: [] };
  const lc = x => String(x).toLowerCase();
  const f = filterMeta(meta, [{ type: 'table', name: 'emp' }, { type: 'package', name: 'PKG' }], lc);
  assert.deepStrictEqual(f.tables.map(t => t.name), ['EMP']);
  assert.deepStrictEqual(f.routines.map(r => r.key), ['PKG.CALC']);
  const pgMeta = { ...meta, routines: [{ key: 'pkg_calc', name: 'pkg_calc', kind: 'function' }, { key: 'other', name: 'other', kind: 'function' }] };
  assert.deepStrictEqual(filterMeta(pgMeta, [{ type: 'package', name: 'PKG' }], lc).routines.map(r => r.key), ['pkg_calc']);
}
console.log('OK: литералы синхронизации и фильтр объектов');

// --- окружение Oracle: расписания и вызовы ---
const { repeatToCron, plsqlToCall } = require('../server/migrate/extras');
assert.strictEqual(repeatToCron('FREQ=DAILY;BYHOUR=2;BYMINUTE=30'), '30 2 * * *');
assert.strictEqual(repeatToCron('FREQ=MINUTELY;INTERVAL=15'), '*/15 * * * *');
assert.strictEqual(repeatToCron('FREQ=HOURLY;BYMINUTE=5'), '5 * * * *');
assert.strictEqual(repeatToCron('FREQ=WEEKLY;BYDAY=MON,FRI;BYHOUR=7'), '0 7 * * 1,5');
assert.strictEqual(repeatToCron('FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=3'), '0 3 1 * *');
assert.strictEqual(repeatToCron('FREQ=MONTHLY;BYMONTHDAY=-1'), null);
assert.strictEqual(plsqlToCall('BEGIN maket_pt.calc(1, sysdate); END;', 'HR'), 'CALL maket_pt_calc(1, sysdate)');
assert.strictEqual(plsqlToCall('HR.PKG.RUN', 'HR'), 'CALL pkg_run()');
assert.strictEqual(plsqlToCall('begin hr.p_load; end;', 'HR'), 'CALL p_load()');
assert.strictEqual(plsqlToCall('BEGIN PKG.RUN; END;', 'HR', 'schema'), 'CALL pkg.run()');
// --- профиль: рекомендации по данным Oracle ---
const { recommendFromOracle } = require('../server/migrate/profile');
{
  const c = { dataType: 'NUMBER', type: 'NUMBER', precision: null, scale: null, family: 'numeric' };
  assert.strictEqual(recommendFromOracle(c, { nn: 10, fr: 0, mn: '1', mx: '5000000000' }).recommended, 'bigint');
  assert.strictEqual(recommendFromOracle(c, { nn: 10, fr: 3, sc: 2, mn: '1', mx: '5' }).recommended, 'numeric');
  const i10 = { dataType: 'NUMBER', type: 'NUMBER(10)', precision: 10, scale: 0, family: 'int' };
  assert.strictEqual(recommendFromOracle(i10, { nn: 10, fr: 2, mn: '1', mx: '5' }).level, 'error');
  const d = { dataType: 'DATE', type: 'DATE', family: 'datetime' };
  assert.strictEqual(recommendFromOracle(d, { nn: 10, tm: 0 }).recommended, 'date');
  assert.strictEqual(recommendFromOracle(d, { nn: 10, tm: 4 }).recommended, 'timestamp(0)');
  const v = { dataType: 'VARCHAR2', type: 'VARCHAR2(10 BYTE)', length: 10, family: 'string' };
  assert.strictEqual(recommendFromOracle(v, { nn: 10, z: 2, ml: 5, mb: 5 }).level, 'error');
}
console.log('OK: окружение Oracle и профиль данных');

// --- сканер кода ---
{
  const { scanFile } = require('../server/migrate/codescan');
  const fs2 = require('fs'), os = require('os'), path2 = require('path');
  const f = path2.join(os.tmpdir(), 'dbc_scan_test.js');
  fs2.writeFileSync(f, [
    "const oracledb = require('oracledb');",
    "// NVL( в комментарии",
    "const a = await c.execute(`SELECT NVL(x, 0) FROM t WHERE id = :id AND d > SYSDATE`, { id });",
    "const b = 'не SQL: NVL(';",
    "await c.execute('BEGIN pkg.run(:a); END;', [1]);",
    "console.log(r.rows[0].NAME, r.rowsAffected);",
  ].join('\n'));
  const res = scanFile(f, 'x.js', { packages: new Set(['PKG']) });
  const ids = res.map(x => x.rule);
  for (const id of ['require-oracledb', 'nvl', 'binds', 'sysdate', 'plsql-block', 'package-call', 'rows-affected', 'execute']) assert(ids.includes(id), 'нет правила ' + id);
  assert(!res.some(x => x.line === 2), 'комментарий не должен проверяться');
  assert(!res.some(x => x.line === 4 && x.rule === 'nvl'), 'строка без SQL не должна проверяться');
  assert.strictEqual(res.find(x => x.rule === 'package-call').fixed.includes('pkg_run('), true);
  assert(res.find(x => x.rule === 'binds' && x.line === 3).hint.includes(':id → $1'));
  console.log('OK: сканер кода');
}

// --- расписание регламента ---
{
  const { cronMatches, validCron } = require('../server/verify/suites');
  const d = new Date(2026, 10, 16, 7, 30); // понедельник 07:30
  assert(cronMatches('30 7 * * 1-5', d));
  assert(cronMatches('*/15 * * * *', d));
  assert(!cronMatches('0 7 * * *', d));
  assert(!cronMatches('30 7 * * 0,6', d));
  assert(cronMatches('30 7 16 11 *', d));
  assert(validCron('0 7 * * 1-5') && !validCron('каждый день'));
  console.log('OK: расписание регламента');
}

// --- зависимости пакетов (на модели справочника: pt вызывает sn, ud, INTER1) ---
{
  const { analyzeDeps } = require('../server/migrate/deps');
  const deps = [
    { name: 'MAKET_PT_2026', type: 'PACKAGE', rowner: 'TEC22', rname: 'MAKET_SN_PGU_FAKT', rtype: 'PACKAGE' },
    { name: 'MAKET_PT_2026', type: 'PACKAGE', rowner: 'TEC22', rname: 'MAKET_UD_PGU_FAKT', rtype: 'PACKAGE' },
    { name: 'MAKET_PT_2026', type: 'PACKAGE', rowner: 'TEC22', rname: 'INTER1', rtype: 'PACKAGE' },
    { name: 'MAKET_PT_2026', type: 'PACKAGE', rowner: 'TEC22', rname: 'T_PGU_PT_RAB2026', rtype: 'TABLE' },
    { name: 'MAKET_PT_2026', type: 'PACKAGE', rowner: 'TEC22', rname: 'MV_PGU_TEC22', rtype: 'MATERIALIZED VIEW' },
    { name: 'MAKET_SN_PGU_FAKT', type: 'PACKAGE', rowner: 'TEC22', rname: 'T_SN_PGU', rtype: 'TABLE' },
    { name: 'MAKET_PT_2026', type: 'PACKAGE', rowner: 'SYS', rname: 'DBMS_OUTPUT', rtype: 'PACKAGE' },
  ];
  const sources = new Map([
    ['MAKET_PT_2026', 'begin maket_sn_pgu_fakt.ish_dan_sn(d1, d2, e, m); MAKET_UD_PGU_FAKT.ish_dan_ud(d1); y := INTER1.INTER3(a, b); x := inter1.kol_const; end;'],
    ['MAKET_SN_PGU_FAKT', 'begin null; end;'],
  ]);
  const packageProcs = new Map([
    ['MAKET_PT_2026', ['ISH_DAN_PT_CL', 'RAS_PT', 'ARH_PT']], ['MAKET_SN_PGU_FAKT', ['ISH_DAN_SN']],
    ['MAKET_UD_PGU_FAKT', ['ISH_DAN_UD']], ['INTER1', ['INTER2', 'INTER3']],
  ]);
  const r = analyzeDeps({
    owner: 'TEC22', deps, sources, packageProcs, scope: new Set(['MAKET_PT_2026']),
    pgRoutines: new Set(['tec22.maket_pt_2026_ish_dan_pt_cl', 'tec22.maket_pt_2026_ras_pt', 'tec22.maket_pt_2026_arh_pt', 'tec22.inter1_inter3', 'tec22.maket_ud_pgu_fakt_ish_dan_ud']),
    pgRelations: new Set(['tec22.t_pgu_pt_rab2026']), targetSchema: 'tec22',
  });
  const miss = r.rows.filter(x => !x.ok).map(x => x.dependency).sort();
  assert.deepStrictEqual(miss, ['MAKET_SN_PGU_FAKT.ISH_DAN_SN', 'MV_PGU_TEC22', 'T_SN_PGU'], JSON.stringify(miss));
  assert(r.scope.includes('MAKET_SN_PGU_FAKT'), 'вызываемые пакеты входят в область');
  assert(!r.rows.some(x => x.dependency === 'INTER1.KOL_CONST'), 'константы пакета не считаются вызовами');
  assert(r.order.indexOf('MAKET_SN_PGU_FAKT') < r.order.indexOf('MAKET_PT_2026'), 'порядок поставки: сначала зависимости');
  assert.deepStrictEqual(r.missingPackages, ['MAKET_SN_PGU_FAKT']);
  console.log('OK: зависимости пакетов');
}

// --- шаблон вызова: ish_dan_PT_cl(0, d1, d2, 0, e, m) как в справочнике ---
{
  const { buildCalls } = require('../server/verify/calctemplate');
  const ora = { returns: null, args: [
    { name: 'P_MODE', type: 'NUMBER', mode: 'IN' }, { name: 'D1', type: 'DATE', mode: 'IN' }, { name: 'D2', type: 'DATE', mode: 'IN' },
    { name: 'P_PR', type: 'NUMBER', mode: 'IN' }, { name: 'E', type: 'NUMBER', mode: 'IN/OUT' }, { name: 'M', type: 'VARCHAR2', mode: 'OUT' } ] };
  const pg = { schema: 'tec22', name: 'maket_pt_2026_ish_dan_pt_cl', kind: 'p', modes: ['i', 'i', 'i', 'i', 'b', 'b'], types: ['numeric', 'timestamp without time zone', 'timestamp without time zone', 'numeric', 'numeric', 'text'] };
  const r = buildCalls({ package: 'MAKET_PT_2026', procedure: 'ISH_DAN_PT_CL' }, ora, pg, 'TEC22', '2026-03-01', '2026-03-31');
  assert(r.postgres === "CALL tec22.maket_pt_2026_ish_dan_pt_cl(0, DATE '2026-03-01', DATE '2026-03-31', 0, 0, NULL)", r.postgres);
  assert(r.oracle.includes(`"TEC22"."MAKET_PT_2026"."ISH_DAN_PT_CL"(0, DATE '2026-03-01', DATE '2026-03-31', 0, o5, o6)`), r.oracle);
  assert(r.oracle.includes('o5 NUMBER := 0;') && r.oracle.includes("DBMS_OUTPUT.PUT_LINE('OUT:' || o5 || '|' || o6)"), r.oracle);
  const miss = buildCalls({ package: 'MAKET_SN_PGU_FAKT', procedure: 'ISH_DAN_SN' }, ora, { missing: true, expected: 'tec22.maket_sn_pgu_fakt_ish_dan_sn' }, 'TEC22', '2026-03-01', '2026-03-31');
  assert(miss.postgres.startsWith('-- В PostgreSQL нет tec22.maket_sn_pgu_fakt_ish_dan_sn'));
  console.log('OK: шаблон вызовов расчёта');
}

// --- юнит-тесты функций: генерация вызовов и коды ошибок ---
{
  const { generateCalls, errorsMatch, judge } = require('../server/verify/unittests');
  const g = generateCalls([{ name: 'N', type: 'NUMBER', mode: 'IN' }, { name: 'D1', type: 'DATE', mode: 'IN' }, { name: 'D2', type: 'DATE', mode: 'IN' }]);
  assert.deepStrictEqual(g.calls[0], [1, '2026-03-01 00:00:00', '2026-03-31 00:00:00']);       // базовый: 1 и 31 марта
  assert(g.calls.every(c => c.filter((v, i) => v !== g.calls[0][i]).length <= 1), 'в каждом вызове меняется не больше одного параметра');
  assert(g.calls.some(c => c[1] === '2024-02-29 00:00:00'));
  assert.strictEqual(g.calls.length, 1 + 6 + 4 + 4);
  assert(generateCalls([{ name: 'T', type: 'PL/SQL TABLE', mode: 'IN' }]).skip);
  const io = generateCalls([{ name: 'E', type: 'NUMBER', mode: 'IN/OUT' }]);
  assert.strictEqual(io.calls[0][0], 0, 'IN OUT число начинается с 0');
  assert.strictEqual(errorsMatch(-1476, '22012'), true);
  assert.strictEqual(errorsMatch(100, 'P0002'), true);
  assert.strictEqual(errorsMatch(-20001, '45001'), true);
  assert.strictEqual(errorsMatch(-1476, 'P0002'), false);
  assert.strictEqual(judge({ value: '12.50' }, { value: '12.5' }).status, 'pass');
  assert.strictEqual(judge({ value: '' }, { value: null }).status, 'pass');
  assert.strictEqual(judge({ value: '2026-03-01 00:00:00' }, { value: '2026-03-01' }).status, 'pass');
  assert.strictEqual(judge({ err: '-1403' }, { value: '1' }).status, 'fail');
  console.log('OK: юнит-тесты функций');
}

// --- проверка перевода кода Oracle → PostgreSQL ---
{
  const { analyzeTranslation, cleanCode, splitPackageBody, dmlTargets } = require('../server/compare/translation');
  const oraBody = cleanCode(`
PACKAGE BODY maket_pt IS
  PROCEDURE helper(p NUMBER);  -- объявление вперёд
  PROCEDURE ras_pt(p_d1 DATE, p_d2 DATE) IS
    v NUMBER;
  BEGIN
    IF p_d1 IS NULL THEN RAISE_APPLICATION_ERROR(-20001, 'нет даты'); END IF;
    SELECT cnt INTO v FROM sv_day WHERE sv_date = p_d1;
    IF v > 0 THEN INSERT INTO t_rab (a) VALUES (v); END IF;
    UPDATE t_arch SET x = 1 WHERE d_beg = p_d1;
    IF v > 10 THEN NULL; END IF;
    FOR r IN (SELECT 1 FROM dual) LOOP NULL; END LOOP;
  EXCEPTION WHEN NO_DATA_FOUND THEN NULL;
  END;
  FUNCTION get_name(p_id NUMBER) RETURN VARCHAR2 IS
  BEGIN RETURN 'x'; END;
END;`);
  const parts = splitPackageBody(oraBody, ['RAS_PT', 'GET_NAME']);
  assert(parts.get('RAS_PT').includes('t_arch') && !parts.get('RAS_PT').includes('RETURN \'s\''));
  assert.deepStrictEqual([...dmlTargets(parts.get('RAS_PT'))].sort(), ['t_arch', 't_rab']);
  assert.deepStrictEqual([...dmlTargets('SELECT * FROM t FOR UPDATE; INSERT INTO s.x VALUES (1) ON CONFLICT DO UPDATE SET a = 1')], ['x']);
  const pgSrc = cleanCode(`
DECLARE v numeric; s varchar2(10);
BEGIN
  SELECT cnt INTO v FROM sv_day WHERE sv_date = p_d1;
  IF NVL(v, 0) > 0 AND s = '' THEN INSERT INTO app.t_rab (a) VALUES (v); END IF;
  v := TRUNC(p_d1, 'MM') ;
  PERFORM decode('aGk=', 'base64');
  COMMIT;
EXCEPTION WHEN NO_DATA_FOUND THEN NULL;
END`);
  const pg = new Map([
    ['app.maket_pt_ras_pt', [{ kind: 'f', lang: 'plpgsql', returns: 'void', code: pgSrc, args: [{ name: 'p_d1', type: 'timestamp without time zone', mode: 'i' }, { name: 'p_date2', type: 'text', mode: 'i' }] }]],
    ['app.maket_pt_get_name', [{ kind: 'f', lang: 'plpgsql', returns: 'integer', code: "BEGIN RETURN 's'; END", args: [{ name: 'p_id', type: 'numeric', mode: 'i' }] }]],
    ['app.lonely', [{ kind: 'f', lang: 'plpgsql', returns: 'void', code: cleanCode('BEGIN PERFORM 1 FROM dual WHERE ROWNUM = 1; END'), args: [] }]],
  ]);
  const oracle = [
    { package: 'MAKET_PT', name: 'RAS_PT', overloads: [{ args: [{ name: 'P_D1', type: 'DATE', mode: 'IN' }, { name: 'P_D2', type: 'DATE', mode: 'IN' }], returns: null }], code: parts.get('RAS_PT') },
    { package: 'MAKET_PT', name: 'GET_NAME', overloads: [{ args: [{ name: 'P_ID', type: 'NUMBER', mode: 'IN' }], returns: 'VARCHAR2' }], code: parts.get('GET_NAME') },
    { package: 'MAKET_PT', name: 'NOT_PORTED', overloads: [{ args: [], returns: null }], code: '' },
  ];
  const f = analyzeTranslation({ targetSchema: 'APP', oracle, pg, pgFuncs: new Set(['trunc', 'decode']), pgRels: new Set(), pgTypes: new Set() });
  const rules = o => f.filter(x => x.object === o).map(x => x.rule).sort();
  const ras = rules('app.maket_pt_ras_pt');
  for (const r of ['sig-types', 'sig-names', 'nvl', 'oratypes', 'emptystr', 'trunc', 'strict', 'commitfn', 'dml-lost', 'raise-lost', 'flow']) assert(ras.includes(r), `ras_pt: нет правила ${r}: ${ras}`);
  assert(!ras.includes('decode'), 'decode(text, text) — встроенная функция PostgreSQL');
  assert(f.find(x => x.rule === 'dml-lost').message.includes('t_arch'));
  assert(f.find(x => x.rule === 'strict').line === 4, 'номер строки');
  assert.deepStrictEqual(rules('app.maket_pt_get_name'), ['sig-ret']);
  assert.deepStrictEqual(rules('app.lonely'), ['dual', 'rownum']);
  assert(!f.some(x => x.oracle === 'MAKET_PT.NOT_PORTED'));
  // orafce: NVL и dual есть в базе — не ошибка
  const f2 = analyzeTranslation({ targetSchema: 'app', oracle: [], pg, pgFuncs: new Set(['nvl']), pgRels: new Set(['dual']), pgTypes: new Set(['varchar2']) });
  assert(!f2.some(x => ['nvl', 'dual', 'oratypes'].includes(x.rule)));
  console.log('OK: проверка перевода кода');
}

// --- импорт дампа Oracle: заголовок, состав, проблемы, план, журнал ---
{
  const { parseHeader, siblingFiles } = require('../server/dump/header');
  const { parseDdl } = require('../server/dump/sqlfile');
  const { analyzeIssues, buildPlan, unresolved, dpBlock } = require('../server/dump/plan');
  const { classifyLog, importedRows } = require('../server/dump/errors');
  // exp: байты 1–2 — NLS_CHARSET_ID (171 = CL8MSWIN1251)
  const exp = Buffer.concat([Buffer.from([0x03, 0x00, 0xab]), Buffer.from('EXPORT:V11.02.00\nDSCOTT\nRUSERS\n2048\n0\n', 'latin1')]);
  const he = parseHeader(exp);
  assert.strictEqual(he.format, 'exp'); assert.strictEqual(he.charset, 'CL8MSWIN1251'); assert.strictEqual(he.exportedBy, 'SCOTT'); assert.strictEqual(he.mode, 'SCHEMA');
  const dp = Buffer.from('\x00\x01garbage"SYSTEM"."SYS_EXPORT_SCHEMA_01"\x00x86_64/Linux 2.4.xx\x00AL32UTF8\x0019.00.00.00.00\x00', 'latin1');
  const hd = parseHeader(dp);
  assert.strictEqual(hd.format, 'datapump'); assert.strictEqual(hd.mode, 'SCHEMA'); assert.strictEqual(hd.dbVersion, '19.00.00.00.00'); assert.strictEqual(hd.charset, 'AL32UTF8');
  assert.strictEqual(parseHeader(Buffer.from([0x1f, 0x8b, 8, 0])).format, 'gzip');
  assert.deepStrictEqual(siblingFiles('/d/exp_01.dmp', ['exp_02.dmp', 'exp_01.dmp', 'other.dmp', 'exp_1.dmp']), ['exp_01.dmp', 'exp_02.dmp']);

  const c = parseDdl(require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'sqlfile.sql'), 'utf8'));
  const scott = c.schemas.find(s => s.name === 'SCOTT');
  assert(scott && scott.createUser && scott.objects.TABLE === 2 && scott.objects['PACKAGE BODY'] === 1, JSON.stringify(scott));
  assert.deepStrictEqual(c.tablespacesUsed.map(t => t.name).sort(), ['APP_DATA', 'APP_IDX', 'APP_LOB', 'TEMP2']);
  assert(c.tablespacesUsed.find(t => t.name === 'TEMP2').temp);
  assert.deepStrictEqual(c.rolesUsed, ['APP_READER']);
  assert(c.grantees.includes('REPORTS'));
  assert.deepStrictEqual(c.externalRefs.map(r => r.schema), ['HR']);
  assert.strictEqual(c.byteColumns.length, 2);
  assert.strictEqual(c.dbLinks.length, 1);
  // старый exp: строки DDL с CONNECT
  const legacy = parseDdl('CONNECT SCOTT;\nCREATE TABLE "EMP" ("EMPNO" NUMBER(4, 0), "ENAME" VARCHAR2(10))  PCTFREE 10 TABLESPACE "USERS" LOGGING;\nGRANT SELECT ON "EMP" TO "R1";\nCREATE PACKAGE BODY pkg AS;', { legacy: true });
  assert.strictEqual(legacy.schemas[0].name, 'SCOTT'); assert.strictEqual(legacy.schemas[0].objects.TABLE, 1);
  assert.strictEqual(legacy.byteColumns[0].column, 'ENAME');

  const target = {
    user: 'SYSTEM', version: '21.0.0.0.0', charset: 'AL32UTF8', conName: 'XEPDB1', privs: { dba: true }, defaultPermanent: 'USERS', defaultTemp: 'TEMP',
    users: { SCOTT: { exists: true, total: 12, objects: { TABLE: 4 }, sessions: 1 } }, allUsers: ['SCOTT', 'SYSTEM'],
    tablespaces: [{ name: 'USERS', contents: 'PERMANENT', maxMb: 30000 }, { name: 'TEMP', contents: 'TEMPORARY' }], roles: [], datafileDir: 'C:\\APP\\ORADATA\\XE\\XEPDB1', sep: '\\', staleJobs: [{ owner: 'SYSTEM', job: 'SYS_IMPORT_FULL_01' }],
  };
  const a = { format: 'datapump', header: { charset: 'CL8MSWIN1251', dbVersion: '19.00.00.00.00', parts: ['x.dmp'] }, dumpInfo: { charset: 'CL8MSWIN1251' }, contents: c, target, totalSize: 1048576 * 10, directory: { name: 'DBCMP_DUMP_DIR', visible: true } };
  const an = analyzeIssues(a);
  const ids = an.issues.map(i => i.id);
  for (const id of ['charset', 'schema:SCOTT', 'ts:APP_DATA', 'ts:TEMP2', 'roles', 'external', 'dblinks', 'stale']) assert(ids.includes(id), `нет проблемы ${id}: ${ids}`);
  assert.strictEqual(an.defaults.tablespaces.TEMP2.to, 'TEMP', 'временное → TEMP');
  assert.strictEqual(an.defaults.tablespaces.APP_DATA.to, 'USERS');
  assert(an.defaults.byteToChar);
  assert(unresolved(an, an.defaults).some(x => /SCOTT/.test(x)), 'непустая схема требует решения');
  // решение: удалить схему
  const d = JSON.parse(JSON.stringify(an.defaults)); d.schemas.SCOTT = { action: 'drop', target: 'SCOTT' };
  const plan = buildPlan(a, an, d);
  assert.deepStrictEqual(plan.blocking, []);
  const sqls = plan.pre.map(s => s.sql).join('\n');
  assert(/KILL SESSION/.test(sqls) && /DROP USER "SCOTT" CASCADE/.test(sqls) && /CREATE ROLE "APP_READER"/.test(sqls) && /DROP TABLE "SYSTEM"\."SYS_IMPORT_FULL_01" PURGE/.test(sqls), sqls);
  assert(!/CREATE USER/.test(sqls), 'пользователя создаст Data Pump из дампа');
  assert.strictEqual(plan.jobs.length, 3, 'два этапа + перевод колонок');
  assert(plan.jobs[0].metadataOnly && plan.jobs[0].exclude.includes('INDEX'));
  assert(/MODIFY \("DNAME" VARCHAR2\(14 CHAR\)\)/.test(plan.jobs[1].between.map(x => x.sql).join()));
  assert.strictEqual(plan.jobs[2].tableExistsAction, 'APPEND');
  assert.deepStrictEqual(plan.jobs[2].remapTablespace.find(x => x[0] === 'APP_DATA'), ['APP_DATA', 'USERS']);
  const blk = dpBlock({ operation: 'IMPORT', jobName: 'J', dir: 'D', files: ['x.dmp'], logFile: 'l.log', workDir: 'DATA_PUMP_DIR', job: plan.jobs[2] });
  assert(/REMAP_TABLESPACE', 'APP_DATA', 'USERS'/.test(blk) && /'TABLE_EXISTS_ACTION', 'APPEND'/.test(blk) && /'l.log', 'DATA_PUMP_DIR'/.test(blk));
  // решение: под другим именем; в дампе нет CREATE USER → пользователь создаётся с квотами
  const c2 = { ...c, schemas: c.schemas.map(s => ({ ...s, createUser: false })) };
  const a2 = { ...a, contents: c2, format: 'exp' };
  const an2 = analyzeIssues(a2);
  const d2 = JSON.parse(JSON.stringify(an2.defaults)); d2.schemas.SCOTT = { action: 'remap', target: 'SCOTT_COPY' };
  const p2 = buildPlan(a2, an2, d2);
  const s2 = p2.pre.map(s => s.sql).join('\n');
  assert(/CREATE USER "SCOTT_COPY"/.test(s2) && /QUOTA UNLIMITED ON "APP_DATA"/.test(s2) && /CREATE TABLESPACE "APP_DATA" DATAFILE 'C:\\APP\\ORADATA\\XE\\XEPDB1\\app_data01.dbf'/.test(s2), s2);
  assert.deepStrictEqual(p2.imp, { fromuser: ['SCOTT'], touser: ['SCOTT_COPY'], ignore: true });
  // CDB$ROOT и отсутствие прав — блокирующие
  const an3 = analyzeIssues({ ...a, target: { ...target, conName: 'CDB$ROOT', privs: {} } });
  assert(an3.issues.find(i => i.id === 'cdb').blocking && an3.issues.find(i => i.id === 'privileges').blocking);

  const log = [
    'Processing object type SCHEMA_EXPORT/TABLE/TABLE',
    'ORA-39083: Object type TABLE:"SCOTT"."EMP" failed to create with error:',
    'ORA-00959: tablespace \'APP_DATA\' does not exist',
    'Failing sql is:',
    'CREATE TABLE "SCOTT"."EMP" (...)',
    'ORA-31684: Object type USER:"SCOTT" already exists',
    'ORA-02374: conversion error loading table "SCOTT"."DEPT"',
    'ORA-12899: value too large for column DNAME (actual: 16, maximum: 14)',
    '. . imported "SCOTT"."DEPT"                              5.929 KB       4 rows',
  ];
  const g = classifyLog(log);
  assert.strictEqual(g[0].benign, undefined);
  assert(g.find(x => x.code === 'ORA-00959').objects.includes('SCOTT.EMP'));
  assert(g.find(x => x.code === 'ORA-12899').fix === 'byteToChar');
  assert(g[g.length - 1].benign, 'безвредные — в конце');
  assert.deepStrictEqual(importedRows(log), [{ owner: 'SCOTT', table: 'DEPT', partition: null, size: '5.929 KB', rows: 4 }]);
  console.log('OK: импорт дампа Oracle');
}

// --- проверка перед запуском и разбор ошибок ---
{
  const { deepMerge, applySelection, unresolvedOf } = require('../server/preflight/common');
  const { diagnoseJob, retryParams } = require('../server/lib/diagnose');
  assert.deepStrictEqual(deepMerge({ a: 1, l: [1], o: { x: 1 } }, { a: 2, l: [2], o: { y: 2 } }), { a: 2, l: [1, 2], o: { x: 1, y: 2 } });
  const issues = [
    { id: 'nonempty', required: true, choice: true, title: 'не пусто', fixes: [{ id: 'truncate', danger: true, patch: { mode: 'truncate' } }, { id: 'skip', patch: { skipTables: ['a'] } }] },
    { id: 'widen', fixes: [{ id: 'w', default: true, patch: { preSql: [{ sql: 'ALTER 1' }] } }] },
    { id: 'schema', blocking: true, title: 'нет схемы', fixes: [{ id: 'c', default: true, input: { label: 'Пароль', value: 'x' }, patch: { preSql: [{ sql: 'CREATE USER u IDENTIFIED BY "{{value}}"' }] } }] },
    { id: 'remap', choice: true, fixes: [{ id: 'r', default: true, input: { path: 'targetSchema', value: 'new_s', upper: true }, patch: {} }] },
  ];
  assert.deepStrictEqual(unresolvedOf(issues, {}), ['не пусто']);
  const r = applySelection({ mode: 'append', preSql: [{ sql: 'X' }] }, issues, { nonempty: 'skip' }, { 'schema/c': 'S3cret' });
  assert.deepStrictEqual(r.params.skipTables, ['a']);
  assert.strictEqual(r.params.mode, 'append');
  assert.deepStrictEqual(r.params.preSql.map(x => x.sql), ['X', 'ALTER 1', 'CREATE USER u IDENTIFIED BY "S3cret"']);
  assert.strictEqual(r.params.targetSchema, 'NEW_S');
  assert.deepStrictEqual(unresolvedOf(issues, { nonempty: 'truncate' }), []);
  assert.deepStrictEqual(unresolvedOf(issues, { schema: [] }).length, 2, 'блокирующая без выбранного исправления');

  const job = { id: 'j1', type: 'transfer', status: 'done', params: { mode: 'append', preSql: [{ sql: 'x' }], encryptionPassword: '***' },
    log: [{ level: 'error', msg: 'dept: ошибка — duplicate key value violates unique constraint "dept_pkey"' }, { level: 'error', msg: 'emp: ошибка — value too long for type character varying(10)' }, { level: 'warning', msg: 'что-то нераспознанное' }],
    result: { tables: [{ table: 'dept', status: 'error', error: 'duplicate key value violates unique constraint "dept_pkey"' }, { table: 'big', status: 'done' }] } };
  const d = diagnoseJob(job);
  assert.deepStrictEqual(d.groups.map(g => g.id).sort(), ['dup', 'toolong']);
  assert.strictEqual(d.groups.find(g => g.id === 'dup').count, 1, 'ошибка из результата не дублируется');
  const rp = retryParams(job, ['dup', 'toolong']);
  assert.strictEqual(rp.params.mode, 'truncate'); assert.deepStrictEqual(rp.params.skipTables, ['big']);
  assert(!rp.params.preSql && !('encryptionPassword' in rp.params) && rp.recheck);
  const pg = diagnoseJob({ type: 'pgdump', status: 'done', params: {}, log: [{ level: 'info', msg: 'pg_restore: error: could not execute query: ERROR:  role "app_owner" does not exist' }] });
  assert.strictEqual(pg.groups[0].id, 'role'); assert.deepStrictEqual(pg.fixes[0].patch, { noOwner: true, noPrivileges: true });
  console.log('OK: проверка перед запуском и разбор ошибок');
}

// --- сервисные функции: планы, индексы, аудит, маскирование, поиск, документация, снимки ---
{
  const { analyzePgPlan, adviseFromMeta } = require('../server/tools/perf');
  const { implicitRefs } = require('../server/tools/health');
  const { makeMasker, detectColumn } = require('../server/testdata/mask');
  const { matchLines } = require('../server/tools/search');
  const { erSvg } = require('../server/tools/docs');
  const { structureHash } = require('../server/history/snapshots');
  const plan = { Plan: { 'Node Type': 'Nested Loop', 'Plan Rows': 10, 'Actual Rows': 50000, 'Actual Loops': 1, Plans: [
    { 'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Plan Rows': 100, 'Actual Rows': 500, 'Actual Loops': 1, Filter: "((status)::text = 'NEW'::text AND (client_id = 5))", 'Rows Removed by Filter': 900000 },
    { 'Node Type': 'Seq Scan', 'Relation Name': 'items', 'Plan Rows': 1, 'Actual Rows': 1, 'Actual Loops': 5000, Filter: '((order_id)::numeric = o.id)' },
  ] } };
  const f = analyzePgPlan(plan, 'app');
  const kinds = f.map(x => x.kind);
  for (const k of ['seqscan', 'cast', 'nlseq', 'estimate']) assert(kinds.includes(k), `план: нет ${k} — ${kinds}`);
  assert(/\("status", "client_id"\)/.test(f.find(x => x.kind === 'seqscan').sql), f.find(x => x.kind === 'seqscan').sql);
  const db = { type: 'postgres', quote: x => `"${x}"` };
  const meta = { schema: 'app', tables: [
    { name: 'dept', columns: [{ name: 'id', family: 'int' }], pk: { columns: ['id'] }, uniques: [], indexes: [], fks: [] },
    { name: 'emp', columns: [{ name: 'id', family: 'int' }, { name: 'dept_id', family: 'int' }, { name: 'boss_id', family: 'int' }], pk: { columns: ['id'] }, uniques: [],
      indexes: [{ name: 'ix_a', columns: ['dept_id'] }, { name: 'ix_b', columns: ['dept_id', 'id'] }], fks: [{ name: 'fk1', columns: ['dept_id'], refTable: 'dept' }] },
    { name: 'log', columns: [{ name: 'emp_id', family: 'int' }, { name: 'dept_id', family: 'int' }], uniques: [], indexes: [], fks: [{ name: 'fk2', columns: ['emp_id'], refTable: 'emp' }] },
  ] };
  const adv = adviseFromMeta(meta, db, { name: 'Oracle', meta: { tables: [{ name: 'EMP', indexes: [{ name: 'IX_BOSS', columns: ['BOSS_ID'] }] }] } });
  const ak = adv.map(a => `${a.kind}:${a.table}`);
  for (const k of ['nopk:log', 'fk:log', 'dup:emp', 'missing:emp']) assert(ak.includes(k), `индексы: нет ${k} — ${ak}`);
  assert(!ak.includes('fk:emp'), 'FK emp.dept_id покрыт индексом');
  assert.deepStrictEqual(implicitRefs(meta).map(r => `${r.table}.${r.column}->${r.refTable}`), ['log.dept_id->dept']);
  const m = makeMasker('k');
  assert.strictEqual(m('fullname')('Иванова Анна Петровна'), m('fullname')('Иванова Анна Петровна'), 'детерминированность');
  assert(/(ова|ева|ёва|ина|ая) \S+ \S+(вна|чна)$/.test(m('fullname')('Иванова Анна Петровна')), m('fullname')('Иванова Анна Петровна'));
  assert.notStrictEqual(m('fullname')('Иванов И.И.'), 'Иванов И.И.');
  const sn = m('snils')('112-233-445 95');
  assert(/^\d{3}-\d{3}-\d{3} \d{2}$/.test(sn));
  const d9 = sn.replace(/\D/g, '').slice(0, 9).split('').map(Number); let sum = d9.reduce((a, x, i) => a + x * (9 - i), 0);
  const ctl = sum < 100 ? sum : sum === 100 || sum === 101 ? 0 : sum % 101 === 100 ? 0 : sum % 101;
  assert.strictEqual(Number(sn.slice(-2)), ctl, 'контрольная сумма СНИЛС');
  const inn = m('inn')('7707083893');
  const w = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  assert.strictEqual(Number(inn[9]), (inn.slice(0, 9).split('').reduce((a, x, i) => a + x * w[i], 0) % 11) % 10, 'контрольная сумма ИНН');
  assert(/^\+7 \(\d{3}\) \d{3}-\d{2}-\d{2}$/.test(m('phone')('+7 (912) 345-67-89')));
  assert.strictEqual(m('email')(null), null);
  assert.strictEqual(m('date_shift')('1980-05-01').length, 10);
  assert.strictEqual(detectColumn('t', { name: 'FAM', family: 'string' }).method, 'lastname');
  assert.strictEqual(detectColumn('t', { name: 'contact', family: 'string' }, Array(10).fill('a.b@c.ru')).method, 'email');
  assert.strictEqual(detectColumn('t', { name: 'dr', family: 'int' }), null);
  assert.deepStrictEqual(matchLines('a\nSELECT x FROM T_ARCH\nb', 't_arch').map(x => x.line), [2]);
  assert(/<svg/.test(erSvg(meta.tables)) && /dept/.test(erSvg(meta.tables)));
  assert.strictEqual(structureHash({ ...meta, views: [], mviews: [], sequences: [], routines: [], triggers: [] }), structureHash({ ...meta, views: [], mviews: [], sequences: [], routines: [], triggers: [], tables: meta.tables.map(t => ({ ...t, rowEstimate: 999 })) }), 'хеш не зависит от числа строк');
  console.log('OK: сервисные функции');
}

// --- зависимости кода в дампе ---
{
  const { extractRefs, classify } = require('../server/dump/codedeps');
  const { parseDdl } = require('../server/dump/sqlfile');
  const { analyzeIssues } = require('../server/dump/plan');
  const refs = extractRefs(`CREATE OR REPLACE PACKAGE BODY "SCOTT"."PKG2" AS
    PROCEDURE p IS v hr.employees%ROWTYPE; BEGIN
      fin.calc_pkg.run(1); -- comment util.x(1)
      SELECT 1 INTO v.x FROM hr.jobs j JOIN reports r ON 1=1; INSERT INTO t@prodlink VALUES (1);
      DBMS_OUTPUT.PUT_LINE('fin.fake(1)'); END; END;`);
  const keys = refs.map(r => [r.a, r.b, r.link].filter(Boolean).join('.'));
  assert(keys.includes('FIN.CALC_PKG') && keys.includes('HR.JOBS') && keys.includes('HR.EMPLOYEES'), keys.join(','));
  assert(!keys.some(k => /^UTIL|FAKE|^V\./.test(k)), 'комментарии, строки и поля записей не считаются: ' + keys);
  assert(refs.some(r => r.link === 'PRODLINK'));
  const c = parseDdl(`CREATE USER "SCOTT" IDENTIFIED BY VALUES 'x';
CREATE TABLE "SCOTT"."T" ("ID" NUMBER);
CREATE OR REPLACE PACKAGE BODY "SCOTT"."PKG2" AS PROCEDURE p IS BEGIN fin.calc_pkg.run(1); hr.jobs_api.go; INSERT INTO hr.employees VALUES (1); INSERT INTO t VALUES (1); END; END;
/`);
  assert(c.codeRefs.length >= 1 && c.objectNames.SCOTT.includes('T'));
  const cd = classify(c, { users: new Set(['HR']), objects: new Map([['HR', new Set(['EMPLOYEES'])]]), named: new Set(), dbLinks: new Set() });
  const miss = cd.missing.map(x => x.ref);
  assert(miss.includes('FIN') && miss.includes('HR.JOBS_API') && !miss.includes('HR.EMPLOYEES') && !miss.includes('SCOTT.T'), miss.join(','));
  const an = analyzeIssues({ format: 'datapump', header: {}, dumpInfo: {}, contents: c, codeDeps: cd, target: { privs: { dba: true }, users: {}, tablespaces: [], allUsers: ['HR'] }, directory: { visible: true } });
  const iss = an.issues.find(i => i.id === 'code-deps');
  assert(iss && iss.level === 'warning' && iss.list.some(l => l.startsWith('FIN')), 'проблема code-deps');
  console.log('OK: зависимости кода в дампе');
}

// --- выборочный импорт из дампа ---
{
  const { parseDdl } = require('../server/dump/sqlfile');
  const { closure, matchObjects, nameMatcher } = require('../server/dump/select');
  const { buildPlan, dpBlock, impdpCommand, unresolved } = require('../server/dump/plan');
  const c = parseDdl(`CREATE USER "S" IDENTIFIED BY VALUES 'x';
CREATE TABLE "S"."ORD_2026" ("ID" NUMBER, "C" NUMBER);
CREATE TABLE "S"."CLIENTS" ("ID" NUMBER, "R" NUMBER);
CREATE TABLE "S"."REGIONS" ("ID" NUMBER);
CREATE TABLE "S"."OTHER" ("ID" NUMBER);
CREATE SEQUENCE "S"."SEQ_ORD" START WITH 1;
ALTER TABLE "S"."ORD_2026" ADD CONSTRAINT "FK1" FOREIGN KEY ("C") REFERENCES "S"."CLIENTS" ("ID") ENABLE;
ALTER TABLE "S"."CLIENTS" ADD CONSTRAINT "FK2" FOREIGN KEY ("R") REFERENCES "S"."REGIONS" ("ID") ENABLE;
CREATE OR REPLACE TRIGGER "S"."TRG_ORD" BEFORE INSERT ON "S"."ORD_2026" FOR EACH ROW BEGIN :new.id := seq_ord.nextval; END;
/
CREATE OR REPLACE PACKAGE BODY "S"."RPT_2026" AS PROCEDURE p IS BEGIN DELETE FROM other; END; END;
/
CREATE OR REPLACE VIEW "S"."V_X" AS SELECT * FROM other;
`);
  assert(nameMatcher('2026')('ord_2026') && nameMatcher('ORD\\_%', 'like') && nameMatcher('%_2026', 'like')('RPT_2026') && !nameMatcher('%_2026', 'like')('RPT_2025'));
  const seeds = matchObjects(c.objects, { mask: '2026' }).map(o => o.id);
  assert.deepStrictEqual(seeds.sort(), ['PACKAGE:S.RPT_2026', 'TABLE:S.ORD_2026']);
  // REGIONS уже есть в базе → не тянем; остальное — из дампа
  const r = closure(c.objects, seeds, (o, n) => o === 'S' && n === 'REGIONS');
  const ids = r.rows.map(x => x.id).sort();
  assert.deepStrictEqual(ids, ['PACKAGE:S.RPT_2026', 'SEQUENCE:S.SEQ_ORD', 'TABLE:S.CLIENTS', 'TABLE:S.ORD_2026', 'TABLE:S.OTHER', 'TRIGGER:S.TRG_ORD']);
  assert.strictEqual(r.rows.find(x => x.id === 'TRIGGER:S.TRG_ORD').reason, 'trigger');
  assert.strictEqual(r.rows.find(x => x.id === 'TABLE:S.CLIENTS').via, 'TABLE:S.ORD_2026');
  assert.deepStrictEqual(r.existing.map(x => x.id), ['TABLE:S.REGIONS']);
  assert(!ids.includes('VIEW:S.V_X'));
  // план: одно задание с INCLUDE, пользователь создаётся заранее, решение по существующей схеме не обязательно
  const a = { format: 'datapump', header: { parts: ['x.dmp'] }, contents: c, target: { users: { S: { exists: false } }, allUsers: [], user: 'SYSTEM', directories: [] } };
  const an = { issues: [{ id: 'schema-S', needsDecision: true, schema: 'S', title: 'Схема S уже есть' }], defaults: {} };
  const d = { schemas: {}, tablespaces: {}, objects: r.rows.map(x => x.id) };
  assert.deepStrictEqual(unresolved(an, d), []);
  const p = buildPlan(a, an, d);
  assert.strictEqual(p.jobs.length, 1);
  assert.deepStrictEqual(p.jobs[0].include.names.TABLE, ['CLIENTS', 'ORD_2026', 'OTHER']);
  assert.deepStrictEqual(p.jobs[0].include.names.PACKAGE_BODY, ['RPT_2026']);
  assert(p.pre.some(s => /CREATE USER "S"/.test(s.sql)), 'пользователь создаётся заранее');
  const blk = dpBlock({ jobName: 'J', dir: 'D', files: ['x.dmp'], job: p.jobs[0] });
  assert(/INCLUDE_PATH_EXPR', 'IN \(''TABLE'',/.test(blk) && /NAME_EXPR', 'IN \(''CLIENTS'',''ORD_2026'',''OTHER''\)', 'TABLE'\)/.test(blk) && !/EXCLUDE_PATH_EXPR/.test(blk), blk);
  assert(/include=TRIGGER:"IN \('TRG_ORD'\)"/.test(impdpCommand({ user: 'SYSTEM' }, 'D', ['x.dmp'], p.jobs[0])));
  console.log('OK: выборочный импорт из дампа');
}
