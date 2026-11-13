'use strict';
// Проверка перед pg_dump / pg_restore.
const fs = require('fs');
const path = require('path');
const { connect } = require('../db');
const { getConnection } = require('../lib/store');
const { run, pgTool, toolVersion, IS_WIN } = require('../lib/proc');
const { DUMPS } = require('../copy/pgdump');
const { tryConnect, one, fmtMb } = require('./common');

const major = s => { const m = /(\d+)(?:\.(\d+))?/.exec(String(s || '')); return m ? Number(m[1]) : null; };

/** Все установленные клиенты PostgreSQL: [{ dir, major }] — чтобы предложить подходящую версию. */
function installedPgBins() {
  const out = [];
  const bases = IS_WIN ? ['C:\\Program Files\\PostgreSQL', 'C:\\Program Files (x86)\\PostgreSQL'] : ['/usr/lib/postgresql', '/usr/pgsql', '/opt/homebrew/opt'];
  for (const base of bases) {
    let vers = [];
    try { vers = fs.readdirSync(base); } catch { continue; }
    for (const v of vers) {
      const dir = path.join(base, v, 'bin');
      if (fs.existsSync(path.join(dir, IS_WIN ? 'pg_dump.exe' : 'pg_dump'))) out.push({ dir, major: major(v.replace(/^postgresql@/, '')) });
    }
  }
  return out.filter(x => x.major).sort((a, b) => b.major - a.major);
}

