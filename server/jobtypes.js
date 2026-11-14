'use strict';
// Реестр типов задач: используется сервером, регламентными проверками и командной строкой.
const { runSchemaCompare } = require('./compare/schema');
const { runDataCompare } = require('./compare/data');
const { runTransfer } = require('./copy/transfer');
const { runPgDump } = require('./copy/pgdump');
const { runDataPump } = require('./copy/datapump');
const { runOra2pg } = require('./copy/ora2pg');
const { runApplySql } = require('./copy/applysql');
const { runDataSync } = require('./compare/syncdata');
const { runProfile } = require('./migrate/profile');
const { runPipeline } = require('./migrate/pipeline');
const { runDelta } = require('./migrate/delta');
const { runExtras } = require('./migrate/extras');
const { runCodeScan } = require('./migrate/codescan');
const { runAggCompare } = require('./verify/aggregates');
const { runQueryCompare } = require('./verify/queries');
const { runCalcVerify } = require('./verify/calc');
const { runReadiness } = require('./verify/readiness');
const { runDepsCheck } = require('./migrate/deps');
const { runUnitTests } = require('./verify/unittests');
const { runDumpAnalyze, runDumpImport } = require('./dump/import');
const { runPlanCompare, runIndexAdvice } = require('./tools/perf');
const { runHealth } = require('./tools/health');
const { runSearch } = require('./tools/search');
const { runDocs } = require('./tools/docs');
const { runBackup } = require('./tools/backup');
const { runPiiScan, runTestCopy } = require('./testdata/testcopy');
const { takeSnapshot } = require('./history/snapshots');

const JOB_TYPES = {
  'schema-compare': { title: p => `Схемы: ${p.sourceSchema} ↔ ${p.targetSchema}`, run: runSchemaCompare },
  'data-compare': { title: p => `Данные: ${p.sourceSchema} ↔ ${p.targetSchema}`, run: runDataCompare },
  transfer: { title: p => `Перелив: ${p.sourceSchema} → ${p.targetSchema}`, run: runTransfer },
  pgdump: { title: p => `pg_dump/pg_restore (${p.mode || 'dump_restore'})`, run: runPgDump },
  datapump: { title: p => `Data Pump: ${p.sourceSchema} → ${p.targetSchema || p.sourceSchema}`, run: runDataPump },
  ora2pg: { title: p => `ora2pg ${p.action}: ${p.sourceSchema}`, run: runOra2pg },
  'data-sync': { title: p => `Синхронизация данных: ${p.sourceSchema} → ${p.targetSchema}${p.apply ? ' (с выполнением)' : ''}`, run: runDataSync },
  profile: { title: p => `Профиль данных: ${p.sourceSchema}`, run: runProfile },
  pipeline: { title: p => `Миграция: ${p.sourceSchema} → ${p.targetSchema}${p.resumeJobId ? ' (продолжение)' : ''}`, run: runPipeline },
  'agg-compare': { title: p => `Агрегаты: ${p.sourceSchema} ↔ ${p.targetSchema}`, run: runAggCompare },
  delta: { title: p => `Догрузка изменений: ${p.sourceSchema} → ${p.targetSchema}${p.apply ? ' (с выполнением)' : ''}`, run: runDelta },
  extras: { title: p => `Права и окружение: ${p.sourceSchema}`, run: runExtras },
  codescan: { title: p => `Проверка кода: ${p.path}`, run: runCodeScan },
  'query-compare': { title: p => `Запросы: ${(p.queries || []).length}${p.includeViews ? ' + представления' : ''}`, run: runQueryCompare },
  'calc-verify': { title: p => `Сверка расчётов: ${(p.tables || []).length} таблиц`, run: runCalcVerify },
  readiness: { title: p => `Готовность данных: ${p.period && p.period.from ? `${p.period.from}…${p.period.to}` : ''}`, run: runReadiness },
  'deps-check': { title: p => `Зависимости пакетов: ${p.sourceSchema} → ${p.targetSchema}`, run: runDepsCheck },
  'unit-tests': { title: p => `Юнит-тесты функций${p.suite ? ' (без Oracle)' : ''}`, run: runUnitTests },
  'dump-analyze': { title: p => `Анализ дампа: ${require('path').basename(String(p.file || ''))}`, run: runDumpAnalyze },
  'dump-import': { title: p => `Импорт дампа${p.title ? ': ' + p.title : ''}`, run: runDumpImport },
  'plan-compare': { title: p => `Сравнение планов: запросов ${(p.queries || []).length}`, run: runPlanCompare },
  'index-advice': { title: p => `Советы по индексам: ${p.schema}`, run: runIndexAdvice },
  health: { title: p => `Аудит здоровья: ${p.schema}`, run: runHealth },
  'db-search': { title: p => `Поиск «${String(p.text || '').slice(0, 40)}» (${{ value: 'в данных', code: 'в коде', name: 'в именах' }[p.mode || 'value']})`, run: runSearch },
  'db-docs': { title: p => `Документация: ${p.schema}`, run: runDocs },
  backup: { title: p => `Резервная копия${p.schema ? ': ' + p.schema : ''}`, run: runBackup },
  'pii-scan': { title: p => `Поиск персональных данных: ${p.sourceSchema}`, run: runPiiScan },
  'test-copy': { title: p => `Тестовая копия: ${p.sourceSchema} → ${p.targetSchema}`, run: runTestCopy },
  'schema-snapshot': { title: p => `Снимок схемы: ${p.schema}`, run: takeSnapshot },
  'apply-sql': { title: p => `Выполнение скрипта: ${(p.statements || []).length} операторов`, run: runApplySql },
};

// Регламентные проверки (набор проверок) — подключаются отдельно, чтобы избежать циклических зависимостей
JOB_TYPES.suite = { title: p => `Регламент: ${p.suiteName || p.suiteId}`, run: (p, ctx) => require('./verify/suites').runSuite(p, ctx) };

// SQL до и после задачи (preSql / postSql) — исправления из проверки перед запуском
const { withSql } = require('./preflight/common');
for (const def of Object.values(JOB_TYPES)) def.run = withSql(def.run);

module.exports = { JOB_TYPES };
