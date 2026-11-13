'use strict';
// Разбор журнала импорта (Data Pump и imp): ошибки группируются по коду, к каждой — объяснение
// и исправление, которое приложение может применить при повторном запуске (fix → решение в плане).

const CODES = {
  'ORA-31684': { benign: true, title: 'Объект уже существует', hint: 'Обычно безвредно: объект создан раньше (повторный запуск, второй этап импорта или существующая схема).' },
  'ORA-39151': { title: 'Таблица уже существует и пропущена (TABLE_EXISTS_ACTION=SKIP)', hint: 'Данные в эти таблицы не загружены. Удалите схему перед импортом или выберите REPLACE / TRUNCATE.', fix: 'tableExists' },
  'ORA-39152': { benign: true, title: 'Таблица существует, данные добавлены (APPEND)', hint: 'Возможны дубликаты, если таблица не была пустой.' },
  'ORA-39153': { benign: true, title: 'Таблица существует, очищена и загружена (TRUNCATE)', hint: '' },
  'ORA-39082': { title: 'Объект создан с ошибками компиляции', hint: 'Чаще всего из-за порядка создания — после импорта приложение перекомпилирует схему. Если ошибки останутся — см. «Невалидные объекты».', fix: 'recompile' },
  'ORA-00959': { title: 'Нет табличного пространства', hint: 'Создайте табличное пространство или перенаправьте объекты в существующее (REMAP_TABLESPACE).', fix: 'tablespaces' },
  'ORA-01917': { title: 'Нет пользователя или роли, которым выдаются права', hint: 'Создайте недостающие роли или не обращайте внимания — не будут выданы только эти права.', fix: 'createRoles' },
  'ORA-01918': { title: 'Пользователь не существует', hint: 'В дампе нет CREATE USER (экспорт делал сам владелец схемы). Создайте пользователя перед импортом.', fix: 'createUser' },
  'ORA-01435': { title: 'Пользователь не существует', hint: 'Создайте пользователя перед импортом или укажите другую схему (touser).', fix: 'createUser' },
  'ORA-12899': { title: 'Значение слишком длинное для колонки', hint: 'Кодировки баз разные (например, CL8MSWIN1251 → AL32UTF8): кириллица занимает 2 байта, и VARCHAR2(n BYTE) не вмещает строки. Импорт в два этапа с переводом колонок в CHAR решает это.', fix: 'byteToChar' },
  'ORA-02374': { title: 'Ошибка преобразования при загрузке таблицы', hint: 'Обычно из-за кодировки — см. ORA-12899.', fix: 'byteToChar' },
  'ORA-31693': { title: 'Данные таблицы не загружены', hint: 'Причина — во вложенной ошибке.' },
  'ORA-39083': { title: 'Объект не создан', hint: 'Причина — во вложенной ошибке.' },
  'ORA-39112': { benign: true, title: 'Зависимый объект пропущен, потому что не создан основной', hint: 'Следствие другой ошибки — исправьте её.' },
  'ORA-02291': { title: 'Нет родительской записи для внешнего ключа', hint: 'В дампе данные несогласованы (экспорт без CONSISTENT/FLASHBACK_TIME) или часть таблиц не загрузилась.' },
  'ORA-02298': { title: 'Внешний ключ не включён: нет родительских записей', hint: 'Данные не согласованы. Включите ограничение с NOVALIDATE или догрузите родительские таблицы.' },
  'ORA-00001': { title: 'Нарушение уникальности', hint: 'Данные добавлены в непустую таблицу (APPEND/ignore=y). Очистите таблицы или удалите схему перед импортом.', fix: 'tableExists' },
  'ORA-01031': { title: 'Недостаточно прав', hint: 'Нужна роль DATAPUMP_IMP_FULL_DATABASE (или DBA): GRANT DATAPUMP_IMP_FULL_DATABASE TO <пользователь>; — выполнить от SYS.', fix: 'privileges' },
  'ORA-01950': { title: 'Нет квоты на табличное пространство', hint: 'ALTER USER … QUOTA UNLIMITED ON …', fix: 'quota' },
  'ORA-01536': { title: 'Квота на табличное пространство исчерпана', hint: 'ALTER USER … QUOTA UNLIMITED ON …', fix: 'quota' },
  'ORA-01652': { title: 'Не хватает места во временном табличном пространстве', hint: 'Добавьте TEMP-файл или включите AUTOEXTEND.', fix: 'space' },
  'ORA-01653': { title: 'Не хватает места для таблицы', hint: 'Добавьте файл данных или включите AUTOEXTEND (и проверьте место на диске).', fix: 'space' },
  'ORA-01654': { title: 'Не хватает места для индекса', hint: 'Добавьте файл данных или включите AUTOEXTEND.', fix: 'space' },
  'ORA-01688': { title: 'Не хватает места для секции', hint: 'Добавьте файл данных или включите AUTOEXTEND.', fix: 'space' },
  'ORA-01691': { title: 'Не хватает места для LOB', hint: 'Добавьте файл данных или включите AUTOEXTEND.', fix: 'space' },
  'ORA-12953': { title: 'Превышен лимит размера базы (Express Edition — 12 ГБ данных)', hint: 'Oracle XE ограничен 12 ГБ (Free 23ai — 12 ГБ). Импортируйте часть схем/таблиц или используйте другую редакцию.' },
  'ORA-30036': { title: 'Не хватает места в UNDO', hint: 'Увеличьте табличное пространство UNDO.', fix: 'space' },
  'ORA-04052': { title: 'Ошибка при обращении через DB link', hint: 'Объект ссылается на удалённую базу. Пока ссылка не работает, объект будет INVALID. Можно не импортировать DB links.', fix: 'excludeDbLinks' },
  'ORA-02019': { title: 'Описание подключения DB link не найдено', hint: 'Нет записи в tnsnames.ora на этом сервере. Пересоздайте DB link с полным описанием подключения или не импортируйте его.', fix: 'excludeDbLinks' },
  'ORA-12154': { title: 'Не найден сервис для DB link', hint: 'См. ORA-02019.', fix: 'excludeDbLinks' },
  'ORA-00942': { title: 'Таблица или представление не существует', hint: 'Объект ссылается на схему, которой нет в дампе. Импортируйте и её или создайте недостающие объекты.' },
  'ORA-39143': { title: 'Это дамп старого формата exp', hint: 'Нужна утилита imp, а не Data Pump — приложение переключится на imp.', fix: 'useImp' },
  'ORA-39142': { title: 'Несовместимая версия дампа', hint: 'Дамп сделан более новой версией Oracle. Сделайте экспорт с параметром VERSION=<версия приёмника> (например, expdp … VERSION=19).' },
  'ORA-39174': { title: 'Нужен пароль шифрования', hint: 'Дамп зашифрован (ENCRYPTION_PASSWORD). Укажите пароль.', fix: 'password' },
  'ORA-39176': { title: 'Неверный пароль шифрования', hint: 'Проверьте пароль.', fix: 'password' },
  'ORA-31640': { title: 'Не удаётся открыть файл дампа', hint: 'Сервер базы не видит файл: другой компьютер/контейнер или нет прав у службы Oracle на папку. Скопируйте файл через соединение.', fix: 'copy' },
  'ORA-27037': { title: 'Не удаётся получить сведения о файле', hint: 'Файла нет по этому пути на сервере базы — скопируйте файл через соединение.', fix: 'copy' },
  'ORA-29283': { title: 'Недопустимая операция с файлом', hint: 'У службы Oracle нет прав на папку. Скопируйте файл через соединение в DATA_PUMP_DIR.', fix: 'copy' },
  'ORA-39087': { title: 'Неверное имя каталога (DIRECTORY)', hint: 'Каталога нет или нет прав READ/WRITE на него.', fix: 'copy' },
  'ORA-39070': { title: 'Не удаётся открыть файл журнала', hint: 'Нет прав на запись в папку каталога — скопируйте файл через соединение в DATA_PUMP_DIR.', fix: 'copy' },
  'ORA-31634': { title: 'Задание уже существует', hint: 'Осталось задание от прерванного запуска — удалите его мастер-таблицу.', fix: 'staleJobs' },
  'ORA-31626': { title: 'Задание не существует', hint: '' },
  'ORA-31655': { title: 'Не выбрано ни одного объекта', hint: 'Схемы с таким именем в дампе нет — проверьте выбор схем.' },
  'ORA-02304': { title: 'Конфликт идентификаторов типов (OID)', hint: 'Типы с тем же OID уже есть в базе (например, при переименовании схемы). Импортируйте с TRANSFORM=OID:N.', fix: 'oid' },
  'ORA-01940': { title: 'Нельзя удалить пользователя: есть подключения', hint: 'Приложение завершит сеансы перед удалением.', fix: 'killSessions' },
  'ORA-01119': { title: 'Ошибка создания файла данных', hint: 'Путь к файлу из базы-источника не существует здесь. Не создавайте табличные пространства из дампа — создайте их сами или используйте REMAP_TABLESPACE.', fix: 'tablespaces' },
  'ORA-27040': { title: 'Ошибка создания файла', hint: 'См. ORA-01119.', fix: 'tablespaces' },
  'ORA-65096': { title: 'Недопустимое имя общего пользователя', hint: 'Подключение к корневому контейнеру CDB$ROOT. Подключитесь к PDB (XEPDB1, FREEPDB1, ORCLPDB1…).' },
  'ORA-39346': { benign: true, title: 'Ошибка в метаданных — объект пропущен', hint: '' },
  'ORA-39181': { benign: true, title: 'Только часть данных импортирована из-за фильтра доступа', hint: 'Пользователь экспорта не видел все строки (VPD/FGAC).' },
  'ORA-01658': { title: 'Не удаётся создать начальный экстент', hint: 'Не хватает места в табличном пространстве.', fix: 'space' },
  // imp
  'IMP-00003': { title: 'Ошибка Oracle', hint: 'Причина — во вложенной ошибке ORA.' },
  'IMP-00017': { title: 'Оператор не выполнен', hint: 'Причина — во вложенной ошибке ORA.' },
  'IMP-00015': { benign: true, title: 'Объект уже существует', hint: 'При ignore=y не останавливает импорт.' },
  'IMP-00041': { title: 'Объект создан с ошибками компиляции', hint: 'После импорта схема перекомпилируется.', fix: 'recompile' },
  'IMP-00010': { title: 'Не является файлом exp', hint: 'Файл повреждён или это дамп Data Pump (нужен impdp).' },
  'IMP-00013': { title: 'Только DBA может импортировать дамп, созданный DBA', hint: 'Подключитесь пользователем с ролью DBA или IMP_FULL_DATABASE.', fix: 'privileges' },
  'IMP-00038': { title: 'Не удалось преобразовать кодировку', hint: 'Дамп сделан более новой версией exp или в несовместимой кодировке.' },
  'IMP-00009': { title: 'Неожиданный конец файла', hint: 'Файл скопирован не полностью (сравните размер с исходным) или передан в текстовом режиме FTP.' },
  'IMP-00032': { title: 'Слишком длинный оператор SQL', hint: 'Увеличьте BUFFER.' },
};

