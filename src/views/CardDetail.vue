<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch, onBeforeUnmount, markRaw } from 'vue'
import TavernPreview from '../components/TavernPreview.vue'
import {
  store,
  closeDetail,
  openMenu,
  showToast,
  catOf,
  openDcAndSync,
  openDcDialog,
  checkOneDc,
  dcOf,
  setDcTitle,
  addNewVersionFromFile,
  pushItemToTavern,
  refreshTavernCompare,
  exportSourceFile,
  listWorldBackups,
  ensureBackupText,
  restoreWorldBackup,
  setVersionName,
  setVersionDate,
  setVersionNote,
  setItemDesc,
  deleteVersions,
  addNewVersionFromUrl,
  greetingsOfVersion,
  coverUrlOf,
  coverHashOf,
  primeCovers,
  setCurrentVersion,
  saveItems,
  tavernCurrentVersion,
  presetModelOf,
  loadThemeDoc,
  tagKeyOf,
  withTavernTarget
} from '../store.js'
import { createTapHandler } from '../lib/tap.js'
import { ensureImage, saveImageDataUrl, urlOf } from '../lib/images.js'

const props = defineProps({ item: { type: Object, required: true } })

/** 标签只在「预设」分类可用：其它分类即使老数据里带了 tags 也不展示（数据保留不动） */
const itemTags = computed(() => {
  if (catOf(props.item) !== 'presets') return []
  const seen = new Set()
  const out = []
  /* 预设上面已经有「模型」一项了，标签里再出现同一个模型名就等于显示两遍 */
  const modelKey = tagKeyOf(presetModelOf(props.item) || '')
  for (const t of props.item.tags || []) {
    const v = String(t == null ? '' : t).trim()
    if (!v) continue
    const k = tagKeyOf(v)
    if (!k || seen.has(k)) continue
    if (modelKey && k === modelKey) continue
    seen.add(k)
    out.push(v)
  }
  return out
})

const stBusy = ref(false)

/* ---------- 备注（书架卡片名字下面显示的那行字） ---------- */
const noteEditing = ref(false)
const noteDraft = ref('')
const noteInput = ref(null)
function editNote() {
  noteDraft.value = String(props.item.desc || '')
  noteEditing.value = true
  nextTick(() => {
    if (noteInput.value && noteInput.value.focus) noteInput.value.focus()
  })
}
function saveNote() {
  if (!noteEditing.value) return
  noteEditing.value = false
  setItemDesc(props.item, noteDraft.value)
}
/* 世界书交给酒馆自己的扩展去提示要不要导入，资料库不再主动替换世界书 */
const backupOldWorld = ref(false)
const wbOpen = ref(false)
const wbList = ref([])

const coverStyle = computed(() => {
  const h = props.item.hue ?? 30
  return {
    background: `linear-gradient(155deg, hsl(${h} 46% 34%), hsl(${(h + 24) % 360} 38% 16%) 70%, #12151a)`
  }
})

/** 分类词：角色卡 / 世界书 / 预设 / 美化 / 其他 */
const unit = computed(() => {
  const c = catOf(props.item)
  return c === 'characters'
    ? '角色卡'
    : c === 'worldbooks'
      ? '世界书'
      : c === 'presets'
        ? '预设'
        : c === 'themes'
          ? '美化'
          : '其他'
})

/* 分类判定一律走 catOf：它会先看条目字段，找不到再按 id 回 store.items 里查。
   以前这里直接读 props.item.category，运行期新建的条目（刚导入、刚建备份文件夹）
   身上还没有这个字段，详情页就会判成「其他」——美化预览整块不渲染、要重启才恢复。 */
const isCharacter = computed(() => catOf(props.item) === 'characters' || props.item.id?.startsWith('c'))
/** 预设：详情页才展示版本号 + 模型名（书架卡片只显示预设名） */
const isPreset = computed(() => catOf(props.item) === 'presets')
const presetModel = computed(() => presetModelOf(props.item))
const currentVersion = computed(
  () => (props.item.versions || []).find((v) => v.current) || (props.item.versions || [])[0] || null
)

/* 美化（酒馆主题）：不自己假装一套界面，直接用酒馆的 style.css + 主题变量还原真实效果 */
const isTheme = computed(() => catOf(props.item) === 'themes')
const themeCss = ref('')
const themeFields = ref(null)
const uiCss = ref('')
const uiCssError = ref('')
const themeCssLoading = ref(false)
/** 预览端：电脑端铺满，手机端窄屏居中 */
const themeMode = ref('desktop')
/** 预览页签：整体界面 / 文字效果 / 字体 */
const previewTab = ref('ui')
/* 预览舞台可以临时放大到整个窗口，方便把一套美化从头看到尾（Esc 还原） */
const previewFull = ref(false)
function toggleFull() {
  previewFull.value = !previewFull.value
}
function onFullKey(e) {
  if (e.key === 'Escape' && previewFull.value) previewFull.value = false
}
/** iframe 的 base：主题里引用的图片、字体等相对资源按酒馆 public 目录解析 */
const themeBaseHref = computed(() => {
  const p = String(store.settings.tavernPath || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return p ? `file:///${p}/public/` : ''
})

/** 酒馆自带的字体图标样式表：顶栏图标靠它显示，缺了会退回文字符号 */
const faCssHref = computed(() => (themeBaseHref.value ? themeBaseHref.value + 'css/fontawesome.min.css' : ''))

/* ---------- 预览头像（用户 / 角色）
   头像存在本地图片仓库里，设置里只留一个哈希，所以换任意一份美化都还能看到；
   没上传时用内置的简笔人像。 ---------- */
const previewAvatars = ref({ user: '', char: '' })
const avatarTarget = ref('')
const avatarInput = ref(null)
const avatarHash = computed(() => ({
  user: String(store.settings.previewAvatarUser || ''),
  char: String(store.settings.previewAvatarChar || '')
}))

async function loadPreviewAvatars() {
  const out = { user: '', char: '' }
  for (const kind of ['user', 'char']) {
    const h = avatarHash.value[kind]
    if (!h) continue
    try {
      await ensureImage(h)
      out[kind] = urlOf(h) || ''
    } catch (_) {}
  }
  previewAvatars.value = out
}
watch(avatarHash, () => loadPreviewAvatars(), { immediate: true, deep: true })

function pickAvatar(kind) {
  avatarTarget.value = kind
  if (avatarInput.value) {
    avatarInput.value.value = ''
    avatarInput.value.click()
  }
}

/** 头像不需要原图那么大：等比缩到 320px 再存，省磁盘也省内存 */
function shrinkImage(file, max = 320) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => {
      const img = new Image()
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width || 1, img.height || 1))
        const w = Math.max(1, Math.round((img.width || 1) * scale))
        const h = Math.max(1, Math.round((img.height || 1) * scale))
        const cv = document.createElement('canvas')
        cv.width = w
        cv.height = h
        const cx = cv.getContext('2d')
        cx.drawImage(img, 0, 0, w, h)
        resolve(cv.toDataURL('image/jpeg', 0.88))
      }
      img.onerror = () => reject(new Error('图片读取失败'))
      img.src = String(fr.result || '')
    }
    fr.onerror = () => reject(new Error('文件读取失败'))
    fr.readAsDataURL(file)
  })
}

async function onAvatarFile(e) {
  const file = e && e.target && e.target.files && e.target.files[0]
  if (!file) return
  const kind = avatarTarget.value === 'char' ? 'char' : 'user'
  try {
    const dataUrl = await shrinkImage(file, 320)
    const hash = await saveImageDataUrl(dataUrl)
    if (!hash) throw new Error('保存失败')
    if (kind === 'char') store.settings.previewAvatarChar = hash
    else store.settings.previewAvatarUser = hash
    await loadPreviewAvatars()
    showToast(kind === 'char' ? '已保存角色预览头像' : '已保存用户预览头像')
  } catch (err) {
    showToast('头像保存失败：' + String((err && err.message) || err))
  }
}

