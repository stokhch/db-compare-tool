'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const store = require('./lib/store');
const jobs = require('./lib/jobs');
const { withDb } = require('./db');
const { listTables } = require('./meta');
const { listObjects } = require('./meta/objects');
const { renderScript } = require('./compare/syncschema');
const { SYNC_DIR } = require('./compare/syncdata');
const { topSql } = require('./verify/queries');
const { buildTemplate, listProcedures } = require('./verify/calctemplate');
const { renderReport } = require('./lib/report');
const { listDumps, DUMPS } = require('./copy/pgdump');
const { ACTIONS } = require('./copy/ora2pg');
const { pgTool, toolVersion, ora2pgCmd, perlModule, findPgBin } = require('./lib/proc');
const { explain } = require('./lib/errhint');

const app = express();
app.use(express.json({ limit: '5mb' }));

const h = fn => async (req, res) => {
  try { const r = await fn(req, res); if (r !== undefined && !res.headersSent) res.json(r); }
  catch (e) { console.error(e.message); res.status(400).json({ error: explain(e) }); }
};

// ---------- Подключения ----------
app.get('/api/connections', h(() => store.listConnections().map(store.publicConnection)));
app.post('/api/connections', h(req => store.saveConnection(req.body)));
app.put('/api/connections/:id', h(req => store.saveConnection({ ...req.body, id: req.params.id })));
app.delete('/api/connections/:id', h(req => { store.deleteConnection(req.params.id); return { ok: true }; }));
app.post('/api/connections/test', h(async req => {
  const c = { ...req.body };
  if (!c.password && c.id) { try { c.password = store.getConnection(c.id).password; } catch { /* новое */ } }
  if (c.port) c.port = Number(c.port);
  const t0 = Date.now();
  const version = await withDb(c, db => db.version());
  return { ok: true, version, ms: Date.now() - t0 };
}));
app.get('/api/connections/:id/schemas', h(req => withDb(req.params.id, db => db.schemas())));
app.get('/api/connections/:id/objects', h(req => withDb(req.params.id, db => listObjects(db, req.query.schema || db.defaultSchema))));
app.get('/api/connections/:id/topsql', h(req => withDb(req.params.id, db => topSql(db, req.query.schema || db.defaultSchema, req.query.limit))));
app.get('/api/connections/:id/procedures', h(req => withDb(req.params.id, db => listProcedures(db, req.query.schema || db.defaultSchema))));
app.post('/api/calc/template', h(req => buildTemplate(req.body)));
app.get('/api/connections/:id/tables', h(req => withDb(req.params.id, db => listTables(db, req.query.schema || db.defaultSchema))));

// ---------- Настройки и утилиты ----------
app.get('/api/settings', h(() => ({ ...store.getSettings(), detectedPgBin: findPgBin(), appDir: path.join(__dirname, '..') })));
app.put('/api/settings', h(req => { const { detectedPgBin, appDir, ...s } = req.body; return store.saveSettings(s); }));
app.get('/api/tools', h(async () => {
  const o = ora2pgCmd();
  const [pgDump, pgRestore, ora2pg, dbdOracle, dbdPg] = await Promise.all([
    toolVersion(pgTool('pg_dump'), ['--version']),
    toolVersion(pgTool('pg_restore'), ['--version']),
    toolVersion(o.cmd, [...o.pre, '--version'], o.env),
    perlModule(o, 'DBD::Oracle'),
    perlModule(o, 'DBD::Pg'),
  ]);
  ora2pg.source = o.source;
  return { pgDump, pgRestore, ora2pg, dbdOracle, dbdPg, ora2pgActions: ACTIONS };
}));

// ---------- Задачи ----------
const { JOB_TYPES } = require('./jobtypes');
const suites = require('./verify/suites');
app.get('/api/saved/:kind', h(req => suites.list(req.params.kind)));
app.post('/api/saved/:kind', h(req => {
  if (req.params.kind === 'suites' && req.body.schedule && !suites.validCron(req.body.schedule)) throw new Error('Неверное расписание. Формат cron: минута час день месяц день_недели, например «0 7 * * 1-5»');
  return suites.save(req.params.kind, req.body);
}));
app.delete('/api/saved/:kind/:id', h(req => { suites.remove(req.params.kind, req.params.id); return { ok: true }; }));
app.get('/api/suites/:id/runs', h(req => suites.runs(req.params.id)));
// Добавить проверку в набор (кнопка «В регламент» на экранах сравнения)
app.post('/api/suites/:id/checks', h(req => {
  const s = suites.get('suites', req.params.id);
  if (!s) throw new Error('Набор не найден');
  const check = { id: require('crypto').randomUUID(), enabled: true, ...req.body };
  return suites.save('suites', { ...s, checks: [...(s.checks || []), check] });
}));

