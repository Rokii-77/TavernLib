<script setup>
/* 首启之后的界面指引：气泡依次指向导入、详情、设置里的关键位置。
 * 需要先有内容的步骤用「演示条目」（store.startTourDemo，带 demoTour 标记，不落盘）；
 * 指引结束即移除演示条目，用户的资料库不受影响。 */
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import {
  store,
  endOnboardTour,
  openImportWith,
  closeImport,
  addTourDemoImportRow,
  dropTourDemoImportRows,
  startTourDemo,
  stopTourDemo,
  TOUR_DEMO_IDS
} from '../store.js'

const steps = [
  {
    sel: '[data-guide="import-btn"]',
    title: '从这里导入',
    text: '右上角「导入」：链接、文件、酒馆三种来源都在里面。',
    before: () => {
      store.settingsPanel.visible = false
      store.currentId = null
      dropTourDemoImportRows()
      closeImport()
    }
  },
  {
    sel: '[data-guide="import-link"]',
    title: '链接导入',
    text: '一行一条：文件直链和 DC 帖子链接可以一起贴，帖子标题会自动绑成条目名。',
    before: () => {
      openImportWith([], 'file')
      addTourDemoImportRow()
    }
  },
  {
    sel: '[data-guide="import-dc"]',
    title: '每条后面填 DC 链接',
    text: '每行末尾的「来源链接」填 DC 帖子地址，导入后标题一变就算有新版本。',
    before: () => {
      openImportWith([], 'file')
      addTourDemoImportRow()
    }
  },
  {
    sel: '[data-guide="import-file"]',
    title: '文件导入',
    text: '拖进窗口或点击选择：角色卡 PNG、世界书 / 预设 JSON、美化 ZIP 都行。',
    before: () => {
      openImportWith([], 'file')
      addTourDemoImportRow()
    }
  },
  {
    sel: '[data-guide="import-st"]',
    title: '酒馆导入',
    text: '从酒馆直接导入：把酒馆里已有的卡、世界书、预设读进资料库。',
    before: () => {
      openImportWith([], 'file')
      addTourDemoImportRow()
    }
  },
  {
    sel: '[data-guide="detail-dc"]',
    title: '详情里的 DC 链接',
    text: '填 DC 帖子链接，后台静默抓标题；右键标题还有「立即检查这个条目」。',
    before: () => {
      closeImport()
      startTourDemo()
      store.tab = 'characters'
      store.currentId = TOUR_DEMO_IDS.char
    }
  },
  {
    sel: '[data-guide="detail-version-ops"]',
    title: '更新与新建',
    text: '「更新到酒馆」用日期最新那版直接写进酒馆；版本行右键「新建到酒馆」，把某一版另存成一份新的。',
    before: () => {
      store.tab = 'characters'
      store.currentId = TOUR_DEMO_IDS.char
    }
  },
  {
    sel: '[data-guide="detail-theme-preview"]',
    title: '美化效果预览',
    text: '美化条目直接还原酒馆真实效果：整体界面 / 文字效果 / 字体，电脑端手机端都能切。',
    before: () => {
      store.tab = 'themes'
      store.currentId = TOUR_DEMO_IDS.theme
    }
  },
  {
    sel: '[data-guide="set-backup"]',
    title: '完整备份',
    text: '「维护 → 完整备份」把整个资料库打包成一个压缩包，换机前先留一份。',
    center: true,
    before: () => {
      store.currentId = null
      store.settingsPanel.visible = true
    }
  },
  {
    sel: '[data-guide="set-scan"]',
    title: '扫描下载',
    text: '指定一个下载文件夹，启动时自动把新文件扫出来，右下角气泡里直接导入。',
    center: true,
    before: () => {
      store.settingsPanel.visible = true
    }
  },
  {
    sel: '[data-guide="merge-btn"]',
    title: '合并多来源',
    text: '勾选两条以上「合并所选项」：同一张卡的不同来源合成一条，版本都留下。',
    before: () => {
      store.settingsPanel.visible = false
      store.currentId = null
      startTourDemo()
      store.tab = 'characters'
      store.selectMode = true
      store.selected = [TOUR_DEMO_IDS.char, TOUR_DEMO_IDS.theme]
    }
  }
]

