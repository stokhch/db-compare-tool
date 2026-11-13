'use strict';
// Конвейер миграции «одной кнопкой» — для репетиций перед переключением:
// структура (без ключей) → данные (параллельно) → ключи, индексы, FK → последовательности → статистика → проверка.
// Время каждого шага фиксируется: сумма шагов после «структуры» — оценка окна простоя.
// Продолжение после сбоя: указывается прошлый запуск — загруженные таблицы пропускаются.
const { connect } = require('../db');
const { loadMeta } = require('../meta');
const { filterMeta } = require('../meta/objects');
const { getConnection, publicConnection } = require('../lib/store');
const { buildSchemaSync } = require('../compare/syncschema');
const { runApplySql } = require('../copy/applysql');
const { runTransfer } = require('../copy/transfer');
const { runSchemaCompare } = require('../compare/schema');
const { runDataCompare } = require('../compare/data');
const { getJob } = require('../lib/jobs');

const STEP_NAMES = {
  structure: 'Структура (таблицы без ключей)', data: 'Данные', keys: 'Ключи, индексы, внешние ключи',
  sequences: 'Последовательности', analyze: 'Сбор статистики', verify: 'Проверка',
};

function subCtx(ctx, prefix, onProgress) {
  const sub = Object.create(ctx);
  sub.log = (m, l) => ctx.log(`[${prefix}] ${m}`, l);
  sub.progress = (c, t, m) => { if (onProgress) onProgress(c, t, m); ctx.progress(c, t, `${prefix}: ${m || ''}`); };
  sub.setPartialResult = () => {};
  return sub;
}

async function syncGroups(p, groups, ctx) {
  const K = x => String(x).toLowerCase();
  const src = await connect(getConnection(p.sourceId)), tgt = await connect(getConnection(p.targetId));
  try {
    let A = await loadMeta(src, p.sourceSchema, {}, null);
    let B = await loadMeta(tgt, p.targetSchema, {}, null, A.packages || []);
    if (p.tables && p.tables.length) {
      const sel = p.tables.map(name => ({ type: 'table', name }));
      A = filterMeta(A, sel, K); B = filterMeta(B, sel, K);
      A.sequences = (await loadMeta(src, p.sourceSchema, {}, null)).sequences; // последовательности — все
      B.sequences = (await loadMeta(tgt, p.targetSchema, {}, null)).sequences;
    }
    const sync = await buildSchemaSync(src, tgt, A, B, { ...p, compareRoutines: false }, K);
    return sync.statements.filter(s => groups.includes(s.group) && !s.comment && s.enabled);
  } finally { await src.close(); await tgt.close(); }
}

