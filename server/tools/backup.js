'use strict';
// Резервные копии по расписанию: PostgreSQL — pg_dump в папку приложения, Oracle — Data Pump на сервере базы.
// Ротация (хранить N последних) и проверка: копия читается (pg_restore -l / SQL_FILE), при желании —
// пробное восстановление во временную базу PostgreSQL со сверкой числа таблиц и строк.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { connect } = require('../db');
const { getConnection, DATA_DIR, readJson, writeJson } = require('../lib/store');
const { run, pgTool } = require('../lib/proc');
const { connArgs, pgEnv } = require('../copy/pgdump');

const DIR = path.join(DATA_DIR, 'backups');
const REG = path.join(DATA_DIR, 'backups.json');
fs.mkdirSync(DIR, { recursive: true });
const list = () => readJson(REG, []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const save = items => writeJson(REG, items);
function upsert(b) { const all = readJson(REG, []); const i = all.findIndex(x => x.id === b.id); if (i >= 0) all[i] = b; else all.push(b); save(all); }

async function removeBackup(b, ctx) {
  if (b.type === 'postgres') fs.rmSync(b.file, { force: true });
  else {
    const db = await connect(getConnection(b.connId)).catch(() => null);
    if (db) { try { for (const f of [b.file, b.logFile].filter(Boolean)) await db.raw.execute(`BEGIN UTL_FILE.FREMOVE(:d, :f); EXCEPTION WHEN OTHERS THEN NULL; END;`, { d: b.directory, f }); } finally { await db.close(); } }
  }
  save(readJson(REG, []).filter(x => x.id !== b.id));
  if (ctx) ctx.log(`Удалена старая копия ${b.name}`);
}

async function pgCounts(conn) {
  const db = await connect(conn);
  try {
    const r = await db.query(`SELECT count(*)::int AS tables, coalesce(sum(n_live_tup), 0)::bigint AS rows FROM pg_stat_user_tables`);
    return { tables: r[0].tables, rows: Number(r[0].rows) };
  } finally { await db.close(); }
}

async function verifyPg(b, conn, method, ctx) {
  const env = pgEnv(conn);
  if (method === 'list') {
    const r = await run(pgTool('pg_restore'), ['-l', b.file], { captureStdout: true, logStdout: false, env });
    const n = (r.stdout.match(/ TABLE DATA /g) || []).length;
    return { ok: r.code === 0 && n >= 0, method: 'чтение оглавления (pg_restore -l)', details: `объектов в оглавлении: ${r.stdout.split('\n').filter(l => /^\d+;/.test(l)).length}, таблиц с данными: ${n}` };
  }
  // пробное восстановление во временную базу на том же сервере
  const tmp = `dbcmp_verify_${crypto.randomBytes(3).toString('hex')}`;
  const admin = await connect({ ...conn, database: 'postgres' });
  try {
    await admin.exec(`CREATE DATABASE ${admin.quote(tmp)}`);
    ctx.log(`Пробное восстановление в базу ${tmp}…`);
    const r = await run(pgTool('pg_restore'), ['--no-owner', '--no-privileges', '-j', '2', ...connArgs(conn), '-d', tmp, b.file], { ctx, env }).catch(e => ({ code: 1, err: e.message }));
    const db = await connect({ ...conn, database: tmp });
    let got;
    try {
      await db.exec('ANALYZE');
      const t = await db.query(`SELECT count(*)::int AS tables, coalesce(sum(n_live_tup), 0)::bigint AS rows FROM pg_stat_user_tables`);
      got = { tables: t[0].tables, rows: Number(t[0].rows) };
    } finally { await db.close(); }
    const exp = b.counts || {};
    const ok = got.tables >= (exp.tables || 0) && !r.code;
    return { ok, method: 'пробное восстановление', details: `восстановлено таблиц ${got.tables} из ${exp.tables ?? '?'}, строк ≈${got.rows}${r.code ? '; pg_restore сообщил об ошибках — см. журнал' : ''}` };
  } finally {
    await admin.exec(`DROP DATABASE IF EXISTS ${admin.quote(tmp)} WITH (FORCE)`).catch(() => admin.exec(`DROP DATABASE IF EXISTS ${admin.quote(tmp)}`).catch(() => {}));
    await admin.close();
  }
}

async function runBackup(p, ctx) {
  const conn = getConnection(p.connId);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const id = `${stamp}_${crypto.randomBytes(2).toString('hex')}`;
  const b = { id, connId: conn.id, connName: conn.name, type: conn.type, schema: p.schema || null, label: p.label || '', createdAt: new Date().toISOString() };
  const t0 = Date.now();
  if (conn.type === 'postgres') {
    b.counts = await pgCounts(conn).catch(() => null);
    b.name = `${conn.database}${p.schema ? '_' + p.schema : ''}_${stamp}.dump`;
    b.file = path.join(p.folder || DIR, b.name);
    fs.mkdirSync(path.dirname(b.file), { recursive: true });
    const args = ['-Fc', '-f', b.file, ...connArgs(conn), '-d', conn.database];
    if (p.schema) args.push('-n', p.schema);
    ctx.log(`pg_dump ${conn.database}${p.schema ? ' (схема ' + p.schema + ')' : ''} → ${b.file}`);
    const r = await run(pgTool('pg_dump'), args, { ctx, env: pgEnv(conn) });
    if (r.code) { fs.rmSync(b.file, { force: true }); throw new Error(`pg_dump завершился с ошибкой (код ${r.code}) — см. журнал`); }
    b.bytes = fs.statSync(b.file).size;
    b.location = b.file;
  } else {
    if (!p.schema) throw new Error('Для Oracle укажите схему');
    const db = await connect(conn), mon = await connect(conn);
    try {
      const { dpBlock } = require('../dump/plan');
      const { runDp } = require('../dump/import');
      const S = p.schema.toUpperCase();
      b.directory = p.directory || 'DATA_PUMP_DIR';
      b.name = `${S}_${stamp}.dmp`; b.file = b.name; b.logFile = `${S}_${stamp}.log`;
      const cnt = await db.query(`SELECT COUNT(*) AS t, NVL(SUM(num_rows), 0) AS r FROM all_tables WHERE owner = :o`, { o: S });
      b.counts = { tables: Number(cnt[0].t), rows: Number(cnt[0].r) };
      const jobName = `DBCMP_BK_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const block = dpBlock({ operation: 'EXPORT', jobName, dir: b.directory, files: [b.file], logFile: b.logFile, job: { jobMode: 'SCHEMA', schemaExpr: `IN ('${S}')`, parallel: Number(p.parallel) || 1 } })
        .replace(/DBMS_DATAPUMP\.SET_PARAMETER\(h, 'TABLE_EXISTS_ACTION'[^;]*;/, '');
      const r = await runDp(db, mon, block, jobName, ctx, `Экспорт ${S}`);
      if (r.state !== 'COMPLETED') throw new Error(`Экспорт не завершён: ${r.error || r.state}`);
      const sz = await db.raw.execute(`DECLARE b BFILE := BFILENAME(:d, :f); BEGIN DBMS_LOB.FILEOPEN(b); :n := DBMS_LOB.GETLENGTH(b); DBMS_LOB.FILECLOSE(b); END;`, { d: b.directory, f: b.file, n: { dir: require('../db/oracle').oracledb.BIND_OUT, type: require('../db/oracle').oracledb.NUMBER } }).catch(() => null);
      b.bytes = sz ? sz.outBinds.n : null;
      const dp = await db.query(`SELECT directory_path AS p FROM all_directories WHERE directory_name = :d`, { d: b.directory }).catch(() => []);
      b.location = `${b.directory}:${b.file}${dp[0] ? ` (${dp[0].p} на сервере базы)` : ''}`;
    } finally { await db.close(); await mon.close(); }
  }
  b.ms = Date.now() - t0;
  ctx.log(`Копия создана: ${b.name}, ${b.bytes != null ? Math.round(b.bytes / 1048576) + ' МБ' : ''}`);
  // проверка
  const method = p.verify || 'list';
  if (method !== 'none') {
    ctx.progress(0, 0, 'Проверка копии…');
    try {
      if (conn.type === 'postgres') b.verified = { ...(await verifyPg(b, conn, method, ctx)), at: new Date().toISOString() };
      else {
        const db = await connect(conn);
        try {
          const { dumpFileInfo } = require('./backupcheck');
          b.verified = { ...(await dumpFileInfo(db, b.directory, b.file)), at: new Date().toISOString() };
        } finally { await db.close(); }
      }
    } catch (e) { b.verified = { ok: false, method, details: e.message.split('\n')[0], at: new Date().toISOString() }; }
    ctx.log(`Проверка (${b.verified.method}): ${b.verified.ok ? 'успешно' : 'НЕ ПРОЙДЕНА'} — ${b.verified.details}`, b.verified.ok ? 'info' : 'error');
  }
  upsert(b);
  // ротация
  if (p.keep) {
    const same = list().filter(x => x.connId === b.connId && (x.schema || '') === (b.schema || '') && (!p.label || x.label === p.label));
    for (const old of same.slice(Number(p.keep))) await removeBackup(old, ctx).catch(e => ctx.log(`Не удалось удалить ${old.name}: ${e.message}`, 'warning'));
  }
  return { summary: { ok: !b.verified || b.verified.ok, verified: b.verified ? b.verified.ok : null, bytes: b.bytes, ms: b.ms }, backup: b };
}

module.exports = { runBackup, list, removeBackup, DIR };
