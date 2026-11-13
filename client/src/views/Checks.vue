<template>
  <div>
    <h2 class="page">Проверки результата</h2>
    <DxTabs :items="tabs" :selected-index="tab" width="auto" @item-click="e => (tab = e.itemIndex)" style="margin-bottom:12px" />
    <div class="panel">
      <div class="row">
        <DbPicker v-model="src" label="Источник" />
        <div class="arrow">⇄</div>
        <DbPicker v-model="tgt" label="Приёмник" />
      </div>
    </div>

    <!-- ===== Запросы ===== -->
    <div v-show="tab === 0" class="panel">
      <p class="hint" style="margin-top:0">Один и тот же набор запросов выполняется в обеих базах: сравниваются результаты (без учёта порядка строк или по ключевым колонкам)
        и время. Запросы, ставшие в PostgreSQL заметно медленнее, отмечаются, к ним прикладывается план (EXPLAIN). Можно добавить все общие представления
        и топ запросов из статистики (Oracle V$SQL, нужны права SELECT_CATALOG_ROLE; PostgreSQL — pg_stat_statements).</p>
      <div class="toolbar">
        <DxButton text="Добавить запрос" icon="add" styling-mode="outlined" @click="editQuery()" />
        <DxButton text="Топ запросов источника" icon="chart" styling-mode="outlined" :disabled="!src.connId" @click="loadTop" />
        <DxCheckBox v-model:value="qs.includeViews" text="+ все общие представления" />
        <span style="flex:1" />
        <DxSelectBox v-model:value="qs.setId" :items="sets" value-expr="id" display-expr="name" placeholder="Сохранённые наборы…" :width="230" :show-clear-button="true" @value-changed="loadSet" />
        <DxButton text="Сохранить набор" icon="save" styling-mode="text" @click="saveSet" />
      </div>
      <DxDataGrid :data-source="qs.queries" :show-borders="true" :word-wrap-enabled="true" no-data-text="Добавьте запросы или включите «все общие представления»">
        <DxColumn data-field="name" caption="Название" :width="200" />
        <DxColumn data-field="sqlSource" caption="SQL для источника" cell-template="sql" />
        <DxColumn data-field="sqlTarget" caption="SQL для приёмника (пусто — тот же)" cell-template="sql" />
        <DxColumn data-field="keyColumns" caption="Ключ" :width="110" />
        <DxColumn caption="" cell-template="act" :width="90" />
        <template #sql="{ data }"><pre class="mono" style="margin:0;white-space:pre-wrap;max-height:90px;overflow:auto">{{ data.value }}</pre></template>
        <template #act="{ data }"><DxButton icon="edit" styling-mode="text" @click="editQuery(data.rowIndex)" /><DxButton icon="trash" styling-mode="text" @click="qs.queries.splice(data.rowIndex, 1)" /></template>
      </DxDataGrid>
      <div class="row" style="margin-top:10px">
        <div class="field" style="width:130px"><label>Повторов (медиана)</label><DxNumberBox v-model:value="qs.repeat" :min="1" :max="10" :show-spin-buttons="true" /></div>
        <div class="field" style="width:150px"><label>Медленнее в N раз</label><DxNumberBox v-model:value="qs.slowRatio" :min="1" :max="100" /></div>
        <div class="field" style="width:150px"><label>Допуск чисел</label><DxNumberBox v-model:value="qs.absTolerance" :min="0" format="#0.##########" /></div>
        <div class="field" style="width:150px"><label>Макс. строк</label><DxNumberBox v-model:value="qs.maxRows" :min="100" :step="10000" /></div>
      </div>
      <div class="toolbar">
        <DxButton text="Сравнить" icon="runner" type="default" :disabled="!ready || (!qs.queries.length && !qs.includeViews)" @click="runQueries" />
        <AddToSuite type="query-compare" :params="queryParams" default-title="Запросы" />
      </div>
      <template v-if="qResult">
        <div class="cards">
          <div class="card"><div class="v">{{ qResult.summary.queries }}</div><div class="l">запросов</div></div>
          <div class="card"><div class="v ok">{{ qResult.summary.equal }}</div><div class="l">совпадают</div></div>
          <div class="card"><div class="v error">{{ qResult.summary.different }}</div><div class="l">отличаются</div></div>
          <div class="card"><div class="v error">{{ qResult.summary.error }}</div><div class="l">ошибок</div></div>
          <div class="card"><div class="v warning">{{ qResult.summary.slow }}</div><div class="l">медленнее</div></div>
          <div class="card"><div class="v">{{ fmtMs(qResult.summary.msSource) }} → {{ fmtMs(qResult.summary.msTarget) }}</div><div class="l">общее время</div></div>
        </div>
        <DxDataGrid :data-source="qResult.queries" :show-borders="true" :column-auto-width="true" :word-wrap-enabled="true">
          <DxFilterRow :visible="true" />
          <DxColumn data-field="name" caption="Запрос" />
          <DxColumn data-field="status" caption="Результат" cell-template="st" />
          <DxColumn data-field="rowsSource" caption="Строк ист." data-type="number" />
          <DxColumn data-field="rowsTarget" caption="Строк приём." data-type="number" />
          <DxColumn data-field="msSource" caption="Время ист." :calculate-display-value="r => fmtMs(r.msSource)" />
          <DxColumn data-field="msTarget" caption="Время приём." cell-template="tm" />
          <DxMasterDetail :enabled="true" template="det" />
          <template #st="{ data }"><span :class="{ equal: 'ok', different: 'error', error: 'error' }[data.value]">{{ { equal: 'совпадает', different: `отличается (нет ${data.data.missing}, лишних ${data.data.extra}, разных ${data.data.different})`, error: data.data.error }[data.value] }}</span></template>
          <template #tm="{ data }"><span :class="data.data.slow ? 'warning' : ''">{{ fmtMs(data.value) }}{{ data.data.ratio != null ? ` (×${data.data.ratio})` : '' }}</span></template>
          <template #det="{ data }">
            <div>
              <div v-if="data.data.note" class="warning">{{ data.data.note }}</div>
              <div v-for="(d, i) in (data.data.diffs || [])" :key="i" class="mono" style="margin-bottom:4px">
                <b>{{ { missing_in_target: 'нет в приёмнике', extra_in_target: 'лишняя в приёмнике', different: 'отличается' }[d.type] }}</b>
                <span v-if="d.key"> {{ JSON.stringify(d.key) }}</span>
                <span v-if="d.columns">: <span v-for="c in d.columns" :key="c.name">{{ c.name }}: <span class="ok">{{ c.source }}</span> → <span class="error">{{ c.target }}</span>; </span></span>
                <span v-else> {{ JSON.stringify(d.row) }}</span>
              </div>
              <template v-if="data.data.plan"><b>План в PostgreSQL:</b><pre class="cmd">{{ data.data.plan }}</pre></template>
            </div>
          </template>
        </DxDataGrid>
      </template>
    </div>

    <!-- ===== Расчёты ===== -->
    <div v-show="tab === 1" class="panel">
      <p class="hint" style="margin-top:0">Расчёт запускается в обеих базах, затем итоговые таблицы сравниваются построчно <b>в тех же сессиях</b> и обе транзакции откатываются —
        базы не меняются. Если процедура Oracle сама делает COMMIT, откатить её нельзя — запускайте только на тестовой копии.
        Операторы разделяйте строкой из одного символа «/» (как в SQL*Plus).</p>
      <div class="row">
        <div class="col"><div class="field"><label>Шаги в источнике</label>
          <DxTextArea v-model:value="cv.sourceSteps" :height="140" placeholder="BEGIN maket_pt_2026.raschet(DATE '2026-01-01'); END;&#10;/" /></div></div>
        <div class="col"><div class="field"><label>Шаги в приёмнике (пусто — те же)</label>
          <DxTextArea v-model:value="cv.targetSteps" :height="140" placeholder="CALL maket_pt_2026_raschet('2026-01-01')" /></div></div>
      </div>
      <div class="row">
        <div class="field col"><label>Итоговые таблицы для сравнения</label>
          <DxTagBox v-model:value="cv.tables" :items="tableNames" :search-enabled="true" :accept-custom-value="true" placeholder="Выберите таблицы" /></div>
        <div class="field" style="width:150px"><label>Допуск чисел</label><DxNumberBox v-model:value="cv.absTolerance" :min="0" format="#0.##########" /></div>
      </div>
      <div class="toolbar">
        <DxCheckBox v-model:value="cv.rollback" text="Откатить после сравнения" />
        <DxButton text="Запустить и сверить" icon="runner" type="default" :disabled="!ready || !cv.sourceSteps || !cv.tables.length" @click="runCalc" />
        <DxSelectBox v-model:value="cv.scenarioId" :items="scenarios" value-expr="id" display-expr="name" placeholder="Сохранённые сценарии…" :width="230" :show-clear-button="true" @value-changed="loadScenario" />
        <DxButton text="Сохранить сценарий" icon="save" styling-mode="text" @click="saveScenario" />
        <AddToSuite type="calc-verify" :params="calcParams" default-title="Расчёты" />
      </div>
      <template v-if="cvResult">
        <div class="cards">
          <div class="card"><div class="v ok">{{ cvResult.summary.equal }}</div><div class="l">таблиц совпадает</div></div>
          <div class="card"><div class="v error">{{ cvResult.summary.different }}</div><div class="l">отличаются</div></div>
          <div class="card"><div class="v">{{ fmtMs(cvResult.summary.msSource) }} → {{ fmtMs(cvResult.summary.msTarget) }}</div><div class="l">время расчёта</div></div>
        </div>
        <div v-if="cvResult.error" class="error" style="margin-bottom:8px">{{ cvResult.error }}</div>
        <DxDataGrid :data-source="cvResult.tables" :show-borders="true">
          <DxColumn data-field="table" caption="Таблица" />
          <DxColumn data-field="status" caption="Статус" :calculate-display-value="r => ({ equal: 'совпадает', different: 'отличается', error: r.error }[r.status])" />
          <DxColumn data-field="sourceRows" caption="Строк ист." /><DxColumn data-field="targetRows" caption="Строк приём." />
          <DxColumn data-field="missing" caption="Нет в приёмнике" /><DxColumn data-field="extra" caption="Лишние" /><DxColumn data-field="different" caption="Различаются" />
          <DxMasterDetail :enabled="true" template="det" />
          <template #det="{ data }">
            <div v-for="(d, i) in (data.data.diffs || [])" :key="i" class="mono">{{ JSON.stringify(d.key) }}: <span v-for="c in (d.columns || [])" :key="c.name">{{ c.name }} {{ c.source }} → {{ c.target }}; </span><span v-if="d.row">{{ d.type }} {{ JSON.stringify(d.row) }}</span></div>
          </template>
        </DxDataGrid>
      </template>
    </div>

    <!-- ===== Агрегаты ===== -->
    <div v-show="tab === 2" class="panel">
      <p class="hint" style="margin-top:0">Быстрая сверка больших таблиц без построчного сравнения: число строк, суммы, минимумы и максимумы чисел, диапазоны дат,
        суммарная длина строк и LOB — по таблице целиком или по месяцам/годам колонки-даты (или по значениям колонки). Построчное сравнение затем
        запускается только для разошедшихся групп.</p>
      <div class="toolbar">
        <DxButton text="Загрузить таблицы" icon="refresh" styling-mode="outlined" :disabled="!src.connId || !src.schema" @click="loadAggTables" />
        <div class="field" style="width:170px;margin:0"><label>Группировка дат</label>
          <DxSelectBox v-model:value="ag.granularity" :items="[{ v: 'month', t: 'по месяцам' }, { v: 'year', t: 'по годам' }]" value-expr="v" display-expr="t" /></div>
        <div class="field" style="width:150px;margin:0"><label>Допуск чисел</label><DxNumberBox v-model:value="ag.absTolerance" :min="0" format="#0.##########" /></div>
      </div>
      <DxDataGrid v-if="ag.tables.length" :data-source="ag.tables" key-expr="source" :show-borders="true" :height="280"
        :selected-row-keys="ag.selected" @selection-changed="e => (ag.selected = e.selectedRowKeys)">
        <DxSelection mode="multiple" show-check-boxes-mode="always" /><DxEditing mode="cell" :allow-updating="true" />
        <DxSearchPanel :visible="true" /><DxScrolling mode="virtual" />
        <DxColumn data-field="source" caption="Таблица" :allow-editing="false" />
        <DxColumn data-field="rows" caption="≈ строк" :allow-editing="false" :width="120" />
        <DxColumn data-field="groupBy" caption="Колонка группировки (дата или код) — необязательно" />
      </DxDataGrid>
      <div class="toolbar" style="margin-top:10px">
        <DxCheckBox v-model:value="ag.detailOnMismatch" text="Построчно сравнить только разошедшиеся группы" />
        <DxButton text="Сверить" icon="runner" type="default" :disabled="!ready" @click="runAgg" />
        <AddToSuite type="agg-compare" :params="aggParams" default-title="Агрегаты" />
      </div>
      <template v-if="agResult">
        <div class="cards">
          <div class="card"><div class="v ok">{{ agResult.summary.equal }}</div><div class="l">таблиц совпадает</div></div>
          <div class="card"><div class="v error">{{ agResult.summary.different }}</div><div class="l">расхождения</div></div>
          <div class="card"><div class="v error">{{ agResult.summary.error }}</div><div class="l">ошибок</div></div>
          <div class="card"><div class="v">{{ fmtNum(agResult.summary.rowsSource) }} / {{ fmtNum(agResult.summary.rowsTarget) }}</div><div class="l">строк</div></div>
        </div>
        <DxDataGrid :data-source="agResult.tables" :show-borders="true" :word-wrap-enabled="true">
          <DxColumn data-field="table" caption="Таблица" />
          <DxColumn data-field="status" caption="Статус" cell-template="st" />
          <DxColumn data-field="rowsSource" caption="Строк ист." data-type="number" format="#,##0" />
          <DxColumn data-field="rowsTarget" caption="Строк приём." data-type="number" format="#,##0" />
          <DxColumn caption="Групп (расхождений)" :calculate-cell-value="r => r.groups != null ? `${r.groups} (${r.badGroups})` : ''" />
          <DxColumn caption="Колонки с расхождениями" :calculate-cell-value="r => (r.diffColumns || []).join(', ')" />
          <DxColumn data-field="ms" caption="Время" :calculate-display-value="r => fmtMs(r.ms)" />
          <DxMasterDetail :enabled="true" template="det" />
          <template #st="{ data }"><span :class="{ equal: 'ok', different: 'error', error: 'error' }[data.value]">{{ { equal: 'совпадает', different: 'расхождения', error: data.data.error }[data.value] }}</span></template>
          <template #det="{ data }">
            <div v-for="g in (data.data.groupsDetail || [])" :key="String(g.group)" class="mono" style="margin-bottom:4px">
              <b>{{ g.group == null ? (data.data.groupBy ? 'NULL' : 'вся таблица') : g.group }}</b>:
              <span v-for="d in g.diffs" :key="d.column + d.agg">{{ d.column }}.{{ d.agg }} <span class="ok">{{ d.source }}</span> → <span class="error">{{ d.target }}</span>; </span>
            </div>
          </template>
        </DxDataGrid>
        <div v-if="agResult.detail" style="margin-top:10px">
          <h3>Построчно по расхождениям</h3>
          <DxDataGrid :data-source="agResult.detail.tables" :show-borders="true">
            <DxColumn data-field="table" caption="Таблица" /><DxColumn data-field="missing" caption="Нет в приёмнике" /><DxColumn data-field="extra" caption="Лишние" /><DxColumn data-field="different" caption="Различаются" />
            <DxMasterDetail :enabled="true" template="d2" />
            <template #d2="{ data }"><div v-for="(d, i) in (data.data.diffs || [])" :key="i" class="mono">{{ d.type }} {{ JSON.stringify(d.key) }} <span v-for="c in (d.columns || [])" :key="c.name">{{ c.name }}: {{ c.source }} → {{ c.target }}; </span></div></template>
          </DxDataGrid>
        </div>
      </template>
    </div>

    <JobPanel v-if="jobId" :job-id="jobId" :report="false" @done="onDone" />

    <DxPopup v-model:visible="qEdit.visible" title="Запрос" :width="860" height="auto" :show-close-button="true">
      <div>
        <div class="row">
          <div class="field" style="flex:2"><label>Название</label><DxTextBox v-model:value="qEdit.q.name" /></div>
          <div class="field" style="flex:1"><label>Ключевые колонки (через запятую)</label><DxTextBox v-model:value="qEdit.q.keyColumns" placeholder="без ключа — набор строк" /></div>
        </div>
        <div class="row">
          <div class="col"><div class="field"><label>SQL для источника</label><DxTextArea v-model:value="qEdit.q.sqlSource" :height="200" /></div></div>
          <div class="col"><div class="field"><label>SQL для приёмника (пусто — тот же)</label><DxTextArea v-model:value="qEdit.q.sqlTarget" :height="200" /></div></div>
        </div>
        <div class="toolbar" style="justify-content:flex-end"><DxCheckBox v-model:value="qEdit.q.ordered" text="Сравнивать по порядку строк (ORDER BY)" /><DxButton text="Сохранить" type="default" @click="saveQuery" /></div>
      </div>
    </DxPopup>
    <DxPopup v-model:visible="top.visible" title="Топ запросов источника" :width="980" :height="620" :show-close-button="true">
      <div>
        <DxDataGrid :data-source="top.items" key-expr="id" :show-borders="true" :height="480" :word-wrap-enabled="true"
          :selected-row-keys="top.selected" @selection-changed="e => (top.selected = e.selectedRowKeys)">
          <DxSelection mode="multiple" show-check-boxes-mode="always" />
          <DxColumn data-field="executions" caption="Выполнений" :width="100" />
          <DxColumn data-field="avgMs" caption="Ср. мс" :width="80" />
          <DxColumn data-field="sql" caption="SQL" cell-template="sql" />
          <DxColumn data-field="hasBinds" caption="Параметры" :width="100" :calculate-display-value="r => r.hasBinds ? 'есть — подставьте' : ''" />
          <template #sql="{ data }"><pre class="mono" style="margin:0;white-space:pre-wrap;max-height:100px;overflow:auto">{{ data.value }}</pre></template>
        </DxDataGrid>
        <div class="toolbar" style="justify-content:flex-end;margin-top:8px"><span class="hint">SQL для PostgreSQL заполните после добавления (замените NVL, ROWNUM и т. п. — см. «Код приложения»).</span><DxButton text="Добавить выбранные" type="default" @click="addTop" /></div>
      </div>
    </DxPopup>
  </div>
