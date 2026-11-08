<script setup>
import { ref, computed, onBeforeUnmount, onActivated, watch, nextTick } from 'vue'
import {
  store, currentList, tabs, openItem, openMenu, showToast,
  handleSelectClick, isSelected, selectByRect, clearSelect,
  selectedItems, selectedSet, runUpdateCheck, isBlacklisted, openDcDialog,
  exportSourceFile, exportSourceFiles, addNewVersionFromFile,
  pushItemToTavern, batchPushNew, openImportWith, dcOf, setSortMode, openWbFolder,
  coverThumbOf, coverHashOf, renameItem, mergeItems, categoryOf, catOf,
  refreshTavernCompare, withTavernTarget, presetModelOf, presetNameOf, addTagsToItems, setItemTags,
  tagKeyOf
} from '../store.js'
import { prefetchThumbs } from '../lib/images.js'

const meta = computed(() => tabs.find((t) => t.key === store.tab) || tabs[0])
const gridRef = ref(null)
/** 选中态集合（Set.has，避免模板里对每张卡做 includes 线性扫描） */
const selSet = selectedSet
/** 书架滚动位置（KeepAlive 收起 DOM 后会归零，返回时用它还原） */
let savedScroll = 0

/* ---------- 分批渲染 + 缩略图封面 ----------
 * 1) 先只挂前 CHUNK 张，滚到底再续挂；
 * 2) 封面一律用 thumb://local/<hash>.webp 这个稳定 URL：图片由主进程从缓存读盘，
 *    不进渲染进程内存、也不参与 JS 字符串比较，进详情再返回时同一个地址直接命中浏览器图片缓存；
 * 3) 生成交给主进程后台队列，界面只把需要的哈希丢过去。 */
const CHUNK = 120
const renderLimit = ref(CHUNK)

/* ---------- 预设标签筛选条 ----------
 * 只有 presets 分类出这条：标签取库里现有预设标签的实际值，静态去重展示
 * （全是 gemini 就不会冒出一个空的 claude），点击筛选、再点取消。
 * 标签文本完全按用户自定义的原样显示，不做模型归一化改写。 */
const isPresetTab = computed(() => store.tab === 'presets')

/**
 * 卡片底部最多两个标签：
 * ① 按 tagKeyOf 去重，大小写 / 空白不同但同名的只留一个
 * ② 预设卡片上方已经单独显示过模型标签了，这里不再重复显示同一个模型名
 */
