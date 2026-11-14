'use strict';
// Браузер объектов: карточка объекта (колонки, ограничения, индексы, триггеры, зависимости, DDL, код, ошибки, статистика)
// и данные таблицы с постраничным просмотром и правкой строк по первичному ключу.
const { connect } = require('../db');
const { getConnection } = require('../lib/store');
const { loadMeta } = require('../meta');
const { listObjects } = require('../meta/objects');

const K = x => String(x || '').toLowerCase();
async function withDb(connId, fn) { const db = await connect(getConnection(connId)); try { return await fn(db); } finally { await db.close(); } }
const one = async (db, sql, binds, def = null) => { try { return await db.query(sql, binds); } catch { return def; } };

// ---------- DDL ----------
function pgTableDdl(db, schema, t, extra) {
  const q = n => db.quote(n);
  const cols = t.columns.map(c => `  ${q(c.name)} ${c.type}${c.identity ? ` GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY` : ''}${c.default && !c.identity ? ` DEFAULT ${c.default}` : ''}${c.nullable ? '' : ' NOT NULL'}`);
  const out = [`CREATE TABLE ${q(schema)}.${q(t.name)} (\n${[...cols, ...extra.constraints.map(x => `  CONSTRAINT ${q(x.name)} ${x.def}`)].join(',\n')}\n);`];
  for (const i of extra.indexes) out.push(`${i};`);
  for (const c of extra.comments) out.push(c);
  for (const g of extra.triggers) out.push(`${g};`);
  return out.join('\n\n');
}

