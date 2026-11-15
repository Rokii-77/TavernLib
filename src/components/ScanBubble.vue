<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { store, showToast, importScanFiles, ignoreScanFiles, runAutoScan } from '../store.js'

const files = computed(() => store.scan.files || [])
const open = computed(() => store.scan.bubbleOpen)
const picked = ref([])

const pos = ref({ x: null, y: null })
let drag = null

function onPointerDown(e) {
  if (e.button !== 0) return
  const el = e.currentTarget.getBoundingClientRect()
  drag = { dx: e.clientX - el.left, dy: e.clientY - el.top, moved: false, sx: e.clientX, sy: e.clientY }
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
}

function onPointerMove(e) {
  if (!drag) return
  if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) drag.moved = true
  if (!drag.moved) return
  const w = 58
  const h = 58
  pos.value = {
    x: Math.min(Math.max(e.clientX - drag.dx, 8), window.innerWidth - w - 8),
    y: Math.min(Math.max(e.clientY - drag.dy, 8), window.innerHeight - h - 8)
  }
  store.scan.bubblePos = { ...pos.value }
}

function onPointerUp() {
  const moved = drag?.moved
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  drag = null
  if (!moved) toggle()
}

function toggle() {
  store.scan.bubbleOpen = !store.scan.bubbleOpen
  if (store.scan.bubbleOpen && files.value.length) picked.value = files.value.map((f) => f.path)
}

function isPicked(f) {
  return picked.value.includes(f.path)
}

function togglePick(f) {
  picked.value = isPicked(f) ? picked.value.filter((p) => p !== f.path) : [...picked.value, f.path]
}

const chosen = computed(() => files.value.filter((f) => picked.value.includes(f.path)))

async function doImport() {
  const list = chosen.value
  if (!list.length) return showToast('先勾选要导入的文件')
  store.scan.bubbleOpen = false
  await importScanFiles(list)
  picked.value = []
  setTimeout(() => runAutoScan({ manual: true }), 1500)
}

function doIgnore() {
  const list = chosen.value
  if (!list.length) return showToast('先勾选不再提醒的文件')
  ignoreScanFiles(list)
  picked.value = []
  if (!files.value.length) store.scan.bubbleOpen = false
}

function ignoreAll() {
  ignoreScanFiles(files.value)
  store.scan.bubbleOpen = false
}

async function rescan() {
  await runAutoScan({ manual: true })
  picked.value = files.value.map((f) => f.path)
}

/* ---------------- 面板定位：贴着气泡弹出，限制在视口内，不压顶栏 ---------------- */
const TOPBAR = 58 // 顶栏 54px + 4px 余量：面板永远不进这块区域，窗口拖动热区不会被盖住
const PANEL_W = 384
const MIN_H = 200

const bubbleEl = ref(null)
const panelPos = ref(null) // 自动锚定算出的 { left, top, maxH }
const panelManual = ref(null) // 手动拖动后的 { left, top, maxH }
let panelDrag = null

function clamp(v, lo, hi) {
  if (hi < lo) return lo
  return Math.min(Math.max(v, lo), hi)
}

/** 以气泡当前在屏幕上的位置为锚：优先放气泡上方，空间不够放下方，再不够就压缩高度（列表内部滚动） */
function computePanel() {
  const el = bubbleEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = clamp(r.right - PANEL_W, 8, Math.max(8, vw - PANEL_W - 8))
  const above = r.top - TOPBAR - 10
  const below = vh - r.bottom - 10
  let top = 0
  let maxH = 0
  if (above >= MIN_H || above >= below) {
    maxH = Math.min(vh * 0.6, above)
    top = r.top - 10 - Math.max(MIN_H, maxH)
  } else {
    maxH = Math.min(vh * 0.6, below)
    top = r.bottom + 10
  }
  maxH = Math.max(MIN_H, Math.min(maxH, vh - TOPBAR - 16))
  top = clamp(top, TOPBAR, Math.max(TOPBAR, vh - maxH - 8))
  panelPos.value = { left, top, maxH }
}

