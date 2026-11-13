<template>
  <div class="panel">
    <p class="hint" style="margin-top:0">Каждая функция пакета вызывается в Oracle и в PostgreSQL с одинаковыми аргументами: базовый вызов (числа 1, даты 1 и 31 марта 2026, строка «abc»),
      затем по очереди меняется один параметр — 0, −1, дроби, 29 февраля, конец года, время внутри дня, кириллица, пробелы, NULL (до 60 вызовов на функцию).
      Каждый вызов — в точке сохранения с откатом. Ответ Oracle — эталон; одинаковые ошибки (NO_DATA_FOUND = P0002, деление на ноль = 22012,
      RAISE_APPLICATION_ERROR(-20001) = 45001) считаются совпадением. Скрипт для SQL*Plus и файлы не нужны.</p>
    <div class="row">
      <div class="col">
        <ObjectPicker v-model="objects" :conn-id="src.connId" :schema="src.schema" :only-types="['package', 'function', 'procedure']" :height="220" />
      </div>
    </div>
    <div class="toolbar">
      <DxCheckBox v-model:value="includeProcedures" text="Включая процедуры (OUT-параметры)" />
      <span v-if="includeProcedures" class="warning">Процедуры выполняются по-настоящему внутри точки сохранения — только на тестовой копии; с COMMIT внутри откат не сработает.</span>
      <div class="field" style="width:150px;margin:0"><label>Вызовов на функцию</label><DxNumberBox v-model:value="maxCalls" :min="1" :max="200" :show-spin-buttons="true" /></div>
    </div>
    <div class="toolbar">
      <DxButton text="Запустить с Oracle" icon="runner" type="default" :disabled="!src.connId || !tgt.connId || !objects.length" @click="run()" />
      <span class="hint">или повторить сохранённый набор без Oracle:</span>
      <DxSelectBox v-model:value="suiteId" :items="suites" value-expr="id" display-expr="name" placeholder="Сохранённые наборы…" :width="240" :show-clear-button="true" />
      <DxButton text="Повторить без Oracle" icon="refresh" styling-mode="outlined" :disabled="!suiteId || !tgt.connId" @click="runSaved" />
      <AddToSuite type="unit-tests" :params="params" default-title="Юнит-тесты функций" />
    </div>
    <JobPanel v-if="jobId" :job-id="jobId" :report="false" @done="j => (result = j.result)" />
    <template v-if="result">
      <div class="cards">
        <div class="card"><div class="v">{{ result.summary.functions }}</div><div class="l">функций{{ result.summary.withoutOracle ? ' (без Oracle)' : '' }}</div></div>
        <div class="card"><div class="v ok">{{ result.summary.fullyPassed }}</div><div class="l">прошли полностью</div></div>
        <div class="card"><div class="v error">{{ result.summary.failed }}</div><div class="l">вызовов не прошло</div></div>
        <div class="card"><div class="v error">{{ result.summary.notFound }}</div><div class="l">не найдено в PostgreSQL</div></div>
        <div class="card"><div class="v">{{ result.summary.skipped }}</div><div class="l">пропущено (коллекции, курсоры)</div></div>
        <div v-if="!result.summary.withoutOracle && result.suite.functions.length" class="card" style="display:flex;align-items:center"><DxButton text="Сохранить набор с ответами Oracle" icon="save" styling-mode="outlined" @click="saveSuite" /></div>
      </div>
      <div class="toolbar"><DxCheckBox v-model:value="onlyFailed" text="Только с ошибками" /></div>
      <DxDataGrid :data-source="shown" :show-borders="true" :word-wrap-enabled="true">
        <DxSearchPanel :visible="true" />
        <DxColumn caption="Функция" :calculate-cell-value="f => `${f.package ? f.package + '.' : ''}${f.name}`" />
        <DxColumn data-field="pgName" caption="В PostgreSQL" />
        <DxColumn caption="Результат" cell-template="st" />
        <DxMasterDetail :enabled="true" template="det" />
        <template #st="{ data: d }">
          <span v-if="d.data.skip" class="hint">пропущено: {{ d.data.skip }}</span>
          <span v-else-if="d.data.notFound" class="error">функция не найдена (поставьте пакет или проверьте search_path)</span>
          <span v-else :class="d.data.failed ? 'error' : 'ok'">прошло {{ d.data.passed }} из {{ d.data.calls.length }}</span>
        </template>
        <template #det="{ data: d }">
          <DxDataGrid :data-source="d.data.calls.filter(c => !onlyFailed || c.status !== 'pass')" :show-borders="true" :word-wrap-enabled="true">
            <DxPaging :page-size="20" />
            <DxColumn data-field="n" caption="№" :width="50" />
            <DxColumn data-field="call" caption="Вызов" css-class="mono" />
            <DxColumn caption="Oracle" :calculate-cell-value="c => ans(c.expected)" css-class="mono" />
            <DxColumn caption="PostgreSQL" :calculate-cell-value="c => ans(c.actual)" css-class="mono" />
            <DxColumn data-field="status" caption="" cell-template="cs" :width="120" />
            <DxColumn data-field="note" caption="" />
            <template #cs="{ data: c }"><span :class="c.value === 'pass' ? 'ok' : 'error'">{{ { pass: 'прошёл', fail: 'не прошёл', 'no-result': 'нет результата', 'not-found': 'не найдена' }[c.value] }}</span></template>
          </DxDataGrid>
        </template>
      </DxDataGrid>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { DxButton } from 'devextreme-vue/button';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { DxNumberBox } from 'devextreme-vue/number-box';
