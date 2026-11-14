'use strict';
// Импорт дампа Oracle без доступа к базе-источнику.
//  dump-analyze: файл → формат, состав (через SQL_FILE Data Pump или разбор exp), состояние базы-приёмника, проблемы и решения.
//  dump-import:  план (SQL до, задания Data Pump / imp, SQL после) → выполнение → разбор журнала с подсказками.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { connect } = require('../db');
const { oracledb, buildConnectString } = require('../db/oracle');
const { getConnection, publicConnection, getSettings } = require('../lib/store');
const { run, IS_WIN } = require('../lib/proc');
const jobs = require('../lib/jobs');
const { scanDumpFile, gunzipFile, extractLegacyDdl, parseHeader } = require('./header');
const { parseDdl } = require('./sqlfile');
const { analyzeIssues, buildPlan, dpBlock, impdpCommand } = require('./plan');
const { classifyLog, importedRows } = require('./errors');

const DIR_NAME = 'DBCMP_DUMP_DIR';
const lc = s => String(s || '').toLowerCase();
const normPath = p => lc(String(p || '').replace(/[\\/]+$/, '').replace(/\\/g, '/'));

// ---------- Состояние базы-приёмника ----------
async function targetState(db, names, ctx) {
  const one = async (sql, binds, def = null) => { try { const r = await db.query(sql, binds); return r; } catch { return def; } };
  const t = { privs: {}, users: {}, tablespaces: [], roles: [], staleJobs: [], allUsers: [] };
  t.user = (await db.query(`SELECT USER AS u FROM dual`))[0].u;
  const con = await one(`SELECT SYS_CONTEXT('USERENV','CON_NAME') AS c FROM dual`);
  t.conName = con && con[0] ? con[0].c : null;
  const ver = await one(`SELECT version FROM product_component_version WHERE product LIKE 'Oracle%' AND ROWNUM = 1`);
  t.version = ver && ver[0] ? ver[0].version : null;
  const ban = await one(`SELECT banner FROM v$version WHERE ROWNUM = 1`);
  t.banner = ban && ban[0] ? ban[0].banner : null;
  if (t.banner && /Express Edition/i.test(t.banner)) t.edition = 'XE';
  const nls = await db.query(`SELECT parameter, value FROM nls_database_parameters WHERE parameter IN ('NLS_CHARACTERSET','NLS_NCHAR_CHARACTERSET')`);
  for (const r of nls) if (r.parameter === 'NLS_CHARACTERSET') t.charset = r.value; else t.ncharset = r.value;
  const roles = new Set(((await one(`SELECT role FROM session_roles`, {}, [])) || []).map(r => r.role));
  const privs = new Set(((await one(`SELECT privilege FROM session_privs`, {}, [])) || []).map(r => r.privilege));
  t.privs = { dba: roles.has('DBA'), dpImp: roles.has('DATAPUMP_IMP_FULL_DATABASE'), impFull: roles.has('IMP_FULL_DATABASE'),
    createAnyDirectory: privs.has('CREATE ANY DIRECTORY'), dropUser: privs.has('DROP USER'), createUser: privs.has('CREATE USER'),
    createTablespace: privs.has('CREATE TABLESPACE'), createRole: privs.has('CREATE ROLE'), alterSystem: privs.has('ALTER SYSTEM') };
  t.privs.dbaViews = !!(await one(`SELECT 1 AS x FROM dba_users WHERE ROWNUM = 1`));
  const V = t.privs.dbaViews ? 'dba' : 'all';
  t.allUsers = ((await one(`SELECT username FROM all_users`, {}, [])) || []).map(r => r.username);
  const want = [...new Set(names)];
  for (const n of want) {
    const exists = t.allUsers.includes(n);
    const u = { exists, total: 0, objects: {}, sessions: 0 };
    if (exists) {
      const objs = await one(`SELECT object_type AS t, COUNT(*) AS n FROM ${V}_objects WHERE owner = :o AND object_name NOT LIKE 'BIN$%' AND object_type NOT IN ('LOB','INDEX PARTITION','TABLE PARTITION','LOB PARTITION','TABLE SUBPARTITION','INDEX SUBPARTITION') GROUP BY object_type`, { o: n }, []);
      for (const r of objs || []) { u.objects[r.t] = Number(r.n); u.total += Number(r.n); }
      const ses = await one(`SELECT COUNT(*) AS n FROM v$session WHERE username = :o`, { o: n });
      u.sessions = ses && ses[0] ? Number(ses[0].n) : null;
    }
    t.users[n] = u;
  }
  const ts = await one(`
    SELECT t.tablespace_name AS name, t.contents,
           ROUND(NVL(f.free, 0) / 1048576) AS free_mb,
           ROUND((NVL(d.maxsize, 0) - NVL(d.used, 0) + NVL(f.free, 0)) / 1048576) AS max_mb
    FROM dba_tablespaces t
    LEFT JOIN (SELECT tablespace_name, SUM(bytes) AS free FROM dba_free_space GROUP BY tablespace_name) f ON f.tablespace_name = t.tablespace_name
    LEFT JOIN (SELECT tablespace_name, SUM(bytes) AS used, SUM(CASE WHEN autoextensible = 'YES' THEN GREATEST(maxbytes, bytes) ELSE bytes END) AS maxsize
               FROM dba_data_files GROUP BY tablespace_name) d ON d.tablespace_name = t.tablespace_name`)
    || await one(`SELECT tablespace_name AS name, contents FROM user_tablespaces`, {}, []);
  t.tablespaces = (ts || []).map(r => ({ name: r.name, contents: r.contents, freeMb: r.free_mb != null ? Number(r.free_mb) : null, maxMb: r.max_mb != null ? Number(r.max_mb) : null }));
  const props = await one(`SELECT property_name AS k, property_value AS v FROM database_properties WHERE property_name IN ('DEFAULT_PERMANENT_TABLESPACE','DEFAULT_TEMP_TABLESPACE')`, {}, []);
  for (const r of props || []) if (r.k === 'DEFAULT_PERMANENT_TABLESPACE') t.defaultPermanent = r.v; else t.defaultTemp = r.v;
  t.roles = ((await one(`SELECT role FROM dba_roles`, {}, [])) || []).map(r => r.role);
  const df = await one(`SELECT file_name FROM dba_data_files WHERE ROWNUM = 1`);
  if (df && df[0]) { const f = df[0].file_name; const i = Math.max(f.lastIndexOf('/'), f.lastIndexOf('\\')); t.datafileDir = f.slice(0, i); t.sep = f[i]; }
  const omf = await one(`SELECT value FROM v$parameter WHERE name = 'db_create_file_dest'`);
  t.omf = !!(omf && omf[0] && omf[0].value);
  const sj = await one(`SELECT owner_name AS owner, job_name AS job FROM ${t.privs.dbaViews ? 'dba_datapump_jobs' : 'user_datapump_jobs j, (SELECT USER AS owner_name FROM dual) u'} WHERE state = 'NOT RUNNING' AND attached_sessions = 0`, {}, []);
  t.staleJobs = (sj || []).filter(j => /^(SYS_(IMPORT|EXPORT|SQL_FILE)_|DBCMP_)/.test(j.job));
  t.directories = ((await one(`SELECT directory_name AS name, directory_path AS path FROM all_directories`, {}, [])) || []);
  if (ctx) ctx.log(`Приёмник: ${t.banner || t.version || 'Oracle'}, контейнер ${t.conName || '—'}, кодировка ${t.charset}, пользователь ${t.user}${t.privs.dba ? ' (DBA)' : t.privs.dpImp ? ' (DATAPUMP_IMP_FULL_DATABASE)' : ''}`);
  return t;
}

