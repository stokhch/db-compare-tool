'use strict';
// Скрипт синхронизации структуры: приводит приёмник к источнику (как «Schema Compare → migrate» в DBeaver).
// Каждый оператор — отдельный элемент со своей группой и уровнем риска; пользователь выбирает, что выполнять.
const { compatibility, targetColumnType } = require('../lib/typemap');

const GROUPS = ['Таблицы', 'Колонки', 'Типы колонок', 'NOT NULL', 'Первичные ключи', 'Уникальные ключи',
  'Внешние ключи', 'Индексы', 'Последовательности', 'Представления', 'Функции и процедуры', 'Триггеры', 'Удаление лишнего'];

async function buildSchemaSync(src, tgt, A, B, p, K) {
  const same = src.type === tgt.type;
  const S = p.targetSchema;
  const out = [];
  let id = 0;
  const add = (group, object, sql, o = {}) => out.push({
    id: ++id, group, object, sql, plsql: !!o.plsql, risk: o.risk || 'low', note: o.note || '', enabled: o.enabled !== false, comment: !!o.comment,
  });
  const q = n => tgt.quote(n);
  const qt = n => tgt.qualify(S, n);
  const newName = n => tgt.normName(n);
  const colType = c => (same ? c.type : targetColumnType(c, src.type, tgt.type));
  const sig = cols => cols.map(K).join(',');

  const mapB = new Map(B.tables.map(t => [K(t.name), t]));
  const tName = n => (mapB.get(K(n)) ? mapB.get(K(n)).name : newName(n)); // имя таблицы в приёмнике
  const created = new Set();

  // ---------- Таблицы и колонки ----------
  for (const ta of A.tables) {
    const tb = mapB.get(K(ta.name));
    if (!tb) {
      const cols = ta.columns.map(c => `  ${q(newName(c.name))} ${colType(c)}${c.nullable ? '' : ' NOT NULL'}`);
      add('Таблицы', ta.name, `CREATE TABLE ${qt(newName(ta.name))} (\n${cols.join(',\n')}\n)`);
      created.add(K(ta.name));
      continue;
    }
    const cb = new Map(tb.columns.map(c => [K(c.name), c]));
    for (const ca of ta.columns) {
      const c2 = cb.get(K(ca.name));
      const t = colType(ca);
      if (!c2) {
        const sql = tgt.type === 'oracle'
          ? `ALTER TABLE ${qt(tb.name)} ADD (${q(newName(ca.name))} ${t})`
          : `ALTER TABLE ${qt(tb.name)} ADD COLUMN ${q(newName(ca.name))} ${t}`;
        add('Колонки', `${tb.name}.${ca.name}`, sql, { note: ca.nullable ? '' : 'В источнике NOT NULL — ограничение добавляется отдельно после заполнения данных' });
        if (!ca.nullable) add('NOT NULL', `${tb.name}.${ca.name}`, notNullSql(tb.name, newName(ca.name), true), { risk: 'medium', note: 'Выполнится, только если в колонке нет NULL' });
        continue;
      }
      const comp = compatibility(ca, c2, same);
      if (comp.level === 'error' || (same && ca.type !== c2.type && comp.level !== 'ok')) {
        const sql = tgt.type === 'oracle'
          ? `ALTER TABLE ${qt(tb.name)} MODIFY (${q(c2.name)} ${t})`
          : `ALTER TABLE ${qt(tb.name)} ALTER COLUMN ${q(c2.name)} TYPE ${t} USING ${q(c2.name)}::${t}`;
        add('Типы колонок', `${tb.name}.${c2.name}`, sql, { risk: 'high', note: `Сейчас ${c2.type}, станет ${t} (как в источнике). Проверьте, что данные поместятся${tgt.type === 'oracle' ? '; Oracle может запретить смену типа непустой колонки' : ''}.` });
      }
      if (ca.nullable !== c2.nullable) {
        add('NOT NULL', `${tb.name}.${c2.name}`, notNullSql(tb.name, c2.name, !ca.nullable),
          { risk: ca.nullable ? 'low' : 'medium', note: ca.nullable ? '' : 'Выполнится, только если в колонке нет NULL' });
      }
    }
    for (const c2 of tb.columns) {
      if (!ta.columns.some(c => K(c.name) === K(c2.name))) {
        add('Удаление лишнего', `${tb.name}.${c2.name}`, `ALTER TABLE ${qt(tb.name)} DROP COLUMN ${q(c2.name)}`, { risk: 'high', enabled: false, note: 'Колонки нет в источнике. Данные будут потеряны.' });
      }
    }
  }

  function notNullSql(table, col, notNull) {
    if (tgt.type === 'oracle') return `ALTER TABLE ${qt(table)} MODIFY (${q(col)} ${notNull ? 'NOT NULL' : 'NULL'})`;
    return `ALTER TABLE ${qt(table)} ALTER COLUMN ${q(col)} ${notNull ? 'SET' : 'DROP'} NOT NULL`;
  }
  const colNames = (table, cols) => {
    const tb = mapB.get(K(table));
    return cols.map(c => {
      const ex = tb && tb.columns.find(x => K(x.name) === K(c));
      return q(ex ? ex.name : newName(c));
    }).join(', ');
  };

  // ---------- Ключи ----------
  for (const ta of A.tables) {
    const tb = mapB.get(K(ta.name));
    const tn = tName(ta.name);
    if (ta.pk && (!tb || !tb.pk)) {
      add('Первичные ключи', tn, `ALTER TABLE ${qt(tn)} ADD CONSTRAINT ${q(newName(ta.pk.name))} PRIMARY KEY (${colNames(ta.name, ta.pk.columns)})`,
        { risk: tb ? 'medium' : 'low', note: tb ? 'Выполнится, только если значения ключа уникальны и не NULL' : '' });
    } else if (ta.pk && tb && tb.pk && sig(ta.pk.columns) !== sig(tb.pk.columns)) {
      add('Первичные ключи', tn, `-- первичный ключ отличается: источник (${ta.pk.columns.join(', ')}), приёмник (${tb.pk.columns.join(', ')}) — пересоздайте вручную`, { comment: true, risk: 'high' });
    }
    for (const u of ta.uniques) {
      if (tb && tb.uniques.some(x => sig(x.columns) === sig(u.columns))) continue;
      add('Уникальные ключи', `${tn} (${u.columns.join(', ')})`, `ALTER TABLE ${qt(tn)} ADD CONSTRAINT ${q(newName(u.name))} UNIQUE (${colNames(ta.name, u.columns)})`, { risk: tb ? 'medium' : 'low' });
    }
  }
  for (const ta of A.tables) {
    const tb = mapB.get(K(ta.name));
    const tn = tName(ta.name);
    for (const fk of ta.fks) {
      const fs = `${sig(fk.columns)}->${K(fk.refTable)}(${sig(fk.refColumns || [])})`;
      if (tb && tb.fks.some(x => `${sig(x.columns)}->${K(x.refTable)}(${sig(x.refColumns || [])})` === fs)) continue;
      const refOk = fk.refTable && (mapB.has(K(fk.refTable)) || created.has(K(fk.refTable)));
      if (!refOk) { add('Внешние ключи', `${tn}.${fk.name}`, `-- ${fk.name}: таблица ${fk.refTable} отсутствует в приёмнике`, { comment: true }); continue; }
      const del = fk.deleteRule && /CASCADE|SET NULL/.test(fk.deleteRule) ? ` ON DELETE ${fk.deleteRule}` : '';
      add('Внешние ключи', `${tn}.${fk.name}`,
        `ALTER TABLE ${qt(tn)} ADD CONSTRAINT ${q(newName(fk.name))} FOREIGN KEY (${colNames(ta.name, fk.columns)}) REFERENCES ${qt(tName(fk.refTable))} (${colNames(fk.refTable, fk.refColumns)})${del}`,
        { risk: tb ? 'medium' : 'low', note: tb ? 'Выполнится, только если данные не нарушают ссылки' : '' });
    }
  }

  // ---------- Индексы ----------
  for (const ta of A.tables) {
    const tb = mapB.get(K(ta.name));
    const tn = tName(ta.name);
    const keySigs = new Set([ta.pk && sig(ta.pk.columns), ...ta.uniques.map(u => sig(u.columns))].filter(Boolean));
    for (const ix of ta.indexes) {
      const s = sig(ix.columns);
      if (ix.unique && keySigs.has(s)) continue; // создаётся вместе с ключом
      if (tb && tb.indexes.some(x => sig(x.columns) === s && !!x.unique === !!ix.unique)) continue;
      if (ix.columns.some(c => /[()\s+*/|]/.test(c))) {
        add('Индексы', `${tn}.${ix.name}`, `-- функциональный индекс ${ix.name} (${ix.columns.join(', ')}) — создайте вручную`, { comment: true });
        continue;
      }
      const name = tgt.type === 'oracle' ? qt(newName(ix.name)) : q(newName(ix.name));
      add('Индексы', `${tn}.${ix.name}`, `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${name} ON ${qt(tn)} (${colNames(ta.name, ix.columns)})`);
    }
    if (tb) {
      for (const ix of tb.indexes) {
        const s = sig(ix.columns);
        const tbKeys = new Set([tb.pk && sig(tb.pk.columns), ...tb.uniques.map(u => sig(u.columns))].filter(Boolean));
        if (ix.unique && tbKeys.has(s)) continue;
        if (ta.indexes.some(x => sig(x.columns) === s)) continue;
        add('Удаление лишнего', `${tb.name}.${ix.name}`, `DROP INDEX ${tgt.type === 'oracle' ? qt(ix.name) : qt(ix.name)}`, { risk: 'medium', enabled: false, note: 'Индекса нет в источнике' });
      }
    }
  }

  // ---------- Последовательности ----------
  const seqB = new Map(B.sequences.map(x => [K(x.name), x]));
  for (const s of A.sequences) {
    const sb = seqB.get(K(s.name));
    const next = s.value != null ? Number(s.value) + 1 : 1;
    if (!sb) {
      add('Последовательности', s.name, `CREATE SEQUENCE ${qt(newName(s.name))} START WITH ${next}${s.increment && Number(s.increment) !== 1 ? ` INCREMENT BY ${s.increment}` : ''}`);
    } else if (s.value != null && (sb.value == null || Number(sb.value) < Number(s.value))) {
      const sql = tgt.type === 'oracle'
        ? `ALTER SEQUENCE ${qt(sb.name)} RESTART START WITH ${next}`
        : `SELECT setval('${qt(sb.name).replace(/'/g, "''")}', ${Number(s.value)}, true)`;
      add('Последовательности', sb.name, sql, { note: tgt.type === 'oracle' ? 'RESTART работает в Oracle 18c+' : '' });
    }
  }

  // ---------- Представления, функции, триггеры ----------
  const missing = (la, lb, key = x => x.name) => {
    const set = new Set(lb.map(x => K(key(x))));
    return la.filter(x => !set.has(K(key(x))) && !set.has(K(key(x)).replace('.', '_')));
  };
  const mViews = missing(A.views, B.views);
  const mRoutines = p.compareRoutines === false ? [] : missing(A.routines, B.routines, x => x.key);
  const mTriggers = missing(A.triggers, B.triggers);

  if (!same) {
    const list = [...mViews.map(v => `VIEW ${v.name}`), ...mRoutines.map(r => `${r.kind} ${r.name}`), ...mTriggers.map(t => `TRIGGER ${t.name}`)];
    if (list.length) {
      add('Функции и процедуры', `${list.length} объектов`, `-- Код из ${src.type === 'oracle' ? 'Oracle' : 'PostgreSQL'} нельзя перенести без конвертации.\n-- Используйте ora2pg / plsql2pg для:\n${list.map(x => `--   ${x}`).join('\n')}`, { comment: true });
    }
  } else {
    const fix = sql => retarget(sql, p.sourceSchema, S, src.type);
    if (src.type === 'postgres') {
      for (const v of mViews) {
        const r = await src.query(`SELECT pg_get_viewdef($1::regclass, true) AS d`, [`${src.quote(p.sourceSchema)}.${src.quote(v.name)}`]);
        add('Представления', v.name, `CREATE OR REPLACE VIEW ${qt(v.name)} AS\n${fix(r[0].d.replace(/;\s*$/, ''))}`, { note: 'Порядок создания представлений может зависеть друг от друга' });
      }
      for (const rt of mRoutines) {
        const nsp = rt.package || p.sourceSchema;
        const name = rt.package ? rt.name.split('.').pop() : rt.name;
        const defs = await src.query(`SELECT pg_get_functiondef(p.oid) AS d FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2`, [nsp, name]);
        for (const d of defs) add('Функции и процедуры', rt.name, fix(d.d), { plsql: true });
      }
      for (const t of mTriggers) {
        const r = await src.query(`SELECT pg_get_triggerdef(tg.oid, true) AS d FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND tg.tgname = $2 AND NOT tg.tgisinternal`, [p.sourceSchema, t.name]);
        if (r[0]) add('Триггеры', t.name, fix(r[0].d), { note: 'Функция триггера должна существовать в приёмнике' });
      }
    } else {
      const ddl = async (type, name) => {
        const r = await src.query(`SELECT DBMS_METADATA.GET_DDL(:t, :n, :o) AS d FROM dual`, { t: type, n: name, o: p.sourceSchema });
        return fix(String(r[0].d).trim().replace(/\s*\/\s*$/, ''));
      };
      const tryAdd = async (group, obj, type, name, plsql) => {
        try { add(group, obj, await ddl(type, name), { plsql }); }
        catch (e) { add(group, obj, `-- ${type} ${name}: не удалось получить DDL (${e.message})`, { comment: true }); }
      };
      for (const v of mViews) await tryAdd('Представления', v.name, 'VIEW', v.name, false);
      const pkgs = new Set();
      for (const rt of mRoutines) {
        if (rt.kind === 'package routine') { pkgs.add(rt.package); continue; }
        await tryAdd('Функции и процедуры', rt.name, rt.kind === 'function' ? 'FUNCTION' : 'PROCEDURE', rt.name, true);
      }
      for (const pk of pkgs) {
        await tryAdd('Функции и процедуры', `${pk} (спецификация)`, 'PACKAGE_SPEC', pk, true);
        await tryAdd('Функции и процедуры', `${pk} (тело)`, 'PACKAGE_BODY', pk, true);
      }
      for (const t of mTriggers) await tryAdd('Триггеры', t.name, 'TRIGGER', t.name, true);
    }
  }

  // ---------- Лишние объекты приёмника (по умолчанию выключены) ----------
  const mapA = new Set(A.tables.map(t => K(t.name)));
  for (const tb of B.tables) if (!mapA.has(K(tb.name))) add('Удаление лишнего', tb.name, `DROP TABLE ${qt(tb.name)}`, { risk: 'high', enabled: false, note: 'Таблицы нет в источнике. Данные будут потеряны.' });
  const vA = new Set(A.views.map(v => K(v.name)));
  for (const v of B.views) if (!vA.has(K(v.name))) add('Удаление лишнего', v.name, `DROP VIEW ${qt(v.name)}`, { risk: 'medium', enabled: false });
  const sA = new Set(A.sequences.map(s => K(s.name)));
  for (const s of B.sequences) if (!sA.has(K(s.name))) add('Удаление лишнего', s.name, `DROP SEQUENCE ${qt(s.name)}`, { risk: 'medium', enabled: false });

  out.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || a.id - b.id);
  return { dialect: tgt.type, targetSchema: S, statements: out };
}

