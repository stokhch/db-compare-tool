'use strict';
// Сравнение схем: Oracle↔Oracle, PG↔PG, Oracle↔PG.
// Идея как у ora2pg TEST: объекты и их количество с обеих сторон + детальный diff колонок.
const { connect } = require('../db');
const { loadMeta } = require('../meta');
const { compatibility } = require('../lib/typemap');
const { getConnection, publicConnection } = require('../lib/store');
const { plpgsqlCheck } = require('./pgcheck');
const { filterMeta } = require('../meta/objects');
const { buildSchemaSync } = require('./syncschema');

const CAT = {
  tables: 'Таблицы', columns: 'Колонки', pk: 'Первичные ключи', uniques: 'Уникальные ключи',
  fks: 'Внешние ключи', checks: 'CHECK-ограничения', indexes: 'Индексы', triggers: 'Триггеры',
  views: 'Представления', mviews: 'Материализованные представления', sequences: 'Последовательности',
  routines: 'Функции и процедуры', types: 'Типы', rows: 'Количество строк', invalid: 'Невалидные объекты',
  pgcheck: 'Код PostgreSQL (plpgsql_check)',
};

function makeKey(caseSensitive) { return n => (n == null ? '' : caseSensitive ? String(n) : String(n).toLowerCase()); }

