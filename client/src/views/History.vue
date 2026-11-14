<template>
  <div>
    <h2 class="page">История схемы</h2>
    <div class="panel">
      <p class="hint" style="margin-top:0">Снимок структуры сохраняется вручную или по расписанию («В регламент» — новый снимок появляется, только если структура изменилась).
        Любые два снимка, или снимок и текущее состояние базы, сравниваются как в «Сравнении схем». Кто и какой командой менял структуру — показывает журнал DDL
        (его нужно один раз установить в базу).</p>
      <div class="row"><DbPicker v-model="db" label="База" /></div>
      <div class="toolbar">
        <DxTextBox v-model:value="label" placeholder="Метка снимка (необязательно), например «перед релизом 5.2»" :width="380" />
        <DxButton text="Сделать снимок" icon="photo" type="default" :disabled="!db.connId || !db.schema" @click="snap" />
        <AddToSuite type="schema-snapshot" :params="() => (db.connId ? { connId: db.connId, schema: db.schema, keep: 100 } : null)" default-title="Снимок схемы" />
      </div>
    </div>
    <JobPanel v-if="snapJob" :job-id="snapJob" :report="false" @done="load" />
    <div class="panel">
      <div class="toolbar"><b>Снимки</b><span class="hint">отметьте два для сравнения или один — сравнить с текущим состоянием</span><span style="flex:1" />
        <DxButton text="Сравнить" icon="columnfield" type="default" :disabled="sel.length < 1 || sel.length > 2" @click="compare" /></div>
      <DxDataGrid :data-source="list" key-expr="id" :show-borders="true" no-data-text="Снимков пока нет" :selected-row-keys="sel" @selection-changed="e => (sel = e.selectedRowKeys)">
        <DxSelection mode="multiple" show-check-boxes-mode="always" />
        <DxColumn data-field="takenAt" caption="Время" :width="170" :calculate-display-value="r => r.takenAt.replace('T', ' ').slice(0, 19)" sort-order="desc" />
        <DxColumn data-field="label" caption="Метка" />
        <DxColumn caption="Объекты" :calculate-cell-value="r => `таблиц ${r.counts.tables}, представлений ${r.counts.views}, подпрограмм ${r.counts.routines}`" />
        <DxColumn caption="Изменённые объекты (Oracle)" :calculate-cell-value="r => (r.recent || []).map(o => `${o.type} ${o.name} (${o.at})`).join('; ')" />
        <DxColumn caption="" :width="60" cell-template="del" />
        <template #del="{ data }"><DxButton icon="trash" styling-mode="text" @click="del(data.data)" /></template>
      </DxDataGrid>
    </div>
    <JobPanel v-if="cmpJob" :job-id="cmpJob" :report="true" @done="j => (diff = j.result)" />
    <div v-if="diff" class="panel">
      <b>{{ diff.source.name }} → {{ diff.target.name }}</b>
      <div v-if="!changes.length" class="ok">Структура не отличается</div>
      <DxDataGrid v-else :data-source="changes" :show-borders="true" :word-wrap-enabled="true">
        <DxGrouping :auto-expand-all="true" />
        <DxColumn data-field="category" caption="Категория" :group-index="0" />
        <DxColumn data-field="object" caption="Объект" :width="260" />
        <DxColumn caption="Изменение" :calculate-cell-value="f => f.source === '' ? 'добавлено' : f.target === '' ? 'удалено' : 'изменено'" :width="110" />
        <DxColumn data-field="source" caption="Было" css-class="mono" />
        <DxColumn data-field="target" caption="Стало" css-class="mono" />
        <DxColumn data-field="message" caption="" />
      </DxDataGrid>
    </div>
    <div class="panel">
      <div class="toolbar"><b>Журнал DDL — кто и когда менял структуру</b><span style="flex:1" />
        <DxButton text="Показать журнал" icon="bulletlist" styling-mode="outlined" :disabled="!db.connId" @click="loadJournal" />
        <DxButton text="Скрипт установки" icon="code" styling-mode="text" :disabled="!db.connId" @click="showSql" />
        <DxButton text="Установить в базу" icon="add" styling-mode="text" :disabled="!db.connId" @click="install" /></div>
      <pre v-if="journalSql" class="cmd" style="max-height:260px;overflow:auto">{{ journalSql }}</pre>
      <div v-if="journal && journal.notInstalled" class="warning">Журнал DDL в этой базе не установлен.</div>
      <DxDataGrid v-else-if="journal" :data-source="journal" :show-borders="true" :word-wrap-enabled="true">
        <DxPaging :page-size="30" /><DxSearchPanel :visible="true" />
        <DxColumn data-field="at" caption="Время" :width="170" /><DxColumn data-field="user" caption="Пользователь" :width="130" /><DxColumn data-field="client" caption="Откуда" :width="140" />
        <DxColumn data-field="command" caption="Команда" :width="140" /><DxColumn data-field="object" caption="Объект" :width="220" /><DxColumn data-field="sql" caption="SQL" css-class="mono" />
      </DxDataGrid>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { DxButton } from 'devextreme-vue/button';
