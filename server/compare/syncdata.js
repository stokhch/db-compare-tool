'use strict';
// Скрипт синхронизации данных: INSERT отсутствующих строк, UPDATE отличающихся, DELETE лишних —
// так, чтобы приёмник совпал с источником. Строится потоково во время сравнения (память не растёт),
// порядок — по внешним ключам: вставки от родителей к детям, удаления — в обратном порядке.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../lib/store');
const { connect } = require('../db');
const { getConnection } = require('../lib/store');
const { canonDateTime } = require('../lib/normalize');
const { runDataCompare } = require('./data');

const SYNC_DIR = path.join(DATA_DIR, 'sync');
fs.mkdirSync(SYNC_DIR, { recursive: true });
const SEP = '\n-- @@\n'; // разделитель операторов в служебном файле для выполнения

// ---------- Литералы под диалект приёмника ----------
function makeLiteral(dialect, stats) {
  const str = s => `'${s.replace(/'/g, "''")}'`;
  const oraStr = s => {
    if (s.length <= 1000) return str(s);
    const parts = [];
    for (let i = 0; i < s.length; i += 1000) parts.push(`TO_CLOB(${str(s.slice(i, i + 1000))})`);
    return parts.join(' || ');
  };
  return (v, col) => {
    if (v === null || v === undefined) return 'NULL';
    const fam = col.family;
    const t = String(col.dataType || col.udt || '').toUpperCase();
    if (Buffer.isBuffer(v)) {
      if (dialect === 'postgres') return `'\\x${v.toString('hex')}'::bytea`;
      if (v.length <= 2000) return `HEXTORAW('${v.toString('hex')}')`;
      stats.lobSkipped++; return 'NULL /* BLOB > 2000 байт — перенесите переливом */';
    }
    if (typeof v === 'boolean') return dialect === 'postgres' ? (v ? 'true' : 'false') : (v ? '1' : '0');
    if (fam === 'bool') return ['1', 't', 'true', 'y'].includes(String(v).toLowerCase()) ? 'true' : 'false';
    if (fam === 'int' || fam === 'numeric' || fam === 'float') {
      const s = String(v).trim();
      if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return s;
      if (s === 't' || s === 'true') return '1';
      if (s === 'f' || s === 'false') return '0';
      return dialect === 'postgres' ? str(s) : `TO_NUMBER(${str(s)})`;
    }
    if (fam === 'datetime' || fam === 'datetimetz' || fam === 'date') {
      const d = canonDateTime(v);
      if (dialect === 'postgres') return str(fam === 'datetimetz' ? d + '+00' : d);
      if (t === 'DATE') return `TO_DATE('${d.slice(0, 19)}', 'YYYY-MM-DD HH24:MI:SS')`;
      if (fam === 'datetimetz') return `TO_TIMESTAMP_TZ('${d} +00:00', 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM')`;
      return `TO_TIMESTAMP('${d}', 'YYYY-MM-DD HH24:MI:SS.FF')`;
    }
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (dialect === 'postgres') return str(s.replace(/\u0000/g, ''));
    if (fam === 'binary') return `HEXTORAW('${Buffer.from(s.startsWith('\\x') ? s.slice(2) : s, s.startsWith('\\x') ? 'hex' : 'utf8').toString('hex')}')`;
    if (t === 'XMLTYPE') return `XMLTYPE(${oraStr(s)})`;
    return oraStr(s);
  };
}