async function pgDetails(db, schema, type, name) {
  const r = { type, name };
  const rel = `${db.quote(schema)}.${db.quote(name)}`;
  if (['table', 'view', 'mview'].includes(type)) {
    const meta = await loadMeta(db, schema, {}, null);
    const t = [...meta.tables, ...meta.views, ...(meta.mviews || [])].find(x => K(x.name) === K(name));
    const comments = await db.query(`SELECT a.attname AS c, col_description(a.attrelid, a.attnum) AS d FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`, [rel]).catch(() => []);
    const cm = new Map(comments.map(x => [x.c, x.d]));
    r.comment = (await one(db, `SELECT obj_description($1::regclass, 'pg_class') AS d`, [rel], [{}]))[0].d || '';
    if (t && t.columns) r.columns = t.columns.map((c, i) => ({ pos: i + 1, name: c.name, type: c.type, nullable: c.nullable, default: c.default || '', identity: c.identity || '', comment: cm.get(c.name) || '', pk: !!(t.pk && t.pk.columns.includes(c.name)) }));
    else r.columns = (await db.query(`SELECT a.attnum AS pos, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [rel])).map(c => ({ ...c, comment: cm.get(c.name) || '' }));
    if (type === 'table') {
      const cons = await db.query(`SELECT conname AS name, contype AS t, pg_get_constraintdef(oid, true) AS def, convalidated AS valid FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY contype, conname`, [rel]);
      r.constraints = cons.map(c => ({ name: c.name, kind: { p: 'PRIMARY KEY', u: 'UNIQUE', f: 'FOREIGN KEY', c: 'CHECK', x: 'EXCLUDE' }[c.t] || c.t, def: c.def, status: c.valid ? '' : 'NOT VALID' }));
      const idx = await db.query(`SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS def, i.indisunique AS uniq, i.indisvalid AS valid, pg_relation_size(i.indexrelid) AS bytes,
          coalesce(s.idx_scan, 0) AS scans, EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid) AS by_constraint
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid WHERE i.indrelid = $1::regclass ORDER BY c.relname`, [rel]);
      r.indexes = idx.map(i => ({ name: i.name, def: i.def, unique: i.uniq, status: i.valid ? '' : 'INVALID', sizeMb: +(Number(i.bytes) / 1048576).toFixed(2), scans: Number(i.scans), byConstraint: i.by_constraint }));
      const trg = await db.query(`SELECT tgname AS name, pg_get_triggerdef(oid, true) AS def, tgenabled AS en FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal ORDER BY tgname`, [rel]);
      r.triggers = trg.map(g => ({ name: g.name, def: g.def, status: g.en === 'D' ? 'DISABLED' : 'ENABLED' }));
      const st = await one(db, `SELECT n_live_tup AS live, n_dead_tup AS dead, pg_total_relation_size(relid) AS total, pg_relation_size(relid) AS heap, seq_scan, idx_scan, n_tup_ins AS ins, n_tup_upd AS upd, n_tup_del AS del,
          last_vacuum, last_autovacuum, last_analyze, last_autoanalyze FROM pg_stat_user_tables WHERE relid = $1::regclass`, [rel], []);
      if (st && st[0]) { const s = st[0]; r.stats = [['Строк (оценка)', s.live], ['Мёртвых строк', s.dead], ['Размер с индексами', `${(Number(s.total) / 1048576).toFixed(1)} МБ`], ['Размер данных', `${(Number(s.heap) / 1048576).toFixed(1)} МБ`],
        ['Полных чтений', s.seq_scan], ['Чтений по индексу', s.idx_scan], ['Вставлено / изменено / удалено', `${s.ins} / ${s.upd} / ${s.del}`],
        ['Последний VACUUM', s.last_vacuum || s.last_autovacuum || '—'], ['Последний ANALYZE', s.last_analyze || s.last_autoanalyze || '—']].map(([k, v]) => ({ k, v: v == null ? '—' : String(v) })); }
      const colComments = r.columns.filter(c => c.comment).map(c => `COMMENT ON COLUMN ${rel}.${db.quote(c.name)} IS '${c.comment.replace(/'/g, "''")}';`);
      r.ddl = pgTableDdl(db, schema, t, { constraints: cons.map(c => ({ name: c.name, def: c.def })), indexes: idx.filter(i => !i.by_constraint).map(i => i.def), triggers: trg.map(g => g.def),
        comments: [...(r.comment ? [`COMMENT ON TABLE ${rel} IS '${r.comment.replace(/'/g, "''")}';`] : []), ...colComments] });
      r.pk = t.pk ? t.pk.columns : null;
    } else {
      const def = (await db.query(`SELECT pg_get_viewdef($1::regclass, true) AS d`, [rel]))[0].d;
      r.ddl = `CREATE ${type === 'mview' ? 'MATERIALIZED VIEW' : 'OR REPLACE VIEW'} ${rel} AS\n${def}`;
      r.source = def;
    }
  } else if (['function', 'procedure'].includes(type)) {
    const fn = await db.query(`SELECT p.oid, pg_get_functiondef(p.oid) AS def, pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS res, l.lanname AS lang
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang WHERE n.nspname = $1 AND p.proname = $2 ORDER BY p.oid`, [schema, name]);
    r.source = fn.map(f => f.def).join('\n\n');
    r.ddl = r.source;
    r.arguments = fn.map(f => ({ signature: `${name}(${f.args})`, returns: f.res || '', language: f.lang }));
    const chk = await one(db, `SELECT 1 AS x FROM pg_extension WHERE extname = 'plpgsql_check'`, [], []);
    if (chk && chk.length) {
      r.errors = [];
      for (const f of fn.filter(x => x.lang === 'plpgsql')) {
        const e = await one(db, `SELECT level, lineno AS line, message, hint FROM plpgsql_check_function_tb($1::regprocedure)`, [`${schema}.${name}(${f.args})`], []);
        for (const x of e || []) r.errors.push({ line: x.line, level: x.level, text: x.message + (x.hint ? ` (${x.hint})` : '') });
      }
    } else r.errorsNote = 'Проверка кода без выполнения доступна с расширением plpgsql_check';
  } else if (type === 'trigger') {
    const g = await db.query(`SELECT t.tgname AS name, c.relname AS tbl, pg_get_triggerdef(t.oid, true) AS def, p.proname AS fn, pg_get_functiondef(p.oid) AS fdef
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_proc p ON p.oid = t.tgfoid WHERE n.nspname = $1 AND t.tgname = $2`, [schema, name]);
    r.source = g.map(x => `${x.def};\n\n${x.fdef}`).join('\n\n'); r.ddl = r.source;
  } else if (type === 'sequence') {
    const s = await db.query(`SELECT data_type, start_value, min_value, max_value, increment_by, cycle, cache_size, last_value FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2`, [schema, name]);
    if (s[0]) {
      r.stats = Object.entries({ 'Тип': s[0].data_type, 'Текущее значение': s[0].last_value ?? '(ещё не использовалась)', 'Шаг': s[0].increment_by, 'Минимум': s[0].min_value, 'Максимум': s[0].max_value, 'Кэш': s[0].cache_size, 'Цикл': s[0].cycle ? 'да' : 'нет' }).map(([k, v]) => ({ k, v: String(v) }));
      r.ddl = `CREATE SEQUENCE ${rel} AS ${s[0].data_type} INCREMENT BY ${s[0].increment_by} MINVALUE ${s[0].min_value} MAXVALUE ${s[0].max_value} START WITH ${s[0].start_value} CACHE ${s[0].cache_size}${s[0].cycle ? ' CYCLE' : ''};`;
    }
  }
  return r;
}

