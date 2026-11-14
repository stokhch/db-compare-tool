'use strict';
// Зависимости кода из дампа: на какие схемы, пакеты, таблицы и DB links ссылаются пакеты, процедуры, функции,
// триггеры, типы и представления — и чего из этого нет ни в дампе, ни в базе-приёмнике.
// Разбор текстовый: учитываются только ссылки, похожие на обращения к объектам (вызов с «(», FROM/JOIN/INTO/UPDATE,
// три части имени, %TYPE/%ROWTYPE, .NEXTVAL, @dblink) — обращения к колонкам через псевдонимы не считаются.
const { cleanCode } = require('../compare/translation');

const ID = '"?([A-Za-z][\\w$#]*)"?';
const SP = '\\s*\\.\\s*';
// пакеты Oracle и стандартные объекты — не зависимости от чужих схем
const BUILTIN = /^(DBMS_\w*|UTL_\w*|OWA\w*|HTP|HTF|APEX_\w*|WWV_\w*|CTX_\w*|SDO_\w*|ORD\w*|XMLTYPE|XMLDOM|XMLPARSER|XSLPROCESSOR|JSON_\w*|STANDARD|SYS|SYSTEM|PUBLIC|DUAL|PLITBLM|DBMS|SYS_\w*|ANYDATA|ANYTYPE|URIFACTORY|LOGMNR\w*|KU\$_\w*|AQ\$_\w*|ORA_\w*|OUTLN|MDSYS|CTXSYS|XDB|WMSYS|USER|SESSION|SQL|SQLERRM|SQLCODE)$/i;
const COLLECTION = new Set(['COUNT', 'FIRST', 'LAST', 'NEXT', 'PRIOR', 'EXISTS', 'EXTEND', 'DELETE', 'TRIM', 'LIMIT']);
const CODE_TYPES = new Set(['PACKAGE', 'PACKAGE BODY', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'TYPE', 'TYPE BODY', 'VIEW', 'MATERIALIZED VIEW']);

