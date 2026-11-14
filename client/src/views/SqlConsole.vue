<template>
  <div>
    <h2 class="page">SQL-консоль</h2>
    <div class="panel">
      <div class="toolbar" style="margin-bottom:6px">
        <DxRadioGroup v-model:value="mode" layout="horizontal" value-expr="v" display-expr="t" :items="[{ v: 'one', t: 'Одна база' }, { v: 'two', t: 'Две базы рядом' }]" />
        <span style="flex:1" />
        <DxCheckBox v-model:value="readOnly" text="Только чтение (с откатом)" />
        <div class="field" style="width:120px;margin:0"><label>Строк, не больше</label><DxNumberBox v-model:value="maxRows" :min="1" :max="100000" /></div>
      </div>
      <div class="row">
        <DbPicker v-model="a" :label="mode === 'two' ? 'База 1' : 'База'" />
        <DbPicker v-if="mode === 'two'" v-model="b" label="База 2" />
      </div>
      <div class="row" style="align-items:stretch">
        <div class="tree">
          <DxTextBox v-model:value="treeFilter" placeholder="Фильтр объектов" value-change-event="input" mode="search" />
          <div class="tree-list">
            <div v-for="o in shownObjects" :key="o.name">
              <div class="tn" @click="o.open = !o.open" @dblclick="insert(o.name)"><span>{{ o.open ? '▾' : '▸' }}</span> {{ o.kind === 'view' ? '👁' : '▦' }} {{ o.name }}</div>
              <div v-if="o.open" class="cols"><div v-for="c in o.columns" :key="c.name" class="tc" @dblclick="insert(c.name)">{{ c.name }} <span class="hint">{{ c.type }}</span></div></div>
            </div>
            <div v-if="!objects.length" class="hint">Выберите базу и схему</div>
          </div>
          <div class="hint">Двойной щелчок — вставить имя</div>
        </div>
        <div style="flex:1;min-width:0">
          <textarea ref="ed" v-model="sql" class="editor" spellcheck="false" placeholder="SELECT … (Ctrl+Enter — выполнить; выделенный фрагмент выполняется отдельно)" @keydown="onKey" />
          <textarea v-if="mode === 'two' && separate" v-model="sql2" class="editor" style="height:110px" spellcheck="false" placeholder="Запрос для базы 2 (если отличается)" />
          <div class="toolbar">
            <DxButton text="Выполнить" icon="runner" type="default" :disabled="!a.connId || !sql.trim() || busy" @click="run" />
            <DxButton text="План выполнения" icon="chart" styling-mode="outlined" :disabled="!a.connId || !sql.trim()" @click="explain" />
            <DxCheckBox v-if="mode === 'two'" v-model:value="separate" text="Свой запрос для базы 2" />
            <div v-if="mode === 'two'" class="field" style="width:200px;margin:0"><label>Ключевые колонки (через запятую)</label><DxTextBox v-model:value="keyColumns" /></div>
            <span style="flex:1" />
            <DxSelectBox :items="history" :value="null" placeholder="История…" :width="260" :display-expr="h => h && h.replace(/\s+/g, ' ').slice(0, 80)" @value-changed="e => e.value && (sql = e.value)" />
          </div>
        </div>
      </div>
      <div v-if="busy" class="hint">Выполняется…</div>
      <div v-if="err" class="error" style="white-space:pre-wrap">{{ err }}</div>
    </div>

    <div v-if="res" class="panel">
      <template v-if="mode === 'one'">
        <div class="toolbar"><b>{{ res.columns.length ? `Строк: ${res.rows.length}${res.truncated ? ' (показаны первые)' : ''}` : `${res.command || 'Выполнено'}${res.rowCount != null ? ': строк ' + res.rowCount : ''}` }}</b>
          <span class="hint">{{ res.ms.toFixed(1) }} мс{{ readOnly ? ' · изменения откатаны' : '' }}</span><span style="flex:1" />
          <DxButton v-if="res.rows.length" text="CSV" icon="exportxlsx" styling-mode="text" @click="csv(res)" /></div>
        <div v-if="res.output" class="mono" style="white-space:pre-wrap">{{ res.output.join('\n') }}</div>
        <DxDataGrid v-if="res.columns.length" :data-source="gridRows(res)" :columns="gridCols(res)" :show-borders="true" :height="460" :column-auto-width="true" :allow-column-resizing="true">
          <DxScrolling mode="virtual" /><DxSearchPanel :visible="true" />
        </DxDataGrid>
      </template>
      <template v-else>
        <div v-if="res.diff" class="toolbar">
          <b :class="res.diff.equal ? 'ok' : 'error'">{{ res.diff.equal ? 'Результаты совпадают' : `Отличия: нет во 2-й ${res.diff.missing}, лишних ${res.diff.extra}, разных ${res.diff.different}` }}</b>
          <span v-if="res.diff.note" class="warning">{{ res.diff.note }}</span>
          <span class="hint">{{ fmt(res.source.ms) }} мс / {{ fmt(res.target.ms) }} мс</span>
        </div>
        <div class="row">
          <div class="col" style="min-width:0"><b>База 1</b>
            <div v-if="res.source.error" class="error">{{ res.source.error }}</div>
            <DxDataGrid v-else :data-source="gridRows(res.source)" :columns="gridCols(res.source)" :show-borders="true" :height="380" :column-auto-width="true"><DxScrolling mode="virtual" /></DxDataGrid></div>
          <div class="col" style="min-width:0"><b>База 2</b>
            <div v-if="res.target.error" class="error">{{ res.target.error }}</div>
            <DxDataGrid v-else :data-source="gridRows(res.target)" :columns="gridCols(res.target)" :show-borders="true" :height="380" :column-auto-width="true"><DxScrolling mode="virtual" /></DxDataGrid></div>
        </div>
        <template v-if="res.diff && res.diff.diffs.length">
          <h4>Отличия</h4>
          <div v-for="(d, i) in res.diff.diffs.slice(0, 100)" :key="i" class="mono">
            <span :class="d.type === 'different' ? 'warning' : 'error'">{{ { missing_in_target: 'нет во 2-й', extra_in_target: 'лишняя во 2-й', different: 'отличается' }[d.type] }}</span>
            {{ d.key ? JSON.stringify(d.key) : d.position ? `строка ${d.position}` : '' }}
            <template v-if="d.columns"><span v-for="c in d.columns" :key="c.name"> {{ c.name }}: {{ c.source }} → {{ c.target }};</span></template>
            <template v-else> {{ JSON.stringify(d.row) }}</template>
          </div>
        </template>
      </template>
    </div>
    <JobPanel v-if="planJob" :job-id="planJob" :report="false" @done="j => (plan = j.result)" />
    <PlanResults v-if="plan" :result="plan" />
  </div>
