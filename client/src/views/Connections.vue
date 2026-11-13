<template>
  <div>
    <h2 class="page">Подключения</h2>
    <div class="toolbar">
      <DxButton text="Добавить подключение" icon="add" type="default" @click="openEdit()" />
      <DxButton text="Обновить" icon="refresh" styling-mode="outlined" @click="loadConnections" />
    </div>
    <div class="panel" style="padding:0">
      <DxDataGrid :data-source="connections" key-expr="id" :show-borders="false" :row-alternation-enabled="true"
        :column-auto-width="true" no-data-text="Подключений пока нет — добавьте первое" @row-dbl-click="e => openEdit(e.data)">
        <DxColumn data-field="name" caption="Название" />
        <DxColumn data-field="type" caption="СУБД" cell-template="typeCell" :width="110" />
        <DxColumn caption="Адрес" :calculate-cell-value="addr" />
        <DxColumn data-field="user" caption="Пользователь" />
        <DxColumn data-field="schema" caption="Схема по умолчанию" />
        <DxColumn caption="Проверка" cell-template="testCell" :width="260" />
        <DxColumn caption="" cell-template="actions" :width="150" />
        <template #typeCell="{ data }">{{ data.value === 'oracle' ? '🟥 Oracle' : '🟦 PostgreSQL' }}</template>
        <template #testCell="{ data }">
          <span v-if="tests[data.data.id]" :class="tests[data.data.id].ok ? 'ok' : 'error'" :title="tests[data.data.id].text">
            {{ tests[data.data.id].text.slice(0, 60) }}</span>
        </template>
        <template #actions="{ data }">
          <DxButton icon="video" hint="Проверить" styling-mode="text" @click="testSaved(data.data)" />
          <DxButton icon="edit" hint="Изменить" styling-mode="text" @click="openEdit(data.data)" />
          <DxButton icon="copy" hint="Дублировать" styling-mode="text" @click="openEdit({ ...data.data, id: undefined, name: data.data.name + ' (копия)' }, true)" />
          <DxButton icon="trash" hint="Удалить" styling-mode="text" @click="remove(data.data)" />
        </template>
      </DxDataGrid>
    </div>
    <p class="hint">Пароли хранятся локально в <span class="mono">data/connections.json</span> в зашифрованном виде (ключ — <span class="mono">data/.secret</span> или переменная DBCOMPARE_SECRET).<br>
      Oracle подключается без Oracle Client (Thin-режим, Oracle 12.1+). Для Oracle 11g укажите путь к Instant Client в Настройках.</p>

    <DxPopup v-model:visible="popup" :title="form.id ? 'Изменить подключение' : 'Новое подключение'" :width="560" height="auto" :show-close-button="true">
      <div>
        <div class="field"><label>Название</label><DxTextBox v-model:value="form.name" placeholder="Например: Прод Oracle" /></div>
        <div class="field"><label>СУБД</label>
          <DxRadioGroup v-model:value="form.type" :items="types" value-expr="v" display-expr="t" layout="horizontal" @value-changed="onType" />
        </div>
        <div class="row">
          <div class="field" style="flex:3"><label>Хост</label><DxTextBox v-model:value="form.host" /></div>
          <div class="field" style="flex:1"><label>Порт</label><DxNumberBox v-model:value="form.port" :min="1" :max="65535" /></div>
        </div>
        <template v-if="form.type === 'oracle'">
          <div class="row">
            <div class="field" style="flex:1"><label>Тип идентификатора</label>
              <DxSelectBox v-model:value="form.oracleConnectMode" :items="[{ v: 'service', t: 'Service name' }, { v: 'sid', t: 'SID' }]" value-expr="v" display-expr="t" />
            </div>
            <div class="field" style="flex:2"><label>{{ form.oracleConnectMode === 'sid' ? 'SID' : 'Service name' }}</label><DxTextBox v-model:value="form.database" placeholder="ORCLPDB1" /></div>
          </div>
          <div class="field"><label>Или полная строка подключения (EZConnect / TNS-дескриптор) — необязательно</label>
            <DxTextBox v-model:value="form.connectString" placeholder="host:1521/service или (DESCRIPTION=…)" /></div>
        </template>
        <div v-else class="field"><label>База данных</label><DxTextBox v-model:value="form.database" placeholder="postgres" /></div>
        <div class="row">
          <div class="field" style="flex:1"><label>Пользователь{{ form.type === 'oracle' ? ' (можно «sys as sysdba»)' : '' }}</label><DxTextBox v-model:value="form.user" /></div>
          <div class="field" style="flex:1"><label>Пароль</label>
            <DxTextBox v-model:value="form.password" mode="password" :placeholder="form.hasPassword ? 'не менять' : ''" /></div>
        </div>
        <div class="row">
          <div class="field" style="flex:1"><label>Схема по умолчанию</label><DxTextBox v-model:value="form.schema" :placeholder="form.type === 'oracle' ? 'как пользователь' : 'public'" /></div>
          <div v-if="form.type === 'postgres'" class="field" style="flex:1;padding-top:22px"><DxCheckBox v-model:value="form.ssl" text="SSL" /></div>
        </div>
        <div v-if="testResult" :class="testResult.ok ? 'ok' : 'error'" style="margin:6px 0 10px;word-break:break-word;white-space:pre-wrap">{{ testResult.text }}</div>
        <div class="toolbar" style="justify-content:flex-end;margin:8px 0 0">
          <DxButton text="Проверить" icon="video" styling-mode="outlined" :disabled="testing" @click="testForm" />
          <DxButton text="Сохранить" type="default" icon="save" @click="save" />
        </div>
      </div>
    </DxPopup>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { DxDataGrid, DxColumn } from 'devextreme-vue/data-grid';
