'use strict';
// «Мозг» импорта: по составу дампа и состоянию базы-приёмника находит всё, что помешает импорту,
// предлагает исправления и строит план: SQL до импорта, задания Data Pump (или imp), SQL после.
// Чистые функции — тестируются без базы.
const crypto = require('crypto');
const { SINGLE_BYTE } = require('./header');

const q = s => `"${String(s).replace(/"/g, '')}"`;
const lit = s => `'${String(s).replace(/'/g, "''")}'`;
const MULTI_BYTE = new Set(['AL32UTF8', 'UTF8', 'AL16UTF16', 'ZHS16GBK', 'JA16SJIS']);
const verNum = v => { const m = /^(\d+)(?:\.(\d+))?/.exec(String(v || '')); return m ? Number(m[1]) + Number(m[2] || 0) / 100 : null; };
const randomPassword = () => 'Imp_' + crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, 'x') + '9';

/**
 * a = {
 *   format: 'datapump'|'exp', header, dumpInfo, contents (parseDdl), totalSize,
 *   target: { user, version, charset, conName, privs:{}, users:{NAME:{exists,total,objects,sessions}}, tablespaces:[{name,contents,freeMb,maxMb}],
 *             defaultPermanent, defaultTemp, roles:[], datafileDir, omf, staleJobs:[{owner,job}], sep }
 *   directory: { name, visible, canCreate }, impPath (для exp), encrypted
 * }
 * → { issues:[…], defaults: решения по умолчанию }
 */
