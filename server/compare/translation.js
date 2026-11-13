'use strict';
// Проверка перевода кода Oracle → PostgreSQL: ищет потенциально неправильно переведённые функции и процедуры.
//
// Три группы проверок:
//  1. Сигнатура: у функции PostgreSQL должно быть столько же входных параметров, сколько у Oracle-оригинала,
//     совместимых типов, те же OUT-параметры, функция ↔ функция, процедура ↔ процедура, те же имена параметров
//     (иначе ломаются вызовы с именованными параметрами p => …).
//  2. Текст на PostgreSQL: остатки Oracle-конструкций (NVL, DECODE, SYSDATE, ROWNUM, (+), seq.NEXTVAL, EXECUTE IMMEDIATE,
//     SQL%ROWCOUNT, DUP_VAL_ON_INDEX…), смысловые ловушки (сравнение с '' — в Oracle это NULL; SELECT INTO без STRICT
//     при обработчике NO_DATA_FOUND; TRUNC даты; TO_NUMBER без формата; COMMIT в функции; WHEN OTHERS THEN NULL).
//     Функции, которые есть в базе (orafce или свои обёртки), не считаются ошибкой.
//  3. Логика относительно оригинала: в какие таблицы пишет (INSERT/UPDATE/DELETE/MERGE), число IF и циклов,
//     RAISE_APPLICATION_ERROR → RAISE, COMMIT, заметно более короткий текст — признаки, что переведено не всё.
//
// Проверки эвристические: находка — повод посмотреть код, а не доказательство ошибки.

const lc = s => String(s || '').toLowerCase();