</template>

<script setup>
import { computed, reactive, ref, onMounted } from 'vue';
import { DxTabs } from 'devextreme-vue/tabs';
import { DxButton } from 'devextreme-vue/button';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { DxSelectBox } from 'devextreme-vue/select-box';
import { DxNumberBox } from 'devextreme-vue/number-box';
import { DxTextBox } from 'devextreme-vue/text-box';
import { DxTextArea } from 'devextreme-vue/text-area';
import { DxTagBox } from 'devextreme-vue/tag-box';
import { DxPopup } from 'devextreme-vue/popup';
import { DxDataGrid, DxColumn, DxSelection, DxEditing, DxSearchPanel, DxScrolling, DxFilterRow, DxMasterDetail } from 'devextreme-vue/data-grid';
import DbPicker from '../components/DbPicker.vue';
import JobPanel from '../components/JobPanel.vue';
import AddToSuite from '../components/AddToSuite.vue';
import { api, safe, toast, fmtMs, fmtNum } from '../api';
import { lastPick, rememberPick } from '../store';
import { useJobFromRoute } from '../jobroute';

const tabs = [{ text: 'Сравнение запросов' }, { text: 'Сверка расчётов' }, { text: 'Сверка по агрегатам' }];
const tab = ref(0);
const lp = lastPick();
const src = ref(lp.src || { connId: null, schema: '' });
const tgt = ref(lp.tgt || { connId: null, schema: '' });
const ready = computed(() => src.value.connId && src.value.schema && tgt.value.connId && tgt.value.schema);
const base = () => ({ sourceId: src.value.connId, sourceSchema: src.value.schema, targetId: tgt.value.connId, targetSchema: tgt.value.schema });
const jobId = ref(null);
async function start(type, p) {
  rememberPick({ src: src.value, tgt: tgt.value });
  const j = await safe(() => api.post(`/jobs/${type}`, p));
  if (j) jobId.value = j.id;
}

