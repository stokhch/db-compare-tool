'use strict';
// Готовность данных за период: перед расчётом в обеих базах считаются строки в справочниках,
// исходных (суточных) данных и архивах соседних расчётов. Пустой результат расчёта часто означает
// не ошибку конвертации, а отсутствие исходных данных за период.
const { connect } = require('../db');
const { loadMeta } = require('../meta');
const { getConnection, publicConnection } = require('../lib/store');
const { periodWhere, andWhere } = require('../lib/period');

// Простой перевод условия Oracle → PostgreSQL (для типовых случаев) и обратно
function adaptCondition(cond, db) {
  if (!cond) return '';
  if (db.type === 'postgres') return cond.replace(/\bNVL\s*\(/gi, 'coalesce(').replace(/\bSYSDATE\b/gi, 'LOCALTIMESTAMP(0)');
  return cond.replace(/\bcoalesce\s*\(/gi, 'NVL(');
}

async function countRows(db, schema, table, where) {
  const sql = `SELECT COUNT(*) AS n FROM ${db.qualify(schema, table)}${where ? ` WHERE ${where}` : ''}`;
  const t0 = Date.now();
  const r = await db.query(sql);
  return { n: Number(r[0].n), ms: Date.now() - t0, sql };
}

async function runReadiness(p, ctx) {
  const srcConn = getConnection(p.sourceId), tgtConn = getConnection(p.targetId);
  const K = x => String(x).toLowerCase();
  const src = await connect(srcConn), tgt = await connect(tgtConn);
  const rows = [];
  try {
    const A = await loadMeta(src, p.sourceSchema, {}, null), B = await loadMeta(tgt, p.targetSchema, {}, null);
    const mapA = new Map(A.tables.map(t => [K(t.name), t])), mapB = new Map(B.tables.map(t => [K(t.name), t]));
    const items = [...(p.items || [])].filter(x => x.table);
    if (p.autoPeriodTables && p.period) {
      // все таблицы, к которым применим фильтр периода (есть d_beg/d_end или дневная дата)
      const have = new Set(items.map(x => K(x.table)));
      for (const t of A.tables) {
        if (have.has(K(t.name))) continue;
        const pw = periodWhere(src, t, { ...p.period, userMode: 'none', onlyFact: false });
        if (pw.applied) items.push({ table: t.name, auto: true });
      }
    }
    let i = 0;
    for (const it of items) {
      ctx.checkCancel();
      ctx.progress(i++, items.length, it.table);
      const ta = mapA.get(K(it.table)), tb = mapB.get(K(it.targetTable || it.table));
      const row = { label: it.label || it.table, table: it.table, condition: it.condition || '', auto: !!it.auto };
      if (!ta || !tb) { row.status = 'error'; row.note = !ta ? 'Нет таблицы в источнике' : 'Нет таблицы в приёмнике'; rows.push(row); continue; }
      const usePeriod = it.usePeriod !== false;
      const pa = usePeriod ? periodWhere(src, ta, p.period, 'source') : { where: '', parts: [] };
      const pb = usePeriod ? periodWhere(tgt, tb, p.period, 'target') : { where: '', parts: [] };
      row.filter = [...new Set([...pa.parts, ...pb.parts])].join(', ');
      try {
        const [a, b] = await Promise.all([
          countRows(src, p.sourceSchema, ta.name, andWhere(pa.where, adaptCondition(it.condition, src))),
          countRows(tgt, p.targetSchema, tb.name, andWhere(pb.where, adaptCondition(it.conditionTarget || it.condition, tgt))),
        ]);
        Object.assign(row, { source: a.n, target: b.n, msSource: a.ms, msTarget: b.ms, sqlSource: a.sql, sqlTarget: b.sql });
        if (a.n === 0 && b.n === 0) { row.status = 'warning'; row.note = 'Пусто в обеих базах — расчёт по этим данным даст пустой или нулевой результат'; }
        else if (b.n === 0) { row.status = 'error'; row.note = 'Нет данных в приёмнике'; }
        else if (a.n === 0) { row.status = 'error'; row.note = 'Нет данных в источнике'; }
        else if (a.n !== b.n) { row.status = 'error'; row.note = `Разница ${b.n - a.n}`; }
        else row.status = 'ok';
      } catch (e) {
        if (e.cancelled) throw e;
        row.status = 'error'; row.note = e.message;
        if (tgt.type === 'postgres') await tgt.exec('ROLLBACK').catch(() => {});
      }
      rows.push(row);
      ctx.log(`${row.label}: ${row.source ?? '—'} / ${row.target ?? '—'}${row.note ? ' — ' + row.note : ''}`, row.status === 'ok' ? 'info' : 'warning');
    }
  } finally { await src.close(); await tgt.close(); }
  const summary = rows.reduce((s, r) => (s[r.status] = (s[r.status] || 0) + 1, s), { tables: rows.length, ok: 0, warning: 0, error: 0 });
  return { summary, source: { ...publicConnection(srcConn), schema: p.sourceSchema }, target: { ...publicConnection(tgtConn), schema: p.targetSchema }, period: p.period, rows };
}

module.exports = { runReadiness, adaptCondition };
