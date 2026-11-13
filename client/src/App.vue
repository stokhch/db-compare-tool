<template>
  <div class="layout">
    <nav class="sidebar">
      <div class="logo">DB Compare<small>Oracle ⇄ PostgreSQL</small></div>
      <router-link to="/connections">🔌 Подключения</router-link>
      <router-link to="/profile">📊 Профиль данных</router-link>
      <router-link to="/schema">🧩 Сравнение схем</router-link>
      <router-link to="/data">🔍 Сравнение данных</router-link>
      <router-link to="/checks">✅ Проверки</router-link>
      <router-link to="/migrate">🚚 Миграция</router-link>
      <router-link to="/copy">📦 Копирование</router-link>
      <router-link to="/dump">🗄️ Импорт дампа</router-link>
      <router-link to="/code">🧑‍💻 Код приложения</router-link>
      <router-link to="/suites">⏰ Регламент</router-link>
      <router-link to="/jobs">🕘 Задачи <span v-if="runningJobs" class="badge">{{ runningJobs }}</span></router-link>
      <router-link to="/settings">⚙️ Настройки</router-link>
    </nav>
    <main class="content">
      <router-view v-slot="{ Component }">
        <keep-alive><component :is="Component" /></keep-alive>
      </router-view>
    </main>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue';
import { api } from './api';
import { loadConnections, runningJobs } from './store';

let timer;
async function poll() {
  try { runningJobs.value = (await api.get('/jobs')).filter(j => j.status === 'running').length; } catch { /* */ }
}
onMounted(() => { loadConnections(); poll(); timer = setInterval(poll, 4000); });
onUnmounted(() => clearInterval(timer));
</script>
