<script setup>
import { computed, onMounted, onUnmounted } from 'vue'
import TopBar from './components/TopBar.vue'
import Bookshelf from './views/Bookshelf.vue'
import CardDetail from './views/CardDetail.vue'
import ContextMenu from './components/ContextMenu.vue'
import ImportDialog from './components/ImportDialog.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import DcDialog from './components/DcDialog.vue'
import ScanBubble from './components/ScanBubble.vue'
import BgTask from './components/BgTask.vue'
import StStatusBar from './components/StStatusBar.vue'
import UpdateToast from './components/UpdateToast.vue'
import WorldBackupFolder from './components/WorldBackupFolder.vue'
import FirstRunGuide from './components/FirstRunGuide.vue'
import OnboardTour from './components/OnboardTour.vue'
import {
  store, currentItem, closeMenu, selectAllVisible, clearSelect,
  checkStConnection, hydrateFromDataFile, ensureCoverImages, wbFolderById,
  startStWatch, stopStWatch, pokeStStatus, normalizeAllTags, checkAppUpdateOnStart, checkStExtVersion,
  shouldShowFirstRun, finishFirstRun, endOnboardTour, showToast
} from './store.js'

const detail = computed(() => currentItem.value)
/* 备份文件夹面板必须有真条目才渲染：条目被删/换库后 id 失效时，
   光看 visible 会留下一个点不掉的空白遮罩层。 */
const wbFolderCur = computed(() => wbFolderById(store.wbFolder.id))

onMounted(async () => {
  window.addEventListener('click', closeMenu)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (store.menu.visible) closeMenu()
      else if (store.scan.bubbleOpen) store.scan.bubbleOpen = false
      else if (store.firstRun.visible) finishFirstRun()
      else if (store.onboardTour.visible) endOnboardTour()
      else if (store.importDialog.visible) store.importDialog.visible = false
      else if (store.settingsPanel.visible) store.settingsPanel.visible = false
      else if (store.selected.length) clearSelect()
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !store.importDialog.visible && !store.settingsPanel.visible && !store.firstRun.visible) {
      e.preventDefault()
      selectAllVisible()
    }
  })

  /* 酒馆开/关、切到别的窗口再回来，状态都要自己跟上，不用重启资料库 */
  const onFocus = () => { pokeStStatus() }
  window.addEventListener('focus', onFocus)
  startStWatch()

  // 换了软件数据目录后，靠数据目录里的 library.json 把库接回来
  const _tHydrate = performance.now()
  await hydrateFromDataFile()
  if (window.__bootT) window.__bootT.hydrate = performance.now() - _tHydrate

  /* 首屏已经出来了，再做重量级的收尾工作（都放到空闲时间，不挡渲染）*/
  scheduleCoverMigration()

  /* 首次使用初始化指引：等库接回来、首屏画完再弹，不和渲染抢时间 */
  if (shouldShowFirstRun()) {
    setTimeout(() => {
      if (shouldShowFirstRun()) store.firstRun.visible = true
    }, 900)
  }

  /* 标签大小写归一：Gemini / gemini 这类写法差异合并成同一种（只跑一次，改完写盘） */
  const normTags = () => {
    try {
      normalizeAllTags()
    } catch (e) {
      console.warn('[tag normalize] failed', e)
    }
  }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(normTags, { timeout: 2500 })
  else setTimeout(normTags, 800)

  /* 软件更新：启动后自动查一次 GitHub Releases（地址写死在 lib/update.js）。
     延后到空闲，失败静默，只有真有新版本才提示。 */
  const updCheck = () => {
    Promise.resolve(checkAppUpdateOnStart()).catch(() => {})
  }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(updCheck, { timeout: 6000 })
  else setTimeout(updCheck, 3000)

  /* 酒馆连接状态：先立刻查一次给状态条，之后交给 startStWatch 定时自检
     （酒馆中途开了/关了，状态会自己变；窗口最小化时暂停）。
     启动阶段不自动扫描目录 —— 那是「打开软件就卡」的主要来源，
     扫描改成用户手动触发（右上角检查更新 / 设置里的立即扫描）。 */
  if (store.settings.tavernPath) {
    /* 不 await：一次 IPC + HTTP 探测不该挡住首屏 */
    Promise.resolve(checkStConnection(true)).catch(() => {})
    /* 扩展版本对不上时，右下角弹一次提示（只提示，不自动安装） */
    setTimeout(checkExtOnStart, 1800)
  }
})