/* 标签只在「预设」分类出现：其它分类整块标签 UI 不渲染（老数据保留不动） */
function cardTagsOf(it) {
  if (!isPresetTab.value) return []
  const arr = Array.isArray(it.tags) ? it.tags : []
  const modelKey = tagKeyOf(presetModelOf(it) || '')
  const seen = new Set()
  const out = []
  for (const t of arr) {
    const v = String(t == null ? '' : t).trim()
    if (!v) continue
    const k = tagKeyOf(v)
    if (!k || seen.has(k)) continue
    if (modelKey && k === modelKey) continue
    seen.add(k)
    out.push(v)
    if (out.length >= 2) break
  }
  return out
}
const tagFilter = ref('')
const presetTagPool = computed(() => {
  if (!isPresetTab.value) return []
  const seen = new Map()
  for (const it of store.items.presets || []) {
    for (const t of it.tags || []) {
      const v = String(t == null ? '' : t).trim()
      if (!v) continue
      const k = tagKeyOf(v)
      if (!seen.has(k)) seen.set(k, v)
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
})
/** 搜索之后再过一层标签筛选 */
const filteredList = computed(() => {
  const list = currentList.value
  const t = tagFilter.value
  if (!isPresetTab.value || !t) return list
  const k = t.toLowerCase()
  return list.filter((it) => (it.tags || []).some((x) => String(x == null ? '' : x).trim().toLowerCase() === k))
})
function toggleTagFilter(t) {
  tagFilter.value = tagFilter.value === t ? '' : t
}
// 切分类 / 标签池里已经没有这个标签 → 清掉筛选，避免出现"筛选着一个不存在的标签"
watch(() => store.tab, () => { tagFilter.value = '' })
watch(presetTagPool, (pool) => {
  if (tagFilter.value && !pool.some((t) => t.toLowerCase() === tagFilter.value.toLowerCase())) tagFilter.value = ''
})

const shownList = computed(() => {
  const list = filteredList.value
  return list.length > renderLimit.value ? list.slice(0, renderLimit.value) : list
})
const restCount = computed(() => Math.max(0, filteredList.value.length - shownList.value.length))

/** 当前分类总数 / 是否在搜索 / 有更新的条目数（用于顶部状态提示） */
const totalInTab = computed(() => (store.items[store.tab] || []).length)
/** 生效中的搜索词：直接取决于 store.search，清空后立刻为空，提示条随之消失 */
const activeKeyword = computed(() => String(store.search == null ? '' : store.search).trim())
const searching = computed(() => !!activeKeyword.value)
const updateCount = computed(() => (store.items[store.tab] || []).filter((it) => it.dc?.hasUpdate).length)

/** 卡片 id → 封面缩略图 URL（一次算好，模板里只做 Map.get） */
const coverMap = computed(() => {
  const m = new Map()
  for (const it of shownList.value) m.set(it.id, coverThumbOf(it))
  return m
})

function coverUrl(it) {
  return coverMap.value.get(it.id) || ''
}

function isCoverOn(it) {
  return !!coverUrl(it)
}

function coverStyle(it) {
  const h = it.hue ?? 30
  const base = `linear-gradient(150deg, hsl(${h} 46% 34%), hsl(${(h + 24) % 360} 38% 17%) 68%, #13161a)`
  // 按需加载：只有进入视口（含预滚 400px）的卡片才挂缩略图 URL。
  // 一次性给上百张卡挂 background-image 会让浏览器同时发起上百个 thumb:// 请求，
  // 主进程要逐张解码整卡 PNG 再编码 webp，启动直接卡住。
  if (!visibleIds.value.has(it.id)) return { background: base }
  const url = coverUrl(it)
  if (!url) return { background: base }
  return {
    backgroundImage: `url("${url}")`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
    backgroundColor: 'var(--panel)'
  }
}

function loadMore() {
  if (restCount.value <= 0) return
  renderLimit.value += CHUNK
}

/** 滚动到底部附近续挂下一批 */
function onGridScroll() {
  const el = gridRef.value
  if (!el) return
  savedScroll = el.scrollTop
  if (restCount.value <= 0) return
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 500) loadMore()
}

// 分类 / 排序变了：渲染窗口回到第一批
watch(
  () => [store.tab, store.settings.sortMode],
  () => {
    renderLimit.value = CHUNK
  }
)

// 搜索词变了 / 被清空：渲染窗口回到第一批 + 滚动回顶部（否则过滤后仍停在原来的深位置，
// 看起来像"没过滤、还停在第几十页"）。searchEpoch 保证「清空」这个动作一定触发复位。
watch(
  [activeKeyword, () => store.searchEpoch, tagFilter],
  () => {
    renderLimit.value = CHUNK
    savedScroll = 0
    nextTick(() => {
      const el = gridRef.value
      if (el) el.scrollTop = 0
    })
  }
)

/** 已进入视口的卡片 id（只有这些才请求缩略图） */
const visibleIds = ref(new Set())
let io = null
let prefetchTimer = 0

function bindCard(id, el) {
  if (!io || !el) return
  if (el.dataset.observed === '1') return
  el.dataset.observed = '1'
  el.dataset.cid = id
  io.observe(el)
}

/** 视口内卡片的封面哈希丢给主进程后台排队生成（只处理看得见的，避免启动时批量解码） */
function prefetchVisible() {
  if (prefetchTimer) return
  prefetchTimer = window.setTimeout(() => {
    prefetchTimer = 0
    const ids = visibleIds.value
    if (!ids.size) return
    const byId = new Map(shownList.value.map((it) => [it.id, it]))
    const hashes = []
    for (const id of ids) {
      const it = byId.get(id)
      if (it) hashes.push(coverHashOf(it))
    }
    prefetchThumbs(hashes)
  }, 120)
}

function setupObserver() {
  if (typeof IntersectionObserver !== 'function') return
  io = new IntersectionObserver(
    (entries) => {
      let changed = false
      const next = new Set(visibleIds.value)
      for (const e of entries) {
        const id = e.target.dataset.cid
        if (!id) continue
        if (e.isIntersecting) {
          if (!next.has(id)) {
            next.add(id)
            changed = true
          }
        } else if (next.has(id)) {
          next.delete(id)
          changed = true
        }
      }
      if (changed) {
        visibleIds.value = next
        prefetchVisible()
      }
    },
    { root: gridRef.value || null, rootMargin: '400px 0px', threshold: 0.01 }
  )
}

onActivated(() => {
  if (!io) setupObserver()
})

onBeforeUnmount(() => {
  if (io) {
    io.disconnect()
    io = null
  }
  if (prefetchTimer) {
    clearTimeout(prefetchTimer)
    prefetchTimer = 0
  }
})

// 列表 / 分批窗口变化：重新观察当前这批卡片
watch(
  shownList,
  () => {
    if (!io) setupObserver()
    nextTick(() => {
      const el = gridRef.value
      if (!el || !io) return
      io.disconnect()
      for (const node of el.querySelectorAll('.card[data-cid]')) {
        node.dataset.observed = '1'
        io.observe(node)
      }
    })
  },
  { immediate: true }
)

/* ---------- 进详情再返回：保位置 ----------
 * 组件被 KeepAlive 收起来时 DOM 会被移出文档，滚动位置会归零，返回时手动还原。 */
function restoreScroll() {
  const el = gridRef.value
  if (!el || savedScroll <= 0) return
  if (el.scrollHeight <= el.clientHeight) return
  if (Math.abs(el.scrollTop - savedScroll) <= 1) return
  el.scrollTop = savedScroll
}

onActivated(() => {
  // 刚插回文档时还没完成布局，连续几帧尝试直到位置还原
  let tries = 0
  const tick = () => {
    restoreScroll()
    const el = gridRef.value
    if (el && Math.abs(el.scrollTop - savedScroll) > 1 && tries++ < 30) requestAnimationFrame(tick)
  }
  nextTick(tick)
})

/* ---------- 框选 ---------- */
const box = ref({ active: false, x1: 0, y1: 0, x2: 0, y2: 0 })
const hitIds = ref([])
const hitSet = computed(() => new Set(hitIds.value))

/* 书架卡片上那行备注：
   1) 有真备注（详情页标题下面的备注 / 导入时自己填的）就用它；
   2) 只有「来自酒馆」这类系统占位时让位给版本备注（详情页版本行里写的备注），
      否则用户写了版本备注也永远被占位文字盖住，看起来就是「备注不显示」；
   3) 两者都没有就取最新一个有备注的版本。 */
const PLACEHOLDER_DESC = new Set(['来自酒馆', '（由导入生成）', '由导入生成', '导入生成'])
function shelfNote(it) {
  const d = String(it.desc || '').trim()
  const vs = it.versions || []
  let note = ''
  for (let i = vs.length - 1; i >= 0; i--) {
    const n = String((vs[i] && vs[i].note) || '').trim()
    if (n) {
      note = n
      break
    }
  }
  if (note && (!d || PLACEHOLDER_DESC.has(d))) return note
  return d || note || '—'
}
let dragging = false
let additive = false

function onMouseDown(e) {
  // Win10 原生逻辑：不用先开什么「多选模式」，空白处按住左键拖就能框选；
  // 按住 Ctrl 拖是在已有选中里追加，不按则是替换。
  if (e.button !== 0) return
  if (e.target.closest('.card') || e.target.closest('.selbar')) return
  dragging = true
  additive = e.ctrlKey || e.metaKey || e.shiftKey
  box.value = { active: true, x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY }
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}

function computeHits() {
  const b = box.value
  const left = Math.min(b.x1, b.x2)
  const right = Math.max(b.x1, b.x2)
  const top = Math.min(b.y1, b.y2)
  const bottom = Math.max(b.y1, b.y2)
  const ids = []
  const root = gridRef.value
  if (!root) return ids
  // 直接查 DOM，避免给每张卡绑一个 ref 闭包（每次重渲染都解绑重绑）
  for (const el of root.querySelectorAll('.card')) {
    const r = el.getBoundingClientRect()
    if (r.right > left && r.left < right && r.bottom > top && r.top < bottom) {
      const id = el.dataset.id
      if (id) ids.push(id)
    }
  }
  return ids
}

/** 时间排序：两个方向来回切 */
function toggleDateSort() {
  setSortMode(store.settings.sortMode === 'date-asc' ? 'date-desc' : 'date-asc')
}

/** 名称排序 */
function sortByName() {
  setSortMode('name')
}

function onMouseMove(e) {
  if (!dragging) return
  box.value.x2 = e.clientX
  box.value.y2 = e.clientY
  hitIds.value = computeHits()
}

function onMouseUp() {
  if (!dragging) return
  dragging = false
  const ids = hitIds.value
  if (ids.length) selectByRect(ids, additive)
  box.value.active = false
  hitIds.value = []
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
}

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
})

