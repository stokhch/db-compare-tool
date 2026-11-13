'use strict';
// Перелив таблиц по соединениям: Oracle→PG, PG→Oracle, Oracle→Oracle, PG→PG.
// Чтение потоком из источника, запись пачками: в PostgreSQL через COPY, в Oracle через executeMany.
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { from: copyFrom } = require('pg-copy-streams');
const { connect } = require('../db');
const { loadMeta } = require('../meta');
const { getConnection, getSettings } = require('../lib/store');
const { selectExpr, canonDateTime } = require('../lib/normalize');
const { targetColumnType } = require('../lib/typemap');

// ---------- Порядок таблиц по внешним ключам ----------
function topoOrder(tables, K) {
  const names = new Set(tables.map(t => K(t.name)));
  const byName = new Map(tables.map(t => [K(t.name), t]));
  const visited = new Set(), temp = new Set(), out = [];
  const visit = (n) => {
    if (visited.has(n) || temp.has(n)) return; // цикл — оставляем как есть
    temp.add(n);
    for (const fk of byName.get(n).fks) {
      const r = K(fk.refTable || '');
      if (r && r !== n && names.has(r)) visit(r);
    }
    temp.delete(n); visited.add(n); out.push(byName.get(n));
  };
  for (const t of tables) visit(K(t.name));
  return out;
}

// ---------- DDL ----------
function createTableSql(srcTable, srcType, tgt, tgtSchema) {
  const cols = srcTable.columns.map(c => {
    const type = targetColumnType(c, srcType, tgt.type);
    return `  ${tgt.quote(tgt.normName(c.name))} ${type}${c.nullable ? '' : ' NOT NULL'}`;
  });
  if (srcTable.pk) {
    cols.push(`  CONSTRAINT ${tgt.quote(tgt.normName(srcTable.pk.name))} PRIMARY KEY (${srcTable.pk.columns.map(c => tgt.quote(tgt.normName(c))).join(', ')})`);
  }
  return `CREATE TABLE ${tgt.qualify(tgtSchema, tgt.normName(srcTable.name))} (\n${cols.join(',\n')}\n)`;
}

