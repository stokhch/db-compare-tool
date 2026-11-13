<template>
  <DxSelectBox :items="items" display-expr="text" value-expr="id" :value="modelValue" placeholder="Выберите базу…"
    :search-enabled="true" @value-changed="e => emit('update:modelValue', e.value)" />
</template>

<script setup>
import { computed } from 'vue';
import { DxSelectBox } from 'devextreme-vue/select-box';
import { connections } from '../store';

const props = defineProps({ modelValue: String, only: { type: String, default: '' } });
const emit = defineEmits(['update:modelValue']);
const items = computed(() => connections.value.filter(c => !props.only || c.type === props.only)
  .map(c => ({ id: c.id, text: `${c.name} — ${c.host}:${c.port}/${c.database}` })));
</script>
