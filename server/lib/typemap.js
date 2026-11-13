'use strict';
// Типы колонок: «семейства» для кросс-СУБД сравнения, проверка совместимости,
// генерация DDL при переливе Oracle <-> PostgreSQL (логика маппинга — как в ora2pg).

// ---------- Семейства ----------
function oracleFamily(c) {
  const t = c.dataType.toUpperCase();
  if (t === 'NUMBER') {
    if (c.scale === 0) return 'int';
    return 'numeric';
  }
  if (t === 'INTEGER' || t === 'SMALLINT') return 'int';
  if (t === 'FLOAT' || t === 'BINARY_FLOAT' || t === 'BINARY_DOUBLE') return 'float';
  if (['VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR', 'VARCHAR'].includes(t)) return 'string';
  if (['CLOB', 'NCLOB', 'LONG'].includes(t)) return 'text';
  if (t === 'DATE') return 'datetime';
  if (/^TIMESTAMP\(\d\) WITH (LOCAL )?TIME ZONE$/.test(t) || /WITH (LOCAL )?TIME ZONE/.test(t)) return 'datetimetz';
  if (t.startsWith('TIMESTAMP')) return 'datetime';
  if (['BLOB', 'RAW', 'LONG RAW', 'BFILE'].includes(t)) return 'binary';
  if (t === 'XMLTYPE') return 'xml';
  if (t === 'JSON') return 'json';
  if (t.startsWith('INTERVAL')) return 'interval';
  if (t === 'ROWID' || t === 'UROWID') return 'string';
  if (t === 'BOOLEAN') return 'bool';
  return 'other';
}

function pgFamily(c) {
  const t = c.udt;
  if (['int2', 'int4', 'int8'].includes(t)) return 'int';
  if (t === 'numeric') return 'numeric';
  if (t === 'float4' || t === 'float8') return 'float';
  if (t === 'money') return 'numeric';
  if (t === 'varchar' || t === 'bpchar') return c.length ? 'string' : 'text';
  if (t === 'text' || t === 'citext' || t === 'name') return 'text';
  if (t === 'date') return 'date';
  if (t === 'timestamp') return 'datetime';
  if (t === 'timestamptz') return 'datetimetz';
  if (t === 'time' || t === 'timetz') return 'time';
  if (t === 'bytea') return 'binary';
  if (t === 'bool') return 'bool';
  if (t === 'uuid') return 'uuid';
  if (t === 'json' || t === 'jsonb') return 'json';
  if (t === 'xml') return 'xml';
  if (t === 'interval') return 'interval';
  return 'other';
}

const GROUP = {
  int: 'number', numeric: 'number', float: 'number', bool: 'number',
  string: 'string', text: 'string', uuid: 'string', json: 'string', xml: 'string',
  datetime: 'datetime', datetimetz: 'datetime', date: 'datetime', time: 'time',
  binary: 'binary', interval: 'interval', other: 'other',
};

// Сколько десятичных цифр гарантированно помещается
function intCapacity(c) {
  if (c.udt === 'int2') return 4;
  if (c.udt === 'int4') return 9;
  if (c.udt === 'int8') return 18;
  if (c.family === 'int' || c.family === 'numeric') {
    if (c.precision == null) return 38;
    return c.precision - (c.scale || 0);
  }
  return 38;
}

/**
 * Совместимость типа колонки источника и приёмника.
 * @returns {{level:'ok'|'warning'|'error', msg?:string}}
 */
