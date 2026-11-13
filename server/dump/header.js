'use strict';
// Анализ файла дампа Oracle без подключения к базе: формат, версия, кодировка, режим, части набора файлов.
// Data Pump (expdp) хранит метаданные сжатыми, поэтому без базы из него извлекается только заголовок;
// полный состав берётся позже через DBMS_DATAPUMP (SQL_FILE). Старый exp хранит DDL открытым текстом —
// его содержимое разбирается прямо здесь.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Идентификаторы кодировок Oracle (NLS_CHARSET_ID), встречающиеся на практике
const CHARSET_IDS = { 1: 'US7ASCII', 31: 'WE8ISO8859P1', 171: 'CL8MSWIN1251', 178: 'WE8MSWIN1252', 196: 'CL8KOI8R', 871: 'UTF8', 873: 'AL32UTF8', 2000: 'AL16UTF16' };
const CHARSET_NAMES = ['AL32UTF8', 'UTF8', 'CL8MSWIN1251', 'CL8KOI8R', 'CL8ISO8859P5', 'RU8PC866', 'WE8MSWIN1252', 'WE8ISO8859P1', 'WE8ISO8859P15', 'EE8MSWIN1250', 'US7ASCII', 'AL16UTF16', 'ZHS16GBK', 'JA16SJIS'];
const SINGLE_BYTE = new Set(['CL8MSWIN1251', 'CL8KOI8R', 'CL8ISO8859P5', 'RU8PC866', 'WE8MSWIN1252', 'WE8ISO8859P1', 'WE8ISO8859P15', 'EE8MSWIN1250', 'US7ASCII']);

