'use strict';
// Сканер кода приложения: что придётся поменять при переходе с Oracle на PostgreSQL.
//  • SQL внутри строк кода (JS/TS/Vue/Java/C#/Python) и в .sql-файлах: NVL, DECODE, ROWNUM, (+), CONNECT BY, seq.NEXTVAL, :binds…
//  • вызовы драйвера node-oracledb: execute/executeMany, OUT-бинды, autoCommit, имена колонок ЗАГЛАВНЫМИ и т. д.
//  • вызовы пакетов Oracle «пакет.процедура» → «пакет_процедура» (именование plsql2pg), если указана база Oracle.
const fs = require('fs');
const path = require('path');

const SQL_RULES = [
  { id: 'nvl', re: /\bNVL\s*\(/gi, sev: 'error', title: 'NVL', hint: 'COALESCE(a, b)', fix: () => 'COALESCE(' },
  { id: 'nvl2', re: /\bNVL2\s*\(/gi, sev: 'error', title: 'NVL2', hint: 'CASE WHEN x IS NOT NULL THEN a ELSE b END' },
  { id: 'decode', re: /\bDECODE\s*\(/gi, sev: 'error', title: 'DECODE', hint: 'CASE x WHEN v1 THEN r1 … ELSE r END (с orafce есть decode)' },
  { id: 'sysdate', re: /\bSYSDATE\b/gi, sev: 'error', title: 'SYSDATE', hint: 'LOCALTIMESTAMP(0) или now(); CURRENT_DATE — если нужна только дата', fix: () => 'LOCALTIMESTAMP(0)' },
  { id: 'systimestamp', re: /\bSYSTIMESTAMP\b/gi, sev: 'error', title: 'SYSTIMESTAMP', hint: 'clock_timestamp() или now()', fix: () => 'clock_timestamp()' },
  { id: 'date-arith', re: /\b(?:SYSDATE|TRUNC\s*\([^)]*\))\s*[-+]\s*\d+(\.\d+)?\b/gi, sev: 'warning', title: 'Дата ± число', hint: "В PostgreSQL: timestamp ± INTERVAL '1 day' (date ± целое работает только для типа date)" },
  { id: 'rownum', re: /\bROWNUM\b/gi, sev: 'error', title: 'ROWNUM', hint: 'LIMIT n / FETCH FIRST n ROWS ONLY; для нумерации — row_number() OVER ()' },
  { id: 'dual', re: /\bFROM\s+DUAL\b/gi, sev: 'warning', title: 'FROM DUAL', hint: 'В PostgreSQL FROM не обязателен: SELECT 1', fix: () => '' },
  { id: 'outer-join', re: /\(\s*\+\s*\)/g, sev: 'error', title: 'Внешнее соединение (+)', hint: 'LEFT/RIGHT JOIN … ON …' },
  { id: 'connect-by', re: /\bCONNECT\s+BY\b/gi, sev: 'error', title: 'CONNECT BY', hint: 'WITH RECURSIVE …' },
  { id: 'nextval', re: /\b([\w$#]+(?:\.[\w$#]+)?)\.NEXTVAL\b/gi, sev: 'error', title: 'seq.NEXTVAL', hint: "nextval('seq')", fix: m => `nextval('${m[1].toLowerCase()}')` },
  { id: 'currval', re: /\b([\w$#]+(?:\.[\w$#]+)?)\.CURRVAL\b/gi, sev: 'error', title: 'seq.CURRVAL', hint: "currval('seq')", fix: m => `currval('${m[1].toLowerCase()}')` },
  { id: 'to-date', re: /\bTO_DATE\s*\(/gi, sev: 'warning', title: 'TO_DATE', hint: 'В PostgreSQL to_date возвращает date без времени; если нужно время — to_timestamp(…). Проверьте форматы (HH24, MI, SS совпадают; RR, SSSSS — нет)' },
  { id: 'trunc', re: /\bTRUNC\s*\(/gi, sev: 'info', title: 'TRUNC', hint: "Для дат: date_trunc('day', x) или x::date; для чисел trunc() работает" },
  { id: 'add-months', re: /\bADD_MONTHS\s*\(/gi, sev: 'error', title: 'ADD_MONTHS', hint: "x + INTERVAL 'n month' (или make_interval(months => n))" },
  { id: 'months-between', re: /\bMONTHS_BETWEEN\s*\(/gi, sev: 'error', title: 'MONTHS_BETWEEN', hint: 'extract(year from age(a,b))*12 + extract(month from age(a,b)) — дробная часть считается иначе' },
  { id: 'last-day', re: /\bLAST_DAY\s*\(/gi, sev: 'error', title: 'LAST_DAY', hint: "(date_trunc('month', d) + INTERVAL '1 month - 1 day')::date" },
  { id: 'instr', re: /\bINSTR\s*\(/gi, sev: 'warning', title: 'INSTR', hint: 'strpos(str, sub) / position(sub in str); вариантов с 3–4 аргументами нет (orafce: instr)' },
  { id: 'minus', re: /\bMINUS\b/gi, sev: 'error', title: 'MINUS', hint: 'EXCEPT', fix: () => 'EXCEPT' },
  { id: 'merge', re: /\bMERGE\s+INTO\b/gi, sev: 'warning', title: 'MERGE', hint: 'INSERT … ON CONFLICT (…) DO UPDATE, либо MERGE (PostgreSQL 15+, синтаксис отличается)' },
  { id: 'listagg', re: /\bLISTAGG\s*\(/gi, sev: 'error', title: 'LISTAGG', hint: "string_agg(x, ',' ORDER BY …)" },
  { id: 'wm-concat', re: /\bWM_CONCAT\s*\(/gi, sev: 'error', title: 'WM_CONCAT', hint: "string_agg(x, ',')" },
  { id: 'regexp-like', re: /\bREGEXP_LIKE\s*\(/gi, sev: 'error', title: 'REGEXP_LIKE', hint: "str ~ 'шаблон' (без учёта регистра: ~*)" },
  { id: 'rowid', re: /\bROWID\b/gi, sev: 'error', title: 'ROWID', hint: 'Используйте первичный ключ; ctid в PostgreSQL меняется при обновлении строки' },
  { id: 'empty-string', re: /(=|<>|!=)\s*''/g, sev: 'warning', title: "Сравнение с ''", hint: "В Oracle '' = NULL, поэтому col = '' там никогда не истинно. В PostgreSQL '' и NULL различаются — проверьте логику (IS NULL / coalesce(col,'') = '')" },
  { id: 'concat-null', re: /\|\|/g, sev: 'info', title: 'Конкатенация ||', hint: "В PostgreSQL NULL || 'x' = NULL (в Oracle — 'x'). Если части могут быть NULL — concat(a, b)", once: true },
  { id: 'sys-guid', re: /\bSYS_GUID\s*\(\s*\)/gi, sev: 'error', title: 'SYS_GUID()', hint: 'gen_random_uuid()', fix: () => 'gen_random_uuid()' },
  { id: 'hint', re: /\/\*\+/g, sev: 'info', title: 'Хинт оптимизатора /*+ */', hint: 'PostgreSQL игнорирует хинты (есть расширение pg_hint_plan)' },
  { id: 'bitand', re: /\bBITAND\s*\(/gi, sev: 'error', title: 'BITAND', hint: 'a & b' },
  { id: 'dbms', re: /\b(DBMS|UTL)_\w+/gi, sev: 'error', title: 'Пакеты DBMS_/UTL_', hint: 'Встроенных пакетов Oracle в PostgreSQL нет — нужен аналог (orafce частично) или переписывание' },
  { id: 'table-func', re: /\bTABLE\s*\(\s*(?!$)/gi, sev: 'warning', title: 'TABLE(коллекция)', hint: 'unnest(массив) или функция, возвращающая SETOF/TABLE' },
  { id: 'returning-into', re: /\bRETURNING\b[^;'"`]*?\bINTO\b/gi, sev: 'error', title: 'RETURNING … INTO', hint: 'В PostgreSQL RETURNING возвращает строки результата: const { rows } = await client.query("… RETURNING id")' },
  { id: 'plsql-block', re: /\bBEGIN\b[\s\S]{0,2000}?\bEND\s*;/gi, sev: 'error', title: 'Анонимный блок BEGIN … END', hint: 'Вызов процедуры: CALL proc($1, $2); функции: SELECT func($1); произвольный код — DO $$ … $$ (без параметров)' },
  { id: 'number-types', re: /\b(VARCHAR2|NUMBER|NVARCHAR2|CLOB|BLOB)\b/g, sev: 'info', title: 'Типы Oracle в SQL', hint: 'varchar / numeric / text / bytea' },
  { id: 'user', re: /(?<![.\w])USER(?![\w(])/g, sev: 'info', title: 'USER', hint: 'current_user (в нижнем регистре; в Oracle — заглавными)' },
];

const BIND_RE = /(^|[^:\w$])(:)([A-Za-z_][\w$#]*|\d+)\b/g;

const CODE_RULES = [
  { id: 'require-oracledb', raw: true, re: /require\(\s*['"]oracledb['"]\s*\)|from\s+['"]oracledb['"]/g, sev: 'error', title: 'Драйвер oracledb', hint: "const { Pool } = require('pg') — пул: new Pool({ host, port, database, user, password })" },
  { id: 'get-connection', re: /\b(?:oracledb\.)?(getConnection|createPool|getPool)\s*\(/g, sev: 'warning', title: 'Подключение/пул oracledb', hint: 'pg: const pool = new Pool(cfg); const client = await pool.connect(); … client.release()' },
  { id: 'execute', re: /\.execute\s*\(/g, sev: 'warning', title: 'connection.execute()', hint: 'pg: client.query(sql, [параметры]) → { rows, rowCount, fields }' },
  { id: 'execute-many', re: /\.executeMany\s*\(/g, sev: 'error', title: 'executeMany()', hint: 'pg: многострочный INSERT … VALUES (…),(…), INSERT … SELECT * FROM unnest($1::int[], …) или COPY (pg-copy-streams)' },
  { id: 'out-binds', re: /\b(BIND_OUT|BIND_INOUT|outBinds)\b/g, sev: 'error', title: 'OUT-параметры', hint: 'pg: функция возвращает значения (SELECT * FROM f($1)) или RETURNING; у процедур — INOUT-параметры в CALL' },
  { id: 'auto-commit', re: /\bautoCommit\b/g, sev: 'warning', title: 'autoCommit', hint: 'pg: каждый запрос фиксируется сам; для транзакции — BEGIN … COMMIT на одном client' },
  { id: 'commit', re: /\.(commit|rollback)\s*\(\s*\)/g, sev: 'warning', title: 'commit()/rollback()', hint: "pg: await client.query('COMMIT') / 'ROLLBACK'" },
  { id: 'out-format', re: /\b(outFormat|OUT_FORMAT_OBJECT|OUT_FORMAT_ARRAY|OBJECT_FORMAT)\b/g, sev: 'info', title: 'outFormat', hint: "pg: строки — объекты по умолчанию; массивы — { rowMode: 'array' }" },
  { id: 'rows-affected', re: /\browsAffected\b/g, sev: 'error', title: 'rowsAffected', hint: 'pg: result.rowCount' },
  { id: 'meta-data', re: /\bmetaData\b/g, sev: 'warning', title: 'metaData', hint: 'pg: result.fields' },
  { id: 'last-rowid', re: /\blastRowid\b/g, sev: 'error', title: 'lastRowid', hint: 'pg: INSERT … RETURNING id' },
  { id: 'result-set', re: /\b(resultSet|getRows|queryStream)\b/g, sev: 'warning', title: 'resultSet/queryStream', hint: 'pg: pg-cursor или pg-query-stream' },
  { id: 'lob', re: /\b(fetchAsString|fetchAsBuffer|fetchInfo|fetchTypeHandler|oracledb\.(CLOB|BLOB|NCLOB|DB_TYPE_\w+)|getData\s*\()/g, sev: 'info', title: 'Типы/LOB oracledb', hint: 'pg: text и bytea приходят строкой/Buffer; numeric и bigint — строкой (types.setTypeParser для чисел)' },
  { id: 'cursor', re: /\boracledb\.CURSOR\b/g, sev: 'error', title: 'REF CURSOR', hint: "pg: функция RETURNS TABLE/SETOF, или refcursor + FETCH ALL FROM \"<cursor>\" в той же транзакции" },
  { id: 'upper-cols', re: /\b(?:row|r|rec|record|item|data|res|result|x|e)\??\.([A-Z][A-Z0-9_]{1,})\b/g, sev: 'warning', title: 'Колонка ЗАГЛАВНЫМИ', hint: 'Oracle возвращает имена колонок заглавными (ROW.NAME), PostgreSQL — строчными (row.name). Либо переименуйте в коде, либо AS "NAME" в запросе' },
  { id: 'upper-destructure', re: /\{\s*[A-Z][A-Z0-9_]{1,}(?:\s*[:,]\s*\w*\s*,?\s*[A-Z][A-Z0-9_]{1,})*\s*\}\s*=\s*(?:row|r|rec|item|rows?\[)/g, sev: 'warning', title: 'Деструктуризация ЗАГЛАВНЫМИ', hint: 'В pg имена колонок строчными: const { id, name } = row' },
];

const EXT = {
  js: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', jsx: 'js', vue: 'vue',
  java: 'js', cs: 'js', py: 'py', kt: 'js', go: 'js', php: 'js',
  sql: 'sql', pls: 'sql', pkb: 'sql', pks: 'sql', prc: 'sql', fnc: 'sql', trg: 'sql', xml: 'xml',
};
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.nuxt', '.next', 'vendor', 'target', 'bin', 'obj', '.idea', '.vscode', '__pycache__']);

// ---------- Извлечение строковых литералов из кода ----------
function extractStrings(text, lang) {
  const out = []; // {start, text}
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i], nx = text[i + 1];
    if (ch === '/' && nx === '/' && lang !== 'py') { while (i < n && text[i] !== '\n') i++; continue; }
    if (ch === '#' && lang === 'py') { while (i < n && text[i] !== '\n') i++; continue; }
    if (ch === '/' && nx === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      // тройные кавычки Python / text blocks Java
      const triple = (lang === 'py' || lang === 'js') && text.substr(i, 3) === q.repeat(3) && q !== '`';
      const start = i + (triple ? 3 : 1);
      let j = start, buf = '', segStart = start;
      while (j < n) {
        if (text[j] === '\\') { buf += text[j + 1] === 'n' ? '\n' : text[j + 1] || ''; j += 2; continue; }
        if (triple ? text.substr(j, 3) === q.repeat(3) : text[j] === q) break;
        if (!triple && q !== '`' && text[j] === '\n') break; // незакрытая строка
        if (q === '`' && text[j] === '$' && text[j + 1] === '{') {
          // ${выражение} внутри шаблонной строки: заменяем на плейсхолдер
          let depth = 1, k = j + 2;
          while (k < n && depth) { if (text[k] === '{') depth++; else if (text[k] === '}') depth--; k++; }
          buf += ' ?expr? '; j = k; continue;
        }
        buf += text[j]; j++;
      }
      out.push({ start: segStart, text: buf, raw: text.slice(segStart, j) });
      i = j + (triple ? 3 : 1);
      continue;
    }
    i++;
  }
  return out;
}

// Код без строк и комментариев (для правил драйвера); длина сохраняется — номера строк совпадают
function blankStrings(text, lang) {
  const arr = text.split('');
  for (const s of extractStrings(text, lang)) for (let k = s.start; k < s.start + s.raw.length; k++) if (arr[k] !== '\n') arr[k] = ' ';
  return arr.join('').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
}

const looksLikeSql = s => s.length > 6 && /\b(SELECT\s|INSERT\s+INTO|UPDATE\s+[\w."]+\s+SET|DELETE\s+FROM|MERGE\s+INTO|BEGIN\b|CALL\s|FROM\s+[\w."]+|WHERE\s|CREATE\s+(OR\s+REPLACE\s+)?(TABLE|VIEW|PROCEDURE|FUNCTION|PACKAGE))/i.test(s);

function lineOf(text, idx) {
  let line = 1, last = 0;
  for (let k = 0; k < idx && k < text.length; k++) if (text.charCodeAt(k) === 10) { line++; last = k + 1; }
  return { line, col: idx - last + 1 };
}

function scanSql(sql, baseIdx, fileText, add, ctxInfo) {
  const seenOnce = new Set();
  // убираем строковые литералы SQL и комментарии, чтобы не ловить слова внутри '…'
  const clean = sql.replace(/--[^\n]*/g, m => ' '.repeat(m.length)).replace(/\/\*(?!\+)[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/'(?:[^']|'')*'/g, m => (m === "''" ? m : "'" + ' '.repeat(m.length - 2) + "'"));
  for (const r of SQL_RULES) {
    r.re.lastIndex = 0;
    let m;
    while ((m = r.re.exec(clean))) {
      if (r.once && seenOnce.has(r.id)) break;
      seenOnce.add(r.id);
      add(r, baseIdx + m.index, m[0], r.fix ? r.fix(m) : null);
      if (m[0].length === 0) r.re.lastIndex++;
    }
  }
  // Параметры :name / :1 → $1
  BIND_RE.lastIndex = 0;
  const binds = [];
  let m;
  while ((m = BIND_RE.exec(clean))) {
    if (clean[m.index + m[1].length + 1] === '=') continue; // :=
    binds.push({ idx: m.index + m[1].length, name: m[3] });
  }
  if (binds.length) {
    const order = [...new Set(binds.map(b => b.name))];
    add({ id: 'binds', sev: 'error', title: `Параметры :${binds[0].name}${binds.length > 1 ? ' …' : ''}`, hint: `node-postgres использует $1, $2… по позиции: ${order.map((nm, i) => `:${nm} → $${i + 1}`).join(', ')}. Объект параметров { name: … } замените массивом [${order.join(', ')}]` },
      baseIdx + binds[0].idx, binds.map(b => ':' + b.name).join(' '), null);
  }
  // Вызовы пакетов Oracle (если известны имена пакетов)
  if (ctxInfo.packages && ctxInfo.packages.size) {
    const re = /\b([A-Za-z_][\w$#]*)\.([A-Za-z_][\w$#]*)\s*\(/g;
    while ((m = re.exec(clean))) {
      if (!ctxInfo.packages.has(m[1].toUpperCase())) continue;
      add({ id: 'package-call', sev: 'error', title: 'Вызов процедуры пакета', hint: `plsql2pg называет подпрограммы пакетов «пакет_процедура»: ${m[1]}.${m[2]}(…) → ${(m[1] + '_' + m[2]).toLowerCase()}(…)${ctxInfo.packageNaming === 'schema' ? ' (или пакет.процедура при PACKAGE_AS_SCHEMA)' : ''}` },
        baseIdx + m.index, m[0], `${(m[1] + '_' + m[2]).toLowerCase()}(`);
    }
  }
}

function scanFile(file, rel, ctxInfo) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const lang = EXT[ext];
  if (!lang) return [];
  let text = fs.readFileSync(file, 'utf8');
  if (text.includes('�') && /[\x80-\xff]/.test(fs.readFileSync(file, 'latin1'))) {
    try { text = new TextDecoder('windows-1251').decode(fs.readFileSync(file)); } catch { /* */ }
  }
  const findings = [];
  const lines = text.split('\n');
  const add = (r, idx, match, fixed) => {
    const { line, col } = lineOf(text, idx);
    const src = lines[line - 1] || '';
    findings.push({
      file: rel, line, col, rule: r.id, severity: r.sev, title: r.title, hint: r.hint, match: String(match).slice(0, 120),
      snippet: src.trim().slice(0, 240),
      fixed: fixed != null ? src.replace(match, fixed).trim().slice(0, 240) : null,
    });
  };
  if (lang === 'sql') {
    scanSql(text, 0, text, add, ctxInfo);
    return findings;
  }
  let code = text, offset = 0;
  const parts = [];
  if (lang === 'vue') {
    const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(text))) parts.push({ code: m[1], offset: m.index + m[0].indexOf(m[1]) });
  } else if (lang === 'xml') {
    // MyBatis/Hibernate: SQL прямо в тексте тегов
    const re = /<(select|insert|update|delete|sql|query|sql-query|named-native-query)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let m;
    while ((m = re.exec(text))) scanSql(m[2].replace(/<!\[CDATA\[|\]\]>/g, s => ' '.repeat(s.length)), m.index + m[0].indexOf(m[2]), text, add, ctxInfo);
    return findings;
  } else parts.push({ code, offset });
  for (const part of parts) {
    const jsLang = lang === 'py' ? 'py' : 'js';
    for (const s of extractStrings(part.code, jsLang)) {
      if (looksLikeSql(s.text)) scanSql(s.raw, part.offset + s.start, text, add, ctxInfo);
    }
    if (lang === 'js' || lang === 'vue') {
      const blank = blankStrings(part.code, jsLang);
      if (/oracledb/.test(part.code) || /\.execute\s*\(/.test(blank) || ctxInfo.alwaysDriver) {
        for (const r of CODE_RULES) {
          r.re.lastIndex = 0;
          let m;
          const src = r.raw ? part.code : blank;
          while ((m = r.re.exec(src))) add(r, part.offset + m.index, m[0], null);
        }
      }
    }
  }
  return findings;
}

function walk(root, ctx, out = [], base = root) {
  const st = fs.statSync(root);
  if (st.isFile()) { out.push({ file: root, rel: path.basename(root) }); return out; }
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.') { if (SKIP_DIRS.has(e.name)) continue; }
    const fp = path.join(root, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(fp, ctx, out, base); }
    else if (EXT[path.extname(e.name).slice(1).toLowerCase()]) {
      const size = fs.statSync(fp).size;
      if (size < 3 * 1024 * 1024 && !/\.min\.js$/.test(e.name)) out.push({ file: fp, rel: path.relative(base, fp) });
    }
  }
  return out;
}

async function runCodeScan(p, ctx) {
  const root = String(p.path || '').trim().replace(/^"|"$/g, '');
  if (!root || !fs.existsSync(root)) throw new Error(`Папка или файл не найдены: ${root}`);
  const ctxInfo = { packages: null, packageNaming: p.packageNaming || 'underscore', alwaysDriver: !!p.alwaysDriver };
  if (p.sourceId && p.sourceSchema) {
    const { withDb } = require('../db');
    try {
      const pk = await withDb(p.sourceId, db => (db.type === 'oracle'
        ? db.query(`SELECT object_name AS name FROM all_objects WHERE owner = :o AND object_type = 'PACKAGE'`, { o: p.sourceSchema })
        : db.query(`SELECT nspname AS name FROM pg_namespace`)));
      ctxInfo.packages = new Set(pk.map(x => String(x.name).toUpperCase()));
      ctx.log(`Пакетов Oracle для поиска вызовов: ${ctxInfo.packages.size}`);
    } catch (e) { ctx.log(`Не удалось получить список пакетов: ${e.message}`, 'warning'); }
  }
  const files = walk(root, ctx);
  ctx.log(`Файлов для проверки: ${files.length}`);
  const findings = [];
  let i = 0;
  for (const f of files) {
    if (i % 50 === 0) { ctx.checkCancel(); ctx.progress(i, files.length, f.rel); }
    i++;
    try { findings.push(...scanFile(f.file, f.rel, ctxInfo)); }
    catch (e) { ctx.log(`${f.rel}: ${e.message}`, 'warning'); }
  }
  const byRule = {};
  for (const f of findings) {
    const r = byRule[f.rule] || (byRule[f.rule] = { rule: f.rule, title: f.title, severity: f.severity, hint: f.hint, count: 0, files: new Set() });
    r.count++; r.files.add(f.file);
  }
  const rules = Object.values(byRule).map(r => ({ ...r, files: r.files.size })).sort((a, b) => ({ error: 0, warning: 1, info: 2 }[a.severity] - { error: 0, warning: 1, info: 2 }[b.severity]) || b.count - a.count);
  const filesWith = new Set(findings.filter(f => f.severity !== 'info').map(f => f.file)).size;
  return {
    summary: { files: files.length, filesWithIssues: filesWith, findings: findings.length,
      error: findings.filter(f => f.severity === 'error').length, warning: findings.filter(f => f.severity === 'warning').length, info: findings.filter(f => f.severity === 'info').length },
    root, rules, findings: findings.slice(0, 20000),
  };
}

module.exports = { runCodeScan, scanFile, extractStrings };
