'use strict';
// Проверка перед переливом таблиц и конвейером миграции.
const { loadMeta } = require('../meta');
const { compatibility, targetColumnType } = require('../lib/typemap');
const { topoOrder } = require('../copy/transfer');
const { tryConnect, one, fmtRows } = require('./common');

const K = x => String(x).toLowerCase();

async function schemaExists(db, schema) {
  if (db.type === 'postgres') return (await db.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [schema])).length > 0;
  return (await db.query(`SELECT 1 FROM all_users WHERE username = :u`, { u: schema })).length > 0;
}
async function isEmpty(db, schema, table) {
  const q = db.qualify(schema, table);
  const r = db.type === 'postgres' ? await one(db, `SELECT 1 AS x FROM ${q} LIMIT 1`) : await one(db, `SELECT 1 AS x FROM ${q} WHERE ROWNUM = 1`);
  return r ? !r.length : null;
}

/**
 * p — параметры transfer или pipeline. kind: 'transfer' | 'pipeline'
 */
async function preflightTransfer(p, kind = 'transfer') {
  const issues = [], facts = [];
  const src = await tryConnect(p.sourceId, 'Источник', issues);
  const tgt = await tryConnect(p.targetId, 'Приёмник', issues);
  if (!src || !tgt) { await src?.close(); await tgt?.close(); return { issues, facts }; }
  const T = p.targetSchema, tid = p.targetId;
  const same = src.type === tgt.type;
  try {
    if (p.sourceId === p.targetId && K(p.sourceSchema) === K(T)) issues.push({ id: 'same', level: 'error', blocking: true, title: 'Источник и приёмник совпадают', fixes: [] });
    const A = await loadMeta(src, p.sourceSchema, {}, null);
    let selected = p.tables && p.tables.length ? A.tables.filter(t => p.tables.map(K).includes(K(t.name))) : A.tables;
    if (!selected.length) { issues.push({ id: 'empty', level: 'error', blocking: true, title: 'Не выбрано ни одной таблицы (или в схеме-источнике нет таблиц)', fixes: [] }); return { issues, facts }; }
    const rowsTotal = selected.reduce((s, t) => s + (t.rowEstimate || 0), 0);
    facts.push({ label: 'Таблиц', value: selected.length }, { label: 'Строк (оценка)', value: fmtRows(rowsTotal) });

    // --- схема приёмника
    const exists = await schemaExists(tgt, T);
    if (!exists) {
      if (tgt.type === 'postgres') {
        issues.push({ id: 'schema', level: 'error', blocking: true, title: `В приёмнике нет схемы ${T}`, details: 'Таблицы создавать некуда.',
          fixes: [{ id: 'create', title: `Создать схему ${T}`, default: true, patch: { preSql: [{ connId: tid, sql: `CREATE SCHEMA ${tgt.quote(T)}`, title: `Создать схему ${T}` }] } }] });
      } else {
        issues.push({ id: 'schema', level: 'error', blocking: true, title: `В приёмнике нет пользователя (схемы) ${T}`,
          fixes: [{ id: 'create', title: `Создать пользователя ${T} с квотой на табличное пространство по умолчанию`, default: true,
            input: { label: 'Пароль нового пользователя', value: 'Change_me_1' },
            patch: { preSql: [
              { connId: tid, sql: `CREATE USER ${tgt.quote(T)} IDENTIFIED BY "{{value}}" QUOTA UNLIMITED ON USERS`, title: `Создать пользователя ${T}` },
              { connId: tid, sql: `GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, CREATE SEQUENCE, CREATE PROCEDURE, CREATE TRIGGER TO ${tgt.quote(T)}`, title: 'Права на создание объектов' },
            ] } }] });
      }
    }
    const B = exists ? await loadMeta(tgt, T, {}, null) : { tables: [], sequences: [] };
    const mapB = new Map(B.tables.map(t => [K(t.name), t]));

    // --- права в приёмнике
    let superuser = false;
    if (tgt.type === 'postgres') {
      const r = await one(tgt, `SELECT rolsuper FROM pg_roles WHERE rolname = current_user`, [], []);
      superuser = !!(r && r[0] && r[0].rolsuper);
      if (exists) {
        const cr = await one(tgt, `SELECT has_schema_privilege(current_user, $1, 'CREATE') AS c, has_schema_privilege(current_user, $1, 'USAGE') AS u`, [T], []);
        const needCreate = selected.some(t => !mapB.has(K(t.name)));
        if (cr && cr[0] && (!cr[0].u || (needCreate && !cr[0].c)))
          issues.push({ id: 'priv-schema', level: 'error', blocking: true, title: `Нет прав ${!cr[0].u ? 'на использование' : 'на создание объектов в'} схеме ${T}`, sql: `GRANT USAGE, CREATE ON SCHEMA ${tgt.quote(T)} TO ${tgt.quote(tgt.conn.user)};`, details: 'Выполните от владельца схемы или суперпользователя:', fixes: [] });
        const noIns = [];
        for (const t of selected.slice(0, 500)) {
          const tb = mapB.get(K(t.name)); if (!tb) continue;
          const r2 = await one(tgt, `SELECT has_table_privilege(current_user, $1, 'INSERT') AS i, has_table_privilege(current_user, $1, 'TRUNCATE') AS t`, [`${tgt.quote(T)}.${tgt.quote(tb.name)}`], []);
          if (r2 && r2[0] && !r2[0].i) noIns.push(tb.name);
        }
        if (noIns.length) issues.push({ id: 'priv-insert', level: 'error', blocking: true, title: `Нет права INSERT на таблицы приёмника: ${noIns.length}`, list: noIns,
          sql: noIns.slice(0, 50).map(n => `GRANT INSERT, UPDATE, DELETE, TRUNCATE ON ${tgt.quote(T)}.${tgt.quote(n)} TO ${tgt.quote(tgt.conn.user)};`).join('\n'), fixes: [] });
      }
      const enc = await one(tgt, `SHOW server_encoding`, [], []);
      if (enc && enc[0] && enc[0].server_encoding !== 'UTF8') issues.push({ id: 'encoding', level: 'warning', title: `Кодировка базы-приёмника ${enc[0].server_encoding}, а не UTF8`, details: 'Символы, которых нет в этой кодировке, вызовут ошибку «character … has no equivalent». Рекомендуется база в UTF8.', fixes: [] });
    } else if (K(T) !== K(tgt.conn.user)) {
      const pr = new Set(((await one(tgt, `SELECT privilege FROM session_privs`, {}, [])) || []).map(r => r.privilege));
      if (!pr.has('INSERT ANY TABLE') && !pr.has('CREATE ANY TABLE'))
        issues.push({ id: 'priv-oracle', level: 'warning', title: `Загрузка в чужую схему ${T} от имени ${tgt.conn.user}`, details: 'Нужны права INSERT на таблицы этой схемы (и CREATE ANY TABLE для создания таблиц). Проще подключиться пользователем-владельцем схемы.', sql: `GRANT CREATE ANY TABLE, INSERT ANY TABLE, DELETE ANY TABLE, ALTER ANY TABLE TO ${tgt.conn.user};`, fixes: [] });
    }

    // --- отсутствующие таблицы
    const missing = selected.filter(t => !mapB.has(K(t.name)));
    if (missing.length) {
      if (kind === 'pipeline') {
        if (p.structure !== 'create') issues.push({ id: 'missing', level: 'error', blocking: true, title: `В приёмнике нет таблиц: ${missing.length}`, list: missing.map(t => t.name),
          fixes: [{ id: 'create', title: 'Создать структуру (шаг «Структура»)', default: true, patch: { structure: 'create' } }] });
        else facts.push({ label: 'Будет создано таблиц', value: missing.length });
      } else if (!p.createTables) {
        issues.push({ id: 'missing', level: 'error', blocking: true, title: `В приёмнике нет таблиц: ${missing.length}`, list: missing.map(t => t.name),
          fixes: [{ id: 'create', title: 'Создать отсутствующие таблицы (типы будут переведены автоматически)', default: true, patch: { createTables: true } }] });
      } else facts.push({ label: 'Будет создано таблиц', value: missing.length });
      const noPk = missing.filter(t => !t.pk);
      if (noPk.length) issues.push({ id: 'nopk', level: 'info', title: `Таблицы без первичного ключа: ${noPk.length}`, details: 'Создаются без ключа; сравнение данных для них будет медленнее (по хешам строк).', list: noPk.map(t => t.name), fixes: [] });
    }

    // --- непустые таблицы
    const existing = selected.filter(t => mapB.has(K(t.name)));
    const nonEmpty = [];
    for (const t of existing.slice(0, 500)) { const e = await isEmpty(tgt, T, mapB.get(K(t.name)).name); if (e === false) nonEmpty.push({ name: t.name, rows: mapB.get(K(t.name)).rowEstimate }); }
    const mode = p.mode || (kind === 'pipeline' ? 'truncate' : 'append');
    if (nonEmpty.length) {
      const list = nonEmpty.map(t => `${t.name}${t.rows ? ` (~${fmtRows(t.rows)} строк)` : ''}`);
      const skip = { skipTables: nonEmpty.map(t => t.name) };
      if (mode === 'append') {
        issues.push({ id: 'nonempty', level: 'warning', required: true, choice: true, title: `В приёмнике уже есть данные в ${nonEmpty.length} табл.`, list,
          details: 'При добавлении строк возможны дубликаты или ошибки уникальности. Что сделать?',
          fixes: [
            { id: 'truncate', title: 'Очистить таблицы перед загрузкой (TRUNCATE)', danger: true, patch: { mode: 'truncate' } },
            { id: 'skip', title: 'Пропустить непустые таблицы', patch: skip },
            { id: 'append', title: 'Добавить строки к существующим', patch: {} },
          ] });
      } else {
        issues.push({ id: 'nonempty', level: 'warning', required: true, choice: true, title: `Будут очищены таблицы с данными: ${nonEmpty.length}`, list,
          fixes: [{ id: 'clear', title: `Да, очистить (${mode === 'delete' ? 'DELETE' : 'TRUNCATE'})`, danger: true, default: true, patch: {} }, { id: 'skip', title: 'Не трогать непустые таблицы', patch: skip }] });
      }
    }

    // --- колонки существующих таблиц
    const addCols = [], widen = [], incompatible = [], notNull = [], genAlways = [], seqFix = [];
    for (const ta of existing) {
      const tb = mapB.get(K(ta.name));
      const cb = new Map(tb.columns.map(c => [K(c.name), c]));
      for (const ca of ta.columns) {
        const c2 = cb.get(K(ca.name));
        if (!c2) { addCols.push({ t: tb.name, c: ca }); continue; }
        const cmp = compatibility(ca, c2, same);
        if (cmp.level === 'error') {
          const widenable = (['string', 'text'].includes(ca.family) && ['string', 'text'].includes(c2.family)) || (['int', 'numeric'].includes(ca.family) && ['int', 'numeric'].includes(c2.family));
          (widenable ? widen : incompatible).push({ t: tb.name, ca, cb: c2, msg: cmp.msg });
        }
        if (!c2.nullable && ca.nullable) notNull.push(`${tb.name}.${c2.name}`);
        if (c2.identity === 'a') genAlways.push({ t: tb.name, c: c2.name });
        if (tgt.type === 'postgres' && (c2.identity || /nextval\(/i.test(c2.default || ''))) seqFix.push({ t: tb.name, c: c2.name });
      }
    }
    const tq = n => `${tgt.quote(T)}.${tgt.quote(n)}`;
    const typeFor = c => (same ? c.type : targetColumnType(c, src.type, tgt.type));
    if (addCols.length)
      issues.push({ id: 'addcols', level: 'warning', title: `В таблицах приёмника нет колонок источника: ${addCols.length}`, details: 'Без исправления данные этих колонок не перенесутся.',
        list: addCols.map(x => `${x.t}.${x.c.name} ${x.c.type}`),
        fixes: [{ id: 'add', title: 'Добавить колонки в приёмник', default: true, patch: { preSql: addCols.map(x => ({ connId: tid, title: `Колонка ${x.t}.${x.c.name}`,
          sql: tgt.type === 'postgres' ? `ALTER TABLE ${tq(x.t)} ADD COLUMN ${tgt.quote(tgt.normName(x.c.name))} ${typeFor(x.c)}` : `ALTER TABLE ${tq(x.t)} ADD (${tgt.quote(tgt.normName(x.c.name))} ${typeFor(x.c)})` })) } }] });
    if (widen.length)
      issues.push({ id: 'widen', level: 'warning', title: `Колонки приёмника уже, чем в источнике: ${widen.length}`, details: 'Длинные строки или большие числа не поместятся («value too long», ORA-12899, ORA-01438).',
        list: widen.map(x => `${x.t}.${x.cb.name}: ${x.msg}`),
        fixes: [{ id: 'widen', title: 'Расширить колонки приёмника до размера источника', default: true, patch: { preSql: widen.map(x => ({ connId: tid, ignoreError: true, title: `Расширить ${x.t}.${x.cb.name}`,
          sql: tgt.type === 'postgres' ? `ALTER TABLE ${tq(x.t)} ALTER COLUMN ${tgt.quote(x.cb.name)} TYPE ${typeFor(x.ca)}` : `ALTER TABLE ${tq(x.t)} MODIFY (${tgt.quote(x.cb.name)} ${typeFor(x.ca)})` })) } }] });
    if (incompatible.length)
      issues.push({ id: 'types', level: 'warning', title: `Несовместимые типы колонок: ${incompatible.length}`, details: 'Значения могут не преобразоваться. Проверьте структуру («Сравнение схем») или профиль данных.', list: incompatible.map(x => `${x.t}.${x.cb.name}: ${x.msg}`), fixes: [] });
    if (notNull.length)
      issues.push({ id: 'notnull', level: src.type === 'postgres' && tgt.type === 'oracle' ? 'warning' : 'info', title: `NOT NULL в приёмнике, а в источнике колонка допускает NULL: ${notNull.length}`,
        details: src.type === 'postgres' && tgt.type === 'oracle' ? 'Пустые строки \'\' в Oracle становятся NULL — такие строки не загрузятся (ORA-01400).' : 'Если в источнике есть NULL, строки не загрузятся.', list: notNull, fixes: [] });
    if (genAlways.length && tgt.type === 'postgres')
      issues.push({ id: 'identity', level: 'warning', title: `Колонки GENERATED ALWAYS AS IDENTITY: ${genAlways.length}`, details: 'Значения из источника в них не записываются — будут новые номера, и ссылки по ключам разойдутся.', list: genAlways.map(x => `${x.t}.${x.c}`),
        fixes: [{ id: 'bydefault', title: 'Переключить на GENERATED BY DEFAULT (значения из источника сохранятся)', default: true, patch: { preSql: genAlways.map(x => ({ connId: tid, title: `${x.t}.${x.c} BY DEFAULT`, sql: `ALTER TABLE ${tq(x.t)} ALTER COLUMN ${tgt.quote(x.c)} SET GENERATED BY DEFAULT` })) } }] });
    if (seqFix.length)
      issues.push({ id: 'serial', level: 'warning', title: `Колонки с автонумерацией (serial / identity): ${seqFix.length}`, details: 'После загрузки последовательности остаются на старом значении — следующая вставка приложением получит дубликат ключа.',
        list: seqFix.map(x => `${x.t}.${x.c}`),
        fixes: [{ id: 'setval', title: 'После загрузки сдвинуть последовательности на MAX(колонки)', default: true, patch: { postSql: seqFix.map(x => ({ connId: tid, ignoreError: true, title: `setval ${x.t}.${x.c}`,
          sql: `SELECT setval(pg_get_serial_sequence('${tq(x.t).replace(/'/g, "''")}', '${x.c.replace(/'/g, "''")}'), GREATEST(COALESCE((SELECT MAX(${tgt.quote(x.c)}) FROM ${tq(x.t)}), 0), 1))` })) } }] });

    // --- триггеры
    const withTrg = existing.map(t => mapB.get(K(t.name))).filter(t => t.triggers && t.triggers.length);
    const replica = tgt.type === 'postgres' && superuser && (kind === 'pipeline' || p.disableFk);
    if (withTrg.length && !replica)
      issues.push({ id: 'triggers', level: 'warning', title: `На таблицах приёмника есть триггеры: ${withTrg.length} табл.`, details: 'Во время загрузки они сработают на каждую строку: замедлят перенос, запишут аудит/историю или изменят данные.',
        list: withTrg.map(t => `${t.name}: ${t.triggers.join(', ')}`),
        fixes: [{ id: 'disable', title: 'Отключить триггеры на время загрузки и включить после', default: true, patch: {
          preSql: withTrg.map(t => ({ connId: tid, title: `Отключить триггеры ${t.name}`, sql: tgt.type === 'postgres' ? `ALTER TABLE ${tq(t.name)} DISABLE TRIGGER USER` : `ALTER TABLE ${tq(t.name)} DISABLE ALL TRIGGERS` })),
          postSql: withTrg.map(t => ({ connId: tid, ignoreError: true, title: `Включить триггеры ${t.name}`, sql: tgt.type === 'postgres' ? `ALTER TABLE ${tq(t.name)} ENABLE TRIGGER USER` : `ALTER TABLE ${tq(t.name)} ENABLE ALL TRIGGERS` })) } }] });

    // --- внешние ключи
    const selNames = new Set(selected.map(t => K(t.name)));
    const parents = new Set();
    for (const t of selected) for (const fk of t.fks || []) if (fk.refTable && !selNames.has(K(fk.refTable)) && (!fk.refSchema || K(fk.refSchema) === K(p.sourceSchema))) parents.add(fk.refTable);
    if (parents.size && p.tables && p.tables.length) {
      const emptyParents = [];
      for (const n of parents) { const tb = mapB.get(K(n)); if (!tb || (await isEmpty(tgt, T, tb.name)) !== false) emptyParents.push(n); }
      if (emptyParents.length)
        issues.push({ id: 'parents', level: 'warning', title: `Не выбраны родительские таблицы: ${emptyParents.join(', ')}`, details: 'В приёмнике они пусты — строки с внешними ключами на них не загрузятся или ключи потом не включатся.',
          fixes: [{ id: 'add', title: 'Добавить родительские таблицы в перенос', default: true, patch: { tables: emptyParents } }] });
    }
    const hasFk = existing.some(t => (mapB.get(K(t.name)).fks || []).length) || selected.some(t => (t.fks || []).length);
    const order = topoOrder(selected, K);
    const cyclic = selected.length !== order.length || hasCycle(selected);
    if (kind === 'transfer' && hasFk && !p.disableFk && ((p.parallel || 1) > 1 || cyclic))
      issues.push({ id: 'fk', level: 'warning', title: (p.parallel || 1) > 1 ? 'Параллельная загрузка таблиц с внешними ключами' : 'Циклические внешние ключи', details: 'Дочерние строки могут загрузиться раньше родительских — ошибки внешнего ключа.',
        fixes: [{ id: 'disable', title: 'Отключить внешние ключи на время загрузки', default: true, patch: { disableFk: true } }, { id: 'serial', title: 'Загружать по одной таблице в порядке зависимостей', patch: { parallel: 1 } }] });
    if (tgt.type === 'postgres' && !superuser && hasFk && (kind === 'pipeline' ? false : p.disableFk) && (p.parallel || 1) > 1)
      issues.push({ id: 'fk-super', level: 'warning', title: 'Отключить внешние ключи в PostgreSQL может только суперпользователь', details: `Пользователь ${tgt.conn.user} не суперпользователь: при параллельной загрузке возможны ошибки внешних ключей.`,
        fixes: [{ id: 'serial', title: 'Загружать по одной таблице в порядке зависимостей', default: true, patch: { parallel: 1 } }] });

    // --- последовательности
    if (kind === 'transfer' && !p.syncSequences) {
      const sb = new Set(B.sequences.map(s => K(s.name)));
      const common = A.sequences.filter(s => sb.has(K(s.name)));
      if (common.length) issues.push({ id: 'seq', level: 'warning', title: `Последовательности есть в обеих базах: ${common.length}`, details: 'Без синхронизации новые записи в приёмнике получат уже занятые номера.',
        fixes: [{ id: 'sync', title: 'Выставить последовательности приёмника по источнику', default: true, patch: { syncSequences: true } }] });
    }

    // --- источник: что не переносится, скорость
    const bfile = selected.flatMap(t => t.columns.filter(c => c.dataType === 'BFILE').map(c => `${t.name}.${c.name}`));
    if (bfile.length) issues.push({ id: 'bfile', level: 'warning', title: `Колонки BFILE не переносятся: ${bfile.length}`, details: 'Это ссылки на файлы на сервере Oracle — сами файлы надо скопировать отдельно.', list: bfile, fixes: [] });
    if (rowsTotal > 1e6 && (p.parallel || (kind === 'pipeline' ? 4 : 1)) === 1 && !issues.some(i => i.id === 'fk-super'))
      issues.push({ id: 'parallel', level: 'info', title: `Около ${fmtRows(rowsTotal)} строк — загрузка в один поток будет долгой`, fixes: [{ id: 'p4', title: 'Загружать 4 таблицы параллельно', default: false, patch: { parallel: 4 } }] });
    if (src.type === 'oracle' && tgt.type === 'postgres') {
      const noPrec = selected.flatMap(t => t.columns.filter(c => c.dataType === 'NUMBER' && c.precision == null && c.scale == null).map(c => `${t.name}.${c.name}`));
      if (noPrec.length && missing.length) issues.push({ id: 'number', level: 'info', title: `NUMBER без точности: ${noPrec.length} колонок → numeric`, details: 'numeric работает медленнее integer/bigint. Если там только целые — «Профиль данных» подскажет точный тип.', list: noPrec.slice(0, 200), fixes: [] });
    }
  } finally { await src.close(); await tgt.close(); }
  return { issues, facts };
}

function hasCycle(tables) {
  const names = new Set(tables.map(t => K(t.name)));
  const g = new Map(tables.map(t => [K(t.name), (t.fks || []).map(f => K(f.refTable || '')).filter(r => names.has(r) && r !== K(t.name))]));
  const state = new Map();
  const visit = n => { if (state.get(n) === 1) return true; if (state.get(n) === 2) return false; state.set(n, 1); for (const m of g.get(n) || []) if (visit(m)) return true; state.set(n, 2); return false; };
  for (const n of g.keys()) if (visit(n)) return true;
  return false;
}

module.exports = { preflightTransfer, hasCycle };
