'use strict';
// Сверка расчётов без CSV (развитие plsql2pg verify): одни и те же расчёты запускаются в Oracle и в PostgreSQL,
// итоговые таблицы сравниваются построчно в тех же сессиях, затем обе транзакции откатываются.
// Если процедура Oracle сама делает COMMIT — откатить её нельзя: запускайте только на тестовой копии.
const { connect } = require('../db');
const { loadMeta } = require('../meta');
const { getConnection, getSettings, publicConnection } = require('../lib/store');
const { compareTable } = require('../compare/data');

// Разделение текста на операторы: строка «/» (как в SQL*Plus) или пустая строка между операторами не нужна —
// каждый блок, отделённый строкой из одного «/», считается одним оператором.
function splitSteps(text) {
  return String(text || '').split(/^\s*\/\s*$/m).map(s => s.trim()).filter(Boolean)
    .map(s => (/^(BEGIN|DECLARE|DO|CREATE)/i.test(s) ? s : s.replace(/;\s*$/, '')));
}

async function runSteps(db, steps, label, ctx) {
  const out = [];
  for (const [i, sql] of steps.entries()) {
    ctx.checkCancel();
    const t0 = Date.now();
    try {
      const st = db.type === 'oracle' && /^(BEGIN|DECLARE)/i.test(sql) && !/;\s*$/.test(sql) ? sql + ';' : sql;
      await db.exec(st);
      out.push({ step: i + 1, sql: sql.slice(0, 300), ms: Date.now() - t0, status: 'done' });
      ctx.log(`${label}: шаг ${i + 1} — ${Date.now() - t0} мс`);
    } catch (e) {
      out.push({ step: i + 1, sql: sql.slice(0, 300), ms: Date.now() - t0, status: 'error', error: e.message });
      throw Object.assign(new Error(`${label}, шаг ${i + 1}: ${e.message}`), { steps: out });
    }
  }
  return out;
}

async function runCalcVerify(p, ctx) {
  const srcConn = getConnection(p.sourceId), tgtConn = getConnection(p.targetId);
  const K = x => String(x).toLowerCase();
  const src = await connect(srcConn), tgt = await connect(tgtConn);
  const rollback = p.rollback !== false;
  const result = { source: { ...publicConnection(srcConn), schema: p.sourceSchema }, target: { ...publicConnection(tgtConn), schema: p.targetSchema }, rollback };
  try {
    for (const db of [src, tgt]) if (db.type === 'postgres') await db.exec('BEGIN');
    ctx.log(rollback ? 'Изменения будут откачены после сравнения' : 'Изменения будут зафиксированы (COMMIT)', rollback ? 'info' : 'warning');
    ctx.progress(0, 3, 'Расчёт в источнике…');
    result.sourceSteps = await runSteps(src, splitSteps(p.sourceSteps), 'Источник', ctx);
    ctx.progress(1, 3, 'Расчёт в приёмнике…');
    result.targetSteps = await runSteps(tgt, splitSteps(p.targetSteps || p.sourceSteps), 'Приёмник', ctx);
    result.msSource = result.sourceSteps.reduce((s, x) => s + x.ms, 0);
    result.msTarget = result.targetSteps.reduce((s, x) => s + x.ms, 0);

    ctx.progress(2, 3, 'Сравнение итоговых таблиц…');
    const A = await loadMeta(src, p.sourceSchema, {}, null), B = await loadMeta(tgt, p.targetSchema, {}, null);
    const mapA = new Map(A.tables.map(t => [K(t.name), t])), mapB = new Map(B.tables.map(t => [K(t.name), t]));
    const settings = getSettings();
    const opts = { ...p, emptyAsNull: p.emptyAsNull ?? src.type !== tgt.type, sourceSchema: p.sourceSchema, targetSchema: p.targetSchema };
    const sub = Object.create(ctx); sub.progress = () => {};
    result.tables = [];
    for (const spec of (p.tables || []).map(x => (typeof x === 'string' ? { source: x } : x))) {
      const ta = mapA.get(K(spec.source)), tb = mapB.get(K(spec.target || spec.source));
      if (!ta || !tb) { result.tables.push({ table: spec.source, status: 'error', error: !ta ? 'Нет в источнике' : 'Нет в приёмнике' }); continue; }
      try {
        const r = await compareTable(src, tgt, ta, tb, spec, opts, sub, Number(p.maxDiffs) || settings.maxDiffsPerTable || 200, settings.fetchSize || 2000, K);
        result.tables.push(r);
        ctx.log(`${ta.name}: ${r.status === 'equal' ? 'совпадает' : `нет ${r.missing}, лишних ${r.extra}, разных ${r.different}`}`, r.status === 'equal' ? 'info' : 'warning');
      } catch (e) {
        if (e.cancelled) throw e;
        result.tables.push({ table: ta.name, status: 'error', error: e.message });
      }
    }
  } catch (e) {
    if (e.steps) { if (!result.sourceSteps) result.sourceSteps = e.steps; else result.targetSteps = e.steps; }
    result.error = e.message;
    ctx.log(e.message, 'error');
    if (e.cancelled) throw e;
  } finally {
    for (const db of [src, tgt]) {
      try {
        if (rollback || result.error) { if (db.type === 'postgres') await db.exec('ROLLBACK'); else await db.rollback(); }
        else { if (db.type === 'postgres') await db.exec('COMMIT'); else await db.commit(); }
      } catch { /* */ }
    }
    await src.close(); await tgt.close();
  }
  const t = result.tables || [];
  result.summary = {
    tables: t.length, equal: t.filter(x => x.status === 'equal').length, different: t.filter(x => x.status === 'different').length,
    error: t.filter(x => x.status === 'error').length + (result.error ? 1 : 0), msSource: result.msSource, msTarget: result.msTarget,
  };
  if (result.error && !t.length) throw new Error(result.error);
  return result;
}

module.exports = { runCalcVerify, splitSteps };
