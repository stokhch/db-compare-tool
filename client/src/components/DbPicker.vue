<template>
  <div class="col">
    <div class="field">
      <label>{{ label }} — подключение</label>
      <DxSelectBox :items="items" display-expr="text" value-expr="id" :value="modelValue.connId"
        placeholder="Выберите базу…" :search-enabled="true" @value-changed="onConn" />
    </div>
    <div class="field">
      <label>{{ label }} — схема</label>
      <DxSelectBox :items="schemas" :value="modelValue.schema" :search-enabled="true" :accept-custom-value="true"
        :disabled="!modelValue.connId" placeholder="Схема" @value-changed="e => emitVal({ schema: e.value })"
        @custom-item-creating="e => { e.customItem = e.text; }" />
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { DxSelectBox } from 'devextreme-vue/select-box';
import { api, safe } from '../api';
import { connections } from '../store';

const props = defineProps({
  modelValue: { type: Object, required: true },
  label: { type: String, default: 'База' },
  only: { type: String, default: '' }, // 'oracle' | 'postgres'
});
const emit = defineEmits(['update:modelValue']);
const schemas = ref([]);
const items = computed(() => connections.value
  .filter(c => !props.only || c.type === props.only)
  .map(c => ({ id: c.id, text: `${c.type === 'oracle' ? '🟥 Oracle' : '🟦 PG'} · ${c.name}`, schema: c.schema, type: c.type })));

function emitVal(patch) { emit('update:modelValue', { ...props.modelValue, ...patch }); }

async function loadSchemas(id) {
  schemas.value = [];
  if (!id) return;
  const r = await safe(() => api.get(`/connections/${id}/schemas`));
  if (r) schemas.value = r;
}
function onConn(e) {
  if (e.value === props.modelValue.connId) return;
  const c = items.value.find(x => x.id === e.value);
  const def = c ? (c.schema || '') : '';
  emitVal({ connId: e.value, schema: c && c.type === 'oracle' ? def.toUpperCase() : def, type: c && c.type });
}
watch(() => props.modelValue.connId, id => loadSchemas(id), { immediate: true });
</script>
