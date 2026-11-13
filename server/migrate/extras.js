'use strict';
// «Окружение» схемы Oracle, о котором обычно вспоминают после переключения:
// роли и права, комментарии, синонимы, DB links, задания DBMS_SCHEDULER / DBMS_JOB.
// Результат — операторы для PostgreSQL в том же формате, что и скрипт синхронизации структуры.
const { connect } = require('../db');
const { getConnection } = require('../lib/store');

const lc = s => String(s).toLowerCase();
const qi = s => (/^[a-z_][a-z0-9_$]*$/.test(lc(s)) ? lc(s) : `"${lc(s).replace(/"/g, '""')}"`);
const lit = s => `'${String(s).replace(/'/g, "''")}'`;

// ---------- Расписание: Oracle calendar syntax → cron ----------
function repeatToCron(ri) {
  if (!ri) return null;
  const m = {};
  for (const part of String(ri).toUpperCase().replace(/\s+/g, '').split(';')) {
    const [k, v] = part.split('=');
    if (k && v != null) m[k] = v;
  }
  const num = (v, d) => (v == null ? d : v.split(',').map(x => String(parseInt(x, 10))).join(','));
  const interval = m.INTERVAL ? parseInt(m.INTERVAL, 10) : 1;
  const minute = num(m.BYMINUTE, '0'), hour = num(m.BYHOUR, '0');
  const days = { MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6, SUN: 0 };
  switch (m.FREQ) {
    case 'MINUTELY': return interval > 1 ? `*/${interval} * * * *` : '* * * * *';
    case 'HOURLY': return `${minute} ${interval > 1 ? `*/${interval}` : '*'} * * *`;
    case 'DAILY': {
      if (m.BYDAY) return `${minute} ${hour} * * ${m.BYDAY.split(',').map(d => days[d.replace(/^-?\d+/, '')]).filter(x => x != null).join(',')}`;
      return `${minute} ${hour} ${interval > 1 ? `*/${interval}` : '*'} * *`;
    }
    case 'WEEKLY': {
      const dow = m.BYDAY ? m.BYDAY.split(',').map(d => days[d]).filter(x => x != null).join(',') : '1';
      return interval > 1 ? null : `${minute} ${hour} * * ${dow}`;
    }
    case 'MONTHLY': {
      if (m.BYMONTHDAY && m.BYMONTHDAY !== '-1') return `${minute} ${hour} ${num(m.BYMONTHDAY)} ${interval > 1 ? `*/${interval}` : '*'} *`;
      return null; // последний день месяца, BYDAY=1MON и т. п. — вручную
    }
    case 'YEARLY': {
      const months = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
      const mon = m.BYMONTH ? (months[m.BYMONTH] || num(m.BYMONTH)) : 1;
      return `${minute} ${hour} ${num(m.BYMONTHDAY, '1')} ${mon} *`;
    }
    default: return null;
  }
}

// Вызов процедуры Oracle → PostgreSQL (именование пакетов как у plsql2pg: пакет_процедура)
function plsqlToCall(action, owner, naming = 'underscore') {
  let body = String(action || '').trim().replace(/^BEGIN\s+/i, '').replace(/\s*END\s*;?\s*$/i, '').trim();
  const stmts = body.split(/;\s*/).filter(Boolean);
  const out = [];
  for (const st of stmts) {
    const m = /^(?:"?(\w+)"?\.)?(?:"?(\w+)"?\.)?"?(\w+)"?\s*(\((.*)\))?$/s.exec(st.trim());
    if (!m) return null;
    let [, a, b, c, , args] = m;
    // a.b.c = схема.пакет.процедура; a.c = пакет.процедура или схема.процедура
    let schema = null, pkg = null;
    if (a && b) { schema = a; pkg = b; } else if (a) { if (lc(a) === lc(owner)) schema = a; else pkg = a; }
    const name = pkg ? (naming === 'schema' ? `${qi(pkg)}.${qi(c)}` : qi(`${pkg}_${c}`)) : qi(c);
    out.push(`CALL ${name}(${(args || '').trim()})`);
  }
  return out.join('; ');
}

