<template>
  <div>
    <h2 class="page">Тестовая копия</h2>
    <div class="panel">
      <p class="hint" style="margin-top:0">Копия для разработчиков и тестировщиков: только нужная часть данных (срез по внешним ключам) и без настоящих персональных данных.
        Маскирование детерминированное: одно и то же значение везде заменяется одинаково, поэтому связи и поиск по ним сохраняются; СНИЛС и ИНН получают
        правильные контрольные суммы, телефоны и даты сохраняют формат.</p>
      <div class="row"><DbPicker v-model="src" label="Источник" /><DbPicker v-model="tgt" label="Приёмник (тестовая база)" /></div>
    </div>

    <div class="panel">
      <DxCheckBox v-model:value="sub.enabled" text="Срез базы — копировать не всё, а согласованную часть" />
      <template v-if="sub.enabled">
        <div class="row" style="margin-top:6px">
          <div class="field" style="width:260px"><label>Начать с таблицы</label><DxSelectBox v-model:value="sub.root" :items="tables" :search-enabled="true" placeholder="например, dept или filial" /></div>
          <div class="field col"><label>Условие отбора (WHERE)</label><DxTextBox v-model:value="sub.where" placeholder="region_id = 77   или   created >= DATE '2026-01-01'" /></div>
        </div>
        <div class="row">
          <div class="field col"><label>Справочники целиком</label><DxTagBox v-model:value="sub.fullTables" :items="tables" :search-enabled="true" placeholder="Таблицы, которые копируются полностью" /></div>
          <div class="field" style="width:130px"><label>Глубина вниз</label><DxNumberBox v-model:value="sub.depth" :min="0" :max="6" :show-spin-buttons="true" /></div>
          <div class="field" style="width:160px"><label>Строк на таблицу, не больше</label><DxNumberBox v-model:value="sub.maxRows" :min="100" :step="10000" /></div>
        </div>
        <DxCheckBox v-model:value="sub.children" text="Брать дочерние строки (заказы выбранных клиентов и т. п.)" />
        <p class="hint">Всё, на что ссылаются выбранные строки (родительские записи), добавляется автоматически — внешние ключи в копии не нарушаются.</p>
      </template>
    </div>

    <div class="panel">
      <div class="toolbar">
        <DxCheckBox v-model:value="mask.enabled" text="Маскировать персональные данные" />
        <DxButton text="Найти персональные данные" icon="search" styling-mode="outlined" :disabled="!src.connId || !src.schema" @click="scan" />
        <DxButton text="Добавить правило" icon="add" styling-mode="text" @click="mask.rules = [...mask.rules, { table: '', column: '', method: 'scramble' }]" />
        <div class="field" style="width:240px;margin:0"><label>Секрет (меняет все замены)</label><DxTextBox v-model:value="mask.secret" mode="password" /></div>
      </div>
      <JobPanel v-if="scanJob" :job-id="scanJob" :report="false" @done="onScan" />
      <DxDataGrid :data-source="mask.rules" :show-borders="true" no-data-text="Правил нет — нажмите «Найти персональные данные»">
        <DxEditing mode="cell" :allow-updating="true" :allow-deleting="true" :confirm-delete="false" />
        <DxColumn data-field="table" caption="Таблица" :width="200" />
        <DxColumn data-field="column" caption="Колонка" :width="180" />
        <DxColumn data-field="method" caption="Способ" :width="220"><DxLookup :data-source="methodItems" value-expr="v" display-expr="t" /></DxColumn>
        <DxColumn data-field="value" caption="Константа" :width="120" />
        <DxColumn data-field="reason" caption="Найдено" :allow-editing="false" :width="150" />
        <DxColumn data-field="example" caption="Пример" :allow-editing="false" />
        <DxColumn data-field="masked" caption="→ после маскирования" :allow-editing="false" />
      </DxDataGrid>
    </div>

    <div class="panel">
      <div class="toolbar">
        <div class="field" style="min-width:300px;margin:0"><label>Таблицы приёмника</label>
          <DxRadioGroup v-model:value="mode" layout="horizontal" value-expr="v" display-expr="t" :items="[{ v: 'truncate', t: 'очистить и загрузить' }, { v: 'append', t: 'добавить' }]" /></div>
        <DxButton text="Создать тестовую копию" icon="runner" type="default" :disabled="!ready" @click="run" />
        <span v-if="mask.enabled && !mask.rules.length" class="warning">Маскирование включено, но правил нет</span>
      </div>
    </div>
    <JobPanel v-if="jobId" :job-id="jobId" :report="false" @done="j => (res = j.result)" />
    <div v-if="res" class="panel">
      <div class="cards">
        <div class="card"><div class="v">{{ res.summary.done }} / {{ res.summary.tables }}</div><div class="l">таблиц</div></div>
        <div class="card"><div class="v">{{ fmtNum(res.summary.rows) }}</div><div class="l">строк</div></div>
        <div class="card"><div class="v">{{ fmtNum(res.summary.maskedRows) }}</div><div class="l">строк замаскировано ({{ res.summary.maskedColumns }} колонок)</div></div>
        <div class="card"><div class="v" :class="res.summary.error ? 'error' : 'ok'">{{ res.summary.error }}</div><div class="l">ошибок</div></div>
      </div>
      <DxDataGrid v-if="res.subset && res.subset.length" :data-source="res.subset" :show-borders="true">
        <DxColumn data-field="table" caption="Таблица" /><DxColumn caption="Строк" :calculate-cell-value="r => (r.all ? 'целиком' : r.rows)" /><DxColumn data-field="why" caption="Почему вошла" />
      </DxDataGrid>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { DxButton } from 'devextreme-vue/button';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { DxNumberBox } from 'devextreme-vue/number-box';