// ---------- Файл на сервере базы ----------
async function serverFileInfo(db, dir, name) {
  const r = await db.raw.execute(`
    DECLARE b BFILE := BFILENAME(:d, :f);
    BEGIN
      :e := DBMS_LOB.FILEEXISTS(b);
      IF :e = 1 THEN DBMS_LOB.FILEOPEN(b, DBMS_LOB.FILE_READONLY); :len := DBMS_LOB.GETLENGTH(b); DBMS_LOB.FILECLOSE(b); END IF;
    EXCEPTION WHEN OTHERS THEN :err := SQLERRM; :e := 0;
    END;`, {
    d: dir, f: name,
    e: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }, len: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    err: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 4000 },
  });
  return { exists: r.outBinds.e === 1, length: r.outBinds.len, error: r.outBinds.err };
}

/** Каталог Oracle для папки файла: существующий, созданный, или копирование через соединение. */
async function resolveDirectory(db, t, header, ctx, { autoCopy }) {
  const folder = header.folder;
  const found = (t.directories || []).find(d => normPath(d.path) === normPath(folder));
  const res = { folder, name: null, visible: false, copyPossible: false, copyTo: null, created: false, reason: '' };
  if (found) res.name = found.name;
  else {
    try {
      await db.exec(`CREATE OR REPLACE DIRECTORY ${DIR_NAME} AS '${folder.replace(/'/g, "''")}'`);
      res.name = DIR_NAME; res.created = true;
      ctx.log(`Создан каталог ${DIR_NAME} → ${folder}`);
    } catch (e) { res.reason = `Не удалось создать каталог для папки ${folder}: ${e.message.split('\n')[0]}`; }
  }
  if (res.name) {
    const info = await serverFileInfo(db, res.name, header.parts[0]);
    if (info.exists && Number(info.length) === header.size) res.visible = true;
    else if (info.exists) res.reason = `На сервере базы по пути ${folder} лежит другой файл (размер ${info.length}, здесь ${header.size}) — база на другом компьютере.`;
    else res.reason = info.error ? `Сервер базы не может прочитать файл: ${info.error.split('\n')[0]}` : `Сервер базы не видит ${path.join(folder, header.parts[0])} — база на другом компьютере (или в контейнере), либо у службы Oracle нет прав на папку.`;
  }
  // куда копировать
  const dpDir = (t.directories || []).find(d => d.name === 'DATA_PUMP_DIR');
  if (!res.visible) {
    res.copyTo = dpDir ? 'DATA_PUMP_DIR' : null;
    res.copyPossible = !!res.copyTo;
    if (!res.copyPossible) res.reason += ' Каталога DATA_PUMP_DIR нет — копирование невозможно.';
  }
  if (!res.visible && res.copyPossible && autoCopy) {
    for (const part of header.parts) await copyToServer(db, path.join(folder, part), res.copyTo, part, ctx);
    const info = await serverFileInfo(db, res.copyTo, header.parts[0]);
    if (!info.exists || Number(info.length) !== header.size) throw new Error(`После копирования файл на сервере не совпадает по размеру (${info.length} / ${header.size})`);
    res.name = res.copyTo; res.visible = true; res.copied = true; res.reason = '';
  }
  return res;
}

