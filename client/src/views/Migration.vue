<template>
  <div>
    <h2 class="page">Миграция</h2>
    <DxTabs :items="tabs" :selected-index="tab" width="auto" @item-click="e => (tab = e.itemIndex)" style="margin-bottom:12px" />

    <div class="panel">
      <div class="row">
        <DbPicker v-model="src" label="Источник" />
        <div class="arrow">→</div>
        <DbPicker v-model="tgt" :label="tab === 2 ? 'Приёмник (для выполнения скрипта)' : 'Приёмник'" />
      </div>
    </div>

    <!-- ===== Конвейер ===== -->
    <div v-show="tab === 0" class="panel">
      <p class="hint" style="margin-top:0">Полный перенос одной кнопкой — для репетиций перед переключением:
        структура (таблицы без ключей) → данные параллельно → первичные ключи, индексы, внешние ключи → последовательности → статистика → проверка.
        Время каждого шага фиксируется; сумма шагов после структуры — оценка окна простоя. Если загрузка части таблиц упала —
        исправьте причину и запустите «продолжить»: уже загруженные таблицы будут пропущены.
        Код (процедуры, пакеты, представления) переносите заранее через ora2pg / plsql2pg.</p>
      <div class="field"><label>Таблицы</label>
        <DxRadioGroup v-model:value="pl.scope" layout="horizontal" value-expr="v" display-expr="t" :items="[{ v: 'all', t: 'вся схема' }, { v: 'selected', t: 'выбранные' }]" />
      </div>
      <div v-if="pl.scope === 'selected'" class="panel" style="background:#fafbfc">
        <ObjectPicker v-model="pl.objects" :conn-id="src.connId" :schema="src.schema" :only-types="['table']" :height="240" />
      </div>
      <div class="row">
        <div class="field" style="min-width:330px"><label>Структура</label>
          <DxRadioGroup v-model:value="pl.structure" layout="horizontal" value-expr="v" display-expr="t"
            :items="[{ v: 'create', t: 'создать недостающие таблицы' }, { v: 'existing', t: 'уже создана (ora2pg/plsql2pg)' }]" />
        </div>
        <div class="field" style="min-width:300px"><label>Перед загрузкой</label>
          <DxRadioGroup v-model:value="pl.mode" layout="horizontal" value-expr="v" display-expr="t"
            :items="[{ v: 'truncate', t: 'TRUNCATE' }, { v: 'delete', t: 'DELETE' }, { v: 'append', t: 'добавить' }]" />
        </div>
        <div class="field" style="width:130px"><label>Потоков загрузки</label><DxNumberBox v-model:value="pl.parallel" :min="1" :max="16" :show-spin-buttons="true" /></div>
        <div class="field" style="width:230px"><label>Проверка в конце</label>
          <DxSelectBox v-model:value="pl.verify" value-expr="v" display-expr="t"
            :items="[{ v: 'counts', t: 'структура + число строк' }, { v: 'aggregates', t: 'агрегаты (быстро)' }, { v: 'data', t: 'построчно (долго)' }, { v: 'none', t: 'без проверки' }]" />
        </div>
      </div>
      <div class="toolbar">
        <DxCheckBox v-model:value="pl.keys" text="Ключи, индексы, FK после загрузки" />
        <DxCheckBox v-model:value="pl.sequences" text="Последовательности" />
        <DxCheckBox v-model:value="pl.analyze" text="Сбор статистики" />
      </div>
      <div class="toolbar">
        <DxButton text="Запустить миграцию" icon="runner" type="default" :disabled="!ready" @click="runPipeline()" />
        <DxSelectBox v-if="failedRuns.length" v-model:value="resumeId" :items="failedRuns" value-expr="id" display-expr="label" placeholder="продолжить прерванный запуск…" :width="360" :show-clear-button="true" />
        <DxButton v-if="resumeId" text="Продолжить" icon="redo" styling-mode="outlined" @click="runPipeline(resumeId)" />
      </div>
      <template v-if="plResult">
        <div class="cards">
          <div class="card"><div class="v">{{ fmtMs(plResult.summary.totalMs) }}</div><div class="l">всего</div></div>
          <div class="card"><div class="v warning">{{ fmtMs(plResult.summary.downtimeMs) }}</div><div class="l">оценка простоя (данные → статистика)</div></div>
          <div class="card"><div class="v" :class="plResult.summary.error ? 'error' : 'ok'">{{ plResult.summary.done + plResult.summary.warning }} / {{ plResult.summary.steps }}</div><div class="l">шагов выполнено</div></div>
        </div>
        <DxDataGrid :data-source="plResult.steps" :show-borders="true" :word-wrap-enabled="true">
          <DxColumn data-field="name" caption="Шаг" />
          <DxColumn data-field="status" caption="Статус" cell-template="st" :width="140" />
          <DxColumn data-field="ms" caption="Время" :calculate-display-value="r => fmtMs(r.ms)" :width="110" />
          <DxColumn caption="Итог" :calculate-cell-value="stepText" />
          <template #st="{ data }"><span :class="{ done: 'ok', warning: 'warning', error: 'error', running: 'warning' }[data.value]">{{ { done: 'Готово', warning: 'С замечаниями', error: 'Ошибка', running: 'Выполняется', cancelled: 'Отменено' }[data.value] }}</span></template>
        </DxDataGrid>
        <div v-if="dataTables.length" style="margin-top:10px">
          <h3>Загрузка по таблицам</h3>
          <DxDataGrid :data-source="dataTables" :show-borders="true" :height="Math.min(400, 60 + dataTables.length * 34)">
            <DxScrolling mode="virtual" />
            <DxColumn data-field="table" caption="Таблица" />
            <DxColumn data-field="status" caption="Статус" :calculate-display-value="r => ({ done: 'загружена', error: 'ошибка', skipped: 'пропущена (уже загружена)' }[r.status] || r.status)" />
            <DxColumn data-field="rows" caption="Строк" data-type="number" format="#,##0" />
            <DxColumn data-field="ms" caption="Время" :calculate-display-value="r => fmtMs(r.ms)" />
            <DxColumn data-field="error" caption="Ошибка" />
          </DxDataGrid>
        </div>
      </template>
    </div>

    <!-- ===== Догрузка изменений ===== -->
    <div v-show="tab === 1" class="panel">
      <p class="hint" style="margin-top:0">Основной перенос делается заранее, в день переключения переносятся только изменения:
        <b>по колонке даты изменения</b> (строки, изменённые начиная с момента основного переноса, — вставка или обновление) или
        <b>по росту ключа</b> (для таблиц, куда только добавляют строки; числовой ключ). «Удалённые строки» сравнивает только ключи всей таблицы и удаляет лишние.</p>
      <div class="toolbar">
        <DxButton text="Загрузить таблицы" icon="refresh" styling-mode="outlined" :disabled="!src.connId || !src.schema" @click="loadDeltaTables" />
        <div class="field" style="width:240px;margin:0"><label>Изменения начиная с (ГГГГ-ММ-ДД ЧЧ:ММ:СС)</label><DxTextBox v-model:value="dl.since" /></div>
        <DxButton v-if="lastPipelineStart" :text="`= начало миграции ${lastPipelineStart}`" styling-mode="text" @click="dl.since = lastPipelineStart" style="margin-top:18px" />
      </div>
      <DxDataGrid v-if="dl.tables.length" :data-source="dl.tables" key-expr="source" :show-borders="true" :height="300"
        :selected-row-keys="dl.selected" @selection-changed="e => (dl.selected = e.selectedRowKeys)">
        <DxSelection mode="multiple" show-check-boxes-mode="always" />
        <DxEditing mode="cell" :allow-updating="true" />
        <DxSearchPanel :visible="true" /><DxScrolling mode="virtual" />
        <DxColumn data-field="source" caption="Таблица" :allow-editing="false" />
        <DxColumn data-field="mode" caption="Режим" :width="200" :lookup="{ dataSource: [{ v: 'column', t: 'по дате изменения' }, { v: 'key', t: 'по росту ключа' }], valueExpr: 'v', displayExpr: 't' }" />
        <DxColumn data-field="column" caption="Колонка даты изменения" />
      </DxDataGrid>
      <div class="toolbar" style="margin-top:10px">
        <DxCheckBox v-model:value="dl.checkDeletes" text="Найти и удалить строки, удалённые в источнике" />
        <DxCheckBox v-model:value="dl.apply" text="Сразу выполнить на приёмнике" />
        <DxButton :text="dl.apply ? 'Догрузить' : 'Построить скрипты'" icon="runner" :type="dl.apply ? 'danger' : 'default'" :disabled="!dl.selected.length || !ready" @click="runDelta" />
      </div>
      <div v-if="dlResult" class="toolbar">
        <span>Вставка/обновление: <b>{{ fmtNum(dlResult.summary.insert) }}</b>, изменено колонок в строках: <b>{{ fmtNum(dlResult.summary.update) }}</b>
          <template v-if="dlResult.summary.delete != null">, удалений: <b>{{ fmtNum(dlResult.summary.delete) }}</b></template></span>
        <span v-if="dlResult.summary.applied" class="ok">выполнено на приёмнике</span>
        <a v-if="dlResult.changed.script" :href="`/api/files/sync/${dlResult.changed.script.jobId}/${encodeURIComponent(dlResult.changed.script.name)}`">скрипт изменений</a>
        <a v-if="dlResult.deleted && dlResult.deleted.script" :href="`/api/files/sync/${dlResult.deleted.script.jobId}/${encodeURIComponent(dlResult.deleted.script.name)}`">скрипт удалений</a>
      </div>
    </div>

    <!-- ===== Права и окружение ===== -->
    <div v-show="tab === 2" class="panel">
      <p class="hint" style="margin-top:0">Из Oracle собирается то, что обычно забывают перенести: роли и права (ALL_TAB_PRIVS → GRANT), комментарии к таблицам и колонкам,
        синонимы (→ представления или search_path), DB links (→ шаблоны oracle_fdw/postgres_fdw), задания DBMS_SCHEDULER (→ pg_cron с переводом расписания в cron).
        Задания и удаления по умолчанию не отмечены — проверьте их вручную.</p>
      <div class="row">
        <div class="field" style="width:260px"><label>Схема в PostgreSQL</label><DxTextBox v-model:value="ex.targetSchema" :placeholder="(src.schema || '').toLowerCase()" /></div>
        <div class="field" style="min-width:360px"><label>Подпрограммы пакетов в PostgreSQL</label>
          <DxRadioGroup v-model:value="ex.naming" layout="horizontal" value-expr="v" display-expr="t" :items="[{ v: 'underscore', t: 'пакет_процедура (plsql2pg)' }, { v: 'schema', t: 'пакет.процедура (ora2pg)' }]" />
        </div>
      </div>
      <div class="toolbar"><DxButton text="Собрать скрипт" icon="codeblock" type="default" :disabled="!src.connId || connType(src.connId) !== 'oracle'" @click="runExtras" />
        <span v-if="src.connId && connType(src.connId) !== 'oracle'" class="warning">Источник должен быть Oracle</span></div>
      <div v-if="exResult" class="cards">
        <div v-for="(v, k) in exResult.summary" :key="k" class="card"><div class="v">{{ v }}</div><div class="l">{{ k }}</div></div>
      </div>
      <SchemaSyncPanel v-if="exResult" :sync="exResult.sync" :target-id="tgt.connId" />
    </div>

    <JobPanel v-if="jobId" :job-id="jobId" :report="false" @done="onDone" @update="onUpdate" />
  </div>