/* ---------- 点击 ---------- */
/* 对齐 Win10：单击选中（Ctrl 追加、Shift 连选），双击才打开 */
function onCardClick(it, e) {
  handleSelectClick(it.id, e)
  if (e.ctrlKey || e.metaKey || e.shiftKey) return
  if (it.kind === 'world-backup' && !store.selected.length) return
}

function onCardDblClick(it) {
  if (it.kind === 'world-backup') return openWbFolder(it)
  openItem(it.id)
}

/* ---------- 批量操作 ---------- */
const batchCount = computed(() => store.selected.length)

function batchCheck() {
  runUpdateCheck('selected')
}

async function batchImport() {
  const list = selectedItems.value
  if (!list.length) {
    showToast('先选中要导入的条目')
    return
  }
  if (!String(store.settings.tavernPath || '').trim()) {
    showToast('先在设置里填酒馆安装路径')
    return
  }
  await batchPushNew(list)
}

async function batchExport() {
  await exportSourceFiles(selectedItems.value)
}

async function updateToTavern(it) {
  const cat = catOf(it)
  const label = cat === 'characters' ? '角色卡' : cat === 'worldbooks' ? '世界书' : cat === 'presets' ? '预设' : cat === 'themes' ? '美化' : '条目'
  /* 书架入口没有「选中哪一版」的概念，就按界面默认的当前版本（最新版）推。
     这里必须显式把版本传下去：store 侧已改成「不传 version 直接报错」，
     静默回退最新版正是「右键旧版本却写了最新版」的根源。 */
  const v = latestVersionOf(it)
  if (!v) {
    showToast('这个条目还没有版本')
    return
  }
  const ok = await askCnf({
    title: '更新到酒馆',
    message:
      `把「${it.name}」的「${v.name}」这一版更新到酒馆？\n\n` +
      (cat === 'characters'
        ? '酒馆里有同名角色就替换，没有就新建一份。'
        : cat === 'themes'
          ? '会写成酒馆 themes 目录里的一个主题 json，在酒馆「主题」里刷新即可看到。'
          : '酒馆里有同名内容就替换，没有就新建一份，原文件会先备份。'),
    okText: '更新到酒馆'
  })
  if (!ok) return
  /* 美化没有「同名替换哪一张」的概念，直接写主题文件，不走角色卡那套对比选卡流程 */
  if (cat === 'themes') {
    await pushItemToTavern(it, { version: v })
    return
  }
  try {
    /* 同名多卡（酒馆允许同名并存）时必须让用户点明写哪一张，不能按名字猜 */
    if (!(it.stCards || []).length) {
      try {
        await refreshTavernCompare(it)
      } catch (_) {}
    }
    await withTavernTarget(it, label, async (card) => {
      try {
        await pushItemToTavern(it, {
          mode: 'replace',
          version: v,
          stAvatar: card ? card.avatar : '',
          /* card 有值代表用户刚在菜单里点明了写哪一份，主进程就不用再弹一次窗 */
          pickAvatar: card ? card.avatar : '',
          replaceWorld: false,
          backupOldWorld: false
        })
      } catch (e) {
        showToast('更新失败：' + (e && e.message ? e.message : String(e)))
      }
    })
  } catch (e) {
    showToast('更新失败：' + (e && e.message ? e.message : String(e)))
  }
}

