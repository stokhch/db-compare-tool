'use strict';
// Проверки перед ora2pg, догрузкой изменений и сравнением данных.
const { loadMeta } = require('../meta');
const { ora2pgCmd, plsql2pgBundle, perlModule, toolVersion } = require('../lib/proc');
const { getSettings } = require('../lib/store');
const { tryConnect, one, fmtRows } = require('./common');

const K = x => String(x).toLowerCase();

// ---------- ora2pg ----------
async function preflightOra2pg(p) {
  const issues = [], facts = [];
  const o = ora2pgCmd();
  const v = await toolVersion(o.cmd, [...o.pre, '--version'], o.env);
  facts.push({ label: 'ora2pg', value: v.ok ? `${v.version} (${o.source})` : 'не найден' });
  const bundle = plsql2pgBundle();
  if (!v.ok) {
    issues.push({ id: 'ora2pg', level: 'error', blocking: true, title: 'ora2pg не запускается', details: `${v.version}\nНужен Perl с модулями DBD::Oracle (и DBD::Pg для загрузки в PostgreSQL). Проще всего — комплект plsql2pg для Windows, в нём всё уже есть.`,
      fixes: bundle && getSettings().ora2pgSource === 'custom' ? [{ id: 'bundle', title: `Использовать комплект plsql2pg (${bundle.root})`, default: true, patch: { _settings: { ora2pgSource: 'auto' } } }] : [] });
    return { issues, facts };
  }
  const dbdO = await perlModule(o, 'DBD::Oracle');
  if (!dbdO.ok) issues.push({ id: 'dbd-oracle', level: 'error', blocking: true, title: 'У Perl нет драйвера DBD::Oracle', details: 'Без него ora2pg не подключится к Oracle. Установите его (cpan DBD::Oracle, нужен Oracle Instant Client с SDK) или используйте комплект plsql2pg.',
    fixes: bundle && getSettings().ora2pgSource === 'custom' ? [{ id: 'bundle', title: `Использовать комплект plsql2pg (${bundle.root})`, default: true, patch: { _settings: { ora2pgSource: 'auto' } } }] : [] });
  const loads = /^(COPY|INSERT|TEST)/.test(p.action || '');
  if (p.targetId) {
    const dbdP = await perlModule(o, 'DBD::Pg');
    if (!dbdP.ok && loads) issues.push({ id: 'dbd-pg', level: 'error', blocking: true, title: 'У Perl нет драйвера DBD::Pg', details: 'Он нужен, чтобы ora2pg писал данные в PostgreSQL напрямую или выполнял проверки TEST.', fixes: [] });
  } else if (/^TEST/.test(p.action || '')) issues.push({ id: 'needpg', level: 'error', blocking: true, title: 'Для проверок TEST нужна база PostgreSQL', fixes: [] });
  const src = await tryConnect(p.sourceId, 'Oracle', issues);
  if (src && src.type !== 'oracle') { issues.push({ id: 'srctype', level: 'error', blocking: true, title: 'Источник для ora2pg должен быть Oracle', fixes: [] }); await src.close(); }
  else if (src) {
    try {
      const own = await one(src, `SELECT COUNT(*) AS n FROM all_objects WHERE owner = :o`, { o: String(p.sourceSchema || '').toUpperCase() }, []);
      const n = own && own[0] ? Number(own[0].n) : 0;
      if (!n) issues.push({ id: 'schema', level: 'error', blocking: true, title: `В схеме ${p.sourceSchema} нет объектов (или нет прав их видеть)`, fixes: [] });
      else facts.push({ label: 'Объектов в схеме', value: n });
      const host = String(src.conn.host || '');
      if (/[^\x20-\x7e]/.test(src.conn.password || '')) issues.push({ id: 'pwd', level: 'warning', title: 'В пароле Oracle есть не-ASCII символы', details: 'ora2pg (Perl DBI) может передать их неверно — ORA-01017.', fixes: [] });
      if (!host && !src.conn.connectString) issues.push({ id: 'host', level: 'error', blocking: true, title: 'В подключении Oracle не указан хост', fixes: [] });
    } finally { await src.close(); }
  }
  if (p.targetId && loads) {
    const tgt = await tryConnect(p.targetId, 'PostgreSQL', issues);
    if (tgt) {
      try {
        const sch = p.targetSchema || String(p.sourceSchema || '').toLowerCase();
        const ex = await one(tgt, `SELECT 1 AS x FROM pg_namespace WHERE nspname = $1`, [sch], []);
        if (!ex || !ex.length) issues.push({ id: 'pgschema', level: 'warning', title: `В PostgreSQL нет схемы ${sch}`, details: 'Данные загружаются в существующие таблицы — сначала создайте структуру (действие TABLE и выполнение скрипта, или «Миграция → Конвейер»).',
          fixes: [{ id: 'create', title: `Создать схему ${sch}`, default: true, patch: { preSql: [{ connId: p.targetId, sql: `CREATE SCHEMA "${sch}"`, title: `Схема ${sch}` }] } }] });
        else if (/^(COPY|INSERT)$/.test(p.action)) {
          const cnt = await one(tgt, `SELECT count(*)::int AS n, count(*) FILTER (WHERE c.reltuples > 0)::int AS full FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','p')`, [sch], []);
          if (cnt && cnt[0] && cnt[0].n === 0) issues.push({ id: 'notables', level: 'error', blocking: true, title: `В схеме ${sch} нет таблиц`, details: 'Сначала создайте структуру (действие TABLE).', fixes: [] });
          else if (cnt && cnt[0] && cnt[0].full > 0 && !p.truncateTable) issues.push({ id: 'nonempty', level: 'warning', choice: true, required: true, title: `В таблицах ${sch} уже есть данные (${cnt[0].full} табл.)`,
            fixes: [{ id: 'truncate', title: 'Очищать таблицы перед загрузкой (TRUNCATE_TABLE)', danger: true, patch: { truncateTable: true } }, { id: 'append', title: 'Добавить к существующим', patch: {} }] });
        }
      } finally { await tgt.close(); }
    }
  }
  if (/^(COPY|INSERT)$/.test(p.action || '') && (Number(p.parallelTables) || 1) === 1) issues.push({ id: 'parallel', level: 'info', title: 'Данные будут загружаться по одной таблице', fixes: [{ id: 'p4', title: 'Загружать 4 таблицы параллельно (-P 4)', patch: { parallelTables: 4 } }] });
  return { issues, facts };
}