</template>

<script setup>
import { computed, onActivated, ref, watch } from 'vue';
import { DxButton } from 'devextreme-vue/button';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { DxNumberBox } from 'devextreme-vue/number-box';
import { DxRadioGroup } from 'devextreme-vue/radio-group';
import { DxSelectBox } from 'devextreme-vue/select-box';
import { DxTextBox } from 'devextreme-vue/text-box';
import { DxDataGrid, DxScrolling, DxSearchPanel } from 'devextreme-vue/data-grid';
import DbPicker from '../components/DbPicker.vue';
import JobPanel from '../components/JobPanel.vue';
import PlanResults from '../components/PlanResults.vue';
import { api, safe } from '../api';
import { lastPick } from '../store';

const pick = lastPick();
const a = ref({ connId: null, schema: '', ...pick.src }), b = ref({ connId: null, schema: '', ...pick.tgt });
const mode = ref('one'), readOnly = ref(true), maxRows = ref(1000), separate = ref(false), keyColumns = ref('');
const sql = ref(localStorage.getItem('dbcompare.sql') || ''), sql2 = ref('');
const res = ref(null), err = ref(''), busy = ref(false);
const objects = ref([]), treeFilter = ref('');
const ed = ref(null);
const planJob = ref(null), plan = ref(null);
const history = ref(JSON.parse(localStorage.getItem('dbcompare.sqlhistory') || '[]'));
const fmt = v => (v == null ? '—' : Number(v).toFixed(1));
const shownObjects = computed(() => { const f = treeFilter.value.toLowerCase(); return objects.value.filter(o => !f || o.name.toLowerCase().includes(f) || o.columns.some(c => c.name.toLowerCase().includes(f))).slice(0, 300); });