function clearPreviewAvatars() {
  store.settings.previewAvatarUser = ''
  store.settings.previewAvatarChar = ''
  previewAvatars.value = { user: '', char: '' }
  showToast('预览头像已恢复默认')
}

/* ---------- 图标字体：woff2 内联 ----------
   酒馆的 fontawesome.min.css 只有 font-family，真正的 @font-face 在 css/solid.min.css，
   指向 ../webfonts/fa-solid-900.woff2。预览 iframe 是 srcdoc 文档，file:// 子资源（字体尤其）
   容易被拦，字体不来 → ::before 有码点也画不出字形，图标就成了空白。
   所以把 woff2 转成 data URL 直接内联，图标显示不再看运气。 */
const faFontCss = ref('')
async function loadFaFont() {
  if (faFontCss.value) return
  try {
    const r = (await window.api.stFaFont({ tavernPath: store.settings.tavernPath })) || {}
    if (r.ok && r.css) faFontCss.value = r.css
  } catch (_) {}
}

/* ---------- 预览背景图（自定义聊天背景） ----------
   和头像一样只把哈希存进设置，图片本体进本地图片仓库 → 全局保存，换美化仍生效。
   预览里它挂在 #bg1 上，美化的 tint / blur 照旧叠在上面，能看到真实搭配效果。 */
const previewBg = ref('')
const bgInput = ref(null)
const bgHash = computed(() => String(store.settings.previewBg || ''))

async function loadPreviewBg() {
  const h = bgHash.value
  if (!h) {
    previewBg.value = ''
    return
  }
  try {
    await ensureImage(h)
    previewBg.value = urlOf(h) || ''
  } catch (_) {
    previewBg.value = ''
  }
}
watch(bgHash, () => loadPreviewBg(), { immediate: true })

function pickBg() {
  if (bgInput.value) {
    bgInput.value.value = ''
    bgInput.value.click()
  }
}

async function onBgFile(e) {
  const file = e && e.target && e.target.files && e.target.files[0]
  if (!file) return
  try {
    /* 背景不用原图：长边缩到 1920 就够铺满，省磁盘也避免解码压力 */
    const dataUrl = await shrinkImage(file, 1920)
    const hash = await saveImageDataUrl(dataUrl)
    if (!hash) throw new Error('保存失败')
    store.settings.previewBg = hash
    await loadPreviewBg()
    showToast('已保存预览背景图')
  } catch (err) {
    showToast('背景图保存失败：' + String((err && err.message) || err))
  }
}

function clearPreviewBg() {
  store.settings.previewBg = ''
  previewBg.value = ''
  showToast('预览背景已恢复默认')
}

async function loadThemePreview() {
  if (!isTheme.value) return
  themeCssLoading.value = true
  try {
    const doc = await loadThemeDoc(props.item, currentVersion.value)
    themeCss.value = doc.css || ''
    themeFields.value = doc.theme || null
  } catch (_) {
    themeCss.value = ''
    themeFields.value = null
  } finally {
    themeCssLoading.value = false
  }
  /* 酒馆界面的样式表是渲染的底：读一次缓存在内存里，所有美化共用 */
  if (!uiCss.value) {
    try {
      const r = (await window.api.stUiCss({ tavernPath: store.settings.tavernPath })) || {}
      if (r.ok && r.css) {
        uiCss.value = r.css
        uiCssError.value = ''
      } else {
        uiCssError.value = r.error || '读不到酒馆界面样式表'
      }
    } catch (e) {
      uiCssError.value = '读不到酒馆界面样式表'
    }
  }
  loadFaFont()
}
watch(
  () => [props.item.id, currentVersion.value && currentVersion.value.id],
  () => loadThemePreview(),
  { immediate: true }
)
const themeCssLines = computed(() => (themeCss.value ? themeCss.value.split(/\r?\n/).length : 0))

/* 预览文档的拼装（主题变量映射 / body 开关类 / 酒馆 DOM 骨架 / 演示消息）已搬到
   src/lib/tavernPreview.js，这里只负责取数据并交给 <TavernPreview> 渲染 */


/** 版本 id → 与之内容一致的那张酒馆卡 */
const stMatch = computed(() => {
  const map = {}
  for (const c of props.item.stCards || []) {
    if (c.matchVersionId) map[c.matchVersionId] = c
  }
  return map
})

const stCardCount = computed(() => (props.item.stCards || []).length)

/* ---------- 酒馆里的当前版本（按酒馆实际文件内容与资料库版本比对得出） ---------- */
const tavernCur = computed(() => tavernCurrentVersion(props.item))
/** 该版本行是否就是酒馆里当前加载的那一版 */
function isTavernVer(v) {
  if (!v || !tavernCur.value.known) return false
  if (v.id && v.id === tavernCur.value.versionId) return true
  return !!tavernCur.value.versionName && String(v.name || '') === tavernCur.value.versionName
}

/* ---------- 选中的版本（点击历史版本行即切换，左侧开场白跟着变） ---------- */
const selectedVersionId = ref('')
const activeVersion = computed(
  () =>
    (props.item.versions || []).find((v) => v.id === selectedVersionId.value) || currentVersion.value
)
function selectVersion(v) {
  if (!v) return
  selectedVersionId.value = v.id
}
function isSelected(v) {
  return activeVersion.value && v && activeVersion.value.id === v.id
}

/* ---------- 版本级图片：详情页跟随所选版本 ---------- */
const coverUrl = computed(() => coverUrlOf(props.item, activeVersion.value))
watch(
  activeVersion,
  (v) => {
    if (!v) return
    const h = coverHashOf(props.item, v)
    if (h) ensureImage(h)
  },
  { immediate: true }
)
onMounted(() => primeCovers([props.item]))

/* ---------- 开场白（与酒馆一致：1 条默认 + N 条备选） ---------- */
const greets = computed(() => greetingsOfVersion(activeVersion.value))
const greetOpen = ref(false)
const greetVersion = ref(null)
const greetIndex = ref(0)
const greetAll = computed(() => {
  const g = greetingsOfVersion(greetVersion.value)
  const list = []
  if (g.first) list.push({ kind: '默认开场白', text: g.first })
  g.alternates.forEach((t, i) => list.push({ kind: `其他开场白 ${i + 1}/${g.alternates.length}`, text: t }))
  return list
})
const greetCur = computed(() => greetAll.value[greetIndex.value] || null)

/* 页码翻页：一页一条，去掉上一条 / 下一条 */
const greetPages = computed(() => {
  const n = greetAll.value.length
  if (n <= 1) return []
  const cur = greetIndex.value
  const pages = []
  const add = (i) => pages.push({ key: 'p' + i, label: String(i + 1), idx: i })
  if (n <= 9) {
    for (let i = 0; i < n; i++) add(i)
    return pages
  }
  add(0)
  const start = Math.max(1, cur - 2)
  const end = Math.min(n - 2, cur + 2)
  if (start > 1) pages.push({ key: 'gap-l', label: '…', idx: -1 })
  for (let i = start; i <= end; i++) add(i)
  if (end < n - 2) pages.push({ key: 'gap-r', label: '…', idx: -1 })
  add(n - 1)
  return pages
})
function greetGoPage(i) {
  if (typeof i !== 'number' || i < 0) return
  if (!greetAll.value.length) return
  greetIndex.value = i
}

/* 弹窗拖动（标题栏按住拖动，默认位置上移由 CSS 承担） */
const greetDrag = ref({ x: 0, y: 0, on: false })
let greetDragOrigin = null

function startGreetDrag(e) {
  if (e.button !== 0) return
  greetDragOrigin = { sx: e.clientX, sy: e.clientY, ox: greetDrag.value.x, oy: greetDrag.value.y }
  greetDrag.value = { ...greetDrag.value, on: true }
  window.addEventListener('mousemove', onGreetDragMove)
  window.addEventListener('mouseup', endGreetDrag)
  e.preventDefault()
}
function onGreetDragMove(e) {
  if (!greetDragOrigin) return
  greetDrag.value = {
    x: greetDragOrigin.ox + (e.clientX - greetDragOrigin.sx),
    y: greetDragOrigin.oy + (e.clientY - greetDragOrigin.sy),
    on: true
  }
}
function endGreetDrag() {
  window.removeEventListener('mousemove', onGreetDragMove)
  window.removeEventListener('mouseup', endGreetDrag)
  if (!greetDragOrigin) return
  greetDragOrigin = null
  greetDrag.value = { ...greetDrag.value, on: false }
}

