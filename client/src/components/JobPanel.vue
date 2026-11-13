<template>
  <div v-if="job" class="panel">
    <div class="toolbar">
      <b>{{ job.title }}</b>
      <span :class="statusClass">{{ STATUS[job.status] || job.status }}</span>
      <span v-if="job.status === 'running'" class="hint">{{ job.progress && job.progress.message }}</span>
      <span style="flex:1" />
      <DxButton v-if="job.status === 'running'" text="Отменить" icon="close" styling-mode="outlined" @click="cancel" />
      <a v-if="job.status !== 'running' && report" :href="`/api/jobs/${job.id}/report.html`" target="_blank">HTML-отчёт</a>
      <a :href="`/api/jobs/${job.id}/log.txt`" target="_blank">Журнал</a>
      <a v-if="job.status !== 'running'" :href="`/api/jobs/${job.id}/result.json`">JSON</a>
      <DxButton :text="showLog ? 'Скрыть журнал' : 'Показать журнал'" styling-mode="text" @click="showLog = !showLog" />
    </div>
    <DxProgressBar v-if="job.status === 'running'" :min="0" :max="pTotal || 100" :value="pTotal ? job.progress.current : undefined"
      :show-status="!!pTotal" :status-format="r => `${Math.round(r * 100)}%`" />
    <div v-if="job.error" class="error" style="margin:8px 0;white-space:pre-wrap">{{ job.error }}</div>

    <!-- разбор ошибок и повтор -->
    <div v-if="diag && diag.groups.length" class="diag">
      <div class="toolbar" style="margin-bottom:4px"><b>Что пошло не так</b><span class="hint">— ошибки сгруппированы, к каждой подсказка</span></div>
      <div v-for="g in diag.groups" :key="g.id" class="dg">
        <div><b>{{ g.title }}</b> <span class="hint">× {{ g.count }}</span></div>
        <div v-if="g.hint">{{ g.hint }}</div>
        <details><summary>Примеры</summary><div v-for="(s, k) in g.samples" :key="k" class="mono">{{ s }}</div></details>
      </div>
      <div v-if="diag.fixes.length" style="margin-top:6px">
        <DxCheckBox v-for="f in diag.fixes" :key="f.id" :text="f.title + (f.danger ? ' (необратимо)' : '')" :value="fixSel.includes(f.id)" style="display:block;margin:2px 0"
          @value-changed="e => (fixSel = e.value ? [...fixSel, f.id] : fixSel.filter(x => x !== f.id))" />
      </div>
      <div class="toolbar" style="margin-top:6px">
        <DxButton :text="diag.fixes.length ? 'Повторить с исправлениями' : 'Повторить'" icon="refresh" type="default" @click="retry" />
        <span v-if="retryInfo" class="hint">{{ retryInfo }}</span>
      </div>
      <Preflight v-if="retryType" ref="pf" :type="retryType" run-text="Запустить повтор" @run="retryRun" />
    </div>
    <div v-if="showLog" ref="logEl" class="log"><div v-for="(l, i) in job.log" :key="i" :class="l.level">{{ l.t.slice(11, 19) }} {{ l.msg }}</div></div>
  </div>
</template>

<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { DxButton } from 'devextreme-vue/button';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { DxProgressBar } from 'devextreme-vue/progress-bar';
import { confirm } from 'devextreme/ui/dialog';
import Preflight from './Preflight.vue';
import { api, safe, STATUS } from '../api';

const props = defineProps({ jobId: String, report: { type: Boolean, default: true }, logOpen: { type: Boolean, default: false } });
const emit = defineEmits(['done', 'update']);
const job = ref(null);
const cur = ref(props.jobId);
const showLog = ref(props.logOpen);
const logEl = ref(null);
const diag = ref(null), fixSel = ref([]), retryType = ref(null), retryInfo = ref(''), pf = ref(null);
let retryParams = null;
let timer = null;

const pTotal = computed(() => (job.value && job.value.progress && job.value.progress.total) || 0);
const statusClass = computed(() => ({ done: 'ok', error: 'error', cancelled: 'warning', running: 'warning' }[job.value && job.value.status]));

async function poll() {
  if (!cur.value) return;
  try {
    const j = await api.get(`/jobs/${cur.value}`);
    job.value = j;
    emit('update', j);
    if (showLog.value) nextTick(() => { if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight; });
    if (j.status !== 'running') {
      stop();
      const full = await api.get(`/jobs/${cur.value}?full=1`);
      job.value = { ...full, log: full.log.slice(-500) };
      emit('done', full);
      if (j.status !== 'cancelled') {
        const d = await api.get(`/jobs/${cur.value}/diagnose`).catch(() => null);
        if (d && d.groups.length) { diag.value = d; fixSel.value = d.fixes.filter(f => !f.danger).map(f => f.id); }
      }
      return;
    }
  } catch { /* сервер перезапущен */ }
  timer = setTimeout(poll, 1000);
}
function stop() { if (timer) clearTimeout(timer); timer = null; }
async function cancel() { await safe(() => api.post(`/jobs/${cur.value}/cancel`)); }

async function retry() {
  const danger = diag.value.fixes.filter(f => f.danger && fixSel.value.includes(f.id));
  if (danger.length && !(await confirm(`<ul>${danger.map(f => `<li>${f.title}</li>`).join('')}</ul><div>Продолжить?</div>`, 'Подтверждение'))) return;
  const r = await safe(() => api.post(`/jobs/${cur.value}/retry`, { fixes: fixSel.value }));
  if (!r) return;
  retryParams = r.params;
  if (r.preflight) {
    retryType.value = r.type;
    retryInfo.value = 'Перед повтором — проверка с учётом исправлений…';
    await nextTick();
    return retryRun();
  }
  start(r.type, r.params);
}
async function retryRun() {
  const p = await pf.value.gate(retryParams);
  if (p) start(retryType.value, p); else retryInfo.value = 'Проверьте предложения ниже и запустите повтор.';
}
async function start(type, params) {
  const j = await safe(() => api.post(`/jobs/${type}`, params));
  if (!j) return;
  diag.value = null; retryType.value = null; retryInfo.value = '';
  cur.value = j.id; job.value = null; poll();
}

watch(() => props.jobId, id => { stop(); job.value = null; diag.value = null; retryType.value = null; cur.value = id; if (id) poll(); }, { immediate: true });
onUnmounted(stop);
</script>

<style scoped>
.diag { border: 1px solid #fda29b; background: #fffbfa; border-radius: 6px; padding: 8px 12px; margin: 8px 0; }
.dg { margin: 6px 0; padding-left: 8px; border-left: 3px solid #fda29b; }
</style>
