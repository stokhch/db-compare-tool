'use strict';
// Проверка кода PL/pgSQL через расширение plpgsql_check — аналог INVALID-объектов Oracle.
// Всё выполняется в транзакции с откатом: если расширение не подключено к базе, оно
// создаётся только на время проверки (подход plsql2pg/checker.py), база не меняется.

async function plpgsqlCheck(db, schemas, { extra = false } = {}) {
  const out = { available: false, note: '', checked: 0, messages: [] };
  await db.exec('BEGIN');
  try {
    const avail = await db.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'plpgsql_check'`);
    if (!avail.length) {
      out.note = 'Расширение plpgsql_check не установлено на сервере PostgreSQL — проверка кода пропущена (https://github.com/okbob/plpgsql_check).';
      return out;
    }
    let ext = await db.query(`SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'plpgsql_check'`);
    if (!ext.length) {
      await db.exec('SAVEPOINT pc');
      try {
        await db.exec('CREATE EXTENSION plpgsql_check');
        ext = await db.query(`SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'plpgsql_check'`);
      } catch (e) {
        await db.exec('ROLLBACK TO SAVEPOINT pc');
        out.note = `plpgsql_check есть на сервере, но не подключён к этой базе, а создать его не удалось (${e.message}). Попросите администратора: CREATE EXTENSION plpgsql_check;`;
        return out;
      }
    }
    out.available = true;
    const fn = `${db.quote(ext[0].nspname)}.plpgsql_check_function_tb`;

    // Обычные функции и процедуры + триггерные функции (с таблицей триггера)
    const targets = await db.query(`
      SELECT p.oid, p.oid::regprocedure::text AS sig, n.nspname, 0::oid AS relid, NULL::text AS trg
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = ANY($1::text[]) AND l.lanname = 'plpgsql' AND p.prorettype <> 'trigger'::regtype
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
      UNION ALL
      SELECT DISTINCT ON (p.oid) p.oid, p.oid::regprocedure::text, n.nspname, t.tgrelid, t.tgname
      FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = ANY($1::text[]) AND l.lanname = 'plpgsql' AND NOT t.tgisinternal
      ORDER BY 2`, [schemas]);

    for (const t of targets) {
      await db.exec('SAVEPOINT pcf');
      try {
        const rows = await db.query(
          `SELECT lineno, level, message, hint, sqlstate FROM ${fn}($1::regprocedure, relid := $2::oid::regclass, fatal_errors := false)`,
          [t.oid, t.relid]);
        out.checked++;
        for (const r of rows) {
          const level = String(r.level || '');
          if (level !== 'error' && level !== 'warning' && !extra) continue;
          out.messages.push({
            function: t.sig, trigger: t.trg, line: r.lineno, level: level === 'error' ? 'error' : 'warning',
            message: r.message + (r.hint ? ` (подсказка: ${r.hint})` : ''), sqlstate: r.sqlstate,
          });
        }
        await db.exec('RELEASE SAVEPOINT pcf');
      } catch (e) {
        await db.exec('ROLLBACK TO SAVEPOINT pcf');
        out.messages.push({ function: t.sig, line: null, level: 'warning', message: `Проверка не выполнена: ${e.message}` });
      }
    }
    return out;
  } finally {
    await db.exec('ROLLBACK').catch(() => {});
  }
}

module.exports = { plpgsqlCheck };