function analyzeIssues(a) {
  const issues = [];
  const t = a.target, c = a.contents || { schemas: [], tablespacesUsed: [], tablespacesCreated: [], rolesUsed: [], grantees: [], externalRefs: [], dbLinks: [], directories: [], byteColumns: [], jobs: 0 };
  const isDp = a.format === 'datapump';
  const add = (i) => issues.push({ fixes: [], ...i });
  const d = { schemas: {}, tablespaces: {}, createRoles: true, byteToChar: false, excludeDbLinks: false, excludeJobs: c.jobs > 0, excludeTablespaces: false,
    dropStaleJobs: true, recompile: true, oidTransform: false, parallel: 1, selected: c.schemas.map(s => s.name), password: a.encryptionPassword || '' };

  // --- блокирующее: формат, контейнер, права, доступ к файлу
  if (a.format === 'unknown') add({ id: 'format', level: 'error', blocking: true, title: 'Не похоже на дамп Oracle', details: 'Ожидается файл expdp (Data Pump) или exp. Если это архив — распакуйте его.' });
  if (t.conName === 'CDB$ROOT') add({ id: 'cdb', level: 'error', blocking: true, title: 'Подключение к корневому контейнеру CDB$ROOT', details: 'Импортировать схемы нужно в подключаемую базу (PDB): XEPDB1 для Oracle XE, FREEPDB1 для Oracle Free, ORCLPDB1 и т. п. Измените сервис в подключении.' });
  const privileged = t.privs.dba || t.privs.dpImp || t.privs.impFull;
  const foreign = c.schemas.some(s => s.name !== t.user);
  if (!privileged && (foreign || c.schemas.some(s => s.createUser)))
    add({ id: 'privileges', level: 'error', blocking: true, title: `У пользователя ${t.user} нет роли DATAPUMP_IMP_FULL_DATABASE`,
      details: 'Без неё можно импортировать только собственную схему. Выполните от SYS и переподключитесь:', sql: `GRANT DATAPUMP_IMP_FULL_DATABASE TO ${q(t.user)};\nGRANT CREATE ANY DIRECTORY, DROP USER, CREATE USER, CREATE TABLESPACE, CREATE ROLE, ALTER SYSTEM TO ${q(t.user)};` });
  if (isDp && a.directory && !a.directory.visible)
    add({ id: 'file', level: 'error', blocking: !a.directory.copyPossible, title: 'Сервер базы не видит файл дампа',
      details: a.directory.reason || 'База на другом компьютере (или в контейнере), либо у службы Oracle нет прав на папку.',
      fixes: a.directory.copyPossible ? [{ id: 'copy', title: `Скопировать файл в каталог ${a.directory.copyTo} через соединение с базой`, default: true }] : [] });
  if (a.format === 'exp' && !a.impPath)
    add({ id: 'imp', level: 'error', blocking: true, title: 'Старый формат exp — нужна утилита imp', details: 'imp есть в полной установке Oracle (ORACLE_HOME\\bin), в Instant Client её нет. Укажите путь к папке bin Oracle в «Настройках».' });
  if (a.encrypted && !a.encryptionPassword) add({ id: 'password', level: 'error', blocking: true, title: 'Дамп зашифрован', details: 'Укажите пароль шифрования (ENCRYPTION_PASSWORD при экспорте).', fixes: [{ id: 'password', title: 'Пароль', input: 'password' }] });

  // --- версия и кодировка
  const dv = verNum(a.dumpInfo && a.dumpInfo.dbVersion || a.header && a.header.dbVersion), tv = verNum(t.version);
  if (dv && tv && Math.floor(dv) > Math.floor(tv))
    add({ id: 'version', level: isDp ? 'warning' : 'error', blocking: !isDp, title: `Дамп из Oracle ${Math.floor(dv)}, база-приёмник — ${Math.floor(tv)}`,
      details: isDp ? `Импорт пройдёт, только если экспорт делали с VERSION=${Math.floor(tv)} или ниже. Иначе будет ORA-39142 — попросите повторить expdp … VERSION=${Math.floor(tv)}.`
        : 'Файл exp более новой версии старая утилита imp не прочитает. Нужен экспорт утилитой exp той же или более ранней версии.' });
  const sc = (a.dumpInfo && a.dumpInfo.charset) || (a.header && a.header.charset);
  if (sc && t.charset && sc !== t.charset) {
    if (SINGLE_BYTE.has(sc) && MULTI_BYTE.has(t.charset)) {
      const cols = c.byteColumns.filter(x => d.selected.includes(x.owner));
      if (cols.length) {
        d.byteToChar = isDp;
        add({ id: 'charset', level: 'warning', title: `Кодировка меняется: ${sc} → ${t.charset}, строковых колонок с длиной в байтах: ${cols.length}`,
          details: 'Кириллица в UTF-8 занимает 2 байта, поэтому строка, заполнявшая VARCHAR2(n BYTE) больше чем наполовину, не поместится (ORA-12899), и такие строки таблицы не загрузятся.'
            + (isDp ? ' Исправление: сначала создать таблицы, перевести колонки в CHAR, затем загрузить данные.' : ' Для exp автоматического исправления нет: создайте таблицы заранее с длиной в CHAR и импортируйте с ignore=y.'),
          fixes: isDp ? [{ id: 'byteToChar', title: 'Импорт в два этапа с переводом колонок VARCHAR2(n BYTE) → VARCHAR2(n CHAR)', default: true }] : [],
          list: cols.slice(0, 200).map(x => `${x.owner}.${x.table}.${x.column} ${x.type}(${x.length} BYTE)`) });
      }
    } else if (MULTI_BYTE.has(sc) && SINGLE_BYTE.has(t.charset)) {
      add({ id: 'charset', level: 'warning', title: `Кодировка меняется: ${sc} → ${t.charset}`, details: 'Символы, которых нет в кодировке приёмника, заменятся на «?» или «¿». Лучше импортировать в базу с AL32UTF8.' });
    } else add({ id: 'charset', level: 'info', title: `Кодировка меняется: ${sc} → ${t.charset}`, details: 'Data Pump перекодирует данные. Проверьте выборочно текстовые поля после импорта.' });
  }

  // --- схемы
  for (const s of c.schemas) {
    const u = t.users[s.name] || { exists: false };
    const dec = { action: 'none', target: s.name, password: '' };
    if (u.exists && u.total > 0) {
      dec.action = null; // требуется решение
      add({ id: `schema:${s.name}`, schema: s.name, level: 'error', needsDecision: true, title: `Схема ${s.name} уже есть в базе и не пуста`,
        details: `Объектов: ${u.total} (${Object.entries(u.objects || {}).map(([k, v]) => `${k.toLowerCase()} ${v}`).join(', ')}). Подключённых сеансов: ${u.sessions || 0}. Выберите, что сделать:`,
        fixes: [
          { id: 'drop', title: `Удалить схему ${s.name} целиком (DROP USER CASCADE${u.sessions ? `, завершить ${u.sessions} сеанс(ов)` : ''}) и импортировать заново`, danger: true },
          { id: 'remap', title: 'Импортировать под другим именем', input: 'schema', suggestion: suggestName(s.name, t) },
          ...(isDp ? [
            { id: 'replace', title: 'Пересоздать только таблицы из дампа (TABLE_EXISTS_ACTION=REPLACE), остальные объекты оставить' },
            { id: 'truncate', title: 'Очистить таблицы из дампа и загрузить данные (TRUNCATE)' },
          ] : []),
          { id: 'append', title: isDp ? 'Добавить строки в существующие таблицы (APPEND) — возможны дубликаты' : 'Добавить строки в существующие таблицы (ignore=y) — возможны дубликаты' },
          { id: 'skip', title: 'Не импортировать эту схему' },
        ] });
    } else if (!u.exists && !s.createUser) {
      dec.action = 'create';
      dec.password = randomPassword();
      add({ id: `user:${s.name}`, schema: s.name, level: 'warning', title: `Пользователя ${s.name} нет, а в дампе нет команды его создания`,
        details: 'Экспорт делал сам владелец схемы, поэтому CREATE USER в дамп не попал. Без пользователя импорт объектов не пройдёт (ORA-01918).',
        fixes: [{ id: 'create', title: `Создать пользователя ${s.name} с квотами и правами на создание объектов`, default: true, input: 'password' }, { id: 'remap', title: 'Импортировать в другую схему', input: 'schema', suggestion: t.user }] });
    } else if (u.exists) {
      add({ id: `schema:${s.name}`, schema: s.name, level: 'info', title: `Схема ${s.name} уже есть, пустая — импорт пойдёт в неё`, details: 'Сообщение ORA-31684 «пользователь уже существует» будет безвредным.' });
    }
    d.schemas[s.name] = dec;
  }

  // --- табличные пространства
  if (c.tablespacesCreated.length && isDp) {
    d.excludeTablespaces = true;
    add({ id: 'ts-create', level: 'warning', title: `Дамп полной базы создаёт табличные пространства: ${c.tablespacesCreated.map(x => x.name).join(', ')}`,
      details: 'Пути к файлам данных взяты с сервера-источника и здесь обычно не существуют (ORA-01119). Лучше пропустить их создание — недостающие будут созданы или перенаправлены по правилам ниже.',
      fixes: [{ id: 'excludeTablespaces', title: 'Не создавать табличные пространства из дампа', default: true }] });
  }
  const existing = new Map((t.tablespaces || []).map(x => [x.name, x]));
  const needTs = [...c.tablespacesUsed, ...(d.excludeTablespaces ? c.tablespacesCreated.map(x => ({ name: x.name, temp: x.temp, schemas: [] })) : [])];
  for (const ts of needTs) {
    if (existing.has(ts.name)) continue;
    const to = ts.temp ? t.defaultTemp : t.defaultPermanent;
    d.tablespaces[ts.name] = isDp ? { action: 'remap', to, temp: !!ts.temp, sizeMb: 100 } : { action: 'create', temp: !!ts.temp, sizeMb: 100 };
    add({ id: `ts:${ts.name}`, tablespace: ts.name, level: 'warning', title: `Нет ${ts.temp ? 'временного ' : ''}табличного пространства ${ts.name}`,
      details: `Используется в схемах: ${ts.schemas.join(', ') || '—'}. Без исправления объекты не создадутся (ORA-00959).`,
      fixes: [
        ...(isDp ? [{ id: 'remap', title: `Перенаправить в существующее (REMAP_TABLESPACE)`, input: ts.temp ? 'tempTablespace' : 'tablespace', suggestion: to, default: true }] : []),
        { id: 'create', title: `Создать ${ts.name} (${t.omf ? 'файл по OMF' : `файл в ${t.datafileDir || 'папке данных'}`}, автоувеличение)`, default: !isDp },
      ] });
  }
  // место
  const free = (t.tablespaces || []).filter(x => x.contents === 'PERMANENT').reduce((s, x) => s + (x.maxMb || x.freeMb || 0), 0);
  const need = (a.totalSize || 0) / 1048576;
  if (need && free && free < need * 1.3)
    add({ id: 'space', level: 'warning', title: `Может не хватить места: дамп ${Math.round(need)} МБ, доступно с учётом автоувеличения ≈ ${Math.round(free)} МБ`,
      details: 'Индексы после импорта занимают дополнительно 20–50 %. Проверьте место на диске и AUTOEXTEND файлов данных.' + (t.edition === 'XE' ? ' В Oracle XE данные пользователя ограничены 12 ГБ.' : '') });

  // --- роли и получатели прав
  const known = new Set([...c.schemas.map(s => s.name), ...(c.rolesCreated || []), ...(t.roles || []), ...Object.keys(t.users).filter(k => t.users[k].exists), ...(t.allUsers || [])]);
  const missingRoles = [...new Set([...c.rolesUsed, ...c.grantees])].filter(r => !known.has(r));
  if (missingRoles.length) {
    add({ id: 'roles', level: 'warning', title: `Нет ролей или пользователей, которым выдаются права: ${missingRoles.slice(0, 12).join(', ')}${missingRoles.length > 12 ? '…' : ''}`,
      details: 'Иначе эти GRANT завершатся ошибкой ORA-01917 (остальной импорт продолжится).',
      fixes: [{ id: 'createRoles', title: `Создать роли: ${missingRoles.length}`, default: true }], list: missingRoles });
  } else d.createRoles = false;
  d.missingRoles = missingRoles;

  // --- внешние ссылки
  const extMissing = (c.externalRefs || []).filter(r => !(t.users[r.schema] && t.users[r.schema].exists) && !(t.allUsers || []).includes(r.schema));
  if (extMissing.length)
    add({ id: 'external', level: 'warning', title: `Ссылки на схемы, которых нет ни в дампе, ни в базе: ${extMissing.map(r => r.schema).join(', ')}`,
      details: 'Синонимы, внешние ключи, права и код, использующие эти схемы, будут с ошибками (INVALID) до импорта этих схем.', list: extMissing.flatMap(r => r.samples) });

  // --- зависимости кода (пакеты, процедуры, триггеры, представления) от объектов вне дампа
  if (a.codeDeps) {
    const cd = a.codeDeps;
    const schemasMissing = cd.missing.filter(x => x.kind === 'schema'), objMissing = cd.missing.filter(x => x.kind === 'object');
    if (cd.missing.length) {
      const users = new Set(cd.missing.flatMap(x => x.usedBy));
      add({ id: 'code-deps', level: 'warning', title: `Код ссылается на то, чего нет ни в дампе, ни в базе: ${cd.missing.length} (затронуто объектов: ${users.size})`,
        details: [
          schemasMissing.length ? `Схемы, пакеты или синонимы: ${schemasMissing.map(x => x.ref).join(', ')}.` : '',
          objMissing.length ? `Объекты в существующих схемах: ${objMissing.slice(0, 15).map(x => x.ref).join(', ')}${objMissing.length > 15 ? '…' : ''}.` : '',
          'Эти пакеты, процедуры и представления после импорта будут невалидными (ORA-04063, PLS-00201). Импортируйте недостающие схемы (их дамп) раньше этого, создайте синонимы на объекты с другими именами или поправьте код после импорта.',
        ].filter(Boolean).join(' '),
        list: cd.missing.map(x => `${x.ref} — ${x.reason}${x.examples && x.examples.length ? ` (например, ${x.examples.join(', ')})` : ''}; используется в: ${x.usedBy.slice(0, 8).join(', ')}${x.usedBy.length > 8 ? ` и ещё ${x.usedBy.length - 8}` : ''}`),
        fixes: [] });
    }
    if (cd.dblinks.length)
      add({ id: 'code-dblinks', level: 'warning', title: `Код обращается к DB links, которых нет ни в дампе, ни в базе: ${cd.dblinks.map(x => x.link).join(', ')}`,
        details: 'Объекты с такими обращениями будут невалидными, пока DB link не создан (CREATE DATABASE LINK … USING …). Если копия не должна ходить в рабочие базы — это ожидаемо.',
        list: cd.dblinks.map(x => `${x.link}: ${x.usedBy.join(', ')}`), fixes: [] });
    if (!cd.missing.length && !cd.dblinks.length && cd.checked)
      add({ id: 'code-deps', level: 'info', title: `Зависимости кода в порядке: проверено ссылок на другие схемы и объекты — ${cd.checked}`, details: 'Всё, на что ссылается код из дампа, есть в самом дампе или в базе-приёмнике.', fixes: [] });
  }

  // --- DB links, задания, каталоги
  if (c.dbLinks.length)
    add({ id: 'dblinks', level: 'warning', title: `DB links в дампе: ${c.dbLinks.map(l => l.name).join(', ')}`,
      details: 'Копия базы будет ссылаться на те же удалённые базы (возможно, рабочие). Если в коде есть запись через DB link — локальные тесты изменят чужие данные.',
      fixes: [{ id: 'excludeDbLinks', title: 'Не импортировать DB links', default: false }] });
  if (c.jobs)
    add({ id: 'jobs', level: 'warning', title: `Задания по расписанию в дампе: ${c.jobs}`,
      details: 'После импорта задания начнут выполняться сами — в копии это обычно не нужно (рассылки, выгрузки, обращения к рабочим системам).',
      fixes: [{ id: 'excludeJobs', title: 'Не импортировать задания (DBMS_JOB, DBMS_SCHEDULER)', default: true }] });
  if (c.directories.length)
    add({ id: 'dirs', level: 'info', title: `Каталоги (DIRECTORY) в дампе: ${c.directories.map(x => `${x.name} → ${x.path}`).join('; ')}`, details: 'Пути взяты с сервера-источника — проверьте их после импорта.' });
  if (t.staleJobs && t.staleJobs.length)
    add({ id: 'stale', level: 'info', title: `Остались задания Data Pump от прерванных запусков: ${t.staleJobs.map(j => j.job).join(', ')}`,
      details: 'Их мастер-таблицы занимают место и мешают повторному запуску с тем же именем.', fixes: [{ id: 'dropStaleJobs', title: 'Удалить мастер-таблицы прерванных заданий', default: true }] });
  // типы при переименовании схемы → конфликт OID
  const hasTypes = c.schemas.some(s => s.objects && s.objects.TYPE);
  if (hasTypes && isDp) d.oidTransform = true;
  return { issues, defaults: d };
}