/** 条目的最新版（按排序规则取第一个版本号最大的） */
function latestVersionOf(it) {
  const vs = (it.versions || []).slice()
  if (!vs.length) return null
  const cur = vs.find((x) => x.current)
  if (cur) return cur
  /* 同一天可能有多个版本（同日多次录入），比较器返回 0 时 Array.sort 不稳定，
     取到哪一版不确定 —— 显式在日期相同时用后出现的那条（录入更晚）。 */
  const order = new Map(vs.map((x, i) => [x, i]))
  vs.sort((a, b) => {
    const d = String(b.date || '').localeCompare(String(a.date || ''))
    if (d !== 0) return d
    return (order.get(b) || 0) - (order.get(a) || 0)
  })
  return vs[0]
}

/* ---------- 应用内文本输入弹窗 ----------
 * Electron 的 Chromium 不支持 window.prompt（调用直接返回空值），
 * 重命名 / 改日期必须走页面内弹窗，否则点了没反应。
 */
const askOpen = ref(false)
const askTitle = ref('')
const askValue = ref('')
const askPlaceholder = ref('')
const askMultilineHint = ref('')
let askResolve = null
const askInputRef = ref(null)

function askText({ title, value = '', placeholder = '', hint = '' }) {
  askTitle.value = title
  askValue.value = value
  askPlaceholder.value = placeholder
  askMultilineHint.value = hint
  askOpen.value = true
  nextTick(() => {
    const el = askInputRef.value
    if (el) {
      el.focus()
      el.select()
    }
  })
  return new Promise((resolve) => {
    askResolve = resolve
  })
}
function askCancel() {
  askOpen.value = false
  const r = askResolve
  askResolve = null
  if (r) r(null)
}
function askConfirm() {
  const v = String(askValue.value || '').trim()
  askOpen.value = false
  const r = askResolve
  askResolve = null
  if (r) r(v)
}

/* ---------- 应用内确认弹窗 ----------
 * window.confirm 在 Electron/Chromium 里是**同步阻塞**渲染进程的原生对话框：
 * 弹窗一旦被窗口遮挡或未拿到焦点，整个界面就永久无响应，看起来就是"点了按钮
 * 直接黑屏/假死"。凡是搬运、覆盖酒馆文件这类关键动作，一律走页面内弹层。
 */
const cnfOpen = ref(false)
const cnfTitle = ref('')
const cnfMsg = ref('')
const cnfOkText = ref('确定')
let cnfResolve = null

function askCnf({ title = '确认', message = '', okText = '确定' } = {}) {
  cnfTitle.value = title
  cnfMsg.value = message
  cnfOkText.value = okText
  cnfOpen.value = true
  return new Promise((resolve) => {
    cnfResolve = resolve
  })
}
function cnfFinish(v) {
  cnfOpen.value = false
  const r = cnfResolve
  cnfResolve = null
  if (r) r(v)
}

function batchDelete() {
  const items = selectedItems.value
  if (!items.length) return
  const ok = window.confirm(`确认从资料库移除选中的 ${items.length} 项？\n不会删除酒馆里的文件`)
  if (!ok) return
  for (const t of tabs) {
    const arr = store.items[t.key] || []
    store.items[t.key] = arr.filter((x) => !store.selected.includes(x.id))
  }
  showToast(`已移除 ${items.length} 项`)
  clearSelect()
}

/* ---------- 重命名 / 合并 ---------- */

function itemsOfCategory(cat) {
  return store.items[cat] || []
}

/** 选中项是否全部在同一分类，返回分类 key（跨分类返回空串） */
function selectedCategory() {
  const cats = new Set()
  for (const t of tabs) {
    for (const it of itemsOfCategory(t.key)) if (store.selected.includes(it.id)) cats.add(t.key)
  }
  return cats.size === 1 ? [...cats][0] : ''
}

/* ---------- 预设标签编辑 ---------- */

/** 单个预设：覆盖式编辑标签（空格 / 逗号分隔） */
async function doEditTags(it) {
  const cur = (it.tags || []).join(' ')
  const v = await askText({
    title: `编辑「${it.name}」的标签`,
    value: cur,
    placeholder: '例如 gemini 3.1p 破甲',
    hint: '用空格或逗号分隔多个标签；清空后保存即删除全部标签'
  })
  if (v == null) return
  setItemTags(it, v)
  const now = (it.tags || []).join(' ') || '（无标签）'
  showToast(`标签已更新：${now}`)
}

