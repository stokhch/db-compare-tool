'use strict';
// SQL-консоль (одна или две базы сразу) и монитор активности сеансов с блокировками.
const { connect } = require('../db');
const { getConnection } = require('../lib/store');
const { compareResults } = require('../verify/queries');

const isQuery = sql => /^\s*(\(\s*)?(select|with|values|show|explain|table)\b/i.test(sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*/g, ''));
const strip = sql => String(sql || '').trim().replace(/;\s*$/, '').replace(/^\s*\/\s*$/m, '');

/** Выполнение одного оператора. readOnly — внутри транзакции только для чтения с откатом. */
async function runSql(connId, sql, { maxRows = 1000, readOnly = true, schema, timeoutSec = 120 } = {}) {
  const conn = getConnection(connId);
  const db = await connect(conn);
  const t0 = process.hrtime.bigint();
  const text = conn.type === 'oracle' && /^\s*(begin|declare|create\s+(or\s+replace\s+)?(procedure|function|package|trigger|type))\b/i.test(sql) ? String(sql).trim().replace(/\n\s*\/\s*$/, '') : strip(sql);
  try {
    if (conn.type === 'postgres') {
      await db.exec(`SET statement_timeout = ${Number(timeoutSec) * 1000}`);
      if (schema) await db.exec(`SET search_path = ${db.quote(schema)}, public`);
      if (readOnly) await db.exec('BEGIN READ ONLY');
    } else {
      db.raw.callTimeout = Number(timeoutSec) * 1000;
      if (schema) await db.exec(`ALTER SESSION SET CURRENT_SCHEMA = ${db.quote(schema.toUpperCase())}`);
      if (readOnly) await db.exec('SET TRANSACTION READ ONLY');
    }
    let res;
    if (isQuery(text)) {
      const r = await db.fetchAll(text, maxRows + 1);
      res = { columns: r.columns, rows: r.rows.slice(0, maxRows).map(row => row.map(v => (v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? `0x${v.toString('hex').slice(0, 64)}` : v))), truncated: r.rows.length > maxRows };
    } else if (conn.type === 'postgres') {
      const r = await db.raw.query(text);
      const last = Array.isArray(r) ? r[r.length - 1] : r;
      res = { columns: (last.fields || []).map(f => f.name), rows: (last.rows || []).slice(0, maxRows).map(o => Object.values(o)), rowCount: last.rowCount, command: last.command };
    } else {
      const r = await db.raw.execute(text, [], { autoCommit: !readOnly });
      res = { columns: [], rows: [], rowCount: r.rowsAffected ?? null, command: text.split(/\s+/)[0].toUpperCase() };
      if (/^\s*(begin|declare)/i.test(text)) { const out = await db.readOutput().catch(() => []); if (out.length) res.output = out; }
    }
    res.ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (readOnly) { if (conn.type === 'postgres') await db.exec('ROLLBACK'); else await db.raw.rollback(); }
    return res;
  } catch (e) {
    if (readOnly && /read-only|READ ONLY|ORA-01456/i.test(e.message)) e.message += '\nВключён режим «только чтение» — снимите его, чтобы изменять данные.';
    throw e;
  } finally { await db.close(); }
}

/** Один запрос на двух базах: результаты рядом и отличия. */
async function compareSql(p) {
  const [a, b] = await Promise.allSettled([
    runSql(p.sourceId, p.sourceSql || p.sql, { ...p, schema: p.sourceSchema }),
    runSql(p.targetId, p.targetSql || p.sql, { ...p, schema: p.targetSchema }),
  ]);
  const out = { source: a.status === 'fulfilled' ? a.value : { error: a.reason.message }, target: b.status === 'fulfilled' ? b.value : { error: b.reason.message } };
  if (!out.source.error && !out.target.error && out.source.columns.length) {
    const d = compareResults(out.source, out.target, { keyColumns: p.keyColumns, ordered: p.ordered }, { emptyAsNull: true, trimTrailingSpaces: true, maxDiffs: 200 });
    out.diff = { missing: d.missing, extra: d.extra, different: d.different, diffs: d.diffs, note: d.note, equal: !d.missing && !d.extra && !d.different && !d.note };
  }
  return out;
}

