'use strict';
// Маскирование персональных данных: детерминированные подстановки (одно и то же исходное значение
// всегда даёт одну и ту же замену — связи и соединения по маскированным колонкам сохраняются).
const crypto = require('crypto');

const LAST_M = ['Иванов', 'Смирнов', 'Кузнецов', 'Попов', 'Васильев', 'Петров', 'Соколов', 'Михайлов', 'Новиков', 'Фёдоров', 'Морозов', 'Волков', 'Алексеев', 'Лебедев', 'Семёнов', 'Егоров', 'Павлов', 'Козлов', 'Степанов', 'Николаев', 'Орлов', 'Андреев', 'Макаров', 'Никитин', 'Захаров', 'Зайцев', 'Соловьёв', 'Борисов', 'Яковлев', 'Григорьев', 'Романов', 'Воробьёв', 'Сергеев', 'Кириллов', 'Медведев', 'Тарасов'];
const FIRST_M = ['Александр', 'Дмитрий', 'Максим', 'Сергей', 'Андрей', 'Алексей', 'Артём', 'Илья', 'Кирилл', 'Михаил', 'Никита', 'Матвей', 'Роман', 'Егор', 'Иван', 'Павел', 'Владимир', 'Олег', 'Николай', 'Евгений', 'Виктор', 'Юрий', 'Константин', 'Денис'];
const FIRST_F = ['Анна', 'Мария', 'Елена', 'Ольга', 'Наталья', 'Татьяна', 'Ирина', 'Светлана', 'Екатерина', 'Юлия', 'Анастасия', 'Дарья', 'Марина', 'Людмила', 'Галина', 'Виктория', 'Полина', 'Ксения', 'Вера', 'Алина', 'Надежда', 'Валентина', 'Софья', 'Евгения'];
const MIDDLE_M = ['Александрович', 'Дмитриевич', 'Сергеевич', 'Андреевич', 'Алексеевич', 'Михайлович', 'Иванович', 'Петрович', 'Николаевич', 'Владимирович', 'Олегович', 'Викторович', 'Юрьевич', 'Павлович', 'Евгеньевич'];
const MIDDLE_F = MIDDLE_M.map(m => m.replace(/ич$/, 'на'));
const CITIES = ['Москва', 'Санкт-Петербург', 'Новосибирск', 'Екатеринбург', 'Казань', 'Нижний Новгород', 'Самара', 'Омск', 'Ростов-на-Дону', 'Уфа', 'Пермь', 'Воронеж', 'Волгоград', 'Краснодар', 'Тюмень', 'Иркутск'];
const STREETS = ['Ленина', 'Советская', 'Мира', 'Молодёжная', 'Школьная', 'Садовая', 'Лесная', 'Центральная', 'Новая', 'Набережная', 'Заводская', 'Полевая', 'Гагарина', 'Пушкина', 'Кирова', 'Строителей'];

const female = s => /(ая|на|ва|ина|ова|ева|ёва|ская|цкая)$/i.test(String(s || '').trim().split(/\s+/)[0]) || /(вна|чна|кызы)$/i.test(String(s || '').trim());
function feminize(last) { return /(ов|ев|ёв|ин)$/.test(last) ? last + 'а' : /ий$/.test(last) ? last.replace(/ий$/, 'ая') : last; }

