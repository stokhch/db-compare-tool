'use strict';
// Копирование Oracle → Oracle через Data Pump по сети (NETWORK_LINK):
// импорт запускается на приёмнике через PL/SQL API DBMS_DATAPUMP и тянет данные из источника по DB link.
// Файлы дампа и утилиты expdp/impdp на этой машине не нужны.
const crypto = require('crypto');
const { connect } = require('../db');
const { getConnection } = require('../lib/store');
const { oracledb } = require('../db/oracle');

function descriptor(c) {
  if (c.connectString) return c.connectString;
  const cd = c.oracleConnectMode === 'sid' ? `(SID=${c.database})` : `(SERVICE_NAME=${c.database})`;
  return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${c.host})(PORT=${c.port}))(CONNECT_DATA=${cd}))`;
}
const ident = s => (/^[A-Za-z][\w$#]*$/.test(s) ? s : `"${s}"`);

const PLSQL = `
DECLARE
  h          NUMBER;
  job_state  VARCHAR2(30) := 'UNDEFINED';
  sts        ku$_Status;
  le         ku$_LogEntry;
  ind        NUMBER;
BEGIN
  h := DBMS_DATAPUMP.OPEN(operation => 'IMPORT', job_mode => :jmode, remote_link => :link, job_name => :jname);
  DBMS_DATAPUMP.METADATA_FILTER(h, 'SCHEMA_EXPR', 'IN (''' || :src || ''')');
  IF :tabexpr IS NOT NULL THEN
    DBMS_DATAPUMP.METADATA_FILTER(h, 'NAME_EXPR', :tabexpr, 'TABLE');
  END IF;
  IF :tgt IS NOT NULL AND :tgt <> :src THEN
    DBMS_DATAPUMP.METADATA_REMAP(h, 'REMAP_SCHEMA', :src, :tgt);
  END IF;
  DBMS_DATAPUMP.SET_PARAMETER(h, 'TABLE_EXISTS_ACTION', :tea);
  IF :metaonly = 1 THEN
    DBMS_DATAPUMP.DATA_FILTER(h, 'INCLUDE_ROWS', 0);
  END IF;
  IF :par > 1 THEN
    DBMS_DATAPUMP.SET_PARALLEL(h, :par);
  END IF;
  DBMS_DATAPUMP.START_JOB(h);

  WHILE job_state NOT IN ('COMPLETED', 'STOPPED') LOOP
    DBMS_DATAPUMP.GET_STATUS(h,
      DBMS_DATAPUMP.KU$_STATUS_JOB_ERROR + DBMS_DATAPUMP.KU$_STATUS_JOB_STATUS + DBMS_DATAPUMP.KU$_STATUS_WIP,
      -1, job_state, sts);
    IF BITAND(sts.mask, DBMS_DATAPUMP.KU$_STATUS_WIP) != 0 THEN
      le := sts.wip;
    ELSIF BITAND(sts.mask, DBMS_DATAPUMP.KU$_STATUS_JOB_ERROR) != 0 THEN
      le := sts.error;
    ELSE
      le := NULL;
    END IF;
    IF le IS NOT NULL THEN
      ind := le.FIRST;
      WHILE ind IS NOT NULL LOOP
        DBMS_OUTPUT.PUT_LINE(le(ind).LogText);
        ind := le.NEXT(ind);
      END LOOP;
    END IF;
  END LOOP;
  DBMS_DATAPUMP.DETACH(h);
  :final := job_state;
EXCEPTION
  WHEN OTHERS THEN
    DECLARE
      msg VARCHAR2(4000) := SQLERRM;
    BEGIN
      IF h IS NOT NULL THEN
        BEGIN
          DBMS_DATAPUMP.GET_STATUS(h, DBMS_DATAPUMP.KU$_STATUS_JOB_ERROR, 0, job_state, sts);
          IF BITAND(sts.mask, DBMS_DATAPUMP.KU$_STATUS_JOB_ERROR) != 0 THEN
            le := sts.error;
            ind := le.FIRST;
            WHILE ind IS NOT NULL LOOP
              DBMS_OUTPUT.PUT_LINE(le(ind).LogText);
              ind := le.NEXT(ind);
            END LOOP;
          END IF;
          DBMS_DATAPUMP.DETACH(h);
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
      END IF;
      RAISE_APPLICATION_ERROR(-20001, msg);
    END;
END;`;

async function readDbmsOutput(db) {
  const lines = [];
  for (let i = 0; i < 100000; i++) {
    const r = await db.raw.execute(`BEGIN DBMS_OUTPUT.GET_LINE(:ln, :st); END;`, {
      ln: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 32767 },
      st: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    });
    if (r.outBinds.st !== 0) break;
    lines.push(r.outBinds.ln || '');
  }
  return lines;
}

function commands(s, t, p, link) {
  const src = p.sourceSchema.toUpperCase(), tgt = (p.targetSchema || p.sourceSchema).toUpperCase();
  const remap = src !== tgt ? ` remap_schema=${src}:${tgt}` : '';
  const tabs = (p.tables || []).length ? ` tables=${p.tables.map(x => `${src}.${x}`).join(',')}` : ` schemas=${src}`;
  const content = p.content === 'METADATA_ONLY' ? ' content=METADATA_ONLY' : '';
  const par = p.parallel > 1 ? ` parallel=${p.parallel}` : '';
  return {
    network: `impdp ${t.user}@"${descriptor(t)}" network_link=${link}${tabs}${remap} table_exists_action=${p.tableExistsAction || 'SKIP'}${content}${par} logfile=DATA_PUMP_DIR:imp_${src}.log`,
    exportFile: `expdp ${s.user}@"${descriptor(s)}"${tabs} directory=DATA_PUMP_DIR dumpfile=${src}_%U.dmp logfile=exp_${src}.log${content}${par}`,
    importFile: `impdp ${t.user}@"${descriptor(t)}" directory=DATA_PUMP_DIR dumpfile=${src}_%U.dmp logfile=imp_${src}.log${remap} table_exists_action=${p.tableExistsAction || 'SKIP'}${par}`,
    note: 'Файловый вариант: после expdp скопируйте *.dmp из DATA_PUMP_DIR сервера-источника в DATA_PUMP_DIR сервера-приёмника (scp/общая папка), затем выполните impdp.',
  };
}

async function runDataPump(p, ctx) {
  const s = getConnection(p.sourceId), t = getConnection(p.targetId);
  if (s.type !== 'oracle' || t.type !== 'oracle') throw new Error('Data Pump работает только между базами Oracle');
  const link = (p.dbLinkName || 'DBCMP_LINK').toUpperCase();
  const cmds = commands(s, t, p, link);
  if (p.commandsOnly) return { summary: { commandsOnly: true }, commands: cmds };

  const db = await connect(t);
  const mon = await connect(t);
  let linkCreated = false;
  const jobName = 'DBCMP_' + crypto.randomBytes(4).toString('hex').toUpperCase();
  try {
    // 1. DB link на приёмнике → источник
    if (p.createDbLink !== false) {
      if (/"/.test(s.password)) throw new Error('Пароль источника содержит двойную кавычку — DB link создайте вручную');
      await db.exec(`DROP DATABASE LINK ${ident(link)}`).catch(() => {});
      await db.exec(`CREATE DATABASE LINK ${ident(link)} CONNECT TO ${ident(s.user)} IDENTIFIED BY "${s.password}" USING '${descriptor(s).replace(/'/g, "''")}'`);
      linkCreated = true;
      ctx.log(`Создан DB link ${link} → ${s.host}:${s.port}/${s.database}`);
    }
    const chk = await db.query(`SELECT 1 AS ok FROM dual@${ident(link)}`);
    if (!chk.length) throw new Error(`DB link ${link} не работает`);
    ctx.log(`DB link ${link} проверен`);

    // 2. Запуск импорта
    await db.raw.execute(`BEGIN DBMS_OUTPUT.ENABLE(NULL); END;`);
    const tabexpr = (p.tables || []).length ? `IN (${p.tables.map(x => `'${String(x).replace(/'/g, "''")}'`).join(',')})` : null;
    const binds = {
      jmode: (p.tables || []).length ? 'TABLE' : 'SCHEMA',
      link, jname: jobName,
      src: p.sourceSchema.toUpperCase(),
      tgt: (p.targetSchema || p.sourceSchema).toUpperCase(),
      tabexpr,
      tea: p.tableExistsAction || 'SKIP',
      metaonly: p.content === 'METADATA_ONLY' ? 1 : 0,
      par: Number(p.parallel) || 1,
      final: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 30 },
    };
    ctx.log(`Запуск Data Pump: задание ${jobName}, ${binds.src} → ${binds.tgt}, TABLE_EXISTS_ACTION=${binds.tea}`);
    ctx.progress(0, 100, 'Data Pump выполняется…');

    let finished = false;
    const poll = (async () => {
      while (!finished) {
        await new Promise(r => setTimeout(r, 3000));
        if (finished) break;
        if (ctx.cancelled) {
          ctx.log('Остановка задания Data Pump…', 'warning');
          await mon.raw.execute(`DECLARE h NUMBER; BEGIN h := DBMS_DATAPUMP.ATTACH(:j, USER); DBMS_DATAPUMP.STOP_JOB(h, 1, 0); END;`, { j: jobName }).catch(e => ctx.log(e.message, 'error'));
          break;
        }
        try {
          const st = await mon.query(`SELECT state FROM user_datapump_jobs WHERE job_name = :j`, { j: jobName });
          const pct = await mon.query(`SELECT ROUND(sofar / NULLIF(totalwork, 0) * 100) AS pct FROM v$session_longops WHERE opname = :j AND sofar <> totalwork`, { j: jobName }).catch(() => []);
          const percent = pct[0] && pct[0].pct != null ? Number(pct[0].pct) : null;
          ctx.progress(percent ?? 0, 100, `Data Pump: ${st[0] ? st[0].state : '…'}${percent != null ? ` ${percent}%` : ''}`);
        } catch { /* нет прав на представление — просто ждём */ }
      }
    })();

    let final, err;
    try {
      const r = await db.raw.execute(PLSQL, binds);
      final = r.outBinds.final;
    } catch (e) { err = e; }
    finished = true;
    await poll;
    const out = await readDbmsOutput(db).catch(() => []);
    for (const l of out) ctx.log(l, /ORA-\d+/.test(l) ? 'error' : 'info');
    if (err) throw err;
    if (ctx.cancelled) throw Object.assign(new Error('Задача отменена пользователем'), { cancelled: true });
    const errors = out.filter(l => /ORA-\d+/.test(l)).length;
    ctx.log(`Data Pump завершён: ${final}, сообщений об ошибках: ${errors}`);
    return { summary: { state: final, errors, job: jobName }, commands: cmds, log: out };
  } finally {
    if (linkCreated && p.dropDbLinkAfter !== false) {
      await db.raw.commit().catch(() => {});
      await db.exec(`ALTER SESSION CLOSE DATABASE LINK ${ident(link)}`).catch(() => {});
      await db.exec(`DROP DATABASE LINK ${ident(link)}`).then(() => ctx.log(`DB link ${link} удалён`)).catch(() => {});
    }
    await db.close(); await mon.close();
  }
}

module.exports = { runDataPump };