/** Копирование файла на сервер базы через соединение (UTL_FILE, частями по 8 МБ). */
async function copyToServer(db, local, dir, name, ctx) {
  const size = fs.statSync(local).size;
  const fd = fs.openSync(local, 'r');
  const CH = 8 * 1024 * 1024;
  const buf = Buffer.alloc(CH);
  let off = 0, first = true;
  const started = Date.now();
  ctx.log(`Копирование ${name} (${Math.round(size / 1048576)} МБ) в каталог ${dir} через соединение…`);
  try {
    while (off < size || first) {
      ctx.checkCancel();
      const n = fs.readSync(fd, buf, 0, CH, off);
      await db.raw.execute(`
        DECLARE f UTL_FILE.FILE_TYPE; len PLS_INTEGER := DBMS_LOB.GETLENGTH(:b); pos PLS_INTEGER := 1;
        BEGIN
          f := UTL_FILE.FOPEN(:d, :f, CASE WHEN :first = 1 THEN 'wb' ELSE 'ab' END, 32767);
          WHILE pos <= len LOOP UTL_FILE.PUT_RAW(f, DBMS_LOB.SUBSTR(:b, 32000, pos), TRUE); pos := pos + 32000; END LOOP;
          UTL_FILE.FCLOSE(f);
        END;`, { b: { type: oracledb.DB_TYPE_BLOB, val: buf.subarray(0, n) }, d: dir, f: name, first: first ? 1 : 0 });
      off += n; first = false;
      const sec = (Date.now() - started) / 1000;
      ctx.progress(off, size, `Копирование ${name}: ${Math.round(off / 1048576)} из ${Math.round(size / 1048576)} МБ${sec > 3 ? `, ${(off / 1048576 / sec).toFixed(1)} МБ/с` : ''}`);
      if (!n) break;
    }
  } finally { fs.closeSync(fd); }
  ctx.log(`Скопировано: ${name}`);
}

/** Чтение файла с сервера базы (SQL-файл, журнал Data Pump). */
async function readServerFile(db, dir, name, maxBytes = 300 * 1024 * 1024) {
  const chunks = [];
  let off = 1;
  for (;;) {
    const r = await db.raw.execute(`
      DECLARE b BFILE := BFILENAME(:d, :f); t BLOB; dst INTEGER := 1; src INTEGER := :off; total INTEGER;
      BEGIN
        DBMS_LOB.FILEOPEN(b, DBMS_LOB.FILE_READONLY);
        total := DBMS_LOB.GETLENGTH(b);
        DBMS_LOB.CREATETEMPORARY(t, TRUE);
        IF :off <= total THEN DBMS_LOB.LOADBLOBFROMFILE(t, b, LEAST(:amt, total - :off + 1), dst, src); END IF;
        DBMS_LOB.FILECLOSE(b);
        :total := total; :out := t;
      END;`, {
      d: dir, f: name, off, amt: 4 * 1024 * 1024,
      total: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }, out: { dir: oracledb.BIND_OUT, type: oracledb.DB_TYPE_BLOB },
    });
    const lob = r.outBinds.out;
    const data = lob ? await lob.getData() : null;
    if (lob && lob.close) await lob.close().catch(() => {});
    if (data && data.length) chunks.push(data);
    off += data ? data.length : 0;
    if (!data || !data.length || off > r.outBinds.total || off > maxBytes) break;
  }
  return Buffer.concat(chunks);
}
function decode(buf, charset) {
  const map = { AL32UTF8: 'utf-8', UTF8: 'utf-8', CL8MSWIN1251: 'windows-1251', WE8MSWIN1252: 'windows-1252', CL8KOI8R: 'koi8-r', CL8ISO8859P5: 'iso-8859-5', RU8PC866: 'ibm866' };
  try { return new TextDecoder(map[charset] || 'latin1').decode(buf); } catch { return buf.toString('latin1'); }
}
async function removeServerFile(db, dir, name) {
  await db.raw.execute(`BEGIN UTL_FILE.FREMOVE(:d, :f); EXCEPTION WHEN OTHERS THEN NULL; END;`, { d: dir, f: name }).catch(() => {});
}

