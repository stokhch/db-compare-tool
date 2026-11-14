'use strict';
// Документация базы: справочник таблиц и колонок с комментариями, ключами, индексами, связями,
// представлениями и подпрограммами + ER-диаграмма (SVG без внешних библиотек). HTML и Markdown.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { connect } = require('../db');
const { getConnection, DATA_DIR } = require('../lib/store');
const { loadMeta } = require('../meta');

const DIR = path.join(DATA_DIR, 'docs');
fs.mkdirSync(DIR, { recursive: true });
const K = x => String(x || '').toLowerCase();
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function loadComments(db, schema) {
  const t = new Map(), c = new Map();
  if (db.type === 'postgres') {
    for (const r of await db.query(`SELECT c.relname AS t, obj_description(c.oid, 'pg_class') AS d FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m') AND obj_description(c.oid, 'pg_class') IS NOT NULL`, [schema])) t.set(K(r.t), r.d);
    for (const r of await db.query(`SELECT c.relname AS t, a.attname AS c, col_description(c.oid, a.attnum) AS d FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND a.attnum > 0 AND col_description(c.oid, a.attnum) IS NOT NULL`, [schema])) c.set(`${K(r.t)}.${K(r.c)}`, r.d);
  } else {
    const o = schema.toUpperCase();
    for (const r of await db.query(`SELECT table_name AS t, comments AS d FROM all_tab_comments WHERE owner = :o AND comments IS NOT NULL`, { o })) t.set(K(r.t), r.d);
    for (const r of await db.query(`SELECT table_name AS t, column_name AS c, comments AS d FROM all_col_comments WHERE owner = :o AND comments IS NOT NULL`, { o })) c.set(`${K(r.t)}.${K(r.c)}`, r.d);
  }
  return { t, c };
}

