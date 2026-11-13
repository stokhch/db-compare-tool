'use strict';
// Зависимости пакетов Oracle → что должно быть в PostgreSQL до запуска расчёта.
// Из ALL_DEPENDENCIES берётся, на какие пакеты, процедуры, таблицы и представления ссылается объект,
// из ALL_SOURCE — какие именно подпрограммы чужих пакетов вызываются (ПАКЕТ.ПРОЦЕДУРА(…)).
// Для каждой зависимости проверяется наличие в PostgreSQL с учётом именования plsql2pg
// (пакет_процедура) или ora2pg (схема пакета). Так ошибка «procedure maket_sn_pgu_fakt_ish_dan_sn does not exist»
// видна до запуска, а не во время расчёта.
const { connect } = require('../db');
const { getConnection, publicConnection } = require('../lib/store');

const SYS_OWNERS = new Set(['SYS', 'SYSTEM', 'PUBLIC', 'XDB', 'MDSYS', 'CTXSYS', 'ORDSYS', 'OUTLN', 'DBSNMP', 'APEX_PUBLIC_USER', 'WMSYS', 'OLAPSYS', 'LBACSYS', 'DVSYS']);
const lc = s => String(s || '').toLowerCase();

/**
 * Чистая функция анализа (тестируется без БД).
 * input = {
 *   owner, deps: [{name,type,rowner,rname,rtype}], sources: Map(name → текст), packageProcs: Map(pkg → [sub]),
 *   scope: Set(имён) | null, pgRoutines: Set('schema.name'), pgRelations: Set('schema.name'),
 *   targetSchema, naming: 'underscore'|'schema'
 * }
 */