// Замена схемы источника на схему приёмника в DDL (одна СУБД, разные схемы)
function retarget(sql, from, to, type) {
  if (!from || !to || from === to) return sql;
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let r = sql.replace(new RegExp(`"${esc(from)}"\\.`, 'g'), `"${to}".`);
  if (type === 'postgres') r = r.replace(new RegExp(`\\b${esc(from)}\\.`, 'g'), `${/^[a-z_][a-z0-9_]*$/.test(to) ? to : `"${to}"`}.`);
  else r = r.replace(new RegExp(`\\b${esc(from.toUpperCase())}\\.`, 'g'), `${to.toUpperCase()}.`);
  return r;
}

// Текст скрипта с разделителями под диалект
function renderScript(sync, statements) {
  const lines = [`-- Скрипт синхронизации структуры (db-compare-tool), приёмник: ${sync.dialect}, схема ${sync.targetSchema}`,
    `-- Сгенерирован ${new Date().toISOString()}. Проверьте перед выполнением!`, ''];
  let group = '';
  for (const s of statements) {
    if (s.group !== group) { group = s.group; lines.push('', `-- ===== ${group} =====`); }
    if (s.note) lines.push(`-- ${s.note}`);
    if (s.comment) { lines.push(s.sql); continue; }
    const body = s.sql.replace(/;\s*$/, '');
    const text = sync.dialect === 'oracle' ? (s.plsql ? `${body};\n/` : `${body};`) : `${body};`;
    // невыбранные операторы — закомментированы
    lines.push(s.enabled === false ? text.split('\n').map(l => '-- ' + l).join('\n') : text);
  }
  return lines.join('\n') + '\n';
}

module.exports = { buildSchemaSync, renderScript, retarget };
