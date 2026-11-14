'use strict';
// Производительность: сравнение планов и времени запросов Oracle ⇄ PostgreSQL, советы по индексам.
const crypto = require('crypto');
const { connect } = require('../db');
const { getConnection } = require('../lib/store');
const { loadMeta } = require('../meta');

const K = x => String(x || '').toLowerCase();
const strip = s => String(s || '').trim().replace(/;\s*$/, '');

// ---------- анализ плана PostgreSQL (чистые функции) ----------
function walk(node, fn, depth = 0, parent = null) { fn(node, depth, parent); for (const c of node.Plans || []) walk(c, fn, depth + 1, node); }

function renderPgPlan(root) {
  const lines = [];
  walk(root, (n, d) => {
    const act = n['Actual Rows'] != null ? ` факт ${Math.round(n['Actual Rows'] * (n['Actual Loops'] || 1))}${n['Actual Loops'] > 1 ? ` (циклов ${n['Actual Loops']})` : ''}, ${n['Actual Total Time'] != null ? (n['Actual Total Time'] * (n['Actual Loops'] || 1)).toFixed(1) + ' мс' : ''}` : '';
    const rel = n['Relation Name'] ? ` ${n['Relation Name']}${n.Alias && n.Alias !== n['Relation Name'] ? ' ' + n.Alias : ''}` : '';
    const idx = n['Index Name'] ? ` по ${n['Index Name']}` : '';
    lines.push(`${'  '.repeat(d)}→ ${n['Node Type']}${n['Join Type'] ? ' ' + n['Join Type'] : ''}${rel}${idx}  (оценка ${n['Plan Rows']}${act})`);
    for (const k of ['Index Cond', 'Hash Cond', 'Merge Cond', 'Join Filter', 'Filter', 'Recheck Cond']) if (n[k]) lines.push(`${'  '.repeat(d)}     ${k}: ${n[k]}`);
    if (n['Rows Removed by Filter']) lines.push(`${'  '.repeat(d)}     отброшено фильтром: ${n['Rows Removed by Filter']}`);
    if (n['Sort Method']) lines.push(`${'  '.repeat(d)}     сортировка: ${n['Sort Method']} ${n['Sort Space Used'] || ''} ${n['Sort Space Type'] || ''}`);
    if (n['Hash Batches'] > 1) lines.push(`${'  '.repeat(d)}     хеш-таблица: пакетов ${n['Hash Batches']}`);
  });
  return lines.join('\n');
}

const FILTER_COL = /\(?"?([a-z_][a-z0-9_$]*)"?\)?(?:::[a-z ]+)?\s*(?:=|<>|<=|>=|<|>|~~\*?|!~~|IS\s|=\s*ANY|IN\s*\()/gi;
const SKIP_WORDS = new Set(['and', 'or', 'not', 'null', 'true', 'false', 'any', 'all', 'case', 'when', 'then', 'else', 'end', 'select']);
function filterColumns(expr) {
  const out = new Set(); let m;
  const e = String(expr || '').replace(/::[a-z_ ]+(\([\d, ]+\))?(\[\])?/gi, '').replace(/'(?:[^']|'')*'/g, "''");
  FILTER_COL.lastIndex = 0;
  while ((m = FILTER_COL.exec(e))) if (!SKIP_WORDS.has(m[1].toLowerCase()) && !/^\d/.test(m[1])) out.add(m[1].toLowerCase());
  return [...out];
}