// ---------- Data Pump: заголовок и SQL-файл ----------
async function dumpFileInfo(db, dir, name) {
  await db.raw.execute(`BEGIN DBMS_OUTPUT.ENABLE(NULL); END;`);
  const r = await db.raw.execute(`
    DECLARE info ku$_dumpfile_info; ft NUMBER; i NUMBER;
    BEGIN
      DBMS_DATAPUMP.GET_DUMPFILE_INFO(:f, :d, info, ft);
      :ft := ft;
      i := info.FIRST;
      WHILE i IS NOT NULL LOOP
        DBMS_OUTPUT.PUT_LINE(CASE info(i).item_code
          WHEN DBMS_DATAPUMP.KU$_DFHDR_DB_VERSION THEN 'dbVersion' WHEN DBMS_DATAPUMP.KU$_DFHDR_CHARSET_ID THEN 'charsetId'
          WHEN DBMS_DATAPUMP.KU$_DFHDR_JOB_NAME THEN 'jobName' WHEN DBMS_DATAPUMP.KU$_DFHDR_PLATFORM THEN 'platform'
          WHEN DBMS_DATAPUMP.KU$_DFHDR_CREATION_DATE THEN 'created' WHEN DBMS_DATAPUMP.KU$_DFHDR_FILE_VERSION THEN 'fileVersion'
          WHEN DBMS_DATAPUMP.KU$_DFHDR_METADATA_COMPRESSED THEN 'metadataCompressed' WHEN DBMS_DATAPUMP.KU$_DFHDR_MASTER_PRESENT THEN 'masterPresent'
          WHEN DBMS_DATAPUMP.KU$_DFHDR_FILE_NUMBER THEN 'fileNumber' WHEN DBMS_DATAPUMP.KU$_DFHDR_LANGUAGE THEN 'language'
          ELSE 'code' || info(i).item_code END || '=' || info(i).value);
        i := info.NEXT(i);
      END LOOP;
    END;`, { f: name, d: dir, ft: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } });
  const lines = await db.readOutput();
  const info = { fileType: { 0: 'unknown', 1: 'datapump', 2: 'exp', 3: 'external' }[r.outBinds.ft] || String(r.outBinds.ft) };
  for (const l of lines) { const i = l.indexOf('='); if (i > 0) info[l.slice(0, i)] = l.slice(i + 1); }
  if (info.charsetId) {
    const cs = await db.query(`SELECT NLS_CHARSET_NAME(:i) AS n FROM dual`, { i: Number(info.charsetId) }).catch(() => []);
    info.charset = cs[0] ? cs[0].n : null;
  }
  return info;
}

async function runDp(db, mon, block, jobName, ctx, title) {
  await db.raw.execute(`BEGIN DBMS_OUTPUT.ENABLE(NULL); END;`);
  let finished = false;
  const poll = (async () => {
    while (!finished) {
      await new Promise(r => setTimeout(r, 3000));
      if (finished) break;
      if (ctx.cancelled) {
        await mon.raw.execute(`DECLARE h NUMBER; BEGIN h := DBMS_DATAPUMP.ATTACH(:j, USER); DBMS_DATAPUMP.STOP_JOB(h, 1, 0); END;`, { j: jobName }).catch(() => {});
        break;
      }
      const pct = await mon.query(`SELECT ROUND(sofar / NULLIF(totalwork, 0) * 100) AS pct FROM v$session_longops WHERE opname = :j AND sofar <> totalwork`, { j: jobName }).catch(() => []);
      const p = pct[0] && pct[0].pct != null ? Number(pct[0].pct) : null;
      ctx.progress(p ?? 0, 100, `${title}${p != null ? `: ${p}%` : '…'}`);
    }
  })();
  let state = null, error = null;
  try { const r = await db.raw.execute(block, { final: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 30 } }); state = r.outBinds.final; }
  catch (e) { error = e.message; }
  finished = true;
  await poll;
  const lines = await db.readOutput().catch(() => []);
  for (const l of lines) ctx.log(l, /ORA-\d{5}/.test(l) ? (/ORA-(31684|39152|39153)/.test(l) ? 'info' : 'warning') : 'info');
  if (error) { ctx.log(error, 'error'); lines.push(error); }
  if (ctx.cancelled) throw Object.assign(new Error('Задача отменена пользователем'), { cancelled: true });
  return { state: state || 'FAILED', error, lines };
}

