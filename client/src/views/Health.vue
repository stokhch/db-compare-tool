<template>
  <div>
    <h2 class="page">Аудит здоровья базы</h2>
    <div class="panel">
      <p class="hint" style="margin-top:0">Раздутые таблицы и устаревшая статистика, последовательности и integer-ключи у предела, возраст транзакций (wraparound),
        заполнение табличных пространств, невалидные объекты, отключённые триггеры и ограничения, внешние ключи без индексов, таблицы без первичного ключа,
        зависшие транзакции и «сироты» — строки, ссылающиеся на несуществующие записи там, где связь есть по смыслу (dept_id → dept), а внешнего ключа нет.</p>
      <div class="row"><DbPicker v-model="db" label="База" /></div>
      <div class="toolbar">
        <DxCheckBox v-model:value="orphans" text="Искать «сирот» (запросы к данным)" />
        <DxButton text="Проверить" icon="runner" type="default" :disabled="!db.connId || !db.schema" @click="run" />
        <AddToSuite type="health" :params="params" default-title="Аудит здоровья" />
      </div>
    </div>
    <JobPanel v-if="jobId" :job-id="jobId" :report="false" @done="j => (res = j.result)" />
    <div v-if="res" class="panel">
      <div class="cards">
        <div class="card"><div class="v" :class="res.summary.score >= 90 ? 'ok' : res.summary.score >= 70 ? 'warning' : 'error'">{{ res.summary.score }}</div><div class="l">оценка из 100</div></div>
        <div class="card"><div class="v" :class="res.summary.error ? 'error' : 'ok'">{{ res.summary.error }}</div><div class="l">ошибок</div></div>
        <div class="card"><div class="v" :class="res.summary.warning ? 'warning' : 'ok'">{{ res.summary.warning }}</div><div class="l">предупреждений</div></div>
        <div class="card"><div class="v">{{ res.summary.info }}</div><div class="l">советов</div></div>
      </div>
      <SqlScript :items="res.findings" />
      <DxDataGrid :data-source="res.findings" :show-borders="true" :word-wrap-enabled="true" no-data-text="Проблем не найдено">
        <DxGrouping :auto-expand-all="true" /><DxSearchPanel :visible="true" />
        <DxColumn data-field="group" caption="Раздел" :group-index="0" />
        <DxColumn data-field="level" caption="" :width="40" cell-template="lv" />
        <DxColumn data-field="object" caption="Объект" :width="220" />
        <DxColumn data-field="text" caption="Что не так" />
        <DxColumn data-field="sql" caption="Как исправить" css-class="mono" :width="360" />
        <template #lv="{ data }"><span :class="data.value === 'info' ? 'hint' : data.value">●</span></template>
      </DxDataGrid>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { DxButton } from 'devextreme-vue/button';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { DxDataGrid, DxColumn, DxGrouping, DxSearchPanel } from 'devextreme-vue/data-grid';
import DbPicker from '../components/DbPicker.vue';
import JobPanel from '../components/JobPanel.vue';
import AddToSuite from '../components/AddToSuite.vue';
import SqlScript from '../components/SqlScript.vue';
import { api, safe } from '../api';
import { lastPick } from '../store';
import { useJobFromRoute } from '../jobroute';

const lp = lastPick();
const db = ref({ connId: null, schema: '', ...lp.tgt });
const orphans = ref(true), jobId = ref(null), res = ref(null);
const params = () => (db.value.connId ? { connId: db.value.connId, schema: db.value.schema, orphans: orphans.value } : null);
async function run() { res.value = null; const j = await safe(() => api.post('/jobs/health', params())); if (j) jobId.value = j.id; }
useJobFromRoute(['health'], j => { jobId.value = j.id; });
</script>
