'use strict';
// Чтение метаданных схемы Oracle в единую модель.
const { oracleFamily } = require('../lib/typemap');

const num = v => (v == null ? null : Number(v));

function oracleTypeString(c) {
  const t = c.data_type;
  switch (t) {
    case 'VARCHAR2': case 'CHAR':
      return `${t}(${num(c.char_length)}${c.char_used === 'C' ? ' CHAR' : ' BYTE'})`;
    case 'NVARCHAR2': case 'NCHAR': return `${t}(${num(c.char_length)})`;
    case 'NUMBER':
      if (c.data_precision == null && c.data_scale == null) return 'NUMBER';
      if (c.data_precision == null) return num(c.data_scale) === 0 ? 'INTEGER' : `NUMBER(*,${c.data_scale})`;
      return num(c.data_scale) ? `NUMBER(${c.data_precision},${c.data_scale})` : `NUMBER(${c.data_precision})`;
    case 'FLOAT': return `FLOAT(${num(c.data_precision)})`;
    case 'RAW': return `RAW(${num(c.data_length)})`;
    default: return t;
  }
}

async function loadOracleMeta(db, schema, opts = {}, ctx) {
  const own = schema; // имена в Oracle чувствительны к регистру — берём как выбрано
  const b = { own };
  const log = m => ctx && ctx.log(m);

  log(`Oracle ${own}: таблицы`);
  const tablesRows = await db.query(`
    SELECT t.table_name, t.num_rows, t.partitioned, t.temporary
    FROM all_tables t
    WHERE t.owner = :own
      AND t.nested = 'NO'
      AND (t.iot_type IS NULL OR t.iot_type = 'IOT')
      AND t.table_name NOT LIKE 'BIN$%'
      AND t.table_name NOT LIKE 'MLOG$\\_%' ESCAPE '\\'
      AND t.table_name NOT LIKE 'RUPD$\\_%' ESCAPE '\\'
      AND NOT EXISTS (SELECT 1 FROM all_mviews m WHERE m.owner = t.owner AND m.mview_name = t.table_name)
      AND NOT EXISTS (SELECT 1 FROM all_external_tables e WHERE e.owner = t.owner AND e.table_name = t.table_name)
    ORDER BY t.table_name`, b);

  const tables = new Map();
  for (const r of tablesRows) {
    tables.set(r.table_name, {
      name: r.table_name, columns: [], pk: null, uniques: [], fks: [], checks: [], indexes: [], triggers: [],
      rowCount: null, rowEstimate: num(r.num_rows), partitioned: r.partitioned === 'YES', temporary: r.temporary === 'Y',
    });
  }

  log(`Oracle ${own}: колонки`);
  const cols = await db.query(`
    SELECT table_name, column_name, data_type, data_length, char_length, char_used,
           data_precision, data_scale, nullable, data_default, column_id
    FROM all_tab_columns
    WHERE owner = :own
    ORDER BY table_name, column_id`, b);
  for (const c of cols) {
    const t = tables.get(c.table_name);
    if (!t) continue;
    const col = {
      name: c.column_name,
      dataType: c.data_type,
      type: oracleTypeString(c),
      length: ['VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR'].includes(c.data_type) ? num(c.char_length) : (c.data_type === 'RAW' ? num(c.data_length) : null),
      precision: c.data_type === 'NUMBER' ? num(c.data_precision) : null,
      scale: c.data_type === 'NUMBER' ? num(c.data_scale) : null,
      fsp: c.data_type === 'DATE' ? 0 : (String(c.data_type).startsWith('TIMESTAMP') ? num(c.data_scale) : null),
      isChar: c.data_type === 'CHAR' || c.data_type === 'NCHAR',
      nullable: c.nullable === 'Y',
      default: c.data_default == null ? null : String(c.data_default).trim(),
      position: num(c.column_id),
    };
    col.family = oracleFamily(col);
    t.columns.push(col);
  }

  log(`Oracle ${own}: ограничения`);
  const cons = await db.query(`
    SELECT c.constraint_name, c.constraint_type, c.table_name, c.r_owner, c.r_constraint_name,
           c.status, c.delete_rule, cc.column_name, cc.position
    FROM all_constraints c
    JOIN all_cons_columns cc
      ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name AND cc.table_name = c.table_name
    WHERE c.owner = :own AND c.constraint_type IN ('P','U','R')
    ORDER BY c.table_name, c.constraint_name, cc.position`, b);
  const consMap = new Map();
  for (const r of cons) {
    let c = consMap.get(r.constraint_name);
    if (!c) {
      c = { name: r.constraint_name, type: r.constraint_type, table: r.table_name, rOwner: r.r_owner, rName: r.r_constraint_name, enabled: r.status === 'ENABLED', deleteRule: r.delete_rule, columns: [] };
      consMap.set(r.constraint_name, c);
    }
    c.columns.push(r.column_name);
  }
  // Ссылки FK на ограничения в других схемах
  const foreignRefs = [...consMap.values()].filter(c => c.type === 'R' && c.rOwner !== own);
  const extRef = new Map();
  if (foreignRefs.length) {
    const rows = await db.query(`
      SELECT c.owner, c.constraint_name, c.table_name, cc.column_name
      FROM all_constraints c JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
      WHERE c.constraint_type IN ('P','U') AND c.owner <> :own
        AND (c.owner, c.constraint_name) IN (SELECT r_owner, r_constraint_name FROM all_constraints WHERE owner = :own AND constraint_type = 'R')
      ORDER BY c.owner, c.constraint_name, cc.position`, b);
    for (const r of rows) {
      const k = r.owner + '.' + r.constraint_name;
      if (!extRef.has(k)) extRef.set(k, { table: r.table_name, owner: r.owner, columns: [] });
      extRef.get(k).columns.push(r.column_name);
    }
  }
  for (const c of consMap.values()) {
    const t = tables.get(c.table);
    if (!t) continue;
    if (c.type === 'P') t.pk = { name: c.name, columns: c.columns };
    else if (c.type === 'U') t.uniques.push({ name: c.name, columns: c.columns });
    else {
      const ref = c.rOwner === own ? consMap.get(c.rName) : extRef.get(c.rOwner + '.' + c.rName);
      t.fks.push({
        name: c.name, columns: c.columns, enabled: c.enabled, deleteRule: c.deleteRule,
        refSchema: c.rOwner, refTable: ref ? ref.table : null, refColumns: ref ? ref.columns : [],
      });
    }
  }

  // CHECK-ограничения (кроме служебных NOT NULL)
  const checks = await db.query(`
    SELECT constraint_name, table_name, search_condition, status
    FROM all_constraints WHERE owner = :own AND constraint_type = 'C'`, b);
  for (const r of checks) {
    const t = tables.get(r.table_name);
    const cond = String(r.search_condition || '').trim();
    if (!t || /^"?[^"\s]+"?\s+IS\s+NOT\s+NULL$/i.test(cond)) continue;
    t.checks.push({ name: r.constraint_name, def: cond, enabled: r.status === 'ENABLED' });
  }

  log(`Oracle ${own}: индексы`);
  const idx = await db.query(`
    SELECT i.index_name, i.table_name, i.uniqueness, i.index_type, ic.column_name, ic.column_position,
           ie.column_expression
    FROM all_indexes i
    JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
    LEFT JOIN all_ind_expressions ie ON ie.index_owner = i.owner AND ie.index_name = i.index_name AND ie.column_position = ic.column_position
    WHERE i.owner = :own AND i.table_owner = :own AND i.index_type <> 'LOB'
    ORDER BY i.table_name, i.index_name, ic.column_position`, b);
  const idxMap = new Map();
  for (const r of idx) {
    let i = idxMap.get(r.index_name);
    if (!i) { i = { name: r.index_name, table: r.table_name, unique: r.uniqueness === 'UNIQUE', kind: r.index_type, columns: [] }; idxMap.set(r.index_name, i); }
    i.columns.push(r.column_expression ? String(r.column_expression).replace(/"/g, '').toLowerCase() : r.column_name);
  }
  for (const i of idxMap.values()) {
    const t = tables.get(i.table);
    if (t) t.indexes.push({ name: i.name, columns: i.columns, unique: i.unique, kind: i.kind });
  }

  log(`Oracle ${own}: триггеры, представления, последовательности, код`);
  const trg = await db.query(`
    SELECT trigger_name, table_name, status, triggering_event, trigger_type
    FROM all_triggers WHERE owner = :own`, b);
  const triggers = trg.map(r => ({ name: r.trigger_name, table: r.table_name, enabled: r.status === 'ENABLED', event: r.triggering_event, timing: r.trigger_type }));
  for (const tr of triggers) { const t = tables.get(tr.table); if (t) t.triggers.push(tr.name); }

  const views = (await db.query(`SELECT view_name FROM all_views WHERE owner = :own ORDER BY view_name`, b)).map(r => ({ name: r.view_name }));
  const mviews = (await db.query(`SELECT mview_name FROM all_mviews WHERE owner = :own ORDER BY mview_name`, b)).map(r => ({ name: r.mview_name }));
  const sequences = (await db.query(`
    SELECT sequence_name, last_number, increment_by, min_value, max_value, cycle_flag
    FROM all_sequences WHERE sequence_owner = :own ORDER BY sequence_name`, b))
    .map(r => ({ name: r.sequence_name, value: r.last_number, increment: r.increment_by }));

  const objs = await db.query(`
    SELECT object_name, object_type, status FROM all_objects
    WHERE owner = :own AND object_type IN ('FUNCTION','PROCEDURE','PACKAGE','PACKAGE BODY','TYPE','TYPE BODY','TRIGGER','VIEW','MATERIALIZED VIEW','SYNONYM')
    ORDER BY object_type, object_name`, b);
  const routines = objs.filter(o => o.object_type === 'FUNCTION' || o.object_type === 'PROCEDURE')
    .map(o => ({ name: o.object_name, key: o.object_name, kind: o.object_type === 'FUNCTION' ? 'function' : 'procedure', valid: o.status === 'VALID' }));
  const packages = objs.filter(o => o.object_type === 'PACKAGE').map(o => o.object_name);
  const pkgSubs = await db.query(`
    SELECT DISTINCT object_name, procedure_name FROM all_procedures
    WHERE owner = :own AND object_type = 'PACKAGE' AND procedure_name IS NOT NULL`, b);
  for (const p of pkgSubs) {
    routines.push({ name: `${p.object_name}.${p.procedure_name}`, key: `${p.object_name}.${p.procedure_name}`, kind: 'package routine', package: p.object_name, valid: true });
  }
  const types = objs.filter(o => o.object_type === 'TYPE').map(o => ({ name: o.object_name }));
  const synonyms = objs.filter(o => o.object_type === 'SYNONYM').map(o => ({ name: o.object_name }));
  const invalid = objs.filter(o => o.status !== 'VALID').map(o => ({ name: o.object_name, type: o.object_type }));

  // Количество строк
  const tableList = [...tables.values()];
  if (opts.rowCounts === 'exact') {
    let i = 0;
    for (const t of tableList) {
      ctx && ctx.checkCancel();
      ctx && ctx.progress(++i, tableList.length, `Oracle: COUNT(*) ${t.name}`);
      try { t.rowCount = Number((await db.query(`SELECT COUNT(*) AS cnt FROM ${db.qualify(own, t.name)}`))[0].cnt); }
      catch (e) { t.rowCountError = e.message; }
    }
  } else if (opts.rowCounts === 'estimate') {
    for (const t of tableList) t.rowCount = t.rowEstimate;
  }

  return { dbType: 'oracle', schema: own, tables: tableList, views, mviews, sequences, routines, packages, types, synonyms, triggers, invalid };
}

module.exports = { loadOracleMeta };