// ---------- imp ----------
function findImp() {
  const exe = IS_WIN ? 'imp.exe' : 'imp';
  const s = getSettings();
  const cands = [s.oracleBinPath && path.join(s.oracleBinPath, exe), process.env.ORACLE_HOME && path.join(process.env.ORACLE_HOME, 'bin', exe)].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) { const c = path.join(dir, exe); if (dir && fs.existsSync(c)) return c; }
  return null;
}

// ---------- Задача «Анализ дампа» ----------
async function runDumpAnalyze(p, ctx) {
  let file = String(p.file || '').trim().replace(/^"|"$/g, '');
  if (!file) throw new Error('Укажите путь к файлу дампа');
  ctx.progress(0, 0, 'Чтение заголовка…');
  let header = scanDumpFile(file);
  if (header.format === 'gzip') {
    if (!p.decompress) return { summary: { format: 'gzip', issues: 1, blocking: 1 }, header, issues: [{ id: 'archive', level: 'error', blocking: true, title: 'Файл сжат gzip', details: 'Приложение может распаковать его рядом с архивом.', fixes: [{ id: 'decompress', title: 'Распаковать и проанализировать', default: true }] }] };
    ctx.log('Распаковка gzip…');
    file = await gunzipFile(file, ctx);
    header = scanDumpFile(file);
  }
  if (['zip', '7z', 'rar'].includes(header.format))
    return { summary: { format: header.format, issues: 1, blocking: 1 }, header, issues: [{ id: 'archive', level: 'error', blocking: true, title: `Это архив ${header.format}`, details: 'Распакуйте архив и укажите файл .dmp (для набора частей — любую из них).' }] };
  ctx.log(`Файл: ${file}, ${Math.round(header.size / 1048576)} МБ, формат: ${{ datapump: 'Data Pump (expdp)', exp: 'exp (старый)', unknown: 'не распознан' }[header.format]}${header.parts.length > 1 ? `, частей: ${header.parts.length}` : ''}`);
  if (header.dbVersion) ctx.log(`Версия базы-источника: ${header.dbVersion}${header.charset ? `, кодировка ${header.charset}` : ''}${header.jobName ? `, задание ${header.jobOwner}.${header.jobName}` : ''}`);

  const result = { header, format: header.format, totalSize: header.totalSize, encryptionPassword: p.encryptionPassword ? '***' : '' };
  let contents = null, legacyText = null;
  if (header.format === 'exp') {
    legacyText = await extractLegacyDdl(file, ctx);
    contents = parseDdl(legacyText, { legacy: true, defaultSchema: header.exportedBy });
    result.impPath = findImp();
  }
  if (!p.targetId) {
    result.contents = contents;
    const an = analyzeIssues({ ...result, target: { privs: { dba: true }, users: {}, tablespaces: [], user: '' }, contents });
    const issues = an.issues.filter(i => ['format', 'imp'].includes(i.id));
    issues.push({ id: 'notarget', level: 'info', fixes: [], title: 'База-приёмник не выбрана — проверен только файл',
      details: header.format === 'datapump' ? 'Состав дампа Data Pump хранится сжатым: схемы, табличные пространства и роли можно прочитать только через базу Oracle (DBMS_DATAPUMP). Выберите подключение и повторите анализ.' : 'Выберите подключение, чтобы проверить существующие схемы, табличные пространства, права и место.' });
    return { ...result, issues, defaults: an.defaults, summary: summarize(header, contents, issues), noTarget: true };
  }
  const tConn = getConnection(p.targetId);
  if (tConn.type !== 'oracle') throw new Error('Дамп Oracle импортируется в базу Oracle. Для PostgreSQL: импортируйте в локальный Oracle, затем «Миграция → Конвейер».');
  const db = await connect(tConn);
  try {
    ctx.progress(0, 0, 'Состояние базы-приёмника…');
    let t = await targetState(db, contents ? contents.schemas.map(s => s.name) : [], ctx);
    result.target = t;
    if (header.format !== 'exp') {
      ctx.progress(0, 0, 'Доступ сервера базы к файлу…');
      const dir = await resolveDirectory(db, t, header, ctx, { autoCopy: p.autoCopy !== false });
      result.directory = dir;
      if (dir.visible) {
        try { result.dumpInfo = await dumpFileInfo(db, dir.name, header.parts[0]); ctx.log(`Заголовок: ${JSON.stringify(result.dumpInfo)}`); }
        catch (e) { ctx.log(`GET_DUMPFILE_INFO: ${e.message}`, 'warning'); }
        if (result.dumpInfo && result.dumpInfo.fileType === 'exp') { header.format = 'exp'; result.format = 'exp'; }
        if (result.format === 'datapump') {
          ctx.progress(0, 0, 'Чтение состава дампа (SQL_FILE)…');
          const id = crypto.randomBytes(3).toString('hex').toUpperCase();
          const sqlName = `dbcmp_${id}.sql`, logName = `dbcmp_${id}_sqlfile.log`;
          const mon = await connect(tConn);
          const work = workDir(t, dir.name);
          try {
            const r = await runDp(db, mon, dpBlock({ operation: 'SQL_FILE', jobName: `DBCMP_SQL_${id}`, dir: dir.name, workDir: work, files: header.parts, sqlFile: sqlName, logFile: logName, job: { password: p.encryptionPassword } }), `DBCMP_SQL_${id}`, ctx, 'Чтение состава дампа');
            result.sqlFileLog = r.lines.slice(-200);
            if (r.lines.some(l => /ORA-39174|ORA-39176/.test(l))) result.encrypted = true;
            if (r.lines.some(l => /ORA-39143/.test(l))) { result.format = 'exp'; header.format = 'exp'; }
            if (r.lines.some(l => /ORA-39142/.test(l))) result.versionError = r.lines.find(l => /ORA-39142/.test(l));
            if (r.state === 'COMPLETED') {
              const buf = await readServerFile(db, work, sqlName);
              contents = parseDdl(decode(buf, t.charset));
              ctx.log(`Состав: схем ${contents.schemas.length}, операторов ${contents.statements}`);
            } else ctx.log(`SQL_FILE не выполнен (${r.state}) — состав дампа неизвестен`, 'warning');
          } finally {
            await removeServerFile(db, work, sqlName); await removeServerFile(db, work, logName);
            await mon.close();
          }
        }
      }
      if (result.format === 'exp' && !legacyText) {
        legacyText = await extractLegacyDdl(file, ctx);
        contents = parseDdl(legacyText, { legacy: true, defaultSchema: header.exportedBy });
        result.impPath = findImp();
      }
      // состояние пользователей дампа
      if (contents) { t = await targetState(db, contents.schemas.map(s => s.name), null); t.directories = result.target.directories; result.target = t; }
    }
    result.contents = contents;
    // зависимости кода от схем, объектов и DB links вне дампа
    if (contents && contents.codeRefs && contents.codeRefs.length) {
      ctx.progress(0, 0, 'Проверка зависимостей кода…');
      try {
        const { resolveInOracle } = require('./codedeps');
        result.codeDeps = await resolveInOracle(db, contents, result.target);
        ctx.log(`Зависимости кода: проверено ссылок ${result.codeDeps.checked}, не найдено ${result.codeDeps.missing.length}, DB links вне дампа и базы: ${result.codeDeps.dblinks.length}`, result.codeDeps.missing.length ? 'warning' : 'info');
      } catch (e) { ctx.log(`Зависимости кода не проверены: ${e.message}`, 'warning'); }
    }
    result.encryptionPassword = p.encryptionPassword || '';
    const an = analyzeIssues(result);
    if (result.versionError) an.issues.unshift({ id: 'version', level: 'error', blocking: true, title: 'Дамп сделан более новой версией Oracle', details: `${result.versionError}. Нужен повторный экспорт с VERSION=${(t.version || '').split('.')[0]}.`, fixes: [] });
    if (!contents && result.format === 'datapump' && result.directory && result.directory.visible && !result.encrypted)
      an.issues.push({ id: 'contents', level: 'warning', title: 'Состав дампа прочитать не удалось', details: 'Импорт возможен, но заранее проверить схемы и табличные пространства нельзя. См. журнал задачи.', fixes: [] });
    result.encryptionPassword = p.encryptionPassword ? '***' : '';
    result.passwordGiven = !!p.encryptionPassword;
    an.defaults.password = '';                     // пароль шифрования не сохраняется в результате задачи
    result.targetId = p.targetId;
    return { ...result, file, issues: an.issues, defaults: an.defaults, summary: summarize(header, contents, an.issues) };
  } finally { await db.close(); }
}

