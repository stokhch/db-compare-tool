'use strict';
// Разбор DDL из дампа: SQL-файл Data Pump (impdp SQLFILE=…) или строки из старого exp.
// Результат — состав дампа: схемы и объекты по типам, табличные пространства, роли, пользователи,
// внешние ссылки на схемы вне дампа, DB links, каталоги, строковые колонки с длиной в байтах.

const SYSTEM_SCHEMAS = new Set(['SYS', 'SYSTEM', 'PUBLIC', 'XDB', 'MDSYS', 'CTXSYS', 'ORDSYS', 'ORDDATA', 'OUTLN', 'DBSNMP', 'WMSYS', 'OLAPSYS',
  'LBACSYS', 'DVSYS', 'APPQOSSYS', 'GSMADMIN_INTERNAL', 'AUDSYS', 'OJVMSYS', 'DBSFWUSER', 'REMOTE_SCHEDULER_AGENT', 'ORACLE_OCM', 'APEX_PUBLIC_USER', 'ANONYMOUS']);
// Предопределённые роли — есть в любой базе
const BUILTIN_ROLES = new Set(['CONNECT', 'RESOURCE', 'DBA', 'SELECT_CATALOG_ROLE', 'EXECUTE_CATALOG_ROLE', 'EXP_FULL_DATABASE', 'IMP_FULL_DATABASE',
  'DATAPUMP_EXP_FULL_DATABASE', 'DATAPUMP_IMP_FULL_DATABASE', 'AQ_ADMINISTRATOR_ROLE', 'AQ_USER_ROLE', 'SCHEDULER_ADMIN', 'JAVAUSERPRIV', 'JAVASYSPRIV',
  'PLUSTRACE', 'SODA_APP', 'XDBADMIN', 'AUTHENTICATEDUSER', 'GATHER_SYSTEM_STATISTICS', 'RECOVERY_CATALOG_OWNER', 'HS_ADMIN_ROLE', 'OEM_MONITOR', 'CTXAPP', 'PUBLIC']);

const TYPE_RE = '(TABLE|INDEX|VIEW|SEQUENCE|SYNONYM|PACKAGE\\s+BODY|PACKAGE|PROCEDURE|FUNCTION|TRIGGER|TYPE\\s+BODY|TYPE|MATERIALIZED\\s+VIEW\\s+LOG|MATERIALIZED\\s+VIEW|DATABASE\\s+LINK|DIRECTORY|USER|ROLE|TABLESPACE|CONTEXT|JAVA\\s+\\w+|LIBRARY|DIMENSION|OPERATOR|INDEXTYPE|CLUSTER)';
const PREFIX_RE = '(?:(?:OR\\s+REPLACE|EDITIONABLE|NONEDITIONABLE|EDITIONING|GLOBAL|PRIVATE|TEMPORARY|UNIQUE|BITMAP|FORCE|NOFORCE|PUBLIC|SHARED|BIGFILE|SMALLFILE|UNDO|NO\\s+FORCE|AND\\s+(?:RESOLVE|COMPILE)|IMMUTABLE|BLOCKCHAIN|SHARDED|DUPLICATED)\\s+)*';
const NAME_RE = '((?:"[^"]+"|[A-Za-z_][\\w$#]*)(?:\\s*\\.\\s*(?:"[^"]+"|[A-Za-z_][\\w$#]*))?)';
const unq = s => (/^".*"$/.test(s) ? s.slice(1, -1) : s.toUpperCase());

function splitName(raw, current) {
  const parts = raw.match(/"[^"]+"|[A-Za-z_][\w$#]*/g).map(unq);
  return parts.length > 1 ? { owner: parts[0], name: parts[1] } : { owner: current, name: parts[0] };
}

/**
 * text — DDL. opts.defaultSchema — схема по умолчанию (для старого exp без CONNECT).
 */
