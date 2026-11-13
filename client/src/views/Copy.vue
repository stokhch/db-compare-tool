<template>
  <div>
    <h2 class="page">Копирование баз данных</h2>
    <DxTabs :items="tabs" :selected-index="tab" width="auto" :scroll-by-content="true" @item-click="e => (tab = e.itemIndex)" style="margin-bottom:12px" />

    <!-- ===== Перелив ===== -->
    <div v-show="tab === 0" class="panel">
      <p class="hint" style="margin-top:0">Любое направление: Oracle → PostgreSQL, PostgreSQL → Oracle, Oracle → Oracle, PostgreSQL → PostgreSQL.
        Данные читаются потоком и пишутся пачками (в PostgreSQL — через COPY, в Oracle — пакетными INSERT). Доступ к файловой системе серверов не нужен.
        Таблицы загружаются в порядке внешних ключей. Код (процедуры, пакеты) не переносится — для него используйте ora2pg.</p>
      <div class="row">
        <DbPicker v-model="tr.src" label="Источник" />
        <div class="arrow">→</div>
        <DbPicker v-model="tr.tgt" label="Приёмник" />
      </div>
      <div class="toolbar">
        <DxButton text="Загрузить таблицы источника" icon="refresh" styling-mode="outlined" :disabled="!tr.src.connId || !tr.src.schema" @click="loadTrTables" />
        <span class="hint" v-if="trTables.length">Таблиц: {{ trTables.length }}, выбрано: {{ trSel.length || 'все' }}</span>
      </div>
      <DxDataGrid v-if="trTables.length" :data-source="trTables" key-expr="name" :height="260" :show-borders="true"
        :selected-row-keys="trSel" @selection-changed="e => (trSel = e.selectedRowKeys)">
        <DxSelection mode="multiple" show-check-boxes-mode="always" />
        <DxSearchPanel :visible="true" /><DxScrolling mode="virtual" />
        <DxColumn data-field="name" caption="Таблица" /><DxColumn data-field="rows" caption="≈ строк" :width="120" />
      </DxDataGrid>
      <div class="row" style="margin-top:10px">
        <div class="field" style="min-width:300px"><label>Перед загрузкой</label>
          <DxRadioGroup v-model:value="tr.mode" layout="horizontal" value-expr="v" display-expr="t"
            :items="[{ v: 'append', t: 'добавить' }, { v: 'truncate', t: 'очистить (TRUNCATE)' }, { v: 'delete', t: 'очистить (DELETE)' }]" />
        </div>
        <div class="field" style="width:160px"><label>Строк в пачке (Oracle)</label><DxNumberBox v-model:value="tr.batchSize" :min="100" :max="10000" :step="500" :show-spin-buttons="true" /></div>
      </div>
      <div class="toolbar">
        <DxCheckBox v-model:value="tr.createTables" text="Создавать отсутствующие таблицы (с маппингом типов)" />
        <DxCheckBox v-model:value="tr.disableFk" text="Отключать FK на время загрузки" />
        <DxCheckBox v-model:value="tr.syncSequences" text="Выровнять последовательности" />
        <DxCheckBox v-model:value="tr.stopOnError" text="Остановиться при первой ошибке" />
      </div>
      <div class="toolbar">
        <DxButton text="Начать перелив" icon="arrowright" type="default" :disabled="!tr.src.connId || !tr.tgt.connId || !tr.src.schema || !tr.tgt.schema" @click="runTransfer" />
        <DxButton text="Перейти к сравнению" styling-mode="text" icon="search" @click="toCompare(tr.src, tr.tgt)" />
      </div>
    </div>

    <!-- ===== pg_dump ===== -->
    <div v-show="tab === 1" class="panel">
      <p class="hint" style="margin-top:0">PostgreSQL → PostgreSQL штатными утилитами <span class="mono">pg_dump</span> / <span class="mono">pg_restore</span> (custom-формат, параллельное восстановление).
        Утилиты берутся из папки, указанной в Настройках (на Windows ищутся автоматически в C:\Program Files\PostgreSQL\*\bin). Версия pg_dump должна быть не ниже версии сервера-источника.</p>
      <div class="field"><label>Режим</label>
        <DxRadioGroup v-model:value="pd.mode" layout="horizontal" value-expr="v" display-expr="t"
          :items="[{ v: 'dump_restore', t: 'дамп + восстановление' }, { v: 'dump_only', t: 'только дамп в файл' }, { v: 'restore_only', t: 'восстановить из файла' }]" />
      </div>
      <div class="row">
        <div v-if="pd.mode !== 'restore_only'" class="col">
          <div class="field"><label>Источник (PostgreSQL)</label><ConnSelect v-model="pd.sourceId" only="postgres" @update:model-value="loadPdSchemas" /></div>
          <div class="field"><label>Схемы (пусто — вся база)</label><DxTagBox v-model:value="pd.schemas" :items="pdSchemas" :accept-custom-value="true" /></div>
          <div class="field"><label>Только таблицы (схема.таблица, можно шаблоны) — необязательно</label>
            <DxTagBox v-model:value="pd.tables" :items="[]" :accept-custom-value="true" @custom-item-creating="e => (e.customItem = e.text)" /></div>
          <div class="field"><label>Содержимое</label>
            <DxRadioGroup v-model:value="pd.content" layout="horizontal" value-expr="v" display-expr="t" :items="[{ v: 'all', t: 'всё' }, { v: 'schema', t: 'только структура' }, { v: 'data', t: 'только данные' }]" />
          </div>
        </div>
        <div v-if="pd.mode === 'restore_only'" class="col">
          <div class="field"><label>Файл дампа</label><DxSelectBox v-model:value="pd.dumpFile" :items="dumps" display-expr="label" value-expr="name" /></div>
        </div>
        <div v-if="pd.mode !== 'dump_only'" class="col">
          <div class="field"><label>Приёмник (PostgreSQL)</label><ConnSelect v-model="pd.targetId" only="postgres" /></div>
          <div class="field" style="width:160px"><label>Потоков pg_restore</label><DxNumberBox v-model:value="pd.jobs" :min="1" :max="16" :show-spin-buttons="true" /></div>
          <div class="toolbar" style="flex-direction:column;align-items:flex-start">
            <DxCheckBox v-model:value="pd.createDatabase" text="Создать базу, если её нет" />
            <DxCheckBox v-model:value="pd.clean" text="Удалить существующие объекты перед восстановлением (--clean)" />
            <DxCheckBox v-if="pd.mode === 'dump_restore'" v-model:value="pd.deleteDumpAfter" text="Удалить файл дампа после восстановления" />
          </div>
        </div>
      </div>
      <div class="toolbar">
        <DxCheckBox v-model:value="pd.noOwner" text="Без владельцев (--no-owner)" />
        <DxCheckBox v-model:value="pd.noPrivileges" text="Без прав (--no-privileges)" />
      </div>
      <div class="toolbar"><DxButton text="Запустить" icon="runner" type="default" @click="runPgDump" /></div>
      <h3 style="margin-top:16px">Файлы дампов</h3>
      <DxDataGrid :data-source="dumps" :show-borders="true" no-data-text="Дампов нет">
        <DxColumn data-field="name" caption="Файл" />
        <DxColumn data-field="size" caption="Размер" :calculate-display-value="r => fmtSize(r.size)" :width="110" />
        <DxColumn data-field="mtime" caption="Создан" data-type="datetime" :width="170" />
        <DxColumn caption="" cell-template="dl" :width="140" />
        <template #dl="{ data }"><a :href="`/api/dumps/${encodeURIComponent(data.data.name)}`">скачать</a> · <a href="#" @click.prevent="delDump(data.data.name)">удалить</a></template>
      </DxDataGrid>
    </div>

    <!-- ===== Data Pump ===== -->
    <div v-show="tab === 2" class="panel">
      <p class="hint" style="margin-top:0">Oracle → Oracle через Data Pump в сетевом режиме: на приёмнике создаётся DB link к источнику и запускается импорт через
        <span class="mono">DBMS_DATAPUMP</span> (аналог <span class="mono">impdp NETWORK_LINK=…</span>). Файлы и утилиты expdp/impdp на этой машине не нужны.
        Пользователю приёмника нужны права CREATE DATABASE LINK и DATAPUMP_IMP_FULL_DATABASE (для переименования схемы), пользователю источника — DATAPUMP_EXP_FULL_DATABASE, если он копирует чужую схему.
        Таблицы с LONG-колонками по сети не переносятся — для них используйте файловый вариант (кнопка «Команды»).</p>
      <div class="row">
        <DbPicker v-model="dp.src" label="Источник (Oracle)" only="oracle" />
        <div class="arrow">→</div>
        <DbPicker v-model="dp.tgt" label="Приёмник (Oracle), схема = REMAP_SCHEMA" only="oracle" />
      </div>
      <div class="row">
        <div class="field" style="width:220px"><label>Если таблица существует</label>
          <DxSelectBox v-model:value="dp.tableExistsAction" :items="['SKIP', 'APPEND', 'TRUNCATE', 'REPLACE']" /></div>
        <div class="field" style="width:220px"><label>Содержимое</label>
          <DxSelectBox v-model:value="dp.content" :items="[{ v: 'ALL', t: 'структура + данные' }, { v: 'METADATA_ONLY', t: 'только структура' }]" value-expr="v" display-expr="t" /></div>
        <div class="field" style="width:140px"><label>Parallel (EE)</label><DxNumberBox v-model:value="dp.parallel" :min="1" :max="32" :show-spin-buttons="true" /></div>
        <div class="field" style="width:200px"><label>Имя DB link</label><DxTextBox v-model:value="dp.dbLinkName" /></div>
      </div>
      <div class="field"><label>Только таблицы (пусто — вся схема)</label>
        <DxTagBox v-model:value="dp.tables" :items="[]" :accept-custom-value="true" placeholder="EMP, DEPT" @custom-item-creating="e => (e.customItem = e.text.toUpperCase())" /></div>
      <div class="toolbar">
        <DxCheckBox v-model:value="dp.createDbLink" text="Создать DB link автоматически" />
        <DxCheckBox v-model:value="dp.dropDbLinkAfter" text="Удалить DB link после импорта" />
      </div>
      <div class="toolbar">
        <DxButton text="Запустить импорт" icon="runner" type="default" :disabled="!dp.src.connId || !dp.tgt.connId || !dp.src.schema" @click="runDataPump(false)" />
        <DxButton text="Команды expdp/impdp" icon="textdocument" styling-mode="outlined" :disabled="!dp.src.connId || !dp.tgt.connId || !dp.src.schema" @click="runDataPump(true)" />
        <DxButton text="Перейти к сравнению" styling-mode="text" icon="search" @click="toCompare(dp.src, dp.tgt)" />
      </div>
      <div v-if="dpCommands">
        <h3>Сетевой импорт одной командой</h3><pre class="cmd">{{ dpCommands.network }}</pre>
        <h3>Через файлы</h3><pre class="cmd">{{ dpCommands.exportFile }}</pre><pre class="cmd">{{ dpCommands.importFile }}</pre>
        <p class="hint">{{ dpCommands.note }}</p>
      </div>
    </div>

    <!-- ===== ora2pg ===== -->
    <div v-show="tab === 3" class="panel">
      <p class="hint" style="margin-top:0">Запуск <b>ora2pg</b> с конфигурацией, собранной из сохранённых подключений. Нужен установленный ora2pg (Strawberry Perl + DBD::Oracle + DBD::Pg) — путь задаётся в Настройках.
        Подходит для конвертации кода (PL/SQL → PL/pgSQL), отчёта о сложности миграции, переноса данных и проверок TEST/TEST_DATA.
        <span v-if="tools && !tools.ora2pg.ok" class="error"> Сейчас ora2pg не найден: {{ tools.ora2pg.version }}</span>
        <span v-else-if="tools" class="ok"> Найден: {{ tools.ora2pg.version }}</span></p>
      <div class="row">
        <DbPicker v-model="op.src" label="Oracle" only="oracle" />
        <div class="arrow">→</div>
        <DbPicker v-model="op.tgt" label="PostgreSQL (для COPY/TEST)" only="postgres" />
      </div>
      <div class="row">
        <div class="field col"><label>Действие</label>
          <DxSelectBox v-model:value="op.action" :items="actions" value-expr="v" display-expr="t" :search-enabled="true" /></div>
        <div class="field" style="width:120px"><label>-P (таблиц)</label><DxNumberBox v-model:value="op.parallelTables" :min="1" :max="32" :show-spin-buttons="true" /></div>
        <div class="field" style="width:120px"><label>-J (Oracle)</label><DxNumberBox v-model:value="op.oracleCopies" :min="1" :max="32" :show-spin-buttons="true" /></div>
        <div class="field" style="width:120px"><label>-j (запись)</label><DxNumberBox v-model:value="op.jobs" :min="1" :max="32" :show-spin-buttons="true" /></div>
      </div>
      <div class="row">
        <div class="field col"><label>ALLOW — только эти объекты (через пробел/запятую)</label><DxTextBox v-model:value="op.allowTables" /></div>
        <div class="field col"><label>EXCLUDE — исключить</label><DxTextBox v-model:value="op.excludeTables" /></div>
      </div>
      <div class="toolbar">
        <DxCheckBox v-model:value="op.countRows" text="--count_rows (для TEST)" />
        <DxCheckBox v-model:value="op.truncateTable" text="TRUNCATE перед COPY" />
        <DxCheckBox v-model:value="op.useTargetSchema" text="Схема PG = выбранная (EXPORT_SCHEMA/PG_SCHEMA)" />
      </div>
      <div class="field"><label>Дополнительные директивы ora2pg.conf</label>
        <DxTextArea v-model:value="op.extraConfig" :height="80" placeholder="PG_VERSION 16&#10;PACKAGE_AS_SCHEMA 1" /></div>
      <div class="toolbar"><DxButton text="Запустить ora2pg" icon="runner" type="default" :disabled="!op.src.connId || !op.src.schema" @click="runOra2pg" /></div>
      <div v-if="opResult">
        <h3>Файлы результата</h3>
        <div v-for="f in opResult.files" :key="f.name">
          <a :href="`/api/files/ora2pg/${opResult.jobId}/${encodeURIComponent(f.name)}`">{{ f.name }}</a>
          <a v-if="/\.html?$/.test(f.name)" :href="`/api/files/ora2pg/${opResult.jobId}/${encodeURIComponent(f.name)}?view=1`" target="_blank"> (открыть)</a>
          <span class="hint"> {{ fmtSize(f.size) }}</span>
        </div>
        <template v-if="opResult.test">
          <h3 style="margin-top:12px">Результат проверки</h3>
          <div v-for="s in opResult.test" :key="s.section" style="margin-bottom:6px">
            <b :class="s.ok && !s.messages.length ? 'ok' : 'error'">{{ s.section }}</b>: {{ s.ok && !s.messages.length ? 'OK' : '' }}
            <div v-for="(m, i) in s.messages" :key="i" class="mono error">{{ m }}</div>
          </div>
        </template>
      </div>
    </div>

    <JobPanel v-if="jobId" :job-id="jobId" :report="false" :log-open="true" @done="onDone" />
    <div v-if="trResult" class="panel">
      <h3>Итог перелива: {{ trResult.summary.done }} из {{ trResult.summary.tables }} таблиц, {{ fmtNum(trResult.summary.rows) }} строк</h3>
      <DxDataGrid :data-source="trResult.tables" :show-borders="true">
        <DxColumn data-field="table" caption="Таблица" />
        <DxColumn data-field="status" caption="Статус" cell-template="st" />
        <DxColumn data-field="rows" caption="Строк" format="#,##0" data-type="number" />
        <DxColumn data-field="ms" caption="Время" :calculate-display-value="r => fmtMs(r.ms)" />
        <DxColumn data-field="error" caption="Ошибка" />
        <template #st="{ data }"><span :class="data.value === 'done' ? 'ok' : 'error'">{{ STATUS[data.value] || data.value }}</span></template>
      </DxDataGrid>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { DxTabs } from 'devextreme-vue/tabs';