function analyzeDeps(input) {
  const { owner, deps, sources, packageProcs, pgRoutines, pgRelations, targetSchema } = input;
  const T = lc(targetSchema);
  const objKey = (o, n) => `${o}.${n}`;
  const objType = new Map();
  for (const d of deps) { objType.set(objKey(owner, d.name), d.type.replace(' BODY', '')); objType.set(objKey(d.rowner, d.rname), d.rtype); }
  // Область: выбранные объекты + всё, что они вызывают (рекурсивно, код)
  const byName = new Map();
  for (const d of deps) { const k = d.name; if (!byName.has(k)) byName.set(k, []); byName.get(k).push(d); }
  let scope = input.scope && input.scope.size ? new Set(input.scope) : new Set(deps.map(d => d.name));
  const selected = new Set(scope); // свои подпрограммы проверяются только у выбранных объектов
  const queue = [...scope];
  while (queue.length) {
    const n = queue.shift();
    for (const d of byName.get(n) || []) {
      if (d.rowner === owner && ['PACKAGE', 'PROCEDURE', 'FUNCTION'].includes(d.rtype) && !scope.has(d.rname)) { scope.add(d.rname); queue.push(d.rname); }
    }
  }
  const findRoutine = (pkgOwner, pkg, sub) => {
    const cands = [];
    if (pkg) {
      cands.push(`${T}.${lc(pkg)}_${lc(sub)}`, `${lc(pkg)}.${lc(sub)}`, `public.${lc(pkg)}_${lc(sub)}`);
      if (pkgOwner !== owner) cands.push(`${lc(pkgOwner)}.${lc(pkg)}_${lc(sub)}`);
    } else {
      cands.push(`${T}.${lc(sub)}`, `public.${lc(sub)}`);
      if (pkgOwner !== owner) cands.push(`${lc(pkgOwner)}.${lc(sub)}`);
    }
    return { found: cands.find(c => pgRoutines.has(c)) || null, expected: cands[0] };
  };
  const findRelation = (o, n) => {
    const cands = [`${T}.${lc(n)}`, `public.${lc(n)}`];
    if (o !== owner) cands.push(`${lc(o)}.${lc(n)}`);
    return { found: cands.find(c => pgRelations.has(c)) || null, expected: cands[0] };
  };

  const rows = [];
  const seen = new Set();
  const push = r => { const k = `${r.object}|${r.dependency}|${r.kind}`; if (seen.has(k)) return; seen.add(k); rows.push(r); };

  // 1. Собственные подпрограммы выбранных пакетов
  for (const name of selected) {
    const t = objType.get(objKey(owner, name));
    if (t === 'PACKAGE') {
      for (const sub of packageProcs.get(name) || []) {
        const f = findRoutine(owner, name, sub);
        push({ object: name, dependency: `${name}.${sub}`, kind: 'своя подпрограмма', expected: f.expected, found: f.found, ok: !!f.found });
      }
    } else if (t === 'PROCEDURE' || t === 'FUNCTION') {
      const f = findRoutine(owner, null, name);
      push({ object: name, dependency: name, kind: t === 'PROCEDURE' ? 'процедура' : 'функция', expected: f.expected, found: f.found, ok: !!f.found });
    }
  }
  // 2. Зависимости
  for (const d of deps) {
    if (!scope.has(d.name) || SYS_OWNERS.has(d.rowner)) continue;
    if (d.rowner === owner && d.rname === d.name) continue;
    if (d.rtype === 'PACKAGE') {
      // какие подпрограммы вызываются — по тексту
      const text = sources.get(d.name) || '';
      const re = new RegExp(`\\b(?:"?${d.rowner}"?\\.)?"?${d.rname}"?\\s*\\.\\s*"?([A-Za-z_][\\w$#]*)"?`, 'gi');
      const subs = new Set();
      let m;
      while ((m = re.exec(text))) subs.add(m[1].toUpperCase());
      const known = packageProcs.get(d.rname);
      const calls = [...subs].filter(s => !known || known.includes(s)); // отсекаем константы/типы пакета, если список известен
      if (!calls.length) push({ object: d.name, dependency: d.rname, kind: 'пакет (вызовы не найдены в тексте)', expected: '', found: '', ok: true, info: true });
      for (const sub of calls) {
        const f = findRoutine(d.rowner, d.rname, sub);
        push({ object: d.name, dependency: `${d.rowner !== owner ? d.rowner + '.' : ''}${d.rname}.${sub}`, kind: 'вызов подпрограммы пакета', expected: f.expected, found: f.found, ok: !!f.found, package: d.rname });
      }
    } else if (d.rtype === 'PROCEDURE' || d.rtype === 'FUNCTION') {
      const f = findRoutine(d.rowner, null, d.rname);
      push({ object: d.name, dependency: d.rname, kind: d.rtype === 'PROCEDURE' ? 'процедура' : 'функция', expected: f.expected, found: f.found, ok: !!f.found });
    } else if (['TABLE', 'VIEW', 'MATERIALIZED VIEW', 'SEQUENCE'].includes(d.rtype)) {
      const f = findRelation(d.rowner, d.rname);
      const kinds = { TABLE: 'таблица', VIEW: 'представление', 'MATERIALIZED VIEW': 'мат. представление', SEQUENCE: 'последовательность' };
      push({ object: d.name, dependency: `${d.rowner !== owner ? d.rowner + '.' : ''}${d.rname}`, kind: kinds[d.rtype], expected: f.expected, found: f.found, ok: !!f.found });
    } else if (d.rtype === 'TYPE') {
      push({ object: d.name, dependency: d.rname, kind: 'тип', expected: `${T}.${lc(d.rname)}`, found: '', ok: true, info: true, note: 'типы Oracle plsql2pg обычно переводит в массивы/jsonb — проверьте вручную' });
    } else if (d.rtype === 'SYNONYM') {
      push({ object: d.name, dependency: d.rname, kind: 'синоним', expected: '', found: '', ok: true, info: true, note: 'синонима в PostgreSQL нет — нужен search_path или представление' });
    }
  }
  // 3. Порядок поставки пакетов: сначала те, от кого зависят
  const pkgDeps = new Map();
  for (const n of scope) pkgDeps.set(n, new Set());
  for (const d of deps) if (scope.has(d.name) && scope.has(d.rname) && d.rowner === owner && d.name !== d.rname && ['PACKAGE', 'PROCEDURE', 'FUNCTION'].includes(d.rtype)) pkgDeps.get(d.name).add(d.rname);
  const order = [], state = new Map(), cycles = [];
  const visit = (n, path) => {
    if (state.get(n) === 2) return;
    if (state.get(n) === 1) { cycles.push([...path, n].join(' → ')); return; }
    state.set(n, 1);
    for (const x of pkgDeps.get(n) || []) visit(x, [...path, n]);
    state.set(n, 2); order.push(n);
  };
  for (const n of [...scope].sort()) visit(n, []);
  // 4. Сводка по объектам
  const perObject = new Map();
  for (const r of rows) {
    if (r.info) continue;
    const o = perObject.get(r.object) || { object: r.object, type: objType.get(objKey(owner, r.object)) || '', total: 0, missing: 0, missingList: [] };
    o.total++; if (!r.ok) { o.missing++; o.missingList.push(r.dependency); }
    perObject.set(r.object, o);
  }
  const missingPackages = [...new Set(rows.filter(r => !r.ok && r.package).map(r => r.package))];
  return { rows, objects: [...perObject.values()].sort((a, b) => b.missing - a.missing || a.object.localeCompare(b.object)), order, cycles: [...new Set(cycles)], missingPackages, scope: [...scope] };
}

