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
