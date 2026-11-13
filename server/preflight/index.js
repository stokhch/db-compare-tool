'use strict';
// Реестр проверок перед запуском задач.
const { preflightTransfer } = require('./transfer');
const { preflightPgDump } = require('./pgdump');
const { preflightDataPump } = require('./datapump');
const { preflightOra2pg, preflightDelta, preflightDataCompare } = require('./others');
const { applySelection, unresolvedOf } = require('./common');
const store = require('../lib/store');

const PREFLIGHT = {
  transfer: p => preflightTransfer(p, 'transfer'),
  pipeline: p => preflightTransfer(p, 'pipeline'),
  pgdump: preflightPgDump,
  datapump: p => (p.commandsOnly ? { issues: [], facts: [] } : preflightDataPump(p)),
  ora2pg: preflightOra2pg,
  delta: preflightDelta,
  'data-compare': preflightDataCompare,
};

async function runPreflight(type, params) {
  const f = PREFLIGHT[type];
  if (!f) return { issues: [], facts: [], supported: false };
  const t0 = Date.now();
  const r = await f(params || {});
  const order = { error: 0, warning: 1, info: 2 };
  r.issues.sort((a, b) => order[a.level] - order[b.level]);
  return { ...r, supported: true, ms: Date.now() - t0 };
}

/** Итоговые параметры задачи по выбранным исправлениям; изменения настроек (_settings) сохраняются сразу. */
function applyPreflight({ params, issues, selection, inputs }) {
  const { params: out, chosen } = applySelection(params, issues || [], selection, inputs);
  const unresolved = unresolvedOf(issues || [], selection);
  if (out._settings) { store.saveSettings({ ...store.getSettings(), ...out._settings }); delete out._settings; }
  return { params: out, chosen, unresolved };
}

module.exports = { runPreflight, applyPreflight, PREFLIGHT };