import { DxSelectBox } from 'devextreme-vue/select-box';
import { DxDataGrid, DxColumn, DxSearchPanel, DxMasterDetail, DxPaging } from 'devextreme-vue/data-grid';
import ObjectPicker from './ObjectPicker.vue';
import JobPanel from './JobPanel.vue';
import AddToSuite from './AddToSuite.vue';
import { api, safe, toast } from '../api';

const props = defineProps({ src: Object, tgt: Object });
const objects = ref([]);
const includeProcedures = ref(false);
const maxCalls = ref(60);
const suites = ref([]);
const suiteId = ref(null);
const jobId = ref(null);
const result = ref(null);
const onlyFailed = ref(true);
const shown = computed(() => (result.value ? result.value.functions.filter(f => !onlyFailed.value || f.failed || f.notFound) : []));
const ans = a => (!a ? '—' : a.err ? `ошибка ${a.err}: ${(a.msg || '').slice(0, 120)}` : a.value === null || a.value === undefined ? 'NULL' : a.value);
const params = () => {
  const s = suites.value.find(x => x.id === suiteId.value);
  if (s) return { targetId: props.tgt.connId, targetSchema: props.tgt.schema, suite: s.suite };
  return props.src.connId && objects.value.length ? { sourceId: props.src.connId, sourceSchema: props.src.schema, targetId: props.tgt.connId, targetSchema: props.tgt.schema, objects: objects.value, includeProcedures: includeProcedures.value, maxCalls: maxCalls.value } : null;
};
async function run() {
  result.value = null;
  const j = await safe(() => api.post('/jobs/unit-tests', { sourceId: props.src.connId, sourceSchema: props.src.schema, targetId: props.tgt.connId, targetSchema: props.tgt.schema, objects: objects.value, includeProcedures: includeProcedures.value, maxCalls: maxCalls.value }));
  if (j) jobId.value = j.id;
}
async function runSaved() {
  const s = suites.value.find(x => x.id === suiteId.value);
  result.value = null;
  const j = await safe(() => api.post('/jobs/unit-tests', { targetId: props.tgt.connId, targetSchema: props.tgt.schema, suite: s.suite }));
  if (j) jobId.value = j.id;
}
async function loadSuites() { suites.value = (await safe(() => api.get('/saved/unitsuites'))) || []; }
async function saveSuite() {
  const name = prompt('Название набора тестов', objects.value.map(o => o.name).join(', ').slice(0, 60) || 'Функции');
  if (!name) return;
  const r = await safe(() => api.post('/saved/unitsuites', { name, suite: result.value.suite, createdAt: new Date().toISOString() }));
  if (r) { toast('Набор сохранён: повторные прогоны — без Oracle'); await loadSuites(); suiteId.value = r.id; }
}
onMounted(loadSuites);
defineExpose({ show: j => { jobId.value = j.id; } });
</script>
