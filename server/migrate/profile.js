'use strict';
// Профиль данных: что реально лежит в колонках, и какой тип PostgreSQL (или Oracle) подходит.
// Главная цель — поймать скрытые ошибки миграции: дробные значения в «целых» колонках, время в DATE,
// символ \0 (PostgreSQL его не принимает), пустые строки ('' в Oracle = NULL), переполнение типов.
const { connect } = require('../db');
const { loadMeta } = require('../meta');
const { filterMeta } = require('../meta/objects');
const { getConnection, publicConnection } = require('../lib/store');
const { oracleToPgType, pgToOracleType } = require('../lib/typemap');

const INT4 = 2147483647n, INT8 = 9223372036854775807n;

// ---------- Агрегаты по колонкам ----------
function oracleAggs(db, c, i) {
  const q = db.quote(c.name);
  const t = String(c.dataType).toUpperCase();
  const a = [`COUNT(${q}) AS nn${i}`];
  if (t === 'NUMBER' || t === 'FLOAT' || t === 'INTEGER') {
    a.push(`MIN(${q}) AS mn${i}`, `MAX(${q}) AS mx${i}`,
      `SUM(CASE WHEN ${q} <> TRUNC(${q}) THEN 1 ELSE 0 END) AS fr${i}`,
      `MAX(CASE WHEN ${q} <> TRUNC(${q}) THEN LENGTH(TO_CHAR(ABS(${q} - TRUNC(${q})), 'TM9')) - 1 END) AS sc${i}`,
      `SUM(CASE WHEN ${q} NOT IN (0, 1) THEN 1 ELSE 0 END) AS nb${i}`);
  } else if (t === 'BINARY_FLOAT' || t === 'BINARY_DOUBLE') {
    a.push(`MIN(${q}) AS mn${i}`, `MAX(${q}) AS mx${i}`);
  } else if (t === 'DATE') {
    a.push(`TO_CHAR(MIN(${q}), 'SYYYY-MM-DD HH24:MI:SS') AS mn${i}`, `TO_CHAR(MAX(${q}), 'SYYYY-MM-DD HH24:MI:SS') AS mx${i}`,
      `SUM(CASE WHEN ${q} <> TRUNC(${q}) THEN 1 ELSE 0 END) AS tm${i}`);
  } else if (t.startsWith('TIMESTAMP')) {
    a.push(`TO_CHAR(MIN(${q}), 'SYYYY-MM-DD HH24:MI:SS') AS mn${i}`, `TO_CHAR(MAX(${q}), 'SYYYY-MM-DD HH24:MI:SS') AS mx${i}`,
      `SUM(CASE WHEN CAST(${q} AS DATE) <> TRUNC(CAST(${q} AS DATE)) THEN 1 ELSE 0 END) AS tm${i}`,
      `SUM(CASE WHEN EXTRACT(SECOND FROM ${q}) <> TRUNC(EXTRACT(SECOND FROM ${q})) THEN 1 ELSE 0 END) AS fs${i}`);
  } else if (['VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR', 'VARCHAR'].includes(t)) {
    a.push(`MAX(LENGTH(${q})) AS ml${i}`, `MAX(LENGTHB(${q})) AS mb${i}`,
      `SUM(CASE WHEN INSTR(${q}, CHR(0)) > 0 THEN 1 ELSE 0 END) AS z${i}`,
      `SUM(CASE WHEN TRIM(${q}) IS NULL THEN 1 ELSE 0 END) AS bl${i}`);
    if (!c.isChar) a.push(`SUM(CASE WHEN ${q} LIKE '% ' THEN 1 ELSE 0 END) AS tr${i}`);
  } else if (t === 'CLOB' || t === 'NCLOB') {
    a.push(`MAX(DBMS_LOB.GETLENGTH(${q})) AS ml${i}`, `SUM(CASE WHEN DBMS_LOB.INSTR(${q}, TO_CLOB(CHR(0))) > 0 THEN 1 ELSE 0 END) AS z${i}`);
  } else if (t === 'BLOB') {
    a.push(`MAX(DBMS_LOB.GETLENGTH(${q})) AS ml${i}`);
  } else if (t === 'LONG' || t === 'LONG RAW') {
    return [`0 AS nn${i}`]; // LONG нельзя агрегировать
  }
  return a;
}

