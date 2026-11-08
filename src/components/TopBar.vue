<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { store, tabs, openMenu, runUpdateCheck, showToast, openImportWith, clearSearch, toggleTheme, setTheme } from '../store.js'
import { resolveTheme } from '../lib/theme.js'

/* ---------- 自绘窗口按钮（主进程已 frame:false，原生标题栏不存在） ---------- */
const isMax = ref(false)
let offMax = null
function winMin() { window.api?.winMinimize?.() }
async function winMax() {
  const r = await window.api?.winToggleMax?.()
  if (r && typeof r.maximized === 'boolean') isMax.value = r.maximized
}
function winClose() { window.api?.winClose?.() }
onMounted(async () => {
  try {
    const r = await window.api?.winIsMax?.()
    if (r && typeof r.maximized === 'boolean') isMax.value = r.maximized
    offMax = window.api?.onWinMaxChange?.((v) => { isMax.value = v }) || null
  } catch (_) {}
})
onBeforeUnmount(() => { try { offMax && offMax() } catch (_) {} })

/* ---------- 配色：默认黑 / 默认白 / 跟随系统 ----------
 * store.settings.theme 是唯一依据（dark | light | auto）：按钮图标跟着"实际生效"变，
 * 点击在 黑 / 白 之间切；右键菜单可切「跟随系统」，并可直接去设置里改自定义 CSS。 */
const isLight = computed(() => resolveTheme(store.settings.theme) === 'light')
const themeMode = computed(() => store.settings.theme)

/* 品牌图标：public/IMG11_9741.png；文件缺失时回退到 public/logo.png */
const logoSrc = ref('IMG11_9741.png')
function onLogoError() {
  if (logoSrc.value !== 'logo.png') logoSrc.value = 'logo.png'
}

function themeMenu(e) {
  openMenu(e, [
    { label: '默认黑', hint: themeMode.value === 'dark' ? '当前' : '', action: () => setTheme('dark') },
    { label: '默认白', hint: themeMode.value === 'light' ? '当前' : '', action: () => setTheme('light') },
    { label: '跟随系统', hint: themeMode.value === 'auto' ? '当前' : '', action: () => setTheme('auto') },
    { label: '自定义 CSS…', hint: '', action: () => { store.settingsPanel.visible = true } }
  ])
}

/* ---------- 搜索框 ----------
 * 用本地 kw 承接输入，再同步给 store.search：
 * 1) 中文输入法组合期间不把拼音字母当关键词（否则列表会随拼音闪成空）；
 * 2) 清空时同时清 kw 和 store.search，并在组合态没结束前不被输入法回填，
 *    保证「清空后回到全量」这个动作一次到底。 */
const kw = ref(store.search || '')
const composing = ref(false)
watch(
  () => store.search,
  (v) => {
    if (composing.value) return
    if ((v || '') !== kw.value) kw.value = v || ''
  }
)
watch(kw, (v) => {
  if (composing.value) return
  if (store.search !== v) store.search = v
})
function onComposeEnd(e) {
  composing.value = false
  const v = e && e.target ? e.target.value : kw.value
  kw.value = v
  store.search = v
}
function doClearSearch() {
  composing.value = false
  kw.value = ''
  clearSearch()
}

function switchTab(key) {
  if (store.tab === key) return
  store.tab = key
  store.currentId = null
  store.selected = []
}

/* 检查更新 = 复合按钮：
 *   点左侧主体 → 直接用「上次用过 / 已选定的」方式开检
 *   点右侧小三角 → 下拉切换检查方式（全部 / 当前页面 / 选中项） */
const SCOPES = ['all', 'current', 'selected']

const curScope = computed(() => (SCOPES.includes(store.settings.checkScope) ? store.settings.checkScope : 'all'))

const scopeLabel = computed(() => {
  if (curScope.value === 'current') return `${tabs.find((t) => t.key === store.tab)?.label || '当前页面'}`
  if (curScope.value === 'selected') return '选中项'
  return '全部条目'
})

const mainLabel = computed(() => {
  const c = store.check
  if (c.running) return `检查中 ${Math.min(c.done, c.total)}/${c.total}`
  return '检查更新'
})

function runMainCheck() {
  if (store.check.running) return
  const s = curScope.value
  if (s === 'selected' && !store.selected.length) {
    showToast('当前没有选中条目，改为检查全部')
    runUpdateCheck('all')
    return
  }
  runUpdateCheck(s)
}

function checkMenu(e) {
  const scope = curScope.value
  openMenu(e, [
    {
      label: '检查全部更新',
      hint: scope === 'all' ? '当前方式' : '全部分类',
      action: () => runUpdateCheck('all')
    },
    {
      label: '检查当前页面',
      hint: scope === 'current' ? '当前方式' : tabs.find((t) => t.key === store.tab)?.label,
      action: () => runUpdateCheck('current')
    },
    {
      label: '检查选中项',
      hint: scope === 'selected' ? '当前方式' : store.selected.length ? `${store.selected.length} 项` : '先多选条目',
      disabled: !store.selected.length,
      action: () => runUpdateCheck('selected')
    }
  ])
}

