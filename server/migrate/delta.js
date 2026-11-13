'use strict';
// Догрузка изменений перед переключением: основной перенос делается заранее,
// в день переключения переносятся только строки, изменённые после него.
//  • по колонке даты изменения: col >= «с какого момента» — INSERT новых и UPDATE изменённых;
//  • по росту ключа: строки с ключом больше максимального в приёмнике (для таблиц «только вставка»);
//  • удалённые строки: сравнение только ключевых колонок всей таблицы → DELETE лишних.
const { connect } = require('../db');
const { loadMeta } = require('../meta');
const { getConnection } = require('../lib/store');
const { runDataSync } = require('../compare/syncdata');

function tsLiteral(db, s) {
  const v = String(s).trim().replace('T', ' ').slice(0, 19);
  if (!/^\d{4}-\d\d-\d\d( \d\d:\d\d(:\d\d)?)?$/.test(v)) throw new Error(`Неверная дата «${s}», нужен формат ГГГГ-ММ-ДД ЧЧ:ММ:СС`);
  const full = v.length === 10 ? v + ' 00:00:00' : v.length === 16 ? v + ':00' : v;
  return db.type === 'oracle' ? `TO_TIMESTAMP('${full}', 'YYYY-MM-DD HH24:MI:SS')` : `TIMESTAMP '${full}'`;
}

async function runDelta(p, ctx) {
  const K = x => String(x).toLowerCase();
  const src = await connect(getConnection(p.sourceId)), tgt = await connect(getConnection(p.targetId));
  const specs = [];
  const keysOnly = [];
  try {
    const A = await loadMeta(src, p.sourceSchema, {}, null);
    const B = await loadMeta(tgt, p.targetSchema, {}, null);
    const mapA = new Map(A.tables.map(t => [K(t.name), t])), mapB = new Map(B.tables.map(t => [K(t.name), t]));
    for (const t of p.tables || []) {
      const ta = mapA.get(K(t.source)), tb = mapB.get(K(t.target || t.source));
      if (!ta || !tb) throw new Error(`Таблица ${t.source} не найдена в ${!ta ? 'источнике' : 'приёмнике'}`);
      const mode = t.mode || p.mode || 'column';
      let sourceWhere, targetWhere;
      if (mode === 'column') {
        const col = t.column || p.column;
        const ca = col && ta.columns.find(c => K(c.name) === K(col));
        const cb = col && tb.columns.find(c => K(c.name) === K(col));
        if (!ca || !cb) throw new Error(`${ta.name}: не найдена колонка даты изменения «${col || ''}»`);
        const since = t.since || p.since;
        if (!since) throw new Error(`${ta.name}: не задано «с какого момента»`);
        sourceWhere = `${src.quote(ca.name)} >= ${tsLiteral(src, since)}`;
        targetWhere = `${tgt.quote(cb.name)} >= ${tsLiteral(tgt, since)}`;
      } else if (mode === 'key') {
        const pk = (ta.pk || {}).columns || [];
        if (pk.length !== 1) throw new Error(`${ta.name}: режим «по ключу» требует первичный ключ из одной колонки`);
        const kc = tb.columns.find(c => K(c.name) === K(pk[0]));
        const kcA = ta.columns.find(c => K(c.name) === K(pk[0]));
        if (!['int', 'numeric', 'datetime', 'date'].includes(kcA.family)) {
          throw new Error(`${ta.name}: режим «по ключу» работает только для числового ключа или даты — у строк порядок зависит от правил сортировки базы. Используйте режим «по колонке даты изменения».`);
        }
        const mx = (await tgt.query(`SELECT MAX(${tgt.quote(kc.name)}) AS mx FROM ${tgt.qualify(p.targetSchema, tb.name)}`))[0].mx;
        if (mx == null) { sourceWhere = null; targetWhere = null; ctx.log(`${ta.name}: приёмник пуст — будет перенесена вся таблица`, 'warning'); }
        else {
          const lit = /^-?\d+(\.\d+)?$/.test(String(mx)) ? String(mx) : `'${String(mx).replace(/'/g, "''")}'`;
          sourceWhere = `${src.quote(pk[0])} > ${lit}`;
          targetWhere = `${tgt.quote(kc.name)} > ${lit}`;
          ctx.log(`${ta.name}: в приёмнике ключ до ${mx}`);
        }
      } else throw new Error(`Неизвестный режим ${mode}`);
      specs.push({ source: ta.name, target: tb.name, sourceWhere: sourceWhere || undefined, targetWhere: targetWhere || undefined });
      if (p.checkDeletes) {
        if (!ta.pk) { ctx.log(`${ta.name}: без первичного ключа удалённые строки не найти`, 'warning'); continue; }
        keysOnly.push({ table: ta, key: ta.pk.columns });
      }
    }
  } finally { await src.close(); await tgt.close(); }
  if (!specs.length) throw new Error('Не выбрано ни одной таблицы');

  const base = { sourceId: p.sourceId, targetId: p.targetId, sourceSchema: p.sourceSchema, targetSchema: p.targetSchema, emptyAsNull: p.emptyAsNull, apply: !!p.apply };
  const sub = (name) => { const s = Object.create(ctx); s.setPartialResult = () => {}; s.log = (m, l) => ctx.log(`[${name}] ${m}`, l); return s; };

  ctx.log(`Изменённые строки: таблиц ${specs.length}`);
  const changed = await runDataSync({ ...base, tables: specs, insert: true, update: true, delete: false, upsert: true }, sub('изменения'));

  let deleted = null;
  if (keysOnly.length) {
    ctx.log('Проверка удалённых строк по ключам…');
    const exclude = keysOnly.flatMap(k => k.table.columns.filter(c => !k.key.map(K).includes(K(c.name))).map(c => `${k.table.name}.${c.name}`));
    deleted = await runDataSync({ ...base, tables: keysOnly.map(k => ({ source: k.table.name })), excludeColumns: exclude, insert: false, update: false, delete: true }, sub('удалённые'));
  }
  return {
    summary: {
      tables: specs.length, insert: changed.summary.insert, update: changed.summary.update,
      delete: deleted ? deleted.summary.delete : null, applied: !!p.apply,
    },
    changed: { script: changed.script, stats: changed.stats, applied: changed.applied, compare: changed.compare },
    deleted: deleted ? { script: deleted.script, stats: deleted.stats, applied: deleted.applied } : null,
    specs,
  };
}

module.exports = { runDelta, tsLiteral };
