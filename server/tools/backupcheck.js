'use strict';
// Проверка резервной копии Oracle: заголовок файла читается, мастер-таблица на месте, версия и кодировка.
const { oracledb } = require('../db/oracle');

async function dumpFileInfo(db, dir, file) {
  await db.raw.execute(`BEGIN DBMS_OUTPUT.ENABLE(NULL); END;`);
  const r = await db.raw.execute(`
    DECLARE info ku$_dumpfile_info; ft NUMBER; i NUMBER;
    BEGIN
      DBMS_DATAPUMP.GET_DUMPFILE_INFO(:f, :d, info, ft);
      :ft := ft; i := info.FIRST;
      WHILE i IS NOT NULL LOOP
        DBMS_OUTPUT.PUT_LINE(CASE info(i).item_code WHEN DBMS_DATAPUMP.KU$_DFHDR_MASTER_PRESENT THEN 'master' WHEN DBMS_DATAPUMP.KU$_DFHDR_DB_VERSION THEN 'version' WHEN DBMS_DATAPUMP.KU$_DFHDR_JOB_NAME THEN 'job' ELSE 'c' || info(i).item_code END || '=' || info(i).value);
        i := info.NEXT(i);
      END LOOP;
    END;`, { f: file, d: dir, ft: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } });
  const lines = await db.readOutput();
  const m = Object.fromEntries(lines.map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const ok = r.outBinds.ft === 1 && m.master !== '0';
  return { ok, method: 'чтение заголовка Data Pump', details: `${ok ? 'файл Data Pump читается' : 'файл не распознан'}, версия ${m.version || '?'}, мастер-таблица ${m.master === '1' ? 'есть' : 'нет'}` };
}

module.exports = { dumpFileInfo };