async function preflightPgDump(p) {
  const issues = [], facts = [];
  const mode = p.mode || 'dump_restore';
  const dumpV = await toolVersion(pgTool('pg_dump'), ['--version']);
  const restV = await toolVersion(pgTool('pg_restore'), ['--version']);
  const cm = major(dumpV.version);
  facts.push({ label: 'pg_dump', value: dumpV.ok ? dumpV.version : 'не найден' });
  const bins = installedPgBins();
  const toolFix = need => {
    const b = bins.find(x => x.major >= need);
    return b ? [{ id: 'bin', title: `Использовать клиент PostgreSQL ${b.major} (${b.dir})`, default: true, patch: { _settings: { pgBinPath: b.dir } } }] : [];
  };
  if (!dumpV.ok || !restV.ok) {
    issues.push({ id: 'tools', level: 'error', blocking: true, title: 'Не найдены pg_dump / pg_restore', details: 'Установите клиент PostgreSQL (входит в установку сервера) и укажите папку bin в «Настройках».', fixes: toolFix(0) });
    return { issues, facts };
  }
  let src = null, srcVer = null;
  if (mode !== 'restore_only') {
    src = await tryConnect(p.sourceId, 'Источник', issues);
    if (src) {
      srcVer = Number((await src.query('SHOW server_version_num'))[0].server_version_num);
      const sm = Math.floor(srcVer / 10000);
      facts.push({ label: 'Источник', value: `PostgreSQL ${sm}` });
      if (cm && cm < sm) issues.push({ id: 'version', level: 'error', blocking: true, title: `pg_dump ${cm} старше сервера-источника (${sm})`, details: 'pg_dump отказывается работать с более новым сервером («server version mismatch»).', fixes: toolFix(sm) });
      const size = await one(src, `SELECT pg_database_size(current_database()) AS s`, [], []);
      if (size && size[0]) {
        const bytes = Number(size[0].s);
        facts.push({ label: 'Размер базы', value: fmtMb(bytes) });
        try {
          const st = fs.statfsSync(DUMPS);
          const free = st.bavail * st.bsize;
          if (free < bytes * 0.4) issues.push({ id: 'disk', level: 'warning', title: `Мало места для файла дампа: свободно ${fmtMb(free)}, база ${fmtMb(bytes)}`, details: 'Сжатый дамп обычно занимает 20–40 % от размера базы.', fixes: [] });
        } catch { /* statfs недоступен */ }
        if (bytes > 1073741824 && (Number(p.jobs) || 1) < 2 && mode !== 'dump_only')
          issues.push({ id: 'jobs', level: 'info', title: `База ${fmtMb(bytes)} — восстановление в один поток будет долгим`, fixes: [{ id: 'j4', title: 'Восстанавливать в 4 потока (-j 4)', patch: { jobs: 4, singleTransaction: false } }] });
      }
    }
  } else {
    const file = p.dumpFile ? path.join(DUMPS, path.basename(p.dumpFile)) : null;
    if (!file || !fs.existsSync(file)) issues.push({ id: 'file', level: 'error', blocking: true, title: 'Файл дампа не выбран или не найден', fixes: [] });
    else {
      const r = await run(pgTool('pg_restore'), ['-l', file], { captureStdout: true, logStdout: false }).catch(e => ({ code: 1, stdout: e.message }));
      if (r.code !== 0) issues.push({ id: 'file', level: 'error', blocking: true, title: 'pg_restore не может прочитать файл', details: /unsupported version/i.test(r.stdout) ? 'Файл создан более новой версией pg_dump — нужен pg_restore той же или новее версии.' : r.stdout.slice(0, 500), fixes: toolFix((cm || 0) + 1) });
    }
  }

  if (mode !== 'dump_only') {
    let t;
    try { t = getConnection(p.targetId); } catch { issues.push({ id: 'target', level: 'error', blocking: true, title: 'Не выбран приёмник', fixes: [] }); }
    if (t) {
      if (mode === 'dump_restore' && p.sourceId === p.targetId) issues.push({ id: 'same', level: 'error', blocking: true, title: 'Источник и приёмник — одна и та же база', fixes: [] });
      const admin = await tryConnect(null, 'Приёмник', issues) || await connect({ ...t, database: p.maintenanceDb || 'postgres' }).catch(e => { issues.push({ id: 'target-admin', level: 'error', blocking: true, title: `Не удаётся подключиться к серверу-приёмнику (база postgres)`, details: e.message, fixes: [] }); return null; });
      if (admin) {
        try {
          const tv = Number((await admin.query('SHOW server_version_num'))[0].server_version_num);
          const tm = Math.floor(tv / 10000);
          facts.push({ label: 'Приёмник', value: `PostgreSQL ${tm}` });
          if (srcVer && tm < Math.floor(srcVer / 10000)) issues.push({ id: 'downgrade', level: 'warning', title: `Восстановление в более старую версию (${Math.floor(srcVer / 10000)} → ${tm})`, details: 'Объекты с новым синтаксисом могут не создаться.', fixes: [] });
          const rm = major(restV.version);
          if (rm && rm < tm) issues.push({ id: 'restver', level: 'warning', title: `pg_restore ${rm} старше сервера-приёмника (${tm})`, fixes: toolFix(tm) });
          const me = (await admin.query(`SELECT rolsuper, rolcreatedb FROM pg_roles WHERE rolname = current_user`))[0] || {};
          const exists = (await admin.query(`SELECT datname FROM pg_database WHERE datname = $1`, [t.database])).length > 0;
          let like = null;
          if (src) {
            const e = await one(src, `SELECT pg_encoding_to_char(encoding) AS enc, datcollate, datctype FROM pg_database WHERE datname = current_database()`, [], []);
            if (e && e[0]) like = { encoding: e[0].enc, collate: e[0].datcollate, ctype: e[0].datctype };
          }
          if (!exists) {
            if (!me.rolcreatedb && !me.rolsuper) issues.push({ id: 'createdb', level: 'error', blocking: true, title: `Базы ${t.database} нет, а у ${t.user} нет права CREATEDB`, sql: `ALTER ROLE ${admin.quote(t.user)} CREATEDB;`, fixes: [] });
            else issues.push({ id: 'nodb', level: p.createDatabase ? 'info' : 'error', blocking: !p.createDatabase, title: `Базы ${t.database} на сервере-приёмнике нет`,
              fixes: [{ id: 'create', title: `Создать базу ${t.database}${like ? ` с кодировкой и локалью источника (${like.encoding}, ${like.collate})` : ''}`, default: true, patch: { createDatabase: true, ...(like ? { createLike: like } : {}) } }] });
          } else {
            const tdb = await connect(t);
            try {
              const schemas = p.schemas && p.schemas.length ? p.schemas : null;
              const cnt = await tdb.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r','p','v','m','S') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' ${schemas ? 'AND n.nspname = ANY($1)' : ''}`, schemas ? [schemas] : []);
              const n = cnt[0].n;
              const conns = (await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [t.database]))[0].n;
              if (n > 0 && p.content !== 'data') {
                issues.push({ id: 'nonempty', level: 'warning', required: true, choice: true, title: `База ${t.database} не пустая: объектов ${n}${schemas ? ` в схемах ${schemas.join(', ')}` : ''}`,
                  details: `Без очистки pg_restore выдаст ошибки «already exists», а данные добавятся к существующим.${conns ? ` Подключено сеансов: ${conns}.` : ''}`,
                  fixes: [
                    { id: 'clean', title: 'Удалить восстанавливаемые объекты перед восстановлением (--clean --if-exists)', danger: true, patch: { clean: true, ...(conns ? { terminateConnections: true } : {}) } },
                    ...(me.rolsuper || me.rolcreatedb ? [{ id: 'recreate', title: `Пересоздать базу ${t.database} целиком (DROP DATABASE)`, danger: true, patch: { recreateDatabase: true, ...(like ? { createLike: like } : {}) } }] : []),
                    { id: 'keep', title: 'Восстановить поверх (ошибки «уже существует» будут пропущены)', patch: {} },
                  ] });
              } else if (p.content === 'data' && n > 0) {
                issues.push({ id: 'dataonly', level: 'warning', title: 'Только данные в непустую базу', details: 'Если в таблицах уже есть строки — будут дубликаты или ошибки ключей. Внешние ключи могут мешать порядку загрузки (pg_restore --disable-triggers требует суперпользователя).', fixes: [] });
              }
              // расширения
              if (src) {
                const ext = (await src.query(`SELECT extname FROM pg_extension WHERE extname <> 'plpgsql'`)).map(r => r.extname);
                if (ext.length) {
                  const avail = new Map((await one(tdb, `SELECT name, installed_version${tv >= 130000 ? ', (SELECT bool_or(trusted) FROM pg_available_extension_versions v WHERE v.name = a.name) AS trusted' : ''} FROM pg_available_extensions a`, [], [])).map(r => [r.name, r]));
                  const missing = ext.filter(e => !avail.has(e));
                  if (missing.length) issues.push({ id: 'ext-missing', level: 'error', title: `На сервере-приёмнике не установлены расширения: ${missing.join(', ')}`, details: 'Объекты, которые их используют, не создадутся. Установите пакеты расширений на сервер (например, postgresql-contrib, postgis).', fixes: [] });
                  const needSuper = ext.filter(e => avail.has(e) && !avail.get(e).installed_version && !avail.get(e).trusted);
                  if (needSuper.length && !me.rolsuper) issues.push({ id: 'ext-super', level: 'warning', title: `Расширения ${needSuper.join(', ')} может создать только суперпользователь`, details: 'Создайте их заранее от суперпользователя:', sql: needSuper.map(e => `CREATE EXTENSION IF NOT EXISTS "${e}";`).join('\n'), fixes: [] });
                }
                // роли-владельцы и права
                const owners = (await src.query(`SELECT DISTINCT pg_get_userbyid(c.relowner) AS r FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'`)).map(r => r.r);
                const grantees = (await one(src, `SELECT DISTINCT pg_get_userbyid((aclexplode(c.relacl)).grantee) AS r FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relacl IS NOT NULL AND n.nspname NOT IN ('pg_catalog','information_schema')`, [], [])).map(r => r.r).filter(r => r && r !== '-');
                const roles = new Set((await admin.query(`SELECT rolname FROM pg_roles`)).map(r => r.rolname));
                const mo = owners.filter(r => !roles.has(r)), mg = grantees.filter(r => !roles.has(r) && r !== 'PUBLIC');
                if (mo.length && p.noOwner === false) issues.push({ id: 'owners', level: 'warning', title: `Нет ролей-владельцев объектов: ${mo.join(', ')}`, details: 'ALTER … OWNER TO завершатся ошибкой.', fixes: [{ id: 'noowner', title: 'Не восстанавливать владельцев (--no-owner): объекты будут принадлежать пользователю подключения', default: true, patch: { noOwner: true } }, { id: 'create', title: 'Создать эти роли', patch: { preSql: mo.map(r => ({ connId: p.targetId, sql: `CREATE ROLE "${r}" NOLOGIN`, title: `Роль ${r}`, ignoreError: true })) } }] });
                if (mg.length && p.noPrivileges === false) issues.push({ id: 'grantees', level: 'warning', title: `Нет ролей, которым выданы права: ${mg.join(', ')}`, fixes: [{ id: 'noacl', title: 'Не восстанавливать права (--no-privileges)', default: true, patch: { noPrivileges: true } }, { id: 'create', title: 'Создать эти роли', patch: { preSql: mg.map(r => ({ connId: p.targetId, sql: `CREATE ROLE "${r}" NOLOGIN`, title: `Роль ${r}`, ignoreError: true })) } }] });
                // табличные пространства
                const ts = (await src.query(`SELECT DISTINCT t.spcname FROM pg_class c JOIN pg_tablespace t ON t.oid = c.reltablespace WHERE c.reltablespace <> 0`)).map(r => r.spcname);
                const tts = new Set((await admin.query(`SELECT spcname FROM pg_tablespace`)).map(r => r.spcname));
                const mts = ts.filter(x => !tts.has(x));
                if (mts.length && !p.noTablespaces) issues.push({ id: 'tablespaces', level: 'warning', title: `На приёмнике нет табличных пространств: ${mts.join(', ')}`, fixes: [{ id: 'nots', title: 'Создавать всё в табличном пространстве по умолчанию (--no-tablespaces)', default: true, patch: { noTablespaces: true } }] });
              }
            } finally { await tdb.close(); }
          }
          if (p.singleTransaction && Number(p.jobs) > 1) issues.push({ id: 'single', level: 'info', title: 'Одна транзакция несовместима с несколькими потоками', details: 'pg_restore выполнит восстановление в несколько потоков без общей транзакции.', fixes: [] });
        } finally { await admin.close(); }
      }
    }
  }
  if (src) await src.close();
  return { issues, facts };
}

module.exports = { preflightPgDump, installedPgBins };