function pgAggs(db, c, i) {
  const q = db.quote(c.name);
  const a = [`count(${q}) AS nn${i}`];
  if (c.isArray || c.family === 'other') return a;
  switch (c.family) {
    case 'int': a.push(`min(${q})::text AS mn${i}`, `max(${q})::text AS mx${i}`); break;
    case 'numeric': a.push(`min(${q})::text AS mn${i}`, `max(${q})::text AS mx${i}`,
      `count(*) FILTER (WHERE ${q} <> trunc(${q}::numeric)) AS fr${i}`, `max(scale(${q}::numeric)) AS sc${i}`); break;
    case 'float': a.push(`min(${q})::text AS mn${i}`, `max(${q})::text AS mx${i}`); break;
    case 'bool': a.push(`count(*) FILTER (WHERE ${q}) AS bt${i}`); break;
    case 'date': a.push(`min(${q})::text AS mn${i}`, `max(${q})::text AS mx${i}`); break;
    case 'datetime': case 'datetimetz':
      a.push(`min(${q})::text AS mn${i}`, `max(${q})::text AS mx${i}`,
        `count(*) FILTER (WHERE ${q}::time <> '00:00'::time) AS tm${i}`); break;
    case 'string': case 'text': case 'json': case 'xml':
      a.push(`max(length(${q}::text)) AS ml${i}`, `max(octet_length(${q}::text)) AS mb${i}`,
        `count(*) FILTER (WHERE ${q}::text = '') AS em${i}`, `count(*) FILTER (WHERE ${q}::text <> '' AND btrim(${q}::text) = '') AS bl${i}`); break;
    case 'binary': a.push(`max(octet_length(${q})) AS ml${i}`); break;
    default:
  }
  return a;
}

const n = v => (v == null ? null : Number(v));
function bigAbs(s) { try { const x = BigInt(String(s).split('.')[0]); return x < 0n ? -x : x; } catch { return null; } }

// ---------- Рекомендации ----------
function recommendFromOracle(c, st) {
  const notes = [];
  let level = 'ok';
  const bump = l => { const o = { ok: 0, info: 1, warning: 2, error: 3 }; if (o[l] > o[level]) level = l; };
  const def = oracleToPgType(c);
  let rec = def;
  const t = String(c.dataType).toUpperCase();
  if (st.nn === 0) { notes.push('Колонка пустая (все значения NULL)'); bump('info'); }
  if (t === 'NUMBER' || t === 'INTEGER' || t === 'FLOAT') {
    if (st.nn > 0 && st.fr > 0) {
      if (c.scale === 0) { notes.push(`Дробных значений: ${st.fr} — при переносе в целый тип они округлятся`); bump('error'); }
      rec = c.precision != null && c.scale ? def : 'numeric';
      notes.push(`Знаков после запятой до ${st.sc ?? '?'}`);
    } else if (st.nn > 0) {
      const mx = [st.mn, st.mx].map(bigAbs).filter(x => x != null).reduce((a, b) => (a > b ? a : b), 0n);
      const fit = mx <= INT4 ? 'integer' : mx <= INT8 ? 'bigint' : 'numeric';
      if (c.precision == null) {
        rec = fit;
        notes.push(`${c.type} без точности, но все значения целые (до ${mx}) — ${fit} быстрее и компактнее numeric`);
        bump('info');
      } else if (def === 'smallint' && mx > 32767n) rec = 'integer';
      if (st.nb === 0 && st.nn > 0 && (c.precision === 1 || c.precision == null) && c.scale === 0) {
        notes.push('Только значения 0 и 1 — можно boolean, если в коде нет арифметики с этим полем');
        bump('info');
      }
    }
  } else if (t === 'DATE') {
    if (st.nn > 0 && st.tm === 0) { notes.push('Время везде 00:00:00 — можно date вместо timestamp(0)'); bump('info'); rec = 'date'; }
    else if (st.tm > 0) notes.push(`Значений со временем: ${st.tm} — нужен timestamp(0), date потеряет время`);
  } else if (t.startsWith('TIMESTAMP')) {
    if (st.nn > 0 && st.fs === 0 && st.tm === 0) notes.push('Время и доли секунды не используются');
  } else if (['VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR', 'VARCHAR'].includes(t)) {
    if (st.z > 0) { notes.push(`Символ \\0 в ${st.z} значениях — PostgreSQL его не принимает, данные нужно очистить`); bump('error'); }
    if (c.isChar) { notes.push('CHAR: в PostgreSQL хвостовые пробелы игнорируются при сравнении, но учитываются в length() и LIKE — обычно лучше varchar'); bump('info'); rec = `varchar(${c.length})`; }
    if (st.tr > 0) notes.push(`Хвостовых пробелов: ${st.tr}`);
    if (st.bl > 0) { notes.push(`Значений из одних пробелов: ${st.bl}`); }
    if (st.mb > st.ml && /BYTE/.test(c.type)) notes.push(`Многобайтовые символы: до ${st.ml} симв. / ${st.mb} байт (в PostgreSQL длина в символах — ок)`);
  } else if (t === 'CLOB' || t === 'NCLOB') {
    if (st.z > 0) { notes.push(`Символ \\0 в ${st.z} значениях — PostgreSQL его не примет`); bump('error'); }
    if (st.ml != null && st.ml <= 4000 && st.nn > 0) { notes.push(`Максимальная длина ${st.ml} — можно varchar(${st.ml}) или оставить text`); }
  } else if (t === 'BLOB') {
    if (st.ml != null && st.ml > 1073741823) { notes.push('Значения больше 1 ГБ — bytea не подойдёт, нужны large objects'); bump('error'); }
  } else if (t === 'LONG' || t === 'LONG RAW') {
    notes.push('LONG устарел: перед миграцией лучше перевести в CLOB/BLOB (ALTER TABLE … MODIFY)'); bump('warning');
  }
  return { defaultType: def, recommended: rec, level, notes };
}

