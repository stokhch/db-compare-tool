'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const store = require('./lib/store');
const jobs = require('./lib/jobs');
const { withDb } = require('./db');
const { listTables } = require('./meta');
const { renderReport } = require('./lib/report');
const { runSchemaCompare } = require('./compare/schema');
const { runDataCompare } = require('./compare/data');
const { runTransfer } = require('./copy/transfer');
const { runPgDump, listDumps, DUMPS } = require('./copy/pgdump');
const { runDataPump } = require('./copy/datapump');
const { runOra2pg, ACTIONS } = require('./copy/ora2pg');
const { pgTool, toolVersion, ora2pgCmd, findPgBin } = require('./lib/proc');

const app = express();
app.use(express.json({ limit: '5mb' }));

const h = fn => async (req, res) => {
  try { const r = await fn(req, res); if (r !== undefined && !res.headersSent) res.json(r); }
  catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
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
app.get('/api/connections/:id/tables', h(req => withDb(req.params.id, db => listTables(db, req.query.schema || db.defaultSchema))));

// ---------- Настройки и утилиты ----------
app.get('/api/settings', h(() => ({ ...store.getSettings(), detectedPgBin: findPgBin() })));
app.put('/api/settings', h(req => { const { detectedPgBin, ...s } = req.body; return store.saveSettings(s); }));
app.get('/api/tools', h(async () => {
  const o = ora2pgCmd();
  const [pgDump, pgRestore, ora2pg] = await Promise.all([
    toolVersion(pgTool('pg_dump'), ['--version']),
    toolVersion(pgTool('pg_restore'), ['--version']),
    toolVersion(o.cmd, [...o.pre, '--version']),
  ]);
  return { pgDump, pgRestore, ora2pg, ora2pgActions: ACTIONS };
}));

// ---------- Задачи ----------
const JOB_TYPES = {
  'schema-compare': { title: p => `Схемы: ${p.sourceSchema} ↔ ${p.targetSchema}`, run: runSchemaCompare },
  'data-compare': { title: p => `Данные: ${p.sourceSchema} ↔ ${p.targetSchema}`, run: runDataCompare },
  transfer: { title: p => `Перелив: ${p.sourceSchema} → ${p.targetSchema}`, run: runTransfer },
  pgdump: { title: p => `pg_dump/pg_restore (${p.mode || 'dump_restore'})`, run: runPgDump },
  datapump: { title: p => `Data Pump: ${p.sourceSchema} → ${p.targetSchema || p.sourceSchema}`, run: runDataPump },
  ora2pg: { title: p => `ora2pg ${p.action}: ${p.sourceSchema}`, run: runOra2pg },
};
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

// Файлы ora2pg и дампы
app.get('/api/files/ora2pg/:jobId/:name', (req, res) => {
  const f = path.join(store.DATA_DIR, 'ora2pg', path.basename(req.params.jobId), path.basename(req.params.name));
  if (!fs.existsSync(f)) return res.status(404).send('Нет файла');
  if (/\.(html?)$/i.test(f) && req.query.view) return res.type('html').sendFile(f);
  res.download(f);
});
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
app.listen(PORT, HOST, () => {
  console.log(`DB Compare Tool: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Данные: ${store.DATA_DIR}`);
});
