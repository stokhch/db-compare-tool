<template>
  <div>
    <h2 class="page">Браузер объектов</h2>
    <div class="row" style="align-items:flex-start">
      <!-- список объектов -->
      <div class="panel left">
        <DbPicker v-model="db" label="База" />
        <DxTextBox v-model:value="filter" mode="search" placeholder="Фильтр по имени" value-change-event="input" style="margin:6px 0" />
        <DxSelectBox v-model:value="typeFilter" :items="typeItems" value-expr="v" display-expr="t" />
        <div class="olist">
          <template v-for="g in groups" :key="g.type">
            <div class="ghead" @click="collapsed[g.type] = !collapsed[g.type]">{{ collapsed[g.type] ? '▸' : '▾' }} {{ TYPES[g.type] || g.type }} <span class="hint">{{ g.items.length }}</span></div>
            <template v-if="!collapsed[g.type]">
              <div v-for="o in g.items.slice(0, 500)" :key="o.type + o.name" class="oitem" :class="{ sel: cur && cur.type === o.type && cur.name === o.name }" @click="open(o)">{{ ICONS[o.type] || '•' }} {{ o.name }}</div>
            </template>
          </template>
          <div v-if="loadingList" class="hint">Загрузка…</div>
          <div v-else-if="!objects.length" class="hint">Выберите базу и схему</div>
        </div>
      </div>

      <!-- карточка объекта -->
      <div class="panel right">
        <div v-if="!cur" class="hint">Выберите объект слева. Двойной щелчок по зависимости открывает связанный объект.</div>
        <template v-else>
          <div class="toolbar">
            <span style="font-size:18px">{{ ICONS[cur.type] }}</span><b style="font-size:16px">{{ cur.name }}</b><span class="hint">{{ TYPES[cur.type] }}</span>
            <span v-if="det && det.comment" class="hint">— {{ det.comment }}</span>
            <span style="flex:1" />
            <DxButton icon="refresh" styling-mode="text" hint="Обновить" @click="open(cur)" />
            <DxButton v-if="['table', 'view', 'mview'].includes(cur.type)" text="В SQL-консоль" icon="activefolder" styling-mode="text" @click="toConsole(`SELECT * FROM ${qualified}`)" />
            <DxButton v-if="cur.type === 'table'" :text="isOra ? 'Собрать статистику' : 'ANALYZE'" styling-mode="text" @click="action('analyze')" />
            <DxButton v-if="cur.type === 'table' && !isOra" text="VACUUM" styling-mode="text" @click="action('vacuum')" />
            <DxButton v-if="cur.type === 'mview'" text="Обновить данные" styling-mode="text" @click="action('refresh')" />
            <DxButton v-if="isOra && CODE.includes(cur.type)" text="Перекомпилировать" icon="repeat" styling-mode="text" @click="action('compile')" />
          </div>
          <DxTabs :items="tabItems" :selected-index="tabIndex" @item-click="e => (tab = tabItems[e.itemIndex].key)" />
          <div v-if="loading" class="hint" style="padding:10px">Загрузка…</div>
          <div v-else-if="det" class="tabbody">
            <!-- данные -->
            <template v-if="tab === 'data'">
              <div class="toolbar">
                <DxTextBox v-model:value="where" :width="460" placeholder="Условие WHERE, например dept_id = 1" @enter-key="reloadData" />
                <DxButton text="Применить" styling-mode="outlined" @click="reloadData" />
                <DxCheckBox v-if="cur.type === 'table'" v-model:value="editable" :disabled="!det.pk" :text="det.pk ? 'Разрешить правку' : 'Правка недоступна: нет первичного ключа'" />
                <span v-if="editable" class="warning">Изменения сохраняются кнопкой «Сохранить» в таблице одной транзакцией</span>
              </div>
              <DxDataGrid ref="grid" :key="gridKey" :data-source="store" :remote-operations="{ paging: true, sorting: true }" :show-borders="true" :height="560"
                :column-auto-width="true" :allow-column-resizing="true" @saving="onSaving" @init-new-row="e => (e.data = {})">
                <DxPaging :page-size="50" /><DxPager :visible="true" :show-info="true" info-text="Страница {0} из {1} (строк: {2})" />
                <DxEditing :mode="'batch'" :allow-updating="editable" :allow-adding="editable" :allow-deleting="editable" :confirm-delete="false" />
              </DxDataGrid>
            </template>
            <!-- колонки -->
            <DxDataGrid v-if="tab === 'columns'" :data-source="det.columns" :show-borders="true" :word-wrap-enabled="true">
              <DxColumn data-field="pos" caption="№" :width="50" />
              <DxColumn data-field="name" caption="Колонка" cell-template="cn" />
              <DxColumn data-field="type" caption="Тип" css-class="mono" />
              <DxColumn data-field="nullable" caption="NULL" :width="70" :calculate-display-value="r => (r.nullable ? '' : 'NOT NULL')" />
              <DxColumn data-field="default" caption="По умолчанию" css-class="mono" />
              <DxColumn data-field="comment" caption="Описание" />
              <template #cn="{ data }"><span>{{ data.data.pk ? '🔑 ' : '' }}<b>{{ data.value }}</b></span></template>
            </DxDataGrid>
            <DxDataGrid v-if="tab === 'constraints'" :data-source="det.constraints" :show-borders="true" :word-wrap-enabled="true" no-data-text="Ограничений нет">
              <DxColumn data-field="kind" caption="Вид" :width="130" /><DxColumn data-field="name" caption="Имя" :width="220" /><DxColumn data-field="def" caption="Определение" css-class="mono" /><DxColumn data-field="status" caption="Состояние" :width="120" />
            </DxDataGrid>
            <DxDataGrid v-if="tab === 'indexes'" :data-source="det.indexes" :show-borders="true" :word-wrap-enabled="true" no-data-text="Индексов нет">
              <DxColumn data-field="name" caption="Индекс" :width="220" /><DxColumn data-field="def" caption="Определение" css-class="mono" />
              <DxColumn data-field="sizeMb" caption="МБ" :width="70" /><DxColumn data-field="scans" caption="Обращений" :width="100" /><DxColumn data-field="status" caption="Состояние" :width="110" />
            </DxDataGrid>
            <DxDataGrid v-if="tab === 'triggers'" :data-source="det.triggers" :show-borders="true" :word-wrap-enabled="true" no-data-text="Триггеров нет">
              <DxColumn data-field="name" caption="Триггер" :width="220" /><DxColumn data-field="def" caption="Определение" css-class="mono" /><DxColumn data-field="status" caption="Состояние" :width="110" />
            </DxDataGrid>
            <div v-if="tab === 'deps'" class="row">
              <div class="col"><b>Использует</b>
                <div v-for="d in det.uses" :key="d.object" class="dep" @dblclick="openRef(d.object)">{{ ICONS[d.object.split(':')[0]] }} {{ d.object.split(':').slice(1).join(':') }} <span class="hint">{{ d.kind }}</span></div>
                <div v-if="!det.uses.length" class="hint">ничего</div></div>
              <div class="col"><b>Используется в</b>
                <div v-for="d in det.usedBy" :key="d.object" class="dep" @dblclick="openRef(d.object)">{{ ICONS[d.object.split(':')[0]] }} {{ d.object.split(':').slice(1).join(':') }} <span class="hint">{{ d.kind }}</span></div>
                <div v-if="!det.usedBy.length" class="hint">нигде (по данным словаря)</div></div>
            </div>
            <template v-if="tab === 'source' || tab === 'ddl'">
              <div class="toolbar"><DxButton text="Копировать" icon="copy" styling-mode="text" @click="copy(tab === 'ddl' ? det.ddl : det.source)" />
                <DxButton text="Открыть в SQL-консоли" icon="activefolder" styling-mode="text" @click="toConsole(tab === 'ddl' ? det.ddl : det.source)" /></div>
              <pre class="code"><template v-for="(l, i) in lines(tab === 'ddl' ? det.ddl : det.source)" :key="i"><span class="ln">{{ String(i + 1).padStart(4) }}</span><span :class="{ errline: errLines.has(i + 1) && tab === 'source' }">{{ l }}</span>