// ---------- догрузка изменений ----------
async function preflightDelta(p) {
  const issues = [], facts = [];
  const src = await tryConnect(p.sourceId, 'Источник', issues), tgt = await tryConnect(p.targetId, 'Приёмник', issues);
  if (!src || !tgt) { await src?.close(); await tgt?.close(); return { issues, facts }; }
  try {
    const A = await loadMeta(src, p.sourceSchema, {}, null), B = await loadMeta(tgt, p.targetSchema, {}, null);
    const mapA = new Map(A.tables.map(t => [K(t.name), t])), mapB = new Map(B.tables.map(t => [K(t.name), t]));
    const noKey = [], noIdx = [], nulls = [], noCol = [], strKey = [], upsertFix = [];
    for (const t of p.tables || []) {
      const ta = mapA.get(K(t.source)), tb = mapB.get(K(t.target || t.source));
      if (!ta || !tb) { issues.push({ id: `missing:${t.source}`, level: 'error', blocking: true, title: `Таблица ${t.source} не найдена в ${!ta ? 'источнике' : 'приёмнике'}`, fixes: [] }); continue; }
      const key = (ta.pk || (ta.uniques || [])[0] || {}).columns || [];
      if (!key.length) noKey.push(ta.name);
      const keyB = (tb.pk || (tb.uniques || [])[0] || {}).columns || [];
      if (key.length && !keyB.length) upsertFix.push({ tb, key });
      const mode = t.mode || p.mode || 'column';
      if (mode === 'column') {
        const col = t.column || p.column;
        const ca = col && ta.columns.find(c => K(c.name) === K(col));
        if (!ca) { noCol.push(`${ta.name}: ${col || '(не задана)'}`); continue; }
        const indexed = (ta.indexes || []).some(i => i.columns && K(i.columns[0]) === K(ca.name)) || (ta.pk && K(ta.pk.columns[0]) === K(ca.name));
        if (!indexed && (ta.rowEstimate || 0) > 100000) noIdx.push({ t: ta.name, c: ca.name, rows: ta.rowEstimate });
        if (ca.nullable) {
          const r = await one(src, `SELECT COUNT(*) AS n FROM ${src.qualify(p.sourceSchema, ta.name)} WHERE ${src.quote(ca.name)} IS NULL`, src.type === 'oracle' ? {} : [], []);
          const n = r && r[0] ? Number(r[0].n) : 0;
          if (n) nulls.push(`${ta.name}.${ca.name}: ${fmtRows(n)} строк с NULL`);
        }
      } else if (mode === 'key') {
        const kc = key.length === 1 && ta.columns.find(c => K(c.name) === K(key[0]));
        if (!kc || !['int', 'numeric', 'datetime', 'date'].includes(kc.family)) strKey.push(ta.name);
      }
    }
    if (noCol.length) issues.push({ id: 'nocol', level: 'error', blocking: true, title: 'Не найдена колонка даты изменения', list: noCol, fixes: [] });
    if (noKey.length) issues.push({ id: 'nokey', level: 'error', blocking: true, title: `Таблицы без первичного или уникального ключа: ${noKey.join(', ')}`, details: 'Без ключа нельзя понять, какую строку обновлять — догрузка изменений для них невозможна. Перенесите их целиком («Перелив», режим TRUNCATE).', fixes: [] });
    if (upsertFix.length) issues.push({ id: 'upsert', level: 'error', blocking: true, title: `В приёмнике у таблиц нет ключа для обновления: ${upsertFix.map(x => x.tb.name).join(', ')}`, details: 'INSERT … ON CONFLICT / MERGE требуют первичного или уникального ключа в приёмнике.',
      fixes: [{ id: 'pk', title: 'Создать первичные ключи в приёмнике по ключу источника', default: true, patch: { preSql: upsertFix.map(x => ({ connId: p.targetId, title: `PK ${x.tb.name}`,
        sql: `ALTER TABLE ${tgt.qualify(p.targetSchema, x.tb.name)} ADD PRIMARY KEY (${x.key.map(c => tgt.quote(tgt.normName(c))).join(', ')})` })) } }] });
    if (strKey.length) issues.push({ id: 'strkey', level: 'error', blocking: true, title: `Режим «по ключу» не подходит: ${strKey.join(', ')}`, details: 'Нужен один числовой ключ или дата. Для строковых ключей порядок зависит от правил сортировки базы.', fixes: [{ id: 'col', title: 'Использовать режим «по колонке даты изменения»', patch: { mode: 'column' } }] });
    if (noIdx.length) issues.push({ id: 'index', level: 'warning', title: `Нет индекса по колонке даты изменения: ${noIdx.length} больших табл.`, details: 'Каждая догрузка будет читать таблицу целиком. Создайте индексы в источнике заранее (в рабочее время это нагрузит базу):',
      sql: noIdx.map(x => src.type === 'oracle' ? `CREATE INDEX ${src.quote(`IX_${x.t}_${x.c}`.slice(0, 30).toUpperCase())} ON ${src.qualify(p.sourceSchema, x.t)} (${src.quote(x.c)}) ONLINE;` : `CREATE INDEX CONCURRENTLY ON ${src.qualify(p.sourceSchema, x.t)} (${src.quote(x.c)});`).join('\n'), fixes: [] });
    if (nulls.length) issues.push({ id: 'nulls', level: 'warning', title: 'В колонке даты изменения есть NULL', details: 'Такие строки догрузка по дате никогда не увидит. Обычно это строки, вставленные до появления колонки — перенесите их основным переносом.', list: nulls, fixes: [] });
    if (!p.checkDeletes) issues.push({ id: 'deletes', level: 'info', title: 'Удалённые в источнике строки не отслеживаются', details: 'По дате изменения удаления не видны.', fixes: [{ id: 'on', title: 'Искать удалённые строки (сравнение ключей)', patch: { checkDeletes: true } }] });
    if (p.since) {
      const ago = (Date.now() - new Date(String(p.since).replace(' ', 'T')).getTime()) / 864e5;
      if (ago > 60) issues.push({ id: 'since', level: 'warning', title: `«С какого момента» — ${Math.round(ago)} дней назад`, details: 'Догрузка будет почти полным переносом. Укажите время начала основного переноса (с запасом в несколько минут).', fixes: [] });
      if (ago < 0) issues.push({ id: 'since', level: 'error', blocking: true, title: '«С какого момента» в будущем', fixes: [] });
    }
  } finally { await src.close(); await tgt.close(); }
  return { issues, facts };
}

