<template>
  <div>
    <h2 class="page">Резервные копии</h2>
    <div class="panel">
      <p class="hint" style="margin-top:0">PostgreSQL — pg_dump в папку приложения (data/backups); Oracle — экспорт Data Pump на сервер базы (каталог DATA_PUMP_DIR).
        После создания копия проверяется: читается ли она, а для PostgreSQL можно сделать пробное восстановление во временную базу со сверкой числа таблиц.
        Старые копии удаляются автоматически. По расписанию — кнопка «В регламент» (там же уведомление, если проверка не прошла).</p>
      <div class="row"><DbPicker v-model="db" label="База" /></div>
      <div class="toolbar">
        <div class="field" style="width:300px;margin:0"><label>Проверка</label>
          <DxSelectBox v-model:value="verify" :items="verifyItems" value-expr="v" display-expr="t" /></div>
        <div class="field" style="width:140px;margin:0"><label>Хранить копий</label><DxNumberBox v-model:value="keep" :min="1" :max="365" :show-spin-buttons="true" /></div>
        <div class="field" style="width:200px;margin:0"><label>Метка</label><DxTextBox v-model:value="label" placeholder="ежедневная" /></div>
        <DxButton text="Создать копию" icon="save" type="default" :disabled="!db.connId || (isOracle && !db.schema)" @click="run" />
        <AddToSuite type="backup" :params="params" default-title="Резервная копия" />
      </div>
      <div v-if="!isOracle" class="hint">Схема необязательна: без неё копируется вся база.</div>
    </div>
    <JobPanel v-if="jobId" :job-id="jobId" :report="false" @done="load" />
    <div class="panel">
      <div class="toolbar"><b>Копии</b><DxButton icon="refresh" styling-mode="text" @click="load" /></div>
      <DxDataGrid :data-source="list" :show-borders="true" :word-wrap-enabled="true" no-data-text="Копий пока нет">
        <DxColumn data-field="createdAt" caption="Создана" :width="160" :calculate-display-value="r => r.createdAt.replace('T', ' ').slice(0, 19)" sort-order="desc" />
        <DxColumn data-field="connName" caption="База" :width="160" />
        <DxColumn data-field="schema" caption="Схема" :width="110" />
        <DxColumn data-field="label" caption="Метка" :width="110" />
        <DxColumn caption="Размер" :width="90" :calculate-cell-value="r => (r.bytes != null ? `${(r.bytes / 1048576).toFixed(1)} МБ` : '')" />
        <DxColumn caption="Проверка" cell-template="ver" />
        <DxColumn data-field="location" caption="Где лежит" css-class="mono" />
        <DxColumn caption="" :width="200" cell-template="act" />
        <template #ver="{ data }">
          <span v-if="!data.data.verified" class="hint">не проверялась</span>
          <span v-else :class="data.data.verified.ok ? 'ok' : 'error'">{{ data.data.verified.ok ? '✓' : '✗' }} {{ data.data.verified.method }}: {{ data.data.verified.details }}</span>
        </template>
        <template #act="{ data }">
          <a v-if="data.data.type === 'postgres'" :href="`/api/backups/${data.data.id}/download`"><DxButton icon="download" styling-mode="text" hint="Скачать" /></a>
          <DxButton icon="info" styling-mode="text" hint="Как восстановить" @click="howTo(data.data)" />
          <DxButton icon="trash" styling-mode="text" hint="Удалить" @click="del(data.data)" />
        </template>
      </DxDataGrid>
      <pre v-if="restoreHint" class="cmd">{{ restoreHint }}</pre>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { DxButton } from 'devextreme-vue/button';
import { DxNumberBox } from 'devextreme-vue/number-box';
import { DxSelectBox } from 'devextreme-vue/select-box';
import { DxTextBox } from 'devextreme-vue/text-box';
import { DxDataGrid, DxColumn } from 'devextreme-vue/data-grid';
import { confirm } from 'devextreme/ui/dialog';
import DbPicker from '../components/DbPicker.vue';
import JobPanel from '../components/JobPanel.vue';
import AddToSuite from '../components/AddToSuite.vue';
import { api, safe } from '../api';
import { lastPick, connType } from '../store';
import { useJobFromRoute } from '../jobroute';

const lp = lastPick();
const db = ref({ connId: null, schema: '', ...lp.tgt });
const verify = ref('list'), keep = ref(7), label = ref('');
const jobId = ref(null), list = ref([]), restoreHint = ref('');
const isOracle = computed(() => connType(db.value.connId) === 'oracle');
const verifyItems = computed(() => (isOracle.value ? [{ v: 'list', t: 'Чтение заголовка Data Pump' }, { v: 'none', t: 'Без проверки' }]
  : [{ v: 'list', t: 'Чтение оглавления (быстро)' }, { v: 'restore', t: 'Пробное восстановление во временную базу' }, { v: 'none', t: 'Без проверки' }]));
const params = () => (db.value.connId ? { connId: db.value.connId, schema: db.value.schema || undefined, verify: verify.value, keep: keep.value, label: label.value || undefined } : null);
async function run() { const j = await safe(() => api.post('/jobs/backup', params())); if (j) jobId.value = j.id; }
async function load() { list.value = (await safe(() => api.get('/backups'))) || []; }
async function del(b) { if (await confirm(`Удалить копию ${b.name}?`, 'Резервные копии')) { await safe(() => api.delete(`/backups/${b.id}`)); load(); } }
function howTo(b) {
  restoreHint.value = b.type === 'postgres'
    ? `# Восстановление в новую базу (или «Копирование → pg_dump/pg_restore», режим «только восстановление»):\ncreatedb -h <хост> -U <пользователь> ${b.name.replace(/\.dump$/, '')}_restored\npg_restore -h <хост> -U <пользователь> -d ${b.name.replace(/\.dump$/, '')}_restored -j 4 --no-owner "${b.file}"`
    : `-- Файл на сервере базы: ${b.location}\n-- Восстановить в ту же базу под другим именем схемы:\nimpdp <пользователь> directory=${b.directory} dumpfile=${b.file} remap_schema=${b.schema}:${b.schema}_RESTORED\n-- Или в другую базу: скопируйте файл и используйте раздел «Импорт дампа».`;
}
onMounted(load);
useJobFromRoute(['backup'], j => { jobId.value = j.id; });
</script>