function openGreet(v) {
  // 世界书 / 预设没有开场白，双击版本行不再弹空弹层
  if (!isCharacter.value) return
  greetVersion.value = v
  greetIndex.value = 0
  greetDrag.value = { x: 0, y: 0, on: false }
  greetOpen.value = true
}
function closeGreet() {
  endGreetDrag()
  greetOpen.value = false
  greetDrag.value = { x: 0, y: 0, on: false }
}
function onGreetKey(e) {
  if (e.key === 'Escape' && greetOpen.value) closeGreet()
}

/* ---------- 版本排序 / 批量管理 ---------- */
const versionSort = ref('desc') // desc：新的在前；asc：旧的在前
const sortedVersions = computed(() => {
  const arr = (props.item.versions || []).slice()
  arr.sort((a, b) => {
    const da = String(a.date || '')
    const db = String(b.date || '')
    if (da === db) return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN')
    return versionSort.value === 'asc' ? (da > db ? 1 : -1) : da > db ? -1 : 1
  })
  return arr
})
function toggleVersionSort() {
  versionSort.value = versionSort.value === 'asc' ? 'desc' : 'asc'
}

/**
 * 版本行点击调度：单击 / 双击互不干扰
 * - 原生 dblclick 触发前必定先触发一次 click，如果 click 里立刻做事，
 *   双击时的第一下就会先把状态改掉，容易出现「单击切不动 / 双击被抢占」。
 * - 这里统一用一个短延时判定：click 后 220ms 内没有第二次点击才算单击；
 *   期间来了 dblclick 就取消单击动作，只走双击分支。
 * - 选中态（行高亮 / 大图 / 开场白）在 click 时就同步刷新，不等延时，手感无延迟。
 */
const rowTap = createTapHandler({
  delay: 220,
  onSingle(v) {
    if (!v) return
    switchTo(v)
  },
  onDouble(v) {
    if (!v) return
    switchTo(v)
    openGreet(v)
  }
})

function onRowClick(v) {
  if (!v) return
  if (batchMode.value) {
    togglePick(v.id)
    return
  }
  // 立即选中：行高亮 / 大图 / 开场白马上跟着这一版，不等延时，手感无延迟
  selectVersion(v)
  rowTap.click(v)
}

/* 双击：取消待执行的单击动作，切到这一版并弹出该版全部开场白 */
function onRowDblClick(v) {
  if (!v || batchMode.value) return
  selectVersion(v)
  rowTap.dblclick(v)
}

onBeforeUnmount(() => rowTap.cancel())
onMounted(() => window.addEventListener('keydown', onFullKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onFullKey))

/** 点哪一版就是哪一版：切当前版本、条目图片同步成该版本的图，持久化后书架立即一致 */
function switchTo(v) {
  if (!v || v.current) return
  setCurrentVersion(props.item, v)
  saveItems()
  primeCovers([props.item])
}

const batchMode = ref(false)
const pickedVersionIds = ref([])
function toggleBatch() {
  batchMode.value = !batchMode.value
  if (!batchMode.value) pickedVersionIds.value = []
}
function isPicked(id) {
  return pickedVersionIds.value.includes(id)
}
function togglePick(id) {
  pickedVersionIds.value = isPicked(id)
    ? pickedVersionIds.value.filter((x) => x !== id)
    : [...pickedVersionIds.value, id]
}
const allPicked = computed(
  () => (props.item.versions || []).length > 0 && pickedVersionIds.value.length === (props.item.versions || []).length
)
function pickAll() {
  pickedVersionIds.value = allPicked.value ? [] : (props.item.versions || []).map((v) => v.id)
}

function delVersions(ids, tip = '') {
  const list = Array.isArray(ids) ? ids : [ids]
  if (!list.length) return showToast('先选中要删的版本')
  const n = deleteVersions(props.item, list)
  pickedVersionIds.value = pickedVersionIds.value.filter((x) => !list.includes(x))
  if (n) showToast(tip || `已删除 ${n} 个版本`)
  if (!(props.item.versions || []).length) batchMode.value = false
  refreshTavernCompare(props.item)
}

/* ---------- 链接更新版本 ---------- */
const linkOpen = ref(false)
const linkVal = ref('')
const linkBusy = ref(false)
async function doLinkUpdate() {
  const url = linkVal.value.trim()
  if (!url) return showToast('请先粘贴角色卡链接')
  if (linkBusy.value) return
  linkBusy.value = true
  const v = await addNewVersionFromUrl(props.item, url)
  linkBusy.value = false
  if (v) {
    linkVal.value = ''
    linkOpen.value = false
    refreshTavernCompare(props.item)
  }
}

onMounted(() => {
  window.addEventListener('keydown', onGreetKey)
  // 四个分类一致：进详情页都静默对比一次酒馆里的同名项
  // 对比要走 IPC 读酒馆目录，放到首帧画完后再跑，避免进详情页先白屏一下
  const kick = () => {
    /* 只比对一次：拿酒馆里的同名项内容跟各版本做指纹比对，
       结果同时决定「酒馆当前版本」标在哪一行；不做任何使用状态轮询 */
    refreshTavernCompare(props.item)
  }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(kick, { timeout: 800 })
  else setTimeout(kick, 60)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onGreetKey)
  endGreetDrag()
})

/* ---------- DC ---------- */

function openDc() {
  openDcAndSync(props.item)
}

async function checkThisDc() {
  const dc = dcOf(props.item)
  if (!dc.url) return showToast('还没设置 DC 链接')
  showToast('正在后台读取 DC 标题…')
  const r = await checkOneDc(props.item)
  if (r.error) return showToast('读取失败：' + (r.message || r.error))
  if (r.baselined) return showToast(`已记录基准标题：${dc.title}`)
  if (!r.updated) return showToast('已是最新，标题没有变化')
  showToast(`发现更新：${r.title}`)
}

function dcMenu(e) {
  const dc = dcOf(props.item)
  openMenu(e, [
    { label: dc.url ? '修改 DC 链接' : '设置 DC 链接', action: () => openDcDialog(props.item) },
    {
      label: '手动更新为当前标题',
      disabled: !dc.latestTitle,
      action: () => {
        setDcTitle(props.item, dc.latestTitle)
        showToast('已同步为最新标题')
      }
    },
    { divider: true },
    { label: '立即检查这个条目', disabled: !dc.url, action: checkThisDc }
  ])
}

/* ---------- 酒馆 ---------- */

async function refreshSt() {
  if (stBusy.value) return
  stBusy.value = true
  const r = await refreshTavernCompare(props.item, { full: true })
  stBusy.value = false
  if (!r.ok) {
    showToast(r.error === 'NO_BRIDGE' ? '请在桌面版里使用' : '对比失败：' + (r.error || ''))
    return
  }
  showToast(stCardCount.value ? `酒馆里有 ${stCardCount.value} 个同名${unit.value}` : `酒馆里暂时没有这个${unit.value}`)
}

function newToTavern(e, version) {
  /* 「新建到酒馆」：不去匹配已有卡，直接把这个指定版本作为新的一份写进酒馆 */
  return pushItemToTavern(props.item, { mode: 'new', version })
    .then((r) => {
      if (r && r.ok === false) showToast('失败：' + (r.error || '未知错误'))
    })
    .catch((err) => showToast('失败：' + ((err && err.message) || err)))
}

