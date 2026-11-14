'use strict';
// Регламентные проверки на период параллельной работы Oracle и PostgreSQL:
// набор сохранённых проверок запускается вручную, по расписанию (встроенный планировщик, формат cron)
// или из командной строки (Планировщик заданий Windows). Итог сравнивается с прошлым запуском,
// при расхождениях можно отправить уведомление (webhook: Teams, Slack, Mattermost, свой сервис).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, readJson, writeJson } = require('../lib/store');

const FILE = path.join(DATA_DIR, 'saved.json');
const RUNS = path.join(DATA_DIR, 'suite-runs');
fs.mkdirSync(RUNS, { recursive: true });

// ---------- Хранилище сохранённых наборов (запросы, сценарии расчётов, регламенты) ----------
const KINDS = ['querysets', 'scenarios', 'suites', 'unitsuites', 'readiness'];
function all() { return readJson(FILE, {}); }
function list(kind) { if (!KINDS.includes(kind)) throw new Error('Неизвестный тип'); return all()[kind] || []; }
function get(kind, id) { return list(kind).find(x => x.id === id || x.name === id); }
function save(kind, item) {
  const data = all();
  const arr = data[kind] || (data[kind] = []);
  const obj = { ...item, id: item.id || crypto.randomUUID(), updatedAt: new Date().toISOString() };
  const i = arr.findIndex(x => x.id === obj.id);
  if (i >= 0) arr[i] = { ...arr[i], ...obj }; else arr.push(obj);
  writeJson(FILE, data);
  return obj;
}
function remove(kind, id) {
  const data = all();
  data[kind] = (data[kind] || []).filter(x => x.id !== id);
  writeJson(FILE, data);
}