// --- запросы
const qs = reactive({ queries: [], includeViews: true, repeat: 1, slowRatio: 2, absTolerance: 0, maxRows: 200000, setId: null });
const qResult = ref(null);
const sets = ref([]);
const qEdit = reactive({ visible: false, idx: -1, q: {} });
const top = reactive({ visible: false, items: [], selected: [] });
function editQuery(idx = -1) { qEdit.idx = idx; qEdit.q = idx >= 0 ? { ...qs.queries[idx] } : { name: `Запрос ${qs.queries.length + 1}`, sqlSource: '', sqlTarget: '', keyColumns: '', ordered: false }; qEdit.visible = true; }
function saveQuery() { if (!qEdit.q.sqlSource) return toast('Введите SQL', 'warning'); if (qEdit.idx >= 0) qs.queries.splice(qEdit.idx, 1, { ...qEdit.q }); else qs.queries.push({ ...qEdit.q }); qEdit.visible = false; }
async function loadTop() {
  const r = await safe(() => api.get(`/connections/${src.value.connId}/topsql?schema=${encodeURIComponent(src.value.schema)}&limit=50`));
  if (r) { top.items = r; top.selected = []; top.visible = true; }
}
function addTop() {
  for (const t of top.items.filter(x => top.selected.includes(x.id))) qs.queries.push({ name: `Топ ${t.id}`, sqlSource: t.sql, sqlTarget: '', keyColumns: '', ordered: false });
  top.visible = false;
}
async function loadSets() { sets.value = (await safe(() => api.get('/saved/querysets'))) || []; scenarios.value = (await safe(() => api.get('/saved/scenarios'))) || []; }
function loadSet(e) { const s = sets.value.find(x => x.id === e.value); if (s) { qs.queries = JSON.parse(JSON.stringify(s.queries || [])); qs.includeViews = !!s.includeViews; } }
async function saveSet() {
  const cur = sets.value.find(x => x.id === qs.setId);
  const name = cur ? cur.name : prompt('Название набора запросов', 'Отчёты');
  if (!name) return;
  const r = await safe(() => api.post('/saved/querysets', { id: cur && cur.id, name, queries: qs.queries, includeViews: qs.includeViews }));
  if (r) { toast('Набор сохранён'); await loadSets(); qs.setId = r.id; }
}
const queryParams = () => (ready.value ? { ...base(), queries: qs.queries, includeViews: qs.includeViews, repeat: qs.repeat, slowRatio: qs.slowRatio, absTolerance: qs.absTolerance, maxRows: qs.maxRows } : null);
function runQueries() { qResult.value = null; start('query-compare', queryParams()); }