async function doReplace(card, version) {
  /* card 为空表示资料库没记酒馆文件名：不拦，交给主进程按名字在酒馆里定位目标卡 */
  showToast(`正在更新酒馆里的${unit.value}…`)
  try {
    const r = await pushItemToTavern(props.item, {
      mode: 'replace',
      version: version || currentVersion.value,
      stAvatar: card ? card.avatar : '',
      /* card 有值 = 用户刚在菜单里选了写哪一份，主进程不必再弹窗 */
      pickAvatar: card ? card.avatar : '',
      replaceWorld: false,
      backupOldWorld: backupOldWorld.value
    })
    if (!r.ok) showToast('失败：' + (r.error || '未知错误'))
  } catch (e) {
    /* 没有这层兜底时，任何异常都变成未捕获的 Promise 拒绝：
       界面停在「正在更新…」，看起来就是点了没反应 / 黑屏 */
    showToast('失败：' + ((e && e.message) || e))
  }
}

/* 日期最新的那一版（红框「更新到酒馆」默认用它）
   同一天里可能有多个版本（"2026-06-05" 与 "2026-06-05 第2版"），date 完全相同，
   localeCompare 相等时不能停在先遇到的那个，必须取数组里更靠后的（后录入的才是最新）。 */
function latestVersion() {
  const vs = props.item.versions || []
  let best = null
  for (const v of vs) {
    if (!v) continue
    if (!best) { best = v; continue }
    if (String(v.date || '').localeCompare(String(best.date || '')) >= 0) best = v
  }
  return best
}

/* 版本记录里给「日期最新那一版」打角标：红框「更新到酒馆」用的就是它，避免改错版本 */
function isLatestVersion(v) {
  const best = latestVersion()
  return !!(v && best && v.id === best.id)
}

/* 红框按钮：直接用日期最新的版本更新到酒馆，不再弹「本地 / 链接」二级菜单 */
async function updateToTavernByLatest() {
  const v = latestVersion()
  if (!v) return showToast('这个条目还没有任何版本')
  if (!(props.item.stCards || []).length) await refreshTavernCompare(props.item)
  /* 酒馆里有多个同名副本时必须先让用户点明写哪一张：
     以前这里默认取 stCards[0]，多后缀的同名卡（方亦楷哇哦 / 哦哦 / 好的）会被静默替换，
     用户既看不到弹窗也看不到各副本的聊天记录。统一走 withTavernTarget。 */
  return withTavernTarget(props.item, '角色卡', (card) => doReplace(card, v))
}

function updateToTavern(e, version) {
  /* 多副本才弹选择菜单（含聊天记录数 / 体积）；单副本直接写；
     一张都没有（酒馆里没这个角色）也直接更新 —— 主进程找不到就按新卡写入 */
  return withTavernTarget(props.item, '角色卡', (card) => doReplace(card, version))
}

function newVersion() {
  addNewVersionFromFile(props.item).then((v) => {
    if (v) refreshTavernCompare(props.item)
  })
}

/* ---------- 世界书备份 ---------- */

async function openWorldBackups() {
  wbOpen.value = true
  /* listWorldBackups 是同步函数（只返回瘦身视图），以前这里写 .then(...)：
     对同步返回值取 .then 会直接抛 TypeError，wbList 永远赋不上值，
     弹层只剩一个标题——点「查看世界书备份」黑屏就是这个异常。
     现在统一 await + 兜底，同步/异步实现都能兼容。 */
  try {
    const list = await listWorldBackups(props.item)
    wbList.value = Array.isArray(list) ? markRaw(list) : []
  } catch (e) {
    wbList.value = []
    showToast('读取世界书备份失败：' + ((e && e.message) || e))
  }
}

/** 备份原文（侧车懒加载） */
function backupTextOf(rec) {
  return ensureBackupText(rec)
}

async function exportWorldBackup(rec) {
  const a = window.api
  if (!a?.pickDir) return showToast('请在桌面版里操作')
  const dir = await a.pickDir({ title: '导出世界书备份' })
  if (!dir) return
  /* 备份内容是懒加载的：listWorldBackups 只给瘦身视图（不带 data），
     这里必须先把侧车里的原文读回来再导出，否则 JSON.stringify(undefined) 会抛错 */
  const text = await backupTextOf(rec)
  if (!text) return showToast('这条备份的原文读不回来了')
  const r = await a.writeNamed({
    dir,
    name: `${props.item.name} - ${rec.date} 备份.json`,
    text
  })
  if (r?.ok) showToast('已导出：' + r.path)
  else showToast('导出失败：' + ((r && r.error) || ''))
}

async function restoreBackup(rec) {
  await restoreWorldBackup(props.item, rec)
}

/* ---------- 右键菜单 ---------- */

function versionMenu(e, v) {
  const total = (props.item.versions || []).length
  openMenu(e, [
    { label: '更新到酒馆', action: () => updateToTavern(e, v) },
    { label: '新建到酒馆', action: () => newToTavern(e, v) },
    { divider: true },
    { label: '导出源文件', action: () => exportSourceFile(props.item, v) },
    { divider: true },
    {
      label: '删除这个版本',
      danger: true,
      disabled: total <= 1,
      hint: total <= 1 ? '至少保留一版' : '',
      action: () => delOneVersion(v)
    }
  ])
}

function delOneVersion(v) {
  const ok = window.confirm(
    `确认删除版本「${v.name || '未命名'}」${v.date ? v.date : ''}？\n删除后无法恢复。`
  )
  if (!ok) return
  delVersions([v.id], '已删除该版本')
}

function headerMenu(e) {
  openMenu(e, [
    { label: '更新到酒馆', action: () => updateToTavernByLatest() },
    {
      label: '新建到酒馆',
      action: () => {
        const v = currentVersion.value
        if (!v) return showToast('这个条目还没有任何版本')
        return newToTavern(null, v)
      }
    },
    { divider: true },
    { label: batchMode.value ? '退出批量管理' : '批量管理版本', action: toggleBatch },
    { divider: true },
    { label: '导出源文件', action: () => exportSourceFile(props.item, currentVersion.value) }
  ])
}

/* ---------- 双击改版本名 / 日期 / 备注（仅双击字段文字才进编辑） ---------- */
const editingId = ref('')
const editingField = ref('') // name | date | note
const editVal = ref('')
const editInput = ref(null)

function startEdit(v, field) {
  editingId.value = v.id
  editingField.value = field
  editVal.value =
    field === 'name' ? String(v.name || '') : field === 'note' ? String(v.note || '') : String(v.date || '')
  nextTick(() => {
    const raw = editInput.value
    const el = Array.isArray(raw) ? raw[0] : raw
    if (!el) return
    el.focus()
    if (field === 'name' && el.select) el.select()
    if (field === 'note' && el.select) el.select()
  })
}

function cancelEdit() {
  editingId.value = ''
  editingField.value = ''
  editVal.value = ''
}

function commitEdit(v) {
  if (!editingId.value) return
  const field = editingField.value
  const val = editVal.value
  cancelEdit()
  if (field === 'name') setVersionName(props.item, v, val)
  else if (field === 'note') setVersionNote(props.item, v, String(val || '').trim())
  else if (field === 'date') {
    if (String(val || '') === String(v.date || '')) return
    setVersionDate(props.item, v, val)
    refreshSort()
  }
}

function refreshSort() {
  // 触发一次重排（store 里 items 是响应式的，改日期即生效）
}
</script>

