<template>
  <div class="panel" style="background:#fafbfc;margin-bottom:12px">
    <div class="toolbar" style="margin:0">
      <DxCheckBox :value="state.enabled" text="Фильтр периода и пользователя" @value-changed="e => set({ enabled: e.value })" />
      <template v-if="state.enabled">
        <DxDateBox :value="state.from" type="date" display-format="dd.MM.yyyy" date-serialization-format="yyyy-MM-dd" :width="140" placeholder="с" @value-changed="e => set({ from: e.value })" />
        <span>—</span>
        <DxDateBox :value="state.to" type="date" display-format="dd.MM.yyyy" date-serialization-format="yyyy-MM-dd" :width="140" placeholder="по" @value-changed="e => set({ to: e.value })" />
        <DxButton text="месяц" styling-mode="text" @click="month" hint="Весь месяц по дате «с»" />
        <span class="hint">{{ summary }}</span>
        <span style="flex:1" />
        <DxButton :text="more ? 'Скрыть настройки' : 'Колонки…'" styling-mode="text" @click="more = !more" />
      </template>
    </div>
    <div v-if="state.enabled && more" class="row" style="margin-top:8px">
      <div class="field" style="width:130px"><label>Начало периода</label><DxTextBox :value="state.startColumn" @value-changed="e => set({ startColumn: e.value })" /></div>
      <div class="field" style="width:130px"><label>Конец периода</label><DxTextBox :value="state.endColumn" @value-changed="e => set({ endColumn: e.value })" /></div>
      <div class="field" style="width:170px"><label>Совпадение периода</label>
        <DxSelectBox :value="state.periodMatch" :items="[{ v: 'exact', t: 'точно (d_beg = с, d_end = по)' }, { v: 'overlap', t: 'пересекается' }]" value-expr="v" display-expr="t" @value-changed="e => set({ periodMatch: e.value })" /></div>
      <div class="field" style="width:180px"><label>Дневные даты (через запятую)</label><DxTextBox :value="state.dayColumns" @value-changed="e => set({ dayColumns: e.value })" /></div>
      <div class="field" style="width:200px"><label>Прогноз</label>
        <div class="toolbar" style="margin:0"><DxTextBox :value="state.prognozColumn" :width="90" @value-changed="e => set({ prognozColumn: e.value })" /><DxCheckBox :value="state.onlyFact" text="только факт (=0)" @value-changed="e => set({ onlyFact: e.value })" /></div></div>
      <div class="field" style="width:110px"><label>Пользователь</label><DxTextBox :value="state.userColumn" @value-changed="e => set({ userColumn: e.value })" /></div>
      <div class="field" style="width:240px"><label>Значение пользователя</label>
        <DxSelectBox :value="state.userMode" :items="[{ v: 'none', t: 'не фильтровать' }, { v: 'session', t: 'текущий (USER / upper(current_user))' }, { v: 'value', t: 'указать' }]" value-expr="v" display-expr="t" @value-changed="e => set({ userMode: e.value })" /></div>
      <template v-if="state.userMode === 'value'">
        <div class="field" style="width:140px"><label>в источнике</label><DxTextBox :value="state.userSource" @value-changed="e => set({ userSource: e.value })" /></div>
        <div class="field" style="width:140px"><label>в приёмнике (пусто — то же)</label><DxTextBox :value="state.userTarget" @value-changed="e => set({ userTarget: e.value })" /></div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { DxDateBox } from 'devextreme-vue/date-box';
import { DxTextBox } from 'devextreme-vue/text-box';
import { DxSelectBox } from 'devextreme-vue/select-box';
import { DxButton } from 'devextreme-vue/button';

// v-model: объект period для сервера или null, если фильтр выключен
const emit = defineEmits(['update:modelValue']);
const KEY = 'dbcompare.period';
const defaults = { enabled: false, from: '', to: '', startColumn: 'd_beg', endColumn: 'd_end', periodMatch: 'exact', dayColumns: 'sv_date', prognozColumn: 'prognoz', onlyFact: true, userColumn: 'u_m', userMode: 'none', userSource: '', userTarget: '' };
let saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* */ }
const state = reactive({ ...defaults, ...saved });
const more = ref(false);
function set(patch) { Object.assign(state, patch); }
function month() {
  if (!state.from) return;
  const [y, m] = state.from.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  set({ from: `${y}-${String(m).padStart(2, '0')}-01`, to: `${y}-${String(m).padStart(2, '0')}-${last}` });
}
const value = computed(() => {
  if (!state.enabled) return null;
  const { enabled, ...p } = state;
  return p;
});
const summary = computed(() => {
  const parts = [];
  if (state.startColumn && state.endColumn) parts.push(`${state.startColumn}/${state.endColumn}`);
  if (state.dayColumns) parts.push(state.dayColumns);
  if (state.onlyFact && state.prognozColumn) parts.push(`${state.prognozColumn}=0`);
  if (state.userMode !== 'none') parts.push(`${state.userColumn} = ${state.userMode === 'session' ? 'текущий' : state.userSource}`);
  return `применяется к таблицам, где есть: ${parts.join(', ')}`;
});
watch(state, () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* */ } emit('update:modelValue', value.value); }, { deep: true, immediate: true });
</script>