function parseDdl(text, opts = {}) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const schemas = new Map();
  const S = name => {
    if (!schemas.has(name)) schemas.set(name, { name, objects: {}, total: 0, createUser: false, defaultTablespace: null, tempTablespace: null, tablespaces: new Set() });
    return schemas.get(name);
  };
  const tsUsed = new Map();   // имя → { name, refs, temp, schemas:Set }
  const useTs = (ts, owner, temp = false) => {
    if (!ts) return;
    if (!tsUsed.has(ts)) tsUsed.set(ts, { name: ts, refs: 0, temp: false, schemas: new Set() });
    const t = tsUsed.get(ts); t.refs++; if (temp) t.temp = true; if (owner) { t.schemas.add(owner); if (schemas.has(owner)) schemas.get(owner).tablespaces.add(ts); }
  };
  const tsCreated = [], rolesCreated = new Set(), rolesUsed = new Set(), grantees = new Set(), dbLinks = [], directories = [];
  const byteColumns = [], external = new Map(), typePaths = {};
  const objectNames = {}, codeRefs = [];
  // объекты для выборочного импорта: id → { id, type, owner, name, tokens, on }
  const objs = new Map(), fkRefs = [];
  const SEL_TYPE = { 'TABLE': 'TABLE', 'VIEW': 'VIEW', 'SEQUENCE': 'SEQUENCE', 'SYNONYM': 'SYNONYM', 'PACKAGE': 'PACKAGE', 'PACKAGE BODY': 'PACKAGE',
    'PROCEDURE': 'PROCEDURE', 'FUNCTION': 'FUNCTION', 'TYPE': 'TYPE', 'TYPE BODY': 'TYPE', 'MATERIALIZED VIEW': 'MATERIALIZED VIEW', 'TRIGGER': 'TRIGGER' };
  const { extractRefs, CODE_TYPES } = require('./codedeps');
  let jobs = 0, lobs = 0, statements = 0, current = opts.defaultSchema ? opts.defaultSchema.toUpperCase() : null;
  const addExternal = (owner, what) => {
    if (!owner || SYSTEM_SCHEMAS.has(owner)) return;
    if (!external.has(owner)) external.set(owner, new Set());
    if (external.get(owner).size < 8) external.get(owner).add(what);
  };

  // Операторы: Data Pump пишет «;» в конце строки, PL/SQL заканчивается строкой «/».
  // Комментарии «-- CONNECT X» и «-- new object type path: …» обрабатываем построчно.
  const stmts = [];
  let buf = [];
  let inPlsql = false;
  for (const line of src.split('\n')) {
    const conn = /^\s*(?:--\s*)?CONNECT\s+"?([A-Za-z0-9_$#]+)"?\s*;?\s*$/i.exec(line);
    if (conn && !buf.length) { current = conn[1].toUpperCase(); S(current); continue; }
    const pathM = /^--\s*new object type path:\s*(\S+)/i.exec(line);
    if (pathM) { stmts.push({ path: pathM[1] }); continue; }
    const cs = /ALTER\s+SESSION\s+SET\s+CURRENT_SCHEMA\s*=\s*"?([A-Za-z0-9_$#]+)"?/i.exec(line);
    if (cs && !buf.length) { current = cs[1].toUpperCase(); S(current); continue; }
    if (!buf.length && /^\s*(--.*)?$/.test(line)) continue;
    if (opts.legacy) { stmts.push({ sql: line, current }); continue; } // старый exp: одна строка — один оператор
    if (!buf.length) inPlsql = /^\s*CREATE\s+(OR\s+REPLACE\s+)?(EDITIONABLE\s+|NONEDITIONABLE\s+)?(PACKAGE|PROCEDURE|FUNCTION|TRIGGER|TYPE|LIBRARY|JAVA)\b/i.test(line)
      || /^\s*(BEGIN|DECLARE)\b/i.test(line);
    if (inPlsql) {
      if (/^\s*\/\s*$/.test(line)) { stmts.push({ sql: buf.join('\n'), current }); buf = []; inPlsql = false; continue; }
      buf.push(line);
      continue;
    }
    buf.push(line);
    if (/;\s*$/.test(line)) { stmts.push({ sql: buf.join('\n'), current }); buf = []; }
  }
  if (buf.length) stmts.push({ sql: buf.join('\n'), current });

  let lastPath = null;
  const createRe = new RegExp(`^\\s*CREATE\\s+${PREFIX_RE}${TYPE_RE}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${NAME_RE}`, 'i');
  for (const st of stmts) {
    if (st.path) { lastPath = st.path; continue; }
    const sql = st.sql;
    const cur = st.current;
    statements++;
    if (lastPath) typePaths[lastPath] = (typePaths[lastPath] || 0) + 1;
    if (/DBMS_SCHEDULER\s*\.\s*CREATE_JOB|DBMS_JOB\s*\.\s*(SUBMIT|ISUBMIT)/i.test(sql)) jobs++;
    // квоты внутри PL/SQL-блоков Data Pump: 'ALTER USER "X" QUOTA UNLIMITED ON "TS"'
    { const qre = /ALTER\s+USER\s+"?([A-Za-z0-9_$#]+)"?\s+QUOTA\s+\S+\s+ON\s+"?([A-Za-z0-9_$#]+)"?/gi; let q;
      if (/^\s*(DECLARE|BEGIN)\b/i.test(sql)) while ((q = qre.exec(sql))) { S(q[1].toUpperCase()); useTs(q[2].toUpperCase(), q[1].toUpperCase()); } }
    const m = createRe.exec(sql);
    if (m) {
      const type = m[1].toUpperCase().replace(/\s+/g, ' ');
      const raw = m[2];
      if (type === 'USER') {
        const name = unq(raw.trim()); const s = S(name); s.createUser = true;
        const dt = /DEFAULT\s+TABLESPACE\s+"?([A-Za-z0-9_$#]+)"?/i.exec(sql), tt = /TEMPORARY\s+TABLESPACE\s+"?([A-Za-z0-9_$#]+)"?/i.exec(sql);
        if (dt) { s.defaultTablespace = dt[1].toUpperCase(); useTs(s.defaultTablespace, name); }
        if (tt) { s.tempTablespace = tt[1].toUpperCase(); useTs(s.tempTablespace, name, true); }
        continue;
      }
      if (type === 'ROLE') { rolesCreated.add(unq(raw.trim())); continue; }
      if (/TABLESPACE$/.test(type)) { tsCreated.push({ name: unq(raw.trim()), temp: /TEMPORARY|UNDO/i.test(sql.slice(0, 60)) }); continue; }
      if (type === 'DIRECTORY') { const pm = /\bAS\s+'([^']*)'/i.exec(sql); directories.push({ name: unq(raw.trim()), path: pm ? pm[1] : '' }); continue; }
      if (type === 'DATABASE LINK') { const um = /\bUSING\s+'([^']*)'/i.exec(sql); dbLinks.push({ name: raw.replace(/"/g, ''), owner: /PUBLIC\s+DATABASE/i.test(sql) ? 'PUBLIC' : cur, using: um ? um[1] : '' }); continue; }
      const isPublicSyn = type === 'SYNONYM' && /\bPUBLIC\s+SYNONYM/i.test(sql);
      const { owner, name } = splitName(raw, isPublicSyn ? 'PUBLIC' : cur);
      if (owner && owner !== 'PUBLIC') {
        const s = S(owner);
        s.objects[type] = (s.objects[type] || 0) + 1; s.total++;
        (objectNames[owner] = objectNames[owner] || new Set()).add(name);
      }
      if (SEL_TYPE[type] && owner && owner !== 'PUBLIC') {
        const st = SEL_TYPE[type], id = `${st}:${owner}.${name}`;
        if (!objs.has(id)) objs.set(id, { id, type: st, owner, name, tokens: [], on: null });
        const o = objs.get(id);
        if (st === 'TABLE') {
          const fre = /REFERENCES\s+("[^"]+"|[\w$#]+)(?:\s*\.\s*("[^"]+"|[\w$#]+))?/gi; let f;
          while ((f = fre.exec(sql))) o.tokens.push(f[2] ? [unq(f[1]), unq(f[2])] : [null, unq(f[1])]);
          o.typeTokens = nameTokens(sql);           // колонки объектных типов
        } else if (st === 'SYNONYM') {
          const fm = /\bFOR\s+("[^"]+"|[\w$#]+)(?:\s*\.\s*("[^"]+"|[\w$#]+))?(@\S+)?/i.exec(sql);
          if (fm && !fm[3]) o.tokens.push(fm[2] ? [unq(fm[1]), unq(fm[2])] : [null, unq(fm[1])]);
        } else {
          if (st === 'TRIGGER') {
            const om = /\bON\s+("[^"]+"|[\w$#]+)(?:\s*\.\s*("[^"]+"|[\w$#]+))?/i.exec(sql);
            if (om) o.on = om[2] ? [unq(om[1]), unq(om[2])] : [owner, unq(om[1])];
          }
          o.tokens.push(...nameTokens(sql));
        }
      }
      // зависимости кода: ссылки на другие схемы, пакеты, таблицы, DB links
      if (CODE_TYPES.has(type) && owner && owner !== 'PUBLIC') {
        const refs = extractRefs(sql);
        if (refs.length) codeRefs.push({ owner, object: name, type, refs });
      }
      if (type === 'TABLE' || type === 'INDEX' || type === 'MATERIALIZED VIEW' || type === 'CLUSTER') {
        const re = /\bTABLESPACE\s+"?([A-Za-z0-9_$#]+)"?/gi; let t;
        while ((t = re.exec(sql))) useTs(t[1].toUpperCase(), owner);
      }
      if (type === 'TABLE') {
        if (/\b(CLOB|BLOB|NCLOB)\b/i.test(sql)) lobs++;
        const body = sql.slice(sql.indexOf('('));
        const cre = /"([^"]+)"\s+(VARCHAR2|CHAR)\s*\(\s*(\d+)(\s+(BYTE|CHAR))?\s*\)/gi; let c;
        while ((c = cre.exec(body))) if (!c[5] || c[5].toUpperCase() === 'BYTE') byteColumns.push({ owner, table: name, column: c[1], type: c[2].toUpperCase(), length: Number(c[3]) });
        const fre = /REFERENCES\s+("[^"]+"|\w+)\s*\.\s*("[^"]+"|\w+)/gi; let f;
        while ((f = fre.exec(sql))) { const o = unq(f[1]); if (o !== owner) addExternal(o, `FK ${owner}.${name} → ${o}.${unq(f[2])}`); }
      }
      if (type === 'SYNONYM') {
        const fm = /\bFOR\s+("[^"]+"|\w+)\s*\.\s*("[^"]+"|\w+)(@\S+)?/i.exec(sql);
        if (fm && !fm[3]) addExternal(unq(fm[1]), `синоним ${owner}.${name} → ${unq(fm[1])}.${unq(fm[2])}`);
      }
      if (type === 'TRIGGER') {
        const om = /\bON\s+("[^"]+"|\w+)\s*\.\s*("[^"]+"|\w+)/i.exec(sql);
        if (om && unq(om[1]) !== owner) addExternal(unq(om[1]), `триггер ${owner}.${name} на ${unq(om[1])}.${unq(om[2])}`);
      }
      continue;
    }
    // внешние ключи: ALTER TABLE "O"."T" ADD CONSTRAINT … FOREIGN KEY … REFERENCES "O2"."T2"
    const fk = /^\s*ALTER\s+TABLE\s+("[^"]+"|[\w$#]+)(?:\s*\.\s*("[^"]+"|[\w$#]+))?[\s\S]*?\bREFERENCES\s+("[^"]+"|[\w$#]+)(?:\s*\.\s*("[^"]+"|[\w$#]+))?/i.exec(sql);
    if (fk) {
      const from = fk[2] ? [unq(fk[1]), unq(fk[2])] : [cur, unq(fk[1])];
      fkRefs.push({ from, to: fk[4] ? [unq(fk[3]), unq(fk[4])] : [from[0], unq(fk[3])] });
      continue;
    }
    // ALTER USER … QUOTA … ON ts / DEFAULT TABLESPACE
    const au = /^\s*ALTER\s+USER\s+"?([A-Za-z0-9_$#]+)"?([\s\S]*)/i.exec(sql);
    if (au) {
      const u = au[1].toUpperCase();
      const re = /QUOTA\s+\S+\s+ON\s+"?([A-Za-z0-9_$#]+)"?/gi; let q;
      while ((q = re.exec(au[2]))) useTs(q[1].toUpperCase(), u);
      const dt = /DEFAULT\s+TABLESPACE\s+"?([A-Za-z0-9_$#]+)"?/i.exec(au[2]);
      if (dt) useTs(dt[1].toUpperCase(), u);
      continue;
    }
    // GRANT
    const g = /^\s*GRANT\s+([\s\S]+?)\s+TO\s+([\s\S]+?)(\s+WITH\s+(ADMIN|GRANT|HIERARCHY|DELEGATE)\s+OPTION)?\s*;?\s*$/i.exec(sql);
    if (g) {
      const who = g[2].split(',').map(x => x.trim()).filter(Boolean).map(unq);
      for (const w of who) if (w !== 'PUBLIC') grantees.add(w);
      const on = /\bON\s+(?:DIRECTORY\s+)?("[^"]+"|[\w$#]+)(?:\s*\.\s*("[^"]+"|[\w$#]+))?\s*$/i.exec(g[1]);
      if (on) { if (on[2]) { const o = unq(on[1]); if (!schemas.has(o)) addExternal(o, `права на ${o}.${unq(on[2])}`); } }
      else for (const r of g[1].match(/"[^"]+"/g) || []) rolesUsed.add(unq(r));
    }
  }

  const schemaNames = new Set(schemas.keys());
  for (const { from, to } of fkRefs) { const o = objs.get(`TABLE:${from[0]}.${from[1]}`); if (o) o.tokens.push(to); }
  const objects = resolveObjects(objs);
  const externalRefs = [...external].filter(([o]) => !schemaNames.has(o)).map(([schema, s]) => ({ schema, samples: [...s] }));
  const createdTs = new Set(tsCreated.map(t => t.name));
  return {
    schemas: [...schemas.values()].filter(s => s.total || s.createUser).map(s => ({ ...s, tablespaces: [...s.tablespaces] })),
    tablespacesUsed: [...tsUsed.values()].filter(t => !createdTs.has(t.name)).map(t => ({ ...t, schemas: [...t.schemas] })),
    tablespacesCreated: tsCreated,
    rolesCreated: [...rolesCreated],
    rolesUsed: [...rolesUsed].filter(r => !BUILTIN_ROLES.has(r)),
    grantees: [...grantees].filter(r => !BUILTIN_ROLES.has(r) && !SYSTEM_SCHEMAS.has(r)),
    externalRefs, dbLinks, directories, byteColumns, typePaths, jobs, lobTables: lobs, statements,
    objectNames: Object.fromEntries(Object.entries(objectNames).map(([o, set]) => [o, [...set]])), codeRefs, objects,
  };
}

/** Идентификаторы и пары «схема.имя» из текста (без комментариев и строк). */
function nameTokens(sql) {
  const { cleanCode } = require('../compare/translation');
  const code = cleanCode(sql);
  const out = new Set(), res = [];
  const re = /(?<![\w$#."])("[^"]+"|[A-Za-z][\w$#]*)(?:\s*\.\s*("[^"]+"|[A-Za-z][\w$#]*))?/g; let m;
  while ((m = re.exec(code))) {
    const a = unq(m[1]), b = m[2] ? unq(m[2]) : null;
    const k = `${a}.${b || ''}`;
    if (!out.has(k)) { out.add(k); res.push(b ? [a, b] : [null, a]); }
  }
  return res;
}

/** Зависимости между объектами дампа: токены → id объектов дампа. */
function resolveObjects(objs) {
  const byName = new Map();   // OWNER.NAME → id (пространство имён таблиц, представлений, кода, синонимов)
  for (const o of objs.values()) if (o.type !== 'TRIGGER') { const k = `${o.owner}.${o.name}`; if (!byName.has(k)) byName.set(k, o.id); }
  const out = [];
  for (const o of objs.values()) {
    const deps = new Set();
    const look = (a, b) => {
      if (a && b) { const id = byName.get(`${a}.${b}`) || byName.get(`${o.owner}.${a}`); if (id) return id; return null; } // схема.объект или пакет.подпрограмма / таблица.колонка
      return byName.get(`${o.owner}.${b}`) || null;
    };
    for (const [a, b] of o.tokens) { const id = look(a, b); if (id && id !== o.id) deps.add(id); }
    if (o.typeTokens) for (const [a, b] of o.typeTokens) { const id = look(a, b); if (id && id.startsWith('TYPE:')) deps.add(id); }
    if (o.on) { const id = byName.get(`${o.on[0]}.${o.on[1]}`); if (id) deps.add(id); }
    const x = { id: o.id, type: o.type, owner: o.owner, name: o.name, deps: [...deps] };
    if (o.type === 'TRIGGER' && o.on) x.on = byName.get(`${o.on[0]}.${o.on[1]}`) || null;
    out.push(x);
  }
  return out;
}

module.exports = { parseDdl, SYSTEM_SCHEMAS, BUILTIN_ROLES };
