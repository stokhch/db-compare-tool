'use strict';
// Список объектов схемы и связи между ними — для выбора объектов и кнопки «Добавить связанные».
// Связь from → to означает «from зависит от to» (дочерняя таблица → родительская, представление → таблица…).

const ORA_TYPE = {
  TABLE: 'table', VIEW: 'view', 'MATERIALIZED VIEW': 'mview', SEQUENCE: 'sequence', FUNCTION: 'function',
  PROCEDURE: 'procedure', PACKAGE: 'package', 'PACKAGE BODY': 'package', TRIGGER: 'trigger', TYPE: 'type', 'TYPE BODY': 'type',
};
const key = (type, name) => `${type}:${name}`;

async function oracleObjects(db, schema) {
  const b = { o: schema };
  const objs = await db.query(`
    SELECT object_name AS name, object_type AS type, status FROM all_objects
    WHERE owner = :o AND object_type IN ('TABLE','VIEW','MATERIALIZED VIEW','SEQUENCE','FUNCTION','PROCEDURE','PACKAGE','TRIGGER','TYPE')
      AND object_name NOT LIKE 'BIN$%' AND object_name NOT LIKE 'MLOG$\\_%' ESCAPE '\\' AND object_name NOT LIKE 'RUPD$\\_%' ESCAPE '\\'
      AND NOT (object_type = 'TABLE' AND EXISTS (SELECT 1 FROM all_mviews m WHERE m.owner = :o AND m.mview_name = object_name))
    ORDER BY object_type, object_name`, b);
  const objects = objs.map(o => ({ type: ORA_TYPE[o.type], name: o.name, valid: o.status === 'VALID' }));
  const deps = [];
  const dd = await db.query(`
    SELECT DISTINCT name, type, referenced_name, referenced_type FROM all_dependencies
    WHERE owner = :o AND referenced_owner = :o
      AND type IN ('VIEW','MATERIALIZED VIEW','FUNCTION','PROCEDURE','PACKAGE','PACKAGE BODY','TRIGGER','TYPE','TYPE BODY')
      AND referenced_type IN ('TABLE','VIEW','MATERIALIZED VIEW','SEQUENCE','FUNCTION','PROCEDURE','PACKAGE','TYPE')`, b);
  for (const d of dd) {
    const ft = ORA_TYPE[d.type], tt = ORA_TYPE[d.referenced_type];
    if (!ft || !tt || (ft === tt && d.name === d.referenced_name)) continue;
    deps.push({ from: key(ft, d.name), to: key(tt, d.referenced_name), kind: 'код' });
  }
  const fk = await db.query(`
    SELECT DISTINCT c.table_name AS child, p.table_name AS parent
    FROM all_constraints c JOIN all_constraints p ON p.owner = c.r_owner AND p.constraint_name = c.r_constraint_name
    WHERE c.owner = :o AND c.constraint_type = 'R' AND p.owner = :o AND c.table_name <> p.table_name`, b);
  for (const r of fk) deps.push({ from: key('table', r.child), to: key('table', r.parent), kind: 'FK' });
  const trg = await db.query(`SELECT trigger_name, table_name FROM all_triggers WHERE owner = :o AND table_owner = :o AND base_object_type = 'TABLE'`, b);
  for (const r of trg) deps.push({ from: key('trigger', r.trigger_name), to: key('table', r.table_name), kind: 'триггер' });
  return { objects, deps: dedupe(deps) };
}