function recommendFromPg(c, st) {
  const notes = [];
  let level = 'ok';
  const bump = l => { const o = { ok: 0, info: 1, warning: 2, error: 3 }; if (o[l] > o[level]) level = l; };
  const def = pgToOracleType(c);
  let rec = def;
  if (st.nn === 0) { notes.push('Колонка пустая'); bump('info'); }
  if (st.em > 0) { notes.push(`Пустых строк '': ${st.em} — в Oracle они станут NULL (проверьте NOT NULL и условия = '')`); bump('warning'); }
  if ((c.udt === 'text' || (c.udt === 'varchar' && !c.length)) && st.mb != null) {
    if (st.mb <= 4000) { rec = `VARCHAR2(${Math.max(st.ml || 1, 1)} CHAR)`; notes.push(`Максимум ${st.ml} симв. — можно VARCHAR2 вместо CLOB`); bump('info'); }
  }
  if (c.udt === 'varchar' && c.length > 4000) { notes.push('Длина > 4000 — в Oracle (без MAX_STRING_SIZE=EXTENDED) только CLOB'); bump('info'); }
  if (c.family === 'numeric' && c.precision == null && st.fr === 0 && st.nn > 0) { rec = 'NUMBER(19)'; notes.push('numeric без точности, но значения целые'); bump('info'); }
  return { defaultType: def, recommended: rec, level, notes };
}

// ---------- Проверка фактического типа в приёмнике ----------
function checkTarget(c, st, tc, srcType) {
  const issues = [];
  if (!tc) return { issues: ['Колонки нет в приёмнике'], level: 'warning' };
  let level = 'ok';
  const bump = l => { const o = { ok: 0, info: 1, warning: 2, error: 3 }; if (o[l] > o[level]) level = l; };
  if (st.nn === 0) return { issues, level };
  if (tc.family === 'int' && st.fr > 0) { issues.push(`В приёмнике ${tc.type}, а в данных есть дробные значения`); bump('error'); }
  if (tc.family === 'int' && st.mx != null) {
    const mx = [st.mn, st.mx].map(bigAbs).filter(x => x != null).reduce((a, b) => (a > b ? a : b), 0n);
    const cap = { int2: 32767n, int4: INT4, int8: INT8 }[tc.udt];
    const ocap = tc.precision != null ? 10n ** BigInt(tc.precision - (tc.scale || 0)) - 1n : null;
    const lim = cap ?? ocap;
    if (lim != null && mx > lim) { issues.push(`Значение ${mx} не помещается в ${tc.type}`); bump('error'); }
  }
  if (tc.family === 'numeric' && tc.scale != null && st.sc != null && st.sc > tc.scale) { issues.push(`В данных до ${st.sc} знаков после запятой, а в ${tc.type} — ${tc.scale}: округление`); bump('error'); }
  if (tc.udt === 'date' && st.tm > 0) { issues.push(`В приёмнике date, а ${st.tm} значений содержат время — оно потеряется`); bump('error'); }
  if (tc.family === 'string' && tc.length != null && st.ml != null && st.ml > tc.length) { issues.push(`Максимальная длина ${st.ml} больше ${tc.type}`); bump('error'); }
  if (tc.family === 'string' && tc.length != null && st.mb != null && srcType === 'postgres' && /BYTE/.test(tc.type) && st.mb > tc.length) { issues.push(`До ${st.mb} байт — не помещается в ${tc.type}`); bump('error'); }
  if ((tc.family === 'string' || tc.family === 'text') && srcType === 'oracle' && st.z > 0) { issues.push('Символ \\0 — загрузка в PostgreSQL упадёт'); bump('error'); }
  return { issues, level };
}

