<template>
  <span>
    <DxButton text="В регламент" icon="clock" styling-mode="outlined" hint="Добавить эту проверку в набор регламентных проверок" @click="open" />
    <DxPopup v-model:visible="visible" title="Добавить в регламентные проверки" :width="480" height="auto" :show-close-button="true">
      <div>
        <div class="field"><label>Набор проверок</label>
          <DxSelectBox v-model:value="suiteId" :items="suites" value-expr="id" display-expr="name" placeholder="Выберите набор" :accept-custom-value="false" />
        </div>
        <div class="field"><label>или новый набор</label><DxTextBox v-model:value="newName" placeholder="Например: Ежедневная сверка" /></div>
        <div class="field"><label>Название проверки</label><DxTextBox v-model:value="title" /></div>
        <div class="toolbar" style="justify-content:flex-end"><DxButton text="Добавить" type="default" icon="add" @click="add" /></div>
      </div>
    </DxPopup>
  </span>
</template>

<script setup>
import { ref } from 'vue';
import { DxButton } from 'devextreme-vue/button';
import { DxPopup } from 'devextreme-vue/popup';
import { DxSelectBox } from 'devextreme-vue/select-box';
import { DxTextBox } from 'devextreme-vue/text-box';
import { api, safe, toast } from '../api';

const props = defineProps({ type: String, params: Function, defaultTitle: String });
const visible = ref(false);
const suites = ref([]);
const suiteId = ref(null);
const newName = ref('');
const title = ref('');
async function open() {
  const p = props.params();
  if (!p) return toast('Сначала заполните параметры проверки', 'warning');
  suites.value = (await safe(() => api.get('/saved/suites'))) || [];
  suiteId.value = suites.value[0] ? suites.value[0].id : null;
  title.value = props.defaultTitle || '';
  visible.value = true;
}
async function add() {
  let id = suiteId.value;
  if (newName.value.trim()) {
    const s = await safe(() => api.post('/saved/suites', { name: newName.value.trim(), enabled: false, schedule: '', checks: [] }));
    if (!s) return; id = s.id;
  }
  if (!id) return toast('Выберите или создайте набор', 'warning');
  const r = await safe(() => api.post(`/suites/${id}/checks`, { type: props.type, title: title.value || undefined, params: props.params() }));
  if (r) { visible.value = false; newName.value = ''; toast(`Проверка добавлена в «${r.name}». Расписание — в разделе «Регламент».`); }
}
</script>
