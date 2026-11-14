<template>
  <div>
    <h2 class="page">Производительность</h2>
    <DxTabs :items="tabs" :selected-index="tab" @item-click="e => (tab = e.itemIndex)" />

    <!-- ===== Планы ===== -->
    <div v-show="tab === 0">
      <div class="panel">
        <p class="hint" style="margin-top:0">Одни и те же запросы выполняются в обеих базах; рядом — время и планы. По плану PostgreSQL приложение подсказывает, чего не хватает: индекса,
          одинаковых типов колонок соединения (после миграции integer ⇄ numeric мешает индексам), индекса по выражению, свежей статистики, памяти для сортировки.
          В Oracle план берётся с фактической статистикой (если есть права на V$SQL_PLAN), в PostgreSQL — EXPLAIN ANALYZE внутри транзакции с откатом.</p>
        <div class="row"><DbPicker v-model="src" label="Источник" /><DbPicker v-model="tgt" label="Приёмник (необязательно)" /></div>
        <div class="toolbar">
          <DxButton text="Добавить запрос" icon="add" styling-mode="outlined" @click="queries.push({ title: `Запрос ${queries.length + 1}`, sourceSql: '', targetSql: '' })" />
          <DxSelectBox :items="sets" display-expr="name" value-expr="id" placeholder="Из сохранённого набора запросов…" :width="280" @value-changed="loadSet" />
          <DxButton text="Тяжёлые запросы источника" icon="chart" styling-mode="text" :disabled="!src.connId" @click="loadTop" />
          <DxCheckBox v-model:value="analyze" text="Выполнять запросы (EXPLAIN ANALYZE)" />
        </div>
        <div v-for="(q, i) in queries" :key="i" class="qrow">
          <div class="toolbar"><DxTextBox v-model:value="q.title" :width="300" /><DxButton icon="trash" styling-mode="text" @click="queries.splice(i, 1)" /></div>
          <div class="row"><textarea v-model="q.sourceSql" class="sqlbox" placeholder="SQL для источника" /><textarea v-model="q.targetSql" class="sqlbox" placeholder="SQL для приёмника (пусто — тот же)" /></div>
        </div>
        <div class="toolbar">
          <DxButton text="Сравнить планы" icon="runner" type="default" :disabled="!src.connId || !queries.some(q => q.sourceSql.trim())" @click="runPlans" />
          <AddToSuite type="plan-compare" :params="planParams" default-title="Планы запросов" />
        </div>
      </div>
      <JobPanel v-if="planJob" :job-id="planJob" :report="false" @done="j => (plans = j.result)" />
      <PlanResults v-if="plans" :result="plans" />
    </div>

    <!-- ===== Индексы ===== -->
    <div v-show="tab === 1">
      <div class="panel">
        <p class="hint" style="margin-top:0">Внешние ключи без индекса, дублирующиеся и неиспользуемые индексы, таблицы без первичного ключа, таблицы, которые постоянно читаются целиком.
          Если указать вторую базу (например, Oracle-источник), будут найдены индексы, которые там были, а здесь потерялись при миграции.</p>
        <div class="row"><DbPicker v-model="ix" label="База" /><DbPicker v-model="ixOther" label="Сравнить с (необязательно)" /></div>
        <div class="toolbar">
          <DxButton text="Проверить индексы" icon="runner" type="default" :disabled="!ix.connId || !ix.schema" @click="runIdx" />
          <AddToSuite type="index-advice" :params="idxParams" default-title="Индексы" />
        </div>
      </div>
      <JobPanel v-if="idxJob" :job-id="idxJob" :report="false" @done="j => (idx = j.result)" />
      <div v-if="idx" class="panel">
        <div class="cards">
          <div class="card"><div class="v" :class="idx.summary.fkNoIndex ? 'warning' : 'ok'">{{ idx.summary.fkNoIndex }}</div><div class="l">FK без индекса</div></div>
          <div class="card"><div class="v" :class="idx.summary.missing ? 'warning' : 'ok'">{{ idx.summary.missing }}</div><div class="l">потеряно при миграции</div></div>
          <div class="card"><div class="v">{{ idx.summary.duplicates }}</div><div class="l">дублей</div></div>
          <div class="card"><div class="v">{{ idx.summary.unused }}</div><div class="l">не используются</div></div>
          <div class="card"><div class="v" :class="idx.summary.invalid ? 'error' : 'ok'">{{ idx.summary.invalid }}</div><div class="l">недействительных</div></div>
          <div class="card"><div class="v">{{ idx.summary.noPk }}</div><div class="l">таблиц без PK</div></div>
        </div>
        <SqlScript :items="idx.advices" />
        <DxDataGrid :data-source="idx.advices" :show-borders="true" :word-wrap-enabled="true">
          <DxSearchPanel :visible="true" /><DxPaging :page-size="30" /><DxGrouping :auto-expand-all="true" />
          <DxColumn data-field="kind" caption="Вид" :group-index="0" :calculate-display-value="r => KINDS[r.kind] || r.kind" :calculate-group-value="r => KINDS[r.kind] || r.kind" />
          <DxColumn data-field="table" caption="Таблица" :width="180" />
          <DxColumn data-field="text" caption="Совет" />
          <DxColumn data-field="sql" caption="SQL" css-class="mono" :width="380" />
        </DxDataGrid>
      </div>
    </div>

    <!-- ===== Активность ===== -->
    <div v-show="tab === 2">
      <div class="panel">
        <div class="toolbar">
          <div class="field" style="width:320px;margin:0"><label>База</label><ConnSelect v-model="act.connId" /></div>
          <DxCheckBox v-model:value="act.auto" text="Обновлять каждые 5 с" />
          <DxCheckBox v-model:value="act.onlyActive" text="Только активные и блокировки" />
          <DxButton text="Обновить" icon="refresh" styling-mode="outlined" :disabled="!act.connId" @click="loadAct" />
        </div>
        <div v-if="actErr" class="error" style="white-space:pre-wrap">{{ actErr }}</div>
        <template v-if="activity">
          <div class="cards">
            <div class="card"><div class="v">{{ activity.summary.total }}<span class="hint" v-if="activity.maxConnections"> / {{ activity.maxConnections }}</span></div><div class="l">сеансов</div></div>
            <div class="card"><div class="v">{{ activity.summary.active }}</div><div class="l">выполняются</div></div>
            <div class="card"><div class="v" :class="activity.summary.long ? 'warning' : 'ok'">{{ activity.summary.long }}</div><div class="l">дольше минуты</div></div>
            <div class="card"><div class="v" :class="activity.summary.blocked ? 'error' : 'ok'">{{ activity.summary.blocked }}</div><div class="l">ждут блокировку</div></div>
            <div class="card"><div class="v" :class="activity.summary.rootBlockers ? 'error' : 'ok'">{{ activity.summary.rootBlockers }}</div><div class="l">блокируют других</div></div>
            <div class="card" v-if="activity.type === 'postgres'"><div class="v" :class="activity.summary.idleInTx ? 'warning' : 'ok'">{{ activity.summary.idleInTx }}</div><div class="l">idle in transaction</div></div>
          </div>
          <DxDataGrid :data-source="shownSessions" :show-borders="true" :word-wrap-enabled="true" key-expr="id" @row-prepared="rowPrep">
            <DxColumn data-field="id" caption="Сеанс" :width="100" />
            <DxColumn data-field="user" caption="Пользователь" :width="120" />
            <DxColumn data-field="app" caption="Программа" :width="140" />
            <DxColumn data-field="client" caption="Клиент" :width="120" />
            <DxColumn data-field="state" caption="Состояние" :width="120" />
            <DxColumn data-field="seconds" caption="Сек." :width="70" />
            <DxColumn data-field="wait" caption="Ожидание" :width="150" />
            <DxColumn caption="Блокировки" :width="150" :calculate-cell-value="s => [s.blockedBy.length ? `ждёт ${s.blockedBy.join(', ')}` : '', s.blocks ? `блокирует ${s.blocks}` : ''].filter(Boolean).join('; ')" />
            <DxColumn data-field="sql" caption="Запрос" css-class="mono" />
            <DxColumn caption="" :width="150" cell-template="act" />
            <template #act="{ data }">
              <DxButton text="Отменить" styling-mode="text" hint="Отменить текущий запрос" @click="kill(data.data, 'cancel')" />
              <DxButton text="Завершить" styling-mode="text" type="danger" @click="kill(data.data, 'terminate')" />
            </template>
          </DxDataGrid>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onUnmounted, reactive, ref, watch } from 'vue';
