// Поиск связанных объектов по графу зависимостей (from зависит от to).
// direction: 'deps' — от чего зависят выбранные (родительские таблицы, таблицы представлений…),
//            'dependents' — что зависит от выбранных (дочерние таблицы, триггеры, представления…), 'both'.
export function relatedKeys(deps, selected, { direction = 'deps', recursive = true, onlyTypes = null } = {}) {
  const fwd = new Map(), back = new Map();
  for (const d of deps) {
    (fwd.get(d.from) || fwd.set(d.from, []).get(d.from)).push(d.to);
    (back.get(d.to) || back.set(d.to, []).get(d.to)).push(d.from);
  }
  const result = new Set(selected);
  let frontier = [...selected];
  while (frontier.length) {
    const next = [];
    for (const k of frontier) {
      const nb = [
        ...(direction !== 'dependents' ? fwd.get(k) || [] : []),
        ...(direction !== 'deps' ? back.get(k) || [] : []),
      ];
      for (const n of nb) {
        if (onlyTypes && !onlyTypes.includes(n.split(':')[0])) continue;
        if (!result.has(n)) { result.add(n); next.push(n); }
      }
    }
    if (!recursive) break;
    frontier = next;
  }
  return [...result];
}

export const TYPE_NAMES = {
  table: 'Таблица', view: 'Представление', mview: 'Мат. представление', sequence: 'Последовательность',
  function: 'Функция', procedure: 'Процедура', package: 'Пакет', trigger: 'Триггер', type: 'Тип',
};
