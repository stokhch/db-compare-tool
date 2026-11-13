#!/usr/bin/env node
'use strict';
// Командная строка — для Планировщика заданий Windows и CI.
//   node server/cli.js suites                 список наборов проверок
//   node server/cli.js suite "Ночная сверка"  запустить набор (по имени или id)
//   node server/cli.js run <тип> params.json  запустить любую задачу с параметрами из файла
// Код возврата: 0 — всё совпадает, 1 — есть расхождения, 2 — ошибка.
const fs = require('fs');
const { JOB_TYPES } = require('./jobtypes');
const suites = require('./verify/suites');

function consoleCtx(id = 'cli-' + Date.now()) {
  let cancelled = false;
  process.on('SIGINT', () => { cancelled = true; });
  return {
    id,
    log: (m, l = 'info') => console.log(`${new Date().toISOString().slice(11, 19)} ${l === 'error' ? '✗' : l === 'warning' ? '!' : ' '} ${m}`),
    progress: () => {},
    checkCancel: () => { if (cancelled) throw Object.assign(new Error('Отменено'), { cancelled: true }); },
    get cancelled() { return cancelled; },
    addChild: () => {},
    setPartialResult: () => {},
  };
}

async function main() {
  const [cmd, arg, file] = process.argv.slice(2);
  if (cmd === 'suites') {
    for (const s of suites.list('suites')) console.log(`${s.id}  ${s.name}  ${s.schedule || '(вручную)'}  проверок: ${(s.checks || []).length}`);
    return 0;
  }
  if (cmd === 'suite') {
    const s = suites.get('suites', arg);
    if (!s) { console.error(`Набор «${arg}» не найден`); return 2; }
    const r = await suites.runSuite({ suiteId: s.id, trigger: 'cli' }, consoleCtx());
    console.log(`\nИтог: ${r.summary.status === 'ok' ? 'всё совпадает' : r.summary.status === 'warn' ? 'есть предупреждения' : 'есть расхождения'}`);
    for (const c of r.checks) console.log(` ${c.status.padEnd(5)} ${c.title}: ${c.text}${c.change ? ` (${c.change})` : ''}`);
    return r.summary.status === 'fail' ? 1 : 0;
  }
  if (cmd === 'run' && JOB_TYPES[arg]) {
    const params = JSON.parse(fs.readFileSync(file, 'utf8'));
    const r = await JOB_TYPES[arg].run(params, consoleCtx());
    console.log(JSON.stringify(r.summary, null, 2));
    const s = r.summary || {};
    return (s.error || s.different || s.fail) ? 1 : 0;
  }
  console.log('Использование:\n  node server/cli.js suites\n  node server/cli.js suite <имя|id>\n  node server/cli.js run <тип задачи> <params.json>\nТипы: ' + Object.keys(JOB_TYPES).join(', '));
  return cmd ? 2 : 0;
}

main().then(code => process.exit(code), e => { console.error(e.message); process.exit(2); });