/** 多个预设：把输入的标签追加给每一项（已有同名标签自动跳过） */
async function doBatchAddTags(items) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return showToast('没有选中预设')
  const v = await askText({
    title: `给 ${list.length} 个预设加标签`,
    value: '',
    placeholder: '例如 gemini',
    hint: '多个标签用空格或逗号分隔；只追加，不会删掉原有标签'
  })
  if (v == null) return
  const r = addTagsToItems(list, v)
  if (!r.added) return showToast('这些预设已经有相同标签了')
  showToast(`已给 ${r.total} 个预设加上标签，新增 ${r.added} 处`)
}

async function doRename(it) {
  const cur = String(it.name || '')
  const name = await askText({
    title: `重命名「${cur}」`,
    value: cur,
    placeholder: '新的名字',
    hint: '酒馆侧同名对比也按这个名字走'
  })
  if (name == null) return
  if (!name) return showToast('名字不能为空')
  if (name === cur) return
  let r = renameItem(it, name)
  if (!r.ok && r.duplicate) {
    const ok = window.confirm(
      `这个分类里已经有「${name}」了。\n\n仍要改名成同名吗？`
    )
    if (!ok) return
    r = renameItem(it, name, { allowDuplicate: true })
  }
  if (!r.ok) return showToast('重命名失败：' + (r.error || '未知原因'))
  showToast(`已重命名：${r.old} → ${r.name}`)
}

/**
 * 合并选中项为同一角色的多个版本
 * @param {string} targetId 指定保留哪一项（默认右键点的那项，或选中的第一项）
 */
async function mergeSelected(targetId) {
  const ids = store.selected.slice()
  if (ids.length < 2) return showToast('先选中至少两项再合并')
  const cat = selectedCategory()
  if (!cat) return showToast('只能合并在同一分类里的条目')
  const list = itemsOfCategory(cat).filter((x) => ids.includes(x.id))
  if (list.length < 2) return showToast('选中的条目不够两项')
  const target = list.find((x) => x.id === targetId) || list[0]
  const others = list.filter((x) => x.id !== target.id)
  const versionTotal = list.reduce((n, x) => n + (x.versions || []).length, 0)
  const othersNames = others.map((x) => `「${x.name}」(${(x.versions || []).length} 版)`).join('、')
  const ok = window.confirm(
    `合并选中的 ${list.length} 项为同一个条目的多个版本？\n\n` +
      `保留条目：「${target.name}」${(target.versions || []).length} 版\n` +
      `并入：${othersNames}\n\n` +
      `合计 ${versionTotal} 个版本，内容相同的版本自动去重，相同图片共用一份。\n` +
      `合并后这 ${others.length} 项会从资料库移除，酒馆里的文件不动。`
  )
  if (!ok) return
  const r = mergeItems(ids, { targetId: target.id })
  if (!r.ok) return showToast('合并失败：' + (r.error || '未知原因'))
  showToast(
    `已合并到「${r.name}」：现 ${r.total} 版` +
      (r.moved ? `，并入 ${r.moved} 版` : '') +
      (r.dup ? `，去重跳过 ${r.dup} 版` : '')
  )
  /* 合并后条目名变了（方亦楷哇哦 + 哦哦 + 好的 → 方亦楷），
     立刻重扫一次酒馆，把这几张同名副本重新挂到条目上，更新时才能列出全部副本让用户选 */
  try {
    await refreshTavernCompare(target)
  } catch (_) {}
}

function cardMenu(e, it) {
  const catKey = categoryOf(it)
  const unit = catKey === 'characters' ? '角色卡' : catKey === 'worldbooks' ? '世界书' : catKey === 'presets' ? '预设' : catKey === 'themes' ? '美化' : '其他'
  const menu = []
  // 只要选了好几项，菜单第一项就是「合并所选项」，右键点哪张卡就以哪张卡为主条目
  if (store.selected.length > 1) {
    const primary = selSet.value.has(it.id) ? it.id : store.selected[0]
    menu.push(
      {
        label: `合并所选项 ${store.selected.length}`,
        hint: selSet.value.has(it.id) ? '以当前项为主条目' : '以已选第一项为主条目',
        action: () => mergeSelected(primary)
      },
      { divider: true }
    )
  }
  menu.push(
    { label: '打开详情', action: () => openItem(it.id) },
    { label: '重命名', action: () => doRename(it) }
  )
  // 预设专属：单条可编辑标签；多选可批量加标签
  if (catKey === 'presets') {
    menu.push({ label: '编辑标签', hint: '空格或逗号分隔', action: () => doEditTags(it) })
    if (store.selected.length > 1) {
      const picked = (store.items.presets || []).filter((x) => selSet.value.has(x.id))
      menu.push({
        label: '批量加标签',
        hint: '给所有已选预设追加标签',
        action: () => doBatchAddTags(picked)
      })
    }
  }
  menu.push(
    { divider: true },
    { label: it.dc?.url ? '修改 DC 链接' : '设置 DC 链接', action: () => openDcDialog(it) },
    { label: isBlacklisted(it) ? '已在黑名单' : '加入更新黑名单', action: () => {
      store.settings.blacklist = Array.from(new Set([...store.settings.blacklist, it.name]))
      showToast(`已加入黑名单：${it.name}`)
    } },
    { divider: true },
    { label: '更新到酒馆', action: () => updateToTavern(it) },
    { divider: true },
    { label: '导出源文件', action: () => exportSourceFile(it) },
    { divider: true },
    { label: '从库中移除', danger: true, action: () => {
      const ok = window.confirm(`确认移除「${it.name}」？`)
      if (!ok) return
      store.items[store.tab] = (store.items[store.tab] || []).filter((x) => x.id !== it.id)
      showToast('已移除')
    } }
  )
  openMenu(e, menu)
}
</script>

