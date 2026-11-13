<template>
  <div class="panel">
    <div class="toolbar">
      <h3 style="margin:0">Скрипт синхронизации структуры</h3>
      <span class="hint">Приводит приёмник ({{ sync.dialect === 'oracle' ? 'Oracle' : 'PostgreSQL' }}, схема {{ sync.targetSchema }}) к источнику.
        Выбрано {{ selected.length }} из {{ runnable.length }}. Удаления лишнего по умолчанию выключены.</span>
    </div>
    <div v-if="!sync.statements.length" class="ok">Различий в структуре, которые можно исправить скриптом, нет.</div>
    <template v-else>
      <DxDataGrid :data-source="sync.statements" key-expr="id" :show-borders="true" :word-wrap-enabled="true" :height="440"
        :selected-row-keys="selected" @selection-changed="e => (selected = e.selectedRowKeys.filter(id => runnableIds.has(id)))">
        <DxSelection mode="multiple" show-check-boxes-mode="always" />
        <DxGrouping :auto-expand-all="true" />
        <DxSearchPanel :visible="true" placeholder="Поиск…" />
        <DxScrolling mode="virtual" />
        <DxColumn data-field="group" caption="Группа" :group-index="0" />
        <DxColumn data-field="object" caption="Объект" css-class="mono" :width="220" />
        <DxColumn data-field="risk" caption="Риск" :width="90" cell-template="risk" />
        <DxColumn data-field="sql" caption="SQL" cell-template="sql" />
        <DxColumn data-field="note" caption="Комментарий" :width="260" />
        <template #risk="{ data }"><span :class="{ low: 'ok', medium: 'warning', high: 'error' }[data.value]">{{ { low: 'низкий', medium: 'средний', high: 'высокий' }[data.value] }}</span></template>
        <template #sql="{ data }"><pre class="mono" style="margin:0;white-space:pre-wrap;max-height:160px;overflow:auto">{{ data.value }}</pre></template>
      </DxDataGrid>
      <div class="toolbar" style="margin-top:10px">
        <DxButton text="Скачать .sql" icon="download" styling-mode="outlined" @click="download" />
        <DxButton text="Копировать" icon="copy" styling-mode="outlined" @click="copy" />
        <DxCheckBox v-if="sync.dialect === 'postgres'" v-model:value="transaction" text="В одной транзакции (откат при ошибке)" />
        <DxButton text="Выполнить выбранные на приёмнике" icon="runner" type="danger" :disabled="!selected.length" @click="apply" />
      </div>
      <JobPanel v-if="jobId" :job-id="jobId" :report="false" :log-open="true" @done="j => emit('applied', j)" />
    </template>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { DxButton } from 'devextreme-vue/button';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { DxDataGrid, DxColumn, DxSelection, DxGrouping, DxSearchPanel, DxScrolling } from 'devextreme-vue/data-grid';
import { confirm } from 'devextreme/ui/dialog';
import JobPanel from './JobPanel.vue';
import { api, safe, toast } from '../api';

const props = defineProps({ sync: { type: Object, required: true }, targetId: String });
const emit = defineEmits(['applied']);
const runnable = computed(() => props.sync.statements.filter(s => !s.comment));
const runnableIds = computed(() => new Set(runnable.value.map(s => s.id)));
const selected = ref([]);
const transaction = ref(true);
const jobId = ref(null);
watch(() => props.sync, s => { selected.value = s.statements.filter(x => x.enabled && !x.comment).map(x => x.id); jobId.value = null; }, { immediate: true });

const chosen = () => props.sync.statements.map(s => ({ ...s, enabled: s.comment || selected.value.includes(s.id) }));
async function script() {
  const r = await safe(() => api.post('/sync/render', { dialect: props.sync.dialect, targetSchema: props.sync.targetSchema, statements: chosen() }));
  return r && r.script;
}
async function download() {
  const s = await script(); if (!s) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([s], { type: 'text/sql;charset=utf-8' }));
  a.download = `schema_sync_${props.sync.targetSchema}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.sql`;
  a.click(); URL.revokeObjectURL(a.href);
}
async function copy() {
  const s = await script(); if (!s) return;
  try { await navigator.clipboard.writeText(s); toast('Скрипт скопирован'); } catch { toast('Не удалось скопировать — используйте «Скачать .sql»', 'warning'); }
}
async function apply() {
  const list = props.sync.statements.filter(s => selected.value.includes(s.id));
  const risky = list.filter(s => s.risk === 'high').length;
  const msg = `Выполнить ${list.length} операторов на приёмнике?${risky ? `<br><b>Из них с высоким риском: ${risky}</b> (изменение типов, удаления).` : ''}`
    + (props.sync.dialect === 'oracle' ? '<br>В Oracle DDL фиксируется сразу — откатить не получится.' : '');
  if (!(await confirm(msg, 'Изменение базы-приёмника'))) return;
  const j = await safe(() => api.post('/jobs/apply-sql', { targetId: props.targetId, statements: list, transaction: transaction.value }));
  if (j) jobId.value = j.id;
}
</script>