</script>

<template>
  <header class="topbar">
    <div class="brand">
      <div class="logo">
        <img :src="logoSrc" alt="洛书匣" @error="onLogoError" />
      </div>
      <span class="name">洛书匣</span>
    </div>

    <nav class="tabs">
      <button
        v-for="t in tabs"
        :key="t.key"
        class="tab"
        :class="{ active: store.tab === t.key }"
        @click="switchTab(t.key)"
      >
        {{ t.label }}
        <em>{{ (store.items[t.key] || []).length }}</em>
      </button>
    </nav>

    <div class="right">
      <div class="search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          v-model="kw"
          placeholder="搜索标题"
          @compositionstart="composing = true"
          @compositionend="onComposeEnd"
          @keydown.esc.prevent="doClearSearch"
        />
        <button v-if="kw || store.search" class="clear" title="清空搜索" @click="doClearSearch">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6">
            <path d="M5 5l14 14M19 5 5 19" />
          </svg>
        </button>
      </div>

      <button data-guide="import-btn" @click="openImportWith([])">导入</button>

      <div class="check-wrap" :class="{ busy: store.check.running }">
        <button
          class="check main"
          :disabled="store.check.running"
          :title="`检查更新 · ${scopeLabel}`"
          @click="runMainCheck"
        >
          <span v-if="store.check.running" class="spin"></span>
          <span v-else class="ico">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 12a9 9 0 1 1-3-6.7" />
              <path d="M21 4v5h-5" />
            </svg>
          </span>
          {{ mainLabel }}
        </button>
        <button
          class="check caret"
          :disabled="store.check.running"
          title="切换检查方式"
          @click="checkMenu"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>

      <button
        class="icon theme"
        :title="`配色：${themeMode === 'auto' ? '跟随系统' : themeMode === 'light' ? '默认白' : '默认黑'}`"
        @click="toggleTheme"
        @contextmenu.prevent="themeMenu"
      >
        <svg v-if="isLight" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.6v2.2M12 19.2v2.2M4.2 12H2M22 12h-2.2M5.9 5.9 4.4 4.4M19.6 19.6l-1.5-1.5M18.1 5.9l1.5-1.5M4.4 19.6l1.5-1.5" />
        </svg>
        <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M20.5 14.3A8.6 8.6 0 0 1 9.7 3.5 8.6 8.6 0 1 0 20.5 14.3Z" />
        </svg>
      </button>

      <button class="icon" title="设置" @click="store.settingsPanel.visible = true">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <circle cx="12" cy="12" r="3.2" />
          <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1 2 2 0 1 1-4 0 1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 15a2 2 0 1 1 0-4 1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9.6 4.4a2 2 0 1 1 4 0 1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.6 1.6 0 0 0 20.4 11a2 2 0 1 1 0 4Z" />
        </svg>
      </button>

      <div class="winbar">
        <button class="winbtn" title="最小化" @click="winMin">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5h6" stroke="currentColor" stroke-width="1.1" /></svg>
        </button>
        <button class="winbtn" :title="isMax ? '还原' : '最大化'" @click="winMax">
          <svg v-if="!isMax" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.1">
            <rect x="2" y="2" width="6" height="6" rx="0.6" />
          </svg>
          <svg v-else width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.1">
            <rect x="2" y="3.4" width="4.6" height="4.6" rx="0.6" />
            <path d="M4 3.4V2h4.6v4.6H7.4" />
          </svg>
        </button>
        <button class="winbtn close" title="关闭" @click="winClose">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2.4 2.4l5.2 5.2M7.6 2.4 2.4 7.6" stroke="currentColor" stroke-width="1.2" /></svg>
        </button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 54px;
  padding: 0 14px;
  background: var(--topbar-bg);
  border-bottom: 1px solid var(--line-soft);
  flex-shrink: 0;
  /* 宽度不够时只压缩中间区（搜索框 / 标签），绝不横向溢出把右边窗口按钮挤出去 */
  min-width: 0;
  overflow: hidden;
  -webkit-app-region: drag;
}
.topbar button,
.topbar input { -webkit-app-region: no-drag; }

/* 自绘窗口按钮：贴右边框、整高，无边框窗口专用。
   flex: 0 0 auto —— 最小化 / 最大化 / 关闭 三键宽度不允许被压缩，
   否则窗口一窄就被挤出视口，右上角直接看不到关闭按钮。 */