// ---------- Подготовка текста ----------
/** Убирает комментарии; строки: keepEmpty — '' остаются, остальные → 's'. Переводы строк сохраняются (для номеров строк). */
function cleanCode(text, { strings = 'blank' } = {}) {
  let out = '';
  const s = String(text || '');
  for (let i = 0; i < s.length;) {
    const c = s[i], n = s[i + 1];
    if (c === '-' && n === '-') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const e = s.indexOf('*/', i + 2); const chunk = s.slice(i, e < 0 ? s.length : e + 2); out += chunk.replace(/[^\n]/g, ' '); i = e < 0 ? s.length : e + 2; continue; }
    if (c === '$' && /^\$[A-Za-z_]*\$/.test(s.slice(i))) { // долларовые кавычки внутри тела (EXECUTE $q$…$q$)
      const tag = s.slice(i).match(/^\$[A-Za-z_]*\$/)[0];
      const e = s.indexOf(tag, i + tag.length);
      const chunk = s.slice(i, e < 0 ? s.length : e + tag.length);
      out += strings === 'keep' ? chunk : `'s'${chunk.replace(/[^\n]/g, '')}`;
      i = e < 0 ? s.length : e + tag.length; continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < s.length) { if (s[j] === "'" && s[j + 1] === "'") { j += 2; continue; } if (s[j] === "'") break; j++; }
      const lit = s.slice(i, j + 1);
      if (strings === 'keep') out += lit;
      else out += (lit === "''" ? "''" : "'s'") + lit.replace(/[^\n]/g, '');
      i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
const words = text => (text.match(/[A-Za-z_][\w$#]*|\d+/g) || []).length;

// ---------- Разбиение тела пакета Oracle на подпрограммы ----------
/**
 * body — текст PACKAGE BODY (очищенный). subs — имена подпрограмм из спецификации.
 * Возвращает Map(SUB → текст). Перегрузки склеиваются. Приватные процедуры (нет в спецификации)
 * приклеиваются к предыдущей — приближение без PL/Scope.
 */
function splitPackageBody(body, subs) {
  const want = new Set(subs.map(x => x.toUpperCase()));
  const re = /\b(PROCEDURE|FUNCTION)\s+"?([A-Za-z][\w$#]*)"?/gi;
  const heads = [];
  let m;
  while ((m = re.exec(body))) {
    const name = m[2].toUpperCase();
    if (!want.has(name)) continue;
    // объявление вперёд: «PROCEDURE x(…);» — до IS/AS встречается «;»
    const rest = body.slice(m.index + m[0].length);
    const semi = rest.search(/;/), isas = rest.search(/\b(IS|AS)\b/i);
    if (semi >= 0 && (isas < 0 || semi < isas)) continue;
    heads.push({ name, at: m.index });
  }
  const res = new Map();
  heads.forEach((h, i) => {
    const text = body.slice(h.at, i + 1 < heads.length ? heads[i + 1].at : body.length);
    res.set(h.name, (res.get(h.name) || '') + '\n' + text);
  });
  return res;
}

// ---------- Признаки логики ----------
const TABLE_RE = '"?([A-Za-z_][\\w$#]*)"?(?:\\s*\\.\\s*"?([A-Za-z_][\\w$#]*)"?)?';
function dmlTargets(code) {
  const set = new Set();
  const re = new RegExp(`\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|DELETE|MERGE\\s+INTO)\\s+${TABLE_RE}`, 'gi');
  let m;
  while ((m = re.exec(code))) {
    const name = lc(m[2] || m[1]);
    if (['set', 'from', 'into', 'only', 'of', 'cascade', 'where', 'nowait', 'skip'].includes(name)) continue;
    // «FOR UPDATE OF t», «ON CONFLICT … DO UPDATE»; в MERGE «THEN UPDATE SET» / «THEN DELETE WHERE» отсекаются по имени
    const before = code.slice(Math.max(0, m.index - 20), m.index);
    if (/\b(FOR|DO)\s+$/i.test(before) && /^UPDATE/i.test(m[0])) continue;
    set.add(name);
  }
  return set;
}
function counts(code) {
  const c = re => (code.match(re) || []).length;
  return {
    if: c(/\bIF\b/gi) - c(/\bEND\s+IF\b/gi) - c(/\b(DROP|CREATE|ALTER)\b[^;]*?\bIF\s+(NOT\s+)?EXISTS\b/gi),
    loop: c(/\bLOOP\b/gi) - c(/\bEND\s+LOOP\b/gi),
    raiseApp: c(/\bRAISE_APPLICATION_ERROR\b/gi),
    raise: c(/\bRAISE\b/gi),
    commit: c(/\bCOMMIT\b/gi),
    words: words(code),
  };
}

// ---------- Семейства типов параметров ----------
function argFamily(t) {
  const s = lc(t).replace(/\(.*\)/, '').trim();
  if (!s) return 'other';
  if (/^(number|integer|int|smallint|float|binary_integer|pls_integer|natural|positive|simple_integer|binary_float|binary_double|numeric|bigint|real|double precision|decimal|int[248]|float[48])$/.test(s)) return 'num';
  if (/^(varchar2|nvarchar2|char|nchar|varchar|character varying|character|text|bpchar|string|clob|nclob|long|citext|name)$/.test(s)) return 'str';
  if (/^(date|timestamp.*|time.*)$/.test(s)) return 'date';
  if (/boolean|^bool$/.test(s)) return 'bool';
  if (/ref cursor|refcursor/.test(s)) return 'cursor';
  if (/^(blob|raw|long raw|bytea)$/.test(s)) return 'bin';
  return 'other';
}

// ---------- Правила для текста PostgreSQL ----------
// need: функция/тип, при наличии которых в базе правило не срабатывает (orafce и собственные обёртки)
const RULES = [
  { id: 'nvl', level: 'error', re: /\bNVL\s*\(/gi, need: 'nvl', msg: 'NVL — в PostgreSQL coalesce(…)' },
  { id: 'nvl2', level: 'error', re: /\bNVL2\s*\(/gi, need: 'nvl2', msg: 'NVL2 — CASE WHEN x IS NOT NULL THEN … ELSE … END' },
  { id: 'decode', level: 'error', re: /\bDECODE\s*\(/gi, need: '__decode_ora', msg: 'DECODE — CASE … WHEN … END (учтите: DECODE считает NULL = NULL)' },
  { id: 'sysdate', level: 'error', re: /\bSYS(DATE|TIMESTAMP)\b(?!\s*\()/gi, msg: 'SYSDATE/SYSTIMESTAMP — localtimestamp(0) / clock_timestamp()' },
  { id: 'rownum', level: 'error', re: /\bROWNUM\b/gi, msg: 'ROWNUM — LIMIT или row_number() OVER ()' },
  { id: 'rowid', level: 'warning', re: /\bROWID\b/gi, msg: 'ROWID — в PostgreSQL ctid меняется при UPDATE; используйте первичный ключ' },
  { id: 'dual', level: 'warning', re: /\bFROM\s+DUAL\b/gi, needRel: 'dual', msg: 'FROM dual — в PostgreSQL SELECT без FROM' },
  { id: 'outer', level: 'error', re: /\(\s*\+\s*\)/g, msg: '(+) — внешнее соединение Oracle; перепишите через LEFT JOIN' },
  { id: 'seq', level: 'error', re: /\.\s*(NEXTVAL|CURRVAL)\b/gi, msg: 'seq.NEXTVAL — nextval(\'seq\')' },
  { id: 'connectby', level: 'error', re: /\bCONNECT\s+BY\b/gi, msg: 'CONNECT BY — WITH RECURSIVE' },
  { id: 'minus', level: 'error', re: /\bMINUS\b/gi, msg: 'MINUS — EXCEPT' },
  { id: 'execimm', level: 'error', re: /\bEXECUTE\s+IMMEDIATE\b/gi, msg: 'EXECUTE IMMEDIATE — EXECUTE … USING' },
  { id: 'bulk', level: 'error', re: /\bBULK\s+COLLECT\b|\bFORALL\b/gi, msg: 'BULK COLLECT / FORALL — массивы (array_agg) или один SQL-оператор' },
  { id: 'sqlattr', level: 'error', re: /\bSQL\s*%\s*(ROWCOUNT|FOUND|NOTFOUND|ISOPEN)\b/gi, msg: 'SQL%ROWCOUNT/FOUND — GET DIAGNOSTICS n = ROW_COUNT / переменная FOUND' },
  { id: 'curattr', level: 'error', re: /\b[A-Za-z_]\w*\s*%\s*(NOTFOUND|FOUND|ISOPEN|ROWCOUNT)\b/gi, msg: 'курсор%NOTFOUND — в PL/pgSQL после FETCH проверяют FOUND' },
  { id: 'rae', level: 'error', re: /\bRAISE_APPLICATION_ERROR\s*\(/gi, need: 'raise_application_error', msg: 'RAISE_APPLICATION_ERROR — RAISE EXCEPTION … USING ERRCODE = \'P0001\'' },
  { id: 'dbmsout', level: 'error', re: /\bDBMS_OUTPUT\s*\.\s*PUT_LINE\b/gi, need: 'put_line', msg: 'DBMS_OUTPUT.PUT_LINE — RAISE NOTICE' },
  { id: 'oratypes', level: 'error', re: /\b(VARCHAR2|NVARCHAR2|PLS_INTEGER|BINARY_INTEGER)\b|\bNUMBER\s*\(/gi, needType: true, msg: 'Типы Oracle (VARCHAR2, NUMBER(…), PLS_INTEGER) — varchar, numeric, integer' },
  { id: 'oraexc', level: 'error', re: /\bWHEN\s+(DUP_VAL_ON_INDEX|ZERO_DIVIDE|VALUE_ERROR|INVALID_NUMBER|CURSOR_ALREADY_OPEN|INVALID_CURSOR|STORAGE_ERROR|TIMEOUT_ON_RESOURCE)\b/gi,
    msg: 'Имена исключений Oracle — unique_violation, division_by_zero, invalid_text_representation…' },
  { id: 'sqlcode', level: 'error', re: /\bSQLCODE\b/gi, msg: 'SQLCODE — в PostgreSQL SQLSTATE (текст, напр. \'P0002\')' },
  { id: 'builtins', level: 'error', re: /\b(ADD_MONTHS|MONTHS_BETWEEN|LAST_DAY|NEXT_DAY|INSTR|BITAND|SYS_GUID|SYS_CONTEXT|USERENV|LISTAGG|SUBSTRB|LENGTHB)\s*\(/gi, needEach: true,
    msg: 'Функция Oracle, которой нет в PostgreSQL' },
  { id: 'emptystr', level: 'warning', re: /(=|<>|!=)\s*''(?!')|''\s*(=|<>|!=)/g,
    msg: "Сравнение с '' — в Oracle '' это NULL, такое условие там никогда не было истинным; в PostgreSQL срабатывает. Обычно нужно x IS NULL или coalesce(x, '') = ''" },
  { id: 'trunc', level: 'warning', re: /\bTRUNC\s*\(\s*(now\s*\(\s*\)|current_date|current_timestamp|localtimestamp|clock_timestamp\s*\(\s*\)|[\w.]+)\s*[,)]/gi, need: 'trunc_date',
    check: m => /^(now|current_|localtimestamp|clock_timestamp)/i.test(m[1]) || /(^|[_.])(d|dt|dat|date)\d*($|_)|date|^dat/i.test(m[1]),
    msg: 'TRUNC от даты — в PostgreSQL trunc только для чисел: date_trunc(\'day\', …)::date' },
  { id: 'tonum', level: 'warning', re: /\bTO_(NUMBER|DATE)\s*\(\s*[^,()']+\)/gi, msg: 'TO_NUMBER/TO_DATE без формата — в PostgreSQL формат обязателен (или приведение ::numeric / ::date)' },
  { id: 'othersnull', level: 'warning', re: /\bWHEN\s+OTHERS\s+THEN\s+NULL\s*;/gi, msg: 'WHEN OTHERS THEN NULL — ошибки молча проглатываются; в PostgreSQL ещё и откатываются изменения блока' },
];

// число аргументов вызова, начиная с позиции после «(»
function topLevelArgs(code, from) {
  let depth = 0, n = 1;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === '(') depth++;
    else if (c === ')') { if (depth === 0) return n; depth--; }
    else if (c === ',' && depth === 0) n++;
  }
  return n;
}

function lintPg(fn, env) {
  const out = [];
  const code = fn.code;            // без комментариев, строки → 's' ('' сохранены)
  for (const r of RULES) {
    if (r.need && env.pgFuncs.has(r.need === 'trunc_date' ? '__trunc_date' : r.need)) continue;
    if (r.id === 'decode') { // встроенная decode(bytea, text) есть всегда — ищем только вызовы с 3+ аргументами
      r.re.lastIndex = 0;
      const many = [];
      let d;
      while ((d = r.re.exec(code))) if (topLevelArgs(code, d.index + d[0].length) >= 3) many.push(d);
      if (many.length) out.push({ rule: r.id, level: r.level, line: lineOf(code, many[0].index), count: many.length, fragment: code.slice(many[0].index, many[0].index + 60).split('\n')[0].trim(), message: r.msg });
      continue;
    }
    if (r.needRel && env.pgRels.has(r.needRel)) continue;
    r.re.lastIndex = 0;
    const hits = [];
    let m;
    while ((m = r.re.exec(code))) {
      if (r.needType && env.pgTypes.has(lc((m[1] || 'number').replace(/\s*\($/, '')))) continue;
      if (r.needEach && env.pgFuncs.has(lc(m[1]))) continue;
      if (r.id === 'curattr' && /^SQL\s*%/i.test(m[0])) continue;
      if (r.check && !r.check(m)) continue;
      hits.push(m);
      if (m[0] === '') r.re.lastIndex++;
    }
    if (!hits.length) continue;
    const first = hits[0];
    const fragment = code.slice(first.index, first.index + 60).split('\n')[0].trim();
    const extra = r.needEach ? `: ${[...new Set(hits.map(h => h[1].toUpperCase()))].join(', ')}` : '';
    out.push({ rule: r.id, level: r.level, line: lineOf(code, first.index), count: hits.length, fragment, message: r.msg + extra });
  }
  // SELECT INTO без STRICT при обработчике NO_DATA_FOUND / TOO_MANY_ROWS
  if (/\bWHEN\s+(NO_DATA_FOUND|TOO_MANY_ROWS)\b/i.test(code)) {
    const re = /\bSELECT\b[^;]*?\bINTO\b(?!\s+STRICT\b)/gi;
    let m, n = 0, first = null;
    while ((m = re.exec(code))) {
      // агрегат без GROUP BY всегда возвращает одну строку — STRICT не нужен
      const stmt = code.slice(m.index, code.indexOf(';', m.index) < 0 ? code.length : code.indexOf(';', m.index));
      if (/^SELECT\s+(count|sum|min|max|avg)\s*\(/i.test(stmt) && !/\bGROUP\s+BY\b/i.test(stmt)) continue;
      n++; if (!first) first = m;
    }
    if (n) out.push({ rule: 'strict', level: 'error', line: lineOf(code, first.index), count: n, fragment: code.slice(first.index, first.index + 60).split('\n')[0].trim(),
      message: 'SELECT … INTO без STRICT: в PostgreSQL при отсутствии строки переменная просто станет NULL, обработчик NO_DATA_FOUND не сработает (в Oracle — сработал бы). Нужно SELECT … INTO STRICT' });
  }
  // COMMIT/ROLLBACK в функции
  if (fn.kind === 'f') {
    const m = /\b(COMMIT|ROLLBACK)\s*;/i.exec(code);
    if (m) out.push({ rule: 'commitfn', level: 'error', line: lineOf(code, m.index), count: 1, fragment: m[0], message: 'COMMIT/ROLLBACK в функции PostgreSQL запрещён — переделайте в процедуру (CALL)' });
  }
  return out;
}

// ---------- Сопоставление Oracle ↔ PostgreSQL ----------
function pgCandidates(pkg, sub, targetSchema) {
  const T = lc(targetSchema);
  return pkg ? [`${T}.${lc(pkg)}_${lc(sub)}`, `${lc(pkg)}.${lc(sub)}`] : [`${T}.${lc(sub)}`];
}

/**
 * Чистая функция (тестируется без БД).
 * input = {
 *   targetSchema,
 *   oracle: [{ package, name, overloads: [{ args:[{name,type,mode}], returns }], code }]   — code очищен (cleanCode)
 *   pg: Map('schema.name' → [{ kind:'f'|'p', args:[{name,type,mode}], returns, code, lang }])
 *   pgFuncs: Set(имён функций в базе, lower), pgRels: Set(имён отношений), pgTypes: Set(имён типов),
 *   scopePg: Set('schema.name') | null — проверять только эти функции PG (для фильтра объектов), иначе все сопоставленные
 *   lintUnmatched: true — проверять и функции PG без оригинала в Oracle (только правила по тексту)
 * }
 * → [{ object, oracle, rule, level, line, count, fragment, message }]
 */
function analyzeTranslation(input) {
  const { oracle, pg, targetSchema } = input;
  const env = { pgFuncs: input.pgFuncs || new Set(), pgRels: input.pgRels || new Set(), pgTypes: input.pgTypes || new Set() };
  const findings = [];
  const seenPg = new Set();
  const push = (object, ora, f) => findings.push({ object, oracle: ora, ...f });

  for (const o of oracle) {
    const oname = o.package ? `${o.package}.${o.name}` : o.name;
    const key = pgCandidates(o.package, o.name, targetSchema).find(k => pg.has(k));
    if (!key) continue; // отсутствие — в категории «Функции и процедуры»
    seenPg.add(key);
    const variants = pg.get(key);

    // 1. Сигнатура
    for (const ov of o.overloads) {
      const insO = ov.args.filter(a => a.mode !== 'OUT');
      const outsO = ov.args.filter(a => a.mode !== 'IN');
      const match = variants.find(v => v.args.filter(a => a.mode !== 'o' && a.mode !== 't').length === insO.length);
      if (!match) {
        const have = variants.map(v => v.args.filter(a => a.mode !== 'o' && a.mode !== 't').length).join(', ');
        push(key, oname, { rule: 'sig-count', level: 'error', message: `Нет варианта с ${insO.length} входными параметрами (в Oracle: ${insO.map(a => `${lc(a.name)} ${a.type}`).join(', ') || 'без параметров'}; в PostgreSQL входных: ${have})` });
        continue;
      }
      const insP = match.args.filter(a => a.mode !== 'o' && a.mode !== 't');
      const bad = [], renamed = [];
      insO.forEach((a, i) => {
        const fa = argFamily(a.type), fp = argFamily(insP[i].type);
        if (fa !== 'other' && fp !== 'other' && fa !== fp) bad.push(`${lc(a.name) || i + 1}: ${a.type} → ${insP[i].type}`);
        if (a.name && insP[i].name && lc(a.name) !== lc(insP[i].name)) renamed.push(`${lc(a.name)} → ${insP[i].name}`);
      });
      if (bad.length) push(key, oname, { rule: 'sig-types', level: 'error', message: `Несовместимые типы параметров: ${bad.join('; ')}` });
      if (renamed.length) push(key, oname, { rule: 'sig-names', level: 'warning', message: `Другие имена параметров (сломаются вызовы вида p => …): ${renamed.join('; ')}` });
      const outsP = match.args.filter(a => a.mode === 'o' || a.mode === 'b');
      const isFuncO = !!ov.returns, isFuncP = match.kind === 'f' && match.returns && match.returns !== 'void';
      if (!isFuncO && outsO.length && outsP.length !== outsO.length && !(isFuncP && outsO.length === 1))
        push(key, oname, { rule: 'sig-out', level: 'error', message: `OUT-параметров в Oracle ${outsO.length}, в PostgreSQL ${outsP.length}` });
      if (isFuncO && match.kind === 'p') push(key, oname, { rule: 'sig-kind', level: 'warning', message: 'В Oracle функция, в PostgreSQL процедура — вызов SELECT f(…) / x := f(…) не сработает' });
      if (!isFuncO && match.kind === 'f' && !outsO.length && match.returns && !/^(void|record|trigger)$/.test(match.returns))
        push(key, oname, { rule: 'sig-kind', level: 'warning', message: `В Oracle процедура, в PostgreSQL функция, возвращающая ${match.returns}` });
      if (isFuncO && isFuncP && !outsP.length) {
        const fa = argFamily(ov.returns), fp = argFamily(match.returns);
        if (fa !== 'other' && fp !== 'other' && fa !== fp) push(key, oname, { rule: 'sig-ret', level: 'error', message: `Тип результата: ${ov.returns} → ${match.returns}` });
      }
    }

    // 2. Текст PostgreSQL
    for (const v of variants) for (const f of lintPg(v, env)) push(key, oname, f);

    // 3. Логика относительно оригинала
    if (o.code) {
      const pgCode = variants.map(v => v.code).join('\n');
      const ta = dmlTargets(o.code), tb = dmlTargets(pgCode);
      const lost = [...ta].filter(t => !tb.has(t)), added = [...tb].filter(t => !ta.has(t));
      if (lost.length) push(key, oname, { rule: 'dml-lost', level: 'error', message: `В Oracle изменяет таблицы, которых нет в переводе: ${lost.join(', ')}` });
      if (added.length) push(key, oname, { rule: 'dml-added', level: 'warning', message: `В переводе изменяет таблицы, которых нет в оригинале: ${added.join(', ')}` });
      const ca = counts(o.code), cb = counts(pgCode);
      const diff = (a, b) => Math.abs(a - b) > Math.max(1, Math.round(Math.max(a, b) * 0.2));
      const parts = [];
      if (diff(ca.if, cb.if)) parts.push(`условий IF ${ca.if} → ${cb.if}`);
      if (diff(ca.loop, cb.loop)) parts.push(`циклов ${ca.loop} → ${cb.loop}`);
      if (parts.length) push(key, oname, { rule: 'flow', level: 'warning', message: `Разная структура: ${parts.join(', ')}` });
      if (ca.raiseApp && !cb.raise) push(key, oname, { rule: 'raise-lost', level: 'error', message: `В Oracle ${ca.raiseApp} × RAISE_APPLICATION_ERROR, в переводе нет ни одного RAISE — проверки бизнес-логики потеряны` });
      if (!!ca.commit !== !!cb.commit) push(key, oname, { rule: 'commit', level: 'warning', message: ca.commit ? 'В Oracle есть COMMIT, в переводе нет — фиксация изменится' : 'В переводе есть COMMIT, которого нет в оригинале' });
      if (ca.words > 80 && cb.words < ca.words * 0.4) push(key, oname, { rule: 'short', level: 'warning', message: `Текст перевода в ${(ca.words / Math.max(cb.words, 1)).toFixed(1)} раза короче оригинала — возможно, переведено не всё` });
      if (cb.words < 12 && ca.words > 30 && /\bNULL\s*;|RETURN\s+NULL\s*;|^\s*BEGIN\s+END/i.test(pgCode)) push(key, oname, { rule: 'stub', level: 'error', message: 'Похоже на заглушку: в PostgreSQL тело почти пустое' });
    }
  }
  // Функции PG без найденного оригинала — только проверка текста
  if (input.lintUnmatched !== false) {
    for (const [key, variants] of pg) {
      if (seenPg.has(key)) continue;
      if (input.scopePg && !input.scopePg.has(key)) continue;
      for (const v of variants) for (const f of lintPg(v, env)) push(key, '', f);
    }
  }
  if (input.scopePg) return findings.filter(f => input.scopePg.has(f.object));
  return findings;
}

// ---------- Загрузка из баз ----------
async function loadOracleSide(db, owner, routines) {
  // routines: [{ package, name }] — из метаданных (уже отфильтрованы)
  const pkgs = [...new Set(routines.filter(r => r.package).map(r => r.package))];
  const standalone = routines.filter(r => !r.package).map(r => r.name);
  const args = await db.query(`
    SELECT package_name AS pkg, object_name AS sub, NVL(overload, '0') AS ov, argument_name AS name, data_type AS type,
           in_out AS mode, position, data_level
    FROM all_arguments WHERE owner = :o AND data_level = 0
    ORDER BY package_name, object_name, overload, position`, { o: owner });
  const byKey = new Map();
  for (const a of args) {
    const k = `${a.pkg || ''}.${a.sub}`;
    if (!byKey.has(k)) byKey.set(k, new Map());
    const ovs = byKey.get(k);
    if (!ovs.has(a.ov)) ovs.set(a.ov, { args: [], returns: null });
    const ov = ovs.get(a.ov);
    if (Number(a.position) === 0) ov.returns = a.type; else if (a.type) ov.args.push({ name: a.name, type: a.type, mode: a.mode });
  }
  const src = await db.query(`
    SELECT name, type, text FROM all_source
    WHERE owner = :o AND type IN ('PACKAGE BODY','PROCEDURE','FUNCTION') ORDER BY name, type, line`, { o: owner });
  const texts = new Map();
  for (const r of src) texts.set(r.name, (texts.get(r.name) || '') + r.text);
  const res = [];
  const subsOf = new Map();
  for (const r of routines) if (r.package) { if (!subsOf.has(r.package)) subsOf.set(r.package, []); subsOf.get(r.package).push(r.name.split('.').pop()); }
  for (const p of pkgs) {
    const parts = splitPackageBody(cleanCode(texts.get(p) || ''), subsOf.get(p));
    for (const sub of subsOf.get(p)) {
      const ovs = byKey.get(`${p}.${sub}`);
      res.push({ package: p, name: sub, overloads: ovs ? [...ovs.values()] : [{ args: [], returns: null }], code: parts.get(sub.toUpperCase()) || '' });
    }
  }
  for (const n of standalone) {
    const ovs = byKey.get(`.${n}`);
    res.push({ package: null, name: n, overloads: ovs ? [...ovs.values()] : [{ args: [], returns: null }], code: cleanCode(texts.get(n) || '') });
  }
  return res;
}

async function loadPgSide(db, schemas) {
  const rows = await db.query(`
    SELECT n.nspname AS schema, p.proname AS name, p.prokind AS kind, l.lanname AS lang, p.prosrc AS src,
           pg_get_function_result(p.oid) AS returns,
           coalesce(p.proargnames, '{}') AS argnames, coalesce(p.proargmodes::text[], '{}') AS argmodes,
           ARRAY(SELECT format_type(t, NULL) FROM unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) t) AS argtypes
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname = ANY($1::text[]) AND l.lanname IN ('plpgsql','sql') AND p.prorettype <> 'trigger'::regtype
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`, [schemas]);
  const pg = new Map();
  for (const r of rows) {
    const k = `${lc(r.schema)}.${lc(r.name)}`;
    const types = r.argtypes || [];
    const args = types.map((t, i) => ({ name: (r.argnames || [])[i] || '', type: t, mode: (r.argmodes || [])[i] || 'i' }));
    if (!pg.has(k)) pg.set(k, []);
    pg.get(k).push({ kind: r.kind, lang: r.lang, returns: r.returns, args, code: cleanCode(r.src) });
  }
  const funcs = await db.query(`SELECT DISTINCT lower(proname) AS n FROM pg_proc`);
  const pgFuncs = new Set(funcs.map(x => x.n));
  // TRUNC для дат (orafce добавляет trunc(date) / trunc(timestamp))
  const td = await db.query(`SELECT 1 FROM pg_proc WHERE proname = 'trunc' AND pg_get_function_identity_arguments(oid) ~ '(date|timestamp)' LIMIT 1`);
  if (td.length) pgFuncs.add('__trunc_date');
  const dc = await db.query(`SELECT 1 FROM pg_proc WHERE proname = 'decode' AND pronargs > 2 LIMIT 1`);
  if (dc.length) pgFuncs.add('__decode_ora');
  const rels = await db.query(`SELECT DISTINCT lower(relname) AS n FROM pg_class WHERE relname = 'dual'`);
  const types = await db.query(`SELECT DISTINCT lower(typname) AS n FROM pg_type WHERE typname IN ('varchar2','nvarchar2','number','pls_integer','binary_integer')`);
  return { pg, pgFuncs, pgRels: new Set(rels.map(x => x.n)), pgTypes: new Set(types.map(x => x.n)) };
}

/** Для сравнения схем: A — метаданные Oracle, B — PostgreSQL. */
async function checkTranslation(src, tgt, A, B, p, ctx) {
  const routines = A.routines.map(r => (r.package ? { package: r.package, name: r.name } : { package: null, name: r.name }));
  const ora = await loadOracleSide(src, A.schema, routines);
  const schemas = [lc(B.schema), ...new Set(B.routines.filter(r => r.package).map(r => lc(r.package))), ...new Set(A.routines.filter(r => r.package).map(r => lc(r.package)))];
  const side = await loadPgSide(tgt, schemas);
  let scopePg = null;
  if (B.filtered) scopePg = new Set(B.routines.map(r => (r.package ? `${lc(r.package)}.${lc(r.name.split('.').pop())}` : `${lc(B.schema)}.${lc(r.name)}`)));
  const findings = analyzeTranslation({ targetSchema: B.schema, oracle: ora, ...side, scopePg, lintUnmatched: !A.filtered });
  if (ctx) ctx.log(`Проверка перевода: функций Oracle ${ora.length}, функций PostgreSQL ${side.pg.size}, находок ${findings.length}`, findings.length ? 'warning' : 'info');
  return { checked: ora.length, pgFunctions: side.pg.size, findings };
}

module.exports = { checkTranslation, analyzeTranslation, loadPgSide, loadOracleSide, cleanCode, splitPackageBody, dmlTargets, lintPg, argFamily, RULES };
