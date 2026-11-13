<template>
  <div>
    <h2 class="page">Настройки</h2>
    <div class="panel">
      <h3>Утилиты</h3>
      <div class="field"><label>Папка с pg_dump / pg_restore</label>
        <DxTextBox v-model:value="s.pgBinPath" :placeholder="s.detectedPgBin ? `авто: ${s.detectedPgBin}` : 'C:\\Program Files\\PostgreSQL\\16\\bin (пусто — искать в PATH)'" />
      </div>
      <div class="field"><label>Команда ora2pg</label>
        <DxTextBox v-model:value="s.ora2pgCommand" placeholder="ora2pg или C:\Strawberry\perl\site\bin\ora2pg.bat" />
      </div>
      <div class="field"><label>Perl (если ora2pg запускается как скрипт: perl путь\к\ora2pg)</label>
        <DxTextBox v-model:value="s.perlPath" placeholder="C:\Strawberry\perl\bin\perl.exe (необязательно)" />
      </div>
      <div class="field"><label>Oracle Instant Client (Thick-режим; нужен для Oracle 11g и старых паролей). После изменения перезапустите приложение.</label>
        <DxTextBox v-model:value="s.oracleClientLibDir" placeholder="C:\oracle\instantclient_23_5 (пусто — Thin-режим без клиента)" />
      </div>
      <h3 style="margin-top:16px">Сравнение</h3>
      <div class="row">
        <div class="field" style="width:220px"><label>Строк за одну выборку (fetch size)</label><DxNumberBox v-model:value="s.fetchSize" :min="100" :max="50000" :step="500" :show-spin-buttons="true" /></div>
        <div class="field" style="width:220px"><label>Примеров отличий на таблицу</label><DxNumberBox v-model:value="s.maxDiffsPerTable" :min="1" :max="10000" :show-spin-buttons="true" /></div>
      </div>
      <div class="toolbar">
        <DxButton text="Сохранить" icon="save" type="default" @click="save" />
        <DxButton text="Проверить утилиты" icon="video" styling-mode="outlined" @click="check" />
      </div>
      <div v-if="tools">
        <div v-for="(v, k) in { 'pg_dump': tools.pgDump, 'pg_restore': tools.pgRestore, 'ora2pg': tools.ora2pg }" :key="k">
          <b>{{ k }}</b>: <span :class="v.ok ? 'ok' : 'error'">{{ v.version }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { DxTextBox } from 'devextreme-vue/text-box';
import { DxNumberBox } from 'devextreme-vue/number-box';
import { DxButton } from 'devextreme-vue/button';
import { api, safe, toast } from '../api';

const s = reactive({});
const tools = ref(null);
async function load() { const r = await safe(() => api.get('/settings')); if (r) Object.assign(s, r); }
async function save() { const r = await safe(() => api.put('/settings', { ...s })); if (r) { toast('Сохранено'); check(); } }
async function check() { tools.value = await safe(() => api.get('/tools')); }
onMounted(() => { load(); check(); });
</script>
