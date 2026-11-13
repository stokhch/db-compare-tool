'use strict';
const { loadOracleMeta } = require('./oracle');
const { loadPgMeta } = require('./postgres');

async function loadMeta(db, schema, opts = {}, ctx, extraSchemas = []) {
  if (db.type === 'oracle') return loadOracleMeta(db, schema, opts, ctx);
  return loadPgMeta(db, schema, opts, ctx, extraSchemas);
}

// Список таблиц (быстро, без колонок) — для выбора в интерфейсе
async function listTables(db, schema) {
  if (db.type === 'oracle') {
    const r = await db.query(`
      SELECT table_name AS name, num_rows AS est FROM all_tables t
      WHERE owner = :own AND nested = 'NO' AND table_name NOT LIKE 'BIN$%'
        AND (iot_type IS NULL OR iot_type = 'IOT')
        AND NOT EXISTS (SELECT 1 FROM all_mviews m WHERE m.owner = t.owner AND m.mview_name = t.table_name)
      ORDER BY table_name`, { own: schema });
    return r.map(x => ({ name: x.name, rows: x.est == null ? null : Number(x.est) }));
  }
  const r = await db.query(`
    SELECT c.relname AS name, c.reltuples::bigint AS est FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY 1`, [schema]);
  return r.map(x => ({ name: x.name, rows: Number(x.est) >= 0 ? Number(x.est) : null }));
}

module.exports = { loadMeta, listTables };