const workDir = (t, dir) => ((t.directories || []).some(d => d.name === 'DATA_PUMP_DIR') ? 'DATA_PUMP_DIR' : dir);

function summarize(header, contents, issues) {
  return {
    format: header.format, sizeMb: Math.round((header.totalSize || header.size) / 1048576), schemas: contents ? contents.schemas.length : null,
    objects: contents ? contents.schemas.reduce((s, x) => s + x.total, 0) : null,
    errors: issues.filter(i => i.level === 'error').length, warnings: issues.filter(i => i.level === 'warning').length,
    blocking: issues.filter(i => i.blocking || i.needsDecision).length,
  };
}

function loadAnalysis(p) {
  const j = p.analysisJobId ? jobs.getJob(p.analysisJobId, true) : null;
  const a = j && j.result ? j.result : p.analysis;
  if (!a || !a.header) throw new Error('Сначала выполните анализ дампа');
  return a;
}

/** План для предпросмотра (без выполнения). */
function previewPlan(p) {
  const a = loadAnalysis(p);
  const d = mergeDecisions(a.defaults, p.decisions);
  const plan = buildPlan(a, { issues: a.issues, defaults: a.defaults }, d);
  if (plan.jobs) plan.commands = plan.jobs.filter(j => !j.between).map(j => impdpCommand(a.target, (a.directory || {}).name || 'DATA_PUMP_DIR', a.header.parts, j));
  return { ...plan, decisions: d };
}
function mergeDecisions(def, dec = {}) {
  const d = JSON.parse(JSON.stringify(def || {}));
  for (const [k, v] of Object.entries(dec || {})) {
    if ((k === 'schemas' || k === 'tablespaces') && v && typeof v === 'object') d[k] = { ...(d[k] || {}), ...Object.fromEntries(Object.entries(v).map(([n, x]) => [n, { ...((d[k] || {})[n] || {}), ...x }])) };
    else d[k] = v;
  }
  return d;
}

