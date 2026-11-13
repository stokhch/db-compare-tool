<template>
  <div>
    <div class="toolbar">
      <DxButton text="Загрузить объекты" icon="refresh" styling-mode="outlined" :disabled="!connId || !schema" @click="load" />
      <template v-if="objects.length">
        <span class="hint">Объектов: {{ objects.length }}, выбрано: <b>{{ modelValue.length }}</b></span>
        <span style="flex:1" />
        <DxSelectBox v-model:value="direction" :items="directions" value-expr="v" display-expr="t" :width="260" />
        <DxCheckBox v-model:value="recursive" text="рекурсивно" />
        <DxButton text="Добавить связанные" icon="link" type="default" styling-mode="outlined" :disabled="!modelValue.length" @click="addRelated" />
        <DxButton text="Очистить" icon="clear" styling-mode="text" @click="emitKeys([])" />
        <DxCheckBox v-model:value="onlySelected" text="только выбранные" />
      </template>
    </div>
    <DxDataGrid v-if="objects.length" ref="grid" :data-source="visible" key-expr="key" :show-borders="true" :height="height"
      :selected-row-keys="[...selectedKeys]" @selection-changed="onSelection">
      <DxSelection mode="multiple" show-check-boxes-mode="always" select-all-mode="allPages" />
      <DxSearchPanel :visible="true" :width="300" placeholder="Фильтр по подстроке в имени…" :search-visible-columns-only="true" />
      <DxFilterRow :visible="true" />
      <DxScrolling mode="virtual" />
      <DxColumn data-field="typeName" caption="Тип" :width="170" />
      <DxColumn data-field="name" caption="Имя" css-class="mono" />
      <DxColumn data-field="links" caption="Связи" :allow-search="false" />
    </DxDataGrid>
    <div v-if="objects.length" class="hint" style="margin-top:4px">
      Фильтр работает по подстроке в имени (поле поиска или строка фильтра). Флажок в заголовке выбирает все объекты, найденные фильтром.
      «Добавить связанные» использует зависимости из словаря СУБД: внешние ключи, представления, триггеры, последовательности, код
      ({{ connType === 'oracle' ? 'Oracle ALL_DEPENDENCIES' : 'для PostgreSQL зависимости кода ищутся по тексту функций' }}).
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { DxButton } from 'devextreme-vue/button';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { DxSelectBox } from 'devextreme-vue/select-box';
import { DxDataGrid, DxColumn, DxSelection, DxSearchPanel, DxFilterRow, DxScrolling } from 'devextreme-vue/data-grid';
import { api, safe, toast } from '../api';
import { connType as connTypeOf } from '../store';
import { relatedKeys, TYPE_NAMES } from '../related';

const props = defineProps({
  connId: String, schema: String,
  modelValue: { type: Array, default: () => [] }, // [{type, name}]
  onlyTypes: { type: Array, default: null },       // например ['table']
  height: { type: Number, default: 360 },
});
const emit = defineEmits(['update:modelValue', 'loaded']);
const objects = ref([]);
const deps = ref([]);
const direction = ref('deps');
const recursive = ref(true);
const onlySelected = ref(false);
const directions = [
  { v: 'deps', t: 'от чего зависят (родители)' },
  { v: 'dependents', t: 'что зависит от них (дети)' },
  { v: 'both', t: 'в обе стороны' },
];
const connType = computed(() => connTypeOf(props.connId));
const selectedKeys = computed(() => props.modelValue.map(o => `${o.type}:${o.name}`));
const visible = computed(() => (onlySelected.value ? objects.value.filter(o => selectedKeys.value.includes(o.key)) : objects.value));

async function load() {
  const r = await safe(() => api.get(`/connections/${props.connId}/objects?schema=${encodeURIComponent(props.schema)}`));
  if (!r) return;
  const count = new Map();
  for (const d of r.deps) { count.set(d.from, (count.get(d.from) || 0) + 1); count.set(d.to, (count.get(d.to) || 0) + 1); }
  const outs = new Map();
  for (const d of r.deps) (outs.get(d.from) || outs.set(d.from, []).get(d.from)).push(d.to.split(':')[1]);
  objects.value = r.objects
    .filter(o => !props.onlyTypes || props.onlyTypes.includes(o.type))
    .map(o => {
      const key = `${o.type}:${o.name}`;
      const out = outs.get(key) || [];
      return { ...o, key, typeName: TYPE_NAMES[o.type] || o.type, links: out.length ? `→ ${out.slice(0, 5).join(', ')}${out.length > 5 ? ` и ещё ${out.length - 5}` : ''}` : '' };
    });
  deps.value = props.onlyTypes ? r.deps.filter(d => props.onlyTypes.includes(d.from.split(':')[0]) && props.onlyTypes.includes(d.to.split(':')[0])) : r.deps;
  emit('loaded', objects.value);
}
function emitKeys(keys) {
  emit('update:modelValue', keys.map(k => { const i = k.indexOf(':'); return { type: k.slice(0, i), name: k.slice(i + 1) }; }));
}
function onSelection(e) {
  if (onlySelected.value) {
    // в режиме «только выбранные» снятие флажка = удаление из выбора
    emitKeys(e.selectedRowKeys);
    return;
  }
  // DevExtreme меняет переданный массив на месте — сравниваем со свежим списком из modelValue
  const current = props.modelValue.map(o => `${o.type}:${o.name}`);
  const keys = new Set(e.selectedRowKeys);
  if (keys.size === current.length && current.every(k => keys.has(k))) return;
  emitKeys([...keys]);
}
function addRelated() {
  const known = new Set(objects.value.map(o => o.key));
  const res = relatedKeys(deps.value, selectedKeys.value, { direction: direction.value, recursive: recursive.value, onlyTypes: props.onlyTypes })
    .filter(k => known.has(k));
  const added = res.length - selectedKeys.value.length;
  emitKeys(res);
  toast(added ? `Добавлено связанных объектов: ${added}` : 'Новых связанных объектов нет', added ? 'success' : 'info');
}
watch(() => [props.connId, props.schema], () => { objects.value = []; deps.value = []; });
defineExpose({ load });
</script>
