<script setup>
import { computed, ref } from 'vue'
import {
  store, wbFolderById, closeWbFolder, restoreWorldBackup,
  exportWorldBackupFile, deleteWorldBackup, pullTavernWorldbook, showToast
} from '../store.js'

const busy = ref(false)

const folder = computed(() => wbFolderById(store.wbFolder.id))
const list = computed(() => (folder.value?.backups || []))

async function pull() {
  const f = folder.value
  if (!f || busy.value) return
  busy.value = true
  await pullTavernWorldbook(f)
  busy.value = false
}

async function restore(rec) {
  const f = folder.value
  if (!f) return
  const ok = window.confirm(`把「${rec.worldName}」${rec.date} 的备份写回酒馆？\n酒馆里同名的世界书会被覆盖。`)
  if (!ok) return
  await restoreWorldBackup(f, rec)
}

async function exportOne(rec) {
  const f = folder.value
  if (!f) return
  await exportWorldBackupFile(f, rec)
}

function remove(rec) {
  const f = folder.value
  if (!f) return
  const ok = window.confirm(`删除 ${rec.date} 这份备份？删了找不回来。`)
  if (!ok) return
  const left = deleteWorldBackup(f, rec)
  showToast(left ? `已删除，还剩 ${left} 份` : '已删除最后一份备份')
}

function close() {
  closeWbFolder()
}
</script>

<template>
  <div class="mask" @click.self="close">
    <div class="panel" v-if="folder">
      <header>
        <div class="ava" :style="folder.cover ? { backgroundImage: `url(${folder.cover})` } : {}">
          <span v-if="!folder.cover">{{ folder.name.slice(0, 1) }}</span>
        </div>
        <div class="ttl">
          <h2>{{ folder.name }}</h2>
          <p>世界书备份 · {{ list.length }} 份</p>
        </div>
        <button class="mini" :disabled="busy" @click="pull">{{ busy ? '读取中…' : '从酒馆取当前世界书' }}</button>
        <button class="x" @click="close">✕</button>
      </header>

      <div class="body">
        <div v-if="!list.length" class="empty">
          <p>还没有备份</p>
          <span>角色卡详情页里勾选「备份旧的世界书」，更新到酒馆时会自动存一份；也可以点右上角从酒馆取当前版本。</span>
        </div>
        <div v-for="rec in list" :key="rec.id" class="wb">
          <div class="line1">
            <b>{{ rec.worldName }}</b>
            <span class="date">{{ rec.date }}</span>
            <span class="note">{{ rec.note }}</span>
          </div>
          <div class="line2">
            <span class="cnt">{{ rec.entries }} 条条目</span>
            <span class="sp"></span>
            <button class="mini" @click="exportOne(rec)">导出</button>
            <button class="mini" @click="restore(rec)">还原到酒馆</button>
            <button class="mini danger" @click="remove(rec)">删除</button>
          </div>
        </div>
      </div>

      <footer>
        <button class="primary" @click="close">关闭</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 480;
  background: var(--mask);
  backdrop-filter: blur(3px);
  display: grid;
  place-items: center;
}
.panel {
  width: min(680px, 92vw);
  max-height: 84vh;
  display: flex;
  flex-direction: column;
  background: var(--panel-solid);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}
header {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 13px 16px 11px;
  border-bottom: 1px solid var(--line-soft);
}
.ava {
  width: 42px;
  height: 42px;
  border-radius: 9px;
  background: linear-gradient(150deg, hsl(95 40% 32%), #171b20);
  background-size: cover;
  background-position: center;
  display: grid;
  place-items: center;
  font-size: 16px;
  color: rgba(255, 255, 255, 0.8);
  flex-shrink: 0;
}
.ttl { flex: 1; min-width: 0; }
.ttl h2 { margin: 0; font-size: 14px; font-weight: 600; }
.ttl p { margin: 2px 0 0; font-size: 11.5px; color: var(--muted); }
.x {
  background: transparent;
  border: none;
  color: var(--muted);
  font-size: 13px;
  padding: 2px 5px;
}
.x:hover { color: var(--text); }

.body { padding: 10px 16px; overflow-y: auto; }
.wb {
  padding: 10px 11px;
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  margin-bottom: 8px;
  background: rgba(255, 255, 255, 0.015);
}
.line1 { display: flex; align-items: baseline; gap: 9px; }
.line1 b { font-size: 12.5px; font-weight: 600; }
.date { font-size: 11px; color: var(--muted); }
.note {
  font-size: 10.5px;
  color: #7d8794;
  background: var(--panel-3);
  border-radius: 5px;
  padding: 1px 6px;
}
.line2 { display: flex; align-items: center; gap: 6px; margin-top: 7px; }
.cnt { font-size: 11px; color: var(--muted); }
.sp { flex: 1; }
.mini { font-size: 11px; padding: 3px 9px; }
.mini.danger { color: #e08a7c; }

.empty { text-align: center; padding: 26px 12px 20px; }
.empty p { margin: 0 0 6px; font-size: 13px; color: var(--text-2); }
.empty span { font-size: 11.5px; color: var(--muted); line-height: 1.7; }

footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 16px;
  border-top: 1px solid var(--line-soft);
}
.hint { font-size: 11px; color: var(--muted); }
</style>