<template>
  <section class="detail">
    <div class="topline">
      <button class="back" @click="closeDetail">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M15 5l-7 7 7 7" />
        </svg>
        返回书架
      </button>
      <div class="title">{{ item.name }}</div>
      <div class="actions">
        <button @click="exportSourceFile(item, currentVersion)">导出源文件</button>
      </div>
    </div>

    <div class="layout">
      <!-- 左：身份区 -->
      <aside class="side">
        <div class="cover" :style="coverUrl ? {} : coverStyle">
          <img v-if="coverUrl" :src="coverUrl" alt="" />
          <span v-else class="initial">{{ item.name.slice(0, 1) }}</span>
        </div>
        <h2>{{ item.name }}</h2>
        <!-- 备注：导入时可手填、卡里自带的 creator_notes 也会落到这里；书架卡片名字下面显示的就是它 -->
        <div class="note" :class="{ empty: !item.desc, editing: noteEditing }" @click="editNote">
          <input
            v-if="noteEditing"
            ref="noteInput"
            v-model="noteDraft"
            maxlength="120"
            placeholder="写一句备注，书架名字下面会显示它"
            @click.stop
            @keydown.enter.prevent="saveNote"
            @keydown.esc.prevent="noteEditing = false"
            @blur="saveNote"
          />
          <template v-else>{{ item.desc || '＋ 添加备注' }}</template>
        </div>
        <div class="chips">
          <span v-for="t in itemTags" :key="t" class="chip">{{ t }}</span>
        </div>

        <!-- 开场白只属于角色卡；世界书 / 预设这类内容没有开场白，不显示空区块 -->
        <div v-if="isCharacter" class="block">
          <div class="block-title">
            开场白
            <span v-if="greets.total" class="block-sub">默认 1 条<template v-if="greets.alternates.length">｜其他 {{ greets.alternates.length }} 条</template></span>
          </div>
          <div v-if="!greets.first" class="block-body empty">这一版没有默认开场白</div>
          <div v-else class="opening-list">
            <div class="opening">
              <span class="op-idx"></span>
              <span class="op-text">{{ greets.first }}</span>
            </div>
          </div>
          <button v-if="greets.alternates.length" class="op-toggle" @click="openGreet(activeVersion)">
            查看全部开场白 {{ greets.total }}
          </button>
        </div>

        <div class="facts">
          <!-- 预设：版本号只在详情页展示，书架卡片上不显示 -->
          <div v-if="isPreset" class="fact"><span>版本号</span><b>{{ item.stVersion || '—' }}</b></div>
          <div v-if="isPreset" class="fact"><span>模型</span><b>{{ presetModel || '—' }}</b></div>
          <div class="fact"><span>版本数量</span><b>{{ (item.versions || []).length }}</b></div>
          <div class="fact"><span>日期</span><b>{{ item.date || item.updatedAt }}</b></div>
          <div class="fact"><span>酒馆里的同名{{ unit }}</span><b>{{ stCardCount }} 个</b></div>
        </div>
      </aside>

      <!-- 右：内容 + 版本 -->
      <div class="main" @contextmenu="headerMenu">
        <div class="section">
          <div class="sec-head">
            <h3>当前内容</h3>
          </div>

          <!-- 美化：主题 CSS 效果预览（顶部电脑端 / 手机端切换，下方三块画面竖线分隔） -->
          <div v-if="isTheme" class="theme-prev" data-guide="detail-theme-preview">
            <div class="tp-bar">
              <span class="tp-title">效果预览</span>
              <div class="tp-switch">
                <button class="tp-seg" :class="{ on: previewTab === 'ui' }" @click="previewTab = 'ui'">整体界面</button>
                <span class="tp-div"></span>
                <button class="tp-seg" :class="{ on: previewTab === 'wrap' }" @click="previewTab = 'wrap'">文字效果</button>
                <span class="tp-div"></span>
                <button class="tp-seg" :class="{ on: previewTab === 'font' }" @click="previewTab = 'font'">字体</button>
              </div>
              <div class="tp-switch tp-device">
                <button class="tp-seg" :class="{ on: themeMode === 'desktop' }" @click="themeMode = 'desktop'">电脑端</button>
                <span class="tp-div"></span>
                <button class="tp-seg" :class="{ on: themeMode === 'mobile' }" @click="themeMode = 'mobile'">手机端</button>
              </div>
              <span class="tp-info">
                {{ themeCssLoading ? '正在读取样式…' : (themeCssLines ? themeCssLines + ' 行 CSS' : '') + (themeCssLines && themeFields ? ' + ' : '') + (themeFields ? Object.keys(themeFields).length + ' 项外观字段' : (!themeCssLines ? '这份美化里没有样式内容' : '')) }}
              </span>
              <button class="tp-full" :title="previewFull ? '还原' : '放大到整个窗口看'" @click="toggleFull">
                {{ previewFull ? '还原' : '放大' }}
              </button>
            </div>
            <div v-if="previewTab === 'ui'" class="tp-avatars">
              <span class="tp-av-label">预览头像</span>
              <button class="tp-av" :class="{ set: !!previewAvatars.user }" title="上传/更换用户头像" @click="pickAvatar('user')">
                <img v-if="previewAvatars.user" :src="previewAvatars.user" alt="用户头像">
                <span v-else class="tp-av-ph">用户</span>
              </button>
              <button class="tp-av" :class="{ set: !!previewAvatars.char }" title="上传/更换角色头像" @click="pickAvatar('char')">
                <img v-if="previewAvatars.char" :src="previewAvatars.char" alt="角色头像">
                <span v-else class="tp-av-ph">角色</span>
              </button>
              <button v-if="previewAvatars.user || previewAvatars.char" class="tp-av-clear" @click="clearPreviewAvatars">恢复默认</button>
              <input ref="avatarInput" type="file" accept="image/*" class="tp-av-file" @change="onAvatarFile">
              <span class="tp-av-label tp-bg-label">聊天背景</span>
              <button class="tp-bg" :class="{ set: !!previewBg }" title="上传/更换聊天背景图" @click="pickBg">
                <img v-if="previewBg" :src="previewBg" alt="聊天背景">
                <span v-else class="tp-av-ph">背景</span>
              </button>
              <button v-if="previewBg" class="tp-av-clear" @click="clearPreviewBg">恢复默认</button>
              <input ref="bgInput" type="file" accept="image/*" class="tp-av-file" @change="onBgFile">
            </div>
            <div v-if="uiCssError" class="tp-warn">没用上酒馆样式表，预览按兜底样式显示</div>
            <div class="tp-stage" :class="[themeMode, { full: previewFull }]">
              <TavernPreview
                :kind="previewTab"
                :ui-css="uiCss"
                :theme-css="themeCss"
                :fields="themeFields"
                :device="themeMode"
                :base-href="themeBaseHref"
                :avatars="previewAvatars"
                :fa-css-href="faCssHref"
                :fa-font-css="faFontCss"
                :background="previewBg"
              />
            </div>
          </div>

          <div class="dc-row" data-guide="detail-dc" :class="{ empty: !item.dc?.url }">
            <div class="dc-label">DC 原帖</div>
            <div class="dc-main">
              <template v-if="item.dc?.url">
                <span
                  class="dc-title"
                  :title="item.dc.hasUpdate ? '标题已变化，点开即同步为新标题' : '点击打开原帖'"
                  @click.stop="openDc"
                  @contextmenu.stop="dcMenu"
                >
                  {{ item.dc.title || '未记录标题' }}
                  <em v-if="item.dc.hasUpdate" class="sq" title="标题已变化，有新版本"></em>
                </span>
                <span class="dc-meta">
                  <template v-if="item.dc.hasUpdate">当前已变为「{{ item.dc.latestTitle }}」，点标题同步</template>
                  <template v-else>基准记录于 {{ item.dc.titleAt || '—' }}{{ item.dc.lastCheckAt ? '｜上次检查 ' + item.dc.lastCheckAt : '' }}</template>
                </span>
              </template>
              <template v-else>
                <span class="dc-none">未设置链接</span>
                <span class="dc-meta">填 DC 帖子链接，后台会静默抓标题，之后标题变了就算有更新</span>
              </template>
            </div>
            <button class="mini" @click.stop="openDcDialog(item)">
              {{ item.dc?.url ? '编辑' : '设置' }}
            </button>
          </div>

          <!-- 酒馆联动条 -->
          <div class="st-row">
            <div class="st-head">
              <span class="dot" :class="{ on: store.stStatus.connected }"></span>
              <span class="st-text">
                酒馆{{ store.stStatus.connected ? '已连接' : '未连接' }}
                <template v-if="stCardCount">
                  ｜有 {{ stCardCount }} 个同名{{ unit }}<template v-if="item.stCheckedAt">，比对于 {{ item.stCheckedAt }}</template>
                </template>
                <template v-else>｜还没有这个{{ unit }}</template>
              </span>
              <button class="mini ghost" :disabled="stBusy" @click="refreshSt">重新对比</button>
            </div>

            <div class="st-cards" v-if="stCardCount">
              <div v-for="c in item.stCards" :key="c.avatar" class="st-card">
                <span class="c-name">{{ isCharacter ? c.avatar : c.name }}</span>
                <span class="chip" :class="c.same ? 'ok' : ''">
                  {{ c.same ? '与「' + c.matchVersionName + '」一致' : '与任何版本都不一致' }}
                </span>
              </div>
            </div>

            <div class="st-actions" data-guide="detail-version-ops">
              <button class="act primary" @click.stop="updateToTavernByLatest">更新到酒馆</button>
              <label v-if="isCharacter" class="chk"><input type="checkbox" v-model="backupOldWorld" /> 备份旧的世界书</label>
              <button v-if="isCharacter" class="act ghost" @click="openWorldBackups">查看世界书备份</button>
              <button class="act ghost" @click="linkOpen = !linkOpen">
                {{ linkOpen ? '收起链接更新' : '从链接添加新版本' }}
              </button>
            </div>

            <div v-if="linkOpen" class="link-row">
              <input
                v-model="linkVal"
                class="link-input"
                :placeholder="`粘贴${unit}文件直链，回车即下载成新版本`"
                @keydown.enter.prevent="doLinkUpdate"
              />
              <button class="act primary" :disabled="linkBusy" @click="doLinkUpdate">
                {{ linkBusy ? '下载中…' : '下载并添加版本' }}
              </button>
              <button class="act ghost" @click="linkOpen = false">取消</button>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="sec-head">
            <h3>版本记录</h3>
            <div class="v-tools">
              <button class="ghost v-sort" :class="{ on: batchMode }" @click="toggleBatch">
                {{ batchMode ? '退出批量' : '批量管理' }}
              </button>
            </div>
          </div>
          <div class="v-head" :class="{ batch: batchMode }">
            <span class="c-drag">
              <input v-if="batchMode" type="checkbox" :checked="allPicked" title="全选" @change="pickAll" />
            </span>
            <span class="c-name">版本名</span>
            <span class="c-date clickable" title="点这里切换日期排序" @click="toggleVersionSort">
              日期<span class="arrow">{{ versionSort === 'asc' ? '↑' : '↓' }}</span>
            </span>
            <span class="c-note">备注</span>
            <span class="c-st">酒馆当前版本</span>
          </div>
          <div class="v-list" :class="{ batch: batchMode }">
            <div
              v-for="v in sortedVersions"
              :key="v.id"
              class="v-row"
              :class="{ selected: isSelected(v), picked: isPicked(v.id) }"
              @contextmenu.stop="versionMenu($event, v)"
              @click="onRowClick(v)"
              @dblclick="onRowDblClick(v)"
            >
              <span class="c-drag">
                <input
                  v-if="batchMode"
                  type="checkbox"
                  :checked="isPicked(v.id)"
                  @click.stop
                  @change="togglePick(v.id)"
                />
                <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
                  <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
                  <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
                </svg>
              </span>
              <span v-if="editingId === v.id && editingField === 'name'" class="c-name editing" @click.stop>
                <input
                  ref="editInput"
                  v-model="editVal"
                  class="inline-input name-input"
                  maxlength="32"
                  @keydown.enter.prevent="commitEdit(v)"
                  @keydown.esc.stop.prevent="cancelEdit"
                  @blur="commitEdit(v)"
                />
              </span>
              <span v-else class="c-name editable" title="双击改版本名" @dblclick.stop="startEdit(v, 'name')">
                <em v-if="isLatestVersion(v)" class="latest-badge" title="「更新到酒馆」用的就是这一版">最新</em>
                {{ v.name }}
              </span>
              <span v-if="editingId === v.id && editingField === 'date'" class="c-date editing" @click.stop>
                <input
                  ref="editInput"
                  v-model="editVal"
                  type="date"
                  class="inline-input"
                  @keydown.enter.prevent="commitEdit(v)"
                  @keydown.esc.stop.prevent="cancelEdit"
                  @blur="commitEdit(v)"
                />
              </span>
              <span v-else class="c-date editable" title="双击改这一版的日期" @dblclick.stop="startEdit(v, 'date')">
                {{ v.date }}
              </span>
              <span v-if="editingId === v.id && editingField === 'note'" class="c-note editing" @click.stop>
                <input
                  ref="editInput"
                  v-model="editVal"
                  class="inline-input"
                  maxlength="40"
                  placeholder="写点备注"
                  @keydown.enter.prevent="commitEdit(v)"
                  @keydown.esc.stop.prevent="cancelEdit"
                  @blur="commitEdit(v)"
                />
              </span>
              <span v-else class="c-note editable" title="双击改备注" @dblclick.stop="startEdit(v, 'note')">
                {{ v.note || '—' }}
              </span>
              <span class="c-st">
                <em v-if="isTavernVer(v)" class="live-ver-tag" title="酒馆里现在加载的就是这一版">酒馆当前版本</em>
              </span>
            </div>
          </div>
          <div class="v-foot">
            <template v-if="batchMode">
              <button class="ghost" @click="pickAll">{{ allPicked ? '取消全选' : '全选' }}</button>
              <button class="ghost" @click="delVersions(pickedVersionIds)">删除选中 {{ pickedVersionIds.length }} 项</button>
            </template>
            <span>共 {{ (item.versions || []).length }} 个版本，日期 {{ item.date || item.updatedAt }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 全部开场白弹层：标题栏可拖动，底部页码翻页，X 关闭 -->
    <div v-if="greetOpen" class="mask greet-mask">
      <div
        ref="greetModalEl"
        class="greet-modal"
        :class="{ dragging: greetDrag.on }"
        :style="{ transform: `translate(${greetDrag.x}px, ${greetDrag.y}px)` }"
      >
        <div class="greet-head" @mousedown="startGreetDrag">
          <div class="greet-title">
            全部开场白
            <span class="greet-sub">
              {{ greetVersion?.name || '' }}{{ greetVersion?.date ? '｜' + greetVersion.date : '' }}｜共 {{ greetAll.length }} 条
            </span>
          </div>
          <button class="greet-x" title="关闭" @mousedown.stop @click.stop="closeGreet">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div v-if="!greetAll.length" class="empty-tip">这一版没有开场白</div>
        <template v-else>
          <div class="greet-bar">
            <span class="greet-kind">{{ greetCur?.kind }}</span>
            <div class="greet-pager">
              <button
                v-for="p in greetPages"
                :key="p.key"
                class="pg"
                :class="{ on: p.idx === greetIndex, gap: p.idx < 0 }"
                :disabled="p.idx < 0"
                @click="greetGoPage(p.idx)"
              >
                {{ p.label }}
              </button>
            </div>
            <span class="greet-count">{{ greetIndex + 1 }} / {{ greetAll.length }}</span>
          </div>
          <div class="greet-body">{{ greetCur?.text }}</div>
        </template>
      </div>
    </div>

    <!-- 世界书备份弹层 -->
    <div v-if="wbOpen" class="mask" @click.self="wbOpen = false">
      <div class="modal">
        <div class="modal-head">
          <h3>「{{ item.name }}」的世界书备份</h3>
          <button class="mini" @click="wbOpen = false">关闭</button>
        </div>
        <div v-if="!wbList.length" class="empty-tip">
          还没有备份。更新到酒馆时勾选「备份旧的世界书」，这里就会留下旧版本。
        </div>
        <div v-else class="wb-list">
          <div v-for="rec in wbList" :key="rec.id" class="wb-row">
            <div class="wb-main">
              <div class="wb-name">{{ rec.worldName }}</div>
              <div class="wb-meta">{{ rec.date }} {{ rec.at }}｜{{ rec.entries }} 条｜{{ rec.note }}</div>
            </div>
            <button class="mini" @click="exportWorldBackup(rec)">导出</button>
            <button class="mini" @click="restoreBackup(rec)">还原到酒馆</button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.detail {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}
.topline {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 22px;
  border-bottom: 1px solid var(--line-soft);
  flex-shrink: 0;
}
.back {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  padding: 5px 10px;
}
.topline .title { font-size: 14px; font-weight: 600; }
.topline .actions { margin-left: auto; display: flex; gap: 8px; }

.layout {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 268px 1fr;
}

.side {
  padding: 18px 18px 24px;
  border-right: 1px solid var(--line-soft);
  overflow-y: auto;
  background: rgba(15, 17, 20, 0.35);
}
.cover {
  position: relative;
  aspect-ratio: 3 / 3.6;
  border-radius: 12px;
  display: grid;
  place-items: center;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.06);
  box-shadow: inset 0 0 60px rgba(0, 0, 0, 0.35);
}
.cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.initial { font-size: 54px; font-weight: 600; color: rgba(255, 255, 255, 0.26); }
.side h2 {
  font-size: 15px;
  margin: 14px 0 8px;
  font-weight: 600;
  line-height: 1.4;
}
.chips { display: flex; flex-wrap: wrap; gap: 5px; }