/** Ссылки из текста одного объекта. → [{ a, b, c, link, ctx }] (имена в верхнем регистре) */
function extractRefs(sql) {
  const code = cleanCode(sql);
  const out = new Map();
  const add = (a, b, c, link, ctx) => {
    a = a && a.toUpperCase(); b = b && b.toUpperCase(); c = c && c.toUpperCase(); link = link && link.toUpperCase();
    const k = [a, b, c, link].join('|');
    if (!out.has(k)) out.set(k, { a, b: b || null, c: c || null, link: link || null, ctx });
  };
  // локальные переменные и параметры: «имя тип …» в объявлениях — их методы и поля не считаем ссылками
  const locals = new Set();
  const decl = /(?:^|[;(,]|\bIS\b|\bAS\b|\bDECLARE\b)\s*([A-Za-z][\w$#]*)\s+(?:IN\s+OUT\s+|IN\s+|OUT\s+|CONSTANT\s+|NOCOPY\s+)*(?:[A-Za-z][\w$#.%]*)/gi;
  let m;
  while ((m = decl.exec(code))) locals.add(m[1].toUpperCase());
  // трёхчастные: SCHEMA.PKG.SUB, SCHEMA.TABLE.COL%TYPE
  const r3 = new RegExp(`(?<![:\\w$#.])${ID}${SP}${ID}${SP}${ID}(\\s*@\\s*[\\w.$#]+)?`, 'g');
  while ((m = r3.exec(code))) {
    if (COLLECTION.has(m[3].toUpperCase()) || locals.has(m[1].toUpperCase())) continue;
    add(m[1], m[2], m[3], m[4] && m[4].replace(/[@\s]/g, ''), '3');
  }
  // двухчастные с вызовом: X.Y(  — схема.процедура или пакет.подпрограмма
  const r2c = new RegExp(`(?<![:\\w$#.])${ID}${SP}${ID}(\\s*@\\s*[\\w.$#]+)?\\s*\\(`, 'g');
  while ((m = r2c.exec(code))) {
    if (COLLECTION.has(m[2].toUpperCase()) || locals.has(m[1].toUpperCase())) continue;
    add(m[1], m[2], null, m[3] && m[3].replace(/[@\s]/g, ''), 'call');
  }
  // таблицы в SQL: FROM/JOIN/INTO/UPDATE/TABLE X.Y
  const rt = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE|TABLE|USING)\\s+${ID}(?:${SP}${ID})?(\\s*@\\s*[\\w.$#]+)?`, 'gi');
  while ((m = rt.exec(code))) {
    if (m[2] && locals.has(m[1].toUpperCase())) continue;
    if (m[2]) add(m[1], m[2], null, m[3] && m[3].replace(/[@\s]/g, ''), 'table');
    else if (m[3]) add(null, m[1], null, m[3].replace(/[@\s]/g, ''), 'table');
  }
  // FROM t1, SCHEMA.t2 — следующие таблицы через запятую
  const rlist = new RegExp(`,\\s*${ID}${SP}${ID}(\\s*@\\s*[\\w.$#]+)?\\s+(?:[A-Za-z]\\w*\\s*)?(?=,|\\bWHERE\\b|\\)|$)`, 'gi');
  while ((m = rlist.exec(code))) if (!locals.has(m[1].toUpperCase())) add(m[1], m[2], null, m[3] && m[3].replace(/[@\s]/g, ''), 'table');
  // SCHEMA.T%ROWTYPE, SCHEMA.SEQ.NEXTVAL (двухчастное с %TYPE — таблица.колонка своей схемы, не считаем)
  const rrt = new RegExp(`${ID}${SP}${ID}\\s*%\\s*ROWTYPE`, 'gi');
  while ((m = rrt.exec(code))) add(m[1], m[2], null, null, 'rowtype');
  // одиночные dblink: X@LINK
  const rl = /(?<![\w$#."])([A-Za-z][\w$#]*)\s*@\s*([A-Za-z][\w.$#]*)/g;
  while ((m = rl.exec(code))) add(null, m[1], null, m[2], 'link');
  return [...out.values()].filter(r => !(r.a && r.b === 'NEXTVAL') && !(r.a && r.b === 'CURRVAL'));
}

/**
 * Классификация ссылок.
 * contents: { objectNames: { OWNER: [NAME…] }, codeRefs: [{ owner, object, type, refs }], dbLinks, schemas }
 * target: { users: Set, objects: Map(OWNER → Set(NAME)), named: Set(NAME — любой объект/синоним с таким именем), publicSyn: Set, dbLinks: Set }
 * remap: { SRC: TGT } — переименование схем при импорте
 * → { missing: [{ ref, kind, reason, usedBy:[…] }], dblinks: [{ link, usedBy }], resolved, checked }
 */
function classify(contents, target, remap = {}) {
  const inDump = new Map(Object.entries(contents.objectNames || {}).map(([o, l]) => [o, new Set(l)]));
  const dumpSchemas = new Set([...inDump.keys(), ...(contents.schemas || []).map(s => s.name)]);
  const dumpLinks = new Set((contents.dbLinks || []).map(l => String(l.name).toUpperCase().split('.')[0]));
  const tgtUsers = target.users || new Set();
  const tgtObj = target.objects || new Map();
  const named = target.named || new Set();
  const tgtLinks = new Set([...(target.dbLinks || [])].map(x => String(x).toUpperCase().split('.')[0]));
  const map = new Map(), links = new Map();
  let checked = 0, resolved = 0;
  const miss = (key, kind, reason, user, example) => {
    if (!map.has(key)) map.set(key, { ref: key, kind, reason, usedBy: new Set(), examples: new Set() });
    const x = map.get(key); x.usedBy.add(user); if (example && x.examples.size < 5) x.examples.add(example);
  };
  const has = (owner, name) => (inDump.get(owner) || new Set()).has(name) || (tgtObj.get(remap[owner] || owner) || new Set()).has(name);
  for (const o of contents.codeRefs || []) {
    const user = `${o.owner}.${o.object}`;
    const own = inDump.get(o.owner) || new Set();
    for (const r of o.refs) {
      if (r.link) {
        const ln = r.link.split('.')[0];
        if (!dumpLinks.has(ln) && !tgtLinks.has(ln)) { if (!links.has(ln)) links.set(ln, new Set()); links.get(ln).add(user); }
        continue;
      }
      if (!r.a) continue;
      if (BUILTIN.test(r.a)) continue;
      checked++;
      if (r.a === o.owner) { // явная ссылка на свою схему
        if (has(o.owner, r.b)) resolved++; else miss(`${r.a}.${r.b}`, 'object', `в схеме ${r.a} нет объекта ${r.b}`, user);
        continue;
      }
      if (own.has(r.a)) { resolved++; continue; }              // свой пакет / таблица / тип / последовательность
      if (dumpSchemas.has(r.a) || tgtUsers.has(remap[r.a] || r.a)) {                // ссылка на другую схему
        if (has(r.a, r.b)) resolved++;
        else miss(`${r.a}.${r.b}`, 'object', `схема ${r.a} есть, но объекта ${r.b} в ней нет${dumpSchemas.has(r.a) ? ' (ни в дампе, ни в базе)' : ' в базе'}`, user);
        continue;
      }
      if (named.has(r.a)) { resolved++; continue; }           // синоним или объект с таким именем есть в базе
      if (r.ctx === 'call' || r.ctx === '3' || r.ctx === 'table' || r.ctx === 'rowtype') miss(r.a, 'schema', `нет схемы, пакета или синонима ${r.a} ни в дампе, ни в базе`, user, [r.a, r.b, r.c].filter(Boolean).join('.'));
    }
  }
  const missing = [...map.values()].map(x => ({ ...x, usedBy: [...x.usedBy].sort(), examples: [...x.examples] })).sort((a, b) => b.usedBy.length - a.usedBy.length);
  return { missing, dblinks: [...links].map(([link, u]) => ({ link, usedBy: [...u].sort() })), checked, resolved };
}

/** Что нужно спросить у базы-приёмника, чтобы классифицировать ссылки. */
function lookupsNeeded(contents) {
  const owners = new Set(), names = new Set();
  for (const o of contents.codeRefs || []) for (const r of o.refs) {
    if (!r.a || BUILTIN.test(r.a)) continue;
    owners.add(r.a); names.add(r.a);
  }
  return { owners: [...owners], names: [...names] };
}

/** Запросы к Oracle-приёмнику и классификация. */
async function resolveInOracle(db, contents, t) {
  const need = lookupsNeeded(contents);
  const users = new Set(t.allUsers || []);
  const objects = new Map(), named = new Set();
  const refsByOwner = new Map();
  for (const o of contents.codeRefs || []) for (const r of o.refs) if (r.a && r.b && users.has(r.a)) { if (!refsByOwner.has(r.a)) refsByOwner.set(r.a, new Set()); refsByOwner.get(r.a).add(r.b); }
  for (const [owner, set] of refsByOwner) {
    const list = [...set];
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500);
      const binds = { o: owner }; chunk.forEach((n, k) => (binds[`n${k}`] = n));
      const rows = await db.query(`SELECT object_name AS n FROM all_objects WHERE owner = :o AND object_name IN (${chunk.map((_, k) => `:n${k}`).join(', ')})`, binds).catch(() => []);
      if (!objects.has(owner)) objects.set(owner, new Set());
      for (const r of rows) objects.get(owner).add(r.n);
    }
  }
  const cand = need.names.filter(n => !users.has(n));
  for (let i = 0; i < cand.length; i += 500) {
    const chunk = cand.slice(i, i + 500);
    const binds = {}; chunk.forEach((n, k) => (binds[`n${k}`] = n));
    const rows = await db.query(`SELECT DISTINCT object_name AS n FROM all_objects WHERE object_name IN (${chunk.map((_, k) => `:n${k}`).join(', ')}) AND (owner IN ('PUBLIC', 'SYS') OR object_type IN ('PACKAGE', 'SYNONYM', 'PROCEDURE', 'FUNCTION', 'TYPE'))`, binds).catch(() => []);
    for (const r of rows) named.add(r.n);
  }
  const links = await db.query(`SELECT db_link AS l FROM all_db_links`).catch(() => []);
  return classify(contents, { users, objects, named, dbLinks: new Set(links.map(x => x.l)) });
}

module.exports = { extractRefs, classify, resolveInOracle, lookupsNeeded, CODE_TYPES, BUILTIN };