async function runProfile(p, ctx) {
  const srcConn = getConnection(p.sourceId);
  const K = x => String(x).toLowerCase();
  const sample = Number(p.samplePercent) || 0;
  const src = await connect(srcConn);
  let tgt = null, B = null;
  const rows = [];
  try {
    ctx.progress(0, 0, 'Чтение структуры…');
    let A = await loadMeta(src, p.sourceSchema, {}, null);
    if (p.tables && p.tables.length) A = filterMeta(A, p.tables.map(name => ({ type: 'table', name })), K);
    if (p.targetId) {
      tgt = await connect(getConnection(p.targetId));
      B = await loadMeta(tgt, p.targetSchema, {}, null);
    }
    const mapB = B ? new Map(B.tables.map(t => [K(t.name), t])) : null;
    let i = 0;
    for (const t of A.tables) {
      ctx.checkCancel();
      ctx.progress(i++, A.tables.length, `${t.name}…`);
      const tb = mapB && mapB.get(K(t.name));
      // Колонки порциями: у Oracle лимит 1000 выражений в SELECT
      const stats = new Map();
      let total = null;
      for (let from = 0; from < t.columns.length; from += 100) {
        const part = t.columns.slice(from, from + 100);
        const exprs = part.flatMap((c, j) => (src.type === 'oracle' ? oracleAggs(src, c, from + j) : pgAggs(src, c, from + j)));
        const tbl = src.qualify(p.sourceSchema, t.name)
          + (sample > 0 && sample < 100 ? (src.type === 'oracle' ? ` SAMPLE (${sample})` : ` TABLESAMPLE SYSTEM (${sample})`) : '');
        const where = p.where && p.where[t.name] ? ` WHERE ${p.where[t.name]}` : '';
        let r;
        try { r = (await src.query(`SELECT COUNT(*) AS total, ${exprs.join(', ')} FROM ${tbl}${where}`))[0]; }
        catch (e) { ctx.log(`${t.name}: ${e.message}`, 'error'); rows.push({ table: t.name, column: '*', level: 'error', notes: [e.message] }); break; }
        total = n(r.total);
        part.forEach((c, j) => {
          const k = from + j;
          stats.set(c.name, {
            nn: n(r['nn' + k]), mn: r['mn' + k] ?? null, mx: r['mx' + k] ?? null, fr: n(r['fr' + k]), sc: n(r['sc' + k]),
            nb: n(r['nb' + k]), tm: n(r['tm' + k]), fs: n(r['fs' + k]), ml: n(r['ml' + k]), mb: n(r['mb' + k]),
            z: n(r['z' + k]), bl: n(r['bl' + k]), tr: n(r['tr' + k]), em: n(r['em' + k]), bt: n(r['bt' + k]),
          });
        });
      }
      for (const c of t.columns) {
        const st = stats.get(c.name);
        if (!st) continue;
        const rec = src.type === 'oracle' ? recommendFromOracle(c, st) : recommendFromPg(c, st);
        let target = null;
        if (tb) {
          const tc = tb.columns.find(x => K(x.name) === K(c.name));
          target = { type: tc ? tc.type : null, ...checkTarget(c, st, tc, src.type) };
        }
        const level = target && { error: 3, warning: 2 }[target.level] > ({ error: 3, warning: 2, info: 1, ok: 0 }[rec.level]) ? target.level : rec.level;
        rows.push({
          table: t.name, column: c.name, sourceType: c.type, rows: total, nonNull: st.nn,
          min: st.mn, max: st.mx, maxLength: st.ml, maxBytes: st.mb, fractional: st.fr, maxScale: st.sc, withTime: st.tm,
          defaultType: rec.defaultType, recommended: rec.recommended, targetType: target ? target.type : null,
          level, notes: [...rec.notes, ...(target ? target.issues : [])],
        });
      }
    }
  } finally {
    await src.close();
    if (tgt) await tgt.close();
  }
  const summary = rows.reduce((s, r) => (s[r.level] = (s[r.level] || 0) + 1, s), { columns: rows.length, tables: new Set(rows.map(r => r.table)).size, sample: sample || 100 });
  return { summary, source: { ...publicConnection(srcConn), schema: p.sourceSchema }, rows };
}

module.exports = { runProfile, recommendFromOracle, recommendFromPg, checkTarget };