.winbar {
  display: flex;
  align-items: stretch;
  align-self: stretch;
  flex: 0 0 auto;
  margin: 0 -14px 0 4px;
  -webkit-app-region: no-drag;
}
.topbar .winbar .winbtn {
  flex: 0 0 46px;
  width: 46px;
  min-width: 46px;
  height: 100%;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--text-2);
  display: grid;
  place-items: center;
  transition: background .12s, color .12s;
}
.topbar .winbar .winbtn:hover { background: var(--hover, rgba(127, 127, 127, .16)); color: var(--text); }
.topbar .winbar .winbtn.close:hover { background: #e81123; color: #fff; }

.brand { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.logo {
  width: 26px; height: 26px; border-radius: 7px;
  display: grid; place-items: center;
  overflow: hidden;
  background: transparent;
}
.logo img { width: 100%; height: 100%; object-fit: cover; display: block; }
.name { font-size: 13.5px; font-weight: 600; letter-spacing: 0.3px; white-space: nowrap; }

.tabs {
  display: flex; gap: 4px; padding: 3px;
  background: var(--tabbar-bg);
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  /* 空间不足时标签栏优先让位：内部横向滚动，而不是把右边的窗口按钮顶出屏幕 */
  flex: 0 1 auto;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.tabs::-webkit-scrollbar { width: 0; height: 0; display: none; }
.tab {
  display: flex; align-items: center; gap: 6px;
  background: transparent; border: none; border-radius: 7px;
  padding: 6px 10px; font-size: 13px; color: var(--text-2);
  flex: 0 0 auto;
  white-space: nowrap;
}
.tab em {
  font-style: normal; font-size: 10.5px; color: var(--muted);
  background: var(--overlay-1); border-radius: 999px;
  padding: 0 6px; line-height: 15px;
}
.tab:hover { background: var(--overlay-2); color: var(--text); }
.tab.active {
  color: #20180a;
  background: linear-gradient(180deg, var(--accent-2), var(--accent));
  font-weight: 600;
}
.tab.active em { color: rgba(32, 24, 10, 0.65); background: rgba(0, 0, 0, 0.1); }

.right {
  margin-left: auto; display: flex; align-items: center; gap: 7px;
  flex: 0 1 auto;
  min-width: 0;
}
/* 右侧按钮本身不参与压缩（按钮文字不能换行、不能压扁），
   空间不够时由搜索框与标签栏让位 */
.right > button,
.right > .check-wrap { flex: 0 0 auto; white-space: nowrap; }
.search {
  display: flex; align-items: center; gap: 7px;
  padding: 0 10px; height: 30px; border-radius: 8px;
  background: var(--panel); border: 1px solid var(--line); color: var(--muted);
  flex: 0 1 auto;
  min-width: 84px;
}
.search input { border: none; background: transparent; padding: 0; width: 132px; min-width: 0; flex: 1 1 auto; height: 100%; }
.search:focus-within { border-color: rgba(212, 162, 76, 0.5); }
.search .clear {
  display: flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; padding: 0; border: none; border-radius: 50%;
  background: var(--overlay-1); color: var(--muted); cursor: pointer;
}
.search .clear:hover { color: var(--text); background: var(--overlay-1); }

.right button { font-size: 12.5px; padding: 6px 11px; }
button.on {
  color: #20180a;
  background: linear-gradient(180deg, var(--accent-2), var(--accent));
  border-color: transparent;
  font-weight: 600;
}
.check { display: inline-flex; align-items: center; gap: 6px; }
.check .ico { display: flex; }

/* 复合按钮：左主体 + 右小三角，中间一条细分割线 */
.check-wrap {
  display: inline-flex;
  align-items: stretch;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--line);
  background: var(--panel-2);
}
.check-wrap .check {
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 6px 9px;
  font-size: 12.5px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.check-wrap .check.main {
  padding-left: 10px;
  padding-right: 10px;
  white-space: nowrap;
}
.check-wrap .check.caret {
  padding: 6px 6px;
  border-left: 1px solid var(--line-soft);
  color: var(--muted);
}
.check-wrap .check.caret:hover { color: var(--text); background: var(--overlay-2); }
.check-wrap .check.main:hover { background: var(--overlay-2); }
.check-wrap.busy { border-color: rgba(212, 162, 76, 0.4); }
.check-wrap .check:disabled { opacity: 0.75; }
button.icon { padding: 6px 8px; display: grid; place-items: center; }

.spin {
  width: 11px; height: 11px; border-radius: 50%;
  border: 1.6px solid rgba(212, 162, 76, 0.3);
  border-top-color: var(--accent-2);
  animation: rot 0.7s linear infinite;
}
@keyframes rot { to { transform: rotate(360deg); } }

/* 日 / 夜切换按钮：与其它图标按钮同尺寸，悬停时用主色描边，便于一眼找到 */
.topbar .icon.theme {
  color: var(--text-2);
}
.topbar .icon.theme:hover {
  color: var(--accent-2);
  border-color: rgba(212, 162, 76, 0.5);
  background: var(--accent-dim);
}

/* 窗口拉窄时的收缩顺序：先去掉品牌文字与标签计数，再收紧按钮内边距。
   无论如何都不能把右侧的自绘窗口按钮（最小化 / 最大化 / 关闭）挤出视口。 */
@media (max-width: 1120px) {
  .brand .name { display: none; }
  .tabs .tab em { display: none; }
  .right button { padding: 6px 9px; }
}
@media (max-width: 1000px) {
  .topbar { gap: 10px; }
  .right { gap: 5px; }
  .search { max-width: 110px; }
  .right button { padding: 6px 8px; font-size: 12px; }
}
</style>
