<template>
  <div>
    <h2 class="page">Регламентные проверки</h2>
    <div class="panel">
      <p class="hint" style="margin-top:0">Наборы проверок на период параллельной работы Oracle и PostgreSQL. Проверки добавляются кнопкой «В регламент» на экранах
        сравнения схем, данных, запросов, расчётов, агрегатов и профиля. Набор запускается вручную, по расписанию (пока приложение запущено)
        или из Планировщика заданий Windows командой ниже. Итог сравнивается с прошлым запуском; при расхождениях можно получать уведомление (webhook).</p>
      <div class="toolbar">
        <DxButton text="Новый набор" icon="add" type="default" @click="edit()" />
        <DxButton text="Обновить" icon="refresh" styling-mode="outlined" @click="load" />
      </div>
      <DxDataGrid :data-source="suites" key-expr="id" :show-borders="true" :focused-row-enabled="true" :focused-row-key="currentId" @row-click="e => select(e.data.id)" no-data-text="Наборов пока нет">
        <DxColumn data-field="name" caption="Набор" />
        <DxColumn caption="Проверок" :calculate-cell-value="r => (r.checks || []).length" :width="100" />
        <DxColumn data-field="schedule" caption="Расписание (cron)" :calculate-display-value="r => r.schedule ? `${r.schedule}${r.enabled ? '' : ' (выкл.)'}` : 'вручную'" />
        <DxColumn caption="Уведомления" :calculate-cell-value="r => r.webhook ? 'webhook' : ''" :width="120" />
        <DxColumn caption="" cell-template="act" :width="230" />
        <template #act="{ data }">
          <DxButton text="Запустить" icon="runner" styling-mode="text" @click.stop="runSuite(data.data)" />
          <DxButton icon="edit" styling-mode="text" @click.stop="edit(data.data)" />
          <DxButton icon="trash" styling-mode="text" @click.stop="remove(data.data)" />
        </template>
      </DxDataGrid>
    </div>

    <JobPanel v-if="jobId" :job-id="jobId" :report="false" @done="onRunDone" />

    <div v-if="current" class="panel">
      <h3>Проверки набора «{{ current.name }}»</h3>
      <DxDataGrid :data-source="current.checks || []" key-expr="id" :show-borders="true" no-data-text="Добавьте проверки кнопкой «В регламент» на экранах сравнения">
        <DxColumn caption="Проверка" :calculate-cell-value="r => r.title || TYPES[r.type] || r.type" />
        <DxColumn data-field="type" caption="Тип" :calculate-display-value="r => TYPES[r.type] || r.type" :width="160" />
        <DxColumn caption="Базы" :calculate-cell-value="dbs" />
        <DxColumn caption="Вкл." cell-template="en" :width="70" />
        <DxColumn caption="" cell-template="del" :width="60" />
        <template #en="{ data }"><DxCheckBox :value="data.data.enabled !== false" @value-changed="e => toggle(data.data, e.value)" /></template>
        <template #del="{ data }"><DxButton icon="trash" styling-mode="text" @click="removeCheck(data.data)" /></template>
      </DxDataGrid>
      <h3 style="margin-top:14px">Запуск из Планировщика заданий Windows</h3>
      <pre class="cmd">cd /d "{{ appDir }}"
node server\cli.js suite "{{ current.name }}"</pre>
      <div class="hint">Код возврата: 0 — всё совпадает, 1 — есть расхождения, 2 — ошибка. Создать задание:
        <span class="mono">schtasks /create /tn "DB Compare — {{ current.name }}" /sc daily /st 07:00 /tr "cmd /c cd /d \"{{ appDir }}\" &amp;&amp; node server\cli.js suite \"{{ current.name }}\""</span></div>
      <h3 style="margin-top:14px">История запусков</h3>
      <DxDataGrid :data-source="runs" :show-borders="true" :word-wrap-enabled="true" no-data-text="Запусков ещё не было">
        <DxColumn data-field="finishedAt" caption="Завершён" data-type="datetime" format="dd.MM.yyyy HH:mm" :width="150" />
        <DxColumn data-field="status" caption="Итог" cell-template="st" :width="150" />
        <DxColumn data-field="trigger" caption="Запуск" :calculate-display-value="r => ({ manual: 'вручную', schedule: 'по расписанию', cli: 'командная строка' }[r.trigger] || r.trigger)" :width="140" />
        <DxColumn caption="Проверки" cell-template="checks" />
        <template #st="{ data }"><span :class="{ ok: 'ok', warn: 'warning', fail: 'error' }[data.value]">{{ { ok: 'всё совпадает', warn: 'предупреждения', fail: 'расхождения' }[data.value] }}</span></template>
        <template #checks="{ data }"><div v-for="c in data.data.checks" :key="c.id"><span :class="{ ok: 'ok', warn: 'warning', fail: 'error', error: 'error' }[c.status]">●</span> {{ c.title }}: {{ c.text }} <b v-if="c.change">({{ c.change }})</b></div></template>
      </DxDataGrid>
    </div>

    <DxPopup v-model:visible="ed.visible" :title="ed.s.id ? 'Набор проверок' : 'Новый набор проверок'" :width="620" height="auto" :show-close-button="true">
      <div>
        <div class="field"><label>Название</label><DxTextBox v-model:value="ed.s.name" /></div>
        <div class="row">
          <div class="field" style="flex:1"><label>Расписание (cron: минута час день месяц день_недели)</label>
            <DxTextBox v-model:value="ed.s.schedule" placeholder="0 7 * * 1-5 — по будням в 7:00" /></div>
          <div class="field" style="width:200px"><label>Шаблон</label>
            <DxSelectBox :items="presets" value-expr="v" display-expr="t" placeholder="выбрать…" @value-changed="e => e.value && (ed.s.schedule = e.value)" /></div>
        </div>
        <DxCheckBox v-model:value="ed.s.enabled" text="Запускать по расписанию (пока приложение запущено)" />
        <div class="field" style="margin-top:10px"><label>Webhook для уведомлений (Teams, Slack, Mattermost — JSON с полем text)</label>
          <DxTextBox v-model:value="ed.s.webhook" placeholder="https://… (необязательно)" /></div>
        <DxCheckBox v-model:value="ed.s.notifyAlways" text="Уведомлять и когда всё совпадает" />
        <div class="toolbar" style="justify-content:flex-end;margin-top:10px"><DxButton text="Сохранить" type="default" icon="save" @click="saveSuite" /></div>
      </div>
    </DxPopup>
  </div>
