'use strict';
// Понятные подсказки к ошибкам подключения (идея — из plsql2pg/checker.py, расширено для Oracle).

const RULES = [
  // ---------- PostgreSQL ----------
  [e => e.code === '28P01' || /password authentication failed/i.test(e.message),
    'Неверный пароль или имя пользователя PostgreSQL.'],
  [e => /client password must be a string|no password supplied|fe_sendauth/i.test(e.message),
    'Сервер требует пароль, а он не задан. Откройте подключение и введите пароль.'],
  [e => e.code === '3D000' || /database ".*" does not exist/i.test(e.message),
    'Такой базы нет на сервере — проверьте поле «База данных».'],
  [e => /role ".*" does not exist/i.test(e.message),
    'Такого пользователя нет на сервере PostgreSQL — проверьте имя пользователя.'],
  [e => /no pg_hba\.conf entry/i.test(e.message),
    'Сервер не разрешает подключение с этого компьютера (pg_hba.conf) — обратитесь к администратору. Если на сервере требуется SSL, включите галочку SSL.'],
  [e => /does not support SSL/i.test(e.message),
    'Сервер не поддерживает SSL — снимите галочку SSL в подключении.'],
  [e => /self.signed certificate|unable to verify the first certificate/i.test(e.message),
    'Сертификат сервера не прошёл проверку.'],
  [e => e.code === '42501' || /permission denied/i.test(e.message),
    'Недостаточно прав у пользователя на этот объект или действие.'],
  // ---------- Oracle ----------
  [e => /ORA-01017/.test(e.message), 'Неверное имя пользователя или пароль Oracle.'],
  [e => /ORA-28000/.test(e.message), 'Учётная запись Oracle заблокирована — обратитесь к администратору (ALTER USER … ACCOUNT UNLOCK).'],
  [e => /ORA-28001/.test(e.message), 'Срок действия пароля Oracle истёк — смените пароль (например, в SQL Developer).'],
  [e => /ORA-12514|NJS-518/.test(e.message),
    'Сервис с таким именем не зарегистрирован в listener. Проверьте Service name (часто это имя PDB, например ORCLPDB1) или переключите тип на SID.'],
  [e => /ORA-12505|NJS-519/.test(e.message), 'Listener не знает такой SID — проверьте SID или переключите тип на Service name.'],
  [e => /ORA-12541|NJS-511/.test(e.message), 'На этом хосте и порту нет listener Oracle — проверьте адрес и порт (обычно 1521).'],
  [e => /NJS-116|NJS-138|password verifier type|not supported by node-oracledb in Thin mode/i.test(e.message),
    'Эта версия Oracle или тип пароля (10G) не поддерживаются в Thin-режиме. Установите Oracle Instant Client и укажите его папку в Настройках (Thick-режим), затем перезапустите приложение.'],
  [e => /ORA-00942/.test(e.message), 'Таблица или представление не найдены либо у пользователя нет прав на них (для метаданных нужен доступ к ALL_*-представлениям).'],
  [e => /ORA-01031/.test(e.message), 'Недостаточно привилегий Oracle для этого действия.'],
  [e => /ORA-39001|ORA-39006|ORA-31626/.test(e.message), 'Ошибка Data Pump: проверьте права DATAPUMP_IMP_FULL_DATABASE / DATAPUMP_EXP_FULL_DATABASE и что DB link работает.'],
  [e => /ORA-02019|ORA-12154/.test(e.message), 'DB link не может подключиться к источнику: проверьте строку подключения источника с сервера-приёмника.'],
  // ---------- Сеть ----------
  [e => e.code === 'ECONNREFUSED' || /ECONNREFUSED|NJS-503|connection refused/i.test(e.message),
    'Сервер отклонил подключение — проверьте хост и порт, запущена ли СУБД и не закрыт ли порт брандмауэром.'],
  [e => e.code === 'ENOTFOUND' || /ENOTFOUND|getaddrinfo/i.test(e.message), 'Не удалось найти хост по имени — проверьте адрес сервера.'],
  [e => e.code === 'ETIMEDOUT' || /timeout|timed out|NJS-510|NJS-501/i.test(e.message),
    'Сервер не ответил вовремя — проверьте адрес, порт и доступность сервера по сети (VPN).'],
  [e => e.code === 'ECONNRESET', 'Соединение разорвано сервером или сетью.'],
];

function hintFor(err) {
  if (!err) return null;
  const e = { code: err.code, message: String(err.message || err) };
  for (const [test, hint] of RULES) { try { if (test(e)) return hint; } catch { /* */ } }
  return null;
}

/** Сообщение об ошибке с подсказкой «что сделать» */
function explain(err) {
  const msg = String(err && err.message ? err.message : err);
  const hint = hintFor(err);
  return hint && !msg.includes(hint) ? `${hint}\n\nОтвет сервера: ${msg}` : msg;
}

module.exports = { explain, hintFor };
