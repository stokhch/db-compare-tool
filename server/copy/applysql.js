'use strict';
// Выполнение выбранных операторов скрипта синхронизации на приёмнике.
const { connect } = require('../db');
const { getConnection } = require('../lib/store');

async function runApplySql(p, ctx) {
  const t = getConnection(p.targetId);
  const list = (p.statements || []).filter(s => !s.comment && s.sql && s.sql.trim() && !/^\s*--/.test(s.sql));
  if (!list.length) throw new Error('Нет операторов для выполнения');
  const db = await connect(t);
  const useTx = db.type === 'postgres' && p.transaction !== false;
  const results = [];
  let failed = 0;
  try {
    if (useTx) { await db.exec('BEGIN'); ctx.log('PostgreSQL: всё выполняется в одной транзакции — при ошибке изменения откатятся'); }
    else if (db.type === 'oracle') ctx.log('Oracle: DDL фиксируется сразу (автокоммит), откатить выполненные операторы нельзя', 'warning');
    let i = 0;
    for (const s of list) {
      ctx.checkCancel();
      ctx.progress(i, list.length, s.object || '');
      const sql = s.sql.trim().replace(db.type === 'oracle' && !s.plsql ? /;\s*$/ : /$^/, '');
      const t0 = Date.now();
      try {
        await db.exec(sql);
        results.push({ object: s.object, group: s.group, status: 'done', ms: Date.now() - t0 });
        ctx.log(`✓ ${s.group ? s.group + ': ' : ''}${s.object}`);
      } catch (e) {
        failed++;
        results.push({ object: s.object, group: s.group, status: 'error', error: e.message, ms: Date.now() - t0 });
        ctx.log(`✗ ${s.object}: ${e.message}\n${sql.slice(0, 500)}`, 'error');
        if (useTx || p.stopOnError !== false) break;
      }
      ctx.progress(++i, list.length);
    }
    if (useTx) {
      if (failed) { await db.exec('ROLLBACK'); ctx.log('Ошибка — транзакция откачена, база не изменена', 'error'); }
      else { await db.exec('COMMIT'); ctx.log('Транзакция зафиксирована'); }
    } else if (db.type === 'oracle') await db.commit();
  } catch (e) {
    if (useTx) await db.exec('ROLLBACK').catch(() => {});
    throw e;
  } finally { await db.close(); }
  const summary = { total: list.length, done: results.filter(r => r.status === 'done').length, error: failed, rolledBack: useTx && failed > 0 };
  if (failed && useTx) results.forEach(r => { if (r.status === 'done') r.status = 'rolled back'; });
  return { summary, results };
}

module.exports = { runApplySql };
