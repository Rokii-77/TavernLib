<script setup>
import { computed } from 'vue'
import { store } from '../store.js'

const job = computed(() => store.bgJob || {})
const doneAll = computed(() => !!job.value.doneAll)
const pct = computed(() => {
  const total = Number(job.value.total || 0)
  const done = Number(job.value.done || 0)
  if (!total) return 0
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
})
/** 「抓取来源标题 3/5」这种带实时数字的文案 */
const text = computed(() => {
  const total = Number(job.value.total || 0)
  const done = Number(job.value.done || 0)
  const label = job.value.label || '处理中'
  return total ? `${label} ${done}/${total}` : label
})
</script>

<template>
  <transition name="bg">
    <div v-if="job.active" class="bg-task" :class="{ done: doneAll }">
      <div class="row">
        <span v-if="doneAll" class="tick-svg">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </span>
        <span v-else class="spin"></span>
        <span class="txt">{{ doneAll ? text + ' · 完成' : text }}</span>
        <span class="pct">{{ pct }}%</span>
      </div>
      <div class="bar"><i :style="{ width: pct + '%' }"></i></div>
    </div>
  </transition>
</template>

<style scoped>
.bg-task {
  position: fixed;
  left: 18px;
  bottom: 18px;
  /* 要盖在导入弹窗（500）、各对话框（520）和提示条之上，否则导入时看不到进度 */
  z-index: 950;
  width: 258px;
  padding: 10px 12px 9px;
  border-radius: 11px;
  background: var(--panel-fly);
  border: 1px solid var(--line);
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.5);
  pointer-events: none;
}
.bg-task.done { border-color: rgba(212, 162, 76, 0.55); }
.tick-svg { display: inline-flex; color: var(--accent-2); flex-shrink: 0; }
.row { display: flex; align-items: center; gap: 8px; }
.spin {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1.6px solid rgba(212, 162, 76, 0.28);
  border-top-color: var(--accent-2);
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}
.txt {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pct { font-size: 11px; color: var(--accent-2); flex-shrink: 0; }
.bar {
  margin-top: 7px;
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.07);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  transition: width 0.2s ease;
}
.hint { margin-top: 6px; font-size: 10.5px; color: #5f6875; }
@keyframes spin { to { transform: rotate(360deg); } }
.bg-enter-active, .bg-leave-active { transition: all 0.2s ease; }
.bg-enter-from, .bg-leave-to { opacity: 0; transform: translateY(6px); }
</style>