// ---------- Оценка результата проверки ----------
const CHECK_TITLES = {
  'schema-compare': 'Структура', 'data-compare': 'Данные', 'agg-compare': 'Агрегаты', 'query-compare': 'Запросы',
  'calc-verify': 'Расчёты', profile: 'Профиль данных', readiness: 'Готовность данных', 'unit-tests': 'Юнит-тесты', 'deps-check': 'Зависимости пакетов', 'data-sync': 'Синхронизация данных', delta: 'Догрузка',
  health: 'Аудит здоровья', 'index-advice': 'Индексы', 'plan-compare': 'Планы запросов', backup: 'Резервная копия', 'schema-snapshot': 'Снимок схемы',
};
function verdict(type, s) {
  if (!s) return { status: 'error', text: 'нет результата', problems: 1 };
  switch (type) {
    case 'schema-compare': return { status: s.error ? 'fail' : s.warning ? 'warn' : 'ok', text: `ошибок ${s.error}, предупреждений ${s.warning}`, problems: s.error };
    case 'data-compare': { const p = (s.different || 0) + (s.error || 0); return { status: p ? 'fail' : 'ok', text: `таблиц ${s.tables}: отличаются ${s.different || 0}, ошибок ${s.error || 0}; строк нет/лишних/разных ${s.missing}/${s.extra}/${s.differentRows}`, problems: p }; }
    case 'agg-compare': { const p = (s.different || 0) + (s.error || 0); return { status: p ? 'fail' : 'ok', text: `таблиц ${s.tables}: расхождения в ${s.different}, ошибок ${s.error}`, problems: p }; }
    case 'query-compare': { const p = (s.different || 0) + (s.error || 0); return { status: p ? 'fail' : s.slow ? 'warn' : 'ok', text: `запросов ${s.queries}: отличаются ${s.different}, ошибок ${s.error}, медленнее ${s.slow}`, problems: p }; }
    case 'calc-verify': { const p = (s.different || 0) + (s.error || 0); return { status: p ? 'fail' : 'ok', text: `таблиц ${s.tables}: отличаются ${s.different}, ошибок ${s.error}`, problems: p }; }
    case 'readiness': { const p = s.error || 0; return { status: p ? 'fail' : s.warning ? 'warn' : 'ok', text: `таблиц ${s.tables}: готово ${s.ok}, пусто в обеих ${s.warning}, расхождений ${s.error}`, problems: p }; }
    case 'unit-tests': { const p = (s.failed || 0) + (s.notFound || 0); return { status: p ? 'fail' : 'ok', text: `функций ${s.functions}: вызовов ${s.calls}, не прошло ${s.failed}, не найдено ${s.notFound}`, problems: p }; }
    case 'deps-check': { const p = s.missing || 0; return { status: p ? 'fail' : 'ok', text: `объектов ${s.objects}: не хватает ${s.missing}`, problems: p }; }
    case 'profile': return { status: s.error ? 'fail' : s.warning ? 'warn' : 'ok', text: `колонок ${s.columns}: ошибок ${s.error || 0}, предупреждений ${s.warning || 0}`, problems: s.error || 0 };
    case 'health': return { status: s.error ? 'fail' : s.warning ? 'warn' : 'ok', text: `оценка ${s.score}: ошибок ${s.error}, предупреждений ${s.warning}`, problems: s.error };
    case 'index-advice': return { status: s.fkNoIndex || s.invalid || s.missing ? 'warn' : 'ok', text: `советов ${s.advices}: FK без индекса ${s.fkNoIndex}, нет индексов ${s.missing}, недействительных ${s.invalid}`, problems: (s.fkNoIndex || 0) + (s.invalid || 0) };
    case 'plan-compare': { const p = (s.slower || 0) + (s.error || 0); return { status: p ? 'fail' : s.warning ? 'warn' : 'ok', text: `запросов ${s.queries}: медленнее ${s.slower}, с замечаниями ${s.warning}, ошибок ${s.error}`, problems: p }; }
    case 'backup': return { status: s.ok ? 'ok' : 'fail', text: `копия ${s.bytes != null ? Math.round(s.bytes / 1048576) + ' МБ' : ''}${s.verified === null ? ', без проверки' : s.verified ? ', проверена' : ', ПРОВЕРКА НЕ ПРОЙДЕНА'}`, problems: s.ok ? 0 : 1 };
    case 'schema-snapshot': return { status: s.changed ? 'warn' : 'ok', text: s.changed ? 'структура изменилась — сохранён новый снимок' : 'структура не менялась', problems: 0 };
    default: return { status: 'ok', text: JSON.stringify(s).slice(0, 200), problems: 0 };
  }
}

function lastRun(suiteId) {
  const f = path.join(RUNS, suiteId + '.json');
  const arr = readJson(f, []);
  return arr[arr.length - 1] || null;
}
function saveRun(suiteId, run) {
  const f = path.join(RUNS, suiteId + '.json');
  const arr = readJson(f, []);
  arr.push(run);
  writeJson(f, arr.slice(-50));
}
function runs(suiteId) { return readJson(path.join(RUNS, suiteId + '.json'), []).reverse(); }

async function notify(suite, run) {
  if (!suite.webhook) return;
  const icon = { ok: '✅', warn: '⚠️', fail: '❌' }[run.status] || '•';
  const lines = run.checks.map(c => `${{ ok: '✅', warn: '⚠️', fail: '❌', error: '❌' }[c.status] || '•'} ${c.title}: ${c.text}${c.change ? ` (${c.change})` : ''}`);
  const text = `${icon} Регламент «${suite.name}»: ${{ ok: 'всё совпадает', warn: 'есть предупреждения', fail: 'есть расхождения' }[run.status]}\n${lines.join('\n')}`;
  try {
    const r = await fetch(suite.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, suite: suite.name, status: run.status, checks: run.checks, finishedAt: run.finishedAt }) });
    return r.ok;
  } catch { return false; }
}