function compatibility(src, tgt, sameEngine) {
  if (sameEngine) {
    if (src.type === tgt.type) return { level: 'ok' };
    if (src.family === tgt.family && src.family === 'string' && tgt.length >= src.length) {
      return { level: 'warning', msg: `Длина отличается: ${src.type} → ${tgt.type}` };
    }
    if (src.family === tgt.family && (src.family === 'int' || src.family === 'numeric') && intCapacity(tgt) >= intCapacity(src) && (tgt.scale || 0) >= (src.scale || 0)) {
      return { level: 'warning', msg: `Тип отличается, но значения поместятся: ${src.type} → ${tgt.type}` };
    }
    return { level: 'error', msg: `Тип отличается: ${src.type} → ${tgt.type}` };
  }

  const sf = src.family, tf = tgt.family;
  const sg = GROUP[sf], tg = GROUP[tf];

  // Число <-> число
  if (sg === 'number' && tg === 'number') {
    if (sf === 'bool' || tf === 'bool') {
      const other = sf === 'bool' ? tgt : src;
      if (other.family === 'int' && (other.precision === 1 || other.precision == null)) return { level: 'ok' };
      return { level: 'warning', msg: `Логический тип ↔ число: ${src.type} → ${tgt.type}` };
    }
    if (sf === 'float' || tf === 'float') {
      if (sf === tf) return { level: 'ok' };
      return { level: 'warning', msg: `Плавающая точка ↔ точное число: ${src.type} → ${tgt.type}` };
    }
    // int / numeric
    const sCap = intCapacity(src), tCap = intCapacity(tgt);
    const sScale = sf === 'int' ? 0 : (src.scale ?? null);
    const tScale = tf === 'int' ? 0 : (tgt.scale ?? null);
    if (tCap < sCap && !(src.precision == null && sf === 'numeric')) {
      return { level: src.precision == null ? 'warning' : 'error', msg: `Возможное переполнение: ${src.type} (до ${sCap} цифр) → ${tgt.type} (до ${tCap})` };
    }
    if (sScale !== 0 && tScale === 0) return { level: 'error', msg: `Дробная часть будет потеряна: ${src.type} → ${tgt.type}` };
    if (sScale != null && tScale != null && tScale < sScale) return { level: 'warning', msg: `Меньше знаков после запятой: ${src.type} → ${tgt.type}` };
    if (src.precision == null && sf === 'int' && tgt.udt === 'int8') return { level: 'warning', msg: `${src.type} (до 38 цифр) → bigint (до 18 цифр)` };
    return { level: 'ok' };
  }

  // Строки
  if (sg === 'string' && tg === 'string') {
    if (tf === 'text' || tf === 'json' || tf === 'xml') {
      if (sf === 'string' || sf === 'text' || sf === tf) return { level: 'ok' };
      return { level: 'warning', msg: `${src.type} → ${tgt.type}` };
    }
    if (tf === 'string') {
      if (sf === 'text' || sf === 'json' || sf === 'xml') return { level: 'warning', msg: `Неограниченный текст → ${tgt.type}: возможно усечение` };
      if (sf === 'uuid') return tgt.length >= 36 ? { level: 'ok' } : { level: 'error', msg: `uuid не поместится в ${tgt.type}` };
      if (tgt.length != null && src.length != null && tgt.length < src.length) {
        return { level: 'error', msg: `Длина меньше: ${src.type} → ${tgt.type}` };
      }
      if (src.isChar !== tgt.isChar) return { level: 'warning', msg: `CHAR ↔ VARCHAR: ${src.type} → ${tgt.type} (хвостовые пробелы)` };
      return { level: 'ok' };
    }
    if (tf === 'uuid') return { level: 'warning', msg: `${src.type} → uuid: значения должны быть в формате UUID` };
  }

  // Дата/время
  if (sg === 'datetime' && tg === 'datetime') {
    if (tf === 'date' && sf !== 'date') return { level: 'warning', msg: `${src.type} → date: время будет потеряно` };
    if ((sf === 'datetimetz') !== (tf === 'datetimetz') && sf !== 'date' && tf !== 'date') {
      return { level: 'warning', msg: `С часовым поясом ↔ без: ${src.type} → ${tgt.type}` };
    }
    if (src.fsp != null && tgt.fsp != null && tgt.fsp < src.fsp) return { level: 'warning', msg: `Меньше точность долей секунды: ${src.type} → ${tgt.type}` };
    return { level: 'ok' };
  }

  if (sg === tg) return { level: 'ok' };
  return { level: 'error', msg: `Несовместимые типы: ${src.type} → ${tgt.type}` };
}

