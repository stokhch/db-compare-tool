'use strict';
// Адаптер PostgreSQL на node-postgres.
const { Client, types: pgTypes } = require('pg');
const Cursor = require('pg-cursor');

// Эти типы отдаём «как есть» строками, без преобразования в JS Date/объекты:
// так значения сравниваются точно (микросекунды, часовые пояса, json).
const RAW_OIDS = new Set([
  1082, // date
  1083, // time
  1266, // timetz
  1114, // timestamp
  1184, // timestamptz
  1186, // interval
  114,  // json
  3802, // jsonb
  1700, // numeric
  20,   // int8
  790,  // money
]);
const customTypes = {
  getTypeParser(oid, format) {
    if (RAW_OIDS.has(oid)) return v => v;
    return pgTypes.getTypeParser(oid, format);
  },
};

class PostgresDb {
  constructor(conn, raw) {
    this.type = 'postgres';
    this.conn = conn;
    this.raw = raw;
    this.defaultSchema = conn.schema || 'public';
  }

  static async connect(conn) {
    const raw = new Client({
      host: conn.host, port: conn.port, database: conn.database || 'postgres',
      user: conn.user, password: conn.password,
      ssl: conn.ssl ? { rejectUnauthorized: false } : undefined,
      types: customTypes,
      application_name: 'db-compare-tool',
      connectionTimeoutMillis: 20000,
    });
    // соединение могут завершить извне (pg_terminate_backend, перезапуск сервера) — не роняем приложение
    raw.on("error", e => { raw._dbcmpError = e; });
    await raw.connect();
    await raw.query("SET TimeZone = 'UTC'");
    await raw.query("SET DateStyle = 'ISO, YMD'");
    await raw.query("SET IntervalStyle = 'iso_8601'");
    await raw.query("SET extra_float_digits = 1");
    return new PostgresDb(conn, raw);
  }

  quote(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }
  qualify(schema, name) { return `${this.quote(schema)}.${this.quote(name)}`; }
  normName(name) { return String(name).toLowerCase(); }

  async query(sql, params = []) {
    const r = await this.raw.query(sql, params);
    return r.rows;
  }
  async exec(sql, params = []) { return this.raw.query(sql, params); }

  async *stream(sql, params = [], fetchSize = 2000) {
    const cursor = this.raw.query(new Cursor(sql, params, { rowMode: 'array' }));
    try {
      while (true) {
        const rows = await cursor.read(fetchSize);
        if (!rows.length) break;
        yield rows;
      }
    } finally {
      await cursor.close().catch(() => {});
    }
  }

  async fetchAll(sql, maxRows = 100000, params = []) {
    const cursor = this.raw.query(new Cursor(sql, params, { rowMode: 'array' }));
    const rows = [];
    let truncated = false;
    try {
      while (true) {
        const part = await cursor.read(1000);
        if (!part.length) break;
        for (const x of part) { if (rows.length >= maxRows) { truncated = true; break; } rows.push(x); }
        if (truncated) break;
      }
      const fields = (cursor._result && cursor._result.fields) || [];
      return { columns: fields.map(f => f.name), rows, truncated };
    } finally { await cursor.close().catch(() => {}); }
  }

  async version() { return (await this.query('SELECT version() AS v'))[0].v; }

  async schemas() {
    const r = await this.query(`
      SELECT nspname AS name FROM pg_namespace
      WHERE nspname NOT IN ('pg_catalog','information_schema','pg_toast')
        AND nspname NOT LIKE 'pg_temp_%' AND nspname NOT LIKE 'pg_toast_temp_%'
      ORDER BY nspname`);
    return r.map(x => x.name);
  }

  async begin() { await this.raw.query('BEGIN'); }
  async commit() { await this.raw.query('COMMIT'); }
  async rollback() { await this.raw.query('ROLLBACK').catch(() => {}); }
  async close() { try { await this.raw.end(); } catch { /* */ } }
}

module.exports = { PostgresDb };