async function runPipeline(p, ctx) {
  const srcConn = getConnection(p.sourceId), tgtConn = getConnection(p.targetId);
  const steps = [];
  const want = {
    structure: p.structure === 'create', data: p.data !== false, keys: p.keys !== false,
    sequences: p.sequences !== false, analyze: p.analyze !== false, verify: p.verify && p.verify !== 'none',
  };
  // Продолжение прошлого запуска
  let skipTables = [];
  if (p.resumeJobId) {
    const prev = getJob(p.resumeJobId, true);
    const dataStep = prev && prev.result && prev.result.steps && prev.result.steps.find(s => s.id === 'data');
    if (dataStep && dataStep.details && dataStep.details.tables) {
      skipTables = dataStep.details.tables.filter(t => t.status === 'done' || t.status === 'skipped').map(t => t.table);
      ctx.log(`Продолжение запуска ${p.resumeJobId.slice(0, 8)}: уже загружено таблиц — ${skipTables.length}`);
    }
  }
  const order = ['structure', 'data', 'keys', 'sequences', 'analyze', 'verify'].filter(s => want[s]);
  ctx.progress(0, order.length, 'Старт');
  const result = { steps, source: { ...publicConnection(srcConn), schema: p.sourceSchema }, target: { ...publicConnection(tgtConn), schema: p.targetSchema } };

  for (const [idx, id] of order.entries()) {
    ctx.checkCancel();
    const step = { id, name: STEP_NAMES[id], status: 'running', ms: 0, details: null };
    steps.push(step);
    ctx.setPartialResult({ ...result, summary: summarize(steps) });
    const t0 = Date.now();
    const sub = subCtx(ctx, STEP_NAMES[id]);
    ctx.log(`===== Шаг ${idx + 1}/${order.length}: ${STEP_NAMES[id]} =====`);
    try {
      if (id === 'structure') {
        const st = await syncGroups(p, ['Таблицы', 'Колонки'], sub);
        if (!st.length) sub.log('Все таблицы и колонки уже есть в приёмнике');
        const r = st.length ? await runApplySql({ targetId: p.targetId, statements: st, transaction: false, stopOnError: true }, sub) : { summary: { total: 0, done: 0, error: 0 } };
        step.details = r.summary;
        if (r.summary.error) throw new Error('Не удалось создать структуру');
      } else if (id === 'data') {
        const r = await runTransfer({
          sourceId: p.sourceId, targetId: p.targetId, sourceSchema: p.sourceSchema, targetSchema: p.targetSchema,
          tables: p.tables, mode: p.mode || 'truncate', createTables: false, disableFk: true, parallel: p.parallel || 4,
          syncSequences: false, skipTables, batchSize: p.batchSize, stopOnError: false,
        }, sub);
        step.details = r;
        if (r.summary.error) { step.status = 'error'; step.ms = Date.now() - t0; throw new Error(`Ошибок загрузки: ${r.summary.error}. Исправьте и запустите конвейер с «продолжить» — загруженные таблицы будут пропущены.`); }
      } else if (id === 'keys') {
        const st = await syncGroups(p, ['Первичные ключи', 'Уникальные ключи', 'Индексы', 'Внешние ключи'], sub);
        const r = st.length ? await runApplySql({ targetId: p.targetId, statements: st, transaction: false, stopOnError: false }, sub) : { summary: { total: 0, done: 0, error: 0 }, results: [] };
        step.details = r;
        if (r.summary.error) step.warning = `Не создано объектов: ${r.summary.error}`;
      } else if (id === 'sequences') {
        const st = await syncGroups(p, ['Последовательности'], sub);
        const r = st.length ? await runApplySql({ targetId: p.targetId, statements: st, transaction: false, stopOnError: false }, sub) : { summary: { total: 0, done: 0, error: 0 } };
        step.details = r.summary;
      } else if (id === 'analyze') {
        const db = await connect(tgtConn);
        try {
          if (db.type === 'postgres') {
            const tabs = await db.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','p')`, [p.targetSchema]);
            const only = p.tables && p.tables.length ? new Set(p.tables.map(t => t.toLowerCase())) : null;
            let k = 0;
            for (const t of tabs) {
              if (only && !only.has(t.relname.toLowerCase())) continue;
              ctx.checkCancel();
              await db.exec(`ANALYZE ${db.qualify(p.targetSchema, t.relname)}`); k++;
            }
            step.details = { tables: k };
          } else {
            await db.exec(`BEGIN DBMS_STATS.GATHER_SCHEMA_STATS(ownname => :o, cascade => TRUE); END;`, { o: p.targetSchema });
            step.details = { schema: p.targetSchema };
          }
        } finally { await db.close(); }
      } else if (id === 'verify') {
        if (p.verify === 'data') {
          const r = await runDataCompare({ sourceId: p.sourceId, targetId: p.targetId, sourceSchema: p.sourceSchema, targetSchema: p.targetSchema, tables: p.tables, parallel: p.parallel || 2 }, sub);
          step.details = { summary: r.summary, tables: r.tables.map(({ diffs, ...t }) => t) };
          if ((r.summary.different || 0) + (r.summary.error || 0)) step.warning = `Таблиц с отличиями: ${r.summary.different || 0}, ошибок: ${r.summary.error || 0}`;
        } else if (p.verify === 'aggregates') {
          const { runAggCompare } = require('../verify/aggregates');
          const r = await runAggCompare({ sourceId: p.sourceId, targetId: p.targetId, sourceSchema: p.sourceSchema, targetSchema: p.targetSchema, tables: p.tables }, sub);
          step.details = { summary: r.summary, tables: r.tables.map(({ groups, ...t }) => t) };
          if (r.summary.different) step.warning = `Таблиц с расхождением агрегатов: ${r.summary.different}`;
        } else {
          const r = await runSchemaCompare({ sourceId: p.sourceId, targetId: p.targetId, sourceSchema: p.sourceSchema, targetSchema: p.targetSchema, rowCounts: 'exact', checkPgCode: false, buildSync: false, compareRoutines: false, objects: p.tables && p.tables.length ? p.tables.map(name => ({ type: 'table', name })) : undefined }, sub);
          const rowsCat = r.categories.find(c => c.category === 'Количество строк');
          step.details = { summary: r.summary, rowsDiff: rowsCat ? rowsCat.error : 0, findings: r.findings.filter(f => f.status !== 'ok').slice(0, 300) };
          if (r.summary.error) step.warning = `Ошибок в сравнении: ${r.summary.error}`;
        }
      }
      if (step.status === 'running') step.status = step.warning ? 'warning' : 'done';
    } catch (e) {
      if (e.cancelled) { step.status = 'cancelled'; throw e; }
      step.status = 'error'; step.error = e.message;
      step.ms = Date.now() - t0;
      ctx.log(`Шаг «${STEP_NAMES[id]}» завершился ошибкой: ${e.message}`, 'error');
      ctx.setPartialResult({ ...result, summary: summarize(steps) });
      if (p.stopOnStepError !== false) { result.summary = summarize(steps); return result; }
    }
    step.ms = Date.now() - t0;
    ctx.log(`Шаг «${STEP_NAMES[id]}»: ${(step.ms / 1000).toFixed(1)} с`);
    ctx.progress(idx + 1, order.length, STEP_NAMES[id]);
    ctx.setPartialResult({ ...result, summary: summarize(steps) });
  }
  result.summary = summarize(steps);
  return result;
}

function summarize(steps) {
  const total = steps.reduce((s, x) => s + (x.ms || 0), 0);
  const downtime = steps.filter(s => ['data', 'keys', 'sequences', 'analyze'].includes(s.id)).reduce((s, x) => s + (x.ms || 0), 0);
  return {
    steps: steps.length, done: steps.filter(s => s.status === 'done').length, warning: steps.filter(s => s.status === 'warning').length,
    error: steps.filter(s => s.status === 'error').length, totalMs: total, downtimeMs: downtime,
  };
}

module.exports = { runPipeline };