// ---------- Генерация типов для DDL ----------
function oracleToPgType(c) {
  const t = c.dataType.toUpperCase();
  switch (true) {
    case t === 'NUMBER' && c.scale === 0 && c.precision != null:
      if (c.precision < 5) return 'smallint';
      if (c.precision < 10) return 'integer';
      if (c.precision < 19) return 'bigint';
      return `numeric(${c.precision})`;
    case t === 'NUMBER' && c.scale === 0: return 'numeric';           // INTEGER / NUMBER(*,0)
    case t === 'NUMBER' && c.precision != null: return `numeric(${c.precision},${c.scale})`;
    case t === 'NUMBER': return 'numeric';
    case t === 'INTEGER': return 'numeric';
    case t === 'FLOAT' || t === 'BINARY_DOUBLE': return 'double precision';
    case t === 'BINARY_FLOAT': return 'real';
    case t === 'VARCHAR2' || t === 'NVARCHAR2' || t === 'VARCHAR': return `varchar(${c.length})`;
    case t === 'CHAR' || t === 'NCHAR': return `char(${c.length})`;
    case ['CLOB', 'NCLOB', 'LONG'].includes(t): return 'text';
    case t === 'DATE': return 'timestamp(0)';
    case /WITH (LOCAL )?TIME ZONE/.test(t): return `timestamp(${c.fsp ?? 6}) with time zone`;
    case t.startsWith('TIMESTAMP'): return `timestamp(${c.fsp ?? 6})`;
    case ['BLOB', 'RAW', 'LONG RAW'].includes(t): return 'bytea';
    case t === 'XMLTYPE': return 'xml';
    case t === 'JSON': return 'jsonb';
    case t.startsWith('INTERVAL'): return 'interval';
    case t === 'ROWID' || t === 'UROWID': return 'varchar(4000)';
    case t === 'BOOLEAN': return 'boolean';
    default: return 'text';
  }
}

function pgToOracleType(c) {
  switch (c.udt) {
    case 'int2': return 'NUMBER(5)';
    case 'int4': return 'NUMBER(10)';
    case 'int8': return 'NUMBER(19)';
    case 'numeric': return c.precision != null ? `NUMBER(${c.precision},${c.scale || 0})` : 'NUMBER';
    case 'money': return 'NUMBER(19,2)';
    case 'float4': return 'BINARY_FLOAT';
    case 'float8': return 'BINARY_DOUBLE';
    case 'varchar': return c.length && c.length <= 4000 ? `VARCHAR2(${c.length} CHAR)` : 'CLOB';
    case 'bpchar': return c.length && c.length <= 2000 ? `CHAR(${c.length} CHAR)` : 'CLOB';
    case 'text': case 'citext': case 'json': case 'jsonb': return 'CLOB';
    case 'bool': return 'NUMBER(1)';
    case 'date': return 'DATE';
    case 'timestamp': return `TIMESTAMP(${c.fsp ?? 6})`;
    case 'timestamptz': return `TIMESTAMP(${c.fsp ?? 6}) WITH TIME ZONE`;
    case 'time': case 'timetz': return 'VARCHAR2(32)';
    case 'interval': return 'INTERVAL DAY(9) TO SECOND(6)';
    case 'bytea': return 'BLOB';
    case 'uuid': return 'VARCHAR2(36)';
    case 'xml': return 'XMLTYPE';
    default: return 'CLOB';
  }
}

function targetColumnType(col, srcType, tgtType) {
  if (srcType === tgtType) return col.type;
  return srcType === 'oracle' ? oracleToPgType(col) : pgToOracleType(col);
}

module.exports = { oracleFamily, pgFamily, compatibility, oracleToPgType, pgToOracleType, targetColumnType, GROUP };
