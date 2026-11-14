'use strict';
// Аудит здоровья базы: обслуживание, переполнение последовательностей, место, невалидные объекты,
// «сироты» (строки без родителя там, где связь есть по смыслу, но нет внешнего ключа) и т.п.
const { connect } = require('../db');
const { getConnection } = require('../lib/store');
const { loadMeta } = require('../meta');
const { adviseFromMeta } = require('./perf');

const K = x => String(x || '').toLowerCase();
const mb = b => Math.round(Number(b || 0) / 1048576);

/** Кандидаты связей без внешнего ключа: колонка <таблица>_id / id_<таблица> → таблица с одноколоночным PK. */
function implicitRefs(meta) {
  const byName = new Map(meta.tables.filter(t => t.pk && t.pk.columns.length === 1).map(t => [K(t.name), t]));
  const out = [];
  for (const t of meta.tables) {
    const fkCols = new Set((t.fks || []).flatMap(f => f.columns.map(K)));
    for (const c of t.columns) {
      const n = K(c.name);
      if (fkCols.has(n) || (t.pk && t.pk.columns.map(K).includes(n) && t.pk.columns.length === 1)) continue;
      const m = /^(?:id_?)?(.+?)(?:_?id)$/.exec(n);
      if (!m || m[1] === n) continue;
      const cand = [m[1], m[1] + 's', m[1].replace(/s$/, ''), 's_' + m[1], 'sp_' + m[1], 'spr_' + m[1]].map(x => byName.get(x)).find(Boolean);
      if (cand && cand !== t && ['int', 'numeric', 'string'].includes(c.family)) out.push({ table: t.name, column: c.name, refTable: cand.name, refColumn: cand.pk.columns[0] });
    }
  }
  return out;
}