<template>
  <section class="shelf">
    <div class="shelf-head">
      <div class="left">
        <h1>{{ meta.label }}</h1>
        <span class="count">共 {{ filteredList.length }} {{ meta.unit }}</span>
        <span v-if="searching" class="count filt">
          筛选「{{ activeKeyword }}」命中 {{ filteredList.length }} / {{ totalInTab }}
        </span>
        <span v-else-if="tagFilter" class="count filt">标签「{{ tagFilter }}」命中 {{ filteredList.length }} / {{ totalInTab }}</span>
        <span v-if="updateCount" class="count upd">有更新 {{ updateCount }}</span>
        <span v-if="store.check.running" class="checking">正在后台检查更新…</span>
        <span v-else-if="store.check.lastAt" class="checking dim">上次检查 {{ store.check.lastAt }}</span>
      </div>
      <div class="right sort-group">
        <button
          class="ghost sort-ico"
          :class="{ on: store.settings.sortMode === 'name' }"
          title="按名称排序"
          @click="sortByName"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 18V6l5 12V6" />
            <path d="M13 10h6" />
            <path d="M13 18h6" />
            <path d="M13 14h4" />
          </svg>
        </button>
        <button
          class="ghost sort-ico"
          :class="{ on: store.settings.sortMode !== 'name' }"
          :title="store.settings.sortMode === 'date-asc' ? '时间：旧的在前' : '时间：新的在前'"
          @click="toggleDateSort"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="12" r="7.5" />
            <path d="M11 8v4.2l2.8 1.9" />
          </svg>
          <span class="dir">{{ store.settings.sortMode === 'date-asc' ? '↑' : '↓' }}</span>
        </button>
      </div>
    </div>

    <!-- 预设标签筛选条：搜索框下方单独一行，只有预设分类且库里确实有标签时才出现 -->
    <div v-if="isPresetTab && presetTagPool.length" class="tagbar">
      <span class="tb-label">标签</span>
      <button
        v-for="t in presetTagPool"
        :key="t"
        class="tag-chip"
        :class="{ on: tagFilter === t }"
        :title="tagFilter === t ? `取消「${t}」筛选` : `只看带「${t}」标签的预设`"
        @click="toggleTagFilter(t)"
      >{{ t }}</button>
      <button v-if="tagFilter" class="tb-clear" @click="tagFilter = ''">清除筛选</button>
    </div>

    <div
      ref="gridRef"
      class="grid-wrap"
      @mousedown="onMouseDown"
      @scroll.passive="onGridScroll"
    >
      <div v-if="filteredList.length" class="grid">
        <article
          v-for="it in shownList"
          :key="it.id"
          :data-id="it.id"
          :ref="(el) => bindCard(it.id, el)"
          class="card"
          :class="{ picked: selSet.has(it.id), hovering: hitSet.has(it.id) }"
          @click="onCardClick(it, $event)"
          @dblclick="onCardDblClick(it)"
          @contextmenu="cardMenu($event, it)"
        >
          <div class="cover" :style="coverStyle(it)">
            <span v-if="!isCoverOn(it)" class="initial">{{ (isPresetTab ? presetNameOf(it) : it.name).slice(0, 1) }}</span>
            <span v-if="it.dc?.hasUpdate" class="badge-update" title="DC 有新版本"></span>
            <!-- 预设首页只显示预设名：版本号统一收到详情页，封面角上不再压版本号 -->
            <span
              v-if="!isPresetTab"
              class="ver"
              :title="it.stVersion ? `酒馆版本 ${it.stVersion}` : ''"
            >{{ it.stVersion }}</span>
            <span
              v-if="selSet.has(it.id)"
              class="check on"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4">
                <path d="m4 12.5 5.5 5.5L20 7" />
              </svg>
            </span>
          </div>
          <div class="meta">
            <div class="title">{{ isPresetTab ? presetNameOf(it) : it.name }}</div>
            <div class="desc">
              <template v-if="it.kind === 'world-backup'">世界书备份 · {{ (it.backups || []).length }} 份</template>
              <template v-else>{{ shelfNote(it) }}</template>
            </div>
            <!-- 预设：模型名以标签形式挂在备注下方，字号比备注略小 -->
            <div v-if="isPresetTab && presetModelOf(it)" class="model-tag" :title="`识别到的模型：${presetModelOf(it)}`">
              {{ presetModelOf(it) }}
            </div>
            <div class="foot">
              <div class="tags">
                <span v-for="t in cardTagsOf(it)" :key="t" class="tag">{{ t }}</span>
              </div>
              <span class="vcount">{{ it.kind === 'world-backup' ? '文件夹' : `${it.versions.length} 版` }}</span>
            </div>
          </div>
        </article>
      </div>

      <div v-else class="empty">
        <p>没有匹配的{{ meta.label }}</p>
        <span>换个关键词，或点击右上角「导入」添加</span>
      </div>

      <div v-if="restCount" class="load-more">
        <button class="ghost" @click="loadMore">继续加载 {{ restCount }}</button>
      </div>

      <div
        v-if="box.active"
        class="selbox"
        :style="{
          left: Math.min(box.x1, box.x2) + 'px',
          top: Math.min(box.y1, box.y2) + 'px',
          width: Math.abs(box.x2 - box.x1) + 'px',
          height: Math.abs(box.y2 - box.y1) + 'px'
        }"
      ></div>
    </div>

    <transition name="bar">
      <div v-if="batchCount" class="selbar" @mousedown.stop>
        <span class="num">
          <svg
            v-if="batchCount === 1"
            class="num-tick"
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3.4"
          >
            <path d="m4 12.5 5.5 5.5L20 7" />
          </svg>
          已选 {{ batchCount }} 项
        </span>
        <div class="ops">
          <button v-if="isPresetTab" @click="doBatchAddTags(selectedItems)">加标签</button>
          <button @click="batchCheck">检查更新</button>
          <button @click="batchImport">导入到酒馆</button>
          <button @click="batchExport">导出源文件</button>
          <button data-guide="merge-btn" :disabled="store.selected.length < 2" @click="mergeSelected()">合并所选项</button>
          <button class="danger" @click="batchDelete">移除</button>
        </div>
        <button class="ghost cancel" @click="clearSelect">取消选择</button>
      </div>
    </transition>

    <!-- 应用内确认弹窗（替代会阻塞渲染进程的 window.confirm） -->
    <div v-if="cnfOpen" class="ask-mask" @click.self="cnfFinish(false)" @mousedown.stop>
      <div class="ask-box">
        <h3>{{ cnfTitle }}</h3>
        <p class="ask-msg">{{ cnfMsg }}</p>
        <div class="ask-foot">
          <button class="ghost" @click="cnfFinish(false)">取消</button>
          <button class="primary" @click="cnfFinish(true)">{{ cnfOkText }}</button>
        </div>
      </div>
    </div>

    <!-- 应用内文本输入弹窗（Electron 不支持 window.prompt） -->
    <div v-if="askOpen" class="ask-mask" @click.self="askCancel" @mousedown.stop>
      <div class="ask-box">
        <h3>{{ askTitle }}</h3>
        <input
          ref="askInputRef"
          v-model="askValue"
          class="ask-input"
          :placeholder="askPlaceholder"
          @keydown.enter.prevent="askConfirm"
          @keydown.esc.prevent="askCancel"
        />
        <p v-if="askMultilineHint" class="ask-hint">{{ askMultilineHint }}</p>
        <div class="ask-foot">
          <button class="ghost" @click="askCancel">取消</button>
          <button class="primary" @click="askConfirm">确定</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.shelf {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}
