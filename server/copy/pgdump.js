'use strict';
// Копирование PostgreSQL → PostgreSQL через pg_dump / pg_restore (custom-формат).
const path = require('path');
const fs = require('fs');
const { run, pgTool } = require('../lib/proc');
const { getConnection, DATA_DIR } = require('../lib/store');
const { withDb } = require('../db');

const DUMPS = path.join(DATA_DIR, 'dumps');

function connArgs(c) {
  return ['-h', c.host, '-p', String(c.port), '-U', c.user];
}
function pgEnv(c) {
  return { PGPASSWORD: c.password, PGSSLMODE: c.ssl ? 'require' : 'prefer', PGCLIENTENCODING: 'UTF8' };
}

async function runPgDump(p, ctx) {
  const mode = p.mode || 'dump_restore'; // dump_restore | dump_only | restore_only
  let file = p.dumpFile ? path.join(DUMPS, path.basename(p.dumpFile)) : null;
  const result = { mode, file: null, dumpSize: null, restoreWarnings: 0 };

  if (mode !== 'restore_only') {
    const s = getConnection(p.sourceId);
    if (s.type !== 'postgres') throw new Error('pg_dump работает только с PostgreSQL');
    // Проверка версий: pg_dump должен быть не старше сервера
    const serverVer = await withDb(s, db => db.query('SHOW server_version_num')).then(r => Number(r[0].server_version_num));
    const dumpVer = await run(pgTool('pg_dump'), ['--version'], { captureStdout: true, logStdout: false });
    const m = /(\d+)(?:\.(\d+))?/.exec(dumpVer.stdout);
    const clientMajor = m ? Number(m[1]) : 0;
    ctx.log(`pg_dump: ${dumpVer.stdout.trim()}, сервер: ${serverVer}`);
    if (clientMajor && clientMajor < Math.floor(serverVer / 10000)) {
      throw new Error(`pg_dump версии ${clientMajor} старше сервера (${Math.floor(serverVer / 10000)}). Установите клиент PostgreSQL ${Math.floor(serverVer / 10000)}+ и укажите путь в Настройках.`);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    file = path.join(DUMPS, `${s.database}_${stamp}.dump`);
    const args = ['-Fc', '-v', '-f', file, ...connArgs(s), '-d', s.database];
    for (const sc of p.schemas || []) args.push('-n', sc);
    for (const t of p.tables || []) args.push('-t', t);
    if (p.content === 'schema') args.push('--schema-only');
    if (p.content === 'data') args.push('--data-only');
    if (p.noTablespaces) args.push('--no-tablespaces');
    if (p.noOwner !== false) args.push('--no-owner');
    if (p.noPrivileges !== false) args.push('--no-privileges');
    ctx.progress(0, 2, 'pg_dump…');
    const r = await run(pgTool('pg_dump'), args, { env: pgEnv(s), ctx });
    if (r.code !== 0) throw new Error(`pg_dump завершился с кодом ${r.code}`);
    result.file = path.basename(file);
    result.dumpSize = fs.statSync(file).size;
    ctx.log(`Дамп создан: ${result.file} (${(result.dumpSize / 1048576).toFixed(1)} МБ)`);
  }
  ctx.checkCancel();

  if (mode !== 'dump_only') {
    if (!file || !fs.existsSync(file)) throw new Error('Файл дампа не найден');
    const t = getConnection(p.targetId);
    if (t.type !== 'postgres') throw new Error('pg_restore работает только с PostgreSQL');
    const admin = { ...t, database: p.maintenanceDb || 'postgres' };
    if (p.terminateConnections || p.recreateDatabase) {
      const r = await withDb(admin, db => db.query(`SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [t.database]));
      if (r.length) ctx.log(`Завершено подключений к ${t.database}: ${r.length}`);
    }
    if (p.recreateDatabase) {
      await withDb(admin, db => db.exec(`DROP DATABASE IF EXISTS ${db.quote(t.database)}`));
      ctx.log(`База ${t.database} удалена`, 'warning');
    }
    if (p.createDatabase || p.recreateDatabase) {
      const exists = await withDb(admin, db => db.query('SELECT 1 FROM pg_database WHERE datname = $1', [t.database]));
      if (!exists.length) {
        const like = p.createLike || {};
        const opts = like.encoding ? ` TEMPLATE template0 ENCODING '${like.encoding}'${like.collate ? ` LC_COLLATE '${like.collate}' LC_CTYPE '${like.ctype || like.collate}'` : ''}` : '';
        await withDb(admin, db => db.exec(`CREATE DATABASE ${db.quote(t.database)}${opts}`));
        ctx.log(`Создана база ${t.database}${opts}`);
      }
    }
    for (const ext of p.createExtensions || []) {
      await withDb(t, db => db.exec(`CREATE EXTENSION IF NOT EXISTS ${db.quote(ext)}`)).then(() => ctx.log(`Расширение ${ext} установлено`)).catch(e => ctx.log(`Расширение ${ext}: ${e.message}`, 'warning'));
    }
    const args = ['-v', ...connArgs(t), '-d', t.database];
    if (p.noOwner !== false) args.push('--no-owner');
    if (p.noPrivileges !== false) args.push('--no-privileges');
    if (p.clean) args.push('--clean', '--if-exists');
    if (p.noTablespaces) args.push('--no-tablespaces');
    if (p.jobs && Number(p.jobs) > 1) args.push('-j', String(p.jobs));
    if (p.singleTransaction && !(p.jobs > 1)) args.push('--single-transaction', '--exit-on-error');
    args.push(file);
    ctx.progress(1, 2, 'pg_restore…');
    const r = await run(pgTool('pg_restore'), args, { env: pgEnv(t), ctx });
    if (r.code !== 0) {
      result.restoreWarnings = r.code;
      ctx.log(`pg_restore завершился с кодом ${r.code} — проверьте ошибки в журнале выше (часто это предупреждения о существующих объектах/ролях).`, 'warning');
    }
    result.file = path.basename(file);
    if (mode === 'dump_restore' && p.deleteDumpAfter) { fs.unlinkSync(file); result.file = null; ctx.log('Временный файл дампа удалён'); }
  }
  ctx.progress(2, 2, 'Готово');
  return { summary: result, ...result };
}

function listDumps() {
  return fs.readdirSync(DUMPS).filter(f => !f.startsWith('.'))
    .map(f => { const st = fs.statSync(path.join(DUMPS, f)); return { name: f, size: st.size, mtime: st.mtime }; })
    .sort((a, b) => b.mtime - a.mtime);
}

module.exports = { runPgDump, listDumps, DUMPS, connArgs, pgEnv };
