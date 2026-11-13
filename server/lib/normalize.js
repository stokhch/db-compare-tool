'use strict';
// Приведение значений Oracle и PostgreSQL к единому каноническому виду,
// чтобы сравнивать их напрямую (идея как в pgCompare/reladiff: нормализация перед сравнением).
const crypto = require('crypto');
const { GROUP } = require('./typemap');

// ---------- SQL-выражения для выборки колонки ----------
// Дата/время выбираются строками в фиксированном формате — без потерь микросекунд и без влияния часового пояса клиента.
function selectExpr(db, col) {
  const q = db.quote(col.name);
  if (db.type === 'oracle') {
    const t = String(col.dataType).toUpperCase();
    if (t === 'DATE') return `TO_CHAR(${q}, 'YYYY-MM-DD HH24:MI:SS')`;
    if (/WITH (LOCAL )?TIME ZONE/.test(t)) return `TO_CHAR(SYS_EXTRACT_UTC(${q}), 'YYYY-MM-DD HH24:MI:SS.FF6')`;
    if (t.startsWith('TIMESTAMP')) return `TO_CHAR(${q}, 'YYYY-MM-DD HH24:MI:SS.FF6')`;
    if (t.startsWith('INTERVAL')) return `TO_CHAR(${q})`;
    if (t === 'XMLTYPE') return `XMLSERIALIZE(CONTENT ${q} AS CLOB)`;
    if (t === 'ROWID' || t === 'UROWID') return `ROWIDTOCHAR(${q})`;
    if (t === 'BFILE') return `NULL`;
    return q;
  }
  if (col.family === 'other' || col.isArray || col.udt === 'interval' || col.udt === 'xml') return `${q}::text`;
  return q;
}

// Как колонку сортировать (для merge-join по ключу)
function orderExpr(db, col) {
  const q = db.quote(col.name);
  if (db.type === 'postgres' && ['string', 'text', 'uuid'].includes(col.family) && col.udt !== 'uuid') return `${q} COLLATE "C"`;
  return q; // Oracle: в сессии NLS_SORT=BINARY
}

// ---------- Канонизация ----------
function canonDecimal(input) {
  let s = String(input).trim();
  if (s === '' || s === 'NaN' || /^[+-]?Infinity$/i.test(s) || s === '~' || s === '-~') return s;
  let neg = false;
  if (s[0] === '-' || s[0] === '+') { neg = s[0] === '-'; s = s.slice(1); }
  let exp = 0;
  const em = /[eE]([+-]?\d+)$/.exec(s);
  if (em) { exp = Number(em[1]); s = s.slice(0, em.index); }
  let [ip, fp = ''] = s.split('.');
  let digits = (ip || '') + fp;
  let point = (ip || '').length + exp;
  if (point < 0) { digits = '0'.repeat(-point) + digits; point = 0; }
  if (point > digits.length) { digits = digits + '0'.repeat(point - digits.length); }
  ip = digits.slice(0, point).replace(/^0+/, '') || '0';
  fp = digits.slice(point).replace(/0+$/, '');
  const out = fp ? `${ip}.${fp}` : ip;
  return neg && out !== '0' ? '-' + out : out;
}

function compareDecimal(a, b) {
  const na = a[0] === '-', nb = b[0] === '-';
  if (na !== nb) return na ? -1 : 1;
  const sign = na ? -1 : 1;
  const [ai, af = ''] = (na ? a.slice(1) : a).split('.');
  const [bi, bf = ''] = (nb ? b.slice(1) : b).split('.');
  if (ai.length !== bi.length) return sign * (ai.length < bi.length ? -1 : 1);
  if (ai !== bi) return sign * (ai < bi ? -1 : 1);
  const len = Math.max(af.length, bf.length);
  const pa = af.padEnd(len, '0'), pb = bf.padEnd(len, '0');
  if (pa === pb) return 0;
  return sign * (pa < pb ? -1 : 1);
}