async function runSchemaCompare(p, ctx) {
  const srcConn = getConnection(p.sourceId);
  const tgtConn = getConnection(p.targetId);
  const sameEngine = srcConn.type === tgtConn.type;
  const K = makeKey(!!p.caseSensitive);
  const opts = { rowCounts: p.rowCounts || 'none' };

  ctx.log(`Источник: ${srcConn.name} (${srcConn.type}) схема ${p.sourceSchema}`);
  ctx.log(`Приёмник: ${tgtConn.name} (${tgtConn.type}) схема ${p.targetSchema}`);
  ctx.progress(0, 0, 'Подключение…');

  const [src, tgt] = await Promise.all([connect(srcConn), connect(tgtConn)]);
  let A, B, sync = null;
  try {
    ctx.progress(0, 0, 'Чтение метаданных источника…');
    A = await loadMeta(src, p.sourceSchema, opts, ctx);
    ctx.checkCancel();
    ctx.progress(0, 0, 'Чтение метаданных приёмника…');
    // Если сравниваем Oracle -> PG, функции пакетов ora2pg кладёт в схемы с именами пакетов
    B = await loadMeta(tgt, p.targetSchema, opts, ctx, A.packages || []);
    // Только выбранные объекты
    if (p.objects && p.objects.length) {
      A = filterMeta(A, p.objects, K);
      B = filterMeta(B, p.objects, K);
      ctx.log(`Сравниваются только выбранные объекты: ${p.objects.length}`);
    }
    // Проверка кода PL/pgSQL (аналог INVALID в Oracle)
    if (p.checkPgCode !== false) {
      for (const [side, db, meta] of [['source', src, A], ['target', tgt, B]]) {
        if (db.type !== 'postgres') continue;
        ctx.checkCancel();
        ctx.progress(0, 0, `plpgsql_check: ${side === 'source' ? 'источник' : 'приёмник'}…`);
        const schemas = [meta.schema, ...new Set(meta.routines.filter(r => r.package).map(r => r.package))];
        try {
          meta.pgcheck = await plpgsqlCheck(db, schemas, { extra: !!p.pgCheckExtra });
          if (meta.filtered) {
            const okNames = new Set([...meta.routines.map(r => K(r.name.split('.').pop())), ...meta.triggers.map(t => K(t.name))]);
            meta.pgcheck.messages = meta.pgcheck.messages.filter(m =>
              okNames.has(K(m.function.replace(/\(.*$/, '').split('.').pop())) || (m.trigger && okNames.has(K(m.trigger))));
          }
          ctx.log(meta.pgcheck.available ? `plpgsql_check (${side}): проверено ${meta.pgcheck.checked}, сообщений ${meta.pgcheck.messages.length}` : meta.pgcheck.note,
            meta.pgcheck.available ? 'info' : 'warning');
        } catch (e) { meta.pgcheck = { available: false, note: `plpgsql_check: ${e.message}`, messages: [] }; }
      }
    }
    // Скрипт синхронизации структуры (приёмник → как источник)
    if (p.buildSync !== false) {
      ctx.progress(0, 0, 'Скрипт синхронизации…');
      try { sync = await buildSchemaSync(src, tgt, A, B, p, K); ctx.log(`Скрипт синхронизации: операторов ${sync.statements.length}`); }
      catch (e) { ctx.log(`Скрипт синхронизации не построен: ${e.message}`, 'warning'); }
    }
  } finally {
    await Promise.all([src.close(), tgt.close()]);
  }
  ctx.checkCancel();
  ctx.progress(0, 0, 'Сравнение…');

  const findings = [];
  const add = (category, object, status, kind, source, target, message, table) =>
    findings.push({ category, object, status, kind, source: source ?? '', target: target ?? '', message: message || '', table: table || '' });

  // ---------- Сопоставление списков по имени ----------
  function matchLists(category, listA, listB, nameOf = x => x.name, onBoth, opt = {}) {
    const mapB = new Map(listB.map(x => [K(nameOf(x)), x]));
    const used = new Set();
    for (const a of listA) {
      const k = K(nameOf(a));
      let b = mapB.get(k);
      let note = '';
      if (!b && opt.altKey) {
        const ak = opt.altKey(k);
        if (ak && mapB.has(ak)) { b = mapB.get(ak); note = `найдено под именем ${nameOf(b)}`; }
      }
      const label = x => (opt.prefix || '') + nameOf(x);
      if (!b) {
        add(category, label(a), opt.missingStatus || 'error', 'missing_in_target', nameOf(a), '', opt.missingMsg || 'Отсутствует в приёмнике', opt.table && opt.table(a));
        continue;
      }
      used.add(K(nameOf(b)));
      if (onBoth) onBoth(a, b, note);
      else add(category, label(a), note ? 'warning' : 'ok', 'equal', nameOf(a), nameOf(b), note, opt.table && opt.table(a));
    }
    for (const b of listB) {
      if (!used.has(K(nameOf(b)))) add(category, (opt.prefix || '') + nameOf(b), opt.extraStatus || 'warning', 'extra_in_target', '', nameOf(b), 'Есть только в приёмнике', opt.table && opt.table(b));
    }
  }

  const sig = cols => cols.map(c => K(c)).join(',');
  const tablePairs = [];

  matchLists(CAT.tables, A.tables, B.tables, x => x.name, (ta, tb) => {
    tablePairs.push([ta, tb]);
    add(CAT.tables, ta.name, 'ok', 'equal', ta.name, tb.name, '');
  });

  for (const [ta, tb] of tablePairs) {
    const tname = ta.name;
    // Колонки
    matchLists(CAT.columns, ta.columns, tb.columns, x => x.name, (ca, cb) => {
      const issues = [];
      let level = 'ok';
      const comp = compatibility(ca, cb, sameEngine);
      if (comp.level !== 'ok') { issues.push(comp.msg); level = comp.level; }
      if (ca.nullable !== cb.nullable) {
        issues.push(`NULL: ${ca.nullable ? 'допускается' : 'NOT NULL'} → ${cb.nullable ? 'допускается' : 'NOT NULL'}`);
        if (level === 'ok') level = 'warning';
      }
      if (sameEngine && normDefault(ca.default) !== normDefault(cb.default)) {
        issues.push(`DEFAULT: ${ca.default ?? '—'} → ${cb.default ?? '—'}`);
        if (level === 'ok') level = 'warning';
      }
      if (p.checkColumnOrder && ca.position !== cb.position) {
        issues.push(`Позиция: ${ca.position} → ${cb.position}`);
        if (level === 'ok') level = 'warning';
      }
      add(CAT.columns, `${tname}.${ca.name}`, level, level === 'ok' ? 'equal' : 'different',
        `${ca.type}${ca.nullable ? '' : ' NOT NULL'}`, `${cb.type}${cb.nullable ? '' : ' NOT NULL'}`, issues.join('; '), tname);
    }, { table: () => tname, prefix: tname + '.' });

    // Первичный ключ
    if (ta.pk || tb.pk) {
      const sa = ta.pk ? sig(ta.pk.columns) : '', sb = tb.pk ? sig(tb.pk.columns) : '';
      if (!tb.pk) add(CAT.pk, tname, 'error', 'missing_in_target', `${ta.pk.name} (${ta.pk.columns.join(', ')})`, '', 'Нет первичного ключа в приёмнике', tname);
      else if (!ta.pk) add(CAT.pk, tname, 'warning', 'extra_in_target', '', `${tb.pk.name} (${tb.pk.columns.join(', ')})`, 'Первичный ключ только в приёмнике', tname);
      else add(CAT.pk, tname, sa === sb ? 'ok' : 'error', sa === sb ? 'equal' : 'different', `(${ta.pk.columns.join(', ')})`, `(${tb.pk.columns.join(', ')})`, sa === sb ? '' : 'Разные колонки ключа', tname);
    }

    // Уникальные ключи, FK, индексы — по сигнатуре колонок (имена после миграции часто отличаются)
    const bySig = (category, la, lb, sigOf, label) => {
      const mb = new Map(lb.map(x => [sigOf(x), x]));
      const used = new Set();
      for (const a of la) {
        const s = sigOf(a);
        if (mb.has(s)) { used.add(s); add(category, `${tname}: ${label(a)}`, 'ok', 'equal', a.name, mb.get(s).name, '', tname); }
        else add(category, `${tname}: ${label(a)}`, 'error', 'missing_in_target', a.name, '', 'Отсутствует в приёмнике', tname);
      }
      for (const b of lb) if (!used.has(sigOf(b))) add(category, `${tname}: ${label(b)}`, 'warning', 'extra_in_target', '', b.name, 'Есть только в приёмнике', tname);
    };
    bySig(CAT.uniques, ta.uniques, tb.uniques, x => sig(x.columns), x => `(${x.columns.join(', ')})`);
    bySig(CAT.fks, ta.fks, tb.fks, x => `${sig(x.columns)}->${K(x.refTable)}(${sig(x.refColumns || [])})`, x => `(${x.columns.join(', ')}) → ${x.refTable}(${(x.refColumns || []).join(', ')})`);
    if (p.compareIndexes !== false) {
      bySig(CAT.indexes, ta.indexes, tb.indexes, x => `${x.unique ? 'U' : ''}:${sig(x.columns)}`, x => `${x.unique ? 'UNIQUE ' : ''}(${x.columns.join(', ')})`);
    }
    // CHECK — у разных СУБД синтаксис отличается, поэтому сравниваем количество
    if (ta.checks.length || tb.checks.length) {
      const same = ta.checks.length === tb.checks.length;
      add(CAT.checks, tname, same ? 'ok' : 'warning', same ? 'equal' : 'different', String(ta.checks.length), String(tb.checks.length),
        same ? '' : 'Разное количество CHECK-ограничений', tname);
    }
    // Количество строк
    if (opts.rowCounts !== 'none') {
      const ra = ta.rowCount, rb = tb.rowCount;
      if (ra == null || rb == null) add(CAT.rows, tname, 'warning', 'different', ra ?? (ta.rowCountError || '?'), rb ?? (tb.rowCountError || '?'), 'Не удалось посчитать', tname);
      else {
        const same = ra === rb;
        const lvl = same ? 'ok' : (opts.rowCounts === 'estimate' ? 'warning' : 'error');
        add(CAT.rows, tname, lvl, same ? 'equal' : 'different', String(ra), String(rb),
          same ? '' : (opts.rowCounts === 'estimate' ? `Оценка по статистике: разница ${rb - ra}` : `Разница: ${rb - ra}`), tname);
      }
    }
  }

  matchLists(CAT.triggers, A.triggers, B.triggers, x => x.name, (a, b) => {
    const issues = [];
    if (a.enabled !== b.enabled) issues.push(`${a.enabled ? 'включён' : 'выключен'} → ${b.enabled ? 'включён' : 'выключен'}`);
    if (K(a.table) !== K(b.table)) issues.push(`таблица ${a.table} → ${b.table}`);
    add(CAT.triggers, a.name, issues.length ? 'warning' : 'ok', issues.length ? 'different' : 'equal', `${a.table}`, `${b.table}`, issues.join('; '), a.table);
  });
  matchLists(CAT.views, A.views, B.views);
  matchLists(CAT.mviews, A.mviews, B.mviews);
  matchLists(CAT.sequences, A.sequences, B.sequences, x => x.name, (a, b) => {
    const va = a.value == null ? null : Number(a.value), vb = b.value == null ? null : Number(b.value);
    let lvl = 'ok', msg = '';
    if (va != null && (vb == null || vb < va - Number(a.increment || 1))) { lvl = 'warning'; msg = 'Текущее значение в приёмнике меньше — возможны конфликты ключей'; }
    add(CAT.sequences, a.name, lvl, lvl === 'ok' ? 'equal' : 'different', a.value ?? '—', b.value ?? '—', msg);
  });
  if (p.compareRoutines !== false) {
    // Подпрограммы пакетов: ora2pg PACKAGE_AS_SCHEMA → «пакет.процедура», plsql2pg (по умолчанию) → «пакет_процедура»
    matchLists(CAT.routines, A.routines, B.routines, x => x.key, (a, b, note) => {
      const msg = note ? `в приёмнике — ${b.name} (именование plsql2pg: пакет_процедура)` : '';
      add(CAT.routines, a.name, a.valid ? 'ok' : 'warning', 'equal', `${a.kind}${a.valid ? '' : ' (INVALID)'}`, `${b.kind} ${b.name}`, msg);
    }, { altKey: k => (k.includes('.') ? k.replace('.', '_') : null) });
    matchLists(CAT.types, A.types, B.types, x => x.name, null, { missingStatus: 'warning' });
  }
  for (const [side, meta] of [['source', A], ['target', B]]) {
    const pc = meta.pgcheck;
    if (!pc) continue;
    if (!pc.available) { add(CAT.pgcheck, side === 'source' ? 'источник' : 'приёмник', 'warning', 'different', '', '', pc.note); continue; }
    for (const m of pc.messages) {
      const where = `${m.trigger ? `триггер ${m.trigger}, ` : ''}${m.line ? `строка ${m.line}` : ''}`;
      add(CAT.pgcheck, m.function, m.level, 'different', side === 'source' ? where || 'ошибка' : '', side === 'target' ? where || 'ошибка' : '', m.message);
    }
    if (!pc.messages.length) add(CAT.pgcheck, `${side === 'source' ? 'источник' : 'приёмник'}: проверено ${pc.checked}`, 'ok', 'equal', '', '', 'Ошибок не найдено');
  }
  for (const o of A.invalid) add(CAT.invalid, `${o.type} ${o.name}`, 'warning', 'different', 'INVALID', '', 'Невалидный объект в источнике');
  for (const o of B.invalid) add(CAT.invalid, `${o.type} ${o.name}`, 'warning', 'different', '', 'INVALID', 'Невалидный объект в приёмнике');

  // ---------- Сводка ----------
  const byCat = {};
  for (const f of findings) {
    const c = byCat[f.category] || (byCat[f.category] = { category: f.category, ok: 0, warning: 0, error: 0, source: 0, target: 0 });
    c[f.status]++;
    if (f.source !== '') c.source++;
    if (f.target !== '') c.target++;
  }
  const order = Object.values(CAT);
  const categories = Object.values(byCat).sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
  const totals = findings.reduce((s, f) => (s[f.status]++, s), { ok: 0, warning: 0, error: 0 });

  // Неотсортированные пары таблиц для экрана «сравнение данных»
  const commonTables = tablePairs.map(([a, b]) => ({ source: a.name, target: b.name, hasPk: !!(a.pk || b.pk) }));

  return {
    summary: { ...totals, sourceTables: A.tables.length, targetTables: B.tables.length },
    source: { ...publicConnection(srcConn), schema: p.sourceSchema },
    target: { ...publicConnection(tgtConn), schema: p.targetSchema },
    sameEngine,
    categories,
    findings,
    commonTables,
    objectsFilter: p.objects && p.objects.length ? p.objects.length : 0,
    sync,
  };
}

function normDefault(d) {
  if (d == null) return '';
  return String(d).trim().replace(/::[\w\s]+(\[\])?/g, '').replace(/^\((.*)\)$/, '$1').toLowerCase();
}

module.exports = { runSchemaCompare, CAT };