import { DxButton } from 'devextreme-vue/button';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { DxSelectBox } from 'devextreme-vue/select-box';
import { DxNumberBox } from 'devextreme-vue/number-box';
import { DxTagBox } from 'devextreme-vue/tag-box';
import { DxTextBox } from 'devextreme-vue/text-box';
import { DxTextArea } from 'devextreme-vue/text-area';
import { DxRadioGroup } from 'devextreme-vue/radio-group';
import { DxDataGrid, DxColumn, DxSelection, DxSearchPanel, DxScrolling } from 'devextreme-vue/data-grid';
import { confirm } from 'devextreme/ui/dialog';
import DbPicker from '../components/DbPicker.vue';
import ConnSelect from '../components/ConnSelect.vue';
import JobPanel from '../components/JobPanel.vue';
import { api, safe, toast, STATUS, fmtMs, fmtNum, fmtSize } from '../api';
import { rememberPick } from '../store';

const router = useRouter();
const tabs = [{ text: 'Перелив таблиц (любые СУБД)' }, { text: 'PostgreSQL: pg_dump / pg_restore' }, { text: 'Oracle: Data Pump' }, { text: 'ora2pg' }];
const tab = ref(0);
const jobId = ref(null);

// --- перелив
const tr = reactive({ src: { connId: null, schema: '' }, tgt: { connId: null, schema: '' }, mode: 'append', batchSize: 1000, createTables: true, disableFk: true, syncSequences: true, stopOnError: false });
const trTables = ref([]); const trSel = ref([]); const trResult = ref(null);
async function loadTrTables() {
  const r = await safe(() => api.get(`/connections/${tr.src.connId}/tables?schema=${encodeURIComponent(tr.src.schema)}`));
  if (r) { trTables.value = r; trSel.value = []; }
}
async function runTransfer() {
  trResult.value = null;
  const j = await safe(() => api.post('/jobs/transfer', {
    sourceId: tr.src.connId, sourceSchema: tr.src.schema, targetId: tr.tgt.connId, targetSchema: tr.tgt.schema,
    tables: trSel.value, mode: tr.mode, batchSize: tr.batchSize, createTables: tr.createTables, disableFk: tr.disableFk,
    syncSequences: tr.syncSequences, stopOnError: tr.stopOnError,
  }));
  if (j) jobId.value = j.id;
}

