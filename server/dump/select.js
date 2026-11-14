'use strict';
// Выборочный импорт из дампа: отбор объектов по имени и замыкание по зависимостям.
// Зависимость подтягивается из дампа, только если её ещё нет в базе-приёмнике (с учётом переименования схем).
// Триггеры выбранных таблиц добавляются всегда: Data Pump с фильтром по именам триггеров иначе их отбросит.

const TYPE_LABEL = { TABLE: 'таблица', VIEW: 'представление', SEQUENCE: 'последовательность', SYNONYM: 'синоним', PACKAGE: 'пакет',
  PROCEDURE: 'процедура', FUNCTION: 'функция', TYPE: 'тип', 'MATERIALIZED VIEW': 'мат. представление', TRIGGER: 'триггер' };
// типы → пути Data Pump для INCLUDE_PATH_EXPR / NAME_EXPR
const DP_PATHS = { TABLE: ['TABLE'], VIEW: ['VIEW'], SEQUENCE: ['SEQUENCE'], SYNONYM: ['SYNONYM'], PACKAGE: ['PACKAGE', 'PACKAGE_BODY'],
  PROCEDURE: ['PROCEDURE'], FUNCTION: ['FUNCTION'], TYPE: ['TYPE', 'TYPE_BODY'], 'MATERIALIZED VIEW': ['MATERIALIZED_VIEW'], TRIGGER: ['TRIGGER'] };

/** Предикат имени: contains — подстрока без учёта регистра; like — маска Oracle (% и _); regex — регулярное выражение. */
function nameMatcher(mask, mode = 'contains') {
  const m = String(mask || '').trim();
  if (!m) return null;
  if (mode === 'regex') { const re = new RegExp(m, 'i'); return n => re.test(n); }
  if (mode === 'like') {
    const re = new RegExp(`^${m.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`);
    return n => re.test(n.toUpperCase());
  }
  const u = m.toUpperCase();
  return n => n.toUpperCase().includes(u);
}

/** Объекты, подходящие под фильтр. filter: { mask, mode, types:[], schemas:[] } */
function matchObjects(objects, filter = {}) {
  const f = nameMatcher(filter.mask, filter.mode);
  if (!f) return [];
  const types = filter.types && filter.types.length ? new Set(filter.types) : null;
  const schemas = filter.schemas && filter.schemas.length ? new Set(filter.schemas) : null;
  return objects.filter(o => f(o.name) && (!types || types.has(o.type)) && (!schemas || schemas.has(o.owner)));
}

/** Все объекты, до которых можно дойти по зависимостям (без учёта базы) — чтобы одним запросом спросить базу. */
function reachable(objects, seedIds) {
  const byId = new Map(objects.map(o => [o.id, o]));
  const trig = triggersByTable(objects);
  const seen = new Set(seedIds), q = [...seedIds];
  while (q.length) {
    const o = byId.get(q.shift()); if (!o) continue;
    for (const d of [...o.deps, ...(trig.get(o.id) || [])]) if (!seen.has(d)) { seen.add(d); q.push(d); }
  }
  return [...seen].map(id => byId.get(id)).filter(Boolean);
}
function triggersByTable(objects) {
  const m = new Map();
  for (const o of objects) if (o.type === 'TRIGGER' && o.on) { if (!m.has(o.on)) m.set(o.on, []); m.get(o.on).push(o.id); }
  return m;
}

/**
 * Замыкание. exists(owner, name) — есть ли объект в базе-приёмнике (owner уже после переименования).
 * → { rows: [{ id, type, owner, name, reason: 'mask'|'dep'|'trigger', via, exists }], existing: [{ id, …, usedBy:[] }] }
 */