</template></pre>
            </template>
            <template v-if="tab === 'errors'">
              <div v-if="det.errorsNote" class="hint">{{ det.errorsNote }}</div>
              <div v-else-if="!det.errors || !det.errors.length" class="ok">Ошибок компиляции нет</div>
              <DxDataGrid v-else :data-source="det.errors" :show-borders="true" :word-wrap-enabled="true">
                <DxColumn data-field="type" caption="Часть" :width="120" /><DxColumn data-field="line" caption="Строка" :width="70" /><DxColumn data-field="level" caption="" :width="90" /><DxColumn data-field="text" caption="Сообщение" css-class="mono" />
              </DxDataGrid>
            </template>
            <DxDataGrid v-if="tab === 'args'" :data-source="det.arguments" :show-borders="true">
              <DxColumn data-field="signature" caption="Подпрограмма" /><DxColumn data-field="arg" caption="Параметр" /><DxColumn data-field="mode" caption="Режим" :width="90" /><DxColumn data-field="type" caption="Тип" /><DxColumn data-field="returns" caption="Результат" /><DxColumn data-field="language" caption="Язык" :width="90" />
            </DxDataGrid>
            <table v-if="tab === 'stats'" class="kv"><tr v-for="s in det.stats" :key="s.k"><td>{{ s.k }}</td><td class="mono">{{ s.v }}</td></tr></table>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { DxButton } from 'devextreme-vue/button';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { DxSelectBox } from 'devextreme-vue/select-box';
