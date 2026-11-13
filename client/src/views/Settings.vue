<template>
  <div>
    <h2 class="page">Настройки</h2>
    <div class="panel">
      <h3>Утилиты</h3>
      <div class="field"><label>Папка с pg_dump / pg_restore</label>
        <DxTextBox v-model:value="s.pgBinPath" :placeholder="s.detectedPgBin ? `авто: ${s.detectedPgBin}` : 'C:\\Program Files\\PostgreSQL\\16\\bin (пусто — искать в PATH)'" />
      </div>
      <div class="field"><label>Какой ora2pg использовать</label>
        <DxRadioGroup v-model:value="s.ora2pgSource" layout="horizontal" value-expr="v" display-expr="t"
          :items="[{ v: 'auto', t: 'из комплекта plsql2pg (если найден)' }, { v: 'custom', t: 'свою установку' }]" />
      </div>
      <div v-if="s.ora2pgSource !== 'custom'" class="field"><label>Папка plsql2pg (распакованный plsql2pg-windows-x64.zip, в ней папки perl и ora2pg)</label>
        <DxTextBox v-model:value="s.plsql2pgHome" placeholder="C:\plsql2pg (проверяется автоматически)" />
        <div class="hint">В комплекте plsql2pg уже есть Perl и ora2pg — ставить ничего не нужно. Для действий, которым нужно подключение к Oracle (отчёт, COPY, TEST), Perl нужен ещё драйвер DBD::Oracle — его наличие показано ниже.</div>
      </div>
      <template v-else>
        <div class="field"><label>Команда ora2pg</label>
          <DxTextBox v-model:value="s.ora2pgCommand" placeholder="ora2pg или C:\Strawberry\perl\site\bin\ora2pg.bat" />
        </div>
        <div class="field"><label>Perl (если ora2pg запускается как скрипт: perl путь\к\ora2pg)</label>
          <DxTextBox v-model:value="s.perlPath" placeholder="C:\Strawberry\perl\bin\perl.exe (необязательно)" />
        </div>
      </template>
      <div class="field"><label>Oracle Instant Client (Thick-режим; нужен для Oracle 11g и старых паролей). После изменения перезапустите приложение.</label>
        <DxTextBox v-model:value="s.oracleClientLibDir" placeholder="C:\oracle\instantclient_23_5 (пусто — Thin-режим без клиента)" />
      </div>
      <h3 style="margin-top:16px">Сравнение</h3>
      <div class="row">
        <div class="field" style="width:220px"><label>Строк за одну выборку (fetch size)</label><DxNumberBox v-model:value="s.fetchSize" :min="100" :max="50000" :step="500" :show-spin-buttons="true" /></div>
        <div class="field" style="width:220px"><label>Допуск чисел по умолчанию, абсолютный</label><DxNumberBox v-model:value="s.absTolerance" :min="0" format="#0.##########" /></div>
        <div class="field" style="width:220px"><label>Допуск чисел по умолчанию, относительный</label><DxNumberBox v-model:value="s.relTolerance" :min="0" format="#0.##########" /></div>
        <div class="field" style="width:220px"><label>Примеров отличий на таблицу</label><DxNumberBox v-model:value="s.maxDiffsPerTable" :min="1" :max="10000" :show-spin-buttons="true" /></div>
      </div>
      <div class="toolbar">
        <DxButton text="Сохранить" icon="save" type="default" @click="save" />
        <DxButton text="Проверить утилиты" icon="video" styling-mode="outlined" @click="check" />
      </div>
      <div v-if="tools">
        <div v-for="(v, k) in { 'pg_dump': tools.pgDump, 'pg_restore': tools.pgRestore, 'ora2pg': tools.ora2pg, 'Perl: DBD::Oracle': tools.dbdOracle, 'Perl: DBD::Pg': tools.dbdPg }" :key="k">
          <b>{{ k }}</b>: <span :class="v.ok ? 'ok' : 'error'">{{ v.version }}</span><span v-if="v.source" class="hint"> — {{ v.source }}</span>
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
import { DxRadioGroup } from 'devextreme-vue/radio-group';
import { api, safe, toast } from '../api';

const s = reactive({});
const tools = ref(null);
async function load() { const r = await safe(() => api.get('/settings')); if (r) Object.assign(s, r); }
async function save() { const r = await safe(() => api.put('/settings', { ...s })); if (r) { toast('Сохранено'); check(); } }
async function check() { tools.value = await safe(() => api.get('/tools')); }
onMounted(() => { load(); check(); });
</script>