function makeMasker(secret = 'dbcompare') {
  const h = (v, salt = '') => crypto.createHmac('sha256', secret).update(salt + '\u0001' + String(v)).digest();
  const pick = (arr, v, salt) => arr[h(v, salt).readUInt32BE(0) % arr.length];
  const num = (v, salt, mod) => h(v, salt).readUInt32BE(4) % mod;
  const digits = (v, salt) => { const d = h(v, salt); let i = 0; return String(v).replace(/\d/g, () => String(d[i++ % d.length] % 10)); };
  const caseLike = (orig, s) => (orig === orig.toUpperCase() && /[А-ЯA-Z]/.test(orig) ? s.toUpperCase() : s);

  const methods = {
    keep: v => v,
    null: () => null,
    constant: (v, o) => (o && o.value != null ? o.value : '***'),
    lastname: v => { const f = female(v); const l = pick(LAST_M, v, 'l'); return caseLike(String(v), f ? feminize(l) : l); },
    firstname: v => caseLike(String(v), /[ая]$/i.test(String(v).trim()) && !/(илья|никита|кузьма|фома)$/i.test(String(v).trim()) ? pick(FIRST_F, v, 'f') : pick(FIRST_M, v, 'f')),
    middlename: v => caseLike(String(v), /(вна|чна)$/i.test(String(v).trim()) ? pick(MIDDLE_F, v, 'm') : pick(MIDDLE_M, v, 'm')),
    fullname: v => {
      const s = String(v).trim(); const f = female(s);
      const l = pick(LAST_M, s, 'l');
      const parts = [f ? feminize(l) : l, pick(f ? FIRST_F : FIRST_M, s, 'f')];
      if (s.split(/\s+/).length >= 3) parts.push(pick(f ? MIDDLE_F : MIDDLE_M, s, 'm'));
      if (/^\S+\s+[А-ЯA-Z]\.\s*[А-ЯA-Z]\.?$/.test(s)) return caseLike(s, `${parts[0]} ${parts[1][0]}.${parts[2] ? parts[2][0] + '.' : ''}`);
      return caseLike(s, parts.join(' '));
    },
    phone: v => { const s = String(v); const m = /^(\s*(?:\+7|8|7)?)/.exec(s); return m[1] + digits(s.slice(m[1].length), 'p'); },
    email: v => { const s = String(v); return `user${h(s, 'e').toString('hex').slice(0, 8)}@example.ru`; },
    digits: v => digits(v, 'd'),
    passport: v => digits(v, 'pp'),
    snils: v => {
      const s = String(v); const d = h(s, 's'); const n = Array.from({ length: 9 }, (_, i) => d[i] % 10);
      let sum = n.reduce((a, x, i) => a + x * (9 - i), 0); let c = sum < 100 ? sum : sum === 100 || sum === 101 ? 0 : sum % 101; if (c === 100) c = 0;
      const ds = n.join('') + String(c).padStart(2, '0');
      return /-/.test(s) ? `${ds.slice(0, 3)}-${ds.slice(3, 6)}-${ds.slice(6, 9)} ${ds.slice(9)}` : ds;
    },
    inn: v => {
      const s = String(v).replace(/\D/g, ''); const d = h(s, 'i');
      if (s.length === 10) { const n = Array.from({ length: 9 }, (_, i) => d[i] % 10); const w = [2, 4, 10, 3, 5, 9, 4, 6, 8]; n.push((n.reduce((a, x, i) => a + x * w[i], 0) % 11) % 10); return n.join(''); }
      const n = Array.from({ length: 10 }, (_, i) => d[i] % 10);
      const w1 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8], w2 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
      n.push((n.reduce((a, x, i) => a + x * w1[i], 0) % 11) % 10); n.push((n.reduce((a, x, i) => a + x * w2[i], 0) % 11) % 10); return n.join('');
    },
    address: v => `г. ${pick(CITIES, v, 'c')}, ул. ${pick(STREETS, v, 's')}, д. ${1 + num(v, 'h', 150)}${num(v, 'k', 3) ? `, кв. ${1 + num(v, 'a', 300)}` : ''}`,
    date_shift: v => {
      const shift = (num(v, 'ds', 361) - 180) * 864e5;
      if (v instanceof Date) return new Date(v.getTime() + shift);
      const s = String(v); const m = /^(\d{4}-\d{2}-\d{2})(.*)$/.exec(s);
      if (!m) return v;
      const d = new Date(m[1] + 'T00:00:00Z'); d.setTime(d.getTime() + shift);
      return d.toISOString().slice(0, 10) + m[2];
    },
    scramble: v => { const d = h(v, 'sc'); let i = 0; return String(v).replace(/[А-Яа-яЁёA-Za-z]/g, ch => { const b = d[i++ % d.length]; const up = ch === ch.toUpperCase(); const cyr = /[А-Яа-яЁё]/.test(ch); const c = cyr ? 'абвгдежзиклмнопрстуфхцчшэюя'[b % 27] : 'abcdefghijklmnopqrstuvwxyz'[b % 26]; return up ? c.toUpperCase() : c; }).replace(/\d/g, () => String(d[i++ % d.length] % 10)); },
    hash: v => h(v, 'x').toString('hex').slice(0, 16),
  };
  /** Функция маскирования значения; null/пустые строки не трогаем. */
  return (method, opts) => {
    const f = methods[method];
    if (!f) throw new Error(`Неизвестный способ маскирования: ${method}`);
    return v => (v === null || v === undefined || v === '' ? v : f(v, opts));
  };
}