app.post('/api/jobs/:type', h(req => {
  const t = JOB_TYPES[req.params.type];
  if (!t) throw new Error('Неизвестный тип задачи');
  const p = req.body || {};
  return jobs.createJob(req.params.type, t.title(p), p, ctx => t.run(p, ctx));
}));
app.get('/api/jobs', h(() => jobs.listJobs()));
app.get('/api/jobs/:id', h((req, res) => {
  const j = jobs.getJob(req.params.id, req.query.full === '1');
  if (!j) { res.status(404).json({ error: 'Задача не найдена' }); return; }
  return j;
}));
app.post('/api/jobs/:id/cancel', h(req => ({ ok: jobs.cancelJob(req.params.id) })));
app.delete('/api/jobs/:id', h(req => { jobs.deleteJob(req.params.id); return { ok: true }; }));
app.get('/api/jobs/:id/report.html', h((req, res) => {
  const j = jobs.getJob(req.params.id, true);
  if (!j) { res.status(404).send('Нет задачи'); return; }
  res.type('html').send(renderReport(j));
}));
app.get('/api/jobs/:id/result.json', h((req, res) => {
  const j = jobs.getJob(req.params.id, true);
  if (!j) { res.status(404).send('Нет задачи'); return; }
  res.setHeader('Content-Disposition', `attachment; filename="${j.type}-${j.id.slice(0, 8)}.json"`);
  return j;
}));
app.get('/api/jobs/:id/log.txt', h((req, res) => {
  const j = jobs.getJob(req.params.id, true);
  if (!j) { res.status(404).send('Нет задачи'); return; }
  res.type('text/plain; charset=utf-8').send(j.log.map(l => `${l.t} [${l.level}] ${l.msg}`).join('\n'));
}));

app.post('/api/sync/render', h(req => ({ script: renderScript(req.body, req.body.statements || []) })));

// Файлы ora2pg и дампы
app.get('/api/files/ora2pg/:jobId/:name', (req, res) => {
  const f = path.join(store.DATA_DIR, 'ora2pg', path.basename(req.params.jobId), path.basename(req.params.name));
  if (!fs.existsSync(f)) return res.status(404).send('Нет файла');
  if (/\.(html?)$/i.test(f) && req.query.view) return res.type('html').sendFile(f);
  res.download(f);
});
app.get('/api/files/sync/:jobId/:name', (req, res) => {
  const f = path.join(SYNC_DIR, path.basename(req.params.jobId), path.basename(req.params.name));
  if (!fs.existsSync(f)) return res.status(404).send('Нет файла');
  res.download(f);
});
// ---------- SQL-консоль, активность, история схемы, документация, резервные копии ----------
const sqlTools = require('./tools/sql');
const snapshots = require('./history/snapshots');
const backups = require('./tools/backup');
app.post('/api/sql/run', h(req => sqlTools.runSql(req.body.connId, req.body.sql, req.body)));
app.post('/api/sql/compare', h(req => sqlTools.compareSql(req.body)));
app.get('/api/connections/:id/activity', h(req => sqlTools.activity(req.params.id)));
app.post('/api/connections/:id/kill', h(req => sqlTools.killSession(req.params.id, String(req.body.session), req.body.mode)));
app.get('/api/connections/:id/columns', h(async req => {
  const { loadMeta } = require('./meta');
  const { connect: cn } = require('./db');
  const db = await cn(store.getConnection(req.params.id));
  try { const m = await loadMeta(db, req.query.schema, {}, null); return [...m.tables.map(t => ({ name: t.name, kind: 'table', columns: t.columns.map(c => ({ name: c.name, type: c.type })) })), ...m.views.map(v => ({ name: v.name, kind: 'view', columns: (v.columns || []).map(c => ({ name: c.name || c, type: c.type || '' })) }))]; }
  finally { await db.close(); }
}));
app.get('/api/snapshots', h(req => snapshots.list(req.query.connId, req.query.schema)));
app.delete('/api/snapshots/:id', h(req => { snapshots.remove(req.params.id); return { ok: true }; }));
app.get('/api/ddl-journal/sql', h(req => ({ sql: snapshots.ddlJournalSql(req.query.type, req.query.schema) })));
app.get('/api/ddl-journal', h(req => snapshots.readDdlJournal(req.query.connId, req.query.schema)));
app.get('/api/docs/:file', (req, res) => {
  const f = path.join(require('./tools/docs').DIR, path.basename(req.params.file));
  if (!fs.existsSync(f)) return res.status(404).send('Нет файла');
  if (f.endsWith('.md')) res.type('text/markdown; charset=utf-8').set('Content-Disposition', `attachment; filename="${path.basename(f)}"`);
  res.sendFile(f);
});
app.get('/api/backups', h(() => backups.list()));
app.delete('/api/backups/:id', h(async req => { const b = backups.list().find(x => x.id === req.params.id); if (b) await backups.removeBackup(b); return { ok: true }; }));
app.get('/api/backups/:id/download', (req, res) => {
  const b = backups.list().find(x => x.id === req.params.id);
  if (!b || b.type !== 'postgres' || !fs.existsSync(b.file)) return res.status(404).send('Копия недоступна для скачивания');
  res.download(b.file);
});