/**
 * lines — строки журнала. Вложенные ошибки (ORA-39083 «Object type … failed to create with error: ORA-00959»)
 * привязываются к причине: группа считается по коду причины.
 */
function classifyLog(lines) {
  const groups = new Map();
  let pending = null;   // обёртка ORA-39083 / ORA-31693 / IMP-00003 ждёт вложенную ошибку
  const add = (code, line, context) => {
    const info = CODES[code] || { title: 'Ошибка', hint: '' };
    if (!groups.has(code)) groups.set(code, { code, ...info, count: 0, samples: [], objects: new Set() });
    const g = groups.get(code);
    g.count++;
    if (g.samples.length < 5) g.samples.push((context ? context + ' → ' : '') + line.trim());
    const obj = /"([^"]+)"\."([^"]+)"/.exec(context || line);
    if (obj && g.objects.size < 50) g.objects.add(`${obj[1]}.${obj[2]}`);
  };
  for (const raw of lines) {
    const line = String(raw || '');
    const codes = line.match(/\b(ORA|IMP)-\d{5}\b/g) || [];
    if (!codes.length) {
      if (pending && /^\s*(Failing sql is|CREATE|ALTER|GRANT|"|\S)/.test(line) && pending.context.length < 400) pending.context += ' ' + line.trim().slice(0, 200);
      continue;
    }
    const wrappers = ['ORA-39083', 'ORA-31693', 'IMP-00003', 'IMP-00017', 'IMP-00058'];
    const main = codes.find(c => !wrappers.includes(c));
    if (codes.length === 1 && wrappers.includes(codes[0])) {
      if (pending) add(pending.code, pending.line, pending.context);
      pending = { code: codes[0], line, context: line.replace(/.*?(ORA|IMP)-\d{5}:\s*/, '').slice(0, 300) };
      continue;
    }
    if (pending && main) { add(main, line, pending.context); pending = null; continue; }
    if (pending) { add(pending.code, pending.line, pending.context); pending = null; }
    add(main || codes[0], line);
  }
  if (pending) add(pending.code, pending.line, pending.context);
  const list = [...groups.values()].map(g => ({ ...g, objects: [...g.objects] }));
  list.sort((a, b) => (a.benign === b.benign ? b.count - a.count : a.benign ? 1 : -1));
  return list;
}

/** Строки журнала «. . imported "SCOTT"."EMP"  8.781 KB  14 rows» → строки по таблицам. */
function importedRows(lines) {
  const out = [];
  for (const l of lines) {
    const m = /imported\s+"([^"]+)"\."([^"]+)"(?::"([^"]+)")?\s+([\d.,]+\s*[KMGT]?B)\s+(\d+)\s+rows/i.exec(l)
      || /importing table\s+"([^"]+)"()()\s+()(\d+)\s+rows imported/i.exec(l);
    if (m) out.push({ owner: m[2] ? m[1] : null, table: m[2] || m[1], partition: m[3] || null, size: m[4] || '', rows: Number(m[5]) });
  }
  return out;
}

module.exports = { classifyLog, importedRows, CODES };