// --- pg_dump
const pd = reactive({ mode: 'dump_restore', sourceId: null, targetId: null, schemas: [], tables: [], content: 'all', jobs: 2, clean: false, createDatabase: true, deleteDumpAfter: false, noOwner: true, noPrivileges: true, dumpFile: null });
const pdSchemas = ref([]); const dumps = ref([]);
async function loadPdSchemas(id) { pdSchemas.value = id ? (await safe(() => api.get(`/connections/${id}/schemas`))) || [] : []; }
async function loadDumps() { const r = await safe(() => api.get('/dumps')); if (r) dumps.value = r.map(d => ({ ...d, label: `${d.name} (${fmtSize(d.size)})` })); }
async function delDump(name) { if (await confirm(`Удалить ${name}?`, 'Подтверждение')) { await safe(() => api.del(`/dumps/${encodeURIComponent(name)}`)); loadDumps(); } }
async function runPgDump() {
  if (pd.mode !== 'restore_only' && !pd.sourceId) return toast('Выберите источник', 'warning');
  if (pd.mode !== 'dump_only' && !pd.targetId) return toast('Выберите приёмник', 'warning');
  if (pd.mode === 'restore_only' && !pd.dumpFile) return toast('Выберите файл дампа', 'warning');
  const j = await safe(() => api.post('/jobs/pgdump', { ...pd }));
  if (j) jobId.value = j.id;
}

