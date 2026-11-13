'use strict';
// Хранение подключений и настроек в JSON-файлах (папка data/).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DBCOMPARE_DATA || path.join(__dirname, '..', '..', 'data');
const FILES = {
  connections: path.join(DATA_DIR, 'connections.json'),
  settings: path.join(DATA_DIR, 'settings.json'),
};
for (const d of ['', 'jobs', 'dumps', 'ora2pg']) fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---- Пароли: лёгкое шифрование, чтобы не лежали открытым текстом ----
// Ключ берётся из DBCOMPARE_SECRET или генерируется один раз в data/.secret
function secretKey() {
  if (process.env.DBCOMPARE_SECRET) return crypto.createHash('sha256').update(process.env.DBCOMPARE_SECRET).digest();
  const f = path.join(DATA_DIR, '.secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'));
  return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
}
function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'enc:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(val) {
  if (!val || !String(val).startsWith('enc:')) return val || '';
  const buf = Buffer.from(val.slice(4), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

// ---- Подключения ----
function listConnections() { return readJson(FILES.connections, []); }
function getConnection(id) {
  const c = listConnections().find(x => x.id === id);
  if (!c) throw new Error(`Подключение ${id} не найдено`);
  return { ...c, password: decrypt(c.password) };
}
function publicConnection(c) { const { password, ...rest } = c; return { ...rest, hasPassword: !!password }; }
function saveConnection(input) {
  const list = listConnections();
  const idx = input.id ? list.findIndex(x => x.id === input.id) : -1;
  const prev = idx >= 0 ? list[idx] : {};
  const conn = {
    id: input.id || crypto.randomUUID(),
    name: input.name || `${input.type}:${input.host}`,
    type: input.type,                          // 'oracle' | 'postgres'
    host: input.host || 'localhost',
    port: Number(input.port) || (input.type === 'oracle' ? 1521 : 5432),
    database: input.database || '',             // PG: имя БД; Oracle: service name или SID
    oracleConnectMode: input.oracleConnectMode || 'service', // 'service' | 'sid' | 'tns'
    connectString: input.connectString || '',   // Oracle: полная строка (EZConnect/TNS) — если задана, приоритетна
    user: input.user || '',
    // пустой пароль при редактировании = оставить прежний
    password: input.password ? encrypt(input.password) : (prev.password || ''),
    schema: input.schema || '',
    ssl: !!input.ssl,
    note: input.note || '',
  };
  if (idx >= 0) list[idx] = conn; else list.push(conn);
  writeJson(FILES.connections, list);
  return publicConnection(conn);
}
function deleteConnection(id) {
  writeJson(FILES.connections, listConnections().filter(x => x.id !== id));
}

// ---- Настройки ----
const DEFAULT_SETTINGS = {
  pgBinPath: '',            // папка с pg_dump/pg_restore/psql, напр. C:\Program Files\PostgreSQL\16\bin
  oracleClientLibDir: '',   // Oracle Instant Client для thick-режима (нужен для Oracle 11g и старых паролей)
  ora2pgCommand: 'ora2pg',  // команда/путь к ora2pg (на Windows обычно C:\Strawberry\perl\site\bin\ora2pg.bat)
  perlPath: '',             // если ora2pg запускается как perl-скрипт
  maxDiffsPerTable: 200,
  fetchSize: 2000,
};
function getSettings() { return { ...DEFAULT_SETTINGS, ...readJson(FILES.settings, {}) }; }
function saveSettings(s) {
  const merged = { ...getSettings(), ...s };
  writeJson(FILES.settings, merged);
  return merged;
}

module.exports = {
  DATA_DIR, readJson, writeJson,
  listConnections, getConnection, publicConnection, saveConnection, deleteConnection,
  getSettings, saveSettings,
};