/** ER-диаграмма: таблицы сеткой (связанные рядом), связи — линии от колонки FK к заголовку родителя. */
function erSvg(tables, { maxCols = 10 } = {}) {
  if (!tables.length) return '';
  // порядок: сначала самые связанные, соседи рядом (обход в ширину по связям)
  const adj = new Map(tables.map(t => [K(t.name), new Set()]));
  for (const t of tables) for (const f of t.fks || []) if (adj.has(K(f.refTable)) && K(f.refTable) !== K(t.name)) { adj.get(K(t.name)).add(K(f.refTable)); adj.get(K(f.refTable)).add(K(t.name)); }
  const byName = new Map(tables.map(t => [K(t.name), t]));
  const order = [], seen = new Set();
  const starts = [...adj.keys()].sort((a, b) => adj.get(b).size - adj.get(a).size);
  for (const s of starts) {
    if (seen.has(s)) continue;
    const q = [s]; seen.add(s);
    while (q.length) { const x = q.shift(); order.push(byName.get(x)); for (const y of [...adj.get(x)].sort((a, b) => adj.get(b).size - adj.get(a).size)) if (!seen.has(y)) { seen.add(y); q.push(y); } }
  }
  const W = 230, RH = 17, HH = 24, GX = 70, GY = 50;
  const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(order.length * 1.3))));
  const boxes = new Map();
  const colX = [], rowY = [0];
  const rowsOf = t => {
    const pk = new Set((t.pk ? t.pk.columns : []).map(K)), fk = new Set((t.fks || []).flatMap(f => f.columns.map(K)));
    const sorted = [...t.columns].sort((a, b) => (pk.has(K(b.name)) - pk.has(K(a.name))) || (fk.has(K(b.name)) - fk.has(K(a.name))));
    const shown = sorted.slice(0, maxCols);
    return { shown, more: t.columns.length - shown.length, pk, fk };
  };
  order.forEach((t, i) => {
    const r = rowsOf(t);
    const h = HH + (r.shown.length + (r.more > 0 ? 1 : 0)) * RH + 6;
    const cx = i % cols, ry = Math.floor(i / cols);
    colX[cx] = cx * (W + GX) + 10;
    boxes.set(K(t.name), { t, r, x: colX[cx], row: ry, h });
  });
  const rowsCount = Math.ceil(order.length / cols);
  for (let ry = 0; ry < rowsCount; ry++) {
    const hmax = Math.max(...[...boxes.values()].filter(b => b.row === ry).map(b => b.h));
    rowY[ry + 1] = rowY[ry] + hmax + GY;
  }
  for (const b of boxes.values()) b.y = rowY[b.row] + 10;
  const width = cols * (W + GX) + 20, height = rowY[rowsCount] + 20;
  const parts = [];
  // связи
  for (const b of boxes.values()) {
    for (const f of b.t.fks || []) {
      const p = boxes.get(K(f.refTable)); if (!p) continue;
      const idx = b.r.shown.findIndex(c => K(c.name) === K(f.columns[0]));
      const y1 = b.y + HH + (idx >= 0 ? idx : b.r.shown.length) * RH + RH / 2;
      if (p === b) { parts.push(`<path d="M${b.x + W} ${y1} h20 V${b.y + 12} h-20" class="ln"/>`); continue; }
      const toRight = p.x > b.x, x1 = toRight ? b.x + W : b.x, x2 = p.x + (p.x > b.x ? 0 : p.x < b.x ? W : W / 2), y2 = p.y + (p.x === b.x ? (p.y > b.y ? 0 : p.h) : 12);
      const mx = p.x === b.x ? x1 + (toRight ? 30 : -30) : (x1 + x2) / 2;
      parts.push(`<path d="M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" class="ln"><title>${esc(`${b.t.name}.${f.columns.join(',')} → ${f.refTable}`)}</title></path><circle cx="${x2}" cy="${y2}" r="3" class="dot"/>`);
    }
  }
  for (const b of boxes.values()) {
    const { t, r } = b;
    parts.push(`<g><rect x="${b.x}" y="${b.y}" width="${W}" height="${b.h}" rx="6" class="box"/><rect x="${b.x}" y="${b.y}" width="${W}" height="${HH}" rx="6" class="hd"/>
<a href="#t-${esc(K(t.name))}"><text x="${b.x + 8}" y="${b.y + 16}" class="tn">${esc(t.name)}</text></a>`);
    r.shown.forEach((c, i) => {
      const y = b.y + HH + i * RH + 13;
      const mark = r.pk.has(K(c.name)) ? '🔑 ' : r.fk.has(K(c.name)) ? '↗ ' : '';
      parts.push(`<text x="${b.x + 8}" y="${y}" class="cn${r.pk.has(K(c.name)) ? ' pk' : ''}">${mark}${esc(c.name)}</text><text x="${b.x + W - 8}" y="${y}" class="ct" text-anchor="end">${esc(String(c.type).slice(0, 22))}</text>`);
    });
    if (r.more > 0) parts.push(`<text x="${b.x + 8}" y="${b.y + HH + r.shown.length * RH + 13}" class="ct">… ещё ${r.more}</text>`);
    parts.push('</g>');
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Segoe UI, Arial, sans-serif">
<style>.box{fill:#fff;stroke:#98a2b3}.hd{fill:#1d4ed8}.tn{fill:#fff;font-size:13px;font-weight:600}.cn{font-size:11.5px;fill:#101828}.pk{font-weight:600}.ct{font-size:10.5px;fill:#667085}.ln{fill:none;stroke:#7c8db5;stroke-width:1.2}.dot{fill:#1d4ed8}</style>
${parts.join('\n')}</svg>`;
}

function buildHtml(meta, cm, info) {
  const T = meta.tables;
  const relIn = new Map();
  for (const t of T) for (const f of t.fks || []) { const k = K(f.refTable); if (!relIn.has(k)) relIn.set(k, []); relIn.get(k).push(`${t.name} (${f.columns.join(', ')})`); }
  const tc = n => cm.t.get(K(n)) || '';
  const cc = (t, c) => cm.c.get(`${K(t)}.${K(c)}`) || '';
  const toc = T.map(t => `<li><a href="#t-${esc(K(t.name))}">${esc(t.name)}</a>${tc(t.name) ? ` — <span class="muted">${esc(tc(t.name).slice(0, 90))}</span>` : ''}</li>`).join('');
  const tables = T.map(t => {
    const pk = new Set((t.pk ? t.pk.columns : []).map(K));
    const fkOf = new Map(); for (const f of t.fks || []) f.columns.forEach((c, i) => fkOf.set(K(c), `${f.refTable}.${(f.refColumns || [])[i] || ''}`));
    const rows = t.columns.map(c => `<tr><td>${pk.has(K(c.name)) ? '🔑 ' : ''}<b>${esc(c.name)}</b></td><td class="mono">${esc(c.type)}</td><td>${c.nullable ? '' : 'NOT NULL'}</td><td class="mono">${esc(c.default || '')}</td>
<td>${fkOf.has(K(c.name)) ? `→ <a href="#t-${esc(K(fkOf.get(K(c.name)).split('.')[0]))}">${esc(fkOf.get(K(c.name)))}</a>` : ''}</td><td>${esc(cc(t.name, c.name))}</td></tr>`).join('');
    const idx = t.indexes.map(i => `<li>${esc(i.name)}${i.unique ? ' (уникальный)' : ''}: ${esc(i.columns.join(', '))}</li>`).join('');
    const chk = (t.checks || []).map(x => `<li class="mono">${esc(x.name)}: ${esc(x.def)}</li>`).join('');
    const refs = relIn.get(K(t.name)) || [];
    return `<section id="t-${esc(K(t.name))}"><h3>${esc(t.name)}${t.rowEstimate ? ` <span class="muted">~${t.rowEstimate} строк</span>` : ''}</h3>
${tc(t.name) ? `<p>${esc(tc(t.name))}</p>` : '<p class="muted">Без описания</p>'}
<table><tr><th>Колонка</th><th>Тип</th><th>NULL</th><th>По умолчанию</th><th>Ссылка</th><th>Описание</th></tr>${rows}</table>
${idx ? `<p><b>Индексы:</b></p><ul>${idx}</ul>` : ''}${chk ? `<p><b>Проверки:</b></p><ul>${chk}</ul>` : ''}
${refs.length ? `<p><b>На таблицу ссылаются:</b> ${refs.map(esc).join('; ')}</p>` : ''}</section>`;
  }).join('\n');
  const views = meta.views.map(v => `<li><b>${esc(v.name)}</b>${tc(v.name) ? ` — ${esc(tc(v.name))}` : ''}${v.columns ? ` <span class="muted">(${esc(v.columns.map(c => c.name || c).join(', ').slice(0, 200))})</span>` : ''}</li>`).join('');
  const routines = meta.routines.map(r => `<li class="mono">${esc(r.name)}${r.args ? `(${esc(r.args)})` : ''}${r.returns ? ` → ${esc(r.returns)}` : ''}</li>`).join('');
  const withRel = T.filter(t => (t.fks || []).length || relIn.has(K(t.name)));
  const er = erSvg(withRel.length > 1 ? withRel : T.slice(0, 40));
  const undocumented = T.filter(t => !tc(t.name)).length;
  const colsNoComment = T.reduce((s, t) => s + t.columns.filter(c => !cc(t.name, c.name)).length, 0);
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>${esc(info.title)}</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;margin:24px auto;max-width:1200px;color:#101828;padding:0 16px}h1{margin-bottom:4px}table{border-collapse:collapse;width:100%;margin:6px 0 10px}th,td{border:1px solid #e4e7ec;padding:4px 8px;font-size:13px;text-align:left;vertical-align:top}th{background:#f2f4f7}.mono{font-family:Consolas,monospace;font-size:12px}.muted{color:#667085;font-weight:normal;font-size:13px}section{margin:18px 0;padding-top:6px;border-top:1px solid #e4e7ec}ul{margin:4px 0}.er{overflow:auto;border:1px solid #e4e7ec;border-radius:6px;padding:6px;background:#fbfcff}@media print{.er{overflow:visible}section{break-inside:avoid}}</style></head><body>
<h1>${esc(info.title)}</h1><p class="muted">${esc(info.connection)} · схема ${esc(meta.schema)} · ${new Date().toLocaleString('ru-RU')} · таблиц ${T.length}, представлений ${meta.views.length}, подпрограмм ${meta.routines.length}.
Без описания: таблиц ${undocumented}, колонок ${colsNoComment}.</p>
<h2>Схема связей</h2><div class="er">${er}</div>
<h2>Таблицы</h2><ol>${toc}</ol>${tables}
${views ? `<h2>Представления</h2><ul>${views}</ul>` : ''}${routines ? `<h2>Процедуры и функции</h2><ul>${routines}</ul>` : ''}
${meta.sequences.length ? `<h2>Последовательности</h2><p class="mono">${meta.sequences.map(s => esc(s.name)).join(', ')}</p>` : ''}
</body></html>`;
}

function buildMarkdown(meta, cm, info) {
  const L = [`# ${info.title}`, '', `${info.connection}, схема ${meta.schema}, ${new Date().toLocaleString('ru-RU')}`, ''];
  for (const t of meta.tables) {
    L.push(`## ${t.name}`, '', cm.t.get(K(t.name)) || '_Без описания_', '', '| Колонка | Тип | NULL | Описание |', '|---|---|---|---|');
    const pk = new Set((t.pk ? t.pk.columns : []).map(K));
    for (const c of t.columns) L.push(`| ${pk.has(K(c.name)) ? '**' + c.name + '** (PK)' : c.name} | \`${c.type}\` | ${c.nullable ? '' : 'NOT NULL'} | ${(cm.c.get(`${K(t.name)}.${K(c.name)}`) || '').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
    for (const f of t.fks || []) L.push('', `- FK ${f.columns.join(', ')} → ${f.refTable}`);
    L.push('');
  }
  return L.join('\n');
}

async function runDocs(p, ctx) {
  const conn = getConnection(p.connId);
  const db = await connect(conn);
  try {
    ctx.progress(0, 0, 'Структура и комментарии…');
    let meta = await loadMeta(db, p.schema, { rowCounts: 'estimate' }, null);
    if (p.tables && p.tables.length) meta = { ...meta, tables: meta.tables.filter(t => p.tables.map(K).includes(K(t.name))) };
    const cm = await loadComments(db, p.schema);
    const info = { title: p.title || `Документация: ${p.schema}`, connection: conn.name };
    const id = `${p.schema}_${new Date().toISOString().slice(0, 10)}_${crypto.randomBytes(2).toString('hex')}`.replace(/[^\w.-]/g, '_');
    fs.writeFileSync(path.join(DIR, `${id}.html`), buildHtml(meta, cm, info));
    fs.writeFileSync(path.join(DIR, `${id}.md`), buildMarkdown(meta, cm, info));
    const undocumented = meta.tables.filter(t => !cm.t.get(K(t.name))).map(t => t.name);
    ctx.log(`Документация: ${meta.tables.length} таблиц, без описания ${undocumented.length}`);
    return { summary: { tables: meta.tables.length, views: meta.views.length, routines: meta.routines.length, undocumented: undocumented.length }, html: `/api/docs/${id}.html`, md: `/api/docs/${id}.md`, undocumented };
  } finally { await db.close(); }
}

module.exports = { runDocs, erSvg, buildHtml, DIR };