import { DxButton } from 'devextreme-vue/button';
import { DxPopup } from 'devextreme-vue/popup';
import { DxTextBox } from 'devextreme-vue/text-box';
import { DxNumberBox } from 'devextreme-vue/number-box';
import { DxSelectBox } from 'devextreme-vue/select-box';
import { DxRadioGroup } from 'devextreme-vue/radio-group';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { confirm } from 'devextreme/ui/dialog';
import { api, safe, toast, fmtMs } from '../api';
import { connections, loadConnections } from '../store';

const types = [{ v: 'oracle', t: 'Oracle' }, { v: 'postgres', t: 'PostgreSQL' }];
const popup = ref(false);
const testing = ref(false);
const testResult = ref(null);
const tests = reactive({});
const empty = () => ({ id: undefined, name: '', type: 'postgres', host: 'localhost', port: 5432, database: '', oracleConnectMode: 'service', connectString: '', user: '', password: '', schema: '', ssl: false, hasPassword: false });
const form = reactive(empty());

const addr = r => r.type === 'oracle' && r.connectString ? r.connectString : `${r.host}:${r.port}/${r.database}`;

function openEdit(row, duplicate = false) {
  Object.assign(form, empty(), row || {}, { password: '' });
  if (duplicate) form.hasPassword = false;
  testResult.value = null;
  popup.value = true;
}
function onType(e) {
  if (e.value === 'oracle' && form.port === 5432) form.port = 1521;
  if (e.value === 'postgres' && form.port === 1521) form.port = 5432;
}
async function testForm() {
  testing.value = true; testResult.value = { ok: true, text: 'Подключение…' };
  try {
    const r = await api.post('/connections/test', { ...form });
    testResult.value = { ok: true, text: `✓ ${r.version} (${fmtMs(r.ms)})` };
  } catch (e) { testResult.value = { ok: false, text: '✗ ' + e.message }; }
  testing.value = false;
}
async function testSaved(row) {
  tests[row.id] = { ok: true, text: 'Подключение…' };
  try { const r = await api.post('/connections/test', { ...row }); tests[row.id] = { ok: true, text: `✓ ${r.version}` }; }
  catch (e) { tests[row.id] = { ok: false, text: '✗ ' + e.message }; }
}
async function save() {
  if (!form.host || !form.user) return toast('Укажите хост и пользователя', 'warning');
  const r = await safe(() => (form.id ? api.put(`/connections/${form.id}`, form) : api.post('/connections', form)));
  if (r) { popup.value = false; toast('Сохранено'); loadConnections(); }
}
async function remove(row) {
  if (!(await confirm(`Удалить подключение «${row.name}»?`, 'Подтверждение'))) return;
  await safe(() => api.del(`/connections/${row.id}`));
  loadConnections();
}
</script>
