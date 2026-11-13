<template>
  <div>
    <h2 class="page">Профиль данных</h2>
    <div class="panel">
      <p class="hint" style="margin-top:0">Анализ фактических значений в колонках — до выбора типов и до переноса. Показывает, где тип по описанию
        не подходит для реальных данных: дробные значения в «целых» колонках, время в DATE, символ \0 (PostgreSQL его не принимает),
        пустые строки ('' в Oracle = NULL), значения длиннее колонки. Если указать приёмник — проверяется и его фактический тип.</p>
      <div class="row">
        <DbPicker v-model="src" label="Источник" />
        <div class="arrow">→</div>
        <div class="col">
          <DxCheckBox v-model:value="withTarget" text="Проверить типы в приёмнике" style="margin-bottom:8px" />
          <DbPicker v-if="withTarget" v-model="tgt" label="Приёмник" />
        </div>
      </div>
      <div class="field">
        <label>Таблицы</label>
        <DxRadioGroup v-model:value="scope" layout="horizontal" value-expr="v" display-expr="t" :items="[{ v: 'all', t: 'все' }, { v: 'selected', t: 'выбранные' }]" />
      </div>
      <div v-if="scope === 'selected'" class="panel" style="background:#fafbfc">
        <ObjectPicker v-model="objects" :conn-id="src.connId" :schema="src.schema" :only-types="['table']" :height="260" />
      </div>
      <div class="toolbar">
        <div class="field" style="width:220px;margin:0"><label>Выборка, % строк (0 — все)</label>
          <DxNumberBox v-model:value="sample" :min="0" :max="100" :show-spin-buttons="true" /></div>
        <DxButton text="Построить профиль" icon="chart" type="default" :disabled="!src.connId || !src.schema" @click="run" style="margin-top:18px" />
        <AddToSuite type="profile" :params="params" default-title="Профиль данных" style="margin-top:18px" />
      </div>
    </div>
    <JobPanel v-if="jobId" :job-id="jobId" :report="false" @done="j => (result = j.result)" />
    <template v-if="result">
      <div class="cards">
        <div class="card"><div class="v">{{ result.summary.tables }} / {{ result.summary.columns }}</div><div class="l">таблиц / колонок</div></div>
        <div class="card"><div class="v error">{{ result.summary.error || 0 }}</div><div class="l">проблем в данных</div></div>
        <div class="card"><div class="v warning">{{ result.summary.warning || 0 }}</div><div class="l">предупреждений</div></div>
        <div class="card"><div class="v">{{ result.summary.info || 0 }}</div><div class="l">рекомендаций</div></div>
        <div v-if="result.summary.sample < 100" class="card"><div class="v">{{ result.summary.sample }}%</div><div class="l">выборка</div></div>
      </div>
      <div class="panel" style="padding:8px">
        <div class="toolbar" style="margin:4px"><DxCheckBox v-model:value="showOk" text="Показывать колонки без замечаний" /></div>
        <DxDataGrid :data-source="rows" :show-borders="true" :word-wrap-enabled="true" :column-auto-width="true" :height="640">
          <DxSearchPanel :visible="true" /><DxFilterRow :visible="true" /><DxScrolling mode="virtual" />
          <DxGrouping :auto-expand-all="true" /><DxGroupPanel :visible="true" empty-panel-text="Перетащите колонку для группировки" />
          <DxColumn data-field="table" caption="Таблица" :group-index="0" />
          <DxColumn data-field="column" caption="Колонка" css-class="mono" />
          <DxColumn data-field="level" caption="Уровень" cell-template="lvl" :width="110" :lookup="{ dataSource: lv, valueExpr: 'v', displayExpr: 't' }" />
          <DxColumn data-field="sourceType" caption="Тип в источнике" />
          <DxColumn data-field="defaultType" caption="По умолчанию" />
          <DxColumn data-field="recommended" caption="Рекомендуется" cell-template="rec" />
          <DxColumn v-if="result.rows.some(r => r.targetType)" data-field="targetType" caption="В приёмнике" />
          <DxColumn caption="Данные" cell-template="stats" :width="220" />
          <DxColumn caption="Замечания" :calculate-cell-value="r => (r.notes || []).join('; ')" />
          <template #lvl="{ data }"><span :class="{ error: 'error', warning: 'warning', info: '', ok: 'ok' }[data.value]">{{ lvMap[data.value] }}</span></template>
          <template #rec="{ data }"><b v-if="data.value !== data.data.defaultType">{{ data.value }}</b><span v-else>{{ data.value }}</span></template>
          <template #stats="{ data: d }">
            <div class="hint">
              <div v-if="d.data.nonNull != null">заполнено {{ fmtNum(d.data.nonNull) }} из {{ fmtNum(d.data.rows) }}</div>
              <div v-if="d.data.min != null">мин {{ d.data.min }} · макс {{ d.data.max }}</div>
              <div v-if="d.data.maxLength != null">макс. длина {{ fmtNum(d.data.maxLength) }}{{ d.data.maxBytes && d.data.maxBytes !== d.data.maxLength ? ` (${d.data.maxBytes} байт)` : '' }}</div>
              <div v-if="d.data.fractional">дробных {{ fmtNum(d.data.fractional) }}, знаков до {{ d.data.maxScale }}</div>
              <div v-if="d.data.withTime != null && d.data.withTime > 0">со временем {{ fmtNum(d.data.withTime) }}</div>
            </div>
          </template>
        </DxDataGrid>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { DxButton } from 'devextreme-vue/button';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { DxNumberBox } from 'devextreme-vue/number-box';
import { DxRadioGroup } from 'devextreme-vue/radio-group';
import { DxDataGrid, DxColumn, DxSearchPanel, DxFilterRow, DxScrolling, DxGrouping, DxGroupPanel } from 'devextreme-vue/data-grid';
import DbPicker from '../components/DbPicker.vue';
import ObjectPicker from '../components/ObjectPicker.vue';
import JobPanel from '../components/JobPanel.vue';
import AddToSuite from '../components/AddToSuite.vue';
import { api, safe, fmtNum } from '../api';
import { lastPick } from '../store';
import { useJobFromRoute } from '../jobroute';

const lp = lastPick();
const src = ref(lp.src || { connId: null, schema: '' });
const tgt = ref(lp.tgt || { connId: null, schema: '' });
const withTarget = ref(false);
const scope = ref('all');
const objects = ref([]);
const sample = ref(0);
const jobId = ref(null);
const result = ref(null);
const showOk = ref(false);
const lv = [{ v: 'error', t: 'Ошибка' }, { v: 'warning', t: 'Внимание' }, { v: 'info', t: 'Совет' }, { v: 'ok', t: 'ОК' }];
const lvMap = Object.fromEntries(lv.map(x => [x.v, x.t]));
const rows = computed(() => (result.value ? result.value.rows.filter(r => showOk.value || r.level !== 'ok') : []));

const params = () => (src.value.connId && src.value.schema ? {
  sourceId: src.value.connId, sourceSchema: src.value.schema,
  targetId: withTarget.value ? tgt.value.connId : undefined, targetSchema: withTarget.value ? tgt.value.schema : undefined,
  tables: scope.value === 'selected' ? objects.value.map(o => o.name) : undefined, samplePercent: sample.value || undefined,
} : null);
async function run() {
  result.value = null;
  const j = await safe(() => api.post('/jobs/profile', params()));
  if (j) jobId.value = j.id;
}
useJobFromRoute(['profile'], j => { jobId.value = j.id; });
</script>