/* 备注：一行小字，点一下就地改 */
.note {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  background: rgba(255, 255, 255, 0.03);
  border: 1px dashed rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  padding: 6px 8px;
  margin-bottom: 8px;
  cursor: text;
  word-break: break-word;
}
.note.empty { color: var(--muted); }
.note:hover { border-color: rgba(255, 255, 255, 0.24); }
.note.editing { padding: 0; border-style: solid; border-color: rgba(120, 170, 255, 0.55); background: rgba(0, 0, 0, 0.25); }
.note input {
  width: 100%;
  box-sizing: border-box;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text-1, #e8e8e8);
  font-size: 12px;
  line-height: 1.6;
  padding: 6px 8px;
}

.block { margin-top: 16px; }
.block-title {
  font-size: 11.5px;
  color: var(--muted);
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}
.block-body {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-2);
  background: var(--panel);
  border: 1px solid var(--line-soft);
  border-radius: 9px;
  padding: 10px 11px;
  max-height: 190px;
  overflow-y: auto;
  white-space: pre-wrap;
}

.facts {
  margin-top: 16px;
  border-top: 1px solid var(--line-soft);
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.fact {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--muted);
}
.fact b { color: var(--text-2); font-weight: 500; }

.main {
  padding: 18px 22px 26px;
  overflow-y: auto;
}
.section {
  background: var(--panel);
  border: 1px solid var(--line-soft);
  border-radius: 12px;
  padding: 14px 16px 16px;
  margin-bottom: 16px;
}
.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.sec-head h3 { font-size: 13.5px; margin: 0; font-weight: 600; }
.hint { font-size: 11.5px; color: #5f6875; }

.dc-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 9px;
  background: var(--bg-2);
  border: 1px solid var(--line-soft);
}
.dc-row.empty { opacity: 0.78; }
.dc-label { font-size: 11.5px; color: var(--muted); flex-shrink: 0; }
.dc-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.dc-title {
  font-size: 13px;
  color: var(--accent-2);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  width: fit-content;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dc-title:hover { text-decoration: underline; }
.dc-none { font-size: 13px; color: var(--text-2); }
.dc-meta {
  font-size: 11px;
  color: #5c6673;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sq {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  background: var(--accent-2);
  display: inline-block;
  flex-shrink: 0;
}
.mini { font-size: 11.5px; padding: 4px 10px; }

/* 酒馆联动条 */
.st-row {
  margin-top: 12px;
  padding: 11px 12px;
  border-radius: 9px;
  background: var(--bg-2);
  border: 1px solid var(--line-soft);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.st-head { display: flex; align-items: center; gap: 8px; }
.dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: #6b7280; flex-shrink: 0;
}
.dot.on { background: #4ade80; box-shadow: 0 0 6px rgba(74, 222, 128, 0.6); }
.st-text { font-size: 12px; color: var(--text-2); flex: 1; }

.live-src {
  margin-left: auto; flex-shrink: 0;
  font-size: 10.5px; color: var(--muted);
  border: 1px solid var(--line-soft); border-radius: 5px; padding: 0 5px;
}
.c-st { display: flex; align-items: center; justify-content: flex-end; min-width: 0; }
.c-st .live-ver-tag { margin-left: 0; white-space: nowrap; }
.live-ver-tag {
  margin-left: 6px;
  font-style: normal; font-size: 10px; line-height: 14px;
  padding: 0 5px; border-radius: 999px;
  color: #06210f; background: linear-gradient(180deg, #6ee7a0, #3fbf74);
  font-weight: 600; vertical-align: 1px;
}
.st-cards { display: flex; flex-direction: column; gap: 5px; }
.st-card {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; color: var(--muted);
}
.st-card .c-name { color: var(--text-2); }
.st-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.act { font-size: 12px; padding: 5px 11px; }
.chk {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11.5px; color: var(--muted); cursor: pointer;
}
.chk input { accent-color: var(--accent-2); }

.v-head {
  display: grid;
  grid-template-columns: 22px 1.1fr 100px 1.3fr 120px;
  gap: 8px;
  padding: 0 10px 7px;
  font-size: 11.5px;
  color: #5f6875;
  border-bottom: 1px solid var(--line-soft);
}
.v-list { margin-top: 4px; }
.v-row {
  display: grid;
  grid-template-columns: 22px 1.1fr 100px 1.3fr 120px;
  gap: 8px;
  align-items: center;
  padding: 9px 10px;
  border-radius: 8px;
  font-size: 12.5px;
  color: var(--text-2);
  border: 1px solid transparent;
  cursor: pointer;
}
.v-row:hover {
  background: var(--panel-2);
  border-color: var(--line);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04);
}
.v-row.selected {
  background: rgba(212, 162, 76, 0.1);
  border-color: rgba(212, 162, 76, 0.3);
  color: var(--text);
}
.v-row.selected:hover,
.v-row.picked:hover {
  background: rgba(212, 162, 76, 0.16);
  border-color: rgba(212, 162, 76, 0.5);
}
.c-drag { color: #454e5b; display: flex; align-items: center; }
.latest-badge {
  display: inline-block;
  margin-right: 6px;
  padding: 0 5px;
  font-style: normal;
  font-size: 10px;
  line-height: 15px;
  border-radius: 4px;
  vertical-align: 1px;
  color: var(--accent-2, #d4a24c);
  background: rgba(212, 162, 76, 0.16);
  border: 1px solid rgba(212, 162, 76, 0.38);
}
.c-name { font-weight: 500; color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-date, .c-note {
  color: var(--muted);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 双击改版本名 / 日期 / 备注：悬停高亮统一由整行承担，字段自身不再单独画框 */
.c-name.editable,
.c-date.editable { cursor: text; border-radius: 4px; padding: 1px 4px; margin-left: -4px; }
.c-note.editable { cursor: text; border-radius: 4px; padding: 1px 4px; margin-left: -4px; }
.c-name.editing,
.c-date.editing,
.c-note.editing { display: flex; }
.inline-input {
  width: 100%;
  min-width: 0;
  height: 24px;
  padding: 0 6px;
  font-size: 12px;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--gold, #d4a24c);
  border-radius: 5px;
  outline: none;
}
/* 版本名编辑框只占列宽三分之一 */
.name-input { width: 33%; }
.chip.dim { opacity: 0.55; }

.v-foot {
  margin-top: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  color: #5f6875;
}
.v-foot button { font-size: 12px; }
.v-foot { gap: 8px; flex-wrap: wrap; }
.v-foot span { margin-left: auto; }

/* 版本区工具条 */
.v-tools { display: flex; align-items: center; gap: 6px; }
.v-sort { font-size: 11.5px; padding: 3px 8px; color: var(--muted); }
.v-sort.on { color: var(--text); background: var(--panel-3); border-color: var(--line); }
.c-date.clickable { cursor: pointer; user-select: none; }
.c-date.clickable:hover { color: var(--text-2); }
.c-date .arrow { font-size: 10px; margin-left: 3px; opacity: 0.85; }
.v-row.picked { background: rgba(212, 162, 76, 0.1); border-color: rgba(212, 162, 76, 0.28); }
.v-head input[type='checkbox'],
.v-row input[type='checkbox'] { accent-color: var(--accent-2); cursor: pointer; }
.v-list.batch .v-row { cursor: pointer; }

/* 链接更新行 */
.link-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.link-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 9px;
  font-size: 12px;
  color: var(--text);
  background: var(--bg-2);
  border: 1px solid var(--line-soft);
  border-radius: 7px;
  outline: none;
}
.link-input:focus { border-color: var(--gold, #d4a24c); }

/* 开场白列表 */
.opening-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow-y: auto;
}
.opening {
  display: grid;
  grid-template-columns: 20px 1fr;
  gap: 6px;
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-2);
  background: var(--bg-2);
  border: 1px solid var(--line-soft);
  border-radius: 8px;
  padding: 7px 9px;
}
.op-idx { color: #6a7381; font-size: 11px; }
.op-text { white-space: pre-wrap; word-break: break-word; }
.op-toggle {
  margin-top: 8px;
  font-size: 11.5px;
  padding: 4px 10px;
  color: var(--text-2);
}
.block-body.empty { color: #5f6875; font-size: 11.5px; }

/* 弹层 */
.mask {
  position: absolute;
  inset: 0;
  background: var(--mask);
  display: grid;
  place-items: center;
  z-index: 40;
}
.modal {
  width: min(620px, 88%);
  max-height: 74%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--line-soft);
  border-radius: 14px;
  padding: 16px 18px;
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.modal-head h3 { font-size: 13.5px; margin: 0; }
.empty-tip { font-size: 12.5px; color: var(--muted); line-height: 1.8; padding: 10px 2px; }

/* 全部开场白弹层 */
.greet-mask {
  z-index: 60;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 26px 12px 12px;
}
.greet-modal {
  width: min(760px, 92%);
  height: min(70%, 540px);
  max-height: calc(100% - 38px);
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--line-soft);
  border-radius: 14px;
  padding: 16px 18px;
  will-change: transform;
}
.greet-modal.dragging { box-shadow: 0 18px 46px rgba(0, 0, 0, 0.55); }
.greet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  cursor: move;
  user-select: none;
}
.greet-title { font-size: 13.5px; color: var(--text); font-weight: 600; }
.greet-sub { font-size: 11.5px; color: var(--muted); font-weight: 400; margin-left: 8px; }
.greet-x {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  flex-shrink: 0;
  border-radius: 7px;
  color: var(--muted);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
}
.greet-x:hover { color: var(--text); background: var(--panel-3); border-color: var(--line-soft); }
.greet-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0 10px;
  border-bottom: 1px solid var(--line-soft);
}
.greet-kind { font-size: 12.5px; color: var(--text); font-weight: 500; flex-shrink: 0; }
.greet-count { font-size: 11.5px; color: var(--muted); flex-shrink: 0; }
.greet-pager {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}
.pg {
  min-width: 26px;
  height: 24px;
  padding: 0 7px;
  font-size: 11.5px;
  color: var(--text-2);
  background: var(--bg-2);
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  cursor: pointer;
}
.pg:hover { border-color: var(--line); color: var(--text); }
.pg.on {
  background: rgba(212, 162, 76, 0.16);
  border-color: rgba(212, 162, 76, 0.45);
  color: var(--text);
}
.pg.gap { background: transparent; border-color: transparent; cursor: default; }
.pg:disabled { opacity: 0.55; cursor: default; }
.greet-body {
  flex: 1;
  overflow-y: auto;
  margin-top: 12px;
  padding: 14px 16px;
  background: var(--bg-2);
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.9;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
}
.wb-list { overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.wb-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 9px;
  background: var(--bg-2);
  border: 1px solid var(--line-soft);
}
.wb-main { flex: 1; min-width: 0; }
.wb-name { font-size: 12.5px; color: var(--text); }
.wb-meta { font-size: 11px; color: var(--muted); margin-top: 2px; }

/* ---------- 美化：效果预览 ---------- */
.theme-prev {
  margin-top: 10px;
  border: 1px solid var(--line-soft);
  border-radius: 12px;
  background: var(--panel);
  overflow: hidden;
}
.tp-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line-soft);
}
.tp-title { font-size: 12px; color: var(--text-2); }
/* 电脑端 | 手机端：两个按钮之间用一根竖线分隔 */
.tp-switch { display: flex; align-items: center; gap: 0; }
.tp-seg {
  background: transparent;
  border: 0;
  padding: 3px 10px;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  border-radius: 6px;
}
.tp-seg:hover { color: var(--text); }
.tp-seg.on { color: var(--text); background: rgba(255, 255, 255, 0.08); }
.tp-div { width: 1px; height: 12px; background: var(--line-soft); }
.tp-info { margin-left: auto; font-size: 11px; color: var(--muted); }
.tp-avatars {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 8px;
  flex-wrap: wrap;
}
.tp-av-label { font-size: 12px; color: var(--text-2); }
/* 背景图按钮：宽一点、圆角方图，和圆形头像按钮区分开，缩略图一眼能看出是背景 */
.tp-bg-label { margin-left: 8px; }
.tp-bg {
  width: 56px;
  height: 34px;
  padding: 0;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--line-soft);
  background: rgba(255, 255, 255, 0.04);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.15s, transform 0.15s;
}
.tp-bg:hover { border-color: var(--text-2, rgba(255, 255, 255, 0.35)); transform: translateY(-1px); }
.tp-bg.set { border-color: rgba(120, 200, 160, 0.55); }
.tp-bg img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tp-av {
  width: 34px;
  height: 34px;
  padding: 0;
  border-radius: 50%;
  overflow: hidden;
  border: 1px solid var(--line-soft);
  background: rgba(255, 255, 255, 0.04);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.15s, transform 0.15s;
}
.tp-av:hover { border-color: var(--text-2, rgba(255, 255, 255, 0.35)); transform: translateY(-1px); }
.tp-av.set { border-color: rgba(120, 200, 160, 0.55); }
.tp-av img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tp-av-ph { font-size: 10px; color: var(--muted); line-height: 1; }
.tp-av-clear {
  font-size: 11px;
  color: var(--muted);
  background: none;
  border: 0;
  cursor: pointer;
  padding: 2px 4px;
}
.tp-av-clear:hover { color: var(--text); }
.tp-av-hint { font-size: 11px; color: var(--muted); }
.tp-av-file { display: none; }