async function pgObjects(db, schema) {
  const objects = [];
  const rel = await db.query(`
    SELECT c.oid, c.relname AS name, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','S') AND NOT c.relispartition ORDER BY 2`, [schema]);
  const T = { r: 'table', p: 'table', v: 'view', m: 'mview', S: 'sequence' };
  for (const r of rel) objects.push({ type: T[r.relkind], name: r.name });
  const procs = await db.query(`
    SELECT DISTINCT p.proname AS name, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS type
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = $1 AND p.prokind IN ('f','p')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') ORDER BY 1`, [schema]);
  objects.push(...procs);
  const trg = await db.query(`
    SELECT tg.tgname AS name, c.relname AS tbl, p.proname AS fn, pn.nspname AS fnsp
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = tg.tgfoid JOIN pg_namespace pn ON pn.oid = p.pronamespace
    WHERE n.nspname = $1 AND NOT tg.tgisinternal ORDER BY 1`, [schema]);
  for (const t of trg) objects.push({ type: 'trigger', name: t.name });
  const types = await db.query(`
    SELECT t.typname AS name FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = $1 AND t.typtype IN ('c','e','d')
      AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c') ORDER BY 1`, [schema]);
  for (const t of types) objects.push({ type: 'type', name: t.name });

  const deps = [];
  for (const t of trg) {
    deps.push({ from: key('trigger', t.name), to: key('table', t.tbl), kind: 'триггер' });
    if (t.fnsp === schema) deps.push({ from: key('trigger', t.name), to: key('function', t.fn), kind: 'функция триггера' });
  }
  const fk = await db.query(`
    SELECT DISTINCT c.relname AS child, r.relname AS parent FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid JOIN pg_class r ON r.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_namespace rn ON rn.oid = r.relnamespace
    WHERE con.contype = 'f' AND n.nspname = $1 AND rn.nspname = $1 AND c.oid <> r.oid`, [schema]);
  for (const r of fk) deps.push({ from: key('table', r.child), to: key('table', r.parent), kind: 'FK' });
  // Представления → таблицы/представления/функции
  const vd = await db.query(`
    SELECT DISTINCT v.relname AS view, v.relkind AS vk, t.relname AS ref, t.relkind AS rk
    FROM pg_depend d JOIN pg_rewrite rw ON rw.oid = d.objid JOIN pg_class v ON v.oid = rw.ev_class
    JOIN pg_class t ON t.oid = d.refobjid JOIN pg_namespace n ON n.oid = v.relnamespace JOIN pg_namespace tn ON tn.oid = t.relnamespace
    WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass AND v.oid <> t.oid
      AND n.nspname = $1 AND tn.nspname = $1`, [schema]);
  for (const r of vd) if (T[r.rk]) deps.push({ from: key(T[r.vk], r.view), to: key(T[r.rk], r.ref), kind: 'представление' });
  // Таблица → последовательность (DEFAULT nextval, serial, identity)
  const sd = await db.query(`
    SELECT DISTINCT c.relname AS tbl, s.relname AS seq FROM pg_depend d
    JOIN pg_class s ON s.oid = d.refobjid AND s.relkind = 'S'
    JOIN pg_attrdef ad ON ad.oid = d.objid AND d.classid = 'pg_attrdef'::regclass
    JOIN pg_class c ON c.oid = ad.adrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1
    UNION
    SELECT DISTINCT c.relname, s.relname FROM pg_depend d
    JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S' JOIN pg_class c ON c.oid = d.refobjid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a','i') AND n.nspname = $1`, [schema]);
  for (const r of sd) deps.push({ from: key('table', r.tbl), to: key('sequence', r.seq), kind: 'последовательность' });
  // Функции → объекты, упомянутые в теле (PostgreSQL не хранит такие зависимости — ищем имена в тексте)
  const byName = new Map();
  for (const o of objects) if (o.type !== 'trigger') { const k = o.name.toLowerCase(); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(o); }
  const bodies = await db.query(`
    SELECT p.proname AS name, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS type, p.prosrc AS src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname = $1 AND p.prokind IN ('f','p') AND l.lanname IN ('plpgsql','sql')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`, [schema]).catch(() =>
    db.query(`SELECT p.proname AS name, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS type, p.prosrc AS src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.prokind IN ('f','p')`, [schema]));
  for (const f of bodies) {
    const words = new Set(String(f.src || '').toLowerCase().replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, ' ').match(/[a-z_][a-z0-9_$]*/g) || []);
    for (const w of words) for (const o of byName.get(w) || []) {
      if (o.name === f.name && o.type === f.type) continue;
      deps.push({ from: key(f.type, f.name), to: key(o.type, o.name), kind: 'код (по тексту)' });
    }
  }
  return { objects, deps: dedupe(deps) };
}

function dedupe(deps) {
  const seen = new Set();
  return deps.filter(d => { const k = d.from + '>' + d.to; if (seen.has(k)) return false; seen.add(k); return true; });
}

async function listObjects(db, schema) {
  return db.type === 'oracle' ? oracleObjects(db, schema) : pgObjects(db, schema);
}

/**
 * Оставить в метаданных только выбранные объекты (имена сравниваются без учёта регистра).
 * selection: [{type, name}] — со стороны источника; к приёмнику применяется по тем же именам.
 */
function filterMeta(meta, selection, K) {
  if (!selection || !selection.length) return meta;
  const sets = {};
  for (const s of selection) (sets[s.type] || (sets[s.type] = new Set())).add(K(s.name));
  const has = (type, name) => sets[type] && sets[type].has(K(name));
  const pkgs = sets.package || new Set();
  const routineOk = r => {
    const k = K(r.key);
    if (has('function', r.key) || has('procedure', r.key) || has(r.kind, r.key)) return true;
    if (sets.function && sets.function.has(k.replace('.', '_'))) return true;
    if (sets.procedure && sets.procedure.has(k.replace('.', '_'))) return true;
    if (r.package && pkgs.has(K(r.package))) return true;
    for (const p of pkgs) if (k.startsWith(p + '_') || k.startsWith(p + '.')) return true; // plsql2pg: пакет_процедура
    return false;
  };
  const allNames = new Set(selection.map(s => K(s.name)));
  return {
    ...meta,
    tables: meta.tables.filter(t => has('table', t.name)),
    views: meta.views.filter(v => has('view', v.name)),
    mviews: meta.mviews.filter(v => has('mview', v.name) || has('view', v.name)),
    sequences: meta.sequences.filter(s => has('sequence', s.name)),
    routines: meta.routines.filter(routineOk),
    triggers: meta.triggers.filter(t => has('trigger', t.name)),
    types: meta.types.filter(t => has('type', t.name)),
    packages: (meta.packages || []).filter(p => pkgs.has(K(p))),
    invalid: meta.invalid.filter(o => allNames.has(K(o.name))),
    filtered: true,
  };
}

module.exports = { listObjects, filterMeta };
