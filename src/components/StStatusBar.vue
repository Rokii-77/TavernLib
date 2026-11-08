<script setup>
import { computed } from 'vue'
import { store, checkStConnection, refreshStExt, showToast } from '../store.js'

const st = computed(() => store.stStatus)

/* 绿点跟的是「酒馆端扩展是否在线」（桥收到 /pending 心跳），文案仍写酒馆已连接 */
const extOnline = computed(() => !!st.value.extOnline)

/* 原显示探测毫秒的位置，改为显示扩展心跳距今秒数；没有心跳就留空 */
const agoText = computed(() => {
  const v = st.value.extAgoMs
  if (typeof v !== 'number') return ''
  return Math.max(0, Math.round(v / 1000)) + 's'
})

async function reconnect() {
  /* 点击重连：先重探酒馆本身（返回值是布尔），再刷扩展在线状态 */
  const ok = await checkStConnection(true)
  try {
    await refreshStExt()
  } catch (_) {}
  if (!ok) {
    showToast('没连上：确认酒馆在运行、端口对得上')
    return
  }
  const ms = typeof st.value.ms === 'number' && st.value.ms > 0 ? ' ' + st.value.ms + ' ms' : ''
  showToast('已连上酒馆' + ms)
}
</script>

<template>
  <footer class="statusbar">
    <button class="dot-wrap" @click="reconnect" :title="st.connected ? '点一下重新检测' : '酒馆没运行也可以正常导入'">
      <span class="dot" :class="{ on: extOnline, checking: st.checking }"></span>
      <span class="txt">{{ st.connected ? '酒馆已连接' : '酒馆未连接' }}</span>
      <span v-if="agoText" class="ms">{{ agoText }}</span>
    </button>
    <span class="sep"></span>
    <span class="info">{{ st.host }}</span>
    <span class="sp"></span>
    <span v-if="store.check.lastAt" class="info">上次检查更新 {{ store.check.lastAt }}</span>
    <span v-if="store.scan.lastAt" class="info">上次扫描 {{ store.scan.lastAt }}</span>
    <span class="ver">洛书匣</span>
  </footer>
</template>

<style scoped>
.statusbar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 26px;
  padding: 0 12px;
  background: var(--panel-solid);
  border-top: 1px solid var(--line-soft);
  font-size: 11px;
  color: var(--muted);
  flex-shrink: 0;
}
.dot-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: none;
  padding: 0;
  font-size: 11px;
  color: var(--muted);
}
.dot-wrap:hover .txt { color: var(--text); }
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #6b7480;
}
.dot.on { background: #4fbf7a; box-shadow: 0 0 0 3px rgba(79, 191, 122, 0.16); }
.dot.checking { background: var(--accent-2); animation: blink 1s ease-in-out infinite; }
@keyframes blink { 50% { opacity: 0.35; } }
.ms { color: #4fbf7a; }
.sep { width: 1px; height: 11px; background: var(--panel-3); }
.info { color: #5f6875; }
.sp { flex: 1; }
.ver { color: #454d57; }
</style>
