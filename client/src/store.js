import { ref } from 'vue';
import { api, safe } from './api';

export const connections = ref([]);
export const runningJobs = ref(0);

export async function loadConnections() {
  const r = await safe(() => api.get('/connections'));
  if (r) connections.value = r;
  return connections.value;
}
export const connName = id => (connections.value.find(c => c.id === id) || {}).name || '';
export const connType = id => (connections.value.find(c => c.id === id) || {}).type || '';

// Последние выбранные параметры между экранами
const KEY = 'dbcompare.lastPick';
export function rememberPick(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* */ } }
export function lastPick() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