// --- расчёты
const cv = reactive({ sourceSteps: '', targetSteps: '', tables: [], absTolerance: 0, rollback: true, scenarioId: null });
const cvResult = ref(null);
const scenarios = ref([]);
const tableNames = ref([]);
async function loadTableNames() {
  if (!src.value.connId || !src.value.schema) return;
  const r = await safe(() => api.get(`/connections/${src.value.connId}/tables?schema=${encodeURIComponent(src.value.schema)}`));
  if (r) tableNames.value = r.map(t => t.name);
}
const calcParams = () => (ready.value && cv.sourceSteps ? { ...base(), sourceSteps: cv.sourceSteps, targetSteps: cv.targetSteps || undefined, tables: cv.tables, absTolerance: cv.absTolerance, rollback: cv.rollback } : null);
function runCalc() { cvResult.value = null; start('calc-verify', calcParams()); }
function loadScenario(e) { const s = scenarios.value.find(x => x.id === e.value); if (s) Object.assign(cv, { sourceSteps: s.sourceSteps, targetSteps: s.targetSteps, tables: s.tables || [], absTolerance: s.absTolerance || 0 }); }
async function saveScenario() {
  const cur = scenarios.value.find(x => x.id === cv.scenarioId);
  const name = cur ? cur.name : prompt('Название сценария', 'Расчёт');
  if (!name) return;
  const r = await safe(() => api.post('/saved/scenarios', { id: cur && cur.id, name, sourceSteps: cv.sourceSteps, targetSteps: cv.targetSteps, tables: cv.tables, absTolerance: cv.absTolerance }));
  if (r) { toast('Сценарий сохранён'); await loadSets(); cv.scenarioId = r.id; }
}