import { DxTextBox } from 'devextreme-vue/text-box';
import { DxDataGrid, DxColumn, DxSelection, DxGrouping, DxPaging, DxSearchPanel } from 'devextreme-vue/data-grid';
import { confirm } from 'devextreme/ui/dialog';
import DbPicker from '../components/DbPicker.vue';
import JobPanel from '../components/JobPanel.vue';
import AddToSuite from '../components/AddToSuite.vue';
import { api, safe, toast } from '../api';
import { lastPick, connType } from '../store';

const lp = lastPick();
const db = ref({ connId: null, schema: '', ...lp.tgt });
const label = ref(''), snapJob = ref(null), list = ref([]), sel = ref([]);
const cmpJob = ref(null), diff = ref(null), journal = ref(null), journalSql = ref('');
const changes = computed(() => (diff.value ? diff.value.findings.filter(f => f.status !== 'ok') : []));
async function load() { if (!db.value.connId) return; list.value = (await safe(() => api.get(`/snapshots?connId=${db.value.connId}&schema=${encodeURIComponent(db.value.schema || '')}`))) || []; }
watch(() => [db.value.connId, db.value.schema], () => { load(); journal.value = null; journalSql.value = ''; }, { immediate: true });
async function snap() { const j = await safe(() => api.post('/jobs/schema-snapshot', { connId: db.value.connId, schema: db.value.schema, label: label.value })); if (j) snapJob.value = j.id; }
async function compare() {
  diff.value = null;
  const chosen = list.value.filter(s => sel.value.includes(s.id)).sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  const params = chosen.length === 2 ? { sourceSnapshot: chosen[0].id, sourceSchema: chosen[0].schema, targetSnapshot: chosen[1].id, targetSchema: chosen[1].schema, checkPgCode: false }
    : { sourceSnapshot: chosen[0].id, sourceSchema: chosen[0].schema, targetId: db.value.connId, targetSchema: db.value.schema, checkPgCode: false };
  const j = await safe(() => api.post('/jobs/schema-compare', params));
  if (j) cmpJob.value = j.id;
}
async function del(s) { if (await confirm('Удалить снимок?', 'История схемы')) { await safe(() => api.delete(`/snapshots/${s.id}`)); load(); } }
async function loadJournal() { journal.value = await safe(() => api.get(`/ddl-journal?connId=${db.value.connId}&schema=${encodeURIComponent(db.value.schema || '')}`)); }
async function showSql() { const r = await safe(() => api.get(`/ddl-journal/sql?type=${connType(db.value.connId)}&schema=${encodeURIComponent(db.value.schema || '')}`)); journalSql.value = r ? r.sql : ''; }
async function install() {
  if (!(await confirm(connType(db.value.connId) === 'postgres' ? 'Создать схему dbcmp_audit и событийные триггеры DDL (нужны права суперпользователя)?' : `Создать в схеме ${db.value.schema} таблицу DDL_LOG и триггер на DDL?`, 'Журнал DDL'))) return;
  const r = await safe(() => api.post('/ddl-journal/install', { connId: db.value.connId, schema: db.value.schema }));
  if (r) { toast('Журнал DDL установлен'); loadJournal(); }
}
</script>