</template>

<script setup>
import { onActivated, onMounted, reactive, ref, computed } from 'vue';
import { DxButton } from 'devextreme-vue/button';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { DxSelectBox } from 'devextreme-vue/select-box';
import { DxTextBox } from 'devextreme-vue/text-box';
import { DxPopup } from 'devextreme-vue/popup';
import { DxDataGrid, DxColumn } from 'devextreme-vue/data-grid';
import { confirm } from 'devextreme/ui/dialog';
import JobPanel from '../components/JobPanel.vue';
import { api, safe, toast } from '../api';
import { connName } from '../store';

const TYPES = { 'schema-compare': 'Структура', 'data-compare': 'Данные', 'agg-compare': 'Агрегаты', 'query-compare': 'Запросы', 'calc-verify': 'Расчёты', profile: 'Профиль данных', readiness: 'Готовность данных', 'unit-tests': 'Юнит-тесты', 'deps-check': 'Зависимости', health: 'Аудит здоровья', 'index-advice': 'Индексы', 'plan-compare': 'Планы запросов', backup: 'Резервная копия', 'schema-snapshot': 'Снимок схемы' };
const presets = [
  { v: '0 7 * * 1-5', t: 'по будням в 7:00' }, { v: '0 2 * * *', t: 'каждую ночь в 2:00' },
  { v: '0 * * * *', t: 'каждый час' }, { v: '*/30 * * * *', t: 'каждые 30 минут' }, { v: '0 8 * * 1', t: 'по понедельникам в 8:00' },
];
const suites = ref([]);
const currentId = ref(null);
const runs = ref([]);
const jobId = ref(null);
const appDir = ref('');
const ed = reactive({ visible: false, s: {} });
const current = computed(() => suites.value.find(s => s.id === currentId.value));
const dbs = r => {
  const p = r.params || {};
  return `${connName(p.sourceId) || '?'}/${p.sourceSchema || ''}${p.targetId ? ` ⇄ ${connName(p.targetId)}/${p.targetSchema || ''}` : ''}`;
};

async function load() {
  suites.value = (await safe(() => api.get('/saved/suites'))) || [];
  if (!currentId.value && suites.value[0]) select(suites.value[0].id);
  else if (currentId.value) loadRuns();
  const st = await safe(() => api.get('/settings'));
  if (st && st.appDir) appDir.value = st.appDir;
}
async function select(id) { currentId.value = id; await loadRuns(); }
async function loadRuns() { runs.value = currentId.value ? ((await safe(() => api.get(`/suites/${currentId.value}/runs`))) || []) : []; }
function edit(s) { ed.s = s ? { ...s } : { name: '', schedule: '', enabled: false, webhook: '', notifyAlways: false, checks: [] }; ed.visible = true; }
async function saveSuite() {
  if (!ed.s.name) return toast('Введите название', 'warning');
  const r = await safe(() => api.post('/saved/suites', ed.s));
  if (r) { ed.visible = false; await load(); select(r.id); }
}
async function remove(s) {
  if (!(await confirm(`Удалить набор «${s.name}»?`, 'Подтверждение'))) return;
  await safe(() => api.del(`/saved/suites/${s.id}`));
  if (currentId.value === s.id) currentId.value = null;
  load();
}
async function toggle(c, en) {
  const s = { ...current.value, checks: current.value.checks.map(x => (x.id === c.id ? { ...x, enabled: en } : x)) };
  if (await safe(() => api.post('/saved/suites', s))) load();
}
async function removeCheck(c) {
  const s = { ...current.value, checks: current.value.checks.filter(x => x.id !== c.id) };
  if (await safe(() => api.post('/saved/suites', s))) load();
}
async function runSuite(s) {
  select(s.id);
  const j = await safe(() => api.post('/jobs/suite', { suiteId: s.id, suiteName: s.name, trigger: 'manual' }));
  if (j) jobId.value = j.id;
}
function onRunDone() { loadRuns(); }
onMounted(load);
onActivated(load);
</script>
