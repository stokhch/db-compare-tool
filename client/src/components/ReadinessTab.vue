<template>
  <div class="panel">
    <p class="hint" style="margin-top:0">Перед сверкой расчёта: есть ли за период исходные данные в обеих базах — справочники (например, <span class="mono">tr_pok</span> с
      <span class="mono">kodrazd = 46</span>), суточные данные (<span class="mono">sv_*</span>), архивы соседних расчётов. «Пусто в обеих» объясняет пустой результат расчёта
      без ошибок. Фильтр периода и пользователя задаётся выше; условие пишется для Oracle (NVL автоматически заменяется на coalesce).</p>
    <div class="toolbar">
      <DxButton text="Добавить таблицу" icon="add" styling-mode="outlined" @click="items.push({ table: '', label: '', condition: '', usePeriod: true })" />
      <DxCheckBox v-model:value="auto" text="+ все таблицы, к которым применим фильтр периода" />
      <span style="flex:1" />
      <DxSelectBox v-model:value="setId" :items="sets" value-expr="id" display-expr="name" placeholder="Сохранённые списки…" :width="220" :show-clear-button="true" @value-changed="loadSet" />
      <DxButton text="Сохранить список" icon="save" styling-mode="text" @click="saveSet" />
    </div>
    <DxDataGrid :data-source="items" :show-borders="true" no-data-text="Добавьте таблицы или включите автоматический список">
      <DxEditing mode="cell" :allow-updating="true" :allow-deleting="true" :confirm-delete="false" />
      <DxColumn data-field="table" caption="Таблица" :width="240" :lookup="{ dataSource: tableNames }" />
      <DxColumn data-field="label" caption="Подпись" :width="200" />
      <DxColumn data-field="condition" caption="Условие (WHERE), например kodrazd = 46" />
      <DxColumn data-field="usePeriod" caption="Период" data-type="boolean" :width="90" />
    </DxDataGrid>
    <div class="toolbar" style="margin-top:10px">
      <DxButton text="Проверить" icon="runner" type="default" :disabled="!ready" @click="run" />
      <AddToSuite type="readiness" :params="params" default-title="Готовность данных" />
      <span v-if="!period" class="warning">Фильтр периода выключен — считаются все строки</span>
    </div>
    <JobPanel v-if="jobId" :job-id="jobId" :report="false" @done="j => (result = j.result)" />
    <template v-if="result">
      <div class="cards">
        <div class="card"><div class="v ok">{{ result.summary.ok }}</div><div class="l">данные есть и совпадают</div></div>
        <div class="card"><div class="v warning">{{ result.summary.warning }}</div><div class="l">пусто в обеих</div></div>
        <div class="card"><div class="v error">{{ result.summary.error }}</div><div class="l">расхождения / нет в одной базе</div></div>
      </div>
      <DxDataGrid :data-source="result.rows" :show-borders="true" :word-wrap-enabled="true">
        <DxColumn data-field="label" caption="Данные" />
        <DxColumn data-field="status" caption="" cell-template="st" :width="40" />
        <DxColumn data-field="source" caption="Источник" data-type="number" format="#,##0" :width="120" />
        <DxColumn data-field="target" caption="Приёмник" data-type="number" format="#,##0" :width="120" />
        <DxColumn data-field="filter" caption="Фильтр" />
        <DxColumn data-field="condition" caption="Условие" />
        <DxColumn data-field="note" caption="Комментарий" />
        <template #st="{ data }"><span :class="{ ok: 'ok', warning: 'warning', error: 'error' }[data.value]">●</span></template>
      </DxDataGrid>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { DxButton } from 'devextreme-vue/button';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { DxSelectBox } from 'devextreme-vue/select-box';
import { DxDataGrid, DxColumn, DxEditing } from 'devextreme-vue/data-grid';
import JobPanel from './JobPanel.vue';
import AddToSuite from './AddToSuite.vue';
import { api, safe, toast } from '../api';

const props = defineProps({ src: Object, tgt: Object, period: Object });
const items = ref([]);
const auto = ref(true);
const sets = ref([]);
const setId = ref(null);
const tableNames = ref([]);
const jobId = ref(null);
const result = ref(null);
const ready = computed(() => props.src.connId && props.src.schema && props.tgt.connId && props.tgt.schema && (items.value.some(i => i.table) || auto.value));
const params = () => (ready.value ? {
  sourceId: props.src.connId, sourceSchema: props.src.schema, targetId: props.tgt.connId, targetSchema: props.tgt.schema,
  period: props.period, autoPeriodTables: auto.value, items: items.value.filter(i => i.table),
} : null);
async function run() { result.value = null; const j = await safe(() => api.post('/jobs/readiness', params())); if (j) jobId.value = j.id; }
async function loadTables() {
  if (!props.src.connId || !props.src.schema) return;
  const r = await safe(() => api.get(`/connections/${props.src.connId}/tables?schema=${encodeURIComponent(props.src.schema)}`));
  if (r) tableNames.value = r.map(t => t.name);
}
async function loadSets() { sets.value = (await safe(() => api.get('/saved/readiness'))) || []; }
function loadSet(e) { const s = sets.value.find(x => x.id === e.value); if (s) { items.value = JSON.parse(JSON.stringify(s.items || [])); auto.value = !!s.auto; } }
async function saveSet() {
  const cur = sets.value.find(x => x.id === setId.value);
  const name = cur ? cur.name : prompt('Название списка', 'Исходные данные pt');
  if (!name) return;
  const r = await safe(() => api.post('/saved/readiness', { id: cur && cur.id, name, items: items.value, auto: auto.value }));
  if (r) { toast('Список сохранён'); await loadSets(); setId.value = r.id; }
}
watch(() => [props.src.connId, props.src.schema], loadTables);
onMounted(() => { loadTables(); loadSets(); });
defineExpose({ show: j => { jobId.value = j.id; } });
</script>