import { DxButton } from 'devextreme-vue/button';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { DxSelectBox } from 'devextreme-vue/select-box';
import { DxTabs } from 'devextreme-vue/tabs';
import { DxTextBox } from 'devextreme-vue/text-box';
import { DxDataGrid, DxColumn, DxSearchPanel, DxPaging, DxGrouping } from 'devextreme-vue/data-grid';
import { confirm } from 'devextreme/ui/dialog';
import DbPicker from '../components/DbPicker.vue';
import ConnSelect from '../components/ConnSelect.vue';
import JobPanel from '../components/JobPanel.vue';
import AddToSuite from '../components/AddToSuite.vue';
import PlanResults from '../components/PlanResults.vue';
import SqlScript from '../components/SqlScript.vue';
import { api, safe, toast } from '../api';
import { lastPick } from '../store';
import { useJobFromRoute } from '../jobroute';

const tabs = [{ text: 'Сравнение планов' }, { text: 'Индексы' }, { text: 'Активность и блокировки' }];
const tab = ref(0);
const lp = lastPick();
const src = ref({ connId: null, schema: '', ...lp.src }), tgt = ref({ connId: null, schema: '', ...lp.tgt });
const queries = ref([{ title: 'Запрос 1', sourceSql: '', targetSql: '' }]);
const analyze = ref(true), sets = ref([]), planJob = ref(null), plans = ref(null);
const KINDS = { fk: 'Внешний ключ без индекса', missing: 'Потерян при миграции', dup: 'Дублирующиеся', unused: 'Не используются', invalid: 'Недействительные', nopk: 'Нет первичного ключа', seq: 'Частое полное чтение', expr: 'Функциональные индексы' };