// --- Data Pump
const dp = reactive({ src: { connId: null, schema: '' }, tgt: { connId: null, schema: '' }, tableExistsAction: 'SKIP', content: 'ALL', parallel: 1, dbLinkName: 'DBCMP_LINK', tables: [], createDbLink: true, dropDbLinkAfter: true });
const dpCommands = ref(null);
async function runDataPump(commandsOnly) {
  dpCommands.value = null;
  const j = await safe(() => api.post('/jobs/datapump', {
    sourceId: dp.src.connId, sourceSchema: dp.src.schema, targetId: dp.tgt.connId, targetSchema: dp.tgt.schema || dp.src.schema,
    tableExistsAction: dp.tableExistsAction, content: dp.content, parallel: dp.parallel, dbLinkName: dp.dbLinkName,
    tables: dp.tables, createDbLink: dp.createDbLink, dropDbLinkAfter: dp.dropDbLinkAfter, commandsOnly,
  }));
  if (j) jobId.value = j.id;
}

// --- ora2pg
const op = reactive({ src: { connId: null, schema: '' }, tgt: { connId: null, schema: '' }, action: 'SHOW_REPORT', parallelTables: 1, oracleCopies: 1, jobs: 1, allowTables: '', excludeTables: '', countRows: true, truncateTable: false, useTargetSchema: true, extraConfig: '' });
const actions = ref([]); const tools = ref(null); const opResult = ref(null);
async function runOra2pg() {
  opResult.value = null;
  const j = await safe(() => api.post('/jobs/ora2pg', {
    sourceId: op.src.connId, sourceSchema: op.src.schema, targetId: op.tgt.connId || undefined,
    targetSchema: op.useTargetSchema && op.tgt.schema ? op.tgt.schema : undefined,
    action: op.action, parallelTables: op.parallelTables, oracleCopies: op.oracleCopies, jobs: op.jobs,
    allowTables: op.allowTables, excludeTables: op.excludeTables, countRows: op.countRows, truncateTable: op.truncateTable, extraConfig: op.extraConfig,
  }));
  if (j) jobId.value = j.id;
}

function onDone(j) {
  if (!j.result) return;
  if (j.type === 'transfer') trResult.value = j.result;
  if (j.type === 'pgdump') { loadDumps(); toast('pg_dump/pg_restore завершены'); }
  if (j.type === 'datapump' && j.result.commands) dpCommands.value = j.result.commands;
  if (j.type === 'ora2pg') opResult.value = { ...j.result, jobId: j.id };
}
function toCompare(src, tgt) { rememberPick({ src, tgt }); router.push('/schema'); }

onMounted(async () => {
  loadDumps();
  const t = await safe(() => api.get('/tools'));
  if (t) { tools.value = t; actions.value = Object.entries(t.ora2pgActions).map(([v, d]) => ({ v, t: `${v} — ${d}` })); }
});
</script>