function closure(objects, seedIds, exists = () => false, tgtName = n => n) {
  const byId = new Map(objects.map(o => [o.id, o]));
  const trig = triggersByTable(objects);
  const rows = new Map(), existing = new Map();
  const q = [];
  for (const id of seedIds) { const o = byId.get(id); if (!o) continue; rows.set(id, { ...pick(o), reason: 'mask', via: null, exists: exists(tgtName(o.owner), o.name) }); q.push(id); }
  while (q.length) {
    const cur = byId.get(q.shift());
    const next = [...cur.deps.map(d => [d, 'dep']), ...(cur.type === 'TABLE' ? (trig.get(cur.id) || []).map(d => [d, 'trigger']) : [])];
    for (const [d, reason] of next) {
      if (rows.has(d)) continue;
      const o = byId.get(d); if (!o) continue;
      if (reason === 'dep' && o.type !== 'TRIGGER' && exists(tgtName(o.owner), o.name)) {
        if (!existing.has(d)) existing.set(d, { ...pick(o), usedBy: new Set() });
        existing.get(d).usedBy.add(cur.id);
        continue;
      }
      rows.set(d, { ...pick(o), reason, via: cur.id, exists: false });
      q.push(d);
    }
  }
  return { rows: [...rows.values()], existing: [...existing.values()].map(x => ({ ...x, usedBy: [...x.usedBy] })) };
}
const pick = o => ({ id: o.id, type: o.type, owner: o.owner, name: o.name });

/** С запросом к Oracle-приёмнику. a — результат анализа, d — решения (переименования схем). */
async function selectWithDeps(db, a, d, filter) {
  const objects = (a.contents && a.contents.objects) || [];
  const tgtName = n => { const s = (d.schemas || {})[n] || {}; return s.action === 'remap' && s.target ? s.target.toUpperCase() : n; };
  const dropped = new Set(Object.entries(d.schemas || {}).filter(([, s]) => s.action === 'drop').map(([n]) => n));
  const seeds = matchObjects(objects, filter).map(o => o.id);
  const cand = reachable(objects, seeds);
  const inDb = new Set();
  if (db) {
    const byOwner = new Map();
    for (const o of cand) { const t = tgtName(o.owner); if (dropped.has(o.owner)) continue; if (!byOwner.has(t)) byOwner.set(t, new Set()); byOwner.get(t).add(o.name); }
    for (const [owner, set] of byOwner) {
      const list = [...set];
      for (let i = 0; i < list.length; i += 500) {
        const chunk = list.slice(i, i + 500);
        const binds = { o: owner }; chunk.forEach((n, k) => (binds[`n${k}`] = n));
        const rs = await db.query(`SELECT object_name AS n FROM all_objects WHERE owner = :o AND object_name IN (${chunk.map((_, k) => `:n${k}`).join(', ')}) AND object_type NOT IN ('INDEX', 'TRIGGER', 'LOB', 'PACKAGE BODY', 'TYPE BODY') AND object_name NOT LIKE 'BIN$%'`, binds);
        for (const r of rs) inDb.add(`${owner}.${r.n}`);
      }
    }
  }
  const res = closure(objects, seeds, (o, n) => inDb.has(`${o}.${n}`), tgtName);
  // недостающее вне дампа — из проверки зависимостей кода, только для выбранных объектов
  const sel = new Set(res.rows.map(r => `${r.owner}.${r.name}`));
  const cd = a.codeDeps || { missing: [], dblinks: [] };
  const outside = cd.missing.map(x => ({ ...x, usedBy: x.usedBy.filter(u => sel.has(u)) })).filter(x => x.usedBy.length);
  const dblinks = cd.dblinks.map(x => ({ ...x, usedBy: x.usedBy.filter(u => sel.has(u)) })).filter(x => x.usedBy.length);
  const byType = {};
  for (const r of res.rows) byType[r.type] = (byType[r.type] || 0) + 1;
  return { ...res, outside, dblinks, stats: { matched: seeds.length, added: res.rows.length - seeds.length, existing: res.existing.length, total: res.rows.length, byType }, total: objects.length };
}

/** Фильтры Data Pump для выбранных объектов одной схемы: { paths:[…], names: { PATH: [имена] } } */
function includeFilter(rows) {
  const names = {};
  for (const r of rows) for (const p of DP_PATHS[r.type] || []) (names[p] = names[p] || new Set()).add(r.name);
  return { paths: Object.keys(names), names: Object.fromEntries(Object.entries(names).map(([k, v]) => [k, [...v].sort()])) };
}

module.exports = { nameMatcher, matchObjects, reachable, closure, selectWithDeps, includeFilter, TYPE_LABEL, DP_PATHS };
