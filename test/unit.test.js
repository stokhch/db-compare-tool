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