/* ---------- C3：酒馆扩展版本校验（更新完第一次打开也走这里） ----------
 * 比对「软件内置扩展版本」与「酒馆目录里那份扩展的版本」，
 * 不一致就在右下角弹提示让用户重新注入；只提示，不自动改酒馆文件。 */
let extChecked = false
async function checkExtOnStart() {
  if (extChecked) return
  extChecked = true
  try {
    await checkStExtVersion()
  } catch (e) {
    console.warn('[ext check] failed', e)
  }
}

onUnmounted(() => {
  stopStWatch()
})

/* ---------- 封面 dataURL 迁移（启动卡顿的主要来源） ----------
 * 老库把整张 base64 封面（单个几 MB）直接存在快照里：启动时要解析这几 MB 字符串，
 * 书架还要把它当背景图交给浏览器解码，卡顿就出在这。这里在空闲时一次搬 1 张进图片仓库，
 * 迁完就停；搬过去的封面改走 thumb:// 缩略图地址，快照里不再背 base64。 */
let coverMigrating = false
function scheduleCoverMigration() {
  if (coverMigrating) return
  coverMigrating = true
  const step = async () => {
    let changed = false
    try {
      changed = await ensureCoverImages({ max: 1 })
    } catch (e) {
      console.warn('[cover migrate] failed', e)
    }
    if (changed) {
      const next = () => setTimeout(step, 120)
      if (typeof requestIdleCallback === 'function') requestIdleCallback(next, { timeout: 2000 })
      else next()
    } else {
      coverMigrating = false
    }
  }
  const kick = () => setTimeout(step, 600)
  if (typeof requestIdleCallback === 'function') requestIdleCallback(kick, { timeout: 2500 })
  else kick()
}
</script>

<template>
  <div class="app">
    <TopBar />
    <div class="body">
      <!-- 书架常驻：进详情再返回时组件不销毁，滚动位置与封面纹理都留着，不会先闪一遍占位图 -->
      <KeepAlive>
        <Bookshelf v-if="!detail" />
      </KeepAlive>
      <CardDetail v-if="detail" :item="detail" />
    </div>
    <StStatusBar />
    <ScanBubble />
    <BgTask />
    <ImportDialog v-if="store.importDialog.visible" />
    <SettingsPanel v-if="store.settingsPanel.visible" />
    <WorldBackupFolder v-if="store.wbFolder.visible && wbFolderCur" />
    <DcDialog v-if="store.dcDialog.visible" />
    <ContextMenu />
    <!-- 首次使用初始化指引：没看过才自动弹（localStorage 里 onboarded 为真就不再打扰） -->
    <FirstRunGuide v-if="store.firstRun.visible" />
    <OnboardTour v-if="store.onboardTour.visible" />
    <!-- 右下角：软件更新 / 酒馆扩展版本不匹配 -->
    <UpdateToast />
    <transition name="toast">
      <div v-if="store.toast.visible" class="toast">{{ store.toast.text }}</div>
    </transition>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.toast {
  position: fixed;
  left: 50%;
  bottom: 32px;
  transform: translateX(-50%);
  padding: 9px 18px;
  border-radius: 999px;
  background: var(--panel-fly);
  border: 1px solid var(--line);
  color: var(--text);
  box-shadow: var(--shadow);
  font-size: 12.5px;
  z-index: 600;
  max-width: 76vw;
  text-align: center;
}
.toast-enter-active,
.toast-leave-active { transition: all 0.22s ease; }
.toast-enter-from,
.toast-leave-to { opacity: 0; transform: translate(-50%, 8px); }
</style>
