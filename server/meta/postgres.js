'use strict';
// Чтение метаданных схемы PostgreSQL в единую модель.
const { pgFamily } = require('../lib/typemap');

function parseTypmod(fullType) {
  // varchar(100) / numeric(12,2) / timestamp(3) without time zone
  const m = /\((\d+)(?:,(\d+))?\)/.exec(fullType);
  return m ? { a: Number(m[1]), b: m[2] != null ? Number(m[2]) : null } : null;
}

/**
 * @param extraSchemas схемы, где ora2pg размещает функции пакетов (PACKAGE_AS_SCHEMA)
 */
async function loadPgMeta(db, schema, opts = {}, ctx, extraSchemas = []) {
  const log = m => ctx && ctx.log(m);
  log(`PostgreSQL ${schema}: таблицы`);
  const tablesRows = await db.query(`
    SELECT c.oid, c.relname, c.relkind, c.reltuples::bigint AS est, c.relpersistence
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind IN ('r','p') AND NOT c.relispartition
    ORDER BY c.relname`, [schema]);
  const tables = new Map();
  for (const r of tablesRows) {
    tables.set(r.relname, {
      name: r.relname, columns: [], pk: null, uniques: [], fks: [], checks: [], indexes: [], triggers: [],
      rowCount: null, rowEstimate: Math.max(Number(r.est), 0), partitioned: r.relkind === 'p', temporary: r.relpersistence === 't',
    });
  }

  log(`PostgreSQL ${schema}: колонки`);
  const cols = await db.query(`
    SELECT c.relname AS table_name, a.attname AS column_name, a.attnum,
           format_type(a.atttypid, a.atttypmod) AS full_type,
           CASE WHEN t.typtype = 'd' THEN bt.typname ELSE t.typname END AS udt,
           t.typcategory, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS def,
           a.attidentity, a.attgenerated
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_type bt ON bt.oid = t.typbasetype
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = $1 AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum`, [schema]);
  for (const c of cols) {
    const t = tables.get(c.table_name);
    if (!t) continue;
    const tm = parseTypmod(c.full_type);
    const udt = c.udt;
    const col = {
      name: c.column_name,
      dataType: udt,
      udt,
      type: c.full_type,
      length: (udt === 'varchar' || udt === 'bpchar') && tm ? tm.a : null,
      precision: udt === 'numeric' && tm ? tm.a : null,
      scale: udt === 'numeric' ? (tm ? (tm.b ?? 0) : null) : (['int2', 'int4', 'int8'].includes(udt) ? 0 : null),
      fsp: (udt === 'timestamp' || udt === 'timestamptz') ? (tm ? tm.a : 6) : (udt === 'date' ? 0 : null),
      isChar: udt === 'bpchar',
      isArray: c.typcategory === 'A',
      nullable: !c.attnotnull,
      default: c.def,
      identity: c.attidentity || null,
      position: c.attnum,
    };
    col.family = col.isArray ? 'other' : pgFamily(col);
    t.columns.push(col);
  }

  log(`PostgreSQL ${schema}: ограничения`);
  const cons = await db.query(`
    SELECT con.conname, con.contype, cl.relname AS table_name, con.convalidated,
           ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS cols,
           rn.nspname AS ref_schema, rcl.relname AS ref_table,
           ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS ref_cols,
           con.confdeltype, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    LEFT JOIN pg_class rcl ON rcl.oid = con.confrelid
    LEFT JOIN pg_namespace rn ON rn.oid = rcl.relnamespace
    WHERE n.nspname = $1 AND con.contype IN ('p','u','f','c')
    ORDER BY cl.relname, con.conname`, [schema]);
  const delRule = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
  for (const r of cons) {
    const t = tables.get(r.table_name);
    if (!t) continue;
    if (r.contype === 'p') t.pk = { name: r.conname, columns: r.cols };
    else if (r.contype === 'u') t.uniques.push({ name: r.conname, columns: r.cols });
    else if (r.contype === 'f') t.fks.push({ name: r.conname, columns: r.cols, refSchema: r.ref_schema, refTable: r.ref_table, refColumns: r.ref_cols, enabled: true, deleteRule: delRule[r.confdeltype] });
    else t.checks.push({ name: r.conname, def: r.def, enabled: r.convalidated });
  }

  log(`PostgreSQL ${schema}: индексы`);
  const idx = await db.query(`
    SELECT i.relname AS index_name, t.relname AS table_name, ix.indisunique, ix.indisprimary, am.amname,
           ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k + 1, true)
                 FROM generate_series(0, ix.indnkeyatts - 1) k ORDER BY k)::text[] AS cols
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_am am ON am.oid = i.relam
    WHERE n.nspname = $1 AND t.relkind IN ('r','p')
    ORDER BY t.relname, i.relname`, [schema]);
  for (const r of idx) {
    const t = tables.get(r.table_name);
    if (t) t.indexes.push({ name: r.index_name, columns: r.cols.map(c => c.replace(/"/g, '')), unique: r.indisunique, kind: r.amname });
  }

  log(`PostgreSQL ${schema}: триггеры, представления, последовательности, функции`);
  const trg = await db.query(`
    SELECT tg.tgname, c.relname AS table_name, tg.tgenabled, p.proname AS func
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = tg.tgfoid
    WHERE n.nspname = $1 AND NOT tg.tgisinternal`, [schema]);
  const triggers = trg.map(r => ({ name: r.tgname, table: r.table_name, enabled: r.tgenabled !== 'D', func: r.func }));
  for (const tr of triggers) { const t = tables.get(tr.table); if (t) t.triggers.push(tr.name); }

  const views = (await db.query(`SELECT viewname AS name FROM pg_views WHERE schemaname = $1 ORDER BY 1`, [schema]));
  const mviews = (await db.query(`SELECT matviewname AS name FROM pg_matviews WHERE schemaname = $1 ORDER BY 1`, [schema]));
  const sequences = (await db.query(`
    SELECT s.relname AS name,
           (SELECT last_value FROM pg_sequences ps WHERE ps.schemaname = n.nspname AND ps.sequencename = s.relname) AS value,
           sq.seqincrement AS increment
    FROM pg_class s JOIN pg_namespace n ON n.oid = s.relnamespace JOIN pg_sequence sq ON sq.seqrelid = s.oid
    WHERE n.nspname = $1 AND s.relkind = 'S' ORDER BY 1`, [schema]).catch(() => []));

  const schemasForRoutines = [schema, ...extraSchemas.map(s => s.toLowerCase())];
  const procs = await db.query(`
    SELECT n.nspname, p.proname, p.prokind
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = ANY($1::text[])
      AND p.prorettype <> 'trigger'::regtype
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    ORDER BY 1, 2`, [schemasForRoutines]).catch(async () =>
    // PostgreSQL < 11: нет prokind
    db.query(`SELECT n.nspname, p.proname, CASE WHEN p.proisagg THEN 'a' ELSE 'f' END AS prokind
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = ANY($1::text[]) AND p.prorettype <> 'trigger'::regtype ORDER BY 1, 2`, [schemasForRoutines]));
  const seen = new Set();
  const routines = [];
  for (const p of procs) {
    const key = p.nspname === schema ? p.proname : `${p.nspname}.${p.proname}`;
    if (seen.has(key)) continue; // перегрузки — одно имя
    seen.add(key);
    routines.push({ name: key, key, kind: p.prokind === 'p' ? 'procedure' : 'function', valid: true, package: p.nspname === schema ? null : p.nspname });
  }
  const types = await db.query(`
    SELECT t.typname AS name FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = $1 AND t.typtype IN ('c','e','d')
      AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c')
    ORDER BY 1`, [schema]);

  const tableList = [...tables.values()];
  if (opts.rowCounts === 'exact') {
    let i = 0;
    for (const t of tableList) {
      ctx && ctx.checkCancel();
      ctx && ctx.progress(++i, tableList.length, `PostgreSQL: count(*) ${t.name}`);
      try { t.rowCount = Number((await db.query(`SELECT count(*) AS cnt FROM ${db.qualify(schema, t.name)}`))[0].cnt); }
      catch (e) { t.rowCountError = e.message; }
    }
  } else if (opts.rowCounts === 'estimate') {
    for (const t of tableList) t.rowCount = t.rowEstimate;
  }

  return { dbType: 'postgres', schema, tables: tableList, views, mviews, sequences, routines, packages: [], types, synonyms: [], triggers, invalid: [] };
}

module.exports = { loadPgMeta };
