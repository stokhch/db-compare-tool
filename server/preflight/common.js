'use strict';
// Общие части «умной» проверки перед запуском.
//
// Проблема (issue): { id, level: 'error'|'warning'|'info', title, details, list, sql, blocking, choice, required, fixes }
//  • choice: true — варианты исправления взаимоисключающие (переключатель), иначе — флажки;
//  • required: true — без выбора варианта запуск невозможен (например, «таблицы не пусты — что делать?»);
//  • blocking: true — запуск невозможен, пока не выбрано исправление (или вообще, если исправлений нет).
// Исправление (fix): { id, title, default, danger, patch, input: { label, path, value, options } }
//  • patch — изменения параметров задачи (объекты сливаются, массивы дописываются);
//  • preSql / postSql в patch — SQL, выполняемые до и после задачи на указанном подключении.
const { connect } = require('../db');
const { getConnection } = require('../lib/store');

/** Слияние параметров: объекты — рекурсивно, массивы — дописываются, значения — заменяются. */
function deepMerge(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in a ? deepMerge(a[k], v) : v;
    return out;
  }
  return b === undefined ? a : b;
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) { if (!o[p] || typeof o[p] !== 'object') o[p] = {}; o = o[p]; }
  o[parts[parts.length - 1]] = value;
  return obj;
}

/** Итоговые параметры по выбранным исправлениям. selection = { issueId: fixId | [fixId…] }, inputs = { 'issue/fix': value } */
function applySelection(params, issues, selection = {}, inputs = {}) {
  let out = JSON.parse(JSON.stringify(params));
  const chosen = [];
  for (const i of issues) {
    const sel = selection[i.id] !== undefined ? selection[i.id] : defaultsOf(i);
    const ids = Array.isArray(sel) ? sel : sel ? [sel] : [];
    for (const f of i.fixes || []) {
      if (!ids.includes(f.id)) continue;
      let patch = JSON.parse(JSON.stringify(f.patch || {}));
      if (f.input) {
        const v = inputs[`${i.id}/${f.id}`] !== undefined ? inputs[`${i.id}/${f.id}`] : f.input.value;
        const val = f.input.upper ? String(v || '').toUpperCase() : v;
        if (f.input.path) patch = setPath(patch, f.input.path, val);
        patch = substitute(patch, val);   // «{{value}}» в строках исправления (например, в SQL)
      }
      out = deepMerge(out, patch);
      chosen.push({ issue: i.id, fix: f.id, title: f.title, danger: !!f.danger });
    }
  }
  return { params: out, chosen };
}
function substitute(o, v) {
  if (typeof o === 'string') return o.split('{{value}}').join(String(v ?? ''));
  if (Array.isArray(o)) return o.map(x => substitute(x, v));
  if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, substitute(x, v)]));
  return o;
}
function defaultsOf(i) {
  const d = (i.fixes || []).filter(f => f.default).map(f => f.id);
  return i.choice ? d[0] || null : d;
}

/** Нерешённые проблемы при данном выборе. */
function unresolvedOf(issues, selection = {}) {
  const out = [];
  for (const i of issues) {
    const sel = selection[i.id] !== undefined ? selection[i.id] : defaultsOf(i);
    const any = Array.isArray(sel) ? sel.length > 0 : !!sel;
    if ((i.required || i.blocking) && !any) out.push(i.title);
  }
  return out;
}

/** Подключение с понятной проблемой вместо исключения. */
async function tryConnect(connId, label, issues) {
  if (!connId) return null;
  let conn;
  try { conn = getConnection(connId); } catch (e) { issues.push({ id: `conn:${label}`, level: 'error', blocking: true, title: `${label}: подключение не найдено`, details: e.message, fixes: [] }); return null; }
  try { const db = await connect(conn); db.conn = conn; return db; }
  catch (e) {
    const { explain } = require('../lib/errhint');
    issues.push({ id: `conn:${label}`, level: 'error', blocking: true, title: `${label}: не удаётся подключиться к ${conn.name}`, details: explain(e), fixes: [] });
    return null;
  }
}

const one = async (db, sql, binds, def = null) => { try { return await db.query(sql, binds); } catch { return def; } };
const fmtRows = n => (n == null ? '?' : n >= 1e6 ? `${(n / 1e6).toFixed(1)} млн` : n >= 1e3 ? `${Math.round(n / 1e3)} тыс.` : String(n));
const fmtMb = b => (b == null ? '?' : b > 1073741824 ? `${(b / 1073741824).toFixed(1)} ГБ` : `${Math.round(b / 1048576)} МБ`);

/** Выполнение preSql / postSql из параметров задачи. */
async function runSqlList(list, ctx, label) {
  const byConn = new Map();
  for (const s of list || []) { if (!byConn.has(s.connId)) byConn.set(s.connId, []); byConn.get(s.connId).push(s); }
  for (const [connId, items] of byConn) {
    const db = await connect(getConnection(connId));
    try {
      for (const s of items) {
        try {
          await db.exec(s.sql);
          if (db.type === 'oracle') await db.commit().catch(() => {});
          ctx.log(`${label}: ${s.title || s.sql.split('\n')[0].slice(0, 120)}`);
        } catch (e) {
          ctx.log(`${label}: ${s.title || s.sql.slice(0, 120)} — ${e.message.split('\n')[0]}`, s.ignoreError ? 'warning' : 'error');
          if (db.type === 'postgres') await db.exec('ROLLBACK').catch(() => {});
          if (!s.ignoreError && label === 'Подготовка') throw new Error(`Подготовка не выполнена: ${s.title || s.sql.slice(0, 80)} — ${e.message.split('\n')[0]}`);
        }
      }
    } finally { await db.close(); }
  }
}

/** Обёртка задачи: preSql до, postSql после (даже при ошибке). */
function withSql(run) {
  return async (p, ctx) => {
    if (p.preSql && p.preSql.length) { ctx.log(`Подготовка: операторов ${p.preSql.length}`); await runSqlList(p.preSql, ctx, 'Подготовка'); }
    try { return await run(p, ctx); }
    finally { if (p.postSql && p.postSql.length) await runSqlList(p.postSql, ctx, 'Завершение').catch(e => ctx.log(e.message, 'error')); }
  };
}

module.exports = { deepMerge, setPath, applySelection, unresolvedOf, defaultsOf, tryConnect, one, fmtRows, fmtMb, runSqlList, withSql };
