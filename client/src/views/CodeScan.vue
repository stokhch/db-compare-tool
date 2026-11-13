<template>
  <div>
    <h2 class="page">Код приложения</h2>
    <div class="panel">
      <p class="hint" style="margin-top:0">Поиск мест в коде приложения, которые придётся поменять при переходе на PostgreSQL:
        SQL в строках кода (NVL, DECODE, ROWNUM, (+), CONNECT BY, seq.NEXTVAL, параметры :name → $1 …) и работа с драйвером node-oracledb
        (execute/executeMany, OUT-параметры, autoCommit, имена колонок ЗАГЛАВНЫМИ). Проверяются .js .ts .vue .java .cs .py .sql и XML-маппинги;
        node_modules, dist, .git пропускаются. Для простых случаев показан вариант замены.</p>
      <div class="row">
        <div class="field col"><label>Папка проекта на этом компьютере</label>
          <DxTextBox v-model:value="path" value-change-event="input" placeholder="C:\projects\my-app\server" /></div>
      </div>
      <div class="row">
        <div class="col">
          <DxCheckBox v-model:value="usePackages" text="Искать вызовы пакетов Oracle (пакет.процедура → пакет_процедура)" />
          <DbPicker v-if="usePackages" v-model="src" label="База Oracle с пакетами" only="oracle" style="margin-top:8px" />
        </div>
        <div class="col">
          <DxCheckBox v-model:value="alwaysDriver" text="Проверять вызовы драйвера во всех файлах (не только где есть oracledb)" />
        </div>
      </div>
      <div class="toolbar"><DxButton text="Проверить код" icon="search" type="default" :disabled="!path" @click="run" /></div>
    </div>
    <JobPanel v-if="jobId" :job-id="jobId" :report="false" @done="j => (result = j.result)" />
    <template v-if="result">
      <div class="cards">
        <div class="card"><div class="v">{{ result.summary.files }}</div><div class="l">файлов проверено</div></div>
        <div class="card"><div class="v">{{ result.summary.filesWithIssues }}</div><div class="l">файлов с замечаниями</div></div>
        <div class="card"><div class="v error">{{ result.summary.error }}</div><div class="l">нужно менять</div></div>
        <div class="card"><div class="v warning">{{ result.summary.warning }}</div><div class="l">проверить</div></div>
        <div class="card"><div class="v">{{ result.summary.info }}</div><div class="l">к сведению</div></div>
        <div class="card" style="display:flex;align-items:center"><DxButton text="Скачать CSV" icon="download" styling-mode="outlined" @click="csv" /></div>
      </div>
      <div class="panel" style="padding:8px">
        <h3 style="margin:4px">По правилам</h3>
        <DxDataGrid :data-source="result.rules" :show-borders="true" :word-wrap-enabled="true" @row-click="e => (ruleFilter = ruleFilter === e.data.rule ? null : e.data.rule)" :hover-state-enabled="true">
          <DxColumn data-field="title" caption="Что найдено (клик — фильтр)" :width="260" />
          <DxColumn data-field="severity" caption="Важность" cell-template="sev" :width="120" />
          <DxColumn data-field="count" caption="Мест" :width="80" />
          <DxColumn data-field="files" caption="Файлов" :width="80" />
          <DxColumn data-field="hint" caption="Как в PostgreSQL" />
          <template #sev="{ data }"><span :class="{ error: 'error', warning: 'warning', info: '' }[data.value]">{{ SEV[data.value] }}</span></template>
        </DxDataGrid>
      </div>
      <div class="panel" style="padding:8px">
        <div class="toolbar" style="margin:4px"><h3 style="margin:0">Места в коде</h3>
          <span v-if="ruleFilter" class="hint">правило: {{ ruleFilter }} <a href="#" @click.prevent="ruleFilter = null">сбросить</a></span></div>
        <DxDataGrid :data-source="findings" :show-borders="true" :word-wrap-enabled="true" :height="620">
          <DxSearchPanel :visible="true" /><DxFilterRow :visible="true" /><DxScrolling mode="virtual" />
          <DxGrouping :auto-expand-all="true" />
          <DxColumn data-field="file" caption="Файл" :group-index="0" />
          <DxColumn data-field="line" caption="Строка" :width="80" />
          <DxColumn data-field="severity" caption="Важность" cell-template="sev" :width="110" :lookup="{ dataSource: sevList, valueExpr: 'v', displayExpr: 't' }" />
          <DxColumn data-field="title" caption="Что" :width="200" />
          <DxColumn caption="Код" cell-template="code" />
          <DxColumn data-field="hint" caption="Как исправить" />
          <template #sev="{ data }"><span :class="{ error: 'error', warning: 'warning', info: '' }[data.value]">{{ SEV[data.value] }}</span></template>
          <template #code="{ data: d }">
            <div class="mono">{{ d.data.snippet }}</div>
            <div v-if="d.data.fixed" class="mono ok">→ {{ d.data.fixed }}</div>
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
import { DxTextBox } from 'devextreme-vue/text-box';
import { DxDataGrid, DxColumn, DxSearchPanel, DxFilterRow, DxScrolling, DxGrouping } from 'devextreme-vue/data-grid';
import DbPicker from '../components/DbPicker.vue';
import JobPanel from '../components/JobPanel.vue';
import { api, safe } from '../api';
import { lastPick } from '../store';
import { useJobFromRoute } from '../jobroute';

const SEV = { error: 'нужно менять', warning: 'проверить', info: 'к сведению' };
const sevList = Object.entries(SEV).map(([v, t]) => ({ v, t }));
const path = ref(localStorage.getItem('dbcompare.codePath') || '');
const usePackages = ref(false);
const alwaysDriver = ref(false);
const src = ref(lastPick().src || { connId: null, schema: '' });
const jobId = ref(null);
const result = ref(null);
const ruleFilter = ref(null);
const findings = computed(() => (result.value ? result.value.findings.filter(f => !ruleFilter.value || f.rule === ruleFilter.value) : []));

async function run() {
  try { localStorage.setItem('dbcompare.codePath', path.value); } catch { /* */ }
  result.value = null;
  const j = await safe(() => api.post('/jobs/codescan', {
    path: path.value, alwaysDriver: alwaysDriver.value,
    sourceId: usePackages.value ? src.value.connId : undefined, sourceSchema: usePackages.value ? src.value.schema : undefined,
  }));
  if (j) jobId.value = j.id;
}
function csv() {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['Файл;Строка;Важность;Что;Код;Замена;Как исправить'];
  for (const f of result.value.findings) lines.push([f.file, f.line, SEV[f.severity], f.title, f.snippet, f.fixed || '', f.hint].map(esc).join(';'));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  a.download = 'oracle-to-postgres-code.csv'; a.click();
}
useJobFromRoute(['codescan'], j => { jobId.value = j.id; if (j.params && j.params.path) path.value = j.params.path; });
</script>