// строки приходят массивами — в таблице они раскладываются по номерам колонок (имена могут повторяться)
const gridCols = r => r.columns.map((c, i) => ({ dataField: `c${i}`, caption: c }));
const gridRows = r => r.rows.map(row => Object.fromEntries(row.map((v, i) => [`c${i}`, v === null ? null : typeof v === 'object' ? JSON.stringify(v) : v])));

async function loadTree() {
  objects.value = [];
  if (!a.value.connId || !a.value.schema) return;
  const r = await safe(() => api.get(`/connections/${a.value.connId}/columns?schema=${encodeURIComponent(a.value.schema)}`));
  if (r) objects.value = r.map(o => ({ ...o, open: false }));
}
watch(() => [a.value.connId, a.value.schema], loadTree, { immediate: true });
watch(sql, v => localStorage.setItem('dbcompare.sql', v));
watch(mode, () => { res.value = null; err.value = ''; });
// скрипт, переданный из других разделов («Открыть в SQL-консоли»)
function takePending() { const p = localStorage.getItem('dbcompare.sql.pending'); if (p) { sql.value = p; localStorage.removeItem('dbcompare.sql.pending'); readOnly.value = false; } }
takePending();
onActivated(takePending);

function current() {
  const el = ed.value;
  if (el && el.selectionEnd > el.selectionStart) return sql.value.slice(el.selectionStart, el.selectionEnd);
  return sql.value;
}
function insert(text) {
  const el = ed.value; const s = el ? el.selectionStart : sql.value.length;
  sql.value = sql.value.slice(0, s) + text + sql.value.slice(el ? el.selectionEnd : s);
}
function onKey(e) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
  if (e.key === 'Tab') { e.preventDefault(); insert('  '); }
}
function remember(q) {
  history.value = [q, ...history.value.filter(x => x !== q)].slice(0, 100);
  localStorage.setItem('dbcompare.sqlhistory', JSON.stringify(history.value));
}
async function run() {
  const q = current().trim();
  if (!q) return;
  if (!readOnly.value && !/^\s*(select|with)\b/i.test(q) && !confirm('Режим «только чтение» выключен: изменения будут зафиксированы. Выполнить?')) return;
  err.value = ''; res.value = null; busy.value = true; remember(q);
  try {
    if (mode.value === 'one') res.value = await api.post('/sql/run', { connId: a.value.connId, schema: a.value.schema, sql: q, readOnly: readOnly.value, maxRows: maxRows.value });
    else res.value = await api.post('/sql/compare', { sourceId: a.value.connId, sourceSchema: a.value.schema, targetId: b.value.connId, targetSchema: b.value.schema, sql: q, targetSql: separate.value && sql2.value.trim() ? sql2.value : undefined, readOnly: readOnly.value, maxRows: maxRows.value, keyColumns: keyColumns.value });
  } catch (e) { err.value = e.message; } finally { busy.value = false; }
}
async function explain() {
  plan.value = null;
  const q = current().trim();
  const j = await safe(() => api.post('/jobs/plan-compare', { sourceId: a.value.connId, sourceSchema: a.value.schema, targetId: mode.value === 'two' ? b.value.connId : undefined, targetSchema: b.value.schema,
    queries: [{ title: 'Запрос из консоли', sourceSql: q, targetSql: mode.value === 'two' && separate.value && sql2.value.trim() ? sql2.value : q }] }));
  if (j) planJob.value = j.id;
}
function csv(r) {
  const e = v => (v == null ? '' : /[";\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const text = '﻿' + [r.columns.map(e).join(';'), ...r.rows.map(row => row.map(e).join(';'))].join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  Object.assign(document.createElement('a'), { href: url, download: 'result.csv' }).click();
  URL.revokeObjectURL(url);
}
</script>

<style scoped>
.tree { width: 260px; display: flex; flex-direction: column; gap: 4px; }
.tree-list { border: 1px solid #e4e7ec; border-radius: 4px; height: 330px; overflow: auto; padding: 4px; font-size: 12.5px; }
.tn { cursor: pointer; white-space: nowrap; padding: 1px 2px; }
.tn:hover, .tc:hover { background: #eff8ff; }
.cols { padding-left: 18px; }
.tc { cursor: default; white-space: nowrap; }
.editor { width: 100%; height: 300px; font-family: Consolas, 'Courier New', monospace; font-size: 13px; padding: 8px; border: 1px solid #d0d5dd; border-radius: 4px; resize: vertical; box-sizing: border-box; tab-size: 2; }
</style>