/** Разбор первых байтов файла (чистая функция). */
function parseHeader(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b[0] === 0x1f && b[1] === 0x8b) return { format: 'gzip' };
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return { format: 'zip' };
  if (b.slice(0, 2).toString('latin1') === '7z' && b[2] === 0xbc) return { format: '7z' };
  if (b.slice(0, 4).toString('latin1') === 'Rar!') return { format: 'rar' };
  const text = b.toString('latin1');
  // Старый exp: «\x03\x03\x69EXPORT:V11.02.00\nDSCOTT\nRUSERS\n…»; 2-й и 3-й байты — NLS_CHARSET_ID
  const legacy = /EXPORT:V(\d\d\.\d\d\.\d\d)/.exec(text.slice(0, 256));
  if (legacy) {
    const lines = text.slice(legacy.index).split('\n');
    const id = (b[1] << 8) | b[2];
    const user = (lines.find(l => /^[DU][A-Z0-9_$#]+$/.test(l)) || '').slice(1);
    const modeLine = (lines.find(l => /^R(USERS|ENTIRE|TABLES|TABLESPACES)$/.test(l)) || '').slice(1);
    return {
      format: 'exp', exportVersion: legacy[1], dbVersion: legacy[1], charset: CHARSET_IDS[id] || null, charsetId: id,
      exportedBy: user || null, mode: { USERS: 'SCHEMA', ENTIRE: 'FULL', TABLES: 'TABLE', TABLESPACES: 'TRANSPORTABLE' }[modeLine] || null,
    };
  }
  const printable = text.replace(/[^\x20-\x7e]+/g, '\n');
  const job = /"([A-Z0-9_$#]{1,128})"\."((?:SYS_EXPORT|SYS_SQL_FILE|[A-Z0-9_$#]*EXPORT)[A-Z0-9_$#]*)"/.exec(printable)
    || /"([A-Z0-9_$#]{1,128})"\."([A-Z0-9_$#]{1,128})"/.exec(printable);
  const ver = /\b(\d{1,2}\.\d{1,2}\.\d{1,2}\.\d{1,2}\.\d{1,2})\b/.exec(printable);
  const charset = CHARSET_NAMES.find(c => new RegExp(`(^|[^A-Z0-9])${c}([^A-Z0-9]|$)`).test(printable));
  const platform = /(x86_64\/Linux[^\n]{0,40}|IBMPC\/WIN_NT[^\n]{0,30}|Linux[ -]x86[ -]64[^\n]{0,20}|Microsoft Windows[^\n]{0,30}|AIX[^\n]{0,30}|Solaris[^\n]{0,40}|HP-UX[^\n]{0,30})/.exec(printable);
  const modeM = job && /SYS_EXPORT_(FULL|SCHEMA|TABLE|TABLESPACE|TRANSPORTABLE)/.exec(job[2]);
  const looksDp = !!(job || ver);
  return {
    format: looksDp ? 'datapump' : 'unknown',
    dbVersion: ver ? ver[1] : null,
    charset: charset || null,
    platform: platform ? platform[1].trim() : null,
    jobOwner: job ? job[1] : null,
    jobName: job ? job[2] : null,
    mode: modeM ? modeM[1] : null,
  };
}

/** Части набора файлов: exp_01.dmp, exp_02.dmp … (expdp DUMPFILE=exp_%U.dmp). */
function siblingFiles(file, names) {
  const base = path.basename(file);
  const m = /^(.*?)(\d{1,3})(\.[^.]+)$/i.exec(base);
  if (!m) return [base];
  const re = new RegExp(`^${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d{${m[2].length}}${m[3].replace('.', '\\.')}$`, 'i');
  const list = names.filter(n => re.test(n)).sort();
  return list.length ? list : [base];
}

/** Чтение начала файла, части набора, размер. */
function scanDumpFile(file) {
  if (!fs.existsSync(file)) throw new Error(`Файл не найден: ${file}`);
  const st = fs.statSync(file);
  if (st.isDirectory()) throw new Error('Укажите файл дампа, а не папку');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(Math.min(st.size, 256 * 1024));
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const h = parseHeader(buf);
  let names = [];
  try { names = fs.readdirSync(path.dirname(file)); } catch { /* нет доступа к папке */ }
  const parts = h.format === 'datapump' ? siblingFiles(file, names) : [path.basename(file)];
  const partSizes = parts.map(n => { try { return fs.statSync(path.join(path.dirname(file), n)).size; } catch { return 0; } });
  return {
    ...h, file, folder: path.dirname(file), name: path.basename(file), size: st.size,
    parts, totalSize: partSizes.reduce((s, x) => s + x, 0),
    singleByteSource: h.charset ? SINGLE_BYTE.has(h.charset) : null,
  };
}

/** Распаковка .gz рядом с архивом. */
function gunzipFile(file, ctx) {
  const out = file.replace(/\.gz$/i, '') === file ? file + '.dmp' : file.replace(/\.gz$/i, '');
  return new Promise((resolve, reject) => {
    const total = fs.statSync(file).size;
    let done = 0;
    const src = fs.createReadStream(file);
    src.on('data', c => { done += c.length; if (ctx) ctx.progress(done, total, 'Распаковка…'); });
    src.pipe(zlib.createGunzip()).on('error', reject).pipe(fs.createWriteStream(out)).on('finish', () => resolve(out)).on('error', reject);
  });
}

/**
 * Старый exp: DDL хранится открытым текстом. Потоково вытаскиваем строки CONNECT/CREATE/ALTER/GRANT,
 * чтобы разобрать их тем же парсером, что и SQL-файл Data Pump.
 */
function extractLegacyDdl(file, ctx, limitBytes = 4 * 1024 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const out = [];
    let tail = '', read = 0;
    const total = Math.min(fs.statSync(file).size, limitBytes);
    const s = fs.createReadStream(file, { highWaterMark: 1024 * 1024, end: total - 1 });
    const re = /(?:^|[\x00-\x1f])((?:CONNECT|CREATE|ALTER|GRANT|COMMENT ON)\s[\x20-\x7e\x80-\xff\t\r]{2,})/g;
    s.on('data', chunk => {
      read += chunk.length;
      const text = tail + chunk.toString('latin1');
      const cut = text.lastIndexOf('\n');
      const body = cut > 0 ? text.slice(0, cut) : text;
      tail = cut > 0 ? text.slice(cut) : '';
      if (tail.length > 1024 * 1024) tail = tail.slice(-64 * 1024);
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(body))) out.push(m[1].trim().replace(/\s*;?\s*$/, ';'));
      if (ctx) ctx.progress(read, total, 'Чтение DDL из дампа exp…');
    });
    s.on('end', () => resolve(out.join('\n')));
    s.on('error', reject);
  });
}

module.exports = { parseHeader, scanDumpFile, siblingFiles, gunzipFile, extractLegacyDdl, SINGLE_BYTE, CHARSET_IDS };
