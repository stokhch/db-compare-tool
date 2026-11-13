'use strict';
// Фильтр периода и пользователя — один раз задаётся и применяется ко всем таблицам, где есть нужные колонки.
// Типовая схема расчётных таблиц: d_beg/d_end — период, prognoz — признак прогноза (0 — факт),
// u_m — пользователь, под которым считали (в Oracle USER — заглавными; plsql2pg пишет upper(current_user)),
// суточные таблицы — колонка даты (sv_date и т. п.).
//
// period = {
//   from: 'YYYY-MM-DD', to: 'YYYY-MM-DD',
//   startColumn: 'd_beg', endColumn: 'd_end', periodMatch: 'exact' | 'overlap',
//   dayColumns: 'sv_date, dt',             // суточные/событийные даты: BETWEEN from AND to
//   prognozColumn: 'prognoz', onlyFact: true, // coalesce(prognoz, 0) = 0
//   userColumn: 'u_m', userMode: 'session' | 'value' | 'none', userSource: 'TEC22', userTarget: 'TEC22'
// }

const D_RE = /^\d{4}-\d\d-\d\d$/;
const lc = s => String(s || '').trim().toLowerCase();
const list = s => String(s || '').split(/[,\s]+/).map(lc).filter(Boolean);
const lit = s => `'${String(s).replace(/'/g, "''")}'`;

function findCol(table, name) {
  if (!name) return null;
  return table.columns.find(c => lc(c.name) === lc(name)) || null;
}

/**
 * Условие WHERE для таблицы в диалекте db. side: 'source' | 'target' (для пользователя).
 * Возвращает { where, parts: [описание], applied: bool }
 */
function periodWhere(db, table, period, side = 'source') {
  if (!period || !table) return { where: '', parts: [] };
  const q = c => db.quote(c.name);
  const parts = [], desc = [];
  const hasDates = D_RE.test(period.from || '') && D_RE.test(period.to || '');
  if (hasDates) {
    const f = `DATE '${period.from}'`, t = `DATE '${period.to}'`;
    const cs = findCol(table, period.startColumn || 'd_beg'), ce = findCol(table, period.endColumn || 'd_end');
    if (cs && ce) {
      if (period.periodMatch === 'overlap') { parts.push(`${q(cs)} <= ${t} AND ${q(ce)} >= ${f}`); desc.push(`${cs.name}/${ce.name} пересекает период`); }
      else { parts.push(`${q(cs)} = ${f} AND ${q(ce)} = ${t}`); desc.push(`${cs.name}..${ce.name} = период`); }
    } else {
      const day = list(period.dayColumns || 'sv_date').map(n => findCol(table, n)).find(Boolean);
      if (day) {
        // до конца последнего дня включительно (колонка может хранить время)
        const end = db.type === 'oracle' ? `${t} + 1` : `${t} + INTERVAL '1 day'`;
        parts.push(`${q(day)} >= ${f} AND ${q(day)} < ${end}`);
        desc.push(`${day.name} в периоде`);
      }
    }
  }
  if (period.onlyFact !== false) {
    const cp = findCol(table, period.prognozColumn || 'prognoz');
    if (cp) { parts.push(`${db.type === 'oracle' ? 'NVL' : 'coalesce'}(${q(cp)}, 0) = 0`); desc.push(`${cp.name} = 0`); }
  }
  const mode = period.userMode || 'none';
  if (mode !== 'none') {
    const cu = findCol(table, period.userColumn || 'u_m');
    if (cu) {
      if (mode === 'session') {
        parts.push(`${q(cu)} = ${db.type === 'oracle' ? 'USER' : 'upper(current_user)'}`);
        desc.push(`${cu.name} = текущий пользователь`);
      } else {
        const v = side === 'source' ? period.userSource : (period.userTarget || period.userSource);
        if (v) { parts.push(`${q(cu)} = ${lit(v)}`); desc.push(`${cu.name} = ${v}`); }
      }
    }
  }
  return { where: parts.join(' AND '), parts: desc, applied: parts.length > 0 };
}

const andWhere = (...w) => w.filter(x => x && String(x).trim()).map(x => `(${x})`).join(' AND ');

module.exports = { periodWhere, andWhere };
