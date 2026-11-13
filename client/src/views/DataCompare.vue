<template>
  <div>
    <h2 class="page">Сравнение данных</h2>
    <div class="panel">
      <div class="row">
        <DbPicker v-model="src" label="Источник" />
        <div class="arrow">⇄</div>
        <DbPicker v-model="tgt" label="Приёмник" />
      </div>
      <div class="toolbar">
        <DxButton text="Загрузить список таблиц" icon="refresh" styling-mode="outlined" :disabled="!ready" @click="loadTables" />
        <template v-if="tables.length">
          <span class="hint">Общих таблиц: {{ tables.length }}, выбрано: {{ selected.length || 'все' }}. Фильтр по подстроке — в поле поиска; ключ и WHERE задаются двойным кликом по ячейке.</span>
          <span style="flex:1" />
          <DxSelectBox v-model:value="relDir" :items="[{ v: 'deps', t: 'родительские (FK)' }, { v: 'dependents', t: 'дочерние (FK)' }, { v: 'both', t: 'родительские и дочерние' }]" value-expr="v" display-expr="t" :width="230" />
          <DxButton text="Добавить связанные таблицы" icon="link" styling-mode="outlined" :disabled="!selected.length" @click="addRelated" />
        </template>
      </div>
      <DxDataGrid v-if="tables.length" :data-source="tables" key-expr="source" :show-borders="true" :height="300"
        :selected-row-keys="selected" @selection-changed="e => (selected = e.selectedRowKeys)">
        <DxSelection mode="multiple" show-check-boxes-mode="always" />
        <DxEditing mode="cell" :allow-updating="true" />
        <DxSearchPanel :visible="true" placeholder="Поиск таблицы…" />
        <DxScrolling mode="virtual" />
        <DxColumn data-field="source" caption="Таблица (источник)" :allow-editing="false" />
        <DxColumn data-field="target" caption="Таблица (приёмник)" :allow-editing="false" />
        <DxColumn data-field="rowsA" caption="≈ строк ист." :allow-editing="false" :width="110" />
        <DxColumn data-field="rowsB" caption="≈ строк приём." :allow-editing="false" :width="120" />
        <DxColumn data-field="keyColumns" caption="Ключ (если нет PK)" :width="170" />
        <DxColumn data-field="sourceWhere" caption="WHERE в источнике" />
        <DxColumn data-field="targetWhere" caption="WHERE в приёмнике" />
      </DxDataGrid>

      <div class="row" style="margin-top:12px">
        <div class="field" style="min-width:230px">
          <label>Пустая строка = NULL</label>
          <DxSelectBox v-model:value="opts.emptyAsNull" :items="[{ v: null, t: 'авто (да для Oracle⇄PG)' }, { v: true, t: 'да' }, { v: false, t: 'нет' }]" value-expr="v" display-expr="t" />
        </div>
        <div class="field" style="width:150px"><label>Примеров отличий на таблицу</label><DxNumberBox v-model:value="opts.maxDiffs" :min="1" :max="10000" :show-spin-buttons="true" /></div>
        <div class="field" style="width:120px"><label>Параллельно таблиц</label><DxNumberBox v-model:value="opts.parallel" :min="1" :max="8" :show-spin-buttons="true" /></div>
        <div class="field" style="width:150px"><label>Допуск чисел, абсолютный</label><DxNumberBox v-model:value="opts.absTolerance" :min="0" format="#0.##########" placeholder="0" /></div>
        <div class="field" style="width:160px"><label>Допуск чисел, относительный</label><DxNumberBox v-model:value="opts.relTolerance" :min="0" format="#0.##########" placeholder="0, напр. 0.000001" /></div>
        <div class="field" style="width:150px"><label>Точность float (цифр)</label><DxNumberBox v-model:value="opts.floatPrecision" :min="6" :max="17" :show-spin-buttons="true" /></div>
        <div class="field col"><label>Исключить колонки (имя или таблица.колонка)</label>
          <DxTagBox v-model:value="opts.excludeColumns" :items="[]" :accept-custom-value="true" placeholder="например: updated_at, emp.photo" @custom-item-creating="e => (e.customItem = e.text)" />
        </div>
      </div>
      <div class="toolbar">
        <DxCheckBox v-model:value="opts.trimTrailingSpaces" text="Обрезать хвостовые пробелы у всех строк" />
        <DxCheckBox v-model:value="opts.compareLobs" text="Сравнивать LOB (CLOB/BLOB/text/bytea)" />
        <DxCheckBox v-model:value="opts.forceMapMode" text="Режим хеш-таблицы (если сортировка в СУБД различается)" />
      </div>
      <div class="toolbar">
        <DxButton text="Сравнить данные" icon="runner" type="default" :disabled="!ready" @click="run" />
        <span class="hint">Строки сопоставляются по первичному ключу потоковым merge-join (как в pgCompare/reladiff), значения нормализуются: числа, даты (UTC, микросекунды), CHAR, NULL/'' , JSON, бинарные данные. Таблицы без ключа сравниваются как наборы строк. Допуск: числа считаются равными, если |a−b| ≤ абсолютного допуска или ≤ относительного × max(|a|,|b|) — полезно для расчётных таблиц (округления Oracle и PostgreSQL).</span>
      </div>
    </div>

    <JobPanel v-if="jobId" :job-id="jobId" @done="onDone" @update="onUpdate" />

    <template v-if="result">
      <div v-if="lastParams && (result.summary.different || 0) > 0" class="panel">
        <div class="toolbar" style="margin:0">
          <b>Скрипт синхронизации данных</b>
          <span class="hint">Приводит данные приёмника к источнику для таблиц с отличиями. Порядок — по внешним ключам.</span>
        </div>
        <div class="toolbar" style="margin:8px 0 0">
          <DxCheckBox v-model:value="syncOpt.insert" text="INSERT отсутствующих строк" />
          <DxCheckBox v-model:value="syncOpt.update" text="UPDATE отличающихся" />
          <DxCheckBox v-model:value="syncOpt.delete" text="DELETE лишних в приёмнике" />
          <DxCheckBox v-model:value="syncOpt.apply" text="Сразу выполнить на приёмнике" />
          <DxButton :text="syncOpt.apply ? 'Построить и выполнить' : 'Построить скрипт'" icon="codeblock" :type="syncOpt.apply ? 'danger' : 'default'" @click="runSync" />
        </div>
        <JobPanel v-if="syncJobId" :job-id="syncJobId" :report="false" @done="j => (syncResult = j.result)" />
        <div v-if="syncResult" class="toolbar" style="margin-top:8px">
          <span>INSERT: <b>{{ fmtNum(syncResult.summary.insert) }}</b>, UPDATE: <b>{{ fmtNum(syncResult.summary.update) }}</b>, DELETE: <b>{{ fmtNum(syncResult.summary.delete) }}</b></span>
          <span v-if="syncResult.applied" class="ok">выполнено на приёмнике: {{ fmtNum(syncResult.applied.executed) }}</span>
          <a :href="`/api/files/sync/${syncResult.script.jobId}/${encodeURIComponent(syncResult.script.name)}`">Скачать {{ syncResult.script.name }} ({{ fmtSize(syncResult.script.size) }})</a>
          <span v-if="syncResult.stats.deleteNoKey" class="warning">В таблицах без ключа лишних строк {{ syncResult.stats.deleteNoKey }} — удалить скриптом нельзя.</span>
        </div>
      </div>
      <div class="cards">
        <div class="card"><div class="v">{{ result.summary.tables }}</div><div class="l">таблиц</div></div>
        <div class="card"><div class="v ok">{{ result.summary.equal || 0 }}</div><div class="l">совпадают</div></div>
        <div class="card"><div class="v error">{{ result.summary.different || 0 }}</div><div class="l">отличаются</div></div>
        <div class="card"><div class="v error">{{ result.summary.error || 0 }}</div><div class="l">ошибок</div></div>
        <div v-if="result.summary.withinTolerance" class="card"><div class="v warning">{{ fmtNum(result.summary.withinTolerance) }}</div><div class="l">строк в пределах допуска</div></div>
        <div class="card"><div class="v">{{ fmtNum(result.summary.missing) }} / {{ fmtNum(result.summary.extra) }} / {{ fmtNum(result.summary.differentRows) }}</div><div class="l">строк: нет в приёмнике / лишние / разные</div></div>
      </div>
      <div class="panel" style="padding:8px">
        <DxDataGrid :data-source="result.tables" key-expr="table" :show-borders="true" :column-auto-width="true" :row-alternation-enabled="true">
          <DxSearchPanel :visible="true" />
          <DxFilterRow :visible="true" />
          <DxColumn data-field="table" caption="Таблица" />
          <DxColumn data-field="status" caption="Статус" cell-template="st" :lookup="{ dataSource: stLookup, valueExpr: 'v', displayExpr: 't' }" />
          <DxColumn data-field="sourceRows" caption="Строк ист." data-type="number" format="#,##0" />
          <DxColumn data-field="targetRows" caption="Строк приём." data-type="number" format="#,##0" />
          <DxColumn data-field="missing" caption="Нет в приёмнике" data-type="number" css-class="error" />
          <DxColumn data-field="extra" caption="Лишние" data-type="number" css-class="error" />
          <DxColumn data-field="different" caption="Различаются" data-type="number" css-class="error" />
          <DxColumn data-field="withinTolerance" caption="В допуске" data-type="number" :visible="!!result.summary.withinTolerance" />
          <DxColumn caption="Колонки с отличиями" :calculate-cell-value="r => Object.entries(r.diffColumns || {}).map(([k, v]) => `${k}: ${v}`).join(', ')" />
          <DxColumn data-field="mode" caption="Режим" :width="90" />
          <DxColumn data-field="ms" caption="Время" :calculate-display-value="r => fmtMs(r.ms)" :width="80" />
          <DxMasterDetail :enabled="true" template="detail" />
          <template #st="{ data }"><span :class="data.value" :title="data.data.error || data.data.note">{{ STATUS[data.value] || data.value }}{{ data.data.error ? ': ' + data.data.error : '' }}</span></template>
          <template #detail="{ data }">
            <div>
              <div class="hint" style="margin-bottom:6px">
                Ключ: <b>{{ (data.data.keyColumns || []).join(', ') || 'нет (сравнение наборов строк)' }}</b>.
                <span v-if="data.data.onlySourceColumns && data.data.onlySourceColumns.length"> Только в источнике: {{ data.data.onlySourceColumns.join(', ') }}.</span>
                <span v-if="data.data.onlyTargetColumns && data.data.onlyTargetColumns.length"> Только в приёмнике: {{ data.data.onlyTargetColumns.join(', ') }}.</span>
                <span v-if="data.data.note"> {{ data.data.note }}</span>
              </div>
              <DxDataGrid v-if="data.data.diffs && data.data.diffs.length" :data-source="data.data.diffs" :show-borders="true" :word-wrap-enabled="true" :column-auto-width="true">
                <DxPaging :page-size="20" />
                <DxColumn data-field="type" caption="Тип" :width="160" :calculate-display-value="r => DT[r.type]" />
                <DxColumn caption="Ключ" css-class="mono" :calculate-cell-value="r => r.key ? Object.entries(r.key).map(([k, v]) => `${k}=${v}`).join(', ') : ''" />
                <DxColumn caption="Подробности" cell-template="det" />
                <template #det="{ data: d }">
                  <div v-if="d.data.columns" class="mono">
                    <div v-for="c in d.data.columns" :key="c.name"><b>{{ c.name }}</b>: <span class="ok">{{ show(c.source) }}</span> → <span class="error">{{ show(c.target) }}</span></div>
                  </div>
                  <div v-else class="mono">{{ rowText(d.data.row) }}</div>
                </template>
              </DxDataGrid>
              <div v-else class="hint">Отличий нет.</div>
            </div>
          </template>
        </DxDataGrid>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { DxButton } from 'devextreme-vue/button';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { DxSelectBox } from 'devextreme-vue/select-box';