// ---------- Преобразование значений под приёмник ----------
function pgValue(v, tcol) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return '\\x' + v.toString('hex');
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (typeof v === 'object') return JSON.stringify(v);
  let s = String(v);
  if (s.indexOf('\u0000') >= 0) s = s.replace(/\u0000/g, ''); // PG не принимает NUL в тексте
  if (tcol.udt === 'timestamptz' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/.test(s)) s += '+00';
  if (tcol.udt === 'bytea' && !s.startsWith('\\x')) s = '\\x' + Buffer.from(s, 'utf8').toString('hex');
  return s;
}
const csvField = v => (v === null ? '' : '"' + v.replace(/"/g, '""') + '"');

function oracleBindExpr(tcol, i) {
  const t = String(tcol.dataType).toUpperCase();
  const b = `:${i + 1}`;
  if (t === 'DATE') return `TO_DATE(SUBSTR(${b}, 1, 19), 'YYYY-MM-DD HH24:MI:SS')`;
  if (/WITH (LOCAL )?TIME ZONE/.test(t)) return `TO_TIMESTAMP_TZ(${b}, 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM')`;
  if (t.startsWith('TIMESTAMP')) return `TO_TIMESTAMP(${b}, 'YYYY-MM-DD HH24:MI:SS.FF')`;
  if (t === 'XMLTYPE') return `XMLTYPE(${b})`;
  return b;
}
function oracleValue(v, tcol) {
  if (v === null || v === undefined) return null;
  const t = String(tcol.dataType).toUpperCase();
  if (Buffer.isBuffer(v)) return ['BLOB', 'RAW', 'LONG RAW'].includes(t) ? v : v.toString('hex');
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (['BLOB', 'RAW', 'LONG RAW'].includes(t)) {
    const s = String(v);
    return /^\\x[0-9a-f]*$/i.test(s) ? Buffer.from(s.slice(2), 'hex') : Buffer.from(s, 'utf8');
  }
  if (typeof v === 'object') return JSON.stringify(v);
  let s = String(v);
  if (t === 'DATE' || t.startsWith('TIMESTAMP')) {
    s = canonDateTime(s); // UTC, 'YYYY-MM-DD HH:MI:SS.ffffff'
    if (/WITH (LOCAL )?TIME ZONE/.test(t)) s += ' +00:00';
  }
  if (t === 'NUMBER' || t === 'FLOAT') {
    if (s === 't' || s === 'true') return '1';
    if (s === 'f' || s === 'false') return '0';
  }
  return s;
}

async function copyTable(src, tgt, ta, tb, p, ctx, K, fetchSize) {
  const mapB = new Map(tb.columns.map(c => [K(c.name), c]));
  const pairs = ta.columns.filter(c => mapB.has(K(c.name)) && c.dataType !== 'BFILE').map(c => ({ a: c, b: mapB.get(K(c.name)) }));
  const skipped = ta.columns.filter(c => !mapB.has(K(c.name))).map(c => c.name);
  if (skipped.length) ctx.log(`${ta.name}: колонки отсутствуют в приёмнике и пропущены: ${skipped.join(', ')}`, 'warning');
  if (!pairs.length) throw new Error('Нет общих колонок');

  // Колонки приёмника — GENERATED ALWAYS / вычисляемые писать нельзя
  const writable = pairs.filter(x => !(x.b.identity === 'a'));
  let sql = `SELECT ${writable.map(x => selectExpr(src, x.a)).join(', ')} FROM ${src.qualify(p.sourceSchema, ta.name)}`;
  const where = (p.where && p.where[ta.name]) || '';
  if (where) sql += ` WHERE ${where}`;

  let rows = 0;
  const rowsTotal = ta.rowEstimate || 0;
  const report = () => ctx.progress(undefined, undefined, `${ta.name}: ${rows}${rowsTotal ? ' из ~' + rowsTotal : ''} строк`);

  if (tgt.type === 'postgres') {
    const copySql = `COPY ${tgt.qualify(p.targetSchema, tb.name)} (${writable.map(x => tgt.quote(x.b.name)).join(', ')}) FROM STDIN WITH (FORMAT csv)`;
    const stream = tgt.raw.query(copyFrom(copySql));
    const gen = async function* () {
      for await (const batch of src.stream(sql, [], fetchSize)) {
        ctx.checkCancel();
        let chunk = '';
        for (const r of batch) {
          chunk += writable.map((x, i) => csvField(pgValue(r[i], x.b))).join(',') + '\n';
        }
        rows += batch.length;
        report();
        yield chunk;
      }
    };
    await pipeline(Readable.from(gen()), stream);
    return { rows, skippedColumns: skipped };
  }

  // Oracle: INSERT … executeMany
  const { oracledb } = require('../db/oracle');
  const insertSql = `INSERT INTO ${tgt.qualify(p.targetSchema, tb.name)} (${writable.map(x => tgt.quote(x.b.name)).join(', ')}) VALUES (${writable.map((x, i) => oracleBindExpr(x.b, i)).join(', ')})`;
  const batchSize = Math.max(100, Math.min(Number(p.batchSize) || 1000, 10000));
  let buf = [];
  const flush = async () => {
    if (!buf.length) return;
    const bindDefs = writable.map((x, i) => {
      const t = String(x.b.dataType).toUpperCase();
      if (['CLOB', 'NCLOB', 'LONG', 'XMLTYPE'].includes(t)) return { type: oracledb.DB_TYPE_CLOB };
      if (t === 'BLOB') return { type: oracledb.DB_TYPE_BLOB };
      if (t === 'RAW' || t === 'LONG RAW') {
        let m = 1; for (const r of buf) if (r[i] && r[i].length > m) m = r[i].length;
        return { type: oracledb.DB_TYPE_RAW, maxSize: m };
      }
      let m = 1; for (const r of buf) if (r[i] != null && r[i].length > m) m = r[i].length;
      return { type: oracledb.STRING, maxSize: m * 4 };
    });
    await tgt.raw.executeMany(insertSql, buf, { bindDefs, autoCommit: true });
    buf = [];
  };
  for await (const batch of src.stream(sql, [], fetchSize)) {
    ctx.checkCancel();
    for (const r of batch) {
      buf.push(writable.map((x, i) => oracleValue(r[i], x.b)));
      if (buf.length >= batchSize) await flush();
    }
    rows += batch.length;
    report();
  }
  await flush();
  return { rows, skippedColumns: skipped };
}

async function setSequence(tgt, schema, name, value, ctx) {
  if (value == null) return;
  if (tgt.type === 'postgres') {
    await tgt.query(`SELECT setval($1, $2::bigint, true)`, [`${tgt.quote(schema)}.${tgt.quote(name)}`, String(value)]);
    return;
  }
  const q = tgt.qualify(schema, name);
  try {
    await tgt.exec(`ALTER SEQUENCE ${q} RESTART START WITH ${Number(value) + 1}`);
  } catch {
    // Oracle < 18c: сдвиг через временный шаг
    const cur = Number((await tgt.query(`SELECT ${q}.NEXTVAL AS v FROM dual`))[0].v);
    const diff = Number(value) - cur;
    if (diff > 0) {
      const inc = Number((await tgt.query(`SELECT increment_by AS i FROM all_sequences WHERE sequence_owner = :o AND sequence_name = :n`, { o: schema, n: name }))[0].i);
      await tgt.exec(`ALTER SEQUENCE ${q} INCREMENT BY ${diff}`);
      await tgt.query(`SELECT ${q}.NEXTVAL AS v FROM dual`);
      await tgt.exec(`ALTER SEQUENCE ${q} INCREMENT BY ${inc}`);
    }
  }
  ctx.log(`Последовательность ${name} → ${value}`);
}

async function runTransfer(p, ctx) {
  const settings = getSettings();
  const fetchSize = Number(settings.fetchSize || 2000);
  const srcConn = getConnection(p.sourceId), tgtConn = getConnection(p.targetId);
  const K = x => String(x).toLowerCase();
  if (p.sourceId === p.targetId && K(p.sourceSchema) === K(p.targetSchema)) throw new Error('Источник и приёмник совпадают');

  ctx.log(`Перелив: ${srcConn.name}/${p.sourceSchema} → ${tgtConn.name}/${p.targetSchema}`);
  const src = await connect(srcConn), tgt = await connect(tgtConn);
  const disabledFks = [];
  let replicaRole = false;
  const results = [];
  try {
    ctx.progress(0, 0, 'Чтение структуры…');
    const A = await loadMeta(src, p.sourceSchema, {}, ctx);
    let B = await loadMeta(tgt, p.targetSchema, {}, ctx);
    let selected = p.tables && p.tables.length ? A.tables.filter(t => p.tables.map(K).includes(K(t.name))) : A.tables;
    if (!selected.length) throw new Error('Не выбрано ни одной таблицы');
    selected = topoOrder(selected, K);
    ctx.log(`Порядок загрузки (по внешним ключам): ${selected.map(t => t.name).join(', ')}`);

    // 1. Создание отсутствующих таблиц
    let mapB = new Map(B.tables.map(t => [K(t.name), t]));
    const missing = selected.filter(t => !mapB.has(K(t.name)));
    if (missing.length) {
      if (!p.createTables) {
        throw new Error(`В приёмнике нет таблиц: ${missing.map(t => t.name).join(', ')}. Включите «Создавать отсутствующие таблицы».`);
      }
      for (const t of missing) {
        const ddl = createTableSql(t, src.type, tgt, p.targetSchema);
        ctx.log(ddl);
        await tgt.exec(ddl);
        if (tgt.type === 'postgres') { /* autocommit */ }
      }
      B = await loadMeta(tgt, p.targetSchema, {}, null);
      mapB = new Map(B.tables.map(t => [K(t.name), t]));
    }

    // 2. Отключение внешних ключей
    if (p.disableFk) {
      if (tgt.type === 'postgres') {
        try { await tgt.exec(`SET session_replication_role = replica`); replicaRole = true; ctx.log('PostgreSQL: session_replication_role = replica (FK и триггеры отключены на время загрузки)'); }
        catch (e) { ctx.log(`Не удалось отключить FK (нужны права суперпользователя): ${e.message}. Загрузка пойдёт в порядке зависимостей.`, 'warning'); }
      } else {
        const names = new Set(selected.map(t => K(t.name)));
        for (const t of B.tables) for (const fk of t.fks) {
          if (fk.enabled && (names.has(K(t.name)) || names.has(K(fk.refTable || '')))) {
            await tgt.exec(`ALTER TABLE ${tgt.qualify(p.targetSchema, t.name)} DISABLE CONSTRAINT ${tgt.quote(fk.name)}`);
            disabledFks.push({ table: t.name, name: fk.name });
          }
        }
        ctx.log(`Oracle: отключено внешних ключей: ${disabledFks.length}`);
      }
    }

    // 3. Очистка
    if (p.mode === 'truncate' || p.mode === 'delete') {
      for (const t of [...selected].reverse()) {
        const tb = mapB.get(K(t.name));
        const q = tgt.qualify(p.targetSchema, tb.name);
        if (p.mode === 'truncate') {
          try { await tgt.exec(`TRUNCATE TABLE ${q}`); ctx.log(`TRUNCATE ${tb.name}`); continue; }
          catch (e) { ctx.log(`TRUNCATE ${tb.name} не выполнен (${e.message}), использую DELETE`, 'warning'); }
        }
        await tgt.exec(`DELETE FROM ${q}`);
        if (tgt.type === 'oracle') await tgt.commit();
        ctx.log(`DELETE ${tb.name}`);
      }
    }

    // 4. Копирование
    let i = 0;
    for (const ta of selected) {
      ctx.checkCancel();
      const tb = mapB.get(K(ta.name));
      ctx.progress(i, selected.length, `${ta.name}…`);
      const t0 = Date.now();
      try {
        const r = await copyTable(src, tgt, ta, tb, p, ctx, K, fetchSize);
        results.push({ table: ta.name, status: 'done', rows: r.rows, ms: Date.now() - t0, skippedColumns: r.skippedColumns });
        ctx.log(`${ta.name}: скопировано ${r.rows} строк за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
      } catch (e) {
        if (e.cancelled) throw e;
        if (tgt.type === 'oracle') await tgt.rollback();
        results.push({ table: ta.name, status: 'error', error: e.message, ms: Date.now() - t0 });
        ctx.log(`${ta.name}: ошибка — ${e.message}`, 'error');
        if (p.stopOnError) break;
      }
      ctx.progress(++i, selected.length);
      ctx.setPartialResult({ summary: sum(results), tables: results });
    }

    // 5. Последовательности
    if (p.syncSequences) {
      const seqB = new Map(B.sequences.map(s => [K(s.name), s]));
      for (const s of A.sequences) {
        const sb = seqB.get(K(s.name));
        if (!sb) continue;
        try { await setSequence(tgt, p.targetSchema, sb.name, s.value, ctx); }
        catch (e) { ctx.log(`Последовательность ${s.name}: ${e.message}`, 'warning'); }
      }
    }
  } finally {
    // 6. Включение FK обратно
    if (replicaRole) await tgt.exec(`SET session_replication_role = origin`).catch(() => {});
    for (const fk of disabledFks) {
      try { await tgt.exec(`ALTER TABLE ${tgt.qualify(p.targetSchema, fk.table)} ENABLE CONSTRAINT ${tgt.quote(fk.name)}`); }
      catch (e) { ctx.log(`Не удалось включить ${fk.name}: ${e.message} (данные нарушают ограничение)`, 'error'); }
    }
    await src.close(); await tgt.close();
  }
  return { summary: sum(results), tables: results };
}

function sum(results) {
  return {
    tables: results.length,
    done: results.filter(r => r.status === 'done').length,
    error: results.filter(r => r.status === 'error').length,
    rows: results.reduce((s, r) => s + (r.rows || 0), 0),
  };
}

module.exports = { runTransfer, createTableSql, topoOrder };
