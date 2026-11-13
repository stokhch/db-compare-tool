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
    <div v-if="job.error" class="error" style="margin:8px 0">{{ job.error }}</div>
    <div v-if="showLog" ref="logEl" class="log"><div v-for="(l, i) in job.log" :key="i" :class="l.level">{{ l.t.slice(11, 19) }} {{ l.msg }}</div></div>
  </div>
</template>

<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { DxButton } from 'devextreme-vue/button';
import { DxProgressBar } from 'devextreme-vue/progress-bar';
import { api, safe, STATUS } from '../api';

const props = defineProps({ jobId: String, report: { type: Boolean, default: true }, logOpen: { type: Boolean, default: false } });
const emit = defineEmits(['done', 'update']);
const job = ref(null);
const showLog = ref(props.logOpen);
const logEl = ref(null);
let timer = null;

const pTotal = computed(() => (job.value && job.value.progress && job.value.progress.total) || 0);
const statusClass = computed(() => ({ done: 'ok', error: 'error', cancelled: 'warning', running: 'warning' }[job.value && job.value.status]));

async function poll() {
  if (!props.jobId) return;
  try {
    const j = await api.get(`/jobs/${props.jobId}`);
    job.value = j;
    emit('update', j);
    if (showLog.value) nextTick(() => { if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight; });
    if (j.status !== 'running') {
      stop();
      const full = await api.get(`/jobs/${props.jobId}?full=1`);
      job.value = { ...full, log: full.log.slice(-500) };
      emit('done', full);
      return;
    }
  } catch { /* сервер перезапущен */ }
  timer = setTimeout(poll, 1000);
}
function stop() { if (timer) clearTimeout(timer); timer = null; }
async function cancel() { await safe(() => api.post(`/jobs/${props.jobId}/cancel`)); }

watch(() => props.jobId, id => { stop(); job.value = null; if (id) poll(); }, { immediate: true });
onUnmounted(stop);
</script>