import { DxNumberBox } from 'devextreme-vue/number-box';
import { DxTagBox } from 'devextreme-vue/tag-box';
import { DxDataGrid, DxColumn, DxSelection, DxEditing, DxSearchPanel, DxScrolling, DxFilterRow, DxMasterDetail, DxPaging } from 'devextreme-vue/data-grid';
import DbPicker from '../components/DbPicker.vue';
import JobPanel from '../components/JobPanel.vue';
import { api, safe, toast, STATUS, fmtMs, fmtNum, fmtSize } from '../api';
import { relatedKeys } from '../related';
import { confirm } from 'devextreme/ui/dialog';
import { lastPick, rememberPick, connType } from '../store';

const route = useRoute();
const lp = lastPick();
const src = ref(lp.src || { connId: null, schema: '' });
const tgt = ref(lp.tgt || { connId: null, schema: '' });
const tables = ref([]);
const selected = ref([]);
const opts = reactive({ absTolerance: 0, relTolerance: 0, emptyAsNull: null, maxDiffs: 200, parallel: 2, floatPrecision: 15, excludeColumns: [], trimTrailingSpaces: false, compareLobs: true, forceMapMode: false });
const jobId = ref(null);
const result = ref(null);
const relDir = ref('deps');
const lastParams = ref(null);
const syncOpt = reactive({ insert: true, update: true, delete: false, apply: false });
const syncJobId = ref(null);
const syncResult = ref(null);
const DT = { missing_in_target: 'Нет в приёмнике', extra_in_target: 'Лишняя в приёмнике', different: 'Отличается' };
const stLookup = [{ v: 'equal', t: 'Совпадает' }, { v: 'different', t: 'Отличается' }, { v: 'error', t: 'Ошибка' }, { v: 'skipped', t: 'Пропущено' }];
const ready = computed(() => src.value.connId && src.value.schema && tgt.value.connId && tgt.value.schema);
const show = v => (v === null ? 'NULL' : v);
const rowText = r => Object.entries(r || {}).map(([k, v]) => `${k}=${show(v)}`).join(', ');

