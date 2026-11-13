import notify from 'devextreme/ui/notify';

async function req(method, url, body) {
  const r = await fetch('/api' + url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

export const api = {
  get: u => req('GET', u),
  post: (u, b) => req('POST', u, b || {}),
  put: (u, b) => req('PUT', u, b),
  del: u => req('DELETE', u),
};

export const toast = (message, type = 'success') =>
  notify({ message, type, displayTime: type === 'error' ? 6000 : 2500, width: 'auto', position: { at: 'bottom right', my: 'bottom right', offset: '-20 -20' } });

export async function safe(fn) {
  try { return await fn(); } catch (e) { toast(e.message, 'error'); return undefined; }
}

export const fmtMs = ms => (ms == null ? '' : ms < 1000 ? `${ms} мс` : `${(ms / 1000).toFixed(1)} с`);
export const fmtNum = n => (n == null ? '' : Number(n).toLocaleString('ru-RU'));
export const fmtSize = b => (b == null ? '' : b > 1048576 ? `${(b / 1048576).toFixed(1)} МБ` : `${Math.ceil(b / 1024)} КБ`);
export const STATUS = { ok: 'Совпадает', warning: 'Предупреждение', error: 'Ошибка', equal: 'Совпадает', different: 'Отличается', skipped: 'Пропущено', done: 'Готово', running: 'Выполняется', cancelled: 'Отменено' };