import { DxRadioGroup } from 'devextreme-vue/radio-group';
import { DxSelectBox } from 'devextreme-vue/select-box';
import { DxTagBox } from 'devextreme-vue/tag-box';
import { DxTextBox } from 'devextreme-vue/text-box';
import { DxDataGrid, DxColumn, DxEditing, DxLookup } from 'devextreme-vue/data-grid';
import { confirm } from 'devextreme/ui/dialog';
import DbPicker from '../components/DbPicker.vue';
import JobPanel from '../components/JobPanel.vue';
import { api, safe, fmtNum } from '../api';
import { lastPick } from '../store';
import { useJobFromRoute } from '../jobroute';

const METHODS = { lastname: 'Фамилия', firstname: 'Имя', middlename: 'Отчество', fullname: 'ФИО целиком', phone: 'Телефон', email: 'E-mail', passport: 'Паспорт (цифры)', snils: 'СНИЛС', inn: 'ИНН', digits: 'Цифры (карта, счёт)', address: 'Адрес', date_shift: 'Дата ±180 дней', scramble: 'Перемешать буквы и цифры', hash: 'Хеш', constant: 'Константа', null: 'Пусто (NULL)', keep: 'Не маскировать' };
const methodItems = Object.entries(METHODS).map(([v, t]) => ({ v, t }));
const lp = lastPick();
const src = ref({ connId: null, schema: '', ...lp.src }), tgt = ref({ connId: null, schema: '', ...lp.tgt });
const saved = (() => { try { return JSON.parse(localStorage.getItem('dbcompare.testcopy') || '{}'); } catch { return {}; } })();
const sub = reactive({ enabled: false, root: null, where: '', children: true, depth: 2, fullTables: [], maxRows: 100000, ...(saved.sub || {}) });
const mask = reactive({ enabled: true, secret: '', rules: [], ...(saved.mask || {}) });
const mode = ref('truncate');
const tables = ref([]);
const scanJob = ref(null), jobId = ref(null), res = ref(null);
const ready = computed(() => src.value.connId && src.value.schema && tgt.value.connId && tgt.value.schema && (!sub.enabled || sub.root));
watch([sub, mask], () => localStorage.setItem('dbcompare.testcopy', JSON.stringify({ sub, mask: { ...mask, secret: '' } })), { deep: true });
watch(() => [src.value.connId, src.value.schema], async () => {
  tables.value = [];
  if (!src.value.connId || !src.value.schema) return;
  const r = await safe(() => api.get(`/connections/${src.value.connId}/tables?schema=${encodeURIComponent(src.value.schema)}`));
  if (r) tables.value = r.map(t => t.name);
}, { immediate: true });
async function scan() { const j = await safe(() => api.post('/jobs/pii-scan', { sourceId: src.value.connId, sourceSchema: src.value.schema })); if (j) scanJob.value = j.id; }
function onScan(j) {
  if (!j.result) return;
  const have = new Set(mask.rules.map(r => `${r.table}.${r.column}`.toLowerCase()));
  mask.rules = [...mask.rules, ...j.result.rules.filter(r => !have.has(`${r.table}.${r.column}`.toLowerCase()))];
  mask.enabled = true;
}
async function run() {
  if (mode.value === 'truncate' && !(await confirm(`Таблицы в ${tgt.value.schema} будут очищены и загружены заново. Продолжить?`, 'Тестовая копия'))) return;
  res.value = null;
  const j = await safe(() => api.post('/jobs/test-copy', {
    sourceId: src.value.connId, sourceSchema: src.value.schema, targetId: tgt.value.connId, targetSchema: tgt.value.schema, mode: mode.value,
    subset: { ...sub }, masking: { enabled: mask.enabled, secret: mask.secret || undefined, rules: mask.rules.filter(r => r.table && r.column).map(r => ({ table: r.table, column: r.column, method: r.method, value: r.value })) },
  }));
  if (j) jobId.value = j.id;
}
useJobFromRoute(['test-copy', 'pii-scan'], j => { if (j.type === 'test-copy') jobId.value = j.id; else scanJob.value = j.id; });
</script>