async function runExtras(p, ctx) {
  const s = getConnection(p.sourceId);
  if (s.type !== 'oracle') throw new Error('Источник должен быть Oracle');
  const db = await connect(s);
  const own = p.sourceSchema;
  const S = p.targetSchema || lc(own);
  const out = [];
  let id = 0;
  const add = (group, object, sql, o = {}) => out.push({ id: ++id, group, object, sql, plsql: !!o.plsql, risk: o.risk || 'low', note: o.note || '', enabled: o.enabled !== false, comment: !!o.comment });
  const tryQuery = async (sql, binds, what) => {
    try { return await db.query(sql, binds); }
    catch (e) { ctx.log(`${what}: ${e.message}`, 'warning'); add(what, '—', `-- ${what}: нет доступа к словарю (${e.message.split('\n')[0]})`, { comment: true }); return []; }
  };
  try {
    const b = { o: own };
    // ---- Типы объектов (для прав и синонимов) ----
    const objs = await tryQuery(`SELECT object_name, object_type FROM all_objects WHERE owner = :o`, b, 'Объекты');
    const typeOf = new Map(objs.map(o => [o.object_name, o.object_type]));

    // ---- Права ----
    ctx.progress(0, 6, 'Права');
    const privs = await tryQuery(`SELECT grantee, table_name, privilege, grantable FROM all_tab_privs WHERE table_schema = :o ORDER BY grantee, table_name, privilege`, b, 'Права');
    const colPrivs = await tryQuery(`SELECT grantee, table_name, column_name, privilege FROM all_col_privs WHERE table_schema = :o`, b, 'Права на колонки');
    const roles = [...new Set([...privs, ...colPrivs].map(r => r.grantee).filter(g => g !== 'PUBLIC' && g !== own))];
    for (const r of roles) {
      add('Роли', lc(r), `DO $$ BEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${lit(lc(r))}) THEN CREATE ROLE ${qi(r)} NOLOGIN; END IF;\nEND $$`,
        { note: 'Роль создаётся без входа; пользователям выдайте её через GRANT роль TO пользователь', plsql: true });
      add('Права', `схема → ${lc(r)}`, `GRANT USAGE ON SCHEMA ${qi(S)} TO ${qi(r)}`);
    }
    if (privs.some(r => r.grantee === 'PUBLIC')) add('Права', 'схема → PUBLIC', `GRANT USAGE ON SCHEMA ${qi(S)} TO PUBLIC`);
    const pgPriv = { SELECT: 'SELECT', INSERT: 'INSERT', UPDATE: 'UPDATE', DELETE: 'DELETE', REFERENCES: 'REFERENCES', EXECUTE: 'EXECUTE' };
    for (const r of privs) {
      if (r.grantee === own) continue;
      const to = r.grantee === 'PUBLIC' ? 'PUBLIC' : qi(r.grantee);
      const t = typeOf.get(r.table_name) || 'TABLE';
      const opt = r.grantable === 'YES' ? ' WITH GRANT OPTION' : '';
      const obj = `${qi(S)}.${qi(r.table_name)}`;
      if (!pgPriv[r.privilege]) { add('Права', `${r.table_name} → ${lc(r.grantee)}`, `-- ${r.privilege} ON ${own}.${r.table_name} TO ${r.grantee}: в PostgreSQL аналога нет`, { comment: true }); continue; }
      if (t === 'SEQUENCE') add('Права', `${r.table_name} → ${lc(r.grantee)}`, `GRANT USAGE, SELECT ON SEQUENCE ${obj} TO ${to}${opt}`);
      else if (t === 'PACKAGE' || t === 'PROCEDURE' || t === 'FUNCTION' || t === 'TYPE') {
        const target = t === 'PACKAGE'
          ? (p.packageNaming === 'schema' ? `ALL FUNCTIONS IN SCHEMA ${qi(r.table_name)}` : null)
          : `${t === 'PROCEDURE' ? 'PROCEDURE' : t === 'TYPE' ? 'TYPE' : 'FUNCTION'} ${obj}`;
        if (target) add('Права', `${r.table_name} → ${lc(r.grantee)}`, `GRANT ${t === 'TYPE' ? 'USAGE' : 'EXECUTE'} ON ${target} TO ${to}${opt}`, { note: t === 'PACKAGE' ? 'Пакет перенесён как схема' : '' });
        else add('Права', `${r.table_name} → ${lc(r.grantee)}`, `-- EXECUTE на пакет ${r.table_name} для ${r.grantee}: в PostgreSQL выдайте права на каждую функцию ${lc(r.table_name)}_* (GRANT EXECUTE ON FUNCTION ... TO ${to})`, { comment: true });
      } else add('Права', `${r.table_name} → ${lc(r.grantee)}`, `GRANT ${pgPriv[r.privilege]} ON ${obj} TO ${to}${opt}`);
    }
    for (const r of colPrivs) {
      if (!pgPriv[r.privilege]) continue;
      add('Права', `${r.table_name}.${r.column_name} → ${lc(r.grantee)}`, `GRANT ${pgPriv[r.privilege]} (${qi(r.column_name)}) ON ${qi(S)}.${qi(r.table_name)} TO ${r.grantee === 'PUBLIC' ? 'PUBLIC' : qi(r.grantee)}`);
    }

    // ---- Комментарии ----
    ctx.progress(1, 6, 'Комментарии');
    const tc = await tryQuery(`SELECT table_name, table_type, comments FROM all_tab_comments WHERE owner = :o AND comments IS NOT NULL AND table_name NOT LIKE 'BIN$%'`, b, 'Комментарии');
    for (const r of tc) add('Комментарии', r.table_name, `COMMENT ON ${r.table_type === 'VIEW' ? 'VIEW' : 'TABLE'} ${qi(S)}.${qi(r.table_name)} IS ${lit(r.comments)}`);
    const cc = await tryQuery(`SELECT table_name, column_name, comments FROM all_col_comments WHERE owner = :o AND comments IS NOT NULL AND table_name NOT LIKE 'BIN$%'`, b, 'Комментарии');
    for (const r of cc) add('Комментарии', `${r.table_name}.${r.column_name}`, `COMMENT ON COLUMN ${qi(S)}.${qi(r.table_name)}.${qi(r.column_name)} IS ${lit(r.comments)}`);
    const mc = await tryQuery(`SELECT mview_name, comments FROM all_mview_comments WHERE owner = :o AND comments IS NOT NULL`, b, 'Комментарии');
    for (const r of mc) add('Комментарии', r.mview_name, `COMMENT ON MATERIALIZED VIEW ${qi(S)}.${qi(r.mview_name)} IS ${lit(r.comments)}`);

    // ---- Синонимы ----
    ctx.progress(2, 6, 'Синонимы');
    const syn = await tryQuery(`SELECT owner, synonym_name, table_owner, table_name, db_link FROM all_synonyms WHERE owner = :o OR (owner = 'PUBLIC' AND table_owner = :o) ORDER BY owner, synonym_name`, b, 'Синонимы');
    let publicCount = 0;
    for (const r of syn) {
      if (r.owner === 'PUBLIC') { publicCount++; continue; }
      if (r.db_link) { add('Синонимы', r.synonym_name, `-- синоним ${r.synonym_name} → ${r.table_owner}.${r.table_name}@${r.db_link}: объект в другой базе — используйте внешнюю таблицу (oracle_fdw/postgres_fdw)`, { comment: true }); continue; }
      const srcSchema = lc(r.table_owner) === lc(own) ? S : lc(r.table_owner);
      const t = lc(r.table_owner) === lc(own) ? typeOf.get(r.table_name) : null;
      if (t && t !== 'TABLE' && t !== 'VIEW' && t !== 'MATERIALIZED VIEW') {
        add('Синонимы', r.synonym_name, `-- синоним ${r.synonym_name} → ${r.table_owner}.${r.table_name} (${t}): для кода синонимов нет — вызывайте по полному имени или через search_path`, { comment: true });
        continue;
      }
      add('Синонимы', r.synonym_name, `CREATE OR REPLACE VIEW ${qi(S)}.${qi(r.synonym_name)} AS SELECT * FROM ${qi(srcSchema)}.${qi(r.table_name)}`,
        { note: 'Синоним заменён представлением (для записи через представление нужны простые представления — без JOIN)' });
    }
    if (publicCount) add('Синонимы', `PUBLIC (${publicCount})`, `-- ${publicCount} публичных синонимов на объекты ${own}. В PostgreSQL их нет — добавьте схему в путь поиска:\n--   ALTER ROLE <роль приложения> SET search_path = ${qi(S)}, public;\n--   или ALTER DATABASE <база> SET search_path = ${qi(S)}, public;`, { comment: true });

    // ---- DB links ----
    ctx.progress(3, 6, 'DB links');
    const links = await tryQuery(`SELECT owner, db_link, username, host FROM all_db_links WHERE owner IN (:o, 'PUBLIC')`, b, 'DB links');
    for (const r of links) {
      const name = qi(r.db_link.split('.')[0]);
      add('DB links', r.db_link, [
        `-- DB link ${r.db_link} (пользователь ${r.username || '?'}, ${r.host || ''}). Аналог в PostgreSQL — внешний сервер:`,
        `-- Удалённая база Oracle → oracle_fdw:`,
        `--   CREATE EXTENSION IF NOT EXISTS oracle_fdw;`,
        `--   CREATE SERVER ${name} FOREIGN DATA WRAPPER oracle_fdw OPTIONS (dbserver ${lit(r.host || '//host:1521/service')});`,
        `--   CREATE USER MAPPING FOR CURRENT_USER SERVER ${name} OPTIONS (user ${lit(r.username || 'user')}, password '***');`,
        `--   IMPORT FOREIGN SCHEMA "${r.username || 'SCHEMA'}" FROM SERVER ${name} INTO ${qi(S)};`,
        `-- Если удалённая база тоже переезжает в PostgreSQL — postgres_fdw или dblink.`,
      ].join('\n'), { comment: true });
    }

    // ---- Задания ----
    ctx.progress(4, 6, 'Задания');
    const jobs = await tryQuery(`SELECT job_name, job_type, job_action, program_name, repeat_interval, enabled, schedule_name FROM all_scheduler_jobs WHERE owner = :o`, b, 'Задания');
    for (const j of jobs) {
      const cron = repeatToCron(j.repeat_interval);
      let call = null;
      if (j.job_type === 'PLSQL_BLOCK') call = plsqlToCall(j.job_action, own, p.packageNaming);
      else if (j.job_type === 'STORED_PROCEDURE') call = plsqlToCall(j.job_action, own, p.packageNaming);
      const head = `-- ${j.job_name}: ${j.job_type || j.program_name || ''} ${String(j.job_action || '').replace(/\s+/g, ' ').slice(0, 200)}\n-- расписание Oracle: ${j.repeat_interval || j.schedule_name || '—'}${j.enabled === 'TRUE' ? '' : ' (задание выключено)'}`;
      if (cron && call) {
        add('Задания', j.job_name, `SELECT cron.schedule(${lit(lc(j.job_name))}, ${lit(cron)}, $job$${call}$job$)`,
          { enabled: false, note: `Нужно расширение pg_cron. Проверьте вызов и часовой пояс cron (по умолчанию GMT). ${head.replace(/\n/g, ' ')}` });
      } else {
        add('Задания', j.job_name, `${head}\n-- автоматически не перенесено: ${!cron ? 'сложное расписание' : 'нестандартное действие'} — настройте в pg_cron вручную`, { comment: true });
      }
    }
    const oldJobs = await tryQuery(`SELECT job, what, interval, broken FROM all_jobs WHERE schema_user = :o`, b, 'Задания DBMS_JOB');
    for (const j of oldJobs) {
      add('Задания', `DBMS_JOB ${j.job}`, `-- DBMS_JOB ${j.job}: ${String(j.what || '').replace(/\s+/g, ' ')}\n-- интервал: ${j.interval}${j.broken === 'Y' ? ' (сломано)' : ''}\n-- Перенесите в pg_cron: SELECT cron.schedule('job_${j.job}', '<cron>', $$${plsqlToCall(j.what, own, p.packageNaming) || '...'}$$);`, { comment: true });
    }
    ctx.progress(6, 6, 'Готово');
  } finally { await db.close(); }
  const groups = ['Роли', 'Права', 'Комментарии', 'Синонимы', 'DB links', 'Задания'];
  out.sort((a, b2) => groups.indexOf(a.group) - groups.indexOf(b2.group) || a.id - b2.id);
  const count = g => out.filter(x => x.group === g).length;
  return { summary: Object.fromEntries(groups.map(g => [g, count(g)])), sync: { dialect: 'postgres', targetSchema: S, statements: out } };
}

module.exports = { runExtras, repeatToCron, plsqlToCall };
