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
            <a v-if="data.data.type === 'schema-compare' || data.data.type === 'data-compare'" :href="`/api/jobs/${data.data.id}/report.html`" target="_blank">отчёт</a>
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
const TYPES = { 'schema-compare': 'Схемы', 'data-compare': 'Данные', transfer: 'Перелив', pgdump: 'pg_dump', datapump: 'Data Pump', ora2pg: 'ora2pg', 'data-sync': 'Синхр. данных', 'apply-sql': 'Скрипт', profile: 'Профиль', pipeline: 'Миграция', delta: 'Догрузка', extras: 'Окружение', codescan: 'Код', 'query-compare': 'Запросы', 'calc-verify': 'Расчёты', 'agg-compare': 'Агрегаты', suite: 'Регламент' };
const ROUTES = { 'schema-compare': '/schema', 'data-compare': '/data', profile: '/profile', pipeline: '/migrate', delta: '/migrate', extras: '/migrate', codescan: '/code', 'query-compare': '/checks', 'calc-verify': '/checks', 'agg-compare': '/checks' };
const isCompare = j => !!ROUTES[j.type];
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
    case 'profile': return `колонок ${s.columns}: проблем ${s.error || 0}, предупреждений ${s.warning || 0}`;
    case 'pipeline': return `шагов ${s.done + (s.warning || 0)}/${s.steps}, простой ≈ ${fmtMs(s.downtimeMs)}${s.error ? ', ОШИБКА' : ''}`;
    case 'delta': return `вставка/обновление ${s.insert}, изменения ${s.update}${s.delete != null ? `, удаления ${s.delete}` : ''}`;
    case 'codescan': return `файлов ${s.files}: менять ${s.error}, проверить ${s.warning}`;
    case 'query-compare': return `запросов ${s.queries}: отличаются ${s.different}, ошибок ${s.error}, медленнее ${s.slow}`;
    case 'calc-verify': case 'agg-compare': return `таблиц ${s.tables}: отличаются ${s.different}, ошибок ${s.error}`;
    case 'data-sync': return `INSERT ${s.insert}, UPDATE ${s.update}, DELETE ${s.delete}${s.applied ? ' (выполнено)' : ''}`;
    case 'apply-sql': return `выполнено ${s.done} из ${s.total}${s.error ? `, ошибок ${s.error}` : ''}`;
    case 'suite': return `${{ ok: 'всё совпадает', warn: 'предупреждения', fail: 'расхождения' }[s.status]}, проверок ${s.checks}`;
    case 'extras': return Object.entries(s).map(([k, v]) => `${k}: ${v}`).join(', ');
    default: return '';
  }
}
async function load() { const r = await safe(() => api.get('/jobs')); if (r) jobs.value = r; }
async function remove(j) { await safe(() => api.del(`/jobs/${j.id}`)); if (openId.value === j.id) openId.value = null; load(); }
function openResult(j) { router.push({ path: ROUTES[j.type], query: { job: j.id } }); }
onMounted(load);
onActivated(load);
</script>