.tp-hint {
  padding: 7px 12px;
  font-size: 11px;
  color: var(--muted);
  border-top: 1px solid var(--line-soft);
}
/* 预览舞台：给够高度，画面自己滚动（以前固定 360px 又不开滚动，内容直接被裁掉） */
.tp-stage {
  display: flex;
  justify-content: center;
  align-items: stretch;
  padding: 12px;
  height: clamp(460px, 66vh, 900px);
  min-height: 420px;
  background: var(--bg-2, #14161b);
}
.tp-stage :deep(.tpv-frame) {
  border: 1px solid var(--line-soft);
  border-radius: 10px;
}
.tp-stage.mobile :deep(.tpv-frame) {
  border-radius: 16px;
}
@media (max-height: 900px) {
  .tp-stage { height: clamp(380px, 60vh, 720px); }
}
/* 放大：铺满窗口看整套美化，Esc 或右上角「还原」退出 */
.tp-stage.full {
  position: fixed;
  inset: 10px;
  z-index: 4000;
  height: auto;
  border-radius: 12px;
  border: 1px solid var(--line-soft);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
}
.tp-stage.full :deep(.tpv-frame) {
  border-radius: 10px;
}
.tp-full {
  background: transparent;
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  padding: 2px 8px;
  margin-left: 8px;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
}
.tp-full:hover { color: var(--text); border-color: var(--text-2, rgba(255, 255, 255, 0.3)); }
</style>
