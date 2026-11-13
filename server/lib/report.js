'use strict';
// Автономный HTML-отчёт по задаче сравнения — удобно отправить коллегам.
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ST = { ok: 'Совпадает', warning: 'Предупреждение', error: 'Ошибка', equal: 'Совпадает', different: 'Отличается', skipped: 'Пропущено' };

const CSS = `
body{font:14px/1.45 -apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px;color:#1d2433;background:#fafbfc}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
.meta{color:#5b6475;margin-bottom:16px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}
.card{background:#fff;border:1px solid #e3e6eb;border-radius:8px;padding:10px 16px;min-width:120px}
.card b{display:block;font-size:22px}
table{border-collapse:collapse;width:100%;background:#fff;margin-bottom:8px}
th,td{border:1px solid #e3e6eb;padding:5px 8px;text-align:left;vertical-align:top;font-size:13px}
th{background:#f2f4f7;position:sticky;top:0}
.ok,.equal{color:#18794e}.warning{color:#a35200}.error,.different{color:#c62828}
code{font:12px Consolas,monospace;background:#f2f4f7;padding:1px 4px;border-radius:3px}
details{margin:6px 0}summary{cursor:pointer}
`;

function head(title, job) {
  const r = job.result || {};
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>
<h1>${esc(title)}</h1>
<div class="meta">Источник: <b>${esc(r.source && r.source.name)}</b> (${esc(r.source && r.source.type)}) / ${esc(r.source && r.source.schema)}
 &nbsp;→&nbsp; Приёмник: <b>${esc(r.target && r.target.name)}</b> (${esc(r.target && r.target.type)}) / ${esc(r.target && r.target.schema)}<br>
Запуск: ${esc(job.startedAt)} · Завершено: ${esc(job.finishedAt)} · Статус: ${esc(job.status)}</div>`;
}

function schemaReport(job) {
  const r = job.result;
  let h = head('Сравнение схем', job);
  h += `<div class="cards"><div class="card">Совпадает<b class="ok">${r.summary.ok}</b></div><div class="card">Предупреждений<b class="warning">${r.summary.warning}</b></div><div class="card">Ошибок<b class="error">${r.summary.error}</b></div><div class="card">Таблиц источник / приёмник<b>${r.summary.sourceTables} / ${r.summary.targetTables}</b></div></div>`;
  h += `<h2>По категориям</h2><table><tr><th>Категория</th><th>Совпадает</th><th>Предупреждения</th><th>Ошибки</th></tr>`;
  for (const c of r.categories) h += `<tr><td>${esc(c.category)}</td><td class="ok">${c.ok}</td><td class="warning">${c.warning}</td><td class="error">${c.error}</td></tr>`;
  h += `</table><h2>Расхождения</h2><table><tr><th>Категория</th><th>Объект</th><th>Статус</th><th>Источник</th><th>Приёмник</th><th>Комментарий</th></tr>`;
  for (const f of r.findings.filter(f => f.status !== 'ok')) {
    h += `<tr><td>${esc(f.category)}</td><td><code>${esc(f.object)}</code></td><td class="${f.status}">${ST[f.status]}</td><td>${esc(f.source)}</td><td>${esc(f.target)}</td><td>${esc(f.message)}</td></tr>`;
  }
  return h + '</table></body></html>';
}

function dataReport(job) {
  const r = job.result;
  const s = r.summary;
  let h = head('Сравнение данных', job);
  h += `<div class="cards"><div class="card">Таблиц<b>${s.tables}</b></div><div class="card">Совпадают<b class="ok">${s.equal || 0}</b></div><div class="card">Отличаются<b class="error">${s.different || 0}</b></div><div class="card">Ошибок<b class="error">${s.error || 0}</b></div><div class="card">Нет в приёмнике / лишние / разные<b>${s.missing} / ${s.extra} / ${s.differentRows}</b></div></div>`;
  h += `<table><tr><th>Таблица</th><th>Статус</th><th>Строк источник</th><th>Строк приёмник</th><th>Нет в приёмнике</th><th>Лишние</th><th>Различаются</th><th>Режим</th><th>Время, с</th></tr>`;
  for (const t of r.tables) {
    h += `<tr><td>${esc(t.table)}</td><td class="${t.status}">${ST[t.status] || esc(t.status)}${t.error ? ': ' + esc(t.error) : ''}</td><td>${t.sourceRows ?? ''}</td><td>${t.targetRows ?? ''}</td><td>${t.missing ?? ''}</td><td>${t.extra ?? ''}</td><td>${t.different ?? ''}</td><td>${esc(t.mode)}</td><td>${t.ms != null ? (t.ms / 1000).toFixed(1) : ''}</td></tr>`;
  }
  h += '</table>';
  for (const t of r.tables.filter(t => t.diffs && t.diffs.length)) {
    h += `<details><summary><b>${esc(t.table)}</b> — примеры отличий (${t.diffs.length})</summary><table><tr><th>Тип</th><th>Ключ</th><th>Подробности</th></tr>`;
    for (const d of t.diffs) {
      const type = { missing_in_target: 'Нет в приёмнике', extra_in_target: 'Лишняя в приёмнике', different: 'Отличается' }[d.type];
      const det = d.columns ? d.columns.map(c => `<code>${esc(c.name)}</code>: ${esc(c.source)} → ${esc(c.target)}`).join('<br>') : esc(JSON.stringify(d.row));
      h += `<tr><td>${type}</td><td>${esc(JSON.stringify(d.key))}</td><td>${det}</td></tr>`;
    }
    h += '</table></details>';
  }
  return h + '</body></html>';
}

function renderReport(job) {
  if (!job.result) return `<!DOCTYPE html><meta charset="utf-8"><p>Нет результата (${esc(job.status)}): ${esc(job.error)}</p>`;
  if (job.type === 'schema-compare') return schemaReport(job);
  if (job.type === 'data-compare') return dataReport(job);
  return `<!DOCTYPE html><meta charset="utf-8"><pre>${esc(JSON.stringify(job.result, null, 2))}</pre>`;
}

module.exports = { renderReport };
