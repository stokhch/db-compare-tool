'use strict';
// Фоновые задачи: сравнения и копирования выполняются асинхронно,
// интерфейс опрашивает их состояние.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./store');
const { explain } = require('./errhint');

const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const jobs = new Map();

class CancelledError extends Error { constructor() { super('Задача отменена пользователем'); this.cancelled = true; } }

function createJob(type, title, params, runner) {
  const job = {
    id: crypto.randomUUID(),
    type, title,
    params: sanitize(params),
    status: 'running',
    progress: { current: 0, total: 0, message: 'Запуск…' },
    log: [],
    result: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    _cancel: false,
    _children: new Set(),
  };
  jobs.set(job.id, job);

  const ctx = {
    id: job.id,
    log(msg, level = 'info') {
      const line = { t: new Date().toISOString(), level, msg: String(msg) };
      job.log.push(line);
      if (job.log.length > 5000) job.log.splice(0, job.log.length - 5000);
    },
    progress(current, total, message) {
      job.progress = { current, total: total ?? job.progress.total, message: message ?? job.progress.message };
    },
    checkCancel() { if (job._cancel) throw new CancelledError(); },
    get cancelled() { return job._cancel; },
    addChild(proc) { job._children.add(proc); proc.on('exit', () => job._children.delete(proc)); },
    setPartialResult(r) { job.result = r; },
  };

  setImmediate(async () => {
    try {
      const result = await runner(ctx);
      job.result = result;
      job.status = 'done';
      job.progress.message = 'Готово';
    } catch (e) {
      job.status = e.cancelled ? 'cancelled' : 'error';
      job.error = e.cancelled ? e.message : explain(e);
      ctx.log(e.stack || e.message, 'error');
    } finally {
      job.finishedAt = new Date().toISOString();
      persist(job);
    }
  });
  return publicJob(job);
}

function sanitize(params) {
  return JSON.parse(JSON.stringify(params || {}, (k, v) => (/password/i.test(k) ? '***' : v)));
}

function persist(job) {
  try {
    fs.writeFileSync(path.join(JOBS_DIR, job.id + '.json'), JSON.stringify(publicJob(job, true)), 'utf8');
  } catch (e) { console.error('Не удалось сохранить задачу', e); }
}

function publicJob(job, full = false) {
  const { _cancel, _children, ...rest } = job;
  if (!full) { rest.logSize = rest.log.length; rest.log = rest.log.slice(-200); }
  return rest;
}

function getJob(id, full = false) {
  const j = jobs.get(id);
  if (j) return publicJob(j, full);
  const f = path.join(JOBS_DIR, id + '.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  return null;
}

function listJobs() {
  const out = new Map();
  for (const f of fs.readdirSync(JOBS_DIR).filter(f => f.endsWith('.json'))) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), 'utf8'));
      out.set(j.id, summary(j));
    } catch { /* повреждённый файл пропускаем */ }
  }
  for (const j of jobs.values()) out.set(j.id, summary(j));
  return [...out.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
function summary(j) {
  const { log, result, ...rest } = j;
  return { ...rest, log: undefined, summary: result && result.summary };
}

function cancelJob(id) {
  const j = jobs.get(id);
  if (!j || j.status !== 'running') return false;
  j._cancel = true;
  for (const p of j._children) { try { p.kill(); } catch { /* */ } }
  return true;
}

function deleteJob(id) {
  const j = jobs.get(id);
  if (j && j.status === 'running') throw new Error('Нельзя удалить выполняющуюся задачу');
  jobs.delete(id);
  const f = path.join(JOBS_DIR, id + '.json');
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

module.exports = { createJob, getJob, listJobs, cancelJob, deleteJob, CancelledError };
