<template>
  <div v-if="script" class="toolbar" style="margin-bottom:6px">
    <DxButton :text="`Скрипт исправлений (${count})`" icon="code" styling-mode="outlined" @click="show = !show" />
    <DxButton text="Копировать" icon="copy" styling-mode="text" @click="copy" />
    <DxButton text="Открыть в SQL-консоли" icon="activefolder" styling-mode="text" @click="toConsole" />
    <span class="hint">Проверьте скрипт перед выполнением: удаление индексов и изменения структуры лучше делать в нерабочее время.</span>
  </div>
  <pre v-if="show && script" class="cmd" style="max-height:300px;overflow:auto">{{ script }}</pre>
</template>

<script setup>
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { DxButton } from 'devextreme-vue/button';
import { toast } from '../api';

const props = defineProps({ items: Array });
const show = ref(false);
const router = useRouter();
const withSql = computed(() => (props.items || []).filter(x => x.sql));
const count = computed(() => withSql.value.length);
const script = computed(() => withSql.value.map(x => `-- ${(x.text || '').split('\n')[0].slice(0, 150)}\n${x.sql.trim().endsWith(';') ? x.sql.trim() : x.sql.trim() + ';'}`).join('\n\n'));
async function copy() { await navigator.clipboard.writeText(script.value).catch(() => {}); toast('Скрипт скопирован'); }
function toConsole() { localStorage.setItem('dbcompare.sql.pending', script.value); router.push('/sql'); }
</script>
