<template>
  <div class="panel">
    <p class="hint" style="margin-top:0">Перед переносом пакета: всё ли, что он вызывает, уже есть в PostgreSQL — собственные подпрограммы, процедуры других пакетов
      (по ALL_DEPENDENCIES и по тексту <span class="mono">ПАКЕТ.процедура</span>), таблицы, представления, последовательности. Отсюда же порядок установки пакетов
      (сначала те, от которых зависят другие) и циклы, которые придётся ставить в два прохода.</p>
    <ObjectPicker v-model="objects" :conn-id="src.connId" :schema="src.schema" :only-types="['package', 'procedure', 'function']" :height="220" />
    <div class="row" style="margin-top:8px">
      <div class="field" style="width:260px"><label>Схема в PostgreSQL</label><DxTextBox v-model:value="targetSchema" :placeholder="(tgt.schema || src.schema || '').toLowerCase()" /></div>
      <div class="field" style="min-width:360px"><label>Подпрограммы пакетов в PostgreSQL</label>
        <DxRadioGroup v-model:value="naming" layout="horizontal" value-expr="v" display-expr="t" :items="[{ v: 'underscore', t: 'пакет_процедура (plsql2pg)' }, { v: 'schema', t: 'пакет.процедура (ora2pg)' }]" /></div>
    </div>
    <div class="toolbar">
      <DxButton text="Проверить зависимости" icon="runner" type="default" :disabled="!src.connId || !tgt.connId || connType(src.connId) !== 'oracle'" @click="run" />
      <span class="hint">{{ objects.length ? `выбрано объектов: ${objects.length}` : 'ничего не выбрано — проверяются все пакеты схемы' }}</span>
      <span v-if="src.connId && connType(src.connId) !== 'oracle'" class="warning">Источник должен быть Oracle</span>
    </div>
    <JobPanel v-if="jobId" :job-id="jobId" :report="false" @done="j => (result = j.result)" />
    <template v-if="result">
      <div class="cards">
        <div class="card"><div class="v">{{ result.summary.objects }}</div><div class="l">объектов</div></div>
        <div class="card"><div class="v">{{ result.summary.dependencies }}</div><div class="l">зависимостей</div></div>
        <div class="card"><div class="v" :class="result.summary.missing ? 'error' : 'ok'">{{ result.summary.missing }}</div><div class="l">нет в PostgreSQL</div></div>
        <div class="card"><div class="v" :class="result.summary.missingPackages ? 'error' : 'ok'">{{ result.summary.missingPackages }}</div><div class="l">пакетов поставить</div></div>
      </div>
      <div v-if="result.missingPackages.length" class="error" style="margin-bottom:6px">Не поставлены (полностью или частично): <b class="mono">{{ result.missingPackages.join(', ') }}</b></div>
      <div v-if="result.order.length" style="margin-bottom:6px"><b>Порядок установки:</b> <span class="mono">{{ result.order.join(' → ') }}</span></div>
      <div v-for="c in result.cycles" :key="c" class="warning">Цикл: <span class="mono">{{ c }}</span> — поставьте спецификации (пустые функции), затем тела</div>
      <DxDataGrid :data-source="result.objects" :show-borders="true" :word-wrap-enabled="true" style="margin:8px 0">
        <DxColumn data-field="object" caption="Объект" />
        <DxColumn data-field="type" caption="Тип" :width="120" />
        <DxColumn data-field="total" caption="Зависимостей" :width="120" />
        <DxColumn data-field="missing" caption="Нет в PG" :width="100" cell-template="m" />
        <DxColumn caption="Чего не хватает" :calculate-cell-value="r => r.missingList.join(', ')" css-class="mono" />
        <template #m="{ data }"><span :class="data.value ? 'error' : 'ok'">{{ data.value }}</span></template>
      </DxDataGrid>
      <div class="toolbar"><DxCheckBox v-model:value="onlyMissing" text="Только отсутствующие" /></div>
      <DxDataGrid :data-source="rows" :show-borders="true" :word-wrap-enabled="true">
        <DxSearchPanel :visible="true" /><DxFilterRow :visible="true" /><DxPaging :page-size="50" />
        <DxColumn data-field="object" caption="Кто" />
        <DxColumn data-field="dependency" caption="От чего зависит" css-class="mono" />
        <DxColumn data-field="kind" caption="Вид" :width="170" />
        <DxColumn data-field="expected" caption="Ожидается в PostgreSQL" css-class="mono" />
        <DxColumn data-field="ok" caption="" cell-template="ok" :width="90" />
        <template #ok="{ data }"><span v-if="data.data.info" class="hint">справка</span><span v-else :class="data.value ? 'ok' : 'error'">{{ data.value ? 'есть' : 'нет' }}</span></template>
      </DxDataGrid>
    </template>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { DxButton } from 'devextreme-vue/button';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { DxTextBox } from 'devextreme-vue/text-box';
import { DxRadioGroup } from 'devextreme-vue/radio-group';
import { DxDataGrid, DxColumn, DxSearchPanel, DxFilterRow, DxPaging } from 'devextreme-vue/data-grid';
import ObjectPicker from './ObjectPicker.vue';
import JobPanel from './JobPanel.vue';
import { api, safe } from '../api';
import { connType } from '../store';

const props = defineProps({ src: Object, tgt: Object });
const objects = ref([]);
const targetSchema = ref('');
const naming = ref('underscore');
const jobId = ref(null);
const result = ref(null);
const onlyMissing = ref(true);
const rows = computed(() => (result.value ? result.value.rows.filter(r => !onlyMissing.value || (!r.ok && !r.info)) : []));
async function run() {
  result.value = null;
  const j = await safe(() => api.post('/jobs/deps-check', {
    sourceId: props.src.connId, sourceSchema: props.src.schema, targetId: props.tgt.connId,
    targetSchema: targetSchema.value || (props.tgt.schema || props.src.schema).toLowerCase(), packageNaming: naming.value, objects: objects.value,
  }));
  if (j) jobId.value = j.id;
}
defineExpose({ show: j => { jobId.value = j.id; } });
</script>
