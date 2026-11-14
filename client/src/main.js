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
    { path: '/profile', component: () => import('./views/Profile.vue'), meta: { title: 'Профиль данных' } },
    { path: '/schema', component: () => import('./views/SchemaCompare.vue'), meta: { title: 'Сравнение схем' } },
    { path: '/data', component: () => import('./views/DataCompare.vue'), meta: { title: 'Сравнение данных' } },
    { path: '/checks', component: () => import('./views/Checks.vue'), meta: { title: 'Проверки' } },
    { path: '/migrate', component: () => import('./views/Migration.vue'), meta: { title: 'Миграция' } },
    { path: '/code', component: () => import('./views/CodeScan.vue'), meta: { title: 'Код приложения' } },
    { path: '/suites', component: () => import('./views/Suites.vue'), meta: { title: 'Регламент' } },
    { path: '/dump', component: () => import('./views/DumpImport.vue'), meta: { title: 'Импорт дампа' } },
    { path: '/copy', component: () => import('./views/Copy.vue'), meta: { title: 'Копирование' } },
    { path: '/objects', component: () => import('./views/ObjectBrowser.vue'), meta: { title: 'Браузер объектов' } },
    { path: '/sql', component: () => import('./views/SqlConsole.vue'), meta: { title: 'SQL-консоль' } },
    { path: '/perf', component: () => import('./views/Perf.vue'), meta: { title: 'Производительность' } },
    { path: '/health', component: () => import('./views/Health.vue'), meta: { title: 'Аудит здоровья' } },
    { path: '/search', component: () => import('./views/Search.vue'), meta: { title: 'Поиск по базе' } },
    { path: '/history', component: () => import('./views/History.vue'), meta: { title: 'История схемы' } },
    { path: '/docs', component: () => import('./views/Docs.vue'), meta: { title: 'Документация' } },
    { path: '/testcopy', component: () => import('./views/TestCopy.vue'), meta: { title: 'Тестовая копия' } },
    { path: '/backups', component: () => import('./views/Backups.vue'), meta: { title: 'Резервные копии' } },
    { path: '/jobs', component: () => import('./views/Jobs.vue'), meta: { title: 'Задачи' } },
    { path: '/settings', component: () => import('./views/Settings.vue'), meta: { title: 'Настройки' } },
  ],
});

createApp(App).use(router).mount('#app');