async function runSuite(p, ctx) {
  const suite = get('suites', p.suiteId);
  if (!suite) throw new Error('Набор проверок не найден');
  const { JOB_TYPES } = require('../jobtypes');
  const prev = lastRun(suite.id);
  const checks = [];
  const t0 = Date.now();
  const enabled = (suite.checks || []).filter(c => c.enabled !== false);
  for (const [i, c] of enabled.entries()) {
    ctx.checkCancel();
    const title = c.title || CHECK_TITLES[c.type] || c.type;
    ctx.progress(i, enabled.length, title);
    ctx.log(`===== ${title} =====`);
    const sub = Object.create(ctx);
    sub.log = (m, l) => ctx.log(`[${title}] ${m}`, l);
    sub.setPartialResult = () => {};
    const started = Date.now();
    let res = null, err = null;
    try { res = await JOB_TYPES[c.type].run(c.params, sub); } catch (e) { if (e.cancelled) throw e; err = e.message; }
    const v = err ? { status: 'error', text: err, problems: 1 } : verdict(c.type, res.summary);
    const before = prev && prev.checks.find(x => x.id === c.id);
    const change = before ? (v.problems > before.problems ? `ухудшение: было ${before.problems}` : v.problems < before.problems ? `улучшение: было ${before.problems}` : '') : '';
    checks.push({ id: c.id, type: c.type, title, status: v.status, text: v.text, problems: v.problems, change, ms: Date.now() - started, summary: res && res.summary });
    ctx.log(`${title}: ${v.text}`, v.status === 'ok' ? 'info' : 'warning');
  }
  const status = checks.some(c => c.status === 'fail' || c.status === 'error') ? 'fail' : checks.some(c => c.status === 'warn') ? 'warn' : 'ok';
  const run = { jobId: ctx.id, startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString(), status, checks, trigger: p.trigger || 'manual' };
  saveRun(suite.id, run);
  if (suite.webhook && (status !== 'ok' || suite.notifyAlways)) {
    const ok = await notify(suite, run);
    ctx.log(ok ? 'Уведомление отправлено' : 'Не удалось отправить уведомление', ok ? 'info' : 'warning');
  }
  return { summary: { status, checks: checks.length, fail: checks.filter(c => c.status === 'fail' || c.status === 'error').length, warn: checks.filter(c => c.status === 'warn').length }, suite: { id: suite.id, name: suite.name }, checks, previous: prev ? { finishedAt: prev.finishedAt, status: prev.status } : null };
}

// ---------- Встроенный планировщик (формат cron: минута час день месяц день_недели) ----------
function cronField(f, min, max, val) {
  if (f === '*') return true;
  return f.split(',').some(part => {
    let [range, step] = part.split('/');
    step = step ? parseInt(step, 10) : 1;
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) [lo, hi] = range.split('-').map(Number);
    else { lo = Number(range); hi = step > 1 ? max : lo; }
    if (Number.isNaN(lo) || Number.isNaN(hi)) return false;
    return val >= lo && val <= hi && (val - lo) % step === 0;
  });
}
function cronMatches(expr, d = new Date()) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return false;
  const dow = d.getDay();
  return cronField(f[0], 0, 59, d.getMinutes()) && cronField(f[1], 0, 23, d.getHours())
    && cronField(f[2], 1, 31, d.getDate()) && cronField(f[3], 1, 12, d.getMonth() + 1)
    && (cronField(f[4], 0, 7, dow) || (dow === 0 && cronField(f[4], 0, 7, 7)));
}
function validCron(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  return f.length === 5 && f.every(x => /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/.test(x));
}

let timer = null;
const lastFired = new Map();
function startScheduler(createJob) {
  if (timer) return;
  timer = setInterval(() => {
    const now = new Date();
    const minuteKey = now.toISOString().slice(0, 16);
    for (const s of list('suites')) {
      if (!s.enabled || !s.schedule || !validCron(s.schedule)) continue;
      if (lastFired.get(s.id) === minuteKey || !cronMatches(s.schedule, now)) continue;
      lastFired.set(s.id, minuteKey);
      createJob('suite', { suiteId: s.id, suiteName: s.name, trigger: 'schedule' });
    }
  }, 20000);
  timer.unref && timer.unref();
}

module.exports = { list, get, save, remove, runSuite, runs, startScheduler, cronMatches, validCron, verdict, KINDS };