function suggestName(name, t) {
  for (let i = 0; i < 100; i++) {
    const n = i ? `${name}_IMP${i + 1}` : `${name}_IMP`;
    if (!(t.users[n] && t.users[n].exists) && !(t.allUsers || []).includes(n)) return n.slice(0, 128);
  }
  return `${name}_IMP`;
}

/** Есть ли нерешённые блокирующие проблемы при этих решениях. */
function unresolved(an, d) {
  const out = [];
  for (const i of an.issues) {
    if (i.blocking && !(i.id === 'file' && d.copy !== false && i.fixes.length) && !(i.id === 'password' && d.password)) out.push(i.title);
    if (i.needsDecision) {
      const s = d.schemas[i.schema];
      if (!s || !s.action || s.action === 'none') out.push(`${i.title} — выберите действие`);
      if (s && s.action === 'remap' && !s.target) out.push(`${i.schema}: укажите новое имя схемы`);
    }
  }
  return out;
}

/**
 * Построение плана по анализу (a), его проблемам (an) и решениям (d).
 * → { blocking:[], pre:[{title,sql,danger}], jobs:[…Data Pump…] | imp:{…}, between:[], post:[], targetSchemas:[] }
 */
function buildPlan(a, an, d) {
  const t = a.target, c = a.contents, isDp = a.format === 'datapump';
  const sep = t.sep || (/^[A-Za-z]:\\|\\/.test(t.datafileDir || '') ? '\\' : '/');
  const blocking = unresolved(an, d);
  const pre = [], post = [], between = [];
  const selected = (d.selected && d.selected.length ? d.selected : c.schemas.map(s => s.name)).filter(n => (d.schemas[n] || {}).action !== 'skip');
  const tgtName = n => { const s = d.schemas[n] || {}; return s.action === 'remap' && s.target ? s.target.toUpperCase() : n; };
  const tsMap = n => { const x = d.tablespaces[n]; return x && x.action === 'remap' && x.to ? x.to : n; };

  if (d.dropStaleJobs) for (const j of t.staleJobs || []) pre.push({ title: `Удалить мастер-таблицу прерванного задания ${j.owner}.${j.job}`, sql: `DROP TABLE ${q(j.owner)}.${q(j.job)} PURGE` });
  // табличные пространства
  for (const [name, x] of Object.entries(d.tablespaces)) {
    if (x.action !== 'create') continue;
    const file = t.omf ? '' : ` ${lit(`${(t.datafileDir || '').replace(/[\\/]$/, '')}${sep}${name.toLowerCase()}01.dbf`)}`;
    pre.push({ title: `Создать ${x.temp ? 'временное ' : ''}табличное пространство ${name}`,
      sql: x.temp ? `CREATE TEMPORARY TABLESPACE ${q(name)} TEMPFILE${file} SIZE ${x.sizeMb || 100}M AUTOEXTEND ON NEXT 100M MAXSIZE UNLIMITED`
        : `CREATE TABLESPACE ${q(name)} DATAFILE${file} SIZE ${x.sizeMb || 100}M AUTOEXTEND ON NEXT 100M MAXSIZE UNLIMITED` });
  }
  // схемы
  for (const n of selected) {
    const s = d.schemas[n] || {}, tn = tgtName(n), info = c.schemas.find(x => x.name === n) || { tablespaces: [], createUser: false };
    if (s.action === 'drop') {
      const u = t.users[n] || {};
      if (u.sessions) pre.push({ title: `Завершить сеансы пользователя ${n}: ${u.sessions}`, danger: true,
        sql: `BEGIN\n  FOR s IN (SELECT sid, serial# AS ser FROM v$session WHERE username = ${lit(n)}) LOOP\n    EXECUTE IMMEDIATE 'ALTER SYSTEM KILL SESSION ''' || s.sid || ',' || s.ser || ''' IMMEDIATE';\n  END LOOP;\nEND;` });
      pre.push({ title: `Удалить схему ${n} со всеми объектами (${u.total || 0})`, danger: true, sql: `DROP USER ${q(n)} CASCADE` });
    }
    const existsAfter = !!(t.users[tn] && t.users[tn].exists) && s.action !== 'drop';
    // Data Pump создаёт пользователя из дампа (и под новым именем); imp с touser — нет
    const dumpCreates = info.createUser && (isDp || tn === n);
    const needCreate = !existsAfter && !dumpCreates;
    if (needCreate) {
      const pwd = s.password || randomPassword();
      s.password = pwd;
      const dts = tsMap(info.defaultTablespace || '') || t.defaultPermanent;
      const usable = new Set([...(info.tablespaces || []).map(tsMap), dts].filter(x => x && !(d.tablespaces[x] && d.tablespaces[x].temp)));
      const temps = new Set([...(info.tablespaces || [])].filter(x => (d.tablespaces[x] || {}).temp || x === info.tempTablespace));
      for (const tt of temps) usable.delete(tsMap(tt));
      pre.push({ title: `Создать пользователя ${tn}`, sql: `CREATE USER ${q(tn)} IDENTIFIED BY ${q(pwd)} DEFAULT TABLESPACE ${q(dts || 'USERS')}${t.defaultTemp ? ` TEMPORARY TABLESPACE ${q(info.tempTablespace ? tsMap(info.tempTablespace) : t.defaultTemp)}` : ''}`, secret: pwd });
      for (const ts of usable) if (ts) pre.push({ title: `Квота ${tn} на ${ts}`, sql: `ALTER USER ${q(tn)} QUOTA UNLIMITED ON ${q(ts)}` });
      pre.push({ title: `Права ${tn} на создание объектов`, sql: `GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, CREATE SEQUENCE, CREATE PROCEDURE, CREATE TRIGGER, CREATE SYNONYM, CREATE TYPE, CREATE MATERIALIZED VIEW, CREATE JOB TO ${q(tn)}` });
    }
  }
  // роли
  if (d.createRoles) for (const r of an.defaults.missingRoles || []) pre.push({ title: `Создать роль ${r}`, sql: `CREATE ROLE ${q(r)}` });

  // перекомпиляция и проверка
  const targetSchemas = selected.map(tgtName);
  if (d.recompile) for (const s of targetSchemas) post.push({ title: `Перекомпилировать ${s}`, sql: `BEGIN DBMS_UTILITY.COMPILE_SCHEMA(${lit(s)}, FALSE); END;` });

  if (!isDp) {
    // imp: fromuser/touser, ignore=y если таблицы уже есть
    const pairs = selected.map(n => [n, tgtName(n)]);
    // ignore=y: пользователи создаются заранее, «уже существует» не должно останавливать импорт
    return { blocking, pre, between, post, targetSchemas, imp: { fromuser: pairs.map(p => p[0]), touser: pairs.map(p => p[1]), ignore: true } };
  }

  // Data Pump: задания группируются по TABLE_EXISTS_ACTION
  const teaOf = n => ({ replace: 'REPLACE', truncate: 'TRUNCATE', append: 'APPEND' }[(d.schemas[n] || {}).action] || 'SKIP');
  const groups = new Map();
  for (const n of selected) { const k = teaOf(n); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n); }
  const excl = [];
  if (d.excludeDbLinks) excl.push('DB_LINK');
  if (d.excludeJobs) excl.push('JOB', 'PROCOBJ');
  if (d.excludeTablespaces) excl.push('TABLESPACE');
  const remapTs = Object.entries(d.tablespaces).filter(([, x]) => x.action === 'remap' && x.to).map(([k, x]) => [k, x.to]);
  const allSchemas = c.schemas.map(s => s.name);
  const jobs = [];
  for (const [tea, names] of groups) {
    const common = {
      schemas: names, schemaExpr: names.length === allSchemas.length && a.header && a.header.mode !== 'FULL' ? null : `IN (${names.map(lit).join(',')})`,
      remapSchema: names.filter(n => tgtName(n) !== n).map(n => [n, tgtName(n)]), remapTablespace: remapTs,
      tableExistsAction: tea, exclude: [...excl], oid: d.oidTransform && names.some(n => tgtName(n) !== n), password: d.password || null, parallel: d.parallel || 1,
    };
    // два этапа — только для схем, где таблиц ещё нет (новые, удалённые, переименованные в новые)
    const fresh = names.filter(n => { const s = d.schemas[n] || {}; const tn = tgtName(n); return s.action === 'drop' || s.action === 'create' || !(t.users[tn] && t.users[tn].exists && t.users[tn].total); });
    const cols = d.byteToChar && tea === 'SKIP' ? c.byteColumns.filter(x => fresh.includes(x.owner)) : [];
    if (cols.length) {
      jobs.push({ ...common, title: `Этап 1: структура таблиц (${names.join(', ')})`, metadataOnly: true, exclude: [...excl, 'INDEX', 'CONSTRAINT', 'REF_CONSTRAINT', 'TRIGGER', 'STATISTICS'] });
      jobs.push({ between: cols.map(x => ({ title: `${tgtName(x.owner)}.${x.table}.${x.column}`, sql: `ALTER TABLE ${q(tgtName(x.owner))}.${q(x.table)} MODIFY (${q(x.column)} ${x.type}(${Math.min(x.length, x.type === 'CHAR' ? 2000 : 4000)} CHAR))` })), title: `Перевод колонок в CHAR: ${cols.length}` });
      jobs.push({ ...common, title: `Этап 2: данные и остальные объекты (${names.join(', ')})`, tableExistsAction: 'APPEND' });
    } else jobs.push({ ...common, title: `Импорт: ${names.join(', ')}${tea !== 'SKIP' ? ` (TABLE_EXISTS_ACTION=${tea})` : ''}` });
  }
  return { blocking, pre, between, post, targetSchemas, jobs };
}