async function loadTables() {
  const [a, b] = await Promise.all([
    safe(() => api.get(`/connections/${src.value.connId}/tables?schema=${encodeURIComponent(src.value.schema)}`)),
    safe(() => api.get(`/connections/${tgt.value.connId}/tables?schema=${encodeURIComponent(tgt.value.schema)}`)),
  ]);
  if (!a || !b) return;
  const mb = new Map(b.map(t => [t.name.toLowerCase(), t]));
  tables.value = a.filter(t => mb.has(t.name.toLowerCase())).map(t => {
    const tb = mb.get(t.name.toLowerCase());
    return { source: t.name, target: tb.name, rowsA: t.rows, rowsB: tb.rows, keyColumns: '', sourceWhere: '', targetWhere: '' };
  });
  selected.value = [];
  const onlyA = a.length - tables.value.length, onlyB = b.length - tables.value.length;
  if (onlyA || onlyB) toast(`Только в источнике: ${onlyA}, только в приёмнике: ${onlyB} — см. «Сравнение схем»`, 'info');
}

async function run() {
  rememberPick({ src: src.value, tgt: tgt.value });
  result.value = null;
  const pick = selected.value.length ? tables.value.filter(t => selected.value.includes(t.source)) : tables.value;
  const tableSpecs = pick.map(t => ({
    source: t.source, target: t.target,
    keyColumns: t.keyColumns ? t.keyColumns.split(',').map(s => s.trim()).filter(Boolean) : undefined,
    sourceWhere: t.sourceWhere || undefined, targetWhere: t.targetWhere || undefined,
  }));
  const params = {
    sourceId: src.value.connId, sourceSchema: src.value.schema, targetId: tgt.value.connId, targetSchema: tgt.value.schema,
    tables: tableSpecs, ...opts, emptyAsNull: opts.emptyAsNull ?? undefined,
  };
  syncJobId.value = null; syncResult.value = null;
  const j = await safe(() => api.post('/jobs/data-compare', params));
  if (j) { jobId.value = j.id; lastParams.value = params; }
}