const DT_RE = /^(-?\d{4,})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?(?::?\d{2})?)?(\s*BC)?$/;
function canonDateTime(v) {
  if (v instanceof Date) v = v.toISOString().replace('T', ' ').replace('Z', '');
  const s = String(v).trim();
  const m = DT_RE.exec(s);
  if (!m) return s;
  let [, Y, Mo, D, h = '00', mi = '00', sec = '00', frac = '', tz, bc] = m;
  frac = (frac + '000000').slice(0, 6);
  if (tz && tz !== 'Z' && !/^[+-]00(:?00)?(:?00)?$/.test(tz)) {
    // Перевод в UTC
    const sign = tz[0] === '-' ? -1 : 1;
    const parts = tz.slice(1).replace(/:/g, '');
    const offMin = sign * (Number(parts.slice(0, 2)) * 60 + Number(parts.slice(2, 4) || 0));
    const d = new Date(Date.UTC(Number(Y), Number(Mo) - 1, Number(D), Number(h), Number(mi), Number(sec)) - offMin * 60000);
    const p = n => String(n).padStart(2, '0');
    Y = String(d.getUTCFullYear()).padStart(4, '0'); Mo = p(d.getUTCMonth() + 1); D = p(d.getUTCDate());
    h = p(d.getUTCHours()); mi = p(d.getUTCMinutes()); sec = p(d.getUTCSeconds());
  }
  return `${bc ? '-' : ''}${Y}-${Mo}-${D} ${h}:${mi}:${sec}.${frac}`;
}

function stableJson(v) {
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

/**
 * Режим нормализации для пары колонок (источник, приёмник)
 */
function pairMode(ca, cb) {
  const ga = GROUP[ca.family], gb = GROUP[cb.family];
  const has = g => ga === g || gb === g;
  if (ca.family === 'json' || cb.family === 'json') return 'json';
  if (has('datetime')) return 'datetime';
  if (ca.family === 'float' || cb.family === 'float') return 'float';
  if (has('number')) return 'number';
  if (has('binary')) return 'binary';
  return 'string';
}

function makeNormalizer(mode, opts, isChar) {
  const emptyAsNull = !!opts.emptyAsNull;
  const trim = !!opts.trimTrailingSpaces || isChar;
  const floatDigits = opts.floatPrecision || 15;
  return (v) => {
    if (v === null || v === undefined) return null;
    if (Buffer.isBuffer(v)) {
      if (v.length === 0 && emptyAsNull) return null;
      return v.length <= 32 ? 'x' + v.toString('hex') : 'md5:' + crypto.createHash('md5').update(v).digest('hex');
    }
    if (typeof v === 'boolean') return v ? '1' : '0';
    switch (mode) {
      case 'number':
        if (typeof v === 'number') return canonDecimal(String(v));
        if (v === 't' || v === 'true') return '1';
        if (v === 'f' || v === 'false') return '0';
        if (String(v).trim() === '' && emptyAsNull) return null;
        return canonDecimal(v);
      case 'float': {
        const n = Number(v);
        if (!Number.isFinite(n)) return String(v);
        return canonDecimal(String(Number(n.toPrecision(floatDigits))));
      }
      case 'datetime':
        if (String(v).trim() === '' && emptyAsNull) return null;
        return canonDateTime(v);
      case 'binary': {
        // строка на одной стороне, бинарь на другой (например, RAW как hex)
        const s = String(v);
        if (s === '' && emptyAsNull) return null;
        if (/^\\x[0-9a-f]*$/i.test(s)) return makeNormalizer('binary', opts)(Buffer.from(s.slice(2), 'hex'));
        return s;
      }
      case 'json': {
        let s = typeof v === 'string' ? v : JSON.stringify(v);
        if (s === '' && emptyAsNull) return null;
        try { s = stableJson(JSON.parse(s)); } catch { /* не JSON — сравниваем как строку */ }
        return s;
      }
      default: {
        let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        if (trim) s = s.replace(/ +$/, '');
        if (s === '' && emptyAsNull) return null;
        return s;
      }
    }
  };
}

// Компаратор ключей: должен совпадать с порядком ORDER BY в обеих СУБД
function keyComparator(mode) {
  if (mode === 'number' || mode === 'float') return (a, b) => compareDecimal(a, b);
  if (mode === 'datetime') return (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

module.exports = { selectExpr, orderExpr, canonDecimal, compareDecimal, canonDateTime, pairMode, makeNormalizer, keyComparator, stableJson };