function onPanelDown(e) {
  if (e.button !== 0) return
  if (e.target && e.target.closest && e.target.closest('button')) return // 关窗按钮只负责关窗
  const rect = e.currentTarget.getBoundingClientRect()
  const cur = panelManual.value || panelPos.value
  panelDrag = {
    dx: e.clientX - rect.left,
    dy: e.clientY - rect.top,
    sx: e.clientX,
    sy: e.clientY,
    moved: false,
    maxH: (cur && cur.maxH) || Math.round(window.innerHeight * 0.6)
  }
  window.addEventListener('pointermove', onPanelMove)
  window.addEventListener('pointerup', onPanelUp)
}

function onPanelMove(e) {
  if (!panelDrag) return
  if (Math.abs(e.clientX - panelDrag.sx) + Math.abs(e.clientY - panelDrag.sy) > 3) panelDrag.moved = true
  if (!panelDrag.moved) return
  const vw = window.innerWidth
  const vh = window.innerHeight
  const maxH = Math.min(panelDrag.maxH, vh - TOPBAR - 16)
  panelManual.value = {
    left: clamp(e.clientX - panelDrag.dx, 8, Math.max(8, vw - PANEL_W - 8)),
    top: clamp(e.clientY - panelDrag.dy, TOPBAR, Math.max(TOPBAR, vh - maxH - 8)),
    maxH
  }
}

function onPanelUp() {
  window.removeEventListener('pointermove', onPanelMove)
  window.removeEventListener('pointerup', onPanelUp)
  panelDrag = null
}

const panelStyle = computed(() => {
  const p = panelManual.value || panelPos.value
  const base = { width: PANEL_W + 'px' }
  if (!p) return base
  return {
    ...base,
    left: p.left + 'px',
    top: p.top + 'px',
    maxHeight: (p.maxH || Math.round(window.innerHeight * 0.6)) + 'px'
  }
})

watch(open, async (v) => {
  panelManual.value = null
  if (!v) {
    panelPos.value = null
    return
  }
  await nextTick()
  computePanel()
})

watch(
  pos,
  () => {
    if (open.value) nextTick(computePanel)
  },
  { deep: true }
)

function onResize() {
  if (!open.value) return
  panelManual.value = null
  computePanel()
}

function label(f) {
  return f.base || f.name
}

