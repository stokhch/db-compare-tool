import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import 'devextreme/dist/css/dx.fluent.blue.light.compact.css';
import config from 'devextreme/core/config';
import { locale, loadMessages } from 'devextreme/localization';
import ruMessages from 'devextreme/localization/messages/ru.json';
import App from './App.vue';
import './style.css';

// Лицензионный ключ DevExtreme (если есть): VITE_DEVEXTREME_LICENSE в client/.env
if (import.meta.env.VITE_DEVEXTREME_LICENSE) config({ licenseKey: import.meta.env.VITE_DEVEXTREME_LICENSE });
loadMessages(ruMessages);
locale('ru');

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/connections' },
    { path: '/connections', component: () => import('./views/Connections.vue'), meta: { title: 'Подключения' } },
    { path: '/schema', component: () => import('./views/SchemaCompare.vue'), meta: { title: 'Сравнение схем' } },
    { path: '/data', component: () => import('./views/DataCompare.vue'), meta: { title: 'Сравнение данных' } },
    { path: '/copy', component: () => import('./views/Copy.vue'), meta: { title: 'Копирование' } },
    { path: '/jobs', component: () => import('./views/Jobs.vue'), meta: { title: 'Задачи' } },
    { path: '/settings', component: () => import('./views/Settings.vue'), meta: { title: 'Настройки' } },
  ],
});

createApp(App).use(router).mount('#app');
