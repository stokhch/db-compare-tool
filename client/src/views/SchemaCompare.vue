<template>
  <div>
    <h2 class="page">Сравнение схем</h2>
    <div class="panel">
      <div class="row">
        <DbPicker v-model="src" label="Источник" />
        <div class="arrow">⇄</div>
        <DbPicker v-model="tgt" label="Приёмник" />
      </div>
      <div class="field">
        <label>Что сравнивать</label>
        <DxRadioGroup v-model:value="scope" layout="horizontal" value-expr="v" display-expr="t"
          :items="[{ v: 'all', t: 'всю схему' }, { v: 'selected', t: 'выбранные объекты' }]" />
      </div>
      <div v-if="scope === 'selected'" class="panel" style="background:#fafbfc">
        <ObjectPicker v-model="objects" :conn-id="src.connId" :schema="src.schema" />
      </div>
      <div class="row" style="margin-top:4px">
        <div class="field">
          <label>Количество строк</label>
          <DxRadioGroup v-model:value="opts.rowCounts" layout="horizontal" value-expr="v" display-expr="t"
            :items="[{ v: 'none', t: 'не считать' }, { v: 'estimate', t: 'по статистике (быстро)' }, { v: 'exact', t: 'точно, COUNT(*)' }]" />
        </div>
      </div>
      <div class="toolbar">
        <DxCheckBox v-model:value="opts.compareIndexes" text="Индексы" />
        <DxCheckBox v-model:value="opts.compareRoutines" text="Функции, процедуры, пакеты, типы" />
        <DxCheckBox v-model:value="opts.checkColumnOrder" text="Учитывать порядок колонок" />
        <DxCheckBox v-model:value="opts.caseSensitive" text="Имена с учётом регистра" />
        <DxCheckBox v-model:value="opts.checkPgCode" text="Проверить код PostgreSQL (plpgsql_check)" />
      </div>
      <div class="toolbar">
        <DxButton text="Сравнить" icon="runner" type="default" :disabled="!ready || (scope === 'selected' && !objects.length)" @click="run" />
        <span class="hint">Oracle ⇄ PostgreSQL: имена сопоставляются без учёта регистра, типы проверяются на совместимость (NUMBER → bigint/numeric, VARCHAR2 → varchar, DATE → timestamp…). Функции пакетов ищутся как <span class="mono">пакет_функция</span> (так их называет plsql2pg) или <span class="mono">пакет.функция</span> (ora2pg с PACKAGE_AS_SCHEMA).
          Код PL/pgSQL проверяется расширением plpgsql_check в транзакции с откатом — база не меняется (аналог INVALID-объектов Oracle).</span>
      </div>
    </div>

    <JobPanel v-if="jobId" :job-id="jobId" @done="onDone" />

    <template v-if="result">
      <div class="cards">
        <div class="card"><div class="v ok">{{ result.summary.ok }}</div><div class="l">совпадает</div></div>
        <div class="card"><div class="v warning">{{ result.summary.warning }}</div><div class="l">предупреждений</div></div>
        <div class="card"><div class="v error">{{ result.summary.error }}</div><div class="l">ошибок</div></div>
        <div class="card"><div class="v">{{ result.summary.sourceTables }} / {{ result.summary.targetTables }}</div><div class="l">таблиц: источник / приёмник</div></div>
        <div v-if="result.objectsFilter" class="card"><div class="v">{{ result.objectsFilter }}</div><div class="l">выбранных объектов</div></div>
        <div class="card" style="display:flex;align-items:center;gap:8px">
          <DxButton v-if="result.sync" :text="`Скрипт синхронизации (${result.sync.statements.filter(s => !s.comment).length})`" icon="codeblock" type="default" styling-mode="outlined" @click="showSync = !showSync" />
          <DxButton text="Сравнить данные общих таблиц" icon="search" styling-mode="outlined" @click="toData" />
        </div>
      </div>

      <SchemaSyncPanel v-if="showSync && result.sync" :sync="result.sync" :target-id="tgtIdOfResult" @applied="onApplied" />

      <div class="panel" style="padding:8px">
        <DxDataGrid :data-source="result.categories" :show-borders="false" :hover-state-enabled="true" @row-click="e => (category = category === e.data.category ? null : e.data.category)">
          <DxColumn data-field="category" caption="Категория (клик — фильтр)" />
          <DxColumn data-field="source" caption="В источнике" :width="110" />
          <DxColumn data-field="target" caption="В приёмнике" :width="110" />
          <DxColumn data-field="ok" caption="Совпадает" css-class="ok" :width="110" />
          <DxColumn data-field="warning" caption="Предупреждения" css-class="warning" :width="130" />
          <DxColumn data-field="error" caption="Ошибки" css-class="error" :width="100" />
        </DxDataGrid>
      </div>

      <div class="panel" style="padding:8px">
        <div class="toolbar" style="margin:4px 4px 8px">
          <b>Детали</b>
          <span v-if="category" class="hint">категория: {{ category }} <a href="#" @click.prevent="category = null">сбросить</a></span>
          <span style="flex:1" />
          <DxCheckBox v-model:value="showOk" text="Показывать совпадения" />
        </div>
        <DxDataGrid :data-source="filtered" :show-borders="true" :column-auto-width="true" :word-wrap-enabled="true"
          :row-alternation-enabled="true" :height="600">
          <DxFilterRow :visible="true" />
          <DxSearchPanel :visible="true" placeholder="Поиск…" />
          <DxGrouping :auto-expand-all="true" />
          <DxGroupPanel :visible="true" empty-panel-text="Перетащите сюда колонку для группировки" />
          <DxScrolling mode="virtual" />
          <DxColumn data-field="category" caption="Категория" :group-index="0" />
          <DxColumn data-field="object" caption="Объект" css-class="mono" />
          <DxColumn data-field="status" caption="Статус" :width="130" cell-template="st"
            :lookup="{ dataSource: statusLookup, valueExpr: 'v', displayExpr: 't' }" />
          <DxColumn data-field="source" caption="Источник" />
          <DxColumn data-field="target" caption="Приёмник" />
          <DxColumn data-field="message" caption="Комментарий" />
          <template #st="{ data }"><span :class="data.value">{{ STATUS[data.value] }}</span></template>
        </DxDataGrid>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { DxButton } from 'devextreme-vue/button';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { DxRadioGroup } from 'devextreme-vue/radio-group';