function sizeText(f) {
  const b = Number(f.size || 0)
  if (!b) return ''
  if (b > 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB'
  return Math.max(1, Math.round(b / 1024)) + ' KB'
}

function dateText(f) {
  return f.date || ''
}

onMounted(() => {
  pos.value = store.scan.bubblePos?.x != null ? { ...store.scan.bubblePos } : { x: null, y: null }
  window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointermove', onPanelMove)
  window.removeEventListener('pointerup', onPanelUp)
  window.removeEventListener('resize', onResize)
})
</script>

<template>
  <div class="scan-root">
    <!-- 气泡：常驻，右下角一直挂着，有新文件时显示数量 -->
    <div
      ref="bubbleEl"
      class="bubble"
      :class="{ has: files.length, idle: !files.length }"
      :style="pos.x != null ? { left: pos.x + 'px', top: pos.y + 'px' } : {}"
      @pointerdown="onPointerDown"
      :title="files.length ? `发现 ${files.length} 个新文件` : '扫描气泡'"
    >
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">
        <path d="M12 3v9m0-9 3.4 3.4M12 3 8.6 6.4" />
        <path d="M4 14v3.5A2.5 2.5 0 0 0 6.5 20h11A2.5 2.5 0 0 0 20 17.5V14" />
      </svg>
      <span v-if="files.length" class="num">{{ files.length }}</span>
    </div>

    <!-- 展开面板：点开时贴在气泡旁边弹出，面板自身也能拖动 -->
    <div v-if="open" class="panel" :style="panelStyle" @pointerdown.stop>
      <header @pointerdown="onPanelDown">
        <b v-if="files.length">发现 {{ files.length }} 个新文件</b>
        <b v-else>暂无新文件</b>
        <span class="hint">来自：{{ store.settings.scanPath || '未设置扫描目录' }}</span>
        <button class="x" @click="store.scan.bubbleOpen = false">✕</button>
      </header>

      <div class="list">
        <div v-for="f in files" :key="f.path" class="row" :class="{ on: isPicked(f) }" @click="togglePick(f)">
          <span class="tick" :class="{ on: isPicked(f) }"></span>
          <span class="nm">{{ label(f) }}</span>
          <span class="meta">{{ f.ext }} · {{ sizeText(f) }} · {{ dateText(f) }}</span>
        </div>
        <div v-if="!files.length" class="empty">
          {{ store.settings.scanPath ? '这个目录暂时没有待导入的新文件' : '先在设置里选一个要自动扫描的文件夹' }}
        </div>
      </div>

      <footer>
        <button class="ghost" @click="rescan">再扫一次</button>
        <button class="ghost" :disabled="!files.length" @click="ignoreAll">全部忽略</button>
        <span class="sp"></span>
        <button :disabled="!chosen.length" @click="doIgnore">忽略选中</button>
        <button class="primary" :disabled="!chosen.length" @click="doImport">导入选中 {{ chosen.length }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.scan-root { position: fixed; inset: 0; pointer-events: none; z-index: 400; }

.bubble {
  position: absolute;
  right: 22px;
  bottom: 22px;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: #20180a;
  background: linear-gradient(180deg, var(--accent-2), var(--accent));
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.08) inset;
  cursor: grab;
  pointer-events: auto;
  user-select: none;
  animation: float 2.6s ease-in-out infinite;
}
.bubble:active { cursor: grabbing; }
.bubble.idle {
  color: var(--text-2);
  background: linear-gradient(180deg, var(--panel-3), var(--panel-2));
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.06) inset;
  animation: none;
  opacity: 0.82;
}
.bubble.idle:hover { opacity: 1; }
.empty {
  padding: 16px 10px;
  text-align: center;
  font-size: 11.5px;
  color: var(--muted);
}
.panel footer button:disabled { opacity: 0.4; cursor: default; }
.bubble .num {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 18px;
  height: 18px;
  border-radius: 9px;
  background: #d2362a;
  color: #fff;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
  padding: 0 4px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
}
@keyframes float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-4px); }
}

.panel {
  position: absolute;
  width: 384px;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  background: var(--panel-solid);
  border: 1px solid var(--line);
  border-radius: 13px;
  box-shadow: 0 20px 48px rgba(0, 0, 0, 0.55);
  pointer-events: auto;
  overflow: hidden;
}
.panel header {
  display: flex;
  align-items: baseline;
  gap: 9px;
  padding: 11px 13px 9px;
  border-bottom: 1px solid var(--line-soft);
  /* 面板自身可拖动：抓住标题栏就能挪开，不再只能关掉重扫 */
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.panel header:active { cursor: grabbing; }
.panel header b { font-size: 13px; }
.panel .hint {
  font-size: 10.5px;
  color: var(--muted);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.panel .x {
  background: transparent;
  border: none;
  color: var(--muted);
  font-size: 12px;
  padding: 0 3px;
}
.list { overflow-y: auto; padding: 5px; }
.row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 12.5px;
}
.row:hover { background: var(--panel-2); }
.row.on { background: rgba(212, 162, 76, 0.09); }
.tick {
  width: 13px;
  height: 13px;
  border-radius: 4px;
  border: 1px solid #4a545f;
  flex-shrink: 0;
}
.tick.on { background: var(--accent-2); border-color: var(--accent-2); }
.nm {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}
.meta { font-size: 10.5px; color: var(--muted); flex-shrink: 0; }
.panel footer {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-top: 1px solid var(--line-soft);
}
.panel footer button { font-size: 12px; padding: 4px 10px; }
.panel footer .sp { flex: 1; }
</style>