</template>

<script setup>
import { computed, onActivated, onMounted, reactive, ref } from 'vue';
import { DxTabs } from 'devextreme-vue/tabs';
import { DxButton } from 'devextreme-vue/button';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { DxSelectBox } from 'devextreme-vue/select-box';
import { DxNumberBox } from 'devextreme-vue/number-box';
import { DxTextBox } from 'devextreme-vue/text-box';
import { DxRadioGroup } from 'devextreme-vue/radio-group';
import { DxDataGrid, DxColumn, DxSelection, DxEditing, DxSearchPanel, DxScrolling } from 'devextreme-vue/data-grid';
import { confirm } from 'devextreme/ui/dialog';
import DbPicker from '../components/DbPicker.vue';
import ObjectPicker from '../components/ObjectPicker.vue';
import JobPanel from '../components/JobPanel.vue';
import SchemaSyncPanel from '../components/SchemaSyncPanel.vue';
import { api, safe, toast, fmtMs, fmtNum } from '../api';
import { lastPick, rememberPick, connType } from '../store';
import { useJobFromRoute } from '../jobroute';

const tabs = [{ text: 'Конвейер миграции' }, { text: 'Догрузка изменений' }, { text: 'Права и окружение' }];
const tab = ref(0);
const lp = lastPick();
const src = ref(lp.src || { connId: null, schema: '' });
const tgt = ref(lp.tgt || { connId: null, schema: '' });
const ready = computed(() => src.value.connId && src.value.schema && tgt.value.connId && tgt.value.schema);
const jobId = ref(null);