function createSink(dir, tgt, tgtSchema, opts) {
  const stats = { insert: 0, update: 0, delete: 0, deleteNoKey: 0, lobSkipped: 0, tables: [] };
  const lit = makeLiteral(tgt.type, stats);
  const sink = {
    stats,
    order: [],
    begin(ta, tb, all, nk) {
      const base = path.join(dir, ta.name.replace(/[^\w$#-]/g, '_'));
      const f = { up: base + '.upsert.sql', del: base + '.delete.sql' };
      let fdUp = fs.openSync(f.up, 'w'), fdDel = fs.openSync(f.del, 'w');
      const tq = tgt.qualify(tgtSchema, tb.name);
      const cols = all.map(c => tgt.quote(c.b.name));
      const keyWhere = (raw) => {
        const parts = [];
        for (let i = 0; i < nk; i++) {
          if (raw[i] === null || raw[i] === undefined) return null;
          parts.push(`${tgt.quote(all[i].b.name)} = ${lit(raw[i], all[i].b)}`);
        }
        return parts.join(' AND ');
      };
      const local = { insert: 0, update: 0, delete: 0, table: ta.name };
      const write = (fd, sql) => fs.writeSync(fd, sql + ';' + SEP);
      return {
        reset() {
          fs.ftruncateSync(fdUp, 0); fs.ftruncateSync(fdDel, 0);
          fs.closeSync(fdUp); fs.closeSync(fdDel);
          fdUp = fs.openSync(f.up, 'w'); fdDel = fs.openSync(f.del, 'w');
          local.insert = local.update = local.delete = 0;
        },
        missing(nr) {
          if (opts.insert === false) return;
          const raw = nr.raw;
          const vals = all.map((c, i) => lit(raw[i], c.b));
          if (opts.upsert && nk) {
            // Догрузка: строка могла быть в приёмнике вне окна отбора — вставка или обновление
            const keyCols = cols.slice(0, nk), valCols = cols.slice(nk);
            if (tgt.type === 'postgres') {
              const set = valCols.map(c => `${c} = EXCLUDED.${c}`).join(', ');
              write(fdUp, `INSERT INTO ${tq} (${cols.join(', ')}) VALUES (${vals.join(', ')}) ON CONFLICT (${keyCols.join(', ')}) DO ${set ? `UPDATE SET ${set}` : 'NOTHING'}`);
            } else {
              const sel = vals.map((v, i) => `${v} AS ${cols[i]}`).join(', ');
              const on = keyCols.map(c => `d.${c} = s.${c}`).join(' AND ');
              const upd = valCols.length ? ` WHEN MATCHED THEN UPDATE SET ${valCols.map(c => `d.${c} = s.${c}`).join(', ')}` : '';
              write(fdUp, `MERGE INTO ${tq} d USING (SELECT ${sel} FROM dual) s ON (${on})${upd} WHEN NOT MATCHED THEN INSERT (${cols.join(', ')}) VALUES (${cols.map(c => `s.${c}`).join(', ')})`);
            }
          } else {
            write(fdUp, `INSERT INTO ${tq} (${cols.join(', ')}) VALUES (${vals.join(', ')})`);
          }
          local.insert++;
        },
        different(na, nb, diffCols) {
          if (opts.update === false) return;
          const w = keyWhere(na.raw);
          if (!w) return;
          const set = diffCols.map(c => `${tgt.quote(all[c.idx].b.name)} = ${lit(na.raw[c.idx], all[c.idx].b)}`);
          write(fdUp, `UPDATE ${tq} SET ${set.join(', ')} WHERE ${w}`);
          local.update++;
        },
        extra(nb) {
          if (opts.delete !== true) return;
          if (!nk) { stats.deleteNoKey++; return; }
          const w = keyWhere(nb.raw);
          if (!w) return;
          write(fdDel, `DELETE FROM ${tq} WHERE ${w}`);
          local.delete++;
        },
        async end() {
          fs.closeSync(fdUp); fs.closeSync(fdDel);
          stats.insert += local.insert; stats.update += local.update; stats.delete += local.delete;
          stats.tables.push({ ...local, files: f });
        },
      };
    },
  };
  return sink;
}

function* readStatements(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const part of text.split(SEP)) { const s = part.trim(); if (s) yield s; }
}

async function runDataSync(p, ctx) {
  const dir = path.join(SYNC_DIR, ctx.id);
  fs.mkdirSync(dir, { recursive: true });
  const tgtConn = getConnection(p.targetId);
  const tgt = await connect(tgtConn); // нужен только для quote/qualify и выполнения
  const opts = { insert: p.insert !== false, update: p.update !== false, delete: p.delete === true, upsert: !!p.upsert };
  const sink = createSink(dir, tgt, p.targetSchema, opts);
  try {
    ctx.log(`Скрипт синхронизации данных: ${opts.insert ? 'INSERT ' : ''}${opts.update ? 'UPDATE ' : ''}${opts.delete ? 'DELETE' : ''}`);
    const cmp = await runDataCompare(p, ctx, sink);

    // Сборка итогового скрипта: вставки/обновления в порядке FK, удаления — в обратном
    const byTable = new Map(sink.stats.tables.map(t => [t.table.toLowerCase(), t]));
    const ordered = (sink.order || []).map(k => byTable.get(k)).filter(Boolean);
    for (const t of sink.stats.tables) if (!ordered.includes(t)) ordered.push(t);
    const scriptName = `data_sync_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.sql`;
    const out = fs.openSync(path.join(dir, scriptName), 'w');
    const term = '\n';
    fs.writeSync(out, `-- Скрипт синхронизации данных (db-compare-tool)\n-- Источник: ${cmp.source.name}/${cmp.source.schema} → приёмник: ${cmp.target.name}/${cmp.target.schema}\n`
      + `-- INSERT: ${sink.stats.insert}, UPDATE: ${sink.stats.update}, DELETE: ${sink.stats.delete}\n`
      + (tgt.type === 'oracle' ? 'SET DEFINE OFF\n' : 'BEGIN;\n') + term);
    for (const t of ordered) {
      if (!t.insert && !t.update) continue;
      fs.writeSync(out, `\n-- ===== ${t.table}: INSERT ${t.insert}, UPDATE ${t.update} =====\n`);
      for (const s of readStatements(t.files.up)) fs.writeSync(out, s + term);
    }
    for (const t of [...ordered].reverse()) {
      if (!t.delete) continue;
      fs.writeSync(out, `\n-- ===== ${t.table}: DELETE ${t.delete} =====\n`);
      for (const s of readStatements(t.files.del)) fs.writeSync(out, s + term);
    }
    fs.writeSync(out, '\nCOMMIT;\n');
    fs.closeSync(out);
    if (sink.stats.deleteNoKey) ctx.log(`Лишние строки в таблицах без ключа (${sink.stats.deleteNoKey}) удалить скриптом нельзя — удалите вручную`, 'warning');
    if (sink.stats.lobSkipped) ctx.log(`BLOB больше 2000 байт (${sink.stats.lobSkipped}) не помещаются в литерал Oracle — для них используйте перелив`, 'warning');
    ctx.log(`Скрипт готов: ${scriptName}`);

    // Выполнение
    let applied = null;
    if (p.apply) {
      applied = { executed: 0, errors: 0 };
      const all = [];
      for (const t of ordered) all.push(...[...readStatements(t.files.up)].map(s => ({ s, t: t.table })));
      for (const t of [...ordered].reverse()) all.push(...[...readStatements(t.files.del)].map(s => ({ s, t: t.table })));
      ctx.log(`Выполнение ${all.length} операторов на приёмнике…`);
      if (tgt.type === 'postgres') await tgt.exec('BEGIN');
      try {
        for (let i = 0; i < all.length; i++) {
          ctx.checkCancel();
          const sql = all[i].s.replace(/;\s*$/, '');
          try { await tgt.exec(sql); applied.executed++; }
          catch (e) {
            applied.errors++;
            ctx.log(`✗ ${all[i].t}: ${e.message}\n${sql.slice(0, 300)}`, 'error');
            if (tgt.type === 'postgres' || p.stopOnError !== false) throw new Error(`Ошибка при выполнении: ${e.message}`);
          }
          if (tgt.type === 'oracle' && applied.executed % 1000 === 0) await tgt.commit();
          if (i % 500 === 0) ctx.progress(i, all.length, `Выполнение: ${i} из ${all.length}`);
        }
        if (tgt.type === 'postgres') await tgt.exec('COMMIT'); else await tgt.commit();
        ctx.log(`Выполнено операторов: ${applied.executed}`);
      } catch (e) {
        if (tgt.type === 'postgres') { await tgt.exec('ROLLBACK').catch(() => {}); ctx.log('Транзакция откачена — данные приёмника не изменены', 'error'); }
        else { await tgt.rollback(); ctx.log('Oracle: выполнено до ошибки и зафиксировано пачками по 1000 — проверьте данные', 'error'); }
        throw e;
      }
    }
    // временные файлы по таблицам больше не нужны
    for (const t of sink.stats.tables) for (const f of Object.values(t.files)) fs.rmSync(f, { force: true });
    return {
      summary: { insert: sink.stats.insert, update: sink.stats.update, delete: sink.stats.delete, applied: !!p.apply, file: scriptName },
      script: { jobId: ctx.id, name: scriptName, size: fs.statSync(path.join(dir, scriptName)).size },
      stats: { ...sink.stats, tables: sink.stats.tables.map(({ files, ...r }) => r) },
      applied,
      compare: { summary: cmp.summary },
      source: cmp.source, target: cmp.target,
    };
  } finally { await tgt.close(); }
}

module.exports = { runDataSync, makeLiteral, SYNC_DIR };
