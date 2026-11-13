'use strict';
// Копирование Oracle → Oracle через Data Pump по сети (NETWORK_LINK):
// импорт запускается на приёмнике через PL/SQL API DBMS_DATAPUMP и тянет данные из источника по DB link.
// Параметры исправлений из проверки: remapTablespaces, excludeDbLinks, excludeJobs, byteToChar (два этапа).
// Файлы дампа и утилиты expdp/impdp на этой машине не нужны.
const crypto = require('crypto');
const { connect } = require('../db');
const { getConnection } = require('../lib/store');

function descriptor(c) {
  if (c.connectString) return c.connectString;
  const cd = c.oracleConnectMode === 'sid' ? `(SID=${c.database})` : `(SERVICE_NAME=${c.database})`;
  return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${c.host})(PORT=${c.port}))(CONNECT_DATA=${cd}))`;
}
const ident = s => (/^[A-Za-z][\w$#]*$/.test(s) ? s : `"${s}"`);

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
  const { dpBlock } = require('../dump/plan');
  const { runDp } = require('../dump/import');
  const { classifyLog } = require('../dump/errors');

  const db = await connect(t);
  const mon = await connect(t);
  let linkCreated = false;
  const src = p.sourceSchema.toUpperCase(), tgt = (p.targetSchema || p.sourceSchema).toUpperCase();
  const all = [];
  try {
    // 1. DB link на приёмнике → источник
    if (p.createDbLink !== false) {
      if (/"/.test(s.password)) throw new Error('Пароль источника содержит двойную кавычку — DB link создайте вручную');
      await db.exec(`DROP DATABASE LINK ${ident(link)}`).catch(() => {});
      const srcUser = String(s.user).replace(/\s+as\s+sysdba$/i, '');
      await db.exec(`CREATE DATABASE LINK ${ident(link)} CONNECT TO ${ident(srcUser)} IDENTIFIED BY "${s.password}" USING '${descriptor(s).replace(/'/g, "''")}'`);
      linkCreated = true;
      ctx.log(`Создан DB link ${link} → ${s.host}:${s.port}/${s.database}`);
    }
    const chk = await db.query(`SELECT 1 AS ok FROM dual@${ident(link)}`);
    if (!chk.length) throw new Error(`DB link ${link} не работает`);
    ctx.log(`DB link ${link} проверен`);

    const tables = p.tables || [];
    const excl = [];
    if (p.excludeDbLinks) excl.push('DB_LINK');
    if (p.excludeJobs) excl.push('JOB', 'PROCOBJ');
    const base = {
      jobMode: tables.length ? 'TABLE' : 'SCHEMA', remoteLink: link,
      schemaExpr: `IN ('${src.replace(/'/g, "''")}')`,
      tablesExpr: tables.length ? `IN (${tables.map(x => `'${String(x).replace(/'/g, "''")}'`).join(',')})` : null,
      remapSchema: src !== tgt ? [[src, tgt]] : [], remapTablespace: p.remapTablespaces || [],
      tableExistsAction: p.tableExistsAction || 'SKIP', exclude: excl, oid: src !== tgt, parallel: Number(p.parallel) || 1,
      metadataOnly: p.content === 'METADATA_ONLY',
    };
    const runJob = async (job, title) => {
      const jobName = 'DBCMP_' + crypto.randomBytes(4).toString('hex').toUpperCase();
      ctx.log(`${title}: задание ${jobName}, ${src} → ${tgt}, TABLE_EXISTS_ACTION=${job.tableExistsAction}`);
      const r = await runDp(db, mon, dpBlock({ operation: 'IMPORT', jobName, job }), jobName, ctx, title);
      all.push(...r.lines);
      if (r.error && !/ORA-39(082|083|151)/.test(r.error)) throw new Error(r.error);
      return r;
    };
    let final;
    if (p.byteToChar && p.content !== 'METADATA_ONLY') {
      // 1) структура таблиц без индексов и ограничений, 2) колонки BYTE → CHAR, 3) данные и остальное
      await runJob({ ...base, metadataOnly: true, exclude: [...excl, 'INDEX', 'CONSTRAINT', 'REF_CONSTRAINT', 'TRIGGER', 'STATISTICS'] }, 'Этап 1: структура');
      const cols = await db.query(`SELECT table_name AS t, column_name AS c, data_type AS ty, char_length AS l FROM all_tab_columns WHERE owner = :o AND data_type IN ('VARCHAR2','CHAR') AND char_used = 'B'`, { o: tgt });
      for (const c of cols) {
        await db.exec(`ALTER TABLE ${ident(tgt)}.${ident(c.t)} MODIFY (${ident(c.c)} ${c.ty}(${Math.min(Number(c.l), c.ty === 'CHAR' ? 2000 : 4000)} CHAR))`)
          .catch(e => ctx.log(`${c.t}.${c.c}: ${e.message.split('\n')[0]}`, 'warning'));
      }
      ctx.log(`Колонок переведено в CHAR: ${cols.length}`);
      final = (await runJob({ ...base, tableExistsAction: 'APPEND' }, 'Этап 2: данные')).state;
    } else final = (await runJob(base, 'Импорт')).state;

    if (ctx.cancelled) throw Object.assign(new Error('Задача отменена пользователем'), { cancelled: true });
    await db.exec(`BEGIN DBMS_UTILITY.COMPILE_SCHEMA('${tgt.replace(/'/g, "''")}', FALSE); END;`).catch(() => {});
    const inv = await db.query(`SELECT object_type AS type, object_name AS name FROM all_objects WHERE owner = :o AND status = 'INVALID'`, { o: tgt }).catch(() => []);
    const errors = classifyLog(all);
    const real = errors.filter(e => !e.benign);
    ctx.log(`Data Pump завершён: ${final}, ошибок ${real.reduce((x, e) => x + e.count, 0)}, невалидных объектов ${inv.length}`);
    return { summary: { state: final, errors: real.reduce((x, e) => x + e.count, 0), invalid: inv.length }, commands: cmds, errors, invalid: inv, log: all.slice(-3000) };
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