// ---------- Проверка перед запуском и разбор ошибок ----------
const preflight = require('./preflight');
const { diagnoseJob, retryParams } = require('./lib/diagnose');
app.post('/api/preflight/:type', h(req => preflight.runPreflight(req.params.type, req.body.params || req.body)));
app.post('/api/preflight-apply', h(req => preflight.applyPreflight(req.body)));
app.get('/api/jobs/:id/diagnose', h(req => { const j = jobs.getJob(req.params.id, true); if (!j) throw new Error('Задача не найдена'); return diagnoseJob(j); }));
app.post('/api/jobs/:id/retry', h(req => {
  const j = jobs.getJob(req.params.id, true);
  if (!j) throw new Error('Задача не найдена');
  const r = retryParams(j, req.body.fixes);
  return { type: j.type, ...r, preflight: !!preflight.PREFLIGHT[j.type] };
}));
app.post('/api/dump/plan', h(req => require('./dump/import').previewPlan(req.body)));
// Просмотр папок этого компьютера для выбора файла дампа (приложение работает локально)
app.get('/api/fs/list', h(req => {
  const os = require('os');
  let dir = String(req.query.path || '').trim();
  if (!dir) {
    if (process.platform === 'win32') {
      const drives = [];
      for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (fs.existsSync(`${l}:\\`)) drives.push({ name: `${l}:\\`, path: `${l}:\\`, dir: true });
      return { path: '', parent: null, entries: [{ name: 'Домашняя папка', path: os.homedir(), dir: true }, ...drives] };
    }
    dir = os.homedir();
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.'))
    .map(e => {
      const full = path.join(dir, e.name);
      let size = null; try { if (e.isFile()) size = fs.statSync(full).size; } catch { /* нет доступа */ }
      return { name: e.name, path: full, dir: e.isDirectory(), size };
    })
    .filter(e => e.dir || /\.(dmp|exp|expdp|dump|gz)$/i.test(e.name) || req.query.all)
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  const parent = path.dirname(dir) !== dir ? path.dirname(dir) : (process.platform === 'win32' ? '' : null);
  return { path: dir, parent, entries };
}));
app.get('/api/dumps', h(() => listDumps()));
app.get('/api/dumps/:name', (req, res) => {
  const f = path.join(DUMPS, path.basename(req.params.name));
  if (!fs.existsSync(f)) return res.status(404).send('Нет файла');
  res.download(f);
});
app.delete('/api/dumps/:name', h(req => { fs.unlinkSync(path.join(DUMPS, path.basename(req.params.name))); return { ok: true }; }));

// ---------- Интерфейс ----------
const dist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  app.get('/', (req, res) => res.send('Интерфейс не собран: выполните <code>npm run build</code>'));
}

const PORT = Number(process.env.PORT) || 3700;
const HOST = process.env.HOST || '127.0.0.1';
suites.startScheduler((type, p) => jobs.createJob(type, JOB_TYPES[type].title(p), p, ctx => JOB_TYPES[type].run(p, ctx)));

app.listen(PORT, HOST, () => {
  console.log(`DB Compare Tool: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Данные: ${store.DATA_DIR}`);
});