async function oraDetails(db, schema, type, name) {
  const O = schema.toUpperCase(), N = name;
  const r = { type, name };
  const OT = { table: 'TABLE', view: 'VIEW', mview: 'MATERIALIZED_VIEW', sequence: 'SEQUENCE', package: 'PACKAGE', procedure: 'PROCEDURE', function: 'FUNCTION', trigger: 'TRIGGER', type: 'TYPE' }[type];
  if (['table', 'view', 'mview'].includes(type)) {
    r.columns = (await db.query(`SELECT c.column_id AS pos, c.column_name AS name,
        c.data_type || CASE WHEN c.data_type IN ('VARCHAR2','NVARCHAR2','CHAR','NCHAR','RAW') THEN '(' || c.char_length || DECODE(c.char_used, 'C', ' CHAR', '') || ')'
          WHEN c.data_type = 'NUMBER' AND c.data_precision IS NOT NULL THEN '(' || c.data_precision || ',' || c.data_scale || ')' ELSE '' END AS type,
        DECODE(c.nullable, 'Y', 1, 0) AS nullable, cm.comments AS "comment"
      FROM all_tab_columns c LEFT JOIN all_col_comments cm ON cm.owner = c.owner AND cm.table_name = c.table_name AND cm.column_name = c.column_name
      WHERE c.owner = :o AND c.table_name = :n ORDER BY c.column_id`, { o: O, n: N })).map(c => ({ ...c, nullable: !!Number(c.nullable), comment: c.comment || '' }));
    const tc = await one(db, `SELECT comments AS c FROM all_tab_comments WHERE owner = :o AND table_name = :n`, { o: O, n: N }, []);
    r.comment = tc && tc[0] ? tc[0].c || '' : '';
  }
  if (type === 'table') {
    const cons = await db.query(`SELECT c.constraint_name AS name, c.constraint_type AS t, c.status, c.validated, c.search_condition_vc AS cond, c.r_constraint_name AS rc,
        (SELECT LISTAGG(column_name, ', ') WITHIN GROUP (ORDER BY position) FROM all_cons_columns x WHERE x.owner = c.owner AND x.constraint_name = c.constraint_name) AS cols,
        (SELECT MAX(table_name) FROM all_constraints p WHERE p.owner = c.r_owner AND p.constraint_name = c.r_constraint_name) AS rtable
      FROM all_constraints c WHERE c.owner = :o AND c.table_name = :n ORDER BY c.constraint_type, c.constraint_name`, { o: O, n: N }).catch(() => []);
    r.constraints = cons.filter(c => !(c.t === 'C' && /IS NOT NULL$/.test(c.cond || ''))).map(c => ({ name: c.name, kind: { P: 'PRIMARY KEY', U: 'UNIQUE', R: 'FOREIGN KEY', C: 'CHECK' }[c.t] || c.t,
      def: c.t === 'C' ? `CHECK (${c.cond})` : c.t === 'R' ? `(${c.cols}) → ${c.rtable}` : `(${c.cols})`, status: [c.status !== 'ENABLED' ? c.status : '', c.validated === 'NOT VALIDATED' ? 'NOVALIDATE' : ''].filter(Boolean).join(' ') }));
    r.pk = (cons.find(c => c.t === 'P') || {}).cols ? cons.find(c => c.t === 'P').cols.split(', ') : null;
    const idx = await db.query(`SELECT i.index_name AS name, i.uniqueness AS u, i.status, i.index_type AS it,
        (SELECT LISTAGG(column_name, ', ') WITHIN GROUP (ORDER BY column_position) FROM all_ind_columns x WHERE x.index_owner = i.owner AND x.index_name = i.index_name) AS cols
      FROM all_indexes i WHERE i.table_owner = :o AND i.table_name = :n ORDER BY i.index_name`, { o: O, n: N });
    r.indexes = idx.map(i => ({ name: i.name, def: `${i.u === 'UNIQUE' ? 'UNIQUE ' : ''}${i.it} (${i.cols})`, unique: i.u === 'UNIQUE', status: i.status === 'VALID' ? '' : i.status }));
    r.triggers = (await db.query(`SELECT trigger_name AS name, trigger_type || ' ' || triggering_event AS def, status FROM all_triggers WHERE table_owner = :o AND table_name = :n`, { o: O, n: N })).map(g => ({ name: g.name, def: g.def, status: g.status }));
    const st = await one(db, `SELECT num_rows, blocks, avg_row_len, last_analyzed, stale_stats FROM all_tab_statistics WHERE owner = :o AND table_name = :n AND object_type = 'TABLE'`, { o: O, n: N }, []);
    if (st && st[0]) r.stats = [['Строк (статистика)', st[0].num_rows], ['Блоков', st[0].blocks], ['Средняя длина строки', st[0].avg_row_len], ['Статистика собрана', st[0].last_analyzed], ['Устарела', st[0].stale_stats]].map(([k, v]) => ({ k, v: v == null ? '—' : String(v) }));
  }
  if (['view', 'mview'].includes(type)) {
    const t = await one(db, type === 'view' ? `SELECT text_vc AS t FROM all_views WHERE owner = :o AND view_name = :n` : `SELECT query AS t FROM all_mviews WHERE owner = :o AND mview_name = :n`, { o: O, n: N }, []);
    r.source = t && t[0] ? t[0].t : '';
  }
  if (['package', 'procedure', 'function', 'trigger', 'type'].includes(type)) {
    const src = await db.query(`SELECT type, line, text FROM all_source WHERE owner = :o AND name = :n ORDER BY DECODE(type, 'PACKAGE', 1, 'TYPE', 1, 2), line`, { o: O, n: N });
    const parts = new Map(); for (const s of src) parts.set(s.type, (parts.get(s.type) || '') + s.text);
    r.source = [...parts].map(([t, txt]) => `-- ${t}\nCREATE OR REPLACE ${txt.trim()}\n/`).join('\n\n');
    r.errors = (await db.query(`SELECT type, line, position AS col, text, attribute AS level FROM all_errors WHERE owner = :o AND name = :n ORDER BY sequence`, { o: O, n: N })).map(e => ({ ...e, text: String(e.text).trim() }));
    const st = await db.query(`SELECT object_type AS t, status, TO_CHAR(last_ddl_time, 'YYYY-MM-DD HH24:MI:SS') AS ddl FROM all_objects WHERE owner = :o AND object_name = :n`, { o: O, n: N });
    r.stats = st.map(s => ({ k: s.t, v: `${s.status}, изменён ${s.ddl}` }));
    if (['package', 'procedure', 'function'].includes(type)) r.arguments = (await db.query(`SELECT NVL(object_name, '') AS sub, argument_name AS arg, in_out AS mode, data_type AS t, position AS pos, overload FROM all_arguments WHERE owner = :o AND ${type === 'package' ? 'package_name = :n' : 'object_name = :n AND package_name IS NULL'} AND data_level = 0 ORDER BY object_name, overload, position`, { o: O, n: N }))
      .map(a => ({ signature: `${a.sub}${a.overload ? ` #${a.overload}` : ''}`, arg: a.pos === 0 ? '(результат)' : a.arg || '', mode: a.mode, type: a.t }));
  }
  if (type === 'sequence') {
    const s = await db.query(`SELECT min_value, max_value, increment_by, cycle_flag, cache_size, last_number FROM all_sequences WHERE sequence_owner = :o AND sequence_name = :n`, { o: O, n: N });
    if (s[0]) r.stats = Object.entries({ 'Следующее значение (≈)': s[0].last_number, 'Шаг': s[0].increment_by, 'Минимум': s[0].min_value, 'Максимум': s[0].max_value, 'Кэш': s[0].cache_size, 'Цикл': s[0].cycle_flag }).map(([k, v]) => ({ k, v: String(v) }));
  }
  if (OT) {
    const d = await one(db, `SELECT DBMS_METADATA.GET_DDL(:t, :n, :o) AS d FROM dual`, { t: OT, n: N, o: O }, []);
    r.ddl = d && d[0] ? String(d[0].d).trim() : r.source || '';
    if (type === 'table') {
      const dep = await one(db, `SELECT DBMS_METADATA.GET_DEPENDENT_DDL('INDEX', :n, :o) AS d FROM dual`, { n: N, o: O }, []);
      if (dep && dep[0] && dep[0].d) r.ddl += '\n\n' + String(dep[0].d).trim();
    }
  }
  return r;
}

async function objectDetails(connId, schema, type, name) {
  return withDb(connId, async db => {
    const r = db.type === 'oracle' ? await oraDetails(db, schema, type, name) : await pgDetails(db, schema, type, name);
    // зависимости: кто использует объект и что использует он
    const { deps } = await listObjects(db, schema);
    const me = `${type}:${name}`, low = K(me);
    r.usedBy = deps.filter(d => K(d.to) === low).map(d => ({ object: d.from, kind: d.kind }));
    r.uses = deps.filter(d => K(d.from) === low).map(d => ({ object: d.to, kind: d.kind }));
    r.dbType = db.type;
    return r;
  });
}

// ---------- данные ----------
function orderSql(db, sort) {
  return (sort || []).filter(s => s && s.column).map(s => `${db.quote(s.column)} ${s.desc ? 'DESC' : 'ASC'}`).join(', ');
}
async function tableData(connId, schema, table, { skip = 0, take = 50, where = '', sort = [], count = true } = {}) {
  return withDb(connId, async db => {
    const q = db.qualify(schema, table);
    if (/;\s*\S/.test(where)) throw new Error('В условии — только выражение WHERE, без «;»');
    const w = where && where.trim() ? ` WHERE ${where}` : '';
    let order = orderSql(db, sort);
    let total = null;
    if (count) total = Number((await db.query(`SELECT COUNT(*) AS n FROM ${q}${w}`, db.type === 'oracle' ? {} : []))[0].n);
    let sql;
    if (db.type === 'postgres') sql = `SELECT * FROM ${q}${w}${order ? ` ORDER BY ${order}` : ''} LIMIT ${Number(take)} OFFSET ${Number(skip)}`;
    else sql = `SELECT * FROM (SELECT t.*, ROWNUM AS dbcmp_rn FROM (SELECT * FROM ${q}${w}${order ? ` ORDER BY ${order}` : ''}) t WHERE ROWNUM <= ${Number(skip) + Number(take)}) WHERE dbcmp_rn > ${Number(skip)}`;
    const r = await db.fetchAll(sql, Number(take) + 1);
    const cols = r.columns.filter(c => c !== 'DBCMP_RN' && c !== 'dbcmp_rn');
    const ix = cols.map(c => r.columns.indexOf(c));
    const rows = r.rows.map(row => Object.fromEntries(cols.map((c, i) => { const v = row[ix[i]]; return [c, v instanceof Date ? v.toISOString().replace('T', ' ').replace(/\.000Z$|Z$/, '') : Buffer.isBuffer(v) ? `<двоичные данные, ${v.length} байт>` : v && typeof v === 'object' ? JSON.stringify(v) : v]; })));
    return { columns: cols, rows, total };
  });
}

/** Правка строк в одной транзакции. changes: [{ type: 'insert'|'update'|'remove', key: {pk…}, data: {col: value} }] */
async function saveRows(connId, schema, table, changes) {
  return withDb(connId, async db => {
    const q = db.qualify(schema, table);
    let n = 0;
    const ph = (binds, v) => { if (db.type === 'oracle') { const k = `b${Object.keys(binds).length}`; binds[k] = v === '' ? null : v; return `:${k}`; } binds.push(v === '' ? null : v); return `$${binds.length}`; };
    const keyWhere = (binds, key) => {
      const parts = Object.entries(key || {}).map(([c, v]) => (v === null ? `${db.quote(c)} IS NULL` : `${db.quote(c)} = ${ph(binds, v)}`));
      if (!parts.length) throw new Error('Нет первичного ключа — строку нельзя однозначно найти');
      return parts.join(' AND ');
    };
    if (db.type === 'postgres') await db.exec('BEGIN');
    try {
      for (const ch of changes) {
        const binds = db.type === 'oracle' ? {} : [];
        let sql;
        if (ch.type === 'insert') {
          const cols = Object.keys(ch.data || {});
          sql = `INSERT INTO ${q} (${cols.map(c => db.quote(c)).join(', ')}) VALUES (${cols.map(c => ph(binds, ch.data[c])).join(', ')})`;
        } else if (ch.type === 'update') {
          const cols = Object.keys(ch.data || {});
          if (!cols.length) continue;
          const set = cols.map(c => `${db.quote(c)} = ${ph(binds, ch.data[c])}`).join(', ');
          sql = `UPDATE ${q} SET ${set} WHERE ${keyWhere(binds, ch.key)}`;
        } else if (ch.type === 'remove') sql = `DELETE FROM ${q} WHERE ${keyWhere(binds, ch.key)}`;
        else continue;
        const res = db.type === 'postgres' ? await db.raw.query(sql, binds) : await db.raw.execute(sql, binds);
        const affected = db.type === 'postgres' ? res.rowCount : res.rowsAffected;
        if (ch.type !== 'insert' && affected !== 1) throw new Error(`Ожидалась одна строка, затронуто ${affected} — изменения отменены`);
        n += affected;
      }
      if (db.type === 'postgres') await db.exec('COMMIT'); else await db.raw.commit();
      return { ok: true, affected: n };
    } catch (e) {
      if (db.type === 'postgres') await db.exec('ROLLBACK').catch(() => {}); else await db.raw.rollback().catch(() => {});
      throw e;
    }
  });
}

/** Действия над объектом: перекомпиляция, обновление МП, ANALYZE / сбор статистики, включение триггера. */
async function objectAction(connId, schema, type, name, action) {
  return withDb(connId, async db => {
    const qn = db.qualify(schema, name);
    const map = db.type === 'postgres' ? {
      analyze: `ANALYZE ${qn}`, vacuum: `VACUUM (ANALYZE) ${qn}`, refresh: `REFRESH MATERIALIZED VIEW ${qn}`,
    } : {
      compile: type === 'package' ? `ALTER PACKAGE ${qn} COMPILE` : type === 'type' ? `ALTER TYPE ${qn} COMPILE` : `ALTER ${type.toUpperCase()} ${qn} COMPILE`,
      analyze: `BEGIN DBMS_STATS.GATHER_TABLE_STATS('${schema.toUpperCase()}', '${name}'); END;`,
      refresh: `BEGIN DBMS_MVIEW.REFRESH('${schema.toUpperCase()}.${name}'); END;`,
    };
    const sql = map[action];
    if (!sql) throw new Error('Действие недоступно для этого объекта');
    await db.exec(sql);
    if (action === 'compile') {
      const e = await db.query(`SELECT COUNT(*) AS n FROM all_errors WHERE owner = :o AND name = :n`, { o: schema.toUpperCase(), n: name });
      return { ok: true, sql, errors: Number(e[0].n) };
    }
    return { ok: true, sql };
  });
}

module.exports = { objectDetails, tableData, saveRows, objectAction };