// ---------- сравнение данных ----------
async function preflightDataCompare(p) {
  const issues = [], facts = [];
  const src = await tryConnect(p.sourceId, 'Источник', issues), tgt = await tryConnect(p.targetId, 'Приёмник', issues);
  if (!src || !tgt) { await src?.close(); await tgt?.close(); return { issues, facts }; }
  try {
    const A = await loadMeta(src, p.sourceSchema, {}, null), B = await loadMeta(tgt, p.targetSchema, {}, null);
    const mapB = new Map(B.tables.map(t => [K(t.name), t]));
    const specs = p.tables && p.tables.length ? p.tables.map(x => (typeof x === 'string' ? { source: x } : x)) : A.tables.filter(t => mapB.has(K(t.name))).map(t => ({ source: t.name }));
    const mapA = new Map(A.tables.map(t => [K(t.name), t]));
    const noKey = [], suggestions = {}, big = [], floats = [];
    for (const s of specs) {
      const ta = mapA.get(K(s.source)), tb = mapB.get(K(s.target || s.source));
      if (!ta || !tb) continue;
      if (!s.keyColumns && !ta.pk && !(ta.uniques || []).length && !tb.pk && !(tb.uniques || []).length) {
        noKey.push(ta.name);
        // кандидат в ключ: NOT NULL колонка, у которой все значения различны (только для небольших таблиц)
        if ((ta.rowEstimate || 0) <= 2e6) {
          const cands = ta.columns.filter(c => !c.nullable && ['int', 'numeric', 'string'].includes(c.family) && /(^id$|_id$|^id_|code|kod|num|nom)/i.test(c.name)).slice(0, 3);
          for (const c of cands) {
            const r = await one(src, `SELECT COUNT(*) AS n, COUNT(DISTINCT ${src.quote(c.name)}) AS d FROM ${src.qualify(p.sourceSchema, ta.name)}`, src.type === 'oracle' ? {} : [], []);
            if (r && r[0] && Number(r[0].n) > 0 && Number(r[0].n) === Number(r[0].d)) { suggestions[ta.name] = [c.name]; break; }
          }
        }
      }
      if ((ta.rowEstimate || 0) > 5e6) big.push(`${ta.name} (~${fmtRows(ta.rowEstimate)})`);
      if (ta.columns.some(c => c.family === 'float') || tb.columns.some(c => c.family === 'float')) floats.push(ta.name);
    }
    facts.push({ label: 'Таблиц', value: specs.length });
    if (noKey.length) {
      const sug = Object.keys(suggestions);
      issues.push({ id: 'nokey', level: sug.length ? 'warning' : 'info', title: `Таблицы без ключа: ${noKey.length}`, details: 'Они сравниваются как наборы строк: видно, что строки отличаются, но не какие именно колонки.' + (sug.length ? ' Найдены колонки с уникальными значениями — их можно использовать как ключ:' : ''),
        list: noKey.map(n => `${n}${suggestions[n] ? ` → ключ ${suggestions[n].join(', ')}` : ''}`),
        fixes: sug.length ? [{ id: 'keys', title: `Использовать найденные ключи (${sug.length} табл.)`, default: true, patch: { keyHints: suggestions } }] : [] });
    }
    if (big.length) issues.push({ id: 'big', level: 'info', title: `Большие таблицы: ${big.length}`, details: 'Построчное сравнение займёт время. Быстрее начать со «Сверки по агрегатам» (Проверки) или ограничить период.', list: big, fixes: [] });
    if (floats.length && !p.absTolerance && !p.relTolerance) issues.push({ id: 'float', level: 'warning', title: `Плавающая точка (FLOAT, BINARY_DOUBLE, double precision): ${floats.length} табл.`, details: 'Значения после переноса могут отличаться в последних знаках.',
      fixes: [{ id: 'tol', title: 'Допуск 1e-9 относительно величины значений', default: true, patch: { relTolerance: 1e-9 } }] });
    if (src.type !== tgt.type && p.emptyAsNull === false) issues.push({ id: 'empty', level: 'warning', title: 'Пустые строки не приравниваются к NULL', details: 'В Oracle \'\' — это NULL, поэтому в паре Oracle ⇄ PostgreSQL будет много ложных отличий.', fixes: [{ id: 'on', title: 'Считать \'\' равным NULL', default: true, patch: { emptyAsNull: true } }] });
  } finally { await src.close(); await tgt.close(); }
  return { issues, facts };
}

module.exports = { preflightOra2pg, preflightDelta, preflightDataCompare };