import { DxDataGrid, DxColumn, DxFilterRow, DxSearchPanel, DxGrouping, DxGroupPanel, DxScrolling } from 'devextreme-vue/data-grid';
import DbPicker from '../components/DbPicker.vue';
import JobPanel from '../components/JobPanel.vue';
import ObjectPicker from '../components/ObjectPicker.vue';
import SchemaSyncPanel from '../components/SchemaSyncPanel.vue';
import { toast } from '../api';
import { api, safe, STATUS } from '../api';
import { lastPick, rememberPick } from '../store';

const route = useRoute(); const router = useRouter();
const lp = lastPick();
const src = ref(lp.src || { connId: null, schema: '' });
const tgt = ref(lp.tgt || { connId: null, schema: '' });
const opts = reactive({ rowCounts: 'estimate', compareIndexes: true, compareRoutines: true, checkColumnOrder: false, caseSensitive: false, checkPgCode: true });
const jobId = ref(null);
const result = ref(null);
const category = ref(null);
const showOk = ref(false);
const scope = ref('all');
const objects = ref([]);
const showSync = ref(false);
const tgtIdOfResult = ref(null);
const statusLookup = [{ v: 'ok', t: 'Совпадает' }, { v: 'warning', t: 'Предупреждение' }, { v: 'error', t: 'Ошибка' }];

const ready = computed(() => src.value.connId && src.value.schema && tgt.value.connId && tgt.value.schema);
const filtered = computed(() => (result.value ? result.value.findings.filter(f =>
  (showOk.value || f.status !== 'ok') && (!category.value || f.category === category.value)) : []));

async function run() {
  rememberPick({ src: src.value, tgt: tgt.value });
  result.value = null; category.value = null; showSync.value = false;
  tgtIdOfResult.value = tgt.value.connId;
  const j = await safe(() => api.post('/jobs/schema-compare', {
    sourceId: src.value.connId, sourceSchema: src.value.schema, targetId: tgt.value.connId, targetSchema: tgt.value.schema, ...opts,
    objects: scope.value === 'selected' ? objects.value : undefined,
  }));
  if (j) jobId.value = j.id;
}
function onDone(j) { if (j.result) result.value = j.result; }
function onApplied(j) {
  if (j.status === 'done') toast('Скрипт выполнен. Запустите сравнение ещё раз, чтобы проверить результат.');
}
function toData() {
  rememberPick({ src: src.value, tgt: tgt.value });
  router.push('/data');
}
watch(() => route.query.job, async id => {
  if (!id) return;
  const j = await safe(() => api.get(`/jobs/${id}?full=1`));
  if (j && j.type === 'schema-compare') {
    jobId.value = id;
    tgtIdOfResult.value = j.params.targetId;
    if (j.params.objects && j.params.objects.length) { scope.value = 'selected'; objects.value = j.params.objects; }
    src.value = { connId: j.params.sourceId, schema: j.params.sourceSchema };
    tgt.value = { connId: j.params.targetId, schema: j.params.targetSchema };
  }
}, { immediate: true });
</script>
