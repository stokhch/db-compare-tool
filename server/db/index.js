'use strict';
const { getConnection } = require('../lib/store');

async function connect(connOrId) {
  const conn = typeof connOrId === 'string' ? getConnection(connOrId) : connOrId;
  if (conn.type === 'oracle') return require('./oracle').OracleDb.connect(conn);
  if (conn.type === 'postgres') return require('./postgres').PostgresDb.connect(conn);
  throw new Error(`Неизвестный тип БД: ${conn.type}`);
}

// Выполнить функцию с открытым подключением и гарантированно закрыть его
async function withDb(connOrId, fn) {
  const db = await connect(connOrId);
  try { return await fn(db); } finally { await db.close(); }
}

module.exports = { connect, withDb };