const planParams = () => (src.value.connId ? { sourceId: src.value.connId, sourceSchema: src.value.schema, targetId: tgt.value.connId || undefined, targetSchema: tgt.value.schema, analyze: analyze.value,
  queries: queries.value.filter(q => q.sourceSql.trim()).map(q => ({ title: q.title, sourceSql: q.sourceSql, targetSql: q.targetSql.trim() || q.sourceSql })) } : null);
async function runPlans() { plans.value = null; const j = await safe(() => api.post('/jobs/plan-compare', planParams())); if (j) planJob.value = j.id; }
(async () => { sets.value = (await safe(() => api.get('/saved/querysets'))) || []; })();
function loadSet(e) { const s = sets.value.find(x => x.id === e.value); if (s) queries.value = (s.queries || []).map((q, i) => ({ title: q.title || `Запрос ${i + 1}`, sourceSql: q.sourceSql || q.sql || '', targetSql: q.targetSql || '' })); }
async function loadTop() {
  const r = await safe(() => api.get(`/connections/${src.value.connId}/topsql?schema=${encodeURIComponent(src.value.schema || '')}`));
  if (r && r.length) { queries.value = r.filter(x => !x.hasBinds).slice(0, 15).map((x, i) => ({ title: `Топ ${i + 1}: ${x.avgMs} мс × ${x.executions}`, sourceSql: x.sql, targetSql: '' })); toast(`Загружено запросов без параметров: ${queries.value.length}`); }
}

// индексы
const ix = ref({ connId: null, schema: '', ...lp.tgt }), ixOther = ref({ connId: null, schema: '' });
const idxJob = ref(null), idx = ref(null);
const idxParams = () => (ix.value.connId ? { connId: ix.value.connId, schema: ix.value.schema, compareWithId: ixOther.value.connId || undefined, compareSchema: ixOther.value.schema || undefined } : null);
async function runIdx() { idx.value = null; const j = await safe(() => api.post('/jobs/index-advice', idxParams())); if (j) idxJob.value = j.id; }

// активность
const act = reactive({ connId: (lp.tgt && lp.tgt.connId) || null, auto: true, onlyActive: false });
const activity = ref(null), actErr = ref('');
let timer = null;
const shownSessions = computed(() => (activity.value ? activity.value.sessions.filter(s => !act.onlyActive || /active/i.test(s.state) || s.blocks || s.blockedBy.length || /idle in transaction/.test(s.state || '')) : []));
async function loadAct() {
  if (!act.connId) return;
  try { activity.value = await api.get(`/connections/${act.connId}/activity`); actErr.value = ''; } catch (e) { actErr.value = e.message; }
}
function schedule() { clearTimeout(timer); if (tab.value === 2 && act.auto && act.connId) timer = setTimeout(async () => { await loadAct(); schedule(); }, 5000); }
watch(() => [tab.value, act.connId, act.auto], () => { if (tab.value === 2) loadAct(); schedule(); });
onUnmounted(() => clearTimeout(timer));
function rowPrep(e) {
  if (e.rowType !== 'data') return;
  if (e.data.isRootBlocker) e.rowElement.style.background = '#fef3f2';
  else if (e.data.blockedBy.length) e.rowElement.style.background = '#fffaeb';
}
async function kill(s, mode) {
  if (!(await confirm(`${mode === 'cancel' ? 'Отменить текущий запрос' : 'Завершить сеанс'} ${s.id} (${s.user || ''}, ${s.app || ''})?`, 'Активность'))) return;
  const r = await safe(() => api.post(`/connections/${act.connId}/kill`, { session: s.id, mode }));
  if (r) { toast(r.ok ? 'Готово' : 'Сеанс уже завершён', r.ok ? 'success' : 'warning'); loadAct(); }
}
useJobFromRoute(['plan-compare', 'index-advice'], j => { if (j.type === 'plan-compare') { tab.value = 0; planJob.value = j.id; } else { tab.value = 1; idxJob.value = j.id; } });
</script>

<style scoped>
.qrow { border-top: 1px dashed #e4e7ec; padding-top: 6px; margin-top: 6px; }
.sqlbox { flex: 1; min-width: 0; height: 90px; font-family: Consolas, monospace; font-size: 12.5px; padding: 6px; border: 1px solid #d0d5dd; border-radius: 4px; resize: vertical; }
</style>