// ---------- Задача «Импорт дампа» ----------
async function runDumpImport(p, ctx) {
  const a = loadAnalysis(p);
  const d = mergeDecisions(a.defaults, p.decisions);
  if (p.encryptionPassword) d.password = p.encryptionPassword;
  const plan = buildPlan(a, { issues: a.issues, defaults: a.defaults }, d);
  if (plan.blocking.length) throw new Error(`Не решены проблемы: ${plan.blocking.join('; ')}`);
  const tConn = getConnection(p.targetId || a.targetId);
  const db = await connect(tConn);
  const mon = await connect(tConn);
  const all = [];
  const phases = [];
  const started = Date.now();
  try {
    // 0. файл на сервере
    let dir = a.directory && a.directory.name;
    if (a.format === 'datapump' && (!a.directory || !a.directory.visible)) {
      const t = await targetState(db, [], null);
      const res = await resolveDirectory(db, t, a.header, ctx, { autoCopy: d.copy !== false });
      if (!res.visible) throw new Error(res.reason || 'Сервер базы не видит файл');
      dir = res.name;
    }
    // 1. SQL до импорта
    const runSql = async (list, title) => {
      const ph = { title, state: 'COMPLETED', steps: [] };
      for (const s of list) {
        ctx.checkCancel();
        const shown = s.secret ? s.sql.replace(s.secret, '***') : s.sql;
        try { await db.exec(s.sql); ctx.log(`✓ ${s.title}`); ph.steps.push({ title: s.title, sql: shown, ok: true }); }
        catch (e) {
          const msg = e.message.split('\n')[0];
          ctx.log(`✗ ${s.title}: ${msg}`, 'error'); all.push(msg);
          ph.steps.push({ title: s.title, sql: shown, ok: false, error: msg });
          if (s.danger || /DROP USER/.test(s.sql)) { ph.state = 'FAILED'; phases.push(ph); throw new Error(`${s.title}: ${msg}`); }
          ph.state = 'WARNINGS';
        }
      }
      if (list.length) phases.push(ph);
    };
    ctx.progress(0, 0, 'Подготовка базы…');
    await runSql(plan.pre, 'Подготовка');

    // 2. импорт
    if (a.format === 'datapump') {
      for (const job of plan.jobs) {
        ctx.checkCancel();
        if (job.between) { await runSql(job.between, job.title); continue; }
        const id = crypto.randomBytes(3).toString('hex').toUpperCase();
        const jobName = `DBCMP_IMP_${id}`;
        ctx.log(`— ${job.title}: задание ${jobName}`);
        const t0 = Date.now();
        const work = workDir(a.target, dir);
        const r = await runDp(db, mon, dpBlock({ operation: 'IMPORT', jobName, dir, workDir: work, files: a.header.parts, logFile: `dbcmp_imp_${id}.log`, job }), jobName, ctx, job.title);
        all.push(...r.lines);
        phases.push({ title: job.title, state: r.state, ms: Date.now() - t0, errors: r.lines.filter(l => /ORA-\d{5}/.test(l) && !/ORA-(31684|39152|39153)/.test(l)).length, logFile: `${work}:dbcmp_imp_${id}.log`, command: impdpCommand(a.target, dir, a.header.parts, job) });
        if (r.state !== 'COMPLETED' && r.error && !/ORA-39(082|083|151)/.test(r.error)) break;
      }
    } else {
      const imp = findImp() || a.impPath;
      if (!imp) throw new Error('Не найдена утилита imp — укажите папку bin Oracle в «Настройках»');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbcmp-imp-'));
      const log = path.join(tmp, 'imp.log'), par = path.join(tmp, 'imp.par');
      const m = /^(.*?)\s+as\s+(sysdba)$/i.exec(tConn.user || '');
      const userid = `${m ? m[1] : tConn.user}/${tConn.password}@${buildConnectString(tConn)}${m ? ' as sysdba' : ''}`;
      const lines = [`userid="${userid.replace(/"/g, '')}"`, `file="${a.file || a.header.file}"`, `log="${log}"`, 'ignore=y', 'grants=y', 'indexes=y', 'constraints=y', 'rows=y', 'commit=y', 'buffer=10485760', 'feedback=100000'];
      if (plan.imp.fromuser.length) lines.push(`fromuser=(${plan.imp.fromuser.join(',')})`, `touser=(${plan.imp.touser.join(',')})`);
      else lines.push('full=y');
      fs.writeFileSync(par, lines.join('\n'));
      const cs = (a.header && a.header.charset) || 'AL32UTF8';
      const t0 = Date.now();
      try { await run(imp, [`parfile=${par}`], { ctx, env: { NLS_LANG: `AMERICAN_AMERICA.${cs}` } }); }
      catch (e) { ctx.log(e.message, 'warning'); }
      const out = fs.existsSync(log) ? fs.readFileSync(log, 'latin1').split(/\r?\n/) : [];
      all.push(...out);
      phases.push({ title: `imp: ${plan.imp.fromuser.join(', ') || 'full'}`, state: out.some(l => /terminated successfully without warnings/i.test(l)) ? 'COMPLETED' : out.some(l => /terminated successfully/i.test(l)) ? 'COMPLETED WITH WARNINGS' : 'FAILED', ms: Date.now() - t0 });
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    // 3. после импорта
    ctx.progress(0, 0, 'Перекомпиляция и проверка…');
    await runSql(plan.post, 'Перекомпиляция');
    const check = await postCheck(db, a, plan, d);
    const errors = classifyLog(all);
    const real = errors.filter(e => !e.benign);
    const fixes = [...new Set(real.map(e => e.fix).filter(Boolean))];
    const rows = importedRows(all);
    const failed = phases.some(ph => ph.state === 'FAILED' || ph.state === 'STOPPED');
    ctx.log(`Импорт ${failed ? 'завершился с ошибками' : 'завершён'}: строк загружено ${rows.reduce((s, r) => s + r.rows, 0)}, групп ошибок ${real.length}, невалидных объектов ${check.invalid.length}`, failed || real.length ? 'warning' : 'info');
    return {
      summary: { state: failed ? 'FAILED' : real.length ? 'WARNINGS' : 'OK', errors: real.reduce((s, e) => s + e.count, 0), errorGroups: real.length,
        benign: errors.filter(e => e.benign).reduce((s, e) => s + e.count, 0), tables: rows.length, rows: rows.reduce((s, r) => s + r.rows, 0),
        invalid: check.invalid.length, ms: Date.now() - started },
      target: { ...publicConnection(tConn) }, phases, errors, fixes, rows, ...check,
      plan: { pre: plan.pre.map(s => ({ title: s.title, sql: s.secret ? s.sql.replace(s.secret, '***') : s.sql })), jobs: (plan.jobs || []).map(j => j.between ? { title: j.title, count: j.between.length } : { title: j.title, command: impdpCommand(a.target, dir, a.header.parts, j) }), imp: plan.imp },
      passwords: plan.pre.filter(s => s.secret).map(s => ({ title: s.title, password: s.secret })),
      analysisJobId: p.analysisJobId, decisions: d, log: all.slice(-5000),
    };
  } finally { await db.close(); await mon.close(); }
}

async function postCheck(db, a, plan, d) {
  const V = a.target && a.target.privs && a.target.privs.dbaViews ? 'dba' : 'all';
  const invalid = [], counts = [];
  for (const s of plan.targetSchemas) {
    const inv = await db.query(`SELECT object_type AS type, object_name AS name FROM ${V}_objects WHERE owner = :o AND status = 'INVALID' ORDER BY 1, 2`, { o: s }).catch(() => []);
    for (const o of inv.slice(0, 500)) {
      const er = await db.query(`SELECT line, text FROM ${V}_errors WHERE owner = :o AND name = :n AND attribute = 'ERROR' AND ROWNUM <= 3 ORDER BY sequence`, { o: s, n: o.name }).catch(() => []);
      invalid.push({ schema: s, type: o.type, name: o.name, errors: er.map(e => `строка ${e.line}: ${String(e.text).trim()}`) });
    }
    const src = Object.entries(d.schemas || {}).find(([n, x]) => (x.action === 'remap' && x.target && x.target.toUpperCase() === s)) || [s];
    const exp = ((a.contents && a.contents.schemas) || []).find(x => x.name === src[0]);
    const act = await db.query(`SELECT object_type AS t, COUNT(*) AS n FROM ${V}_objects WHERE owner = :o AND object_name NOT LIKE 'BIN$%' GROUP BY object_type`, { o: s }).catch(() => []);
    const actual = Object.fromEntries(act.map(r => [r.t, Number(r.n)]));
    if (exp) for (const [type, n] of Object.entries(exp.objects)) counts.push({ schema: s, type, expected: n, actual: actual[type] || 0 });
  }
  return { invalid, counts };
}

module.exports = { runDumpAnalyze, runDumpImport, previewPlan, targetState, findImp, runDp };
