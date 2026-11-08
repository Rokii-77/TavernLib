<script setup>
import { store, openMenu, closeMenu } from '../store.js'

const props = defineProps({ items: { type: Array, default: () => [] } })

function run(fn) {
  closeMenu()
  if (typeof fn === 'function') fn()
}
</script>

<template>
  <div
    v-if="store.menu.visible"
    class="ctx"
    :style="{ left: store.menu.x + 'px', top: store.menu.y + 'px' }"
    @click.stop
  >
    <template v-for="(m, i) in store.menu.items" :key="i">
      <div v-if="m.divider" class="divider"></div>
      <div
        v-else
        class="item"
        :class="{ danger: m.danger, disabled: m.disabled, 'has-desc': m.desc }"
        @click="!m.disabled && run(m.action)"
      >
        <div class="row">
          <span>{{ m.label }}</span>
          <em v-if="m.hint">{{ m.hint }}</em>
        </div>
        <div v-if="m.desc" class="desc">{{ m.desc }}</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ctx {
  position: fixed;
  z-index: 400;
  min-width: 190px;
  max-width: 380px;
  max-height: calc(100vh - 24px);
  overflow-y: auto;
  padding: 5px;
  background: var(--panel-fly);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(6px);
}
.item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--text-2);
  cursor: pointer;
}
/* 带说明的项：标题一行、明细另起一行，明细里可能有多条聊天记录 */
.item.has-desc { display: block; }
.item .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.desc {
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.55;
  color: var(--muted);
  white-space: pre-line;
  word-break: break-all;
}
.item:hover { background: var(--panel-3); color: var(--text); }
.item em { font-style: normal; font-size: 11px; color: var(--muted); }
.item.danger:hover { background: rgba(210, 96, 79, 0.16); color: #f09283; }
.item.disabled { opacity: 0.4; cursor: default; }
.item.disabled:hover { background: transparent; color: var(--text-2); }
.divider { height: 1px; margin: 4px 6px; background: var(--line-soft); }
</style>
