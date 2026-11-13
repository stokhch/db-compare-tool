'use strict';
// Обёртка над ora2pg: генерирует ora2pg.conf из сохранённых подключений и запускает нужное действие.
const fs = require('fs');
const path = require('path');
const { run, ora2pgCmd } = require('../lib/proc');
const { getConnection, DATA_DIR } = require('../lib/store');

const ACTIONS = {
  SHOW_VERSION: 'Версия Oracle',
  SHOW_REPORT: 'Отчёт о содержимом и оценка сложности миграции',
  SHOW_TABLE: 'Список таблиц',
  SHOW_COLUMN: 'Колонки и типы (как будут перенесены)',
  TABLE: 'DDL таблиц',
  VIEW: 'Представления', MVIEW: 'Мат. представления', SEQUENCE: 'Последовательности',
  FUNCTION: 'Функции', PROCEDURE: 'Процедуры', PACKAGE: 'Пакеты', TRIGGER: 'Триггеры', TYPE: 'Типы',
  GRANT: 'Права', PARTITION: 'Секции', SYNONYM: 'Синонимы',
  COPY: 'Перенос данных (COPY, напрямую в PG при заданном PG_DSN)',
  INSERT: 'Перенос данных (INSERT)',
  TEST: 'Проверка: объекты и количество строк Oracle vs PG',
  TEST_COUNT: 'Проверка: только количество строк',
  TEST_VIEW: 'Проверка: строки представлений',
  TEST_DATA: 'Проверка: построчное сравнение данных',
};

function oracleDsn(c) {
  if (c.connectString && !/^[\w.-]+(:\d+)?\/[\w.$#-]+$/.test(c.connectString)) return `dbi:Oracle:${c.connectString}`;
  const key = c.oracleConnectMode === 'sid' ? 'sid' : 'service_name';
  return `dbi:Oracle:host=${c.host};${key}=${c.database};port=${c.port}`;
}

function buildConf(s, t, p, outDir) {
  const lines = [
    `# Сгенерировано db-compare-tool ${new Date().toISOString()}`,
    `ORACLE_DSN\t${oracleDsn(s)}`,
    `ORACLE_USER\t${s.user}`,
    `ORACLE_PWD\t${s.password}`,
    `SCHEMA\t${p.sourceSchema.toUpperCase()}`,
    `NLS_LANG\tAMERICAN_AMERICA.AL32UTF8`,
    `CLIENT_ENCODING\tUTF8`,
    `OUTPUT_DIR\t${outDir}`,
    `OUTPUT\toutput.sql`,
    `FILE_PER_TABLE\t0`,
    `DROP_FKEY\t0`,
    `DISABLE_SEQUENCE\t0`,
    `PG_SUPPORTS_IDENTITY\t1`,
  ];
  if (t) {
    lines.push(
      `PG_DSN\tdbi:Pg:dbname=${t.database};host=${t.host};port=${t.port}`,
      `PG_USER\t${t.user}`,
      `PG_PWD\t${t.password}`,
    );
  }
  if (p.targetSchema) lines.push(`EXPORT_SCHEMA\t1`, `PG_SCHEMA\t${p.targetSchema}`);
  if (p.dataValidationRows) lines.push(`DATA_VALIDATION_ROWS\t${p.dataValidationRows}`);
  if (p.allowTables) lines.push(`ALLOW\t${p.allowTables}`);
  if (p.excludeTables) lines.push(`EXCLUDE\t${p.excludeTables}`);
  if (p.truncateTable) lines.push('TRUNCATE_TABLE\t1');
  if (p.extraConfig) lines.push('', '# Дополнительно', p.extraConfig);
  return lines.join('\n') + '\n';
}

// Сводка по отчёту TEST: секции [ERRORS ...] и их содержимое
function parseTestReport(text) {
  const sections = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    const m = /^\[ERRORS (.+)\]$/.exec(l);
    if (m) { cur = { section: m[1], ok: false, messages: [] }; sections.push(cur); continue; }
    if (/^\[TEST /.test(l)) { cur = null; continue; }
    if (cur && l) {
      if (/^OK,/.test(l)) cur.ok = true;
      else cur.messages.push(l);
    }
  }
  return sections;
}

async function runOra2pg(p, ctx) {
  const s = getConnection(p.sourceId);
  if (s.type !== 'oracle') throw new Error('Источник для ora2pg должен быть Oracle');
  const t = p.targetId ? getConnection(p.targetId) : null;
  if (t && t.type !== 'postgres') throw new Error('Приёмник для ora2pg должен быть PostgreSQL');
  const action = p.action || 'SHOW_REPORT';
  if (!ACTIONS[action]) throw new Error(`Неизвестное действие ${action}`);
  if (/^TEST/.test(action) && !t) throw new Error('Для проверок TEST нужно выбрать базу PostgreSQL');

  const outDir = path.join(DATA_DIR, 'ora2pg', ctx.id);
  fs.mkdirSync(outDir, { recursive: true });
  const confFile = path.join(outDir, 'ora2pg.conf');
  fs.writeFileSync(confFile, buildConf(s, t, p, outDir), 'utf8');

  const { cmd, pre, env, source } = ora2pgCmd();
  ctx.log(`ora2pg: ${source}`);
  const args = [...pre, '-c', confFile, '-t', action, '-b', outDir];
  if (p.parallelTables > 1) args.push('-P', String(p.parallelTables));
  if (p.oracleCopies > 1) args.push('-J', String(p.oracleCopies));
  if (p.jobs > 1) args.push('-j', String(p.jobs));
  if (action === 'TEST' && p.countRows) args.push('--count_rows');
  if (action === 'SHOW_REPORT') { if (p.estimateCost !== false) args.push('--estimate_cost'); args.push('--dump_as_html'); }

  const stdoutName = action === 'SHOW_REPORT' ? 'report.html' : 'stdout.txt';
  ctx.progress(0, 0, `ora2pg ${action}…`);
  const r = await run(cmd, args, { cwd: outDir, ctx, env, captureStdout: true, logStdout: action !== 'SHOW_REPORT', stdoutFile: path.join(outDir, stdoutName) });

  // пароли в conf больше не нужны
  try {
    fs.writeFileSync(confFile, fs.readFileSync(confFile, 'utf8').replace(/^(ORACLE_PWD|PG_PWD)\t.*$/gm, '$1\t***'), 'utf8');
  } catch { /* */ }
  if (r.code !== 0) throw new Error(`ora2pg завершился с кодом ${r.code}. Смотрите журнал.`);

  let test = null;
  if (/^TEST/.test(action)) {
    const dv = path.join(outDir, 'data_validation.log');
    const text = r.stdout + (fs.existsSync(dv) ? '\n' + fs.readFileSync(dv, 'utf8') : '');
    test = parseTestReport(text);
  }
  const files = fs.readdirSync(outDir).map(f => ({ name: f, size: fs.statSync(path.join(outDir, f)).size }));
  return {
    summary: { action, files: files.length, problems: test ? test.filter(x => !x.ok && x.messages.length).length : undefined },
    action, files, test,
  };
}

module.exports = { runOra2pg, ACTIONS, parseTestReport };