/** PL/SQL для одного задания Data Pump (IMPORT или SQL_FILE) с выводом журнала через DBMS_OUTPUT. */
function dpBlock({ operation = 'IMPORT', jobName, dir, files, logFile, sqlFile, workDir, job = {} }) {
  const L = [];
  L.push(`h := DBMS_DATAPUMP.OPEN(operation => '${operation}', job_mode => '${job.jobMode || 'FULL'}', remote_link => ${job.remoteLink ? lit(job.remoteLink) : 'NULL'}, job_name => ${lit(jobName)});`);
  for (const f of files || []) L.push(`DBMS_DATAPUMP.ADD_FILE(h, ${lit(f)}, ${lit(dir)});`);
  // журнал и SQL-файл пишутся в рабочий каталог (DATA_PUMP_DIR): папка с дампом может быть доступна только на чтение
  if (logFile) L.push(`DBMS_DATAPUMP.ADD_FILE(h, ${lit(logFile)}, ${lit(workDir || dir)}, NULL, DBMS_DATAPUMP.KU$_FILE_TYPE_LOG_FILE);`);
  if (sqlFile) L.push(`DBMS_DATAPUMP.ADD_FILE(h, ${lit(sqlFile)}, ${lit(workDir || dir)}, NULL, DBMS_DATAPUMP.KU$_FILE_TYPE_SQL_FILE);`);
  if (job.password) L.push(`DBMS_DATAPUMP.SET_PARAMETER(h, 'ENCRYPTION_PASSWORD', ${lit(job.password)});`);
  if (job.schemaExpr) L.push(`DBMS_DATAPUMP.METADATA_FILTER(h, 'SCHEMA_EXPR', ${lit(job.schemaExpr)});`);
  if (job.tablesExpr) L.push(`DBMS_DATAPUMP.METADATA_FILTER(h, 'NAME_EXPR', ${lit(job.tablesExpr)}, 'TABLE');`);
  if (job.exclude && job.exclude.length) L.push(`DBMS_DATAPUMP.METADATA_FILTER(h, 'EXCLUDE_PATH_EXPR', ${lit(`IN (${job.exclude.map(lit).join(',')})`)});`);
  for (const [a, b] of job.remapSchema || []) L.push(`DBMS_DATAPUMP.METADATA_REMAP(h, 'REMAP_SCHEMA', ${lit(a)}, ${lit(b)});`);
  for (const [a, b] of job.remapTablespace || []) L.push(`DBMS_DATAPUMP.METADATA_REMAP(h, 'REMAP_TABLESPACE', ${lit(a)}, ${lit(b)});`);
  if (job.oid) L.push(`DBMS_DATAPUMP.METADATA_TRANSFORM(h, 'OID', 0);`);
  if (operation === 'IMPORT') L.push(`DBMS_DATAPUMP.SET_PARAMETER(h, 'TABLE_EXISTS_ACTION', ${lit(job.tableExistsAction || 'SKIP')});`);
  if (job.metadataOnly) L.push(`DBMS_DATAPUMP.DATA_FILTER(h, 'INCLUDE_ROWS', 0);`);
  if ((job.parallel || 1) > 1) L.push(`DBMS_DATAPUMP.SET_PARALLEL(h, ${Number(job.parallel)});`);
  return `
DECLARE
  h NUMBER;
  job_state VARCHAR2(30) := 'UNDEFINED';
  sts ku$_Status;
  le ku$_LogEntry;
  ind NUMBER;
BEGIN
  ${L.join('\n  ')}
  DBMS_DATAPUMP.START_JOB(h);
  WHILE job_state NOT IN ('COMPLETED', 'STOPPED') LOOP
    DBMS_DATAPUMP.GET_STATUS(h, DBMS_DATAPUMP.KU$_STATUS_JOB_ERROR + DBMS_DATAPUMP.KU$_STATUS_JOB_STATUS + DBMS_DATAPUMP.KU$_STATUS_WIP, -1, job_state, sts);
    IF BITAND(sts.mask, DBMS_DATAPUMP.KU$_STATUS_WIP) != 0 THEN le := sts.wip;
    ELSIF BITAND(sts.mask, DBMS_DATAPUMP.KU$_STATUS_JOB_ERROR) != 0 THEN le := sts.error;
    ELSE le := NULL; END IF;
    IF le IS NOT NULL THEN
      ind := le.FIRST;
      WHILE ind IS NOT NULL LOOP DBMS_OUTPUT.PUT_LINE(le(ind).LogText); ind := le.NEXT(ind); END LOOP;
    END IF;
  END LOOP;
  DBMS_DATAPUMP.DETACH(h);
  :final := job_state;
EXCEPTION WHEN OTHERS THEN
  DECLARE msg VARCHAR2(4000) := SQLERRM; BEGIN
    IF h IS NOT NULL THEN BEGIN
      DBMS_DATAPUMP.GET_STATUS(h, DBMS_DATAPUMP.KU$_STATUS_JOB_ERROR, 0, job_state, sts);
      IF BITAND(sts.mask, DBMS_DATAPUMP.KU$_STATUS_JOB_ERROR) != 0 THEN
        le := sts.error; ind := le.FIRST;
        WHILE ind IS NOT NULL LOOP DBMS_OUTPUT.PUT_LINE(le(ind).LogText); ind := le.NEXT(ind); END LOOP;
      END IF;
      DBMS_DATAPUMP.STOP_JOB(h, 1, 0);
    EXCEPTION WHEN OTHERS THEN NULL; END; END IF;
    RAISE_APPLICATION_ERROR(-20001, msg);
  END;
END;`;
}

/** Командная строка impdp для справки / ручного запуска. */
function impdpCommand(t, dir, files, job) {
  const parts = [`impdp ${t.user}@<база> directory=${dir} dumpfile=${files.join(',')} logfile=imp_${Date.now()}.log`];
  if (job.schemaExpr) parts.push(`schemas=${job.schemas.join(',')}`);
  for (const [a, b] of job.remapSchema || []) parts.push(`remap_schema=${a}:${b}`);
  for (const [a, b] of job.remapTablespace || []) parts.push(`remap_tablespace=${a}:${b}`);
  if (job.exclude && job.exclude.length) parts.push(`exclude=${job.exclude.join(',')}`);
  if (job.oid) parts.push('transform=OID:N');
  parts.push(`table_exists_action=${job.tableExistsAction || 'SKIP'}`);
  if (job.metadataOnly) parts.push('content=METADATA_ONLY');
  return parts.join(' ');
}

module.exports = { analyzeIssues, buildPlan, unresolved, dpBlock, impdpCommand, suggestName, verNum };