async function runHealth(p, ctx) {
  const conn = getConnection(p.connId);
  const db = await connect(conn);
  const f = [];
  const add = (group, level, object, text, sql) => f.push({ group, level, object, text, sql: sql || null });
  try {
    ctx.progress(0, 0, 'Структура…');
    const meta = await loadMeta(db, p.schema, {}, null);
    const S = p.schema;
    const qq = t => `${db.quote(meta.schema)}.${db.quote(t)}`;
    // структура и индексы (из советов по индексам — без статистики)
    for (const a of adviseFromMeta(meta, db, null)) if (a.kind !== 'dup') add(a.kind === 'nopk' ? 'Структура' : 'Индексы', a.level, a.table, a.text, a.sql);

    if (db.type === 'postgres') {
      ctx.progress(0, 0, 'Обслуживание таблиц…');
      const st = await db.query(`
        SELECT relname AS t, n_live_tup AS live, n_dead_tup AS dead, last_vacuum, last_autovacuum, last_analyze, last_autoanalyze, n_mod_since_analyze AS mods,
               pg_total_relation_size(relid) AS bytes
        FROM pg_stat_user_tables WHERE schemaname = $1`, [S]);
      for (const r of st) {
        const live = Number(r.live), dead = Number(r.dead);
        if (dead > 10000 && dead > live * 0.2) add('Обслуживание', dead > live ? 'error' : 'warning', r.t, `Мёртвых строк ${dead} при живых ${live} (${Math.round(dead / Math.max(live, 1) * 100)} %) — таблица раздута, autovacuum не справляется`, `VACUUM (ANALYZE) ${qq(r.t)};`);
        if (!r.last_analyze && !r.last_autoanalyze && live + Number(r.mods) > 1000) add('Обслуживание', 'warning', r.t, 'Статистика ни разу не собиралась — планировщик ошибается в оценках (типично сразу после загрузки данных)', `ANALYZE ${qq(r.t)};`);
        else if (Number(r.mods) > Math.max(live * 0.5, 50000)) add('Обслуживание', 'info', r.t, `С последнего ANALYZE изменено ${r.mods} строк`, `ANALYZE ${qq(r.t)};`);
      }
      const seqs = await db.query(`SELECT sequencename AS s, last_value, max_value, increment_by FROM pg_sequences WHERE schemaname = $1 AND last_value IS NOT NULL`, [S]).catch(() => []);
      for (const s of seqs) {
        const used = Number(s.last_value) / Number(s.max_value);
        if (used > 0.7) add('Последовательности', used > 0.9 ? 'error' : 'warning', s.s, `Использовано ${Math.round(used * 100)} % диапазона (${s.last_value} из ${s.max_value})`, `ALTER SEQUENCE ${qq(s.s)} AS bigint MAXVALUE 9223372036854775807;`);
      }
      // integer-колонки с автонумерацией близко к пределу
      const intId = await db.query(`
        SELECT c.relname AS t, a.attname AS col, pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) AS seq
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND a.attnum > 0 AND NOT a.attisdropped AND a.atttypid = 'int4'::regtype AND c.relkind = 'r'
          AND (a.attidentity <> '' OR pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) IS NOT NULL)`, [S]).catch(() => []);
      for (const r of intId) {
        const v = await db.query(`SELECT last_value FROM ${r.seq}`).catch(() => []);
        if (v[0] && Number(v[0].last_value) > 2147483647 * 0.7) add('Последовательности', 'error', `${r.t}.${r.col}`, `Колонка integer, автонумерация дошла до ${v[0].last_value} — скоро переполнение (максимум 2 147 483 647)`, `ALTER TABLE ${qq(r.t)} ALTER COLUMN ${db.quote(r.col)} TYPE bigint;`);
      }
      const age = await db.query(`SELECT age(datfrozenxid) AS a FROM pg_database WHERE datname = current_database()`);
      if (Number(age[0].a) > 1e9) add('База', Number(age[0].a) > 1.5e9 ? 'error' : 'warning', 'transaction ID', `Возраст транзакций ${age[0].a} из 2·10⁹ — при достижении предела база остановит запись (wraparound). Нужен VACUUM FREEZE`, 'VACUUM (FREEZE, VERBOSE);');
      const idle = await db.query(`SELECT count(*)::int AS n, max(extract(epoch FROM now() - xact_start))::int AS s FROM pg_stat_activity WHERE state LIKE 'idle in transaction%' AND datname = current_database()`).catch(() => [{ n: 0 }]);
      if (idle[0].n) add('Сеансы', idle[0].s > 600 ? 'error' : 'warning', `${idle[0].n} сеанс(ов)`, `Открытые транзакции без активности (до ${idle[0].s} с) — держат блокировки и мешают VACUUM. См. «Активность»`, 'ALTER DATABASE … SET idle_in_transaction_session_timeout = \'10min\';');
      const conns = await db.query(`SELECT (SELECT count(*) FROM pg_stat_activity)::int AS n, setting::int AS max FROM pg_settings WHERE name = 'max_connections'`);
      if (conns[0].n > conns[0].max * 0.8) add('Сеансы', 'warning', 'подключения', `Занято ${conns[0].n} из ${conns[0].max} подключений — нужен пул соединений (pgbouncer)`);
      const hit = await db.query(`SELECT round(100.0 * sum(blks_hit) / nullif(sum(blks_hit) + sum(blks_read), 0), 1) AS h FROM pg_stat_database WHERE datname = current_database()`);
      if (hit[0].h != null && Number(hit[0].h) < 95) add('База', 'info', 'кэш', `Попадание в кэш ${hit[0].h} % (норма > 99 %) — мало shared_buffers или много полных чтений`);
      const trg = await db.query(`SELECT c.relname AS t, t.tgname AS g FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal AND t.tgenabled = 'D'`, [S]);
      for (const r of trg) add('Структура', 'warning', `${r.t}.${r.g}`, 'Триггер отключён (возможно, остался после загрузки)', `ALTER TABLE ${qq(r.t)} ENABLE TRIGGER ${db.quote(r.g)};`);
      const nv = await db.query(`SELECT conrelid::regclass::text AS t, conname AS c FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 AND NOT convalidated`, [S]);
      for (const r of nv) add('Структура', 'warning', `${r.t}.${r.c}`, 'Ограничение не проверено (NOT VALID) — старые строки могут его нарушать', `ALTER TABLE ${r.t} VALIDATE CONSTRAINT ${db.quote(r.c)};`);
      const unl = await db.query(`SELECT relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relpersistence = 'u' AND c.relkind = 'r'`, [S]);
      for (const r of unl) add('Структура', 'warning', r.t, 'UNLOGGED-таблица: после сбоя сервера будет пустой (часто остаётся после ускоренной загрузки)', `ALTER TABLE ${qq(r.t)} SET LOGGED;`);
      const big = st.filter(r => Number(r.bytes) > 1073741824).sort((a, b) => b.bytes - a.bytes).slice(0, 10);
      for (const r of big) add('Место', 'info', r.t, `${(Number(r.bytes) / 1073741824).toFixed(1)} ГБ вместе с индексами`);
    } else {
      const O = S.toUpperCase();
      ctx.progress(0, 0, 'Объекты и статистика…');
      const inv = await db.query(`SELECT object_type AS t, object_name AS n FROM all_objects WHERE owner = :o AND status = 'INVALID'`, { o: O });
      for (const r of inv) add('Код', 'error', `${r.t} ${r.n}`, 'Объект невалиден', `ALTER ${r.t.replace(' BODY', '')} ${db.quote(O)}.${db.quote(r.n)} COMPILE${/BODY/.test(r.t) ? ' BODY' : ''};`);
      const stale = await db.query(`SELECT table_name AS t, last_analyzed AS d, stale_stats AS s, num_rows FROM all_tab_statistics WHERE owner = :o AND object_type = 'TABLE' AND (stale_stats = 'YES' OR last_analyzed IS NULL)`, { o: O }).catch(() => []);
      for (const r of stale) add('Обслуживание', 'warning', r.t, r.d ? 'Статистика устарела' : 'Статистика не собиралась', `BEGIN DBMS_STATS.GATHER_TABLE_STATS('${O}', '${r.t}'); END;`);
      const seqs = await db.query(`SELECT sequence_name AS s, last_number, max_value FROM all_sequences WHERE sequence_owner = :o AND cycle_flag = 'N'`, { o: O });
      for (const s of seqs) { const u = Number(s.last_number) / Number(s.max_value); if (u > 0.7) add('Последовательности', u > 0.9 ? 'error' : 'warning', s.s, `Использовано ${Math.round(u * 100)} % диапазона`, `ALTER SEQUENCE ${db.quote(O)}.${db.quote(s.s)} MAXVALUE ${String(BigInt(s.max_value) * 10n)};`); }
      const dis = await db.query(`SELECT table_name AS t, constraint_name AS c, constraint_type AS ty FROM all_constraints WHERE owner = :o AND status = 'DISABLED' AND table_name NOT LIKE 'BIN$%'`, { o: O });
      for (const r of dis) add('Структура', 'warning', `${r.t}.${r.c}`, 'Ограничение отключено', `ALTER TABLE ${db.quote(O)}.${db.quote(r.t)} ENABLE VALIDATE CONSTRAINT ${db.quote(r.c)};`);
      const nvl = await db.query(`SELECT table_name AS t, constraint_name AS c FROM all_constraints WHERE owner = :o AND status = 'ENABLED' AND validated = 'NOT VALIDATED' AND table_name NOT LIKE 'BIN$%'`, { o: O });
      for (const r of nvl) add('Структура', 'info', `${r.t}.${r.c}`, 'Ограничение включено без проверки старых строк (NOVALIDATE)', `ALTER TABLE ${db.quote(O)}.${db.quote(r.t)} MODIFY CONSTRAINT ${db.quote(r.c)} VALIDATE;`);
      const trg = await db.query(`SELECT trigger_name AS g, table_name AS t FROM all_triggers WHERE owner = :o AND status = 'DISABLED'`, { o: O });
      for (const r of trg) add('Структура', 'warning', `${r.t}.${r.g}`, 'Триггер отключён', `ALTER TRIGGER ${db.quote(O)}.${db.quote(r.g)} ENABLE;`);
      const unus = await db.query(`SELECT index_name AS i FROM all_indexes WHERE owner = :o AND status = 'UNUSABLE'`, { o: O });
      for (const r of unus) add('Индексы', 'error', r.i, 'Индекс UNUSABLE — запросы по нему падают или идут полным чтением', `ALTER INDEX ${db.quote(O)}.${db.quote(r.i)} REBUILD ONLINE;`);
      const ts = await db.query(`
        SELECT d.tablespace_name AS ts, SUM(d.bytes) AS bytes, SUM(DECODE(d.autoextensible, 'YES', GREATEST(d.maxbytes, d.bytes), d.bytes)) AS maxb,
               (SELECT NVL(SUM(f.bytes), 0) FROM dba_free_space f WHERE f.tablespace_name = d.tablespace_name) AS free
        FROM dba_data_files d GROUP BY d.tablespace_name`).catch(() => []);
      for (const r of ts) {
        const used = Number(r.bytes) - Number(r.free), pct = used / Number(r.maxb);
        if (pct > 0.8) add('Место', pct > 0.95 ? 'error' : 'warning', r.ts, `Табличное пространство заполнено на ${Math.round(pct * 100)} % с учётом автоувеличения (${mb(used)} из ${mb(r.maxb)} МБ)`, `ALTER TABLESPACE ${db.quote(r.ts)} ADD DATAFILE SIZE 1G AUTOEXTEND ON NEXT 256M MAXSIZE UNLIMITED;`);
      }
      const rb = await db.query(`SELECT COUNT(*) AS n, NVL(SUM(space), 0) AS blocks FROM all_recyclebin WHERE owner = :o`, { o: O }).catch(() => []);
      if (rb[0] && Number(rb[0].n) > 50) add('Место', 'info', 'корзина', `В корзине (RECYCLEBIN) ${rb[0].n} объектов`, 'PURGE RECYCLEBIN;');
      if (!ts.length) ctx.log('Заполнение табличных пространств не проверено: нужны права на DBA_DATA_FILES', 'warning');
    }

    // «сироты»: связь по смыслу без внешнего ключа
    if (p.orphans !== false) {
      const refs = implicitRefs(meta).slice(0, 40);
      for (const [i, r] of refs.entries()) {
        ctx.checkCancel();
        ctx.progress(i, refs.length, `Сироты: ${r.table}.${r.column}`);
        const sql = `SELECT COUNT(*) AS n FROM ${qq(r.table)} c WHERE c.${db.quote(r.column)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${qq(r.refTable)} p WHERE p.${db.quote(r.refColumn)} = c.${db.quote(r.column)})`;
        const n = await db.query(sql, db.type === 'oracle' ? {} : []).then(x => Number(x[0].n)).catch(() => null);
        if (n == null) continue;
        if (n) add('Данные', 'warning', `${r.table}.${r.column}`, `${n} строк ссылаются на несуществующие записи ${r.refTable}.${r.refColumn} (внешнего ключа нет)`, `${sql.replace('COUNT(*) AS n', `c.*`)};`);
        else add('Структура', 'info', `${r.table}.${r.column}`, `Похоже на ссылку на ${r.refTable}, нарушений нет — можно добавить внешний ключ`, `ALTER TABLE ${qq(r.table)} ADD FOREIGN KEY (${db.quote(r.column)}) REFERENCES ${qq(r.refTable)} (${db.quote(r.refColumn)});`);
      }
    }
    const order = { error: 0, warning: 1, info: 2 };
    f.sort((a, b) => order[a.level] - order[b.level]);
    const cnt = l => f.filter(x => x.level === l).length;
    const score = Math.max(0, 100 - cnt('error') * 10 - cnt('warning') * 3 - cnt('info') * 0.5);
    ctx.log(`Аудит: ошибок ${cnt('error')}, предупреждений ${cnt('warning')}, советов ${cnt('info')}`);
    return { summary: { error: cnt('error'), warning: cnt('warning'), info: cnt('info'), score: Math.round(score), tables: meta.tables.length }, findings: f, connection: conn.name, schema: S };
  } finally { await db.close(); }
}

module.exports = { runHealth, implicitRefs };