.shelf-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  padding: 16px 22px 12px;
  flex-shrink: 0;
}
.shelf-head .left { display: flex; align-items: baseline; gap: 10px; }
.shelf-head .right { display: flex; align-items: center; gap: 6px; }
.sort-ico { display: inline-flex; align-items: center; gap: 2px; padding: 4px 7px; line-height: 1; color: var(--muted); }
.sort-ico.on { color: var(--text); background: var(--panel-3); }
.sort-ico .dir { font-size: 10px; opacity: 0.9; }
h1 { font-size: 16px; font-weight: 600; margin: 0; letter-spacing: 0.4px; }
.count { font-size: 12px; color: var(--muted); }
.count.filt { color: var(--accent-2); }
.count.upd {
  color: #20180a;
  background: linear-gradient(180deg, var(--accent-2), var(--accent));
  border-radius: 999px;
  padding: 1px 8px;
  font-weight: 600;
}
.checking { font-size: 11.5px; color: var(--accent-2); }
.checking.dim { color: #5f6875; }
.shelf-head .right { display: flex; gap: 6px; }
.shelf-head .right button { font-size: 12px; padding: 5px 10px; }

.grid-wrap {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 22px 90px;
  position: relative;
}
.load-more {
  display: flex;
  justify-content: center;
  padding: 16px 0 8px;
}
.load-more .ghost {
  font-size: 12.5px;
  padding: 7px 16px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(152px, 1fr));
  gap: 16px;
  align-content: start;
}

.card {
  border-radius: 12px;
  background: var(--panel);
  border: 1px solid var(--line-soft);
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;
  position: relative;
}
.card:hover {
  transform: translateY(-3px);
  border-color: rgba(212, 162, 76, 0.42);
  box-shadow: 0 12px 26px rgba(0, 0, 0, 0.4);
}
.card.picked {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px rgba(212, 162, 76, 0.5), 0 10px 22px rgba(0, 0, 0, 0.35);
}
.card.hovering {
  border-color: rgba(240, 198, 117, 0.85);
}

