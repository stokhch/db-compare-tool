<template>
  <div>
    <h2 class="page">Документация базы</h2>
    <div class="panel">
      <p class="hint" style="margin-top:0">Справочник таблиц и колонок с типами, ключами, связями, индексами, проверками и комментариями из базы, список представлений
        и подпрограмм, ER-диаграмма связей. HTML можно открыть в браузере и распечатать в PDF; Markdown — положить в репозиторий или вики.
        В шапке видно, сколько таблиц и колонок не имеют описания — хороший список работы для команды.</p>
      <div class="row"><DbPicker v-model="db" label="База" /></div>
      <div class="toolbar">
        <DxTextBox v-model:value="title" placeholder="Заголовок документа" :width="380" />
        <DxButton text="Сформировать" icon="doc" type="default" :disabled="!db.connId || !db.schema" @click="run" />
      </div>
    </div>
    <JobPanel v-if="jobId" :job-id="jobId" :report="false" @done="j => (res = j.result)" />
    <div v-if="res" class="panel">
      <div class="toolbar">
        <a :href="res.html" target="_blank"><DxButton text="Открыть HTML" icon="globe" type="default" /></a>
        <a :href="res.md"><DxButton text="Скачать Markdown" icon="download" styling-mode="outlined" /></a>
        <span class="hint">таблиц {{ res.summary.tables }}, представлений {{ res.summary.views }}, подпрограмм {{ res.summary.routines }}; без описания: {{ res.summary.undocumented }}</span>
      </div>
      <iframe :src="res.html" style="width:100%;height:720px;border:1px solid #e4e7ec;border-radius:6px" />
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { DxButton } from 'devextreme-vue/button';
import { DxTextBox } from 'devextreme-vue/text-box';
import DbPicker from '../components/DbPicker.vue';
import JobPanel from '../components/JobPanel.vue';
import { api, safe } from '../api';
import { lastPick } from '../store';
import { useJobFromRoute } from '../jobroute';

const lp = lastPick();
const db = ref({ connId: null, schema: '', ...lp.src });
const title = ref(''), jobId = ref(null), res = ref(null);
async function run() { res.value = null; const j = await safe(() => api.post('/jobs/db-docs', { connId: db.value.connId, schema: db.value.schema, title: title.value || undefined })); if (j) jobId.value = j.id; }
useJobFromRoute(['db-docs'], j => { jobId.value = j.id; });
</script>
