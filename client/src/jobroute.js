import { watch } from 'vue';
import { useRoute } from 'vue-router';
import { api, safe } from './api';

// Открыть результат задачи из раздела «Задачи» (?job=<id>)
export function useJobFromRoute(types, onJob) {
  const route = useRoute();
  watch(() => route.query.job, async id => {
    if (!id) return;
    const j = await safe(() => api.get(`/jobs/${id}?full=1`));
    if (j && types.includes(j.type)) onJob(j);
  }, { immediate: true });
}
