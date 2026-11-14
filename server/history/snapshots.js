'use strict';
// История схемы: снимки структуры (по расписанию или вручную), сравнение любых двух снимков
// и журнал DDL (кто и когда менял) — скрипт установки триггера аудита.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { connect } = require('../db');
const { getConnection, publicConnection, DATA_DIR } = require('../lib/store');
const { loadMeta } = require('../meta');

const DIR = path.join(DATA_DIR, 'snapshots');
fs.mkdirSync(DIR, { recursive: true });

// Хеш только структуры (без статистики и оценок строк)
function structureHash(meta) {
  const strip = o => JSON.stringify(o, (k, v) => (['rowEstimate', 'rowCount', 'lastAnalyzed', 'bytes', 'pgcheck'].includes(k) ? undefined : v));
  return crypto.createHash('sha1').update(strip({ t: meta.tables, v: meta.views, m: meta.mviews, s: meta.sequences, r: meta.routines, g: meta.triggers })).digest('hex');
}
function counts(meta) { return { tables: meta.tables.length, views: meta.views.length, routines: meta.routines.length, sequences: meta.sequences.length, triggers: meta.triggers.length }; }

function list(connId, schema) {
  const out = [];
  for (const f of fs.readdirSync(DIR).filter(x => x.endsWith('.json'))) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if ((connId && s.connId !== connId) || (schema && s.schema.toLowerCase() !== String(schema).toLowerCase())) continue;
      const { meta, ...head } = s;
      out.push(head);
    } catch { /* повреждённый файл */ }
  }
  return out.sort((a, b) => b.takenAt.localeCompare(a.takenAt));
}
function get(id) {
  const f = path.join(DIR, path.basename(id) + '.json');
  if (!fs.existsSync(f)) throw new Error(`Снимок ${id} не найден`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function remove(id) { fs.rmSync(path.join(DIR, path.basename(id) + '.json'), { force: true }); }

async function takeSnapshot(p, ctx) {
  const conn = getConnection(p.connId);
  const db = await connect(conn);
  try {
    ctx.progress(0, 0, 'Чтение структуры…');
    const meta = await loadMeta(db, p.schema, {}, null);
    const hash = structureHash(meta);
    const prev = list(p.connId, p.schema)[0];
    const changed = !prev || prev.hash !== hash;
    if (!changed && p.skipUnchanged !== false) {
      ctx.log(`Структура не изменилась с ${prev.takenAt.replace('T', ' ').slice(0, 16)} — новый снимок не нужен`);
      return { summary: { changed: false, snapshots: list(p.connId, p.schema).length }, snapshot: prev };
    }
    // объекты, изменённые после прошлого снимка (Oracle хранит время DDL)
    let recent = [];
    if (db.type === 'oracle' && prev) {
      recent = await db.query(`SELECT object_type AS type, object_name AS name, TO_CHAR(last_ddl_time, 'YYYY-MM-DD HH24:MI:SS') AS at FROM all_objects WHERE owner = :o AND last_ddl_time > TO_DATE(:d, 'YYYY-MM-DD"T"HH24:MI:SS') ORDER BY last_ddl_time`, { o: p.schema.toUpperCase(), d: prev.takenAt.slice(0, 19) }).catch(() => []);
    }
    const id = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}_${crypto.randomBytes(3).toString('hex')}`;
    const snap = { id, connId: p.connId, connName: conn.name, type: conn.type, schema: p.schema, takenAt: new Date().toISOString(), hash, label: p.label || '', counts: counts(meta), changed, prevId: prev ? prev.id : null, recent, meta };
    fs.writeFileSync(path.join(DIR, id + '.json'), JSON.stringify(snap));
    ctx.log(`Снимок ${id}: таблиц ${meta.tables.length}, представлений ${meta.views.length}, подпрограмм ${meta.routines.length}${prev ? ', структура изменилась' : ''}`);
    if (p.keep) for (const old of list(p.connId, p.schema).slice(Number(p.keep))) remove(old.id);
    const { meta: _m, ...head } = snap;
    return { summary: { changed: true, snapshots: list(p.connId, p.schema).length }, snapshot: head };
  } finally { await db.close(); }
}

/** Заглушка «подключения» для сравнения снимка: метаданные уже прочитаны. */
function snapshotSide(id) {
  const s = get(id);
  return { conn: { id: s.connId, name: `${s.connName} @ ${s.takenAt.replace('T', ' ').slice(0, 16)}`, type: s.type }, meta: s.meta, schema: s.schema,
    db: { type: s.type, snapshot: true, close: async () => {}, quote: x => `"${x}"` } };
}

/** SQL установки журнала DDL: кто, когда, какой командой менял структуру. */
function ddlJournalSql(type, schema) {
  if (type === 'postgres') return `-- Журнал DDL для PostgreSQL (выполнить от суперпользователя или владельца базы)
CREATE SCHEMA IF NOT EXISTS dbcmp_audit;
CREATE TABLE IF NOT EXISTS dbcmp_audit.ddl_log (
  id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), username text NOT NULL DEFAULT current_user,
  client inet DEFAULT inet_client_addr(), app text DEFAULT current_setting('application_name', true),
  command text, object_type text, object_name text, sql text);
CREATE OR REPLACE FUNCTION dbcmp_audit.log_ddl() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    INSERT INTO dbcmp_audit.ddl_log (command, object_type, object_name, sql) VALUES (r.command_tag, r.object_type, r.object_identity, current_query());
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION dbcmp_audit.log_drop() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM pg_event_trigger_dropped_objects() WHERE original LOOP
    INSERT INTO dbcmp_audit.ddl_log (command, object_type, object_name, sql) VALUES ('DROP', r.object_type, r.object_identity, current_query());
  END LOOP;
END $$;
DROP EVENT TRIGGER IF EXISTS dbcmp_ddl_end;
DROP EVENT TRIGGER IF EXISTS dbcmp_ddl_drop;
CREATE EVENT TRIGGER dbcmp_ddl_end ON ddl_command_end EXECUTE FUNCTION dbcmp_audit.log_ddl();
CREATE EVENT TRIGGER dbcmp_ddl_drop ON sql_drop EXECUTE FUNCTION dbcmp_audit.log_drop();
-- Просмотр: SELECT * FROM dbcmp_audit.ddl_log ORDER BY at DESC;`;
  const S = String(schema || 'SCHEMA').toUpperCase();
  return `-- Журнал DDL для схемы ${S} (Oracle; выполнить от владельца схемы)
CREATE TABLE ddl_log (
  id NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  username VARCHAR2(128), osuser VARCHAR2(128), machine VARCHAR2(256), program VARCHAR2(256),
  event VARCHAR2(30), object_type VARCHAR2(30), object_name VARCHAR2(128), sql_text CLOB);
CREATE OR REPLACE TRIGGER trg_ddl_log AFTER DDL ON SCHEMA
DECLARE n PLS_INTEGER; t ora_name_list_t; s CLOB;
BEGIN
  IF ora_dict_obj_name = 'DDL_LOG' THEN RETURN; END IF;
  n := ora_sql_txt(t);
  FOR i IN 1 .. NVL(n, 0) LOOP s := s || t(i); END LOOP;
  INSERT INTO ddl_log (username, osuser, machine, program, event, object_type, object_name, sql_text)
  VALUES (SYS_CONTEXT('USERENV','SESSION_USER'), SYS_CONTEXT('USERENV','OS_USER'), SYS_CONTEXT('USERENV','HOST'),
          SYS_CONTEXT('USERENV','MODULE'), ora_sysevent, ora_dict_obj_type, ora_dict_obj_name, s);
EXCEPTION WHEN OTHERS THEN NULL;  -- журнал не должен мешать DDL
END;
/
-- Просмотр: SELECT * FROM ddl_log ORDER BY at DESC;`;
}

/** Чтение журнала DDL, если он установлен. */
async function readDdlJournal(connId, schema, limit = 300) {
  const conn = getConnection(connId);
  const db = await connect(conn);
  try {
    if (conn.type === 'postgres') return await db.query(`SELECT at::text AS at, username AS "user", client::text AS client, app, command, object_type AS type, object_name AS object, left(sql, 2000) AS sql FROM dbcmp_audit.ddl_log ORDER BY at DESC LIMIT ${Number(limit)}`);
    return await db.query(`SELECT * FROM (SELECT TO_CHAR(at, 'YYYY-MM-DD HH24:MI:SS') AS at, username AS "user", machine AS client, program AS app, event AS command, object_type AS type, object_name AS object, DBMS_LOB.SUBSTR(sql_text, 2000, 1) AS sql FROM ${db.quote(String(schema).toUpperCase())}.ddl_log ORDER BY at DESC) WHERE ROWNUM <= ${Number(limit)}`);
  } catch (e) {
    if (/does not exist|ORA-00942/i.test(e.message)) return { notInstalled: true };
    throw e;
  } finally { await db.close(); }
}

module.exports = { takeSnapshot, list, get, remove, snapshotSide, structureHash, ddlJournalSql, readDdlJournal, DIR };
