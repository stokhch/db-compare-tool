<template>
  <div>
    <h2 class="page">Поиск по базе</h2>
    <div class="panel">
      <div class="row"><DbPicker v-model="db" label="База" /></div>
      <div class="toolbar">
        <DxRadioGroup v-model:value="mode" layout="horizontal" value-expr="v" display-expr="t"
          :items="[{ v: 'value', t: 'Значение во всех таблицах' }, { v: 'code', t: 'Текст в коде' }, { v: 'name', t: 'Имена таблиц и колонок' }]" />
      </div>
      <div class="toolbar">
        <DxTextBox v-model:value="text" value-change-event="input" :width="420" placeholder="Что искать: ИНН, фамилию, имя таблицы, фрагмент SQL…" @enter-key="run" />
        <DxCheckBox v-if="mode === 'value'" v-model:value="exact" text="Точное совпадение" />
        <DxCheckBox v-if="mode !== 'name'" v-model:value="caseSensitive" text="С учётом регистра" />
        <DxCheckBox v-if="mode === 'code'" v-model:value="allSchemas" text="Во всех схемах" />
        <DxButton text="Найти" icon="search" type="default" :disabled="!db.connId || !text.trim()" @click="run" />
      </div>
      <p class="hint" v-if="mode === 'value'">Ищется во всех текстовых колонках (и в числовых, если введено число). На больших таблицах без индексов это полное чтение — запускайте на копии или в нерабочее время.</p>
    </div>
    <JobPanel v-if="jobId" :job-id="jobId" :report="false" @done="j => (res = j.result)" />
    <div v-if="res" class="panel">
      <b>{{ res.summary.mode === 'value' ? `Найдено в ${res.summary.found} таблицах из ${res.summary.tables}` : `Найдено объектов: ${res.summary.objects}` }}</b>
      <template v-if="res.summary.mode === 'value'">
        <div v-for="h in res.hits" :key="h.table" class="hit">
          <div class="toolbar"><b>{{ h.table }}</b><span class="hint">колонки: {{ h.columns.join(', ') }} · строк: {{ h.rows }}{{ h.more ? '+' : '' }}</span>
            <DxButton text="Открыть в SQL-консоли" styling-mode="text" @click="toConsole(h.sql)" /></div>
          <DxDataGrid :data-source="h.sample" :show-borders="true" :column-auto-width="true" />
        </div>
      </template>
      <template v-else-if="res.summary.mode === 'code'">
        <div v-for="h in res.hits" :key="h.type + h.object" class="hit">
          <b>{{ h.type }} {{ h.object }}</b> <span class="hint">совпадений {{ h.count }}</span>
          <div v-for="l in h.lines" :key="l.line" class="mono"><span class="hint">{{ String(l.line).padStart(5) }}:</span> {{ l.text }}</div>
        </div>
      </template>
      <DxDataGrid v-else :data-source="res.hits" :show-borders="true">
        <DxColumn data-field="type" caption="Тип" :width="140" /><DxColumn data-field="object" caption="Объект" /><DxColumn data-field="detail" caption="" />
      </DxDataGrid>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { DxButton } from 'devextreme-vue/button';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { DxRadioGroup } from 'devextreme-vue/radio-group';
import { DxTextBox } from 'devextreme-vue/text-box';
import { DxDataGrid, DxColumn } from 'devextreme-vue/data-grid';
import DbPicker from '../components/DbPicker.vue';
import JobPanel from '../components/JobPanel.vue';
import { api, safe } from '../api';
import { lastPick } from '../store';
import { useJobFromRoute } from '../jobroute';

const lp = lastPick();
const router = useRouter();
const db = ref({ connId: null, schema: '', ...lp.src });
const mode = ref('value'), text = ref(''), exact = ref(false), caseSensitive = ref(false), allSchemas = ref(false);
const jobId = ref(null), res = ref(null);
async function run() {
  if (!text.value.trim()) return;
  res.value = null;
  const j = await safe(() => api.post('/jobs/db-search', { connId: db.value.connId, schema: db.value.schema, mode: mode.value, text: text.value, exact: exact.value, caseSensitive: caseSensitive.value, allSchemas: allSchemas.value }));
  if (j) jobId.value = j.id;
}
function toConsole(sql) { localStorage.setItem('dbcompare.sql.pending', sql); router.push('/sql'); }
useJobFromRoute(['db-search'], j => { jobId.value = j.id; });
</script>

<style scoped>
.hit { border-top: 1px solid #e4e7ec; padding: 8px 0; }
</style>
