'use strict';
// Адаптер Oracle на node-oracledb.
// По умолчанию — Thin-режим (Oracle Client не нужен, Oracle 12.1+).
// Для Oracle 11g/старых парольных верификаторов укажите в настройках папку Instant Client — включится Thick-режим.
const oracledb = require('oracledb');
const { getSettings } = require('../lib/store');

let initDone = false;
function init() {
  if (initDone) return;
  initDone = true;
  const libDir = getSettings().oracleClientLibDir;
  if (libDir) {
    try { oracledb.initOracleClient({ libDir }); console.log('Oracle: Thick-режим, Instant Client', libDir); }
    catch (e) { console.error('Oracle: не удалось включить Thick-режим:', e.message); }
  }
  // Числа — строками (без потери точности), LOB — сразу значениями.
  oracledb.fetchTypeHandler = (meta) => {
    switch (meta.dbType) {
      case oracledb.DB_TYPE_NUMBER: return { type: oracledb.STRING };
      case oracledb.DB_TYPE_CLOB:
      case oracledb.DB_TYPE_NCLOB: return { type: oracledb.STRING };
      case oracledb.DB_TYPE_BLOB: return { type: oracledb.BUFFER };
      default: return undefined;
    }
  };
}

function buildConnectString(c) {
  if (c.connectString) return c.connectString;
  if (c.oracleConnectMode === 'sid') {
    return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${c.host})(PORT=${c.port}))(CONNECT_DATA=(SID=${c.database})))`;
  }
  return `${c.host}:${c.port}/${c.database}`;
}

class OracleDb {
  constructor(conn, raw) {
    this.type = 'oracle';
    this.conn = conn;
    this.raw = raw;
    this.defaultSchema = (conn.schema || conn.user || '').toUpperCase();
  }

  static async connect(conn) {
    init();
    let user = conn.user;
    let privilege;
    const m = /^(.*?)\s+as\s+(sysdba|sysoper)$/i.exec(user || '');
    if (m) { user = m[1]; privilege = m[2].toLowerCase() === 'sysdba' ? oracledb.SYSDBA : oracledb.SYSOPER; }
    const raw = await oracledb.getConnection({ user, password: conn.password, connectString: buildConnectString(conn), privilege, connectTimeout: 20 });
    const db = new OracleDb(conn, raw);
    // Единые настройки сессии: бинарная сортировка (совпадает с COLLATE "C" в PG), точка как разделитель, UTC.
    for (const s of [
      "ALTER SESSION SET NLS_SORT=BINARY",
      "ALTER SESSION SET NLS_COMP=BINARY",
      "ALTER SESSION SET NLS_NUMERIC_CHARACTERS='.,'",
      "ALTER SESSION SET NLS_DATE_FORMAT='YYYY-MM-DD HH24:MI:SS'",
      "ALTER SESSION SET NLS_TIMESTAMP_FORMAT='YYYY-MM-DD HH24:MI:SS.FF6'",
      "ALTER SESSION SET NLS_TIMESTAMP_TZ_FORMAT='YYYY-MM-DD HH24:MI:SS.FF6 TZH:TZM'",
      "ALTER SESSION SET TIME_ZONE='+00:00'",
    ]) await raw.execute(s);
    return db;
  }

  quote(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }
  qualify(schema, name) { return `${this.quote(schema)}.${this.quote(name)}`; }
  // Регистр имён для новых объектов
  normName(name) { return String(name).toUpperCase(); }

  async query(sql, binds = {}) {
    const r = await this.raw.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return (r.rows || []).map(row => {
      const o = {};
      for (const k of Object.keys(row)) o[k.toLowerCase()] = row[k];
      return o;
    });
  }

  async exec(sql, binds = {}, opts = {}) {
    return this.raw.execute(sql, binds, { autoCommit: false, ...opts });
  }

  // Потоковое чтение: async-итератор по пачкам строк (массивы значений)
  async *stream(sql, binds = {}, fetchSize = 2000) {
    const r = await this.raw.execute(sql, binds, {
      resultSet: true, outFormat: oracledb.OUT_FORMAT_ARRAY, fetchArraySize: fetchSize, prefetchRows: fetchSize + 1,
    });
    const rs = r.resultSet;
    try {
      while (true) {
        const rows = await rs.getRows(fetchSize);
        if (!rows.length) break;
        yield rows;
        if (rows.length < fetchSize) break;
      }
    } finally {
      await rs.close().catch(() => {});
    }
  }

  // Результат произвольного запроса: имена колонок + строки (массивы), не больше maxRows
  async fetchAll(sql, maxRows = 100000, binds = []) {
    const r = await this.raw.execute(sql, binds, { resultSet: true, outFormat: oracledb.OUT_FORMAT_ARRAY, fetchArraySize: 1000 });
    if (!r.resultSet) return { columns: [], rows: [], truncated: false, rowsAffected: r.rowsAffected };
    const columns = r.resultSet.metaData.map(m => m.name);
    const rows = [];
    let truncated = false;
    try {
      while (true) {
        const part = await r.resultSet.getRows(1000);
        if (!part.length) break;
        for (const x of part) { if (rows.length >= maxRows) { truncated = true; break; } rows.push(x); }
        if (truncated || part.length < 1000) break;
      }
    } finally { await r.resultSet.close().catch(() => {}); }
    return { columns, rows, truncated };
  }

  // Строки DBMS_OUTPUT (после DBMS_OUTPUT.ENABLE)
  async readOutput(max = 100000) {
    const lines = [];
    for (let i = 0; i < max; i++) {
      const r = await this.raw.execute(`BEGIN DBMS_OUTPUT.GET_LINE(:ln, :st); END;`, {
        ln: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 32767 },
        st: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      });
      if (r.outBinds.st !== 0) break;
      lines.push(r.outBinds.ln || '');
    }
    return lines;
  }

  async version() {
    const r = await this.query("SELECT banner FROM v$version WHERE ROWNUM = 1").catch(() => null);
    return r && r[0] ? r[0].banner : `Oracle ${this.raw.oracleServerVersionString}`;
  }

  async schemas() {
    const r = await this.query(`
      SELECT username AS name FROM all_users
      WHERE oracle_maintained = 'N' OR username = USER
      ORDER BY username`).catch(async () =>
      // Oracle 11g: нет колонки oracle_maintained
      this.query(`SELECT username AS name FROM all_users ORDER BY username`));
    return r.map(x => x.name);
  }

  async commit() { await this.raw.commit(); }
  async rollback() { await this.raw.rollback(); }
  async close() { try { await this.raw.close(); } catch { /* */ } }
}

module.exports = { OracleDb, oracledb, buildConnectString };