// --- конвейер
const pl = reactive({ scope: 'all', objects: [], structure: 'create', mode: 'truncate', parallel: 4, verify: 'counts', keys: true, sequences: true, analyze: true });
const plResult = ref(null);
const failedRuns = ref([]);
const resumeId = ref(null);
const lastPipelineStart = ref('');
const dataTables = computed(() => {
  const s = plResult.value && plResult.value.steps.find(x => x.id === 'data');
  return (s && s.details && s.details.tables) || [];
});
function stepText(s) {
  if (s.error) return s.error;
  const d = s.details;
  if (!d) return s.warning || '';
  if (s.id === 'data') return `таблиц ${d.summary.done} из ${d.summary.tables}, строк ${fmtNum(d.summary.rows)}${d.summary.skipped ? `, пропущено ${d.summary.skipped}` : ''}`;
  if (s.id === 'keys') return `создано ${d.summary.done} из ${d.summary.total}${s.warning ? ` — ${s.warning}` : ''}`;
  if (s.id === 'structure' || s.id === 'sequences') return `операторов ${d.done} из ${d.total}`;
  if (s.id === 'analyze') return d.tables != null ? `таблиц ${d.tables}` : `схема ${d.schema}`;
  if (s.id === 'verify') return s.warning || 'расхождений нет';
  return '';
}
async function loadRuns() {
  const all = (await safe(() => api.get('/jobs'))) || [];
  const p = all.filter(j => j.type === 'pipeline');
  failedRuns.value = p.filter(j => j.summary && j.summary.error).map(j => ({ id: j.id, label: `${new Date(j.startedAt).toLocaleString('ru-RU')} — ${j.title}` }));
  const okRun = p.find(j => j.status === 'done');
  if (okRun) {
    const d = new Date(okRun.startedAt), z = n => String(n).padStart(2, '0');
    lastPipelineStart.value = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:00`;
  }
}
async function runPipeline(resume) {
  rememberPick({ src: src.value, tgt: tgt.value });
  if (pl.mode !== 'append' && !(await confirm(`Таблицы приёмника (${tgt.value.schema}) будут очищены (${pl.mode.toUpperCase()}) и загружены заново. Продолжить?`, 'Миграция'))) return;
  plResult.value = null;
  const j = await safe(() => api.post('/jobs/pipeline', {
    sourceId: src.value.connId, sourceSchema: src.value.schema, targetId: tgt.value.connId, targetSchema: tgt.value.schema,
    tables: pl.scope === 'selected' ? pl.objects.map(o => o.name) : undefined, structure: pl.structure, mode: pl.mode,
    parallel: pl.parallel, verify: pl.verify, keys: pl.keys, sequences: pl.sequences, analyze: pl.analyze, resumeJobId: resume || undefined,
  }));
  if (j) jobId.value = j.id;
}

// --- догрузка
const dl = reactive({ since: '', tables: [], selected: [], checkDeletes: false, apply: false });
const dlResult = ref(null);
async function loadDeltaTables() {
  const r = await safe(() => api.get(`/connections/${src.value.connId}/tables?schema=${encodeURIComponent(src.value.schema)}`));
  if (r) { dl.tables = r.map(t => ({ source: t.name, mode: 'column', column: '' })); dl.selected = []; }
}
async function runDelta() {
  const specs = dl.tables.filter(t => dl.selected.includes(t.source));
  const bad = specs.filter(t => t.mode === 'column' && !t.column);
  if (bad.length) return toast(`Укажите колонку даты изменения: ${bad.map(t => t.source).join(', ')}`, 'warning');
  if (specs.some(t => t.mode === 'column') && !dl.since) return toast('Укажите, с какого момента искать изменения', 'warning');
  if (dl.apply && !(await confirm('Изменить данные приёмника?', 'Догрузка изменений'))) return;
  dlResult.value = null;
  const j = await safe(() => api.post('/jobs/delta', {
    sourceId: src.value.connId, sourceSchema: src.value.schema, targetId: tgt.value.connId, targetSchema: tgt.value.schema,
    tables: specs, since: dl.since, checkDeletes: dl.checkDeletes, apply: dl.apply,
  }));
  if (j) jobId.value = j.id;
}

// --- окружение
const ex = reactive({ targetSchema: '', naming: 'underscore' });
const exResult = ref(null);
async function runExtras() {
  exResult.value = null;
  const j = await safe(() => api.post('/jobs/extras', { sourceId: src.value.connId, sourceSchema: src.value.schema, targetSchema: ex.targetSchema || (tgt.value.schema || src.value.schema).toLowerCase(), packageNaming: ex.naming }));
  if (j) jobId.value = j.id;
}

function onUpdate(j) { if (j.type === 'pipeline' && j.result) plResult.value = j.result; }
function onDone(j) {
  if (!j.result) return;
  if (j.type === 'pipeline') { plResult.value = j.result; loadRuns(); }
  if (j.type === 'delta') dlResult.value = j.result;
  if (j.type === 'extras') exResult.value = j.result;
}
useJobFromRoute(['pipeline', 'delta', 'extras'], j => {
  tab.value = { pipeline: 0, delta: 1, extras: 2 }[j.type];
  jobId.value = j.id;
});
onMounted(loadRuns);
onActivated(loadRuns);
</script>