const METHODS = {
  lastname: 'Фамилия', firstname: 'Имя', middlename: 'Отчество', fullname: 'ФИО целиком', phone: 'Телефон', email: 'E-mail', passport: 'Паспорт (цифры)',
  snils: 'СНИЛС (с контрольной суммой)', inn: 'ИНН (с контрольной суммой)', digits: 'Цифры (карта, счёт)', address: 'Адрес', date_shift: 'Дата ±180 дней',
  scramble: 'Перемешать буквы и цифры', hash: 'Хеш', constant: 'Константа', null: 'Пусто (NULL)', keep: 'Не маскировать',
};

// Распознавание по имени колонки
const NAME_RULES = [
  [/^(fio|full_?name|fullname|polnoe_?imya|fio_?\w*)$/i, 'fullname'],
  [/(^|_)(fam|familiya|familia|surname|last_?name|lname)(_|$)/i, 'lastname'],
  [/(^|_)(imya|im|first_?name|fname|given_?name)(_|$)/i, 'firstname'],
  [/(^|_)(otch|otchestvo|middle_?name|patronymic|mname)(_|$)/i, 'middlename'],
  [/(^|_)(phone|tel|telefon|mobile|mob|sms|phone_?num\w*)(_|$)/i, 'phone'],
  [/(^|_)(e?mail|email_?addr\w*)(_|$)/i, 'email'],
  [/(^|_)(snils)(_|$)/i, 'snils'],
  [/(^|_)(inn)(_|$)/i, 'inn'],
  [/(^|_)(pasp\w*|passport\w*|doc_?(num|ser)\w*|ser_?num)(_|$)/i, 'passport'],
  [/(^|_)(adr|addr|address|adres\w*|mesto_?zhit\w*)(_|$)/i, 'address'],
  [/(^|_)(birth\w*|dr|d_?rozh\w*|data_?rozh\w*|dob|bdate)(_|$)/i, 'date_shift'],
  [/(^|_)(card|karta|kart|pan|schet|account|acc_?num|rs|ks|bik_?schet)(_|$)/i, 'digits'],
];
// Распознавание по значениям
function byValues(samples) {
  const s = samples.filter(x => x != null && String(x).trim() !== '').map(String).slice(0, 200);
  if (s.length < 5) return null;
  const share = re => s.filter(x => re.test(x.trim())).length / s.length;
  if (share(/^[^@\s]+@[^@\s]+\.[a-zа-я]{2,}$/i) > 0.8) return 'email';
  if (share(/^\d{3}-\d{3}-\d{3} \d{2}$/) > 0.8) return 'snils';
  if (share(/^(\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}$/) > 0.8) return 'phone';
  if (share(/^[А-ЯЁ][а-яё]+(-[А-ЯЁ][а-яё]+)? [А-ЯЁ][а-яё]+( [А-ЯЁ][а-яё]+)?$/) > 0.7) return 'fullname';
  if (share(/^[А-ЯЁ][а-яё]+ [А-ЯЁ]\.\s?[А-ЯЁ]\.$/) > 0.7) return 'fullname';
  if (share(/^\d{4}\s?\d{6}$/) > 0.8) return 'passport';
  if (share(/^\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}$/) > 0.8) return 'digits';
  if (share(/(ул\.|улица|пр-т|проспект|д\.\s?\d|кв\.)/i) > 0.6) return 'address';
  return null;
}
function detectColumn(table, col, samples) {
  if (!['string', 'text', 'date', 'datetime', 'int', 'numeric'].includes(col.family)) return null;
  for (const [re, m] of NAME_RULES) {
    if (!re.test(col.name)) continue;
    if (m === 'date_shift' && !['date', 'datetime'].includes(col.family)) continue;
    if (m !== 'date_shift' && ['date', 'datetime'].includes(col.family)) continue;
    if (['int', 'numeric'].includes(col.family) && !['inn', 'phone', 'digits', 'snils', 'passport'].includes(m)) continue;
    return { method: m, reason: `имя колонки «${col.name}»` };
  }
  if (['string', 'text'].includes(col.family) && samples) {
    const m = byValues(samples);
    if (m) return { method: m, reason: 'по значениям' };
  }
  return null;
}

module.exports = { makeMasker, detectColumn, METHODS, byValues };