import { DxTabs } from 'devextreme-vue/tabs';
import { DxTextBox } from 'devextreme-vue/text-box';
import { DxDataGrid, DxColumn, DxEditing, DxPaging, DxPager } from 'devextreme-vue/data-grid';
import CustomStore from 'devextreme/data/custom_store';
import notify from 'devextreme/ui/notify';
import DbPicker from '../components/DbPicker.vue';
import { api, safe, toast } from '../api';
import { lastPick, connType } from '../store';

const TYPES = { table: 'Таблицы', view: 'Представления', mview: 'Материализованные представления', sequence: 'Последовательности', package: 'Пакеты', procedure: 'Процедуры', function: 'Функции', trigger: 'Триггеры', type: 'Типы' };
const ICONS = { table: '▦', view: '👁', mview: '🧊', sequence: '🔢', package: '📦', procedure: '⚙️', function: 'ƒ', trigger: '⚡', type: '🧩' };
const CODE = ['package', 'procedure', 'function', 'trigger', 'type'];
const typeItems = [{ v: null, t: 'Все типы' }, ...Object.entries(TYPES).map(([v, t]) => ({ v, t }))];
const router = useRouter(), route = useRoute();
const lp = lastPick();
const db = ref({ connId: route.query.conn || null, schema: route.query.schema || '', ...(route.query.conn ? {} : lp.src) });
const objects = ref([]), filter = ref(''), typeFilter = ref(null), collapsed = reactive({}), loadingList = ref(false);
const cur = ref(null), det = ref(null), loading = ref(false), tab = ref('data');
const where = ref(''), editable = ref(false), gridKey = ref(0), grid = ref(null);
const isOra = computed(() => connType(db.value.connId) === 'oracle');
const qualified = computed(() => (cur.value ? `${isOra.value ? db.value.schema.toUpperCase() : `"${db.value.schema}"`}.${isOra.value ? `"${cur.value.name}"` : `"${cur.value.name}"`}` : ''));

const groups = computed(() => {
  const f = filter.value.toLowerCase();
  const by = new Map();
  for (const o of objects.value) {
    if (typeFilter.value && o.type !== typeFilter.value) continue;
    if (f && !o.name.toLowerCase().includes(f)) continue;
    if (!by.has(o.type)) by.set(o.type, []);
    by.get(o.type).push(o);
  }
  return Object.keys(TYPES).filter(t => by.has(t)).map(t => ({ type: t, items: by.get(t).sort((a, b) => a.name.localeCompare(b.name)) }));
});
const tabItems = computed(() => {
  if (!cur.value) return [];
  const t = cur.value.type;
  const L = [];
  if (['table', 'view', 'mview'].includes(t)) L.push(['data', 'Данные'], ['columns', 'Колонки']);
  if (t === 'table') L.push(['constraints', 'Ограничения'], ['indexes', 'Индексы'], ['triggers', 'Триггеры']);
  if (['view', 'mview'].includes(t) || CODE.includes(t)) L.push(['source', t === 'view' || t === 'mview' ? 'Запрос' : 'Код']);
  if (CODE.includes(t)) L.push(['errors', `Ошибки${det.value && det.value.errors && det.value.errors.length ? ` (${det.value.errors.length})` : ''}`]);
  if (['package', 'procedure', 'function'].includes(t)) L.push(['args', 'Параметры']);
  L.push(['deps', 'Зависимости'], ['ddl', 'DDL']);
  if (det.value && det.value.stats) L.push(['stats', t === 'sequence' ? 'Сведения' : 'Статистика']);
  return L.map(([key, text]) => ({ key, text }));
});
const tabIndex = computed(() => Math.max(0, tabItems.value.findIndex(x => x.key === tab.value)));
const errLines = computed(() => new Set((det.value && det.value.errors || []).map(e => Number(e.line))));
const lines = s => String(s || '').split('\n');

async function loadList() {
  objects.value = []; cur.value = null; det.value = null;
  if (!db.value.connId || !db.value.schema) return;
  loadingList.value = true;
  const r = await safe(() => api.get(`/connections/${db.value.connId}/objects?schema=${encodeURIComponent(db.value.schema)}`));
  loadingList.value = false;
  if (r) {
    objects.value = r.objects;
    if (route.query.name) { const o = r.objects.find(x => x.name === route.query.name && (!route.query.type || x.type === route.query.type)); if (o) open(o); }
  }
}
watch(() => [db.value.connId, db.value.schema], loadList, { immediate: true });

