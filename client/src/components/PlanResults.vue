<template>
  <div class="panel">
    <div class="cards">
      <div class="card"><div class="v">{{ result.summary.queries }}</div><div class="l">запросов</div></div>
      <div class="card"><div class="v" :class="result.summary.slower ? 'error' : 'ok'">{{ result.summary.slower }}</div><div class="l">медленнее в 2+ раза</div></div>
      <div class="card"><div class="v" :class="result.summary.warning ? 'warning' : 'ok'">{{ result.summary.warning }}</div><div class="l">с замечаниями к плану</div></div>
      <div class="card"><div class="v" :class="result.summary.error ? 'error' : 'ok'">{{ result.summary.error }}</div><div class="l">ошибок</div></div>
    </div>
    <div v-for="(q, i) in result.results" :key="i" class="q">
      <div class="toolbar"><b>{{ q.title }}</b>
        <span :class="{ ok: 'ok', slower: 'error', warning: 'warning', error: 'error' }[q.status]">{{ { ok: 'нормально', slower: 'медленнее', warning: 'есть замечания', error: 'ошибка' }[q.status] }}</span>
        <span class="hint">{{ ms(q.source) }}{{ q.target ? ` → ${ms(q.target)}` : '' }}{{ q.ratio ? ` (×${q.ratio.toFixed(2)})` : '' }}</span></div>
      <div v-for="(f, k) in q.findings" :key="k" :class="['finding', f.level]">
        <span class="hint">{{ f.side }}:</span> {{ f.text }}
        <pre v-if="f.sql" class="cmd">{{ f.sql }}</pre>
      </div>
      <details><summary>Планы выполнения</summary>
        <div class="row">
          <div class="col" style="min-width:0"><b>Источник{{ q.source.actual ? ' (фактическая статистика)' : '' }}</b><pre class="plan">{{ q.source.error || q.source.plan }}</pre></div>
          <div v-if="q.target" class="col" style="min-width:0"><b>Приёмник</b><pre class="plan">{{ q.target.error || q.target.plan }}</pre></div>
        </div>
      </details>
    </div>
  </div>
</template>

<script setup>
defineProps({ result: Object });
const ms = s => (!s || s.error ? 'ошибка' : s.ms != null ? `${s.ms.toFixed(1)} мс` : '—');
</script>

<style scoped>
.q { border-top: 1px solid #e4e7ec; padding: 8px 0; }
.finding { margin: 4px 0; padding-left: 8px; border-left: 3px solid #98a2b3; }
.finding.warning { border-color: #dc6803; } .finding.error { border-color: #d92d20; } .finding.info { border-color: #1570ef; }
.plan { font-size: 11.5px; background: #f9fafb; border: 1px solid #e4e7ec; padding: 6px; overflow: auto; max-height: 420px; white-space: pre; }
</style>