async function runDepsCheck(p, ctx) {
  const srcConn = getConnection(p.sourceId), tgtConn = getConnection(p.targetId);
  if (srcConn.type !== 'oracle') throw new Error('Источник должен быть Oracle (зависимости берутся из ALL_DEPENDENCIES)');
  if (tgtConn.type !== 'postgres') throw new Error('Приёмник должен быть PostgreSQL');
  const src = await connect(srcConn), tgt = await connect(tgtConn);
  const owner = p.sourceSchema;
  try {
    ctx.progress(0, 4, 'Зависимости Oracle…');
    const deps = (await src.query(`
      SELECT name, type, referenced_owner AS rowner, referenced_name AS rname, referenced_type AS rtype
      FROM all_dependencies
      WHERE owner = :o AND type IN ('PACKAGE BODY','PACKAGE','PROCEDURE','FUNCTION','TRIGGER','VIEW','MATERIALIZED VIEW','TYPE BODY')
        AND referenced_type IN ('PACKAGE','PROCEDURE','FUNCTION','TABLE','VIEW','MATERIALIZED VIEW','SEQUENCE','TYPE','SYNONYM')`, { o: owner }))
      .map(d => ({ ...d, type: d.type.replace(' BODY', '') }));
    ctx.progress(1, 4, 'Подпрограммы пакетов…');
    const procs = await src.query(`SELECT object_name AS pkg, procedure_name AS sub FROM all_procedures WHERE owner = :o AND object_type = 'PACKAGE' AND procedure_name IS NOT NULL`, { o: owner });
    const packageProcs = new Map();
    for (const r of procs) { if (!packageProcs.has(r.pkg)) packageProcs.set(r.pkg, []); if (!packageProcs.get(r.pkg).includes(r.sub)) packageProcs.get(r.pkg).push(r.sub); }
    // подпрограммы пакетов других владельцев, на которые есть ссылки
    const otherPkgs = [...new Set(deps.filter(d => d.rtype === 'PACKAGE' && d.rowner !== owner && !SYS_OWNERS.has(d.rowner)).map(d => `${d.rowner}.${d.rname}`))];
    for (const op of otherPkgs) {
      const [o, n] = op.split('.');
      const r = await src.query(`SELECT procedure_name AS sub FROM all_procedures WHERE owner = :o AND object_name = :n AND procedure_name IS NOT NULL`, { o, n }).catch(() => []);
      if (r.length) packageProcs.set(n, [...new Set(r.map(x => x.sub))]);
    }
    const scopeSet = p.objects && p.objects.length ? new Set(p.objects.map(o => o.name.toUpperCase() === o.name ? o.name : o.name.toUpperCase())) : null;
    ctx.progress(2, 4, 'Тексты процедур…');
    const needSrc = [...new Set(deps.filter(d => d.rtype === 'PACKAGE').map(d => d.name))];
    const sources = new Map();
    for (const n of needSrc) {
      ctx.checkCancel();
      const r = await src.query(`SELECT text FROM all_source WHERE owner = :o AND name = :n AND type IN ('PACKAGE BODY','PROCEDURE','FUNCTION','TRIGGER') ORDER BY type, line`, { o: owner, n });
      // без комментариев и строк
      sources.set(n, r.map(x => x.text).join('').replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''"));
    }
    ctx.progress(3, 4, 'Объекты PostgreSQL…');
    const pgR = await tgt.query(`SELECT n.nspname || '.' || p.proname AS k FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema')`);
    const pgC = await tgt.query(`SELECT n.nspname || '.' || c.relname AS k FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p','v','m','S','f') AND n.nspname NOT IN ('pg_catalog','information_schema')`);
    const res = analyzeDeps({
      owner, deps, sources, packageProcs, scope: scopeSet,
      pgRoutines: new Set(pgR.map(r => r.k.toLowerCase())), pgRelations: new Set(pgC.map(r => r.k.toLowerCase())),
      targetSchema: p.targetSchema, naming: p.packageNaming || 'underscore',
    });
    const missing = res.rows.filter(r => !r.ok).length;
    ctx.log(`Проверено зависимостей: ${res.rows.length}, отсутствует в PostgreSQL: ${missing}`, missing ? 'warning' : 'info');
    if (res.missingPackages.length) ctx.log(`Не поставлены (полностью или частично) пакеты: ${res.missingPackages.join(', ')}`, 'warning');
    return {
      summary: { objects: res.objects.length, dependencies: res.rows.length, missing, missingPackages: res.missingPackages.length },
      source: { ...publicConnection(srcConn), schema: owner }, target: { ...publicConnection(tgtConn), schema: p.targetSchema },
      ...res,
    };
  } finally { await src.close(); await tgt.close(); }
}

module.exports = { runDepsCheck, analyzeDeps };