const idx = ref(0)
const rect = ref(null)
const bubble = ref({ top: 0, left: 0 })
const bubbleEl = ref(null)
const cur = computed(() => steps[idx.value])
const isLast = computed(() => idx.value === steps.length - 1)

let timer = null
let centered = false

function measure(tries = 0) {
  const el = document.querySelector(cur.value.sel)
  if (!el) {
    if (tries < 60) timer = setTimeout(() => measure(tries + 1), 50)
    return
  }
  if (cur.value.center && !centered) {
    centered = true
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest' })
    } catch (_) {}
  }
  const r = el.getBoundingClientRect()
  rect.value = { top: r.top, left: r.left, width: r.width, height: r.height }
  place(r)
}

/** 气泡优先贴目标下方，空间不够依次换上方 / 右侧 / 左侧，最后夹在视口内，避免压住高亮区 */
function place(r) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const gap = 12
  const bw = bubbleEl.value ? bubbleEl.value.offsetWidth || 300 : 300
  const bh = bubbleEl.value ? bubbleEl.value.offsetHeight || 170 : 170
  const below = vh - r.bottom
  const above = r.top
  const right = vw - r.right
  const leftSp = r.left
  let top
  let left
  if (below >= bh + gap) {
    top = r.bottom + gap
    left = r.left + r.width / 2 - bw / 2
  } else if (above >= bh + gap) {
    top = r.top - bh - gap
    left = r.left + r.width / 2 - bw / 2
  } else if (right >= bw + gap) {
    top = r.top + r.height / 2 - bh / 2
    left = r.right + gap
  } else if (leftSp >= bw + gap) {
    top = r.top + r.height / 2 - bh / 2
    left = r.left - bw - gap
  } else {
    top = r.bottom + gap
    left = r.left
  }
  bubble.value = {
    left: Math.min(Math.max(left, 12), Math.max(vw - bw - 12, 12)),
    top: Math.min(Math.max(top, 12), Math.max(vh - bh - 12, 12))
  }
}

async function sync() {
  clearTimeout(timer)
  rect.value = null
  centered = false
  try {
    if (cur.value.before) await cur.value.before()
  } catch (_) {}
  await nextTick()
  timer = setTimeout(() => measure(), 40)
}

watch(idx, sync)
onMounted(() => {
  sync()
  window.addEventListener('resize', onResize)
})
onUnmounted(() => {
  clearTimeout(timer)
  window.removeEventListener('resize', onResize)
  closeImport()
  stopTourDemo()
})
function onResize() {
  measure()
}
function next() {
  if (isLast.value) done()
  else idx.value += 1
}
function prev() {
  if (idx.value > 0) idx.value -= 1
}
function done() {
  closeImport()
  stopTourDemo()
  endOnboardTour()
}
</script>

<template>
  <div class="tour">
    <div
      v-if="rect"
      class="hole"
      :style="{ top: rect.top - 4 + 'px', left: rect.left - 4 + 'px', width: rect.width + 8 + 'px', height: rect.height + 8 + 'px' }"
    ></div>
    <div ref="bubbleEl" class="bubble" :style="{ top: bubble.top + 'px', left: bubble.left + 'px' }">
      <h4>{{ cur.title }}</h4>
      <p>{{ cur.text }}</p>
      <div class="ops">
        <span class="cnt">{{ idx + 1 }} / {{ steps.length }}</span>
        <button v-if="idx > 0" class="ghost" @click="prev">上一步</button>
        <button class="ghost" @click="done">跳过</button>
        <button class="primary" @click="next">{{ isLast ? '知道了' : '下一步' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tour {
  position: fixed;
  inset: 0;
  z-index: 900;
  pointer-events: none;
}
.hole {
  position: fixed;
  border-radius: 10px;
  border: 2px solid var(--accent);
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.55);
  transition: top 0.16s ease, left 0.16s ease, width 0.16s ease, height 0.16s ease;
  pointer-events: none;
}
.bubble {
  position: fixed;
  width: 300px;
  max-width: calc(100vw - 24px);
  padding: 12px 14px;
  pointer-events: auto;
  background: var(--panel-solid);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.5);
}
.bubble h4 { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
.bubble p { margin: 0; font-size: 12px; line-height: 1.65; color: var(--text-2); }
.ops { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
.cnt { font-size: 11.5px; color: var(--muted); margin-right: auto; }
.ops button { font-size: 12px; padding: 4px 9px; }
</style>