/** Находки по плану PostgreSQL (EXPLAIN ANALYZE, FORMAT JSON). schema — для текста CREATE INDEX. */
function analyzePgPlan(plan, schema) {
  const f = [];
  const add = (kind, level, text, sql) => { if (!f.some(x => x.text === text)) f.push({ kind, level, text, sql }); };
  const q = n => `"${n}"`;
  walk(plan.Plan, (n, d, parent) => {
    const loops = n['Actual Loops'] || 1;
    const actual = n['Actual Rows'] != null ? n['Actual Rows'] * loops : null;
    const removed = (n['Rows Removed by Filter'] || 0) * loops;
    const rel = n['Relation Name'];
    const hasFunc = /\b(upper|lower|trunc|date_trunc|coalesce|to_char|substr|substring|btrim|nvl)\s*\(/i.test(n.Filter || '');
    if (n['Node Type'] === 'Seq Scan' && rel && n.Filter && !hasFunc && removed > 10000 && removed > 9 * (actual || 0)) {
      const cols = filterColumns(n.Filter);
      add('seqscan', 'warning', `${rel}: читается целиком, фильтр отбрасывает ${removed} строк из ${removed + (actual || 0)} — нужен индекс${cols.length ? ` по ${cols.join(', ')}` : ''}`,
        cols.length ? `CREATE INDEX CONCURRENTLY ON ${q(schema)}.${q(rel)} (${cols.slice(0, 3).map(q).join(', ')});` : null);
    }
    for (const k of ['Filter', 'Index Cond', 'Hash Cond', 'Merge Cond', 'Join Filter']) {
      const e = n[k]; if (!e) continue;
      const cast = /\(\(?"?([a-z_][a-z0-9_]*)"?\)?::(numeric|bigint|integer|double precision|timestamp[a-z ]*|date)\b/i.exec(e);
      if (cast && (rel || k !== 'Filter')) add('cast', 'warning', `${rel || n['Node Type']}: колонка ${cast[1]} приводится к ${cast[2]} в условии «${k}» — индекс по ней не используется. Обычно после миграции типы связанных колонок различаются (integer и numeric, varchar и text) — выровняйте типы.`, null);
      const fn = /\b(upper|lower|trunc|date_trunc|coalesce|to_char|substr|substring|btrim|nvl)\s*\(\s*\(?"?([a-z_][a-z0-9_]*)"?/i.exec(e);
      if (fn && n['Node Type'] === 'Seq Scan' && removed > 10000) add('func', 'warning', `${rel}: условие с функцией ${fn[1]}(${fn[2]}) — обычный индекс не поможет, нужен индекс по выражению`, `CREATE INDEX CONCURRENTLY ON ${q(schema)}.${q(rel)} ((${fn[1].toLowerCase()}(${q(fn[2])})));`);
    }
    if (actual != null && n['Plan Rows'] > 0) {
      const ratio = Math.max(actual, 1) / Math.max(n['Plan Rows'], 1);
      if ((ratio > 100 || ratio < 0.01) && Math.max(actual, n['Plan Rows']) > 1000)
        add('estimate', 'warning', `${rel || n['Node Type']}: оценка строк ${n['Plan Rows']}, фактически ${Math.round(actual)} — статистика устарела или неточна (после загрузки данных нужен ANALYZE)`, rel ? `ANALYZE ${q(schema)}.${q(rel)};` : null);
    }
    if (/external/i.test(n['Sort Method'] || '')) add('sort', 'info', `Сортировка на диске (${n['Sort Space Used']} кБ) — не хватает work_mem`, `SET work_mem = '${Math.ceil((n['Sort Space Used'] || 4096) / 1024) * 2 + 4}MB';  -- или в postgresql.conf`);
    if (n['Hash Batches'] > 1) add('hash', 'info', `Хеш-соединение в ${n['Hash Batches']} пакетов (на диске) — не хватает work_mem`, null);
    if (n['Node Type'] === 'Nested Loop' && n.Plans && n.Plans[1]) {
      const inner = n.Plans[1];
      if ((inner['Actual Loops'] || 0) > 1000 && /Seq Scan/.test(inner['Node Type']) && inner['Relation Name'])
        add('nlseq', 'error', `Вложенный цикл: таблица ${inner['Relation Name']} читается целиком ${inner['Actual Loops']} раз — нет индекса по колонке соединения`, null);
    }
  });
  if (plan['JIT'] && plan['JIT'].Timing && plan['JIT'].Timing.Total > 100) add('jit', 'info', `Компиляция JIT заняла ${Math.round(plan['JIT'].Timing.Total)} мс — для коротких запросов её лучше отключить (jit = off)`, 'SET jit = off;');
  return f;
}

// ---------- задача «Сравнение планов» ----------
async function explainOracle(db, schema, sql) {
  if (schema) await db.exec(`ALTER SESSION SET CURRENT_SCHEMA = ${db.quote(schema.toUpperCase())}`);
  const t0 = process.hrtime.bigint();
  let hinted = sql, actual = false;
  if (/^\s*select\s/i.test(sql) && !/gather_plan_statistics/i.test(sql)) hinted = sql.replace(/^\s*select\s/i, 'SELECT /*+ gather_plan_statistics */ ');
  const r = await db.fetchAll(hinted, 100000);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  let plan = null;
  try {
    const x = await db.query(`SELECT plan_table_output AS l FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, 'ALLSTATS LAST'))`);
    if (x.length > 3 && !x.some(l => /cannot fetch plan|could not find/i.test(l.l || ''))) { plan = x.map(l => l.l).join('\n'); actual = true; }
  } catch { /* нет прав на v$sql_plan */ }
  if (!plan) {
    const id = 'DBCMP' + crypto.randomBytes(3).toString('hex');
    await db.exec(`EXPLAIN PLAN SET STATEMENT_ID = '${id}' FOR ${sql}`);
    plan = (await db.query(`SELECT plan_table_output AS l FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, '${id}', 'TYPICAL'))`)).map(l => l.l).join('\n');
    await db.exec(`DELETE FROM plan_table WHERE statement_id = '${id}'`).catch(() => {});
  }
  const findings = [];
  if (/TABLE ACCESS FULL/i.test(plan)) findings.push({ kind: 'full', level: 'info', text: 'В плане Oracle есть полное чтение таблиц (TABLE ACCESS FULL)' });
  return { ms, rows: r.rows.length, plan, actual, findings };
}
async function explainPg(db, schema, sql, analyze) {
  if (schema) await db.exec(`SET search_path = ${db.quote(schema)}, public`);
  await db.exec('BEGIN');
  try {
    const r = await db.query(`EXPLAIN (${analyze ? 'ANALYZE, BUFFERS, ' : ''}FORMAT JSON) ${sql}`);
    const v = r[0]['QUERY PLAN'] ?? r[0]['query plan'];
    const plan = (typeof v === 'string' ? JSON.parse(v) : v)[0];
    const findings = analyze ? analyzePgPlan(plan, schema || 'public') : [];
    if (/\/\*\+/.test(sql)) findings.push({ kind: 'hints', level: 'info', text: 'Подсказки Oracle (/*+ … */) в PostgreSQL игнорируются (нужно расширение pg_hint_plan)' });
    return { ms: plan['Execution Time'] != null ? plan['Execution Time'] + (plan['Planning Time'] || 0) : null, planningMs: plan['Planning Time'], rows: plan.Plan['Actual Rows'] != null ? plan.Plan['Actual Rows'] : null, plan: renderPgPlan(plan.Plan), findings, raw: plan };
  } finally { await db.exec('ROLLBACK').catch(() => {}); }
}
async function explainAny(db, schema, sql, analyze) {
  return db.type === 'oracle' ? explainOracle(db, schema, sql) : explainPg(db, schema, sql, analyze);
}

async function runPlanCompare(p, ctx) {
  const src = await connect(getConnection(p.sourceId));
  const tgt = p.targetId ? await connect(getConnection(p.targetId)) : null;
  const results = [];
  try {
    for (const [i, q] of (p.queries || []).entries()) {
      ctx.checkCancel();
      const title = q.title || `Запрос ${i + 1}`;
      ctx.progress(i, p.queries.length, title);
      const item = { title, sourceSql: strip(q.sourceSql || q.sql), targetSql: strip(q.targetSql || q.sourceSql || q.sql) };
      try { item.source = await explainAny(src, p.sourceSchema, item.sourceSql, p.analyze !== false); } catch (e) { item.source = { error: e.message.split('\n')[0] }; }
      if (tgt) { try { item.target = await explainAny(tgt, p.targetSchema, item.targetSql, p.analyze !== false); } catch (e) { item.target = { error: e.message.split('\n')[0] }; } }
      const a = item.source && item.source.ms, b = item.target && item.target.ms;
      item.ratio = a && b ? b / a : null;
      item.findings = [...((item.source && item.source.findings) || []).map(x => ({ ...x, side: 'источник' })), ...((item.target && item.target.findings) || []).map(x => ({ ...x, side: 'приёмник' }))];
      item.status = item.source.error || (item.target && item.target.error) ? 'error' : item.ratio && item.ratio > 2 && b > 50 ? 'slower' : item.findings.some(x => x.level !== 'info') ? 'warning' : 'ok';
      if (item.target && item.target.raw) delete item.target.raw;
      results.push(item);
      ctx.log(`${title}: ${a != null ? a.toFixed(1) : '—'} мс → ${b != null ? b.toFixed(1) : '—'} мс${item.ratio ? ` (×${item.ratio.toFixed(2)})` : ''}, находок ${item.findings.length}`, item.status === 'ok' ? 'info' : 'warning');
    }
  } finally { await src.close(); if (tgt) await tgt.close(); }
  return { summary: { queries: results.length, slower: results.filter(r => r.status === 'slower').length, warning: results.filter(r => r.status === 'warning').length, error: results.filter(r => r.status === 'error').length,
    findings: results.reduce((s, r) => s + r.findings.length, 0) }, results };
}

// ---------- советы по индексам ----------
const prefixOf = (a, b) => a.length <= b.length && a.every((c, i) => K(c) === K(b[i]));

/** Чистая часть: по метаданным — FK без индекса, дубли, таблицы без PK, индексы, которых нет относительно другой базы. */
function adviseFromMeta(meta, db, other) {
  const out = [];
  const qual = t => `${db.quote(meta.schema)}.${db.quote(t)}`;
  for (const t of meta.tables) {
    const idx = [...t.indexes.map(i => ({ ...i })), ...(t.pk ? [{ name: t.pk.name || 'PK', columns: t.pk.columns, unique: true, pk: true }] : []), ...(t.uniques || []).map(u => ({ name: u.name, columns: u.columns, unique: true, constraint: true }))];
    if (!t.pk) out.push({ kind: 'nopk', level: 'warning', table: t.name, text: 'Нет первичного ключа: репликация, сравнение данных и многие ORM работают плохо или медленно' });
    for (const fk of t.fks || []) {
      if (!idx.some(i => prefixOf(fk.columns, i.columns)))
        out.push({ kind: 'fk', level: 'warning', table: t.name, text: `Внешний ключ ${fk.name} (${fk.columns.join(', ')}) → ${fk.refTable} без индекса: удаление/изменение строк в ${fk.refTable} и соединения медленные, возможны блокировки`,
          sql: db.type === 'postgres' ? `CREATE INDEX CONCURRENTLY ON ${qual(t.name)} (${fk.columns.map(c => db.quote(c)).join(', ')});` : `CREATE INDEX ${db.quote(`IX_${t.name}_${fk.columns[0]}`.slice(0, 30).toUpperCase())} ON ${qual(t.name)} (${fk.columns.map(c => db.quote(c)).join(', ')}) ONLINE;` });
    }
    const plain = idx.filter(i => !i.pk && !i.constraint && !/function|expr/i.test(i.kind || '') && !(i.columns || []).some(c => /\(/.test(c)));
    for (const a of plain) {
      const dup = idx.find(b => b !== a && b.name !== a.name && (K(b.columns.join()) === K(a.columns.join()) ? (b.unique || b.pk || b.name < a.name) : prefixOf(a.columns, b.columns)) && !(a.unique && !b.unique));
      if (dup) out.push({ kind: 'dup', level: 'info', table: t.name, index: a.name, text: `Индекс ${a.name} (${a.columns.join(', ')}) ${K(dup.columns.join()) === K(a.columns.join()) ? 'дублирует' : 'покрывается'} ${dup.pk ? 'первичным ключом' : dup.name} (${dup.columns.join(', ')}) — лишняя запись при каждом изменении`,
        sql: `DROP INDEX ${db.type === 'postgres' ? 'CONCURRENTLY ' : ''}${db.quote(meta.schema)}.${db.quote(a.name)};` });
    }
  }
  if (other) {
    const om = new Map(other.meta.tables.map(t => [K(t.name), t]));
    for (const t of meta.tables) {
      const o = om.get(K(t.name)); if (!o) continue;
      const mine = [...t.indexes, ...(t.pk ? [{ columns: t.pk.columns }] : []), ...(t.uniques || [])];
      for (const i of o.indexes) {
        if ((i.columns || []).some(c => /\(|SYS_NC/i.test(c))) { out.push({ kind: 'expr', level: 'info', table: t.name, text: `В ${other.name} есть функциональный индекс ${i.name} (${i.columns.join(', ')}) — перенесите вручную как индекс по выражению` }); continue; }
        if (mine.some(m => K((m.columns || []).join()) === K(i.columns.join()))) continue;
        const cols = i.columns.map(c => db.quote(db.normName ? db.normName(c) : c));
        out.push({ kind: 'missing', level: 'warning', table: t.name, text: `В ${other.name} есть индекс ${i.name} (${i.columns.join(', ')}), здесь — нет`,
          sql: db.type === 'postgres' ? `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX CONCURRENTLY ON ${qual(t.name)} (${cols.join(', ')});` : `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${db.quote(String(i.name).toUpperCase().slice(0, 30))} ON ${qual(t.name)} (${cols.join(', ')}) ONLINE;` });
      }
    }
  }
  return out;
}

async function runIndexAdvice(p, ctx) {
  const conn = getConnection(p.connId);
  const db = await connect(conn);
  let other = null;
  try {
    ctx.progress(0, 0, 'Чтение структуры…');
    const meta = await loadMeta(db, p.schema, {}, null);
    if (p.compareWithId) {
      const oc = getConnection(p.compareWithId);
      const odb = await connect(oc);
      try { other = { name: `${oc.name} (${p.compareSchema})`, meta: await loadMeta(odb, p.compareSchema, {}, null) }; } finally { await odb.close(); }
    }
    const out = adviseFromMeta(meta, db, other);
    ctx.progress(0, 0, 'Статистика использования…');
    if (db.type === 'postgres') {
      const reset = await db.query(`SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()`).catch(() => []);
      const since = reset[0] && reset[0].stats_reset ? String(reset[0].stats_reset).slice(0, 10) : null;
      const unused = await db.query(`
        SELECT s.relname AS t, s.indexrelname AS i, s.idx_scan, pg_relation_size(s.indexrelid) AS bytes
        FROM pg_stat_user_indexes s JOIN pg_index x ON x.indexrelid = s.indexrelid
        WHERE s.schemaname = $1 AND s.idx_scan = 0 AND NOT x.indisunique AND NOT x.indisprimary
          AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = s.indexrelid)
        ORDER BY bytes DESC`, [p.schema]);
      for (const u of unused) out.push({ kind: 'unused', level: 'info', table: u.t, index: u.i, bytes: Number(u.bytes), text: `Индекс ${u.i} ни разу не использовался${since ? ` с ${since}` : ''} (${Math.round(Number(u.bytes) / 1048576)} МБ). Проверьте на рабочей нагрузке, прежде чем удалять`, sql: `DROP INDEX CONCURRENTLY ${db.quote(p.schema)}.${db.quote(u.i)};` });
      const invalid = await db.query(`SELECT c.relname AS i, t.relname AS t FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT x.indisvalid`, [p.schema]);
      for (const v of invalid) out.push({ kind: 'invalid', level: 'error', table: v.t, index: v.i, text: `Индекс ${v.i} недействителен (прерванный CREATE INDEX CONCURRENTLY) — не используется, но замедляет запись`, sql: `REINDEX INDEX CONCURRENTLY ${db.quote(p.schema)}.${db.quote(v.i)};` });
      const seq = await db.query(`SELECT relname AS t, seq_scan, seq_tup_read, coalesce(idx_scan, 0) AS idx_scan, n_live_tup FROM pg_stat_user_tables WHERE schemaname = $1 AND n_live_tup > 10000 AND seq_tup_read > 1000000 AND seq_scan > coalesce(idx_scan, 0) ORDER BY seq_tup_read DESC LIMIT 30`, [p.schema]);
      for (const s of seq) out.push({ kind: 'seq', level: 'warning', table: s.t, text: `Таблица ${s.t} (${s.n_live_tup} строк) читается целиком: ${s.seq_scan} раз против ${s.idx_scan} обращений по индексу — найдите запросы в «Сравнении планов» или pg_stat_statements` });
      if (since) ctx.log(`Статистика использования накоплена с ${since}`);
    } else {
      const usage = await db.query(`SELECT name AS i, total_access_count AS n FROM dba_index_usage WHERE owner = :o`, { o: p.schema.toUpperCase() }).catch(() => null);
      if (usage) {
        const used = new Set(usage.filter(u => Number(u.n) > 0).map(u => u.i));
        for (const t of meta.tables) for (const i of t.indexes) if (!i.unique && !used.has(i.name)) out.push({ kind: 'unused', level: 'info', table: t.name, index: i.name, text: `Индекс ${i.name} не использовался по данным DBA_INDEX_USAGE`, sql: `DROP INDEX ${db.quote(p.schema.toUpperCase())}.${db.quote(i.name)};` });
      } else ctx.log('DBA_INDEX_USAGE недоступна (нужны права или Oracle 12.2+) — неиспользуемые индексы не определены', 'warning');
      const unusable = await db.query(`SELECT index_name AS i, table_name AS t FROM all_indexes WHERE owner = :o AND status = 'UNUSABLE'`, { o: p.schema.toUpperCase() }).catch(() => []);
      for (const v of unusable) out.push({ kind: 'invalid', level: 'error', table: v.t, index: v.i, text: `Индекс ${v.i} в состоянии UNUSABLE`, sql: `ALTER INDEX ${db.quote(p.schema.toUpperCase())}.${db.quote(v.i)} REBUILD ONLINE;` });
    }
    const order = { error: 0, warning: 1, info: 2 };
    out.sort((a, b) => order[a.level] - order[b.level] || a.table.localeCompare(b.table));
    const by = k => out.filter(x => x.kind === k).length;
    ctx.log(`Советов: ${out.length}`);
    return { summary: { tables: meta.tables.length, advices: out.length, fkNoIndex: by('fk'), duplicates: by('dup'), unused: by('unused'), missing: by('missing'), noPk: by('nopk'), invalid: by('invalid') }, advices: out, connection: conn.name, schema: p.schema };
  } finally { await db.close(); }
}

module.exports = { runPlanCompare, runIndexAdvice, analyzePgPlan, renderPgPlan, filterColumns, adviseFromMeta, explainAny };