.cover {
  position: relative;
  aspect-ratio: 3 / 3.4;
  display: grid;
  place-items: center;
}
.cover::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, transparent 45%, rgba(10, 12, 15, 0.65));
  pointer-events: none;
}
.initial {
  font-size: 40px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.28);
  letter-spacing: 2px;
  z-index: 1;
}
.ver {
  position: absolute;
  left: 8px;
  bottom: 7px;
  z-index: 2;
  font-size: 10.5px;
  color: rgba(255, 255, 255, 0.72);
  background: rgba(0, 0, 0, 0.34);
  padding: 1px 6px;
  border-radius: 5px;
}
.badge-update {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  width: 9px;
  height: 9px;
  border-radius: 2px;
  background: var(--accent-2);
  box-shadow: 0 0 0 3px rgba(212, 162, 76, 0.16);
  animation: pulse 1.9s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

.check {
  position: absolute;
  top: 7px;
  left: 7px;
  z-index: 3;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  border: 1.6px solid rgba(255, 255, 255, 0.5);
  background: rgba(10, 12, 15, 0.45);
  display: grid;
  place-items: center;
  color: #20180a;
}
.check.on {
  background: linear-gradient(180deg, var(--accent-2), var(--accent));
  border-color: transparent;
  animation: check-pop 0.16s ease-out;
}
@keyframes check-pop {
  from { transform: scale(0.6); opacity: 0.4; }
  to { transform: scale(1); opacity: 1; }
}

.meta { padding: 9px 11px 10px; }
.title {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.desc {
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.45;
  height: 2.9em;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.foot {
  margin-top: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.tags { display: flex; gap: 4px; overflow: hidden; }
.tag {
  font-size: 10.5px;
  color: var(--text-2);
  background: var(--panel-2);
  border-radius: 4px;
  padding: 1px 5px;
  white-space: nowrap;
}
.vcount { font-size: 10.5px; color: #616a78; white-space: nowrap; }

/* 预设卡片上的模型标签：字号比备注小，排在备注下方 */
.model-tag {
  display: inline-block;
  margin-top: 4px;
  max-width: 100%;
  font-size: 10px;
  line-height: 1.5;
  color: #8b6a2f;
  background: rgba(212, 162, 76, 0.14);
  border: 1px solid rgba(212, 162, 76, 0.3);
  border-radius: 4px;
  padding: 0 5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 预设标签筛选条 */
.tagbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 0 2px 10px;
}
.tagbar .tb-label { font-size: 11.5px; color: var(--muted); margin-right: 2px; }
.tag-chip {
  font-size: 11.5px;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid var(--line, rgba(255, 255, 255, 0.12));
  background: var(--panel-2);
  color: var(--text-2);
  cursor: pointer;
  transition: all 0.12s;
}
.tag-chip:hover { border-color: rgba(212, 162, 76, 0.6); color: var(--text); }
.tag-chip.on {
  background: rgba(212, 162, 76, 0.18);
  border-color: rgba(212, 162, 76, 0.75);
  color: #e8c078;
}
.tagbar .tb-clear {
  font-size: 11px;
  color: var(--muted);
  background: none;
  border: none;
  cursor: pointer;
  text-decoration: underline;
}

.empty { margin: 60px auto; text-align: center; color: var(--muted); }
.empty p { font-size: 13.5px; margin: 0 0 6px; color: var(--text-2); }
.empty span { font-size: 12px; }

.selbox {
  position: fixed;
  z-index: 200;
  border: 1px solid rgba(212, 162, 76, 0.85);
  background: rgba(212, 162, 76, 0.12);
  border-radius: 4px;
  pointer-events: none;
}

.selbar {
  position: absolute;
  left: 50%;
  bottom: 20px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 9px 14px;
  background: var(--panel-fly);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: var(--shadow);
  z-index: 150;
}
.selbar .num { font-size: 12.5px; color: var(--accent-2); white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; }
.selbar .num-tick { flex-shrink: 0; }
.selbar .ops { display: flex; gap: 7px; }
.selbar button { font-size: 12.5px; padding: 5px 11px; }
.selbar button.danger { color: #e08a7c; border-color: rgba(210, 96, 79, 0.35); }
.selbar button.danger:hover { background: rgba(210, 96, 79, 0.16); }
.selbar .cancel { font-size: 12px; }

.bar-enter-active, .bar-leave-active { transition: all 0.2s ease; }
.bar-enter-from, .bar-leave-to { opacity: 0; transform: translate(-50%, 10px); }

/* 应用内输入弹窗 */
.ask-mask {
  position: absolute;
  inset: 0;
  background: var(--mask);
  display: grid;
  place-items: center;
  z-index: 70;
}
.ask-box {
  width: min(380px, 84%);
  background: var(--panel);
  border: 1px solid var(--line-soft);
  border-radius: 14px;
  padding: 18px 18px 14px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
}
.ask-box h3 { margin: 0 0 12px; font-size: 13.5px; font-weight: 600; }
.ask-input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  font-size: 13px;
  color: var(--text);
  background: var(--bg-2);
  border: 1px solid var(--line-soft);
  border-radius: 8px;
  outline: none;
}
.ask-input:focus { border-color: var(--accent-2); }
.ask-hint { margin: 8px 0 0; font-size: 11.5px; color: var(--muted); line-height: 1.6; }
.ask-msg { margin: 10px 0 0; font-size: 12.5px; color: var(--text); line-height: 1.7; white-space: pre-line; }
.ask-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.ask-foot button { font-size: 12.5px; padding: 6px 14px; }
</style>
