<template>
  <div>
    <h2 class="page">Задачи</h2>
    <div class="toolbar"><DxButton text="Обновить" icon="refresh" styling-mode="outlined" @click="load" /></div>
    <div class="panel" style="padding:8px">
      <DxDataGrid :data-source="jobs" key-expr="id" :show-borders="false" :row-alternation-enabled="true" :column-auto-width="true"
        :focused-row-enabled="true" :focused-row-key="openId" @row-click="e => (openId = e.data.id)">
        <DxPaging :page-size="25" />
        <DxFilterRow :visible="true" />
        <DxColumn data-field="startedAt" caption="Запуск" data-type="datetime" format="dd.MM.yyyy HH:mm:ss" sort-order="desc" :width="160" />
        <DxColumn data-field="type" caption="Тип" :width="130" :calculate-display-value="r => TYPES[r.type] || r.type" />
        <DxColumn data-field="title" caption="Описание" />
        <DxColumn data-field="status" caption="Статус" cell-template="st" :width="120" />
        <DxColumn caption="Итог" :calculate-cell-value="summaryText" />
        <DxColumn caption="Длительность" :width="110" :calculate-cell-value="r => r.finishedAt ? fmtMs(new Date(r.finishedAt) - new Date(r.startedAt)) : ''" />
        <DxColumn caption="" cell-template="act" :width="220" />
        <template #st="{ data }"><span :class="cls[data.value]">{{ STATUS[data.value] || data.value }}</span></template>
        <template #act="{ data }">
          <span style="display:inline-flex;gap:10px">
            <a v-if="isCompare(data.data)" href="#" @click.prevent.stop="openResult(data.data)">открыть</a>
            <a v-if="isCompare(data.data)" :href="`/api/jobs/${data.data.id}/report.html`" target="_blank">отчёт</a>
            <a v-if="data.data.status !== 'running'" href="#" @click.prevent.stop="remove(data.data)">удалить</a>
          </span>
        </template>
      </DxDataGrid>
    </div>
    <JobPanel v-if="openId" :job-id="openId" :log-open="true" @done="load" />
  </div>
</template>

<script setup>
import { onActivated, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { DxButton } from 'devextreme-vue/button';
import { DxDataGrid, DxColumn, DxPaging, DxFilterRow } from 'devextreme-vue/data-grid';
import JobPanel from '../components/JobPanel.vue';
import { api, safe, STATUS, fmtMs, fmtNum } from '../api';

const router = useRouter();
const jobs = ref([]);
const openId = ref(null);
const TYPES = { 'schema-compare': 'Схемы', 'data-compare': 'Данные', transfer: 'Перелив', pgdump: 'pg_dump', datapump: 'Data Pump', ora2pg: 'ora2pg' };
const isCompare = j => j.type === 'schema-compare' || j.type === 'data-compare';
const cls = { done: 'ok', error: 'error', cancelled: 'warning', running: 'warning' };

function summaryText(r) {
  const s = r.summary;
  if (!s) return r.error || '';
  switch (r.type) {
    case 'schema-compare': return `ошибок ${s.error}, предупреждений ${s.warning}, совпадает ${s.ok}`;
    case 'data-compare': return `таблиц ${s.tables}: совпадают ${s.equal || 0}, отличаются ${s.different || 0}, ошибок ${s.error || 0}`;
    case 'transfer': return `таблиц ${s.done}/${s.tables}, строк ${fmtNum(s.rows)}`;
    case 'datapump': return s.commandsOnly ? 'команды' : `${s.state}, ошибок ${s.errors}`;
    case 'ora2pg': return `${s.action}, файлов ${s.files}${s.problems != null ? `, проблем ${s.problems}` : ''}`;
    case 'pgdump': return `${s.file || ''}`;
    default: return '';
  }
}
async function load() { const r = await safe(() => api.get('/jobs')); if (r) jobs.value = r; }
async function remove(j) { await safe(() => api.del(`/jobs/${j.id}`)); if (openId.value === j.id) openId.value = null; load(); }
function openResult(j) { router.push({ path: j.type === 'schema-compare' ? '/schema' : '/data', query: { job: j.id } }); }
onMounted(load);
onActivated(load);
</script>