async function addRelated() {
  const r = await safe(() => api.get(`/connections/${src.value.connId}/objects?schema=${encodeURIComponent(src.value.schema)}`));
  if (!r) return;
  const names = new Map(tables.value.map(t => [t.source, t.source]));
  const deps = r.deps.filter(d => d.from.startsWith('table:') && d.to.startsWith('table:'));
  const res = relatedKeys(deps, selected.value.map(n => `table:${n}`), { direction: relDir.value, recursive: true, onlyTypes: ['table'] })
    .map(k => k.slice(6)).filter(n => names.has(n));
  const added = res.length - selected.value.length;
  selected.value = res;
  toast(added ? `Добавлено связанных таблиц: ${added}` : 'Новых связанных таблиц нет', added ? 'success' : 'info');
}

async function runSync() {
  if (!lastParams.value) return;
  if (syncOpt.apply && !(await confirm(`Изменить данные приёмника?${syncOpt.delete ? '<br><b>Включено удаление лишних строк.</b>' : ''}`
    + (connType(tgt.value.connId) === 'postgres' ? '<br>Всё выполнится в одной транзакции и откатится при ошибке.' : '<br>Oracle: фиксация пачками по 1000 операторов.'), 'Синхронизация данных'))) return;
  const diffTables = result.value.tables.filter(t => t.status === 'different').map(t => t.table);
  const tablesSpec = (lastParams.value.tables && lastParams.value.tables.length ? lastParams.value.tables : diffTables.map(t => ({ source: t })))
    .filter(t => diffTables.includes(t.source));
  syncResult.value = null;
  const j = await safe(() => api.post('/jobs/data-sync', { ...lastParams.value, tables: tablesSpec, ...syncOpt }));
  if (j) syncJobId.value = j.id;
}
function onUpdate(j) { if (j.result && j.status === 'running') result.value = j.result.tables ? { summary: j.result.summary, tables: j.result.tables } : null; }
function onDone(j) { if (j.result) result.value = j.result; }

onMounted(async () => {
  const st = await safe(() => api.get('/settings'));
  if (st) { opts.absTolerance = st.absTolerance || 0; opts.relTolerance = st.relTolerance || 0; }
});

watch(() => route.query.job, async id => {
  if (!id) return;
  const j = await safe(() => api.get(`/jobs/${id}?full=1`));
  if (j && j.type === 'data-compare') {
    jobId.value = id;
    lastParams.value = j.params;
    src.value = { connId: j.params.sourceId, schema: j.params.sourceSchema };
    tgt.value = { connId: j.params.targetId, schema: j.params.targetSchema };
  }
}, { immediate: true });
</script>