// ---------- активность ----------
async function activity(connId) {
  const conn = getConnection(connId);
  const db = await connect(conn);
  try {
    if (conn.type === 'postgres') {
      const rows = await db.query(`
        SELECT pid, usename AS "user", datname AS db, application_name AS app, client_addr::text AS client, state,
               wait_event_type || coalesce(': ' || wait_event, '') AS wait,
               extract(epoch FROM now() - coalesce(query_start, backend_start))::int AS seconds,
               extract(epoch FROM now() - xact_start)::int AS xact_seconds,
               pg_blocking_pids(pid) AS blocked_by, left(query, 4000) AS sql, backend_type
        FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'
        ORDER BY state = 'active' DESC, seconds DESC`);
      const locks = await db.query(`
        SELECT l.pid, l.locktype, l.mode, l.granted, c.relname AS object
        FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation
        WHERE l.pid <> pg_backend_pid() AND (NOT l.granted OR l.pid IN (SELECT unnest(pg_blocking_pids(pid)) FROM pg_stat_activity))`).catch(() => []);
      const max = (await db.query(`SELECT setting::int AS m FROM pg_settings WHERE name = 'max_connections'`))[0].m;
      return finish(rows.map(r => ({ id: String(r.pid), user: r.user, db: r.db, app: r.app, client: r.client, state: r.state, wait: r.wait, seconds: r.seconds, xactSeconds: r.xact_seconds,
        blockedBy: (r.blocked_by || []).map(String), sql: r.sql })), { locks, maxConnections: max, type: 'postgres' });
    }
    const rows = await db.query(`
      SELECT s.sid || ',' || s.serial# AS id, s.sid, s.username AS "user", s.osuser, s.machine AS client, s.program AS app, s.status AS state,
             s.event AS wait, s.last_call_et AS seconds, s.blocking_session AS blocked_by, s.sql_id,
             (SELECT SUBSTR(q.sql_text, 1, 1000) FROM v$sql q WHERE q.sql_id = s.sql_id AND ROWNUM = 1) AS sql
      FROM v$session s WHERE s.type = 'USER' AND s.sid <> SYS_CONTEXT('USERENV', 'SID')
      ORDER BY DECODE(s.status, 'ACTIVE', 0, 1), s.last_call_et DESC`);
    const bySid = new Map(rows.map(r => [String(r.sid), r.id]));
    const max = await db.query(`SELECT value AS m FROM v$parameter WHERE name = 'sessions'`).catch(() => [{ m: null }]);
    return finish(rows.map(r => ({ id: r.id, user: r.user, osuser: r.osuser, client: r.client, app: r.app, state: r.state, wait: r.wait, seconds: Number(r.seconds),
      blockedBy: r.blocked_by != null ? [bySid.get(String(r.blocked_by)) || String(r.blocked_by)] : [], sql: r.sql })), { maxConnections: max[0] && Number(max[0].m), type: 'oracle' });
  } catch (e) {
    if (/ORA-00942|permission denied/i.test(e.message)) e.message += conn.type === 'oracle' ? '\nНужны права на v$session и v$sql: GRANT SELECT_CATALOG_ROLE TO <пользователь>;' : '\nНужна роль pg_read_all_stats или pg_monitor, чтобы видеть чужие сеансы.';
    throw e;
  } finally { await db.close(); }
}
function finish(sessions, extra) {
  // кто кого блокирует: корни цепочек
  const blocked = new Set(), blockers = new Map();
  for (const s of sessions) for (const b of s.blockedBy) { blocked.add(s.id); blockers.set(b, (blockers.get(b) || 0) + 1); }
  for (const s of sessions) { s.blocks = blockers.get(s.id) || 0; s.isRootBlocker = s.blocks > 0 && !blocked.has(s.id); }
  return { sessions, summary: { total: sessions.length, active: sessions.filter(s => /active/i.test(s.state)).length, blocked: blocked.size, rootBlockers: sessions.filter(s => s.isRootBlocker).length,
    idleInTx: sessions.filter(s => s.state === 'idle in transaction').length, long: sessions.filter(s => /active/i.test(s.state) && s.seconds > 60).length }, ...extra };
}

/** Отмена запроса или завершение сеанса. */
async function killSession(connId, id, mode = 'terminate') {
  const conn = getConnection(connId);
  const db = await connect(conn);
  try {
    if (conn.type === 'postgres') {
      const r = await db.query(`SELECT ${mode === 'cancel' ? 'pg_cancel_backend' : 'pg_terminate_backend'}($1::int) AS ok`, [Number(id)]);
      return { ok: !!r[0].ok };
    }
    if (!/^\d+,\d+$/.test(id)) throw new Error('Неверный идентификатор сеанса');
    await db.exec(mode === 'cancel' ? `ALTER SYSTEM CANCEL SQL '${id}'` : `ALTER SYSTEM KILL SESSION '${id}' IMMEDIATE`);
    return { ok: true };
  } catch (e) {
    if (/ORA-01031|must be a member|permission denied/i.test(e.message)) e.message += conn.type === 'oracle' ? '\nНужно право ALTER SYSTEM.' : '\nНужна роль pg_signal_backend или права суперпользователя.';
    throw e;
  } finally { await db.close(); }
}

module.exports = { runSql, compareSql, activity, killSession, isQuery };
