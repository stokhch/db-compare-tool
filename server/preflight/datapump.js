'use strict';
// Проверка перед Data Pump по сети (Oracle → Oracle): связь сервера-приёмника с источником через DB link,
// существующая схема, табличные пространства, роли, права, версии и кодировки, LONG.
const crypto = require('crypto');
const { targetState } = require('../dump/import');
const { tryConnect, one, fmtMb } = require('./common');
const { verNum } = require('../dump/plan');

const q = s => `"${String(s).replace(/"/g, '')}"`;
const SINGLE = new Set(['CL8MSWIN1251', 'CL8KOI8R', 'CL8ISO8859P5', 'RU8PC866', 'WE8MSWIN1252', 'WE8ISO8859P1', 'EE8MSWIN1250', 'US7ASCII']);

function descriptor(c) {
  if (c.connectString) return c.connectString;
  const cd = c.oracleConnectMode === 'sid' ? `(SID=${c.database})` : `(SERVICE_NAME=${c.database})`;
  return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${c.host})(PORT=${c.port}))(CONNECT_DATA=${cd}))`;
}

async function preflightDataPump(p) {
  const issues = [], facts = [];
  const src = await tryConnect(p.sourceId, 'Источник', issues);
  const tgt = await tryConnect(p.targetId, 'Приёмник', issues);
  if (!src || !tgt) { await src?.close(); await tgt?.close(); return { issues, facts }; }
  const S = String(p.sourceSchema || '').toUpperCase(), T = String(p.targetSchema || p.sourceSchema || '').toUpperCase();
  try {
    if (src.type !== 'oracle' || tgt.type !== 'oracle') { issues.push({ id: 'types', level: 'error', blocking: true, title: 'Data Pump работает только между базами Oracle', fixes: [] }); return { issues, facts }; }
    const t = await targetState(tgt, [T], null);
    const sv = await one(src, `SELECT version FROM product_component_version WHERE product LIKE 'Oracle%' AND ROWNUM = 1`, {}, []);
    const scs = await one(src, `SELECT value FROM nls_database_parameters WHERE parameter = 'NLS_CHARACTERSET'`, {}, []);
    const srcVersion = sv && sv[0] ? sv[0].version : null, srcCharset = scs && scs[0] ? scs[0].value : null;
    facts.push({ label: 'Источник', value: `${srcVersion || '?'}, ${srcCharset || '?'}` }, { label: 'Приёмник', value: `${t.version || '?'}, ${t.charset}, ${t.conName || ''}` });
    if (t.conName === 'CDB$ROOT') issues.push({ id: 'cdb', level: 'error', blocking: true, title: 'Приёмник — корневой контейнер CDB$ROOT', details: 'Подключитесь к PDB (XEPDB1, FREEPDB1, ORCLPDB1…).', fixes: [] });
    const sMajor = Math.floor(verNum(srcVersion) || 0), tMajor = Math.floor(verNum(t.version) || 0);
    if (sMajor && tMajor && sMajor > tMajor) issues.push({ id: 'version', level: 'warning', title: `Источник Oracle ${sMajor}, приёмник — ${tMajor}`, details: 'Импорт по сети из более новой версии возможен, но объекты с новыми возможностями не создадутся.', fixes: [] });

    // схема-источник
    const own = await src.query(`SELECT 1 AS x FROM all_users WHERE username = :u`, { u: S });
    if (!own.length) { issues.push({ id: 'srcschema', level: 'error', blocking: true, title: `В источнике нет схемы ${S}`, fixes: [] }); return { issues, facts }; }
    const sdba = !!(await one(src, `SELECT 1 AS x FROM dba_segments WHERE ROWNUM = 1`));
    const seg = await one(src, `SELECT tablespace_name AS ts, SUM(bytes) AS b FROM ${sdba ? 'dba' : 'user'}_segments WHERE ${sdba ? 'owner = :o' : ':o = :o'} GROUP BY tablespace_name`, { o: S }, []);
    const size = (seg || []).reduce((s, r) => s + Number(r.b), 0);
    if (size) facts.push({ label: 'Объём схемы', value: fmtMb(size) });
    const srcUser = String(src.conn.user).replace(/\s+as\s+sysdba$/i, '').toUpperCase();
    if (srcUser !== S) {
      const roles = new Set(((await one(src, `SELECT role FROM session_roles`, {}, [])) || []).map(r => r.role));
      if (!roles.has('DBA') && !roles.has('DATAPUMP_EXP_FULL_DATABASE') && !roles.has('EXP_FULL_DATABASE'))
        issues.push({ id: 'srcpriv', level: 'error', blocking: true, title: `Пользователь источника ${srcUser} не может выгружать чужую схему ${S}`, details: 'Нужна роль DATAPUMP_EXP_FULL_DATABASE (выполнить от SYS в источнике) или подключение владельцем схемы.', sql: `GRANT DATAPUMP_EXP_FULL_DATABASE TO ${q(srcUser)};`, fixes: [] });
    }

    // DB link: проверка связи с сервера-приёмника
    const host = String(src.conn.host || '').toLowerCase();
    if (['localhost', '127.0.0.1', '::1'].includes(host) && String(tgt.conn.host || '').toLowerCase() !== host)
      issues.push({ id: 'localhost', level: 'warning', title: `Источник указан как ${host}`, details: 'DB link создаётся на сервере-приёмнике, и «localhost» для него — он сам. Укажите в подключении источника реальное имя или IP, видимые с сервера-приёмника.', fixes: [] });
    if (!t.privs.dba && !(await one(tgt, `SELECT 1 AS x FROM session_privs WHERE privilege = 'CREATE DATABASE LINK'`, {}, [])).length)
      issues.push({ id: 'linkpriv', level: 'error', blocking: true, title: `У ${t.user} нет права CREATE DATABASE LINK`, sql: `GRANT CREATE DATABASE LINK TO ${q(t.user)};`, fixes: [] });
    else if (p.createDbLink !== false) {
      const link = `DBCMP_CHK_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      try {
        if (/"/.test(src.conn.password)) throw new Error('Пароль источника содержит двойную кавычку — DB link не создать');
        await tgt.exec(`CREATE DATABASE LINK ${link} CONNECT TO ${q(srcUser)} IDENTIFIED BY "${src.conn.password}" USING '${descriptor(src.conn).replace(/'/g, "''")}'`);
        await tgt.query(`SELECT 1 AS x FROM dual@${link}`);
        facts.push({ label: 'Связь приёмник → источник', value: 'работает' });
      } catch (e) {
        const m = e.message.split('\n')[0];
        const hint = /ORA-12541|ORA-12170|ORA-12543/.test(m) ? 'Сервер-приёмник не достучался до хоста/порта источника: брандмауэр, другой сегмент сети или неверный адрес (см. «localhost»).'
          : /ORA-12514|ORA-12505/.test(m) ? 'Сервис/SID источника не найден listener-ом — проверьте имя сервиса в подключении источника.'
          : /ORA-01017/.test(m) ? 'Неверный пароль источника для DB link (регистр пароля важен).'
          : /ORA-02085/.test(m) ? 'GLOBAL_NAMES=TRUE на приёмнике: имя DB link должно совпадать с глобальным именем источника.' : '';
        issues.push({ id: 'link', level: 'error', blocking: true, title: 'DB link с сервера-приёмника к источнику не работает', details: `${m}${hint ? '\n' + hint : ''}`,
          fixes: [] });
      } finally {
        await tgt.exec(`ALTER SESSION CLOSE DATABASE LINK ${link}`).catch(() => {});
        await tgt.exec(`DROP DATABASE LINK ${link}`).catch(() => {});
      }
    }

    // права на приёмнике
    if ((T !== t.user || S !== T) && !t.privs.dba && !t.privs.dpImp)
      issues.push({ id: 'tgtpriv', level: 'error', blocking: true, title: `У ${t.user} нет роли DATAPUMP_IMP_FULL_DATABASE`, details: 'Без неё нельзя импортировать в другую схему или переименовывать схему.', sql: `GRANT DATAPUMP_IMP_FULL_DATABASE TO ${q(t.user)};`, fixes: [] });

    // схема-приёмник
    const u = t.users[T];
    if (u && u.exists && u.total > 0) {
      issues.push({ id: 'target', level: 'warning', required: true, choice: true, title: `Схема ${T} в приёмнике уже есть: объектов ${u.total}${u.sessions ? `, сеансов ${u.sessions}` : ''}`,
        details: Object.entries(u.objects).map(([k, v]) => `${k.toLowerCase()} ${v}`).join(', '),
        fixes: [
          { id: 'drop', title: `Удалить схему ${T} и импортировать заново`, danger: true, patch: { preSql: [
            ...(u.sessions ? [{ connId: p.targetId, title: `Завершить сеансы ${T}`, ignoreError: true, sql: `BEGIN FOR s IN (SELECT sid, serial# AS ser FROM v$session WHERE username = '${T}') LOOP EXECUTE IMMEDIATE 'ALTER SYSTEM KILL SESSION ''' || s.sid || ',' || s.ser || ''' IMMEDIATE'; END LOOP; END;` }] : []),
            { connId: p.targetId, title: `Удалить схему ${T}`, sql: `DROP USER ${q(T)} CASCADE` }] } },
          { id: 'remap', title: 'Импортировать под другим именем', input: { label: 'Новое имя схемы', path: 'targetSchema', value: `${T}_COPY`, upper: true }, patch: {} },
          { id: 'replace', title: 'Пересоздать таблицы (TABLE_EXISTS_ACTION=REPLACE)', patch: { tableExistsAction: 'REPLACE' } },
          { id: 'truncate', title: 'Очистить таблицы и загрузить (TRUNCATE)', patch: { tableExistsAction: 'TRUNCATE' } },
          { id: 'skip', title: 'Пропустить существующие таблицы (SKIP)', patch: { tableExistsAction: 'SKIP' } },
        ] });
    }
    // табличные пространства
    const tsNeeded = [...new Set((seg || []).map(r => r.ts).filter(Boolean))];
    const have = new Set(t.tablespaces.map(x => x.name));
    const missTs = tsNeeded.filter(x => !have.has(x));
    if (missTs.length)
      issues.push({ id: 'ts', level: 'warning', choice: true, title: `На приёмнике нет табличных пространств: ${missTs.join(', ')}`,
        fixes: [
          { id: 'remap', title: `Перенаправить в ${t.defaultPermanent || 'USERS'} (REMAP_TABLESPACE)`, default: true, patch: { remapTablespaces: missTs.map(x => [x, t.defaultPermanent || 'USERS']) } },
          { id: 'create', title: 'Создать табличные пространства (автоувеличение)', patch: { preSql: missTs.map(x => ({ connId: p.targetId, title: `Создать ${x}`,
            sql: t.omf ? `CREATE TABLESPACE ${q(x)} DATAFILE SIZE 100M AUTOEXTEND ON NEXT 100M MAXSIZE UNLIMITED` : `CREATE TABLESPACE ${q(x)} DATAFILE '${(t.datafileDir || '').replace(/'/g, "''")}${t.sep || '/'}${x.toLowerCase()}01.dbf' SIZE 100M AUTOEXTEND ON NEXT 100M MAXSIZE UNLIMITED` })) } },
        ] });
    // роли — получатели прав на объекты схемы
    const grantees = ((await one(src, `SELECT DISTINCT grantee AS g FROM all_tab_privs WHERE table_schema = :o`, { o: S }, [])) || []).map(r => r.g);
    const known = new Set([...t.roles, ...t.allUsers, 'PUBLIC', S, T]);
    const missRoles = grantees.filter(g => !known.has(g));
    if (missRoles.length)
      issues.push({ id: 'roles', level: 'warning', title: `На приёмнике нет ролей/пользователей, которым выданы права: ${missRoles.join(', ')}`, details: 'Эти GRANT завершатся ошибкой ORA-01917.',
        fixes: [{ id: 'create', title: `Создать роли: ${missRoles.length}`, default: true, patch: { preSql: missRoles.map(r => ({ connId: p.targetId, title: `Роль ${r}`, ignoreError: true, sql: `CREATE ROLE ${q(r)}` })) } }] });
    // кодировка
    if (srcCharset && t.charset && srcCharset !== t.charset && SINGLE.has(srcCharset) && /UTF8/.test(t.charset)) {
      const cols = await one(src, `SELECT COUNT(*) AS n FROM all_tab_columns WHERE owner = :o AND data_type IN ('VARCHAR2','CHAR') AND char_used = 'B'`, { o: S }, []);
      const n = cols && cols[0] ? Number(cols[0].n) : 0;
      if (n) issues.push({ id: 'charset', level: 'warning', title: `Кодировка ${srcCharset} → ${t.charset}: строковых колонок с длиной в байтах ${n}`, details: 'Кириллица в UTF-8 занимает 2 байта — длинные значения не поместятся (ORA-12899).',
        fixes: [{ id: 'twophase', title: 'Импорт в два этапа: структура → колонки в CHAR → данные', default: true, patch: { byteToChar: true } }] });
    }
    // LONG — по сети не переносится
    const longs = await one(src, `SELECT table_name AS t, column_name AS c FROM all_tab_columns WHERE owner = :o AND data_type IN ('LONG','LONG RAW') AND table_name NOT LIKE 'BIN$%'`, { o: S }, []);
    if (longs && longs.length) issues.push({ id: 'long', level: 'warning', title: `Таблицы с LONG / LONG RAW: ${longs.length}`, details: 'Data Pump по сети их данные не переносит (ограничение Oracle). Перенесите эти таблицы «Переливом» или через файл дампа.', list: longs.map(x => `${x.t}.${x.c}`), fixes: [] });
    // DB links и задания в схеме
    const links = await one(src, `SELECT db_link AS n FROM all_db_links WHERE owner = :o`, { o: S }, []);
    if (links && links.length) issues.push({ id: 'dblinks', level: 'warning', title: `DB links в схеме: ${links.map(x => x.n).join(', ')}`, details: 'Копия будет обращаться к тем же удалённым базам.', fixes: [{ id: 'excl', title: 'Не переносить DB links', patch: { excludeDbLinks: true } }] });
    const jobsN = await one(src, `SELECT (SELECT COUNT(*) FROM all_scheduler_jobs WHERE owner = :o) + (SELECT COUNT(*) FROM all_jobs WHERE schema_user = :o) AS n FROM dual`, { o: S }, []);
    if (jobsN && jobsN[0] && Number(jobsN[0].n)) issues.push({ id: 'jobs', level: 'warning', title: `Задания по расписанию в схеме: ${jobsN[0].n}`, details: 'В копии они начнут выполняться сами.', fixes: [{ id: 'excl', title: 'Не переносить задания', default: true, patch: { excludeJobs: true } }] });
    if (t.staleJobs.length) issues.push({ id: 'stale', level: 'info', title: `Остатки прерванных заданий Data Pump: ${t.staleJobs.map(j => j.job).join(', ')}`,
      fixes: [{ id: 'drop', title: 'Удалить их мастер-таблицы', default: true, patch: { preSql: t.staleJobs.map(j => ({ connId: p.targetId, ignoreError: true, title: `Удалить ${j.owner}.${j.job}`, sql: `DROP TABLE ${q(j.owner)}.${q(j.job)} PURGE` })) } }] });
    // место
    const free = t.tablespaces.filter(x => x.contents === 'PERMANENT').reduce((s, x) => s + (x.maxMb || 0), 0);
    if (size && free && free * 1048576 < size * 1.2) issues.push({ id: 'space', level: 'warning', title: `Может не хватить места: схема ${fmtMb(size)}, доступно ≈ ${free} МБ`, fixes: [] });
  } finally { await src.close(); await tgt.close(); }
  return { issues, facts };
}

module.exports = { preflightDataPump, descriptor };