async function open(o) {
  const same = cur.value && cur.value.type === o.type && cur.value.name === o.name;
  cur.value = o; loading.value = true; editable.value = false;
  if (!same) { where.value = ''; tab.value = ['table', 'view', 'mview'].includes(o.type) ? 'data' : CODE.includes(o.type) ? 'source' : 'stats'; }
  det.value = await safe(() => api.get(`/connections/${db.value.connId}/object?schema=${encodeURIComponent(db.value.schema)}&type=${o.type}&name=${encodeURIComponent(o.name)}`));
  loading.value = false;
  if (det.value && !tabItems.value.some(t => t.key === tab.value)) tab.value = tabItems.value[0].key;
  gridKey.value++;
}
function openRef(ref) {
  const [type, ...rest] = ref.split(':'); const name = rest.join(':');
  const o = objects.value.find(x => x.type === type && x.name === name) || objects.value.find(x => x.name.toLowerCase() === name.toLowerCase());
  if (o) open(o); else toast(`Объект ${name} не найден в этой схеме`, 'warning');
}

// данные таблицы: постраничная загрузка с сервера и правка строк
const pkCols = () => (det.value && det.value.pk) || [];
const store = computed(() => {
  gridKey.value; // пересоздавать при смене объекта
  if (!cur.value || !['table', 'view', 'mview'].includes(cur.value.type)) return null;
  const pk = pkCols();
  return new CustomStore({
    key: pk.length ? (pk.length === 1 ? pk[0] : pk) : undefined,
    load: async o => {
      let sort = (o.sort || []).map(s => ({ column: s.selector, desc: s.desc }));
      if (!sort.length && pk.length) sort = pk.map(c => ({ column: c }));   // стабильный порядок страниц
      const r = await api.post(`/connections/${db.value.connId}/table-data`, { schema: db.value.schema, table: cur.value.name, skip: o.skip || 0, take: o.take || 50, where: where.value, sort, count: o.requireTotalCount !== false });
      return { data: r.rows, totalCount: r.total };
    },
  });
});
function reloadData() { gridKey.value++; }
async function onSaving(e) {
  e.cancel = true;
  const pk = pkCols();
  const keyObj = k => (pk.length === 1 ? { [pk[0]]: k } : k);
  const changes = e.changes.map(c => (c.type === 'insert' ? { type: 'insert', data: c.data } : c.type === 'update' ? { type: 'update', key: keyObj(c.key), data: c.data } : { type: 'remove', key: keyObj(c.key) }));
  if (!changes.length) return;
  try {
    const r = await api.post(`/connections/${db.value.connId}/table-save`, { schema: db.value.schema, table: cur.value.name, changes });
    notify(`Сохранено, затронуто строк: ${r.affected}`, 'success', 2500);
    grid.value && grid.value.instance.cancelEditData();
    reloadData();
  } catch (err) { notify(err.message, 'error', 6000); }
}
async function action(a) {
  const r = await safe(() => api.post(`/connections/${db.value.connId}/object-action`, { schema: db.value.schema, type: cur.value.type, name: cur.value.name, action: a }));
  if (r) { toast(a === 'compile' ? (r.errors ? `Скомпилировано с ошибками: ${r.errors}` : 'Скомпилировано без ошибок') : 'Готово', r.errors ? 'warning' : 'success'); open(cur.value); }
}
function toConsole(sql) { localStorage.setItem('dbcompare.sql.pending', sql); router.push('/sql'); }
async function copy(t) { await navigator.clipboard.writeText(t || '').catch(() => {}); toast('Скопировано'); }
</script>

<style scoped>
.left { width: 300px; flex: none; }
.right { flex: 1; min-width: 0; }
.olist { margin-top: 6px; height: calc(100vh - 330px); min-height: 300px; overflow: auto; font-size: 13px; }
.ghead { font-weight: 600; cursor: pointer; padding: 4px 2px; border-bottom: 1px solid #f2f4f7; }
.oitem { padding: 2px 4px 2px 16px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.oitem:hover { background: #eff8ff; }
.oitem.sel { background: #d1e9ff; }
.tabbody { padding-top: 10px; }
.dep { padding: 3px 4px; cursor: pointer; }
.dep:hover { background: #eff8ff; }
.code { background: #f9fafb; border: 1px solid #e4e7ec; border-radius: 4px; padding: 8px; font-size: 12.5px; max-height: 600px; overflow: auto; }
.ln { color: #98a2b3; user-select: none; margin-right: 10px; }
.errline { background: #fee4e2; }
.kv td { padding: 4px 12px 4px 0; border-bottom: 1px solid #f2f4f7; }
</style>
