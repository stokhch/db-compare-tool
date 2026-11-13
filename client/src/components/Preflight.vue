<template>
  <div v-if="visible || loading" class="panel preflight">
    <div class="toolbar" style="margin-bottom:6px">
      <b>Проверка перед запуском</b>
      <span v-if="loading" class="hint">проверяю базы и параметры…</span>
      <span v-else-if="!issues.length" class="ok">препятствий не найдено</span>
      <span v-else class="hint">ошибок {{ count('error') }}, предупреждений {{ count('warning') }}</span>
      <span style="flex:1" />
      <span v-for="f in facts" :key="f.label" class="chip">{{ f.label }}: <b>{{ f.value }}</b></span>
      <DxButton icon="close" styling-mode="text" hint="Скрыть" @click="visible = false" />
    </div>
    <div v-for="i in issues" :key="i.id" class="issue" :class="i.level">
      <div class="issue-title"><span class="dot">●</span> {{ i.title }}</div>
      <div v-if="i.details" class="issue-details">{{ i.details }}</div>
      <pre v-if="i.sql" class="cmd">{{ i.sql }}</pre>
      <details v-if="i.list && i.list.length"><summary>Список ({{ i.list.length }})</summary><div class="mono" style="max-height:160px;overflow:auto;white-space:pre-wrap">{{ i.list.join('\n') }}</div></details>
      <template v-if="i.fixes && i.fixes.length">
        <DxRadioGroup v-if="i.choice" :items="i.fixes" value-expr="id" display-expr="title" :value="selection[i.id]" @value-changed="e => (selection[i.id] = e.value)" />
        <template v-else>
          <DxCheckBox v-for="f in i.fixes" :key="f.id" :text="f.title" :value="(selection[i.id] || []).includes(f.id)" style="display:block;margin:2px 0"
            @value-changed="e => toggle(i, f, e.value)" />
        </template>
        <template v-for="f in i.fixes" :key="'in' + f.id">
          <div v-if="f.input && isOn(i, f)" class="field" style="width:300px;margin:6px 0 0 24px"><label>{{ f.input.label }}</label>
            <DxTextBox v-model:value="inputs[`${i.id}/${f.id}`]" /></div>
          <div v-if="f.danger && isOn(i, f)" class="error" style="margin:4px 0 0 24px">Необратимое действие — будет запрошено подтверждение.</div>
        </template>
      </template>
      <div v-else-if="i.blocking" class="error" style="margin-top:4px">Автоматического исправления нет — устраните причину и проверьте заново.</div>
    </div>
    <div v-if="!loading" class="toolbar" style="margin-top:8px">
      <DxButton :text="runText" icon="runner" type="default" :disabled="unresolved.length > 0" @click="emit('run')" />
      <DxButton text="Проверить заново" icon="refresh" styling-mode="outlined" @click="recheck" />
      <span v-if="unresolved.length" class="error">Нужно решить: {{ unresolved.join('; ') }}</span>
      <span v-else-if="issues.length" class="hint">Выбранные исправления будут применены при запуске.</span>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue';
import { DxButton } from 'devextreme-vue/button';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { DxRadioGroup } from 'devextreme-vue/radio-group';
import { DxTextBox } from 'devextreme-vue/text-box';
import { confirm } from 'devextreme/ui/dialog';
import { api, safe, toast } from '../api';

const props = defineProps({ type: String, runText: { type: String, default: 'Запустить с исправлениями' } });
const emit = defineEmits(['run']);
const issues = ref([]), facts = ref([]);
const selection = reactive({}), inputs = reactive({});
const visible = ref(false), loading = ref(false);
let lastKey = null, reviewed = false, lastParams = null;

const count = l => issues.value.filter(i => i.level === l).length;
const isOn = (i, f) => (i.choice ? selection[i.id] === f.id : (selection[i.id] || []).includes(f.id));
function toggle(i, f, on) { const s = new Set(selection[i.id] || []); if (on) s.add(f.id); else s.delete(f.id); selection[i.id] = [...s]; }
const unresolved = computed(() => issues.value.filter(i => (i.required || i.blocking) && !(i.choice ? selection[i.id] : (selection[i.id] || []).length)).map(i => i.title));

async function load(params) {
  loading.value = true; visible.value = true;
  try {
    const r = await safe(() => api.post(`/preflight/${props.type}`, { params }));
    if (!r) return false;
    issues.value = r.issues || []; facts.value = r.facts || [];
    for (const k of Object.keys(selection)) delete selection[k];
    for (const k of Object.keys(inputs)) delete inputs[k];
    for (const i of issues.value) {
      const d = (i.fixes || []).filter(f => f.default).map(f => f.id);
      selection[i.id] = i.choice ? d[0] || null : d;
      for (const f of i.fixes || []) if (f.input) inputs[`${i.id}/${f.id}`] = f.input.value;
    }
    return true;
  } finally { loading.value = false; }
}

/**
 * Перед запуском: проверить (если параметры изменились) и вернуть итоговые параметры с исправлениями.
 * null — нужно внимание пользователя (панель показана); повторный вызов после выбора вернёт параметры.
 */
async function gate(params) {
  const key = JSON.stringify(params);
  lastParams = params;
  if (key !== lastKey) {
    if (!(await load(params))) return null;
    lastKey = key; reviewed = false;
  }
  const serious = issues.value.some(i => i.level !== 'info');
  if ((serious && !reviewed) || unresolved.value.length) { reviewed = true; visible.value = true; return null; }
  const r = await safe(() => api.post('/preflight-apply', { params, issues: issues.value, selection: { ...selection }, inputs: { ...inputs } }));
  if (!r) return null;
  if (r.unresolved.length) { visible.value = true; return null; }
  const danger = r.chosen.filter(c => c.danger);
  if (danger.length && !(await confirm(`<div>Будут выполнены необратимые действия:</div><ul>${danger.map(c => `<li>${c.title}</li>`).join('')}</ul><div>Продолжить?</div>`, 'Подтверждение'))) return null;
  if (r.chosen.length) toast(`Применено исправлений: ${r.chosen.length}`, 'info');
  visible.value = false; lastKey = null;
  return r.params;
}
async function recheck() { if (lastParams) { lastKey = null; await load(lastParams); lastKey = JSON.stringify(lastParams); reviewed = true; } }
function reset() { lastKey = null; visible.value = false; issues.value = []; }
defineExpose({ gate, reset });
</script>

<style scoped>
.preflight { border: 1px solid #d0d5dd; }
.chip { background: #f2f4f7; border-radius: 10px; padding: 2px 8px; font-size: 12px; }
.issue { border-left: 4px solid #98a2b3; background: #f9fafb; padding: 8px 12px; margin-bottom: 8px; border-radius: 4px; }
.issue.error { border-color: #d92d20; background: #fef3f2; }
.issue.warning { border-color: #dc6803; background: #fffaeb; }
.issue.info { border-color: #1570ef; background: #eff8ff; }
.issue-title { font-weight: 600; margin-bottom: 2px; }
.issue.error .dot { color: #d92d20; } .issue.warning .dot { color: #dc6803; } .issue.info .dot { color: #1570ef; }
.issue-details { margin-bottom: 6px; white-space: pre-wrap; }
</style>
