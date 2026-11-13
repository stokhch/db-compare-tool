'use strict';
// Сверка расчётов без CSV (развитие plsql2pg verify): одни и те же расчёты запускаются в Oracle и в PostgreSQL,
// итоговые таблицы сравниваются построчно в тех же сессиях, затем обе транзакции откатываются.
// Если процедура Oracle сама делает COMMIT — откатить её нельзя: запускайте только на тестовой копии.
const { connect } = require('../db');
const { loadMeta } = require('../meta');
const { getConnection, getSettings, publicConnection } = require('../lib/store');
const { compareTable } = require('../compare/data');
const { canonDecimal } = require('../lib/normalize');

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
      const r = await db.exec(st);
      const step = { step: i + 1, sql: sql.slice(0, 300), ms: Date.now() - t0, status: 'done' };
      // ответы процедуры: Oracle — строки «OUT:…» из DBMS_OUTPUT, PostgreSQL — строка результата CALL/SELECT
      if (db.type === 'oracle') {
        const lines = await db.readOutput().catch(() => []);
        const o = lines.filter(l => l.startsWith('OUT:'));
        if (o.length) step.out = o[o.length - 1].slice(4).split('|');
        const other = lines.filter(l => !l.startsWith('OUT:'));
        if (other.length) step.output = other.slice(-50);
      } else if (r && r.rows && r.rows.length) {
        step.out = Object.values(r.rows[0]).map(v => (v === null || v === undefined ? '' : String(v)));
      }
      out.push(step);
      ctx.log(`${label}: шаг ${i + 1} — ${Date.now() - t0} мс${step.out ? ` → ${step.out.join(' | ')}` : ''}`);
    } catch (e) {
      out.push({ step: i + 1, sql: sql.slice(0, 300), ms: Date.now() - t0, status: 'error', error: e.message });
      throw Object.assign(new Error(`${label}, шаг ${i + 1}: ${e.message}`), { steps: out });
    }
  }
  return out;
}

// Сравнение ответов процедур (OUT-параметры: код ошибки, сообщение) по номеру шага
function compareOuts(a, b) {
  const norm = v => {
    if (v === undefined || v === null) return '';
    const s = String(v).trim();
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return canonDecimal(s);
    return s;
  };
  const rows = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] && a[i].out, y = b[i] && b[i].out;
    if (!x && !y) continue;
    const nx = (x || []).map(norm), ny = (y || []).map(norm);
    const same = nx.length === ny.length ? nx.every((v, k) => v === ny[k]) : nx.every((v, k) => v === (ny[k] ?? ''));
    rows.push({ step: i + 1, source: x ? x.join(' | ') : '—', target: y ? y.join(' | ') : '—', status: same ? 'equal' : 'different' });
  }
  return rows;
}

async function runCalcVerify(p, ctx) {
  const srcConn = getConnection(p.sourceId), tgtConn = getConnection(p.targetId);
  const K = x => String(x).toLowerCase();
  const src = await connect(srcConn), tgt = await connect(tgtConn);
  const rollback = p.rollback !== false;
  const result = { source: { ...publicConnection(srcConn), schema: p.sourceSchema }, target: { ...publicConnection(tgtConn), schema: p.targetSchema }, rollback };
  try {
    for (const db of [src, tgt]) if (db.type === 'postgres') await db.exec('BEGIN');
    if (src.type === 'oracle') await src.exec('BEGIN DBMS_OUTPUT.ENABLE(NULL); END;');
    if (tgt.type === 'oracle') await tgt.exec('BEGIN DBMS_OUTPUT.ENABLE(NULL); END;');
    ctx.log(rollback ? 'Изменения будут откачены после сравнения' : 'Режим очистки периода: изменения фиксируются, период очищается шагами «до» и «после»', rollback ? 'info' : 'warning');
    // Очистка периода до расчёта (del_* и т. п.)
    if (p.sourcePre || p.targetPre) {
      ctx.progress(0, 5, 'Очистка периода…');
      result.sourcePre = await runSteps(src, splitSteps(p.sourcePre), 'Источник, очистка', ctx);
      result.targetPre = await runSteps(tgt, splitSteps(p.targetPre || p.sourcePre), 'Приёмник, очистка', ctx);
    }
    ctx.progress(1, 5, 'Расчёт в источнике…');
    result.sourceSteps = await runSteps(src, splitSteps(p.sourceSteps), 'Источник', ctx);
    ctx.progress(2, 5, 'Расчёт в приёмнике…');
    result.targetSteps = await runSteps(tgt, splitSteps(p.targetSteps || p.sourceSteps), 'Приёмник', ctx);
    result.outs = compareOuts(result.sourceSteps, result.targetSteps);
    for (const o of result.outs) if (o.status !== 'equal') ctx.log(`Ответ шага ${o.step} отличается: ${o.source} → ${o.target}`, 'warning');
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
    // Очистка периода после сравнения
    if (p.sourcePost || p.targetPost) {
      ctx.progress(4, 5, 'Очистка после…');
      result.sourcePost = await runSteps(src, splitSteps(p.sourcePost), 'Источник, очистка после', ctx);
      result.targetPost = await runSteps(tgt, splitSteps(p.targetPost || p.sourcePost), 'Приёмник, очистка после', ctx);
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
    tables: t.length, equal: t.filter(x => x.status === 'equal').length, different: t.filter(x => x.status === 'different').length + ((result.outs || []).some(o => o.status !== 'equal') ? 1 : 0),
    error: t.filter(x => x.status === 'error').length + (result.error ? 1 : 0), msSource: result.msSource, msTarget: result.msTarget,
    outsDifferent: (result.outs || []).filter(o => o.status !== 'equal').length,
  };
  if (result.error && !t.length) throw new Error(result.error);
  return result;
}

module.exports = { runCalcVerify, splitSteps };
