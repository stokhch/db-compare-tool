'use strict';
// Разбор ошибок завершённой задачи (любого типа): журнал → группы ошибок с объяснением,
// и — где возможно — исправления параметров для повторного запуска «одной кнопкой».
const { CODES } = require('../dump/errors');
const { hintFor } = require('./errhint');

// Текстовые ошибки PostgreSQL, pg_dump/pg_restore, ora2pg и драйверов
const RULES = [
  { id: 'dup', re: /duplicate key value violates unique constraint|ORA-00001/i, title: 'Повтор значения ключа', hint: 'В таблице приёмника уже есть такие строки. Очистите таблицы перед загрузкой или пропустите непустые.' },
  { id: 'toolong', re: /value too long for type|ORA-12899/i, title: 'Значение не помещается в колонку', hint: 'Колонка в приёмнике короче, чем данные (или другая кодировка). Расширьте колонку.' },
  { id: 'overflow', re: /numeric field overflow|ORA-01438|out of range for type (integer|smallint|bigint)/i, title: 'Число не помещается в тип колонки', hint: 'Увеличьте точность колонки (numeric(p,s) / NUMBER(p,s)) или тип (integer → bigint).' },
  { id: 'notnull', re: /null value in column .* violates not-null|ORA-01400/i, title: 'NULL в колонке NOT NULL', hint: 'В источнике есть пустые значения. При переносе PostgreSQL → Oracle пустые строки становятся NULL. Снимите NOT NULL или заполните значения.' },
  { id: 'fk', re: /violates foreign key constraint|ORA-02291|ORA-02292/i, title: 'Нарушение внешнего ключа', hint: 'Дочерние строки загружены раньше родительских или родительская таблица не выбрана. Отключите внешние ключи на время загрузки или добавьте родительские таблицы.' },
  { id: 'nul', re: /invalid byte sequence for encoding "UTF8": 0x00|unsupported Unicode escape sequence/i, title: 'Символ \\0 в тексте', hint: 'PostgreSQL не хранит символ с кодом 0. Перелив удаляет его автоматически; в ora2pg используйте REPLACE_QUERY или очистку в источнике.' },
  { id: 'encoding', re: /invalid byte sequence for encoding|has no equivalent in encoding|character with byte sequence/i, title: 'Ошибка кодировки', hint: 'Данные в источнике не соответствуют объявленной кодировке (например, кириллица в US7ASCII) или в кодировке приёмника нет символа. Нужна база-приёмник в UTF8; для неверно объявленной кодировки источника — NLS_LANG с фактической кодировкой.' },
  { id: 'datetime', re: /date\/time field value out of range|ORA-01841|ORA-01861|invalid input syntax for type (date|timestamp)/i, title: 'Недопустимая дата', hint: 'В источнике есть даты, которых не бывает (год 0, 30 февраля) или формат не распознан. Найдите их «Профилем данных» и исправьте или отфильтруйте.' },
  { id: 'syntax', re: /invalid input syntax for type (integer|numeric|bigint|boolean)|ORA-01722/i, title: 'Значение не преобразуется в число', hint: 'В текстовой колонке источника есть нечисловые значения, а в приёмнике колонка числовая.' },
  { id: 'perm', re: /permission denied|must be owner of|ORA-01031|ORA-01950/i, title: 'Недостаточно прав', hint: 'Выдайте права пользователю подключения (GRANT) или подключитесь владельцем объектов.' },
  { id: 'norel', re: /relation ".*" does not exist|ORA-00942/i, title: 'Таблица не найдена', hint: 'В приёмнике нет таблицы — создайте структуру перед загрузкой данных.' },
  { id: 'nocol', re: /column ".*" (of relation ".*" )?does not exist|ORA-00904/i, title: 'Колонка не найдена', hint: 'Структуры источника и приёмника различаются — выполните «Сравнение схем» и синхронизацию структуры.' },
  { id: 'exists', re: /already exists|ORA-00955/i, title: 'Объект уже существует', hint: 'Объект создан раньше. Для pg_restore — режим --clean; для повторного запуска — удалите объект или пропустите.' },
  { id: 'role', re: /role ".*" does not exist/i, title: 'Нет роли', hint: 'Восстанавливайте без владельцев и прав (--no-owner --no-privileges) или создайте роли.' },
  { id: 'dbinuse', re: /is being accessed by other users|cannot drop the currently open database/i, title: 'К базе подключены другие сеансы', hint: 'Завершите подключения к базе перед удалением/очисткой.' },
  { id: 'nodb', re: /database ".*" does not exist/i, title: 'Нет базы', hint: 'Создайте базу перед восстановлением.' },
  { id: 'ext', re: /could not open extension control file|extension ".*" is not available|extension ".*" does not exist/i, title: 'Нет расширения PostgreSQL', hint: 'Установите пакет расширения на сервер-приёмник (postgresql-contrib, postgis…), затем повторите.' },
  { id: 'extsuper', re: /permission denied to create extension|must be superuser to create/i, title: 'Расширение может создать только суперпользователь', hint: 'Создайте расширение заранее от суперпользователя (CREATE EXTENSION …).' },
  { id: 'tablespace', re: /tablespace ".*" does not exist|ORA-00959/i, title: 'Нет табличного пространства', hint: 'Восстанавливайте без табличных пространств (--no-tablespaces) или создайте/перенаправьте их.' },
  { id: 'pgver', re: /server version mismatch|aborting because of server version mismatch/i, title: 'pg_dump старше сервера', hint: 'Нужен клиент PostgreSQL той же или более новой версии, чем сервер (Настройки → папка bin).' },
  { id: 'filever', re: /unsupported version \([\d.]+\) in file header/i, title: 'pg_restore старше файла дампа', hint: 'Восстановите более новой версией pg_restore.' },
  { id: 'space', re: /No space left on device|could not extend file|ORA-0165[234]|ORA-01688|ORA-01691/i, title: 'Не хватает места на диске', hint: 'Освободите место или включите автоувеличение файлов данных.' },
  { id: 'deadlock', re: /deadlock detected|ORA-00060/i, title: 'Взаимная блокировка', hint: 'Параллельные потоки мешают друг другу (общие внешние ключи). Уменьшите число потоков.' },
  { id: 'locked', re: /ORA-00054|could not obtain lock|lock timeout/i, title: 'Таблица заблокирована другим сеансом', hint: 'Кто-то работает с таблицей. Повторите позже или завершите мешающий сеанс.' },
  { id: 'timeout', re: /statement timeout|canceling statement due to|ETIMEDOUT|NJS-040|connection terminated unexpectedly|ECONNRESET|ORA-03113|ORA-03135/i, title: 'Обрыв соединения или тайм-аут', hint: 'Длинная операция прервана сетью или ограничением времени. Повторите с продолжением — уже загруженные таблицы будут пропущены.' },
  { id: 'snapshot', re: /ORA-01555/i, title: 'Слишком старый снимок (ORA-01555)', hint: 'Чтение большой таблицы длилось дольше, чем хранится UNDO в источнике. Увеличьте UNDO_RETENTION или переносите таблицу частями.' },
  { id: 'dbd', re: /Can't locate DBD\/(Oracle|Pg)\.pm|install_driver\((Oracle|Pg)\) failed/i, title: 'Нет драйвера Perl для ora2pg', hint: 'Установите DBD::Oracle / DBD::Pg или используйте комплект plsql2pg (Настройки).' },
  { id: 'oci', re: /libclntsh|OCI\.DLL|oci\.dll|DPI-1047|NJS-045/i, title: 'Не найден Oracle Client', hint: 'Установите Oracle Instant Client и укажите его папку (Настройки), для ora2pg — добавьте папку в PATH.' },
];

// Исправления параметров для повторного запуска: тип задачи → id ошибки → patch (или функция от задачи)
const FIXES = {
  transfer: {
    dup: { title: 'Очистить таблицы перед загрузкой (TRUNCATE)', patch: { mode: 'truncate' }, danger: true },
    fk: { title: 'Отключить внешние ключи на время загрузки', patch: { disableFk: true } },
    deadlock: { title: 'Загружать по одной таблице', patch: { parallel: 1 } },
    norel: { title: 'Создавать отсутствующие таблицы', patch: { createTables: true } },
    timeout: { title: 'Продолжить: пропустить уже загруженные таблицы', patch: job => ({ skipTables: doneTables(job) }) },
    toolong: { title: 'Пропустить уже загруженные таблицы (колонки расширит повторная проверка)', patch: job => ({ skipTables: doneTables(job) }), recheck: true },
    overflow: { title: 'Пропустить уже загруженные таблицы (колонки расширит повторная проверка)', patch: job => ({ skipTables: doneTables(job) }), recheck: true },
  },
  pipeline: {
    timeout: { title: 'Продолжить с места остановки', patch: job => ({ resumeJobId: job.id }) },
    deadlock: { title: 'Загружать по одной таблице и продолжить', patch: job => ({ parallel: 1, resumeJobId: job.id }) },
    fk: { title: 'Продолжить с места остановки', patch: job => ({ resumeJobId: job.id }) },
    toolong: { title: 'Продолжить (колонки расширит повторная проверка)', patch: job => ({ resumeJobId: job.id }), recheck: true },
    overflow: { title: 'Продолжить (колонки расширит повторная проверка)', patch: job => ({ resumeJobId: job.id }), recheck: true },
    dup: { title: 'Продолжить с места остановки', patch: job => ({ resumeJobId: job.id }) },
  },
  pgdump: {
    role: { title: 'Без владельцев и прав (--no-owner --no-privileges)', patch: { noOwner: true, noPrivileges: true } },
    exists: { title: 'Удалять объекты перед восстановлением (--clean --if-exists)', patch: { clean: true }, danger: true },
    dbinuse: { title: 'Завершать подключения к базе', patch: { terminateConnections: true } },
    nodb: { title: 'Создать базу', patch: { createDatabase: true } },
    tablespace: { title: 'Без табличных пространств (--no-tablespaces)', patch: { noTablespaces: true } },
    deadlock: { title: 'Восстанавливать в один поток', patch: { jobs: 1 } },
  },
  datapump: {
    'ORA-01917': { title: 'Повторить с проверкой (создаст недостающие роли)', patch: {}, recheck: true },
    'ORA-00959': { title: 'Повторить с проверкой (перенаправит табличные пространства)', patch: {}, recheck: true },
    'ORA-12899': { title: 'Импорт в два этапа с переводом колонок в CHAR', patch: { byteToChar: true, tableExistsAction: 'TRUNCATE' } },
    'ORA-39151': { title: 'Пересоздать существующие таблицы (REPLACE)', patch: { tableExistsAction: 'REPLACE' }, danger: true },
    'ORA-04052': { title: 'Не переносить DB links', patch: { excludeDbLinks: true } },
    'ORA-02019': { title: 'Не переносить DB links', patch: { excludeDbLinks: true } },
  },
  ora2pg: {
    dup: { title: 'Очищать таблицы перед загрузкой (TRUNCATE_TABLE)', patch: { truncateTable: true }, danger: true },
    dbd: { title: 'Повторить с проверкой окружения', patch: {}, recheck: true },
  },
  delta: {
    dup: { title: 'Повторить (догрузка использует вставку с обновлением)', patch: {} },
  },
};
const doneTables = job => ((job.result && job.result.tables) || []).filter(t => t.status === 'done' || t.status === 'skipped').map(t => t.table);

function diagnoseJob(job) {
  const lines = [], strong = new Set();
  if (job.error) { lines.push(String(job.error)); strong.add(String(job.error)); }
  for (const l of job.log || []) {
    // вывод внешних утилит пишется в журнал как info — ошибки распознаются по тексту
    const tool = /^(pg_restore|pg_dump|psql|pg_dumpall)(\[\d+\])?: (error|ошибка|ОШИБКА)|^\s*(ERROR|FATAL|ОШИБКА):|DBD::\w+::\w+ failed|^FATAL|Can't locate|ORA-\d{5}/.test(l.msg);
    if (l.level === 'error' || l.level === 'warning' || tool) { lines.push(l.msg); if (l.level === 'error' || tool) strong.add(l.msg); }
  }
  const logged = (job.log || []).map(l => l.msg).join('\n');
  if (job.result && Array.isArray(job.result.tables)) for (const t of job.result.tables) if (t.error && t.status === 'error' && !logged.includes(t.error)) { const x = `${t.table}: ${t.error}`; lines.push(x); strong.add(x); }
  const groups = new Map();
  const add = (key, info, line) => {
    if (!groups.has(key)) groups.set(key, { id: key, ...info, count: 0, samples: [] });
    const g = groups.get(key); g.count++; if (g.samples.length < 5) g.samples.push(line.slice(0, 400));
  };
  for (const line of lines) {
    const rule = RULES.find(r => r.re.test(line));
    if (rule) { add(rule.id, { title: rule.title, hint: rule.hint }, line); continue; }
    const ora = /\b(ORA|IMP)-\d{5}\b/.exec(line);
    if (ora && CODES[ora[0]] && !CODES[ora[0]].benign) { add(ora[0], { title: CODES[ora[0]].title, hint: CODES[ora[0]].hint }, line); continue; }
    if (ora && CODES[ora[0]] && CODES[ora[0]].benign) continue;
    if (!strong.has(line)) continue;            // предупреждения — только если распознаны
    const h = hintFor({ message: line });
    if (h) { add(`hint:${h.slice(0, 40)}`, { title: 'Подключение / права', hint: h }, line); continue; }
    add('other', { title: 'Прочие ошибки', hint: '' }, line);
  }
  // ошибки datapump с вложенными кодами
  if (job.result && Array.isArray(job.result.errors)) for (const e of job.result.errors) if (!e.benign && !groups.has(e.code)) groups.set(e.code, { id: e.code, title: e.title, hint: e.hint, count: e.count, samples: e.samples || [] });
  const fx = FIXES[job.type] || {};
  const list = [...groups.values()].sort((a, b) => b.count - a.count);
  const fixes = [];
  for (const g of list) {
    const f = fx[g.id];
    if (!f) continue;
    g.fix = g.id;
    if (!fixes.some(x => x.id === g.id)) fixes.push({ id: g.id, title: f.title, danger: !!f.danger, recheck: !!f.recheck, patch: typeof f.patch === 'function' ? f.patch(job) : f.patch });
  }
  const failed = job.status === 'error' || list.some(g => g.id !== 'other');
  return { failed, groups: list, fixes };
}

/** Параметры повторного запуска: параметры задачи + выбранные исправления. */
function retryParams(job, fixIds) {
  const { deepMerge } = require('../preflight/common');
  const d = diagnoseJob(job);
  let params = JSON.parse(JSON.stringify(job.params || {}));
  for (const k of Object.keys(params)) if (params[k] === '***') delete params[k];
  // повторный запуск не должен повторять «Подготовку» (удаление схем и т.п.) — её пересчитает проверка
  delete params.preSql; delete params.postSql;
  for (const f of d.fixes) if (!fixIds || fixIds.includes(f.id)) params = deepMerge(params, f.patch);
  return { params, recheck: d.fixes.some(f => (!fixIds || fixIds.includes(f.id)) && f.recheck) };
}

module.exports = { diagnoseJob, retryParams, RULES };