// --- агрегаты
const ag = reactive({ tables: [], selected: [], granularity: 'month', absTolerance: 0, detailOnMismatch: true });
const agResult = ref(null);
async function loadAggTables() {
  const r = await safe(() => api.get(`/connections/${src.value.connId}/tables?schema=${encodeURIComponent(src.value.schema)}`));
  if (r) { ag.tables = r.map(t => ({ source: t.name, rows: t.rows, groupBy: '' })); ag.selected = []; }
  loadTableNames();
}
const aggParams = () => {
  if (!ready.value) return null;
  const pick = ag.selected.length ? ag.tables.filter(t => ag.selected.includes(t.source)) : ag.tables;
  return { ...base(), tables: pick.length ? pick.map(t => ({ source: t.source, groupBy: t.groupBy || undefined })) : undefined, granularity: ag.granularity, absTolerance: ag.absTolerance, detailOnMismatch: ag.detailOnMismatch };
};
function runAgg() { agResult.value = null; start('agg-compare', aggParams()); }

function onDone(j) {
  if (!j.result) return;
  if (j.type === 'query-compare') qResult.value = j.result;
  if (j.type === 'calc-verify') cvResult.value = j.result;
  if (j.type === 'agg-compare') agResult.value = j.result;
}
useJobFromRoute(['query-compare', 'calc-verify', 'agg-compare'], j => { tab.value = { 'query-compare': 0, 'calc-verify': 1, 'agg-compare': 2 }[j.type]; jobId.value = j.id; });
onMounted(() => { loadSets(); loadTableNames(); });
</script>
