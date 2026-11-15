import { reactive, computed, watch, markRaw } from 'vue'
import {
  IMG, urlOf, ensureImage, ensureImages, hashText,
  saveImageDataUrl, saveImageBytes, isDataUrl, b64Payload,
  bytesToDataUrl, sniffImageMime, thumbUrl
} from './lib/images.js'
import { cleanUrl, cleanText, checkUrl, hasBadChars } from './lib/urlsafe.js'
import { digestOf } from './lib/digest.js'
import { parsePresetName, presetGroupKey, detectModel } from './lib/preset.js'
import { applyTheme, applyCustomCss, resolveTheme, onSystemThemeChange } from './lib/theme.js'
import { checkForUpdate, listReleases, DEFAULT_UPDATE_SOURCE } from './lib/update.js'
import { judgeExtVersion } from './lib/extver.js'
import { CAT_ORDER, catIndex } from './lib/itemcat.js'

const SETTINGS_KEY = 'tavern-lib-settings'
/* 设置的备份键：主键被写坏 / 解析失败时还能把用户填的路径救回来 */
const SETTINGS_BAK_KEY = 'tavern-lib-settings-bak'
const ITEMS_KEY = 'tavern-lib-items'

/** 之前内置的示例数据：既按名称剔除，也按短 id（mock 用 c1/w1/p1/o1 这种短号，真实条目是长号）剔除 */
const LEGACY_MOCK_NAMES = new Set([
  '艾拉 · 酒馆老板娘',
  '林小满',
  '守夜人 · 提灯',
  '苏临风',
  'K-07 检修员',
  '雾岛理纱',
  '北境诸城 · 地理志',
  '通用 · 剧情推进规则',
  '苏氏药堂 · 药材名录',
  '长回响 · 沉浸叙事',
  '短平快 · 对话体'
])
const LEGACY_MOCK_IDS = /^(c|w|p|o|wb)\d{1,2}$/

function emptyItems() {
  return { characters: [], worldbooks: [], presets: [], themes: [], others: [] }
}

function stripMock(items) {
  let removed = 0
  for (const k of ['characters', 'worldbooks', 'presets', 'themes', 'others']) {
    if (!Array.isArray(items[k])) { items[k] = []; continue }
    const before = items[k].length
    items[k] = items[k].filter((it) => {
      const name = String(it?.name || '').trim()
      if (LEGACY_MOCK_NAMES.has(name)) return false
      if (it?.id && LEGACY_MOCK_IDS.test(String(it.id))) return false
      return true
    })
    removed += before - items[k].length
  }
  return removed
}

/**
 * 版本里保存的原始卡片 JSON 体量大且只读（导出 / 备份 / 看开场白时才读）。
 * 标成 markRaw：不进响应式代理、深 watch 也不遍历它。
 * 资料一多，这一条能把整库深度遍历的开销削掉一大半。
 */
export function markRawPayloads(items) {
  const cats = items && typeof items === 'object' ? ['characters', 'worldbooks', 'presets', 'themes', 'others'] : []
  for (const k of cats) {
    const arr = Array.isArray(items[k]) ? items[k] : []
    for (const it of arr) {
      for (const v of it?.versions || []) {
        if (v && v.raw && typeof v.raw === 'object') v.raw = markRaw(v.raw)
      }
    }
  }
  return items
}

/**
 * 给条目打归属类别（characters / worldbooks / presets / themes / others）。
 * 早期数据里没有 category 字段，而「酒馆在用」判定、详情页分支、导出分支都要靠它，
 * 这里按条目所在列表统一补齐。
 *
 * 重要：category 必须是**可枚举**属性，才能跟着 slimItems / 存档一起落盘。
 * 历史坑：早期为了省存档体积用了 enumerable:false，category 只在内存里有、从不落盘，
 * 于是运行期新建的条目（导入、世界书备份文件夹）必须重启才被详情页认出来。
 * 现在可枚举 + 新建条目直接写字段，双保险。
 */
export function tagCategories(items) {
  if (!items || typeof items !== 'object') return items
  for (const k of CAT_ORDER) {
    const arr = Array.isArray(items[k]) ? items[k] : []
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue
      if (it.category === k) continue
      try {
        /* 直接赋值即可：category 现在是可枚举字段，会跟着 slimItems 一起落盘。
           之前用 defineProperty(enumerable:false) 只为省存档体积，代价是运行期新建/导入的
           条目必须重启（loadItems/hydrateFromDataFile 才补字段）才能被识别成美化。 */
        it.category = k
      } catch (_) {}
    }
  }
  return items
}

/**
 * 精确取条目归属类别：先看自身字段，再回退到按 id 在列表里找；找不到就返回空。
 * 同时把拿到的类别补回条目自身（可枚举，随存档落盘），下次不必再查。
 * 详情页 / 导出等按分类分叉的地方统一用它，不要再直接写 item.category === 'themes'。
 * 判定本身在 lib/itemcat.js 里（纯函数、有单测），这里只负责补字段。
 */
export function catOf(item) {
  if (!item) return ''
  let items = null
  try { items = (store && store.items) || null } catch (_) { items = null }
  const k = catIndex(items, item)
  if (!k) return ''
  if (item.category !== k) {
    try { item.category = k } catch (_) {}
  }
  return k
}
/** 内部沿用旧名 */
const resolveCat = catOf

function countItemsOf(items) {
  let n = 0
  for (const k of CAT_KEYS) n += Array.isArray(items?.[k]) ? items[k].length : 0
  return n
}

/** 本机本地时间戳（带时区偏移），写进 library.json 的 savedLocalAt，人工查库时一眼看出写入时刻 */
function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
}

/* ---------------- localStorage：降级成「时间戳缓存」 ----------------
 * 权威源只有一份：数据目录里的 library.json。
 * localStorage 里现在只留 {"savedAt":..,"localAt":..,"v":2}，记录本机最后一次保存时
 * json 的 savedAt，用来判断「磁盘上的 json 有没有比我手里的新」。
 *
 * 历史坑（本次要根治的）：旧版把整库写进 localStorage，启动时只要 localStorage 有值就
 * 不读 json —— 真正的权威源其实是缓存。手工清理 json 里的 224 条遗留备份版本后，
 * 第二天一启动就被 localStorage 里的旧整库回写覆盖。 */
function readItemsCache() {
  let raw = ''
  try { raw = String(localStorage.getItem(ITEMS_KEY) || '') } catch (_) { return null }
  if (!raw) return null
  let o = null
  try { o = JSON.parse(raw) } catch (_) { return null }
  if (!o || typeof o !== 'object') return null
  /* 老格式：整库（含 characters/... 数组）；新格式：只有时间戳 */
  const legacy = CAT_KEYS.some((k) => Array.isArray(o[k]))
  if (legacy) return { legacy: o, savedAt: '', localAt: '', raw }
  return { legacy: null, savedAt: String(o.savedAt || ''), localAt: String(o.localAt || ''), raw }
}

function writeItemsStamp(stamp) {
  try {
    localStorage.setItem(ITEMS_KEY, JSON.stringify({
      savedAt: String(stamp?.savedAt || ''),
      localAt: String(stamp?.localAt || localStamp()),
      v: 2
    }))
  } catch (_) {}
}

/** 老版本整包缓存 → 规范化的 items；没有 / 空的返回 null（只在 json 缺失或损坏时用） */
function legacyCachedItems() {
  const c = readItemsCache()
  if (!c || !c.legacy) return null
  const items = emptyItems()
  for (const k of CAT_KEYS) items[k] = Array.isArray(c.legacy[k]) ? c.legacy[k] : []
  if (!countItemsOf(items)) return null
  stripMock(items)
  markRawPayloads(items)
  return ensureCurrentVersion(tagCategories(items))
}

function loadItems() {
  /* 启动时内存的起点：只可能是「旧版 localStorage 整包缓存」。
     新版 localStorage 只剩时间戳，条目一律等 hydrateFromDataFile() 从 library.json 重建。 */
  try {
    const legacy = legacyCachedItems()
    if (legacy) return legacy
  } catch (_) {}
  return emptyItems()
}

/* ---------------- 侧车文件：raw / 备份内容不再塞进快照 ----------------
 * 实测本机约 60.86MB，其中 33.87MB 是 characters 的 versions[].raw。
 * 每次保存要把整库 stringify 两遍（localStorage + library.json 快照），
 * 启动还要把这几十兆解析回来 —— 这就是「改回目录+图片方案后开始卡」的真实原因。
 * 现在 raw 与世界书备份内容落到 数据目录/raw、数据目录/backups 的独立文件（按需读）。
 * 快照里只留索引字段，内存中的 raw 仍保留（导出 / 推酒馆不受影响）。
 */
const RAW_SUB = 'raw'
const BACKUP_SUB = 'backups'
const rawCache = new Map()

const CAT_KEYS = ['characters', 'worldbooks', 'presets', 'themes', 'others']

function rawFileName(itemId, verId) {
  return `${String(itemId || 'x').replace(/[\\/:*?"<>|]/g, '_')}__${String(verId || 'v').replace(/[\\/:*?"<>|]/g, '_')}.json`
}

/** 已写入侧车的内容签名：内容没变就不再重复写盘（否则每次保存都要重写几十兆） */
const sidecarSig = new Map()

/** 写一个侧车文件（异步，不阻塞 UI；内容未变则跳过；失败下次保存会重试） */
function putSidecar(sub, name, text) {
  const a = apiOf()
  if (!a?.dataPutFile) return
  const key = sub + '/' + name
  let sig = ''
  try { sig = String(text.length) + ':' + hashText(text) } catch (_) { sig = String(text.length) }
  if (sidecarSig.get(key) === sig) return
  sidecarSig.set(key, sig)
  try {
    const p = a.dataPutFile({ sub, name, text })
    if (p && typeof p.catch === 'function') p.catch(() => { sidecarSig.delete(key) })
  } catch (_) {
    sidecarSig.delete(key)
  }
}

/**
 * 序列化用的精简副本（内存数据不动）。
 * versions[].raw → 侧车 raw/<itemId>__<verId>.json，快照只留 rawFile
 * backups[].data → 侧车 backups/<itemId>__<wbId>.json，快照只留 rawFile
 */
export function slimItems() {
  const out = {}
  for (const k of CAT_KEYS) {
    out[k] = (store.items[k] || []).filter((it) => !it || !it.demoTour).map((it) => {
      const versions = (it.versions || []).map((v) => {
        if (!v || v.raw === undefined || v.raw === null) return v
        const fn = rawFileName(it.id, v.id)
        let text = ''
        try { text = JSON.stringify(v.raw) } catch (_) { text = '' }
        if (text) putSidecar(RAW_SUB, fn, text)
        return { ...v, raw: undefined, rawFile: fn }
      })
      let backups = it.backups
      if (Array.isArray(backups) && backups.length) {
        backups = backups.map((b) => {
          const fn = rawFileName(it.id, b.id)
          if (b.text) {
            putSidecar(BACKUP_SUB, fn, String(b.text))
            const { text, ...rest } = b
            return { ...rest, rawFile: fn }
          }
          if (b.data) {
            let text = ''
            try { text = JSON.stringify(b.data) } catch (_) { text = '' }
            if (text) putSidecar(BACKUP_SUB, fn, text)
            const { data, ...rest } = b
            return { ...rest, rawFile: fn }
          }
          return b
        })
      }
      return { ...it, versions, ...(Array.isArray(backups) ? { backups } : {}) }
    })
  }
  return out
}

/** 正在读的侧车文件：同一文件的并发请求共用一次读盘（详情页开场白预载与正则预载几乎同时发起） */
const rawPending = new Map()

/** 按需把某个版本的原始 JSON 读回来（推酒馆 / 导出 / 看内容时用） */
export async function ensureVersionRaw(item, version) {
  if (!version) return undefined
  if (version.raw !== undefined && version.raw !== null) return version.raw
  const fn = version.rawFile
  if (!fn) return undefined
  if (rawCache.has(fn)) {
    version.raw = markRaw(rawCache.get(fn))
    return version.raw
  }
  let p = rawPending.get(fn)
  if (!p) {
    const a = apiOf()
    if (!a?.dataReadFile) return undefined
    p = (async () => {
      const r = await a.dataReadFile({ sub: RAW_SUB, name: fn })
      if (!r || !r.ok || !r.text) return null
      try {
        return JSON.parse(r.text)
      } catch (_) {
        return null
      }
    })()
      .then((data) => {
        rawPending.delete(fn)
        if (data) rawCache.set(fn, data)
        return data
      })
      .catch(() => {
        rawPending.delete(fn)
        return null
      })
    rawPending.set(fn, p)
  }
  const data = await p
  if (!data) return undefined
  version.raw = markRaw(data)
  return version.raw
}

/** 美化分类的 CSS 正文：raw 里存成 { css }，读侧车后取值 */
export function themeCssOf(ver, item) {
  const raw = ver && ver.raw
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object') {
    if (typeof raw.css === 'string') return raw.css
    if (typeof raw.text === 'string') return raw.text
  }
  const p = item && item.payload
  if (p && typeof p === 'object' && typeof p.css === 'string') return p.css
  return ''
}

/** 异步版：版本 raw 可能还在侧车文件里，读回来再取 CSS */
export async function loadThemeCss(item, version) {
  if (!item) return ''
  const ver = version || bestVersionOf(item) || null
  let css = themeCssOf(ver, item)
  if (!css && ver && ver.rawFile) {
    try {
      await ensureVersionRaw(item, ver)
    } catch (_) {}
    css = themeCssOf(ver, item)
  }
  return css || ''
}

/** 美化主题的外观字段（酒馆 UI 主题那种只存颜色/模糊/头像形状的写法） */
export function themeFieldsOf(ver, item) {
  const raw = ver && ver.raw
  if (raw && typeof raw === 'object' && raw.theme && typeof raw.theme === 'object') return raw.theme
  const p = item && item.payload
  if (p && typeof p === 'object' && p.theme && typeof p.theme === 'object') return p.theme
  return null
}

/**
 * 导出用的酒馆主题 json。
 * 酒馆 themes/*.json 的样式字段是 custom_css（酒馆 1.12 起都是这个键），
 * 而本软件内部存成 { css, theme }，直接吐 css 文件酒馆认不出来 ——
 * 所以导出时一律按酒馆格式拼回一份 json：{ name, ...外观字段, custom_css }。
 * 内容为空返回 null（调用方据此报「没有可导出的内容」）。
 */
export function themeJsonOf(ver, item) {
  const css = String(themeCssOf(ver, item) || '')
  const th = themeFieldsOf(ver, item) || null
  const fields = th && typeof th === 'object' ? { ...th } : null
  if (!css.trim() && !fields) return null
  /* 名字优先用酒馆原名（raw.name）：资料库里的条目名可能被用户改过、甚至带「(1)」这类
     重名后缀，直接写进主题文件会让酒馆里出现一个看不出出处的怪名字。 */
  const rawName = (ver && ver.raw && ver.raw.name) || ''
  const out = { name: String(rawName || (item && item.name) || (ver && ver.name) || '') }
  if (fields) for (const k of Object.keys(fields)) if (fields[k] !== undefined) out[k] = fields[k]
  out.custom_css = css
  return out
}

/** 详情页预览用：一次性拿到 CSS 源 + 外观字段 */
export async function loadThemeDoc(item, version) {
  if (!item) return { css: '', theme: null }
  const ver = version || bestVersionOf(item) || null
  let css = themeCssOf(ver, item)
  let theme = themeFieldsOf(ver, item)
  if ((!css || !theme) && ver && ver.rawFile) {
    try {
      await ensureVersionRaw(item, ver)
    } catch (_) {}
    css = css || themeCssOf(ver, item)
    theme = theme || themeFieldsOf(ver, item)
  }
  /* 老版本导入的美化只把 { css, name } 存进了 raw，颜色/模糊/头像形状这些外观字段没留下来。
     源文件还在酒馆里就直接回源读一次，用户不用把主题重新导入一遍。 */
  if (!css || !theme) {
    const a = apiOf()
    if (a?.stThemeSrc) {
      const cands = []
      const push = (v) => {
        const s = String(v == null ? '' : v).trim()
        if (s && !cands.includes(s)) cands.push(s)
      }
      try { push(ver && ver.raw && ver.raw.name) } catch (_) {}
      push(item && item.name)
      push(ver && ver.name)
      /* 来源串形如「xxx.zip › themes/<主题名>/2026-10-22.json」，抠出中间那段当名字 */
      const m = /themes[\\/]([^\\/]+)[\\/]/i.exec(String((ver && ver.srcFile) || ''))
      if (m) push(m[1])
      for (const nm of cands) {
        try {
          const r = await a.stThemeSrc({
            tavernPath: store.settings.tavernPath,
            user: store.settings.stUser,
            file: ver && ver.srcPath,
            name: nm
          })
          if (!r || !r.ok || (!r.css && !r.theme)) continue
          css = String(r.css || '') || css
          theme = r.theme || theme
          /* 侧车里只剩空壳 { css:'', name, theme:null } 的老条目：把回源结果写回去，
             顺手补上源文件路径，下次打开就不用再按名字捞一遍 */
          if (ver) {
            if (!ver.srcPath && r.path) {
              try { ver.srcPath = r.path } catch (_) {}
            }
            if (ver.rawFile) {
              const payload = {
                css: String(css || ''),
                name: String((ver.raw && ver.raw.name) || item.name || ver.name || nm || ''),
                theme: theme || null
              }
              try { ver.raw = markRaw(payload) } catch (_) {}
              rawCache.set(ver.rawFile, payload)
              try { putSidecar(RAW_SUB, ver.rawFile, JSON.stringify(payload)) } catch (_) {}
            }
          }
          break
        } catch (_) {}
      }
    }
  }
  return { css: css || '', theme: theme || null }
}

/** 按需把某个世界书备份的正文读回来（查看 / 导出 / 还原时用） */
export async function ensureBackupText(rec) {
  if (!rec) return ''
  if (rec.text) return rec.text
  if (rec.data) {
    try { return JSON.stringify(rec.data, null, 2) } catch (_) { return '' }
  }
  if (!rec.rawFile) return ''
  const a = apiOf()
  if (!a?.dataReadFile) return ''
  const r = await a.dataReadFile({ sub: BACKUP_SUB, name: rec.rawFile })
  if (!r || !r.ok || !r.text) return ''
  rec.text = r.text
  return r.text
}

let saveTimer = null

/* ---------------- 路径类设置保护 ----------------
 * 「首次打开路径被重置」的另一个入口：某个时序把 store.settings 换成了默认值，
 * 随后的 saveItems / saveSettings 会把空路径一起写进 library.json 与 localStorage，
 * 磁盘上原本有效的酒馆路径、扫描路径就此被覆盖。
 * 这里记住每个路径键最后一次的非空值，写盘前用它兜住空值。 */
const PATH_SETTING_KEYS = [
  'tavernPath', 'scanPath', 'backupLastDir', 'tavernUrl', 'stUser',
  'previewAvatarUser', 'previewAvatarChar', 'previewBg'
]
let lastGoodSettings = {}
function guardPathSettings(obj) {
  if (!obj || typeof obj !== 'object') return obj
  for (const k of PATH_SETTING_KEYS) {
    const cur = obj[k]
    const empty = cur === undefined || cur === null || String(cur).trim() === ''
    if (empty) {
      if (lastGoodSettings[k]) obj[k] = lastGoodSettings[k]
    } else {
      lastGoodSettings[k] = cur
    }
  }
  return obj
}

/** 立即整库落盘（切数据目录、清库等关键路径用）—— 只写 library.json，不再写 localStorage 正文 */
export function saveItems() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  /* 写盘前先把内存里被清空的路径类设置补回来：
     整库写入会带着 settings 一起落盘，这里不挡一道，空路径就会顺着 library.json 传下去 */
  guardPathSettings(store.settings)
  /* 启动保护：json 还没读进内存（bootHydrated=false）而内存是空的，这一笔绝不能落盘 ——
     localStorage 降级成时间戳后，内存起步就是空库，此时写一次就会把磁盘上好好的库清空。 */
  if (!bootHydrated && countItemsOf(store.items) === 0) return
  persistSnapshot('')
}

/**
 * 高频改动（批量导入、连续切版本、连续改字段）用它：
 * 一个时间窗内多次改动只整库序列化一次，避免每改一次就把整个库 stringify 两遍（localStorage + 快照）。
 */
export function scheduleSave(delay = 400) {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveItems()
  }, delay)
}

/* ---------------- 数据目录快照 ----------------
 * 除了 localStorage，再往「软件数据保存目录」写一份 library.json。
 * 换数据目录后重启，localStorage 是空的（新分区），靠这份快照把库接回来。
 */
/* 传给主进程（ipcRenderer.invoke）的数据必须是纯数据：结构化克隆不认 Proxy。
   Vue 的 reactive 对象（导入对话框里响应式数组中的 payload、刚导入未重启时的版本 raw）
   直接透传就会抛 "An object could not be cloned." —— 这里统一做一次去代理深拷贝。 */
export function toPlain(v, depth = 0) {
  if (v === null || v === undefined) return v
  if (typeof v !== 'object') return v
  if (depth > 40) return undefined
  if (v instanceof Uint8Array) return new Uint8Array(v)
  if (v instanceof ArrayBuffer) return v.slice(0)
  if (ArrayBuffer.isView(v)) {
    return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength))
  }
  if (Array.isArray(v)) {
    const out = new Array(v.length)
    for (let i = 0; i < v.length; i++) out[i] = toPlain(v[i], depth + 1)
    return out
  }
  const out = {}
  for (const k of Object.keys(v)) {
    const val = toPlain(v[k], depth + 1)
    if (val !== undefined) out[k] = val
  }
  return out
}

const apiOf = () => (typeof window !== 'undefined' ? window.api : null)
let snapTimer = null

/* ---------------- 权威源状态 ----------------
 * bootHydrated：内存里的库是否已经从 library.json 恢复过（恢复前禁止把空内存写盘）
 * dirtySinceSave：内存有还没落盘的改动（轮询时先写盘，别被磁盘上的旧内容盖掉）
 * knownStamp：上一次读/写到的 json 的戳（savedAt + 主进程给的 mtime / size）
 * lastSnapshotSig：我们自己最后写下去那份文本的签名，读回来一致就是自己写的，不用再拉 */
let bootHydrated = false
let dirtySinceSave = false
let knownStamp = { savedAt: '', mtimeMs: 0, size: 0 }
let lastSnapshotSig = ''
/* 内存「换代」计数：每次按外部 json 整体覆盖内存就 +1。
   覆盖前排队等着落盘的防抖任务拿着旧代号，fire 时发现代号变了就直接放弃，
   否则它会把覆盖前的旧内容晚一步写回磁盘（外部清理白做）。 */
let snapshotEpoch = 0

/** 生成 library.json 的正文：savedAt（UTC ISO）+ savedLocalAt（本机本地戳）一起写 */
function snapshotPayload(itemsJson) {
  let items = itemsJson
  if (!items) {
    try {
      items = JSON.stringify(slimItems())
    } catch (_) {
      items = '{}'
    }
  }
  let settings = '{}'
  try {
    /* 写快照前同样过路径保护：library.json 是换数据目录后唯一的救命数据，
       不能让一次内存里的空值把路径写没 */
    guardPathSettings(store.settings)
    settings = JSON.stringify(store.settings)
  } catch (_) {}
  const now = new Date()
  /* savedAt：UTC ISO，跨机跨时区拿来比对「谁更新」；savedLocalAt：本地时间，打开 json 一眼看到写入时刻 */
  const savedAt = now.toISOString()
  const savedLocalAt = localStamp(now)
  const text = `{"items":${items || '{}'},"settings":${settings},"savedAt":"${savedAt}","savedLocalAt":"${savedLocalAt}"}`
  return { text, savedAt, savedLocalAt }
}

/* 文本指纹直接用 lib/image.js 的 hashText（与侧车内容签名同一套），只用来判
   「读回来的这份是不是我自己刚写下去的」，不做安全用途 */
function sigOfText(text) {
  const s = String(text || '')
  try { return String(s.length) + ':' + hashText(s) } catch (_) { return String(s.length) }
}

/** 写成功后对齐「已知戳」，并把 savedAt 记进 localStorage 的缓存戳 */
function markStampWritten(payload, res) {
  knownStamp = {
    savedAt: String(payload?.savedAt || ''),
    mtimeMs: Number(res?.mtimeMs || 0),
    size: Number(res?.size || (payload?.text || '').length)
  }
  lastSnapshotSig = sigOfText(payload?.text)
  writeItemsStamp({ savedAt: knownStamp.savedAt, localAt: payload?.savedLocalAt })
  dirtySinceSave = false
}

function persistSnapshot(itemsJson, opt = {}) {
  const a = apiOf()
  if (!a?.saveLibrary) return
  if (snapTimer) { clearTimeout(snapTimer); snapTimer = null }
  const epoch = snapshotEpoch
  const fire = () => {
    snapTimer = null
    /* 内存已经被外部 json 整体换过：这一笔是旧内容，写下去等于撤销外部修改 */
    if (epoch !== snapshotEpoch) return
    let payload = null
    try { payload = snapshotPayload(itemsJson) } catch (_) { return }
    let p = null
    try { p = a.saveLibrary(payload.text) } catch (_) { dirtySinceSave = true; return }
    const done = (res) => {
      if (res && res.ok === false) { dirtySinceSave = true; lastSnapshotSig = ''; return }
      markStampWritten(payload, res)
    }
    if (p && typeof p.then === 'function') p.then(done).catch(() => { dirtySinceSave = true })
    else done({ ok: true })
  }
  if (opt.immediate) fire()
  else snapTimer = setTimeout(fire, 600)
}

/** 立即落盘（切换数据目录前调用，保证新目录拿到的是最新数据） */
export async function flushSnapshot() {
  const a = apiOf()
  if (!a?.saveLibrary) return false
  if (snapTimer) { clearTimeout(snapTimer); snapTimer = null }
  let payload = null
  try { payload = snapshotPayload('') } catch (_) { return false }
  let r = null
  try { r = await a.saveLibrary(payload.text) } catch (_) { return false }
  if (!r || r.ok === false) return false
  markStampWritten(payload, r)
  return true
}

function hasItemId(id) {
  if (!id) return false
  for (const k of CAT_KEYS) {
    for (const it of store.items[k] || []) {
      if (it && String(it.id) === String(id)) return true
    }
  }
  return false
}

/**
 * 用 json 里的条目「整体覆盖」内存（不做按 id 并集合并）。
 * 并集合并会把外部（手工清理 / 备份还原）已经删掉的条目从内存里再反填回去，
 * 这正是旧逻辑「删了又复活」的根子 —— 所以这里只做替换。
 */
function applySnapshotItems(items) {
  const restored = emptyItems()
  for (const k of CAT_KEYS) restored[k] = Array.isArray(items?.[k]) ? items[k] : []
  markRawPayloads(restored)
  ensureCurrentVersion(restored)
  const tagged = tagCategories(restored)
  const count = countItemsOf(tagged)
  const wasWatching = !!itemsWatcher
  /* 覆盖期间摘掉深 watch：否则整库赋值会触发一次「把刚拉到的东西再写回去」的无用落盘 */
  if (wasWatching) suspendItemsSave()
  store.items = tagged
  /* 外部删掉的条目若正被选中 / 正在详情页里，引用一并清掉，别留一个点不掉的空白详情 */
  if (store.currentId && !hasItemId(store.currentId)) store.currentId = null
  if (Array.isArray(store.selected) && store.selected.length) {
    store.selected = store.selected.filter((id) => hasItemId(id))
    if (!store.selected.length) store.selectMode = false
  }
  if (wasWatching) startItemsWatch()
  /* 换代：把覆盖前排队未落盘的改动作废（包括 400ms 的 scheduleSave 与 600ms 的快照防抖） */
  snapshotEpoch += 1
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (snapTimer) {
    clearTimeout(snapTimer)
    snapTimer = null
  }
  dirtySinceSave = false
  return count
}

/** 磁盘上的 json 是否比「我们上次读/写的那个版本」更新 */
function stampIsNewer(next) {
  if (!knownStamp.savedAt && !knownStamp.mtimeMs && !knownStamp.size) return true
  if (next.savedAt && knownStamp.savedAt && next.savedAt !== knownStamp.savedAt) return true
  if (next.mtimeMs && knownStamp.mtimeMs && next.mtimeMs !== knownStamp.mtimeMs) return true
  if (next.size && knownStamp.size && next.size !== knownStamp.size) return true
  return false
}

/** 从数据目录读 library.json（唯一真相），按需整体覆盖内存 */
async function pullFromDataFile(opt = {}) {
  const a = apiOf()
  if (!a?.loadLibrary) return { ok: false, reason: 'no-api', changed: false }
  let r = null
  try { r = await a.loadLibrary() } catch (_) { r = null }
  if (!r || !r.ok || !r.text) return { ok: false, reason: 'no-snapshot', changed: false }
  const text = String(r.text)
  let snap = null
  try { snap = JSON.parse(text) } catch (_) { return { ok: false, reason: 'bad-json', changed: false } }
  if (!snap || typeof snap !== 'object' || !snap.items || typeof snap.items !== 'object') {
    return { ok: false, reason: 'bad-json', changed: false }
  }
  const next = {
    savedAt: String(snap.savedAt || ''),
    mtimeMs: Number(r.mtimeMs || 0),
    size: Number(r.size || text.length)
  }

  /* ① 内容就是我们自己刚写下去那份：只对齐戳，不重建内存（免得打断正在编辑的状态） */
  if (!opt.force && lastSnapshotSig && sigOfText(text) === lastSnapshotSig) {
    knownStamp = next
    writeItemsStamp({ savedAt: next.savedAt })
    return { ok: true, changed: false, reason: 'self-write' }
  }
  /* ② 时间戳没动 = 外部没改过，不白拉一遍 */
  if (!opt.force && !stampIsNewer(next)) {
    fillSettingsFromSnapshot(snap.settings)
    return { ok: true, changed: false, reason: 'unchanged' }
  }

  const before = countItemsOf(store.items)
  const count = applySnapshotItems(snap.items)
  knownStamp = next
  writeItemsStamp({ savedAt: next.savedAt })
  fillSettingsFromSnapshot(snap.settings)
  const changed = opt.force ? count !== before : true
  if (opt.notify && changed) showToast(`已按 library.json 同步 ${count} 个条目`)
  else if (opt.bootToast && before === 0 && count > 0) showToast(`已从数据目录恢复 ${count} 个条目`)
  return { ok: true, changed, reason: 'pulled', count, before }
}

/**
 * 启动恢复：以数据目录的 library.json 为唯一真相重建内存。
 * 只要 json 存在且可解析就用它整体重建（不再判 localStorage 是否为空 ——
 * 以前那个判断让旧缓存成了事实上的权威源）。
 * json 缺失或损坏时才回落 localStorage（旧版整包缓存），并立即补写 json。
 */
export async function hydrateFromDataFile(opt = {}) {
  const a = apiOf()
  if (!a?.loadLibrary) { bootHydrated = true; return false }
  const res = await pullFromDataFile({
    force: opt.force !== false,
    notify: !!opt.notify,
    bootToast: opt.toast !== false
  })
  if (res.ok) {
    bootHydrated = true
    return !!res.changed
  }
  /* 走到这里：json 不存在 / 解析失败。回落 localStorage 的旧整包缓存（loadItems 已读进内存的
     那份，或这里再取一次），然后立刻把内存补写回 json，避免下次启动还是无源可读。 */
  bootHydrated = true
  let total = countItemsOf(store.items)
  if (!total) {
    const legacy = legacyCachedItems()
    if (legacy) total = applySnapshotItems(legacy)
  }
  if (total > 0) {
    const wrote = await flushSnapshot()
    if (wrote) showToast(`数据文件缺失，已按本机缓存重建 ${total} 个条目`)
  }
  return false
}

/**
 * 运行期同步（窗口聚焦 / 可见性变化 / 定时轮询调它）：
 * 外部对 library.json 的改动（手工清理、备份还原、另一处的写入）在这里生效。
 */
export async function syncFromDataFile(opt = {}) {
  if (!bootHydrated) return await hydrateFromDataFile(opt)
  /* 本地还有没落盘的改动：先把手里的写下去，不能被磁盘上的旧内容盖掉 */
  if (dirtySinceSave) { saveItems(); return false }
  const res = await pullFromDataFile({ force: false, notify: opt.notify !== false })
  return !!res.changed
}

/** 立刻同步一次（聚焦 / 可见性变化用） */
export async function syncLibraryNow() {
  return syncFromDataFile({ notify: true })
}

let libSyncTimer = null

/** 定时轮询 library.json（窗口隐藏时跳过，不白白读盘） */
export function startLibrarySync(intervalMs = 10000) {
  stopLibrarySync()
  const ms = Math.max(3000, Number(intervalMs) || 10000)
  libSyncTimer = setInterval(() => {
    try {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    } catch (_) {}
    Promise.resolve(syncFromDataFile({ notify: true })).catch(() => {})
  }, ms)
  return libSyncTimer
}

export function stopLibrarySync() {
  if (libSyncTimer) {
    clearInterval(libSyncTimer)
    libSyncTimer = null
  }
}

/**
 * 把快照里的设置补回内存：只补当前为空 / 缺失的键，用户刚改过的值不动。
 * @returns {boolean} 是否有键被补回
 */
function fillSettingsFromSnapshot(snapSettings) {
  if (!snapSettings || typeof snapSettings !== 'object') return false
  let n = 0
  for (const k of Object.keys(snapSettings)) {
    const v = snapSettings[k]
    if (v === undefined || v === null) continue
    if (typeof v === 'string' && !v.trim()) continue
    const cur = store.settings[k]
    const empty = cur === undefined || cur === null || (typeof cur === 'string' && !cur.trim())
    if (empty) {
      store.settings[k] = v
      n++
    }
  }
  if (n) {
    guardPathSettings(store.settings)
    saveSettings()
  }
  return n > 0
}

/** 清空资料库所有条目（设置保留）。用于清除早期示例 / 测试数据 */
export function clearLibrary() {
  store.items = emptyItems()
  store.currentId = null
  store.selected = []
  store.selectMode = false
  saveItems()
  showToast('资料库条目已清空，设置已保留')
}

function loadSettings() {
  const def = {
    tavernPath: '',
    tavernUrl: 'http://127.0.0.1:8000',
    stUser: 'default-user',
    autoDetect: true,
    // 导出 / 备份上一次用过的目录（不再作为「备份路径」设置项，只是记住位置）
    backupLastDir: '',
    dcConcurrency: 3,
    blacklist: [],
    // 扫描下载：监控指定目录，发现新的卡 / 世界书就提示导入
    scanPath: '',
    scanOnStart: true,
    scanRecursive: false,
    scanExts: ['png', 'json', 'zip'],
    scanIgnored: [],
    // 排序：只按日期，升序 / 降序
    sortMode: 'date-desc',
    // 软件更新源：仓库地址写死，跟着 settings 一起存只是为了界面上有值可显示
    updateOwner: 'Rokii-77',
    updateRepo: 'TavernLib',
    // 用户点过「忽略本次更新」的版本号：同版本不再弹提示，有更新版本照常提示
    ignoredUpdateVersion: '',
    // 启动检查更新做过的日期（YYYY-MM-DD）：一天最多打一次 GitHub 接口
    updateLastCheckDay: '',
    // 外观：dark 夜间 / light 日间 / auto 跟随系统，以及用户自定义 CSS（空 = 不注入）
    theme: 'auto',
    customCss: '',
    // 美化详情页的预览头像（只存图片哈希；全局一份，换任意美化都继续生效）
    previewAvatarUser: '',
    previewAvatarChar: '',
    // 美化详情页预览用的聊天背景图（同样只存哈希，图片本体在本地图片仓库）
    previewBg: '',
    // 首次使用初始化指引是否已看过：false / 缺省时启动自动弹一次
    onboarded: false
  }
  /* 读设置：主键解析失败时退回备份键，最后才用默认值补缺。
     以前 JSON 一坏就整份 return def —— 用户填好的酒馆路径 / 扫描路径会被默认值
     一次性冲掉，这是「首次打开设置被重置」的直接原因之一。 */
  let s = { ...def }
  try {
    let obj = null
    for (const key of [SETTINGS_KEY, SETTINGS_BAK_KEY]) {
      const raw = localStorage.getItem(key)
      if (!raw) continue
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') {
          obj = parsed
          break
        }
      } catch (_) {
        /* 这份坏了，试下一份 */
      }
    }
    s = obj ? { ...def, ...obj } : { ...def }
    /* 更新源写死在代码里（设置页不让手填）：历史数据里残留的任何值一律纠正，
       否则回退会拿着脏 owner/repo 去请求，接口 404 被误判成「仓库或 Release 不存在」 */
    s.updateOwner = DEFAULT_UPDATE_SOURCE.owner
    s.updateRepo = DEFAULT_UPDATE_SOURCE.repo
    if (!Array.isArray(s.scanIgnored)) s.scanIgnored = []
    if (!Array.isArray(s.scanExts) || !s.scanExts.length) s.scanExts = def.scanExts
    // 清掉已废弃的设置项：抓标题方式、单独的备份路径（备份改为跟随上次使用的目录，不再单独设置）
    delete s.dcProbeMode
    delete s.backupPath
    // 排序：日期升序 / 降序 / 名称，非法值回落日期倒序
    if (!['date-asc', 'date-desc', 'name'].includes(s.sortMode)) s.sortMode = 'date-desc'
    // 外观：主题非法值回落跟随系统；自定义 CSS 必须是字符串
    if (!['dark', 'light', 'auto'].includes(s.theme)) s.theme = 'auto'
    if (typeof s.customCss !== 'string') s.customCss = ''
    /* 把这次读到的有效路径记成保护基线：后面任何一次写盘遇到空值都能拿它兜住 */
    for (const k of PATH_SETTING_KEYS) {
      if (s[k] !== undefined && s[k] !== null && String(s[k]).trim() !== '') lastGoodSettings[k] = s[k]
    }
    return s
  } catch (_) {
    /* 归一过程中出错也只丢出错的字段，不再把整份设置打成默认值 */
    return s
  }
}

export function saveSettings() {
  /* 写盘前先过一遍路径保护：内存里若被清空，不要让它覆盖磁盘上的有效路径 */
  guardPathSettings(store.settings)
  const text = JSON.stringify(store.settings)
  try {
    localStorage.setItem(SETTINGS_KEY, text)
    /* 同写一份备份：主键被写坏时还能把设置救回来 */
    localStorage.setItem(SETTINGS_BAK_KEY, text)
  } catch (_) {}
  // 快照里同时含 settings，合并到下一次整库写入，避免改个排序就整库序列化一次
  scheduleSave(500)
}

/* ---------------- 首次使用初始化指引 ----------------
 * 判断依据只有 settings.onboarded：新装（localStorage 空）或老库没这个字段都会弹一次。
 * 「看过」的三个入口（走完最后一步 / 右上角 × / 跳过）都调用 finishFirstRun，
 * 保证不会每次启动都来打扰；想再看得去 设置 → 维护 手动打开。 */
export function openFirstRun() {
  store.firstRun.visible = true
}

export function finishFirstRun() {
  try {
    if (!store.settings.onboarded) {
      store.settings.onboarded = true
      saveSettings()
    }
  } catch (_) {}
  store.firstRun.visible = false
}

/** 启动时是否需要弹：没看过就弹，看过就静默 */
export function shouldShowFirstRun() {
  try {
    return !store.settings.onboarded
  } catch (_) {
    return false
  }
}

/** 首启第三步走完后的界面指引（气泡依次指向导入按钮、链接导入、文件导入、酒馆导入） */
export function startOnboardTour() {
  store.onboardTour.step = 0
  store.onboardTour.visible = true
}
export function endOnboardTour() {
  store.onboardTour.visible = false
  store.onboardTour.step = 0
}

/* ---------------- 外观：日 / 夜 / 跟随系统 + 自定义 CSS ---------------- */

/** 切到指定主题（dark / light / auto）：立即上屏，并记住选择 */
export function setTheme(mode) {
  const m = ['dark', 'light', 'auto'].includes(mode) ? mode : 'auto'
  applyTheme(m)
  store.settings.theme = m
  saveSettings()
  return m
}

/** 顶栏那一个按钮：在 日间 / 夜间 之间来回切（auto 时按当前实际外观取反） */
export function toggleTheme() {
  const now = resolveTheme(store.settings.theme)
  return setTheme(now === 'light' ? 'dark' : 'light')
}

/** 应用自定义 CSS（传空串 = 撤掉自定义，回到内置外观） */
export function setCustomCss(css) {
  const text = String(css == null ? '' : css)
  applyCustomCss(text)
  store.settings.customCss = text
  saveSettings()
  return text
}

/** 启动时按已保存的设置把主题和自定义 CSS 铺上（在 mount 之前调用，避免闪一下） */
export function applyAppearanceFromSettings() {
  applyTheme(store.settings.theme)
  applyCustomCss(store.settings.customCss)
  /* 跟随系统时，系统换深浅色要跟着变；只挂一次 */
  if (!applyAppearanceFromSettings._watching) {
    applyAppearanceFromSettings._watching = true
    onSystemThemeChange(() => {
      if (store.settings.theme === 'auto') applyTheme('auto')
    })
  }
}

export const store = reactive({
  tab: 'characters',
  search: '',
  /** 搜索版本号：每次清空 / 重新设置都 +1，书架用它做「渲染分页 + 滚动」复位 */
  searchEpoch: 0,
  currentId: null,
  items: loadItems(),

  menu: { visible: false, x: 0, y: 0, items: [] },
  toast: { visible: false, text: '' },

  selectMode: false,
  selected: [],
  anchorIndex: -1,

  settings: loadSettings(),
  stStatus: {
    connected: false,
    host: 'http://127.0.0.1:8000',
    ms: 0,
    checkedAt: '',
    checking: false,
    config: { ok: false, port: 0, url: '', path: '', error: '', fromFile: false },
    /* 酒馆端扩展是否在线（桥 /health 的 ext 字段透传）：与酒馆本身是否连通分开判 */
    extOnline: false,
    extAgoMs: null,
    extCheckedAt: '',
    bridgeRunning: false,
    bridgePort: 0,
    /* 酒馆当前在用哪张卡 / 什么版本（来自扩展 POST /state 上报，30 秒没更新算过期） */
    inUseName: '',
    inUseVersion: '',
    inUseExtVersion: '',
    inUseFresh: false,
    inUseAgoMs: null
  },

  /** 自动扫描到的新文件（右下角可拖动小气泡） */
  scan: {
    running: false,
    files: [],
    bubbleOpen: false,
    lastAt: '',
    bubblePos: { x: null, y: null }
  },

  /** 后台任务（大批量导入等）：只显示一个小进度条，不挡操作 */
  bgJob: { active: false, label: '', done: 0, total: 0, hint: '', doneAll: false },

  importDialog: { visible: false, rows: [], busy: false, dcUrl: '', from: 'file' },
  settingsPanel: { visible: false },
  /** 首次使用初始化指引（由 App.vue 挂载，设置 → 维护 可重新打开） */
  firstRun: { visible: false },
  onboardTour: { visible: false, step: 0 },
  dcDialog: { visible: false, itemId: '', url: '', title: '', busy: false, hint: '' },

  check: { running: false, scope: '', total: 0, done: 0, lastAt: '' },

  appUpdate: {
    lastAt: '',
    hasUpdate: false,
    latest: '',
    current: '',
    notes: '',
    url: '',
    downloadUrl: '',
    downloadName: '',
    downloadDigest: '',
    downloadSize: 0,
    ignored: false,
    /* 检查链路信息：走的哪条通道、怎么校验、失败了属于哪种错 */
    channel: '',
    channelLabel: '',
    verify: '',
    verifyLabel: '',
    manifest: false,
    manifestNote: '',
    kind: '',
    error: '',
    hint: ''
  },

  /** 更新包下载/安装进度：右下角弹窗与设置面板共用同一份状态 */
  upd: { phase: 'idle', mode: '', percent: 0, received: 0, total: 0, error: '', pkg: '', sha256: '', toVersion: '' },

  /** 酒馆里的扩展版本与软件内置不一致时的提醒（右下角弹窗，提示重新注入） */
  extRemind: { visible: false, installed: true, builtin: '', tavern: '', path: '', busy: false, state: '' },

  /** 更新看门狗：新版装完没正常启动时，提示回退到上一版 */
  rollback: { suspect: false, from: '', to: '', attempts: 0, target: '', busy: false, hint: '' }
})

// 条目与设置变动后自动落盘，重启不丢
// 条目变动后自动落盘（合并写入：一个时间窗内多次改动只整库序列化一次）
// 用可暂停的 watcher：批量写入时先摘掉 deep watch，避免每写一行就把全量 traverse 一次
let itemsWatcher = null

function startItemsWatch() {
  if (itemsWatcher) return
  itemsWatcher = watch(
    () => store.items,
    () => {
      /* 内存已领先磁盘：轮询/聚焦时先写盘，别被磁盘上的旧内容盖掉 */
      dirtySinceSave = true
      scheduleSave()
    },
    { deep: true }
  )
}
startItemsWatch()

/** 批量写入前调用：暂停条目深遍历 + 自动落盘 */
export function suspendItemsSave() {
  if (itemsWatcher) {
    itemsWatcher()
    itemsWatcher = null
  }
}

/** 批量写入结束后调用：恢复监听并一次性落盘 */
export function resumeItemsSave() {
  startItemsWatch()
  saveItems()
}
watch(
  () => store.settings,
  () => saveSettings(),
  { deep: true }
)

export const tabs = [
  { key: 'characters', label: '角色卡', unit: '个' },
  { key: 'worldbooks', label: '世界书', unit: '个' },
  { key: 'presets', label: '预设', unit: '个' },
  { key: 'themes', label: '美化', unit: '个' },
  { key: 'others', label: '其他', unit: '个' }
]

export const allItems = computed(() => tabs.flatMap((t) => store.items[t.key] || []))

/** 有条目被检查出「有新版本」时，把它们整体提到最前（组内仍按原排序） */
function hasUpdateFlag(it) {
  return it && it.dc && it.dc.hasUpdate === true ? 1 : 0
}

/**
 * 各分类「有多少条检查出了更新」。
 * 顶栏分类页签据此挂角标：检查完更新后不用一条条切过去才知道哪一类有变化。
 * all 键是总数，供顶栏按钮/提示复用。
 */
export const updateCounts = computed(() => {
  const out = { all: 0 }
  for (const t of tabs) {
    let n = 0
    for (const it of store.items[t.key] || []) n += hasUpdateFlag(it)
    out[t.key] = n
    out.all += n
  }
  return out
})

function sortList(list) {
  // 大类排序：日期升序 / 降序 / 名称（拼音）；有更新的条目永远排在最前
  const mode = store.settings.sortMode
  const arr = list.slice()
  if (mode === 'name') {
    arr.sort((a, b) => {
      const ua = hasUpdateFlag(a)
      const ub = hasUpdateFlag(b)
      if (ua !== ub) return ub - ua
      return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN')
    })
    return arr
  }
  const sign = mode === 'date-asc' ? 1 : -1
  arr.sort((a, b) => {
    const ua = hasUpdateFlag(a)
    const ub = hasUpdateFlag(b)
    if (ua !== ub) return ub - ua
    const da = String(a.date || a.updatedAt || a.createdAt || '')
    const db = String(b.date || b.updatedAt || b.createdAt || '')
    if (da === db) return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN')
    return da > db ? sign : -sign
  })
  return arr
}

/**
 * 排序只依赖「分类 + 排序方式 + 条目集合」，与搜索词无关。
 * 单独抽成 computed，打字搜索时只做一次过滤，不用每敲一个字就把整类重新排序。
 */
const sortedTabList = computed(() => sortList(store.items[store.tab] || []))

/**
 * 搜索用的小写缓存：避免每次输入都对每个条目重算 toLowerCase（WeakMap 不阻塞 GC）。
 * 缓存带签名：条目被重命名后自动失效，否则搜索会一直用旧名字，
 * 出现「输入关键词但列表不变化」的假失效。
 * 注意：命中判定只认标题（name），描述与标签不参与，避免「何」因为标签 #世界观 被误命中。
 */
const lowCache = new WeakMap()
function lowSig(item) {
  return String(item.name || '')
}
function lowOf(item) {
  const sig = lowSig(item)
  let v = lowCache.get(item)
  if (!v || v.sig !== sig) {
    v = { sig, name: String(item.name || '').toLowerCase() }
    lowCache.set(item, v)
  }
  return v
}

/** 清空搜索：一次性把关键词与版本号都归零，界面据此回到全量第一页 */
export function clearSearch() {
  store.search = ''
  store.searchEpoch = (store.searchEpoch || 0) + 1
}

/** 设置搜索词（外部按钮/标签点击用） */
export function setSearch(kw) {
  store.search = String(kw == null ? '' : kw)
  store.searchEpoch = (store.searchEpoch || 0) + 1
}

export const currentList = computed(() => {
  // 关键词规范化：去全角空格 / 不间断空格 / 不可见字符，统一小写。
  // 多个词按空格切开后「全部出现在标题里」才算匹配（"银 少女" 这种组合也能查到）
  const raw = String(store.search == null ? '' : store.search)
    .replace(/[\u3000\u00A0\uFFFD\u200B-\u200D\uFEFF]/g, ' ')
    .trim()
    .toLowerCase()
  const sorted = sortedTabList.value
  if (!raw) return sorted
  const tokens = raw.split(/\s+/).filter(Boolean)
  if (!tokens.length) return sorted
  const out = []
  for (const it of sorted) {
    const title = lowOf(it).name
    let hit = true
    for (const kw of tokens) {
      if (!title.includes(kw)) {
        hit = false
        break
      }
    }
    if (hit) out.push(it)
  }
  return out
})

/** 切换大类排序：date-asc / date-desc / name */
const SORT_MODES = ['date-asc', 'date-desc', 'name']
export function setSortMode(mode) {
  store.settings.sortMode = SORT_MODES.includes(mode) ? mode : 'date-desc'
  store.settings.sortUserPicked = true
  saveSettings()
}

export const currentItem = computed(() => {
  if (!store.currentId) return null
  return (store.items[store.tab] || []).find((it) => it.id === store.currentId) || null
})

const selectedIdSet = computed(() => new Set(store.selected))

export const selectedItems = computed(() =>
  allItems.value.filter((it) => selectedIdSet.value.has(it.id))
)

/** 选中 id 集合：模板里判选中态用 Set.has，避免每张卡都 includes 线性扫描（O(n²)） */
export const selectedSet = computed(() => new Set(store.selected))

/* ---------------- 基础交互 ---------------- */

export function openItem(id) {
  if (!id) return
  // 自动定位条目所在分类：否则 currentItem 在别的 tab 下找不到，详情页就打不开
  const keys = tabs.map((t) => t.key)
  if (!(store.items[store.tab] || []).some((it) => it.id === id)) {
    const hit = keys.find((k) => (store.items[k] || []).some((it) => it.id === id))
    if (hit) store.tab = hit
  }
  store.currentId = id
}

export function closeDetail() {
  store.currentId = null
}

export function showToast(text) {
  store.toast.text = text
  store.toast.visible = true
  clearTimeout(showToast._t)
  showToast._t = setTimeout(() => (store.toast.visible = false), 2400)
}

export function openMenu(e, items) {
  e.preventDefault()
  e.stopPropagation()
  store.menu.items = items
  /* 带明细的项更高（可能好几行聊天记录），按实际行数估高度，别把菜单顶出屏幕 */
  const h = items.reduce((s, m) => {
    if (m.divider) return s + 9
    if (!m.desc) return s + 34
    return s + 34 + String(m.desc).split('\n').length * 17
  }, 10)
  store.menu.x = Math.min(e.clientX, window.innerWidth - 260)
  store.menu.y = Math.max(8, Math.min(e.clientY, window.innerHeight - h - 16))
  store.menu.visible = true
}

export function closeMenu() {
  store.menu.visible = false
}

/* ---------------- 多选 ---------------- */

export function setSelectMode(on) {
  store.selectMode = on
  if (!on) store.selected = []
  store.anchorIndex = -1
}

export function isSelected(id) {
  return selectedSet.value.has(id)
}

/**
 * 点击卡片时的选中行为（对齐 Win10 资源管理器）：
 * 普通点击 = 只选它一个；Ctrl 点击 = 追加/取消；Shift 点击 = 从上一张到这张的区间。
 */
export function handleSelectClick(id, ev) {
  const list = currentList.value
  const idx = list.findIndex((x) => x.id === id)
  const ctrl = ev.ctrlKey || ev.metaKey
  const shift = ev.shiftKey

  if (shift && store.anchorIndex >= 0) {
    const [a, b] = [store.anchorIndex, idx].sort((x, y) => x - y)
    const range = list.slice(a, b + 1).map((x) => x.id)
    store.selected = Array.from(new Set([...store.selected, ...range]))
    return
  }

  if (ctrl) {
    store.selected = isSelected(id)
      ? store.selected.filter((x) => x !== id)
      : [...store.selected, id]
    store.anchorIndex = idx
    return
  }

  store.selected = [id]
  store.anchorIndex = idx
}

/** 框选：传入一组 id 整体替换/追加 */
export function selectByRect(ids, additive) {
  store.selected = additive ? Array.from(new Set([...store.selected, ...ids])) : ids
}

export function selectAllVisible() {
  store.selected = currentList.value.map((x) => x.id)
}

export function clearSelect() {
  store.selected = []
}

/* ---------------- 黑名单 ---------------- */

export function isBlacklisted(it) {
  if (!it) return false
  const bl = store.settings.blacklist || []
  return bl.some((k) => {
    const t = String(k || '').trim()
    if (!t) return false
    if (it.dc?.url && it.dc.url === t) return true
    return it.name.includes(t)
  })
}

/* ---------------- DC 链接与更新检查 ---------------- */

const todayStr = () => new Date().toISOString().slice(0, 10)
const nowStr = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })

/** 取（并补齐）条目的 DC 信息结构 */
export function dcOf(it) {
  if (!it.dc || typeof it.dc !== 'object') it.dc = {}
  const dc = it.dc
  if (typeof dc.url !== 'string') dc.url = ''
  if (typeof dc.title !== 'string') dc.title = ''
  if (typeof dc.latestTitle !== 'string') dc.latestTitle = ''
  if (typeof dc.hasUpdate !== 'boolean') dc.hasUpdate = false
  if (typeof dc.titleAt !== 'string') dc.titleAt = ''
  if (typeof dc.lastCheckAt !== 'string') dc.lastCheckAt = ''
  return dc
}

/** 首次填写 / 修改链接：把此刻的标题记为基准标题 */
export function setDcLink(it, { url, title }) {
  const dc = dcOf(it)
  dc.url = String(url || '').trim()
  dc.title = String(title || '').trim()
  dc.titleAt = dc.title ? todayStr() : ''
  dc.latestTitle = ''
  dc.hasUpdate = false
  dc.lastCheckAt = ''
}

/** 手动更新基准标题 */
export function setDcTitle(it, title) {
  const dc = dcOf(it)
  dc.title = String(title || '').trim()
  dc.titleAt = todayStr()
  dc.latestTitle = ''
  dc.hasUpdate = false
}

/** 读取 DC 当前标题：后台静默抓（隐藏浏览器） */
export async function probeDcTitle(url) {
  if (!window.api?.probeDcMany) return { ok: false, reason: 'NO_BRIDGE' }
  try {
    const r = await window.api.probeDcMany({
      urls: [url],
      concurrency: 1
    })
    const one = r && r.list && r.list[0]
    if (one) return one
    return { ok: false, reason: 'NETWORK' }
  } catch (e) {
    return { ok: false, reason: 'NETWORK', error: String(e && e.message ? e.message : e) }
  }
}

const REASON_TEXT = {
  NEED_TOKEN: '需要登录 Discord 才能读帖子',
  BAD_LINK: '链接格式不对',
  EMPTY: '帖子里没有可读文本',
  NO_BRIDGE: '当前为浏览器预览，无法读取 DC',
  BROWSER_FAIL: '后台浏览器没抓到内容',
  NETWORK: '网络不可用',
}

/** 单条检查：把读到的当前标题与基准标题比对，不同即视为更新 */
export async function checkOneDc(it) {
  const dc = dcOf(it)
  if (!dc.url) return { id: it.id, skipped: true }
  const r = await probeDcTitle(dc.url)
  if (!r.ok) return { id: it.id, error: r.reason, message: REASON_TEXT[r.reason] || r.reason }
  const cur = String(r.title || '').trim()
  if (!cur) return { id: it.id, error: 'EMPTY', message: REASON_TEXT.EMPTY }

  const base = String(dc.title || '').trim()
  if (!base) {
    // 首次拿到标题：直接作为基准，不算更新
    dc.title = cur
    dc.titleAt = todayStr()
    dc.hasUpdate = false
    dc.lastCheckAt = nowStr()
    return { id: it.id, baselined: true }
  }
  dc.latestTitle = cur
  dc.latestAt = r.at || ''
  dc.hasUpdate = cur !== base
  dc.lastCheckAt = nowStr()
  return { id: it.id, updated: dc.hasUpdate, title: cur }
}

/** 打开 DC 链接，并把最新标题同步为当前标题 */
export function openDcAndSync(it) {
  const dc = dcOf(it)
  if (!dc.url) {
    showToast('还没设置 DC 链接')
    return
  }
  if (window.api?.openExternal) window.api.openExternal(dc.url)
  else showToast('请在桌面版中打开')

  if (dc.latestTitle) {
    dc.title = dc.latestTitle
    dc.titleAt = todayStr()
    dc.latestTitle = ''
  }
  dc.hasUpdate = false
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 检查更新（后台静默）
 * @param {'all'|'current'|'selected'} scope
 */
export async function runUpdateCheck(scope = 'all') {
  return runUpdateCheckFast(scope)
}

/* ---------------- DC 链接设置弹窗 ---------------- */

export function openDcDialog(it) {
  const dc = dcOf(it)
  store.dcDialog = {
    visible: true,
    itemId: it.id,
    url: dc.url,
    title: dc.title,
    busy: false,
    hint: dc.url ? '标题作为基准，之后检查更新时变了就说明有更新' : ''
  }
}

export function closeDcDialog() {
  store.dcDialog.visible = false
}

/** 弹窗内：尝试读取 DC 当前标题 */
export async function dcDialogReadTitle() {
  const d = store.dcDialog
  const url = String(d.url || '').trim()
  if (!url) {
    d.hint = '请先填写 DC 链接'
    return
  }
  d.busy = true
  const r = await probeDcTitle(url)
  d.busy = false
  if (r.ok) {
    d.title = r.title
    d.hint = '已读取到当前标题，将作为基准'
  } else {
    d.hint = (REASON_TEXT[r.reason] || r.reason) + '，可直接手动填写标题'
  }
}

/** 弹窗内：保存链接与基准标题（标题留空时，保存前自动去抓一次） */
export async function dcDialogSave() {
  const d = store.dcDialog
  const it = allItems.value.find((x) => x.id === d.itemId)
  if (!it) return
  if (d.busy) return

  const ck = checkUrl(d.url)
  if (!ck.ok) {
    d.hint = ck.error
    return
  }
  d.url = ck.url

  let title = cleanText(d.title)
  // 没有标题 或 点保存后自动抓一次（抓不到就按空标题保存，不会阻塞保存）
  if (!title) {
    d.busy = true
    try {
      const r = await probeDcTitle(ck.url)
      if (r && r.ok && r.title) {
        title = String(r.title).trim()
        d.title = title
      } else {
        const why = REASON_TEXT[r && r.reason] || (r && (r.error || r.reason)) || '没抓到标题'
        d.hint = `${why}，已先保存链接，检查更新时会自动记录首条标题`
      }
    } catch (e) {
      d.hint = '抓标题失败：' + String((e && e.message) || e) + '，已先保存链接'
    } finally {
      d.busy = false
    }
  }

  setDcLink(it, { url: d.url, title })
  const hint = d.hint
  closeDcDialog()
  showToast(
    title
      ? `已保存，基准标题：${title}`
      : hint || '已保存链接，检查更新时会自动记录首条标题'
  )
}

/* ---------------- 导入落库 ---------------- */

let seq = 1000
function nextId(prefix) {
  seq += 1
  return `${prefix}${Date.now().toString(36)}${seq}`
}

/** 版本原始文件内容（二进制）只放内存，不写 localStorage，避免撑爆 */
const BUFFERS = new Map()
export function setVersionBuffer(versionId, buf) {
  /* 缓存里也不能留 Proxy：导入时的 buffer 可能取自响应式行数据 */
  if (versionId && buf) BUFFERS.set(versionId, toPlain(buf))
}
export function getVersionBuffer(version) {
  if (!version) return null
  if (version.srcPath) return version.srcPath
  return BUFFERS.get(version.id) || null
}

const HUE_BY_CAT = { characters: 20, worldbooks: 195, presets: 280, themes: 330, others: 95 }

/** 稳定序列化（key 排序），保证同一份内容算出的指纹一致 */
function canonJson(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonJson).join(',') + ']'
  const keys = Object.keys(v).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonJson(v[k])).join(',') + '}'
}

/**
 * 版本级内容指纹：只要这四项一模一样（名字/描述/开场白/备选开场白），
 * 就认为同一条目里的「同一个版本」，与卡片内嵌的修改时间无关。
 * 这样同一张卡的两个版本备份进来，不会因为打包时间不同而多出一个版本。
 */
export function keyOfPayload(category, payload) {
  if (!payload) return ''
  if (category === 'characters') {
    const d = cardDataOf(payload)
    return hashText(canonJson({
      n: d.name || '',
      d: d.description || '',
      p: d.personality || '',
      s: d.scenario || '',
      f: d.first_mes || '',
      a: d.alternate_greetings || []
    }))
  }
  return hashText(canonJson(payload))
}

/** 该版本在酒馆里是否同款：签名或内容指纹命中一个就算 */
function versionMatches(v, sig, key) {
  if (!v) return false
  if (sig && v.sig && v.sig === sig) return true
  if (key && v.key && v.key === key) return true
  // 老数据没有 key：用版本里留存的原始 JSON 现算一份
  if (key && !v.key && v.raw) {
    const k = keyOfPayload(v.raw && v.raw.spec !== undefined ? 'characters' : 'others', v.raw)
    if (k && k === key) return true
  }
  return false
}

/* ---------------- 版本正文完整度 / 辅助指纹 ----------------
 * 背景：备份包里的 json 可能只是精简元数据（没有 first_mes），
 * 这类「残缺卡」算出来的 keyOfPayload 与库里的完整卡必然不同，
 * 于是绕过全部去重无条件新增成「第 2 版」——197 组重复就是这么来的。
 * 下面三个工具用来兜住这种情况：完整度打分、辅助指纹、同基名同日期的槽位判定。
 */

/** 版本正文完整度打分：开场白 / 描述 / 人设 / 场景 / 备选开场白越多分越高 */
export function payloadRichness(payload) {
  if (!payload || typeof payload !== 'object') return 0
  const d = cardDataOf(payload) || payload
  if (!d || typeof d !== 'object') return 0
  let n = 0
  for (const k of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'creator_notes']) {
    const v = d[k]
    if (typeof v !== 'string' || !v.trim()) continue
    n += v.trim().length >= 20 ? 2 : 1
  }
  const alt = Array.isArray(d.alternate_greetings) ? d.alternate_greetings.filter((x) => String(x || '').trim()).length : 0
  n += Math.min(alt, 5)
  return n
}

/**
 * 按类别给「正文完整度」打分。
 * payloadRichness 只认角色卡字段，世界书 / 美化 / 预设全被判成 0 分，
 * 于是「精简元数据 json」与「完整正文」同分，覆盖方向随机 —— 世界书 44 条条目被一张
 * 178 字节的空壳覆盖就是这么发生的。这里按类别各自算分，才能真正比出谁更完整。
 */
export function contentScoreOf(category, payload) {
  if (!payload || typeof payload !== 'object') return 0
  /* 老数据 / 测试数据可能没写 category：按 payload 形态反推类别，
     否则一律落进「其他」分支按 JSON 长度算分，角色卡空壳与完整卡分不出高下 */
  if (!category) {
    const d = cardDataOf(payload) || payload
    if (payload.spec || (d && (d.first_mes !== undefined || d.alternate_greetings !== undefined || d.personality !== undefined))) {
      category = 'characters'
    } else if (payload.entries || (payload.data && payload.data.entries)) {
      category = 'worldbooks'
    } else if (typeof payload.css === 'string' || typeof payload.customCSS === 'string' || typeof payload.custom_css === 'string') {
      category = 'themes'
    }
  }
  if (category === 'characters') return payloadRichness(payload)
  if (category === 'worldbooks') {
    const e = payload.entries || (payload.data && payload.data.entries)
    const n = e ? (Array.isArray(e) ? e.length : Object.keys(e).length) : 0
    return n * 4 + (String(payload.name || payload.bookName || '').trim() ? 1 : 0)
  }
  if (category === 'themes') {
    const css = String(payload.css ?? payload.customCSS ?? payload.custom_css ?? '').trim()
    const th = payload.theme && typeof payload.theme === 'object' ? Object.keys(payload.theme).length : 0
    return (css ? 4 + Math.min(Math.floor(css.length / 2000), 10) : 0) + (th ? 2 : 0)
  }
  if (category === 'presets') {
    let n = 0
    const body = payload.data && typeof payload.data === 'object' ? payload.data : payload
    for (const k of ['prompts', 'prompt_order', 'temperature', 'top_p', 'max_tokens', 'openai_max_tokens']) {
      const v = body[k] !== undefined ? body[k] : payload[k]
      if (Array.isArray(v) ? v.length : v !== undefined && v !== null && v !== '') n++
    }
    if (Array.isArray(body.prompts)) n += Math.min(Math.floor(body.prompts.length / 4), 6)
    return n
  }
  try {
    return Math.min(Math.floor(canonJson(payload).length / 400), 40)
  } catch (_) {
    return 0
  }
}

/** 正文是否为空壳（按类别判定）：角色卡看开场白/描述，其余看各自类别的完整度分 */
export function hasBodyOf(category, payload) {
  if (!payload || typeof payload !== 'object') return false
  if (category === 'characters') return hasCardBody(payload)
  /* 只剩 name / data 这类元信息时，各分类得分都 <= 1 */
  return contentScoreOf(category, payload) > 1
}

/** 正文是否为空壳：既没开场白也没描述（精简元数据 json 的典型形态） */
function hasCardBody(payload) {
  if (!payload || typeof payload !== 'object') return false
  const d = cardDataOf(payload) || payload
  if (!d || typeof d !== 'object') return false
  return !!(String(d.first_mes || '').trim() || String(d.description || '').trim())
}

/**
 * 辅助指纹：名称 + 版本名 + 日期。
 * 与 keyOfPayload（正文指纹）配合使用：正文指纹对「残缺卡 vs 完整卡」天然失效，
 * 辅助指纹不看正文，因此能认出「同一条目的同一个版本」，避免重复新增。
 */
export function auxKeyOfPayload(category, payload, extra = {}) {
  const d = category === 'characters' ? cardDataOf(payload) || {} : payload || {}
  const name = String(extra.name || (d && d.name) || '').trim().toLowerCase()
  const ver = String(extra.version || (d && (d.character_version || d.version)) || '').trim().toLowerCase()
  const day = String(extra.day || '').trim()
  if (!name && !ver) return ''
  return hashText(canonJson({ n: name, v: ver, d: day }))
}

/** 版本名基名：去掉「第 N 版」后缀，用于「同基名」判定 */
function verBaseName(n) {
  return String(n || '').replace(/\s*第\s*\d+\s*版\s*$/, '').trim().toLowerCase()
}

/**
 * 是否是同一个版本槽位。
 *  ① 辅助指纹（名称 + 版本名 + 日期）命中 → 同一个版本；
 *  ② 版本名完全相同 → 同一个版本（老库没有 aux，靠这条认）。
 * 刻意不再用「去掉『第 N 版』后同基名 + 同日期」这种松判定：
 * 备份包里 `2026-09-22`（44 条条目）与 `2026-09-22 第2版`（空壳）是两个真实版本，
 * 松判定会把后者并进前者，再用空壳覆盖正文 —— 版本数变少、世界书条目清零都是它干的。
 */
function sameVersionSlot(v, baseName, day, aux) {
  if (!v) return false
  if (aux && v.aux && v.aux === aux) return true
  const a = String(v.name || '').trim()
  const b = String(baseName || '').trim()
  return !!a && a === b
}

/**
 * 条目的「最完整版本」：当前版本有正文就用当前，否则取正文最全的那个。
 * 取代旧的「无条件 versions[0]」兜底 —— 空壳版抢占当前版本会让详情页读到空开场白。
 */
export function bestVersionOf(item) {
  const list = item && Array.isArray(item.versions) ? item.versions : []
  if (!list.length) return null
  const cat = (item && item.category) || ''
  const cur = list.find((v) => v.current) || null
  let best = list[0]
  let bestScore = contentScoreOf(cat, best.raw)
  for (const v of list) {
    const s = contentScoreOf(cat, v.raw)
    if (s > bestScore) {
      best = v
      bestScore = s
    }
  }
  if (cur && (hasBodyOf(cat, cur.raw) || !hasBodyOf(cat, best.raw))) return cur
  return best
}

/**
 * 修正条目的当前版本标记。
 * 两种异常都会修：
 *  1) 一个 current 都没有 → 补一个，且补的是正文最全的版本（而不是旧逻辑里的 versions[0]）；
 *  2) current 指向空壳版（既没开场白也没描述）、而同一版本槽位/其它版本里有正文 → 切到最完整的那个。
 *    老库里「备份精简版抢占当前版本」正是这么来的，不修就会一直读到空开场白。
 * 用户主动选过、且本身有正文的当前版本一律不动。
 */
export function ensureCurrentVersion(items) {
  const cats = items && typeof items === 'object' ? CAT_ORDER : []
  for (const k of cats) {
    for (const it of Array.isArray(items[k]) ? items[k] : []) {
      const list = it && Array.isArray(it.versions) ? it.versions : []
      if (!list.length) continue
      const best = bestVersionOf(it) || list[0]
      if (!best) continue
      const cat = it.category || k
      const cur = list.find((v) => v.current) || null
      const needFix = !cur || (cur !== best && !hasBodyOf(cat, cur.raw) && hasBodyOf(cat, best.raw))
      if (!needFix) continue
      try {
        for (const v of list) v.current = v === best
        it.stVersion = best.name || it.stVersion
        if (best.imgId) it.imgId = best.imgId
      } catch (_) {}
    }
  }
  return items
}

/** 从导入行里取图片，落进图片仓库，返回内容哈希（同内容只存一份） */
async function imageIdOfRow(r) {
  if (!r) return ''
  if (r.cover && isDataUrl(r.cover)) return await saveImageDataUrl(r.cover)
  if (r.cover && /^https?:/i.test(String(r.cover))) return ''
  if (r.buffer) {
    const bytes = r.buffer instanceof Uint8Array ? r.buffer : new Uint8Array(r.buffer)
    if (sniffImageMime(bytes)) return await saveImageBytes(bytes)
  }
  return ''
}

/**
 * 用新导入的行补全一个「已经存在」的版本。
 * 铁律：只有在「新内容更完整」时才覆盖正文，绝不拿残缺卡把完整卡冲掉。
 * @returns {boolean} 是否真的补全了内容
 */
function fillVersionPayload(v, r, cat, sig, key, aux) {
  if (!v || !r) return false
  let changed = false
  let incoming = null
  try {
    incoming = r.payload && typeof r.payload === 'object' ? toPlain(r.payload) : null
  } catch (_) {
    incoming = null
  }
  if (incoming) {
    /* 按类别比完整度：角色卡看卡字段，世界书看条目数，美化看 CSS，预设看参数/提示词。
       旧版只算角色卡分，世界书 / 美化永远同分，且 `!hasCardBody` 一命中就无条件覆盖，
       于是备份包里 178 字节的空壳把 44 条条目的世界书冲掉了。 */
    const oldScore = contentScoreOf(cat, v.raw)
    const newScore = contentScoreOf(cat, incoming)
    const oldBody = hasBodyOf(cat, v.raw)
    const newBody = hasBodyOf(cat, incoming)
    /* 只有在「新内容有正文」且「老内容没正文，或新内容明显更完整」时才覆盖 —— 绝不降级 */
    if (newBody && (!oldBody || newScore > oldScore)) {
      try { v.raw = markRaw(incoming) } catch (_) { v.raw = incoming }
      changed = true
    }
  }
  if (key && !v.key) { v.key = key; changed = true }
  if (sig && !v.sig) { v.sig = sig; changed = true }
  if (aux && !v.aux) { v.aux = aux; changed = true }
  if (!v.cardVersion && r.cardVersion) { v.cardVersion = String(r.cardVersion); changed = true }
  if (!v.imgId && r.imgId) { v.imgId = r.imgId; changed = true }
  if (changed) v.filledAt = new Date().toISOString()
  return changed
}

/**
 * 导入落库
 * @param {object[]} rows
 * @param {{replaceItem?:object}} opt replaceItem：同一批导入里已经确定要合并进去的条目名映射 */
export async function commitImport(rows, opt = {}) {
  const okRows = rows.filter((r) => !r.error && r.payload !== null)
  let created = 0
  let merged = 0
  /* 补全计数：命中已存在版本时不再是「无视跳过」，而是把残缺版本补成完整版 */
  let filled = 0
  /* 空壳跳过：备份包里非角色类别、正文全空的条目直接不建条目（详见下方空壳守卫） */
  let skippedEmpty = 0
  const emptyShellSkipped = []
  const duplicates = []
  // 同一批里内容重复的行先内部去重，避免「两个版本变三个版本」
  const seenKeys = new Set()
  /* 标签写法索引：本次导入只统计一次，之后边导入边把新标签补进去，
     保证同一批里先出现的写法被后续行复用（不会 Gemini / gemini 各出现一次） */
  let tagIdxCache = null
  const tagIdx = () => tagIdxCache || (tagIdxCache = tagCanonIndex())

  // 后台静默分批：每 CHUNK 行就让出主线程一帧，界面全程可操作
  const chunk = Math.max(1, Number(opt.chunk) || 40)
  const onProgress = typeof opt.onProgress === 'function' ? opt.onProgress : null
  let rowIndex = 0
  // 大批量：写盘前先暂停深遍历，写完整库只落盘一次
  const bulk = okRows.length > 40
  if (bulk) suspendItemsSave()
  try {

  for (const r of okRows) {
    if (rowIndex > 0 && rowIndex % chunk === 0) {
      onProgress?.({ done: rowIndex, total: okRows.length })
      await new Promise((res) => setTimeout(res, 0))
    }
    rowIndex++
    /* 行里没有类别时不要往 store.items[undefined] 里塞条目（会造出脏分类） */
    const cat = CAT_ORDER.includes(r.category) ? r.category : 'others'
    const target = store.items[cat] || (store.items[cat] = [])
    const rawName = (r.name || '').trim() || r.fileName
    /* 预设：名称 / 版本号在这里统一拆一次（导入、扫描、批量改名的最终落库都走这条路径）。
       用户可能在导入界面把「【Ako】1.9_Polaroid」手改成「Ako1.9_Polaroid」，
       所以每次都用当前名字重新解析：改过名的条目会按新名字归组，和「Ako」并成同一预设。 */
    let itemName = rawName
    let presetKey = ''
    let presetModel = ''
    let presetVer = ''
    if (cat === 'presets') {
      const pv = parsePresetName(rawName)
      itemName = String(pv.name || rawName).trim()
      presetKey = presetGroupKey(itemName, { bracketed: pv.bracketed })
      presetModel = String(r.model || pv.model || '').trim()
      presetVer = String(pv.version || '').trim()
    }
    const day = r.date || new Date().toISOString().slice(0, 10)
    const sig = r.sig || (r.payload ? sigOfPayload(cat, r.payload) : '')
    const key = r.key || keyOfPayload(cat, r.payload)
    r.key = key
    /* 版本名：默认就是这一版的日期（创建/修改取更早那天，读不到用导入日期），
       名字可自定义字母汉字；重名才顺延成「xxx 第 N 版」。
       必须在去重之前算出来 —— 「同基名同日期即同一版本」的合并规则要靠它。 */
    const baseName = (cat === 'presets' ? (presetVer || (r.version || '').trim()) : (r.version || '').trim()) || day
    /* 辅助指纹（名称 + 版本名 + 日期）：正文指纹对残缺卡天然失效，靠它兜住 */
    const aux = auxKeyOfPayload(cat, r.payload, { name: itemName, version: baseName, day })

    /* 同批去重不再「一律跳过」：正文指纹会被残缺卡撞车（同一角色的两个不同版本，
       描述/开场白相同而 mes_example 不同，指纹完全一样），一律 continue 会把真实版本吞掉。
       这里只做记录，真正的归并交给下面的槽位 / 指纹 / 跨条目匹配，且填充永不降级。 */
    if (key) {
      const batchKey = cat + '|' + key + '|' + (aux || baseName)
      if (seenKeys.has(batchKey)) {
        duplicates.push(itemName)
      } else {
        seenKeys.add(batchKey)
      }
    }

    let it = target.find((x) => x.name === itemName)
    // 预设还有一层「归组 key」匹配：名字写法不同的同一预设（Ako / Ako1.91…）也能并成多版本
    if (!it && presetKey) it = target.find((x) => x.presetKey === presetKey)

    /* 空壳守卫：备份包里除角色卡以外的条目（世界书 / 预设 / 主题 / 其他）没有 png 内嵌卡可回填，
       正文全空就说明包里本身就是个空条目，导进来只会堆出一张永远没内容的空卡。
       库里已有同名条目时照常走下面的合并/补全，不清空已有内容。 */
    if (!it && cat !== 'characters' && !hasBodyOf(cat, r.payload)) {
      if (emptyShellSkipped.length < 50) emptyShellSkipped.push(`${cat}/${itemName}`)
      skippedEmpty++
      continue
    }

    if (it) {
      /* ① 先认「同一个版本槽位」：辅助指纹（名称 + 版本名 + 日期）或版本名完全相同。
         备份包里被剥掉正文的精简 json 与库里的完整版，正文指纹必然不同，只有槽位能认出来；
         顺序必须在正文指纹之前，否则指纹撞车会把「另一个版本」当成「这一版」直接吞掉。 */
      const slot = (it.versions || []).find((v) => sameVersionSlot(v, baseName, day, aux))
      if (slot) {
        if (fillVersionPayload(slot, r, cat, sig, key, aux)) filled++
        merged++
        it.updatedAt = day
        continue
      }
      // ② 再看正文指纹 / 签名：内容完全一样（同一个文件）就是这一版，只补全不新增
      const hit = (it.versions || []).find((v) => versionMatches(v, sig, key))
      if (hit) {
        /* 版本名一样（或行里没有版本名）才算「同一个版本」；
           版本名不同说明备份包里本就是两行（两张卡正文相同、只有 mes_example 之类的差异），
           合并会把真实版本吞掉、版本数变少，所以放行让它建自己的版本行。 */
        const hitName = String(hit.name || '').trim()
        const sameName = !baseName || hitName === baseName || (!!aux && hit.aux === aux)
        if (sameName) {
          if (fillVersionPayload(hit, r, cat, sig, key, aux)) filled++
          duplicates.push(itemName)
          continue
        }
      }
    }
    // 名称对不上但内容完全一样（同一个文件改了名）也算「该版本已存在」
    if (sig || key) {
      const same = target.find((x) => x !== it && (x.versions || []).some((v) => versionMatches(v, sig, key)))
      if (same) {
        const hit = (same.versions || []).find((v) => versionMatches(v, sig, key))
        if (hit && fillVersionPayload(hit, r, cat, sig, key, aux)) filled++
        duplicates.push(itemName)
        continue
      }
    }

    let versionName = baseName
    if (it && (it.versions || []).length) {
      const used = new Set((it.versions || []).map((v) => String(v.name || '')))
      if (used.has(versionName)) {
        let n = 2
        while (used.has(`${baseName} 第${n}版`)) n++
        versionName = `${baseName} 第${n}版`
      }
    }

    // 这一版用的图：按内容落进图片仓库（同样一张图多个版本共用一份）
    const imgId = r.imgId !== undefined ? r.imgId : await imageIdOfRow(r)

    const wasNew = !it
    if (!it) {
      it = {
        id: nextId(cat[0]),
        /* 类别直接写进字段（可枚举、随存档落盘）：详情页的预览、导出分支都靠它，
           以前不写这里，新建条目要重启一次才会被认成「美化 / 预设」 */
        category: cat,
        name: itemName,
        // 预设专属字段：归组 key（同一预设不同版本共用）+ 自动识别到的模型名
        ...(cat === 'presets' ? { presetKey, model: presetModel } : {}),
        /* 书架名字下方显示的就是这条备注：优先用卡片自带的 creator_notes（导入界面可改），
           卡片没写就留空 —— 不再拿开场白顶替，也不塞「（由导入生成）」占位 */
        desc: String(r.remark || '').trim(),
        tags: [],
        hue: HUE_BY_CAT[cat] ?? 30,
        // cover 只留给极老的引用；新数据统一用 imgId
        cover: '',
        imgId: imgId || '',
        dc: { url: r.dcUrl || '', title: r.dcTitle || '', hasUpdate: false },
        stVersion: versionName,
        date: day,
        updatedAt: day,
        createdAt: new Date().toISOString(),
        srcPath: r.srcPath || '',
        stCards: [],
        versions: []
      }
      target.push(it)
      created++
    } else {
      merged++
      /* 条目本身还没有备注时，用这次导入的卡片备注补上；已有备注一律不动 */
      if (!String(it.desc || '').trim() && String(r.remark || '').trim()) it.desc = String(r.remark).trim()
    }

    // 老库里的预设没有 presetKey / model：这里顺手补齐，不重建数据
    if (cat === 'presets') {
      if (presetKey && !it.presetKey) it.presetKey = presetKey
      if (presetModel && !it.model) it.model = presetModel
    }

    /* 导入自动打标（新建和已有条目都补）：
       ① 卡片 / 预设文件自带的标签词条 ② 预设识别到的模型名（Gemini、Claude…）
       大小写不同的同名字标签统一成库里既有的写法。
       已有条目只在这条还没被手动整理过标签时才补，用户删掉的标签不会被下次导入塞回来 */
    const autoTags = catOf(it) === 'presets' ? autoTagsOfRow(r) : []
    const canAutoTag = wasNew || !(Array.isArray(it.tags) && it.tags.length)
    if (autoTags.length && canAutoTag) {
      const idx = tagIdx()
      const cur = Array.isArray(it.tags) ? it.tags.slice() : []
      const seen = new Set(cur.map((t) => tagKeyOf(t)))
      for (const t of autoTags) {
        const v = canonicalTag(t, idx)
        const k = tagKeyOf(v)
        if (!k || seen.has(k)) continue
        seen.add(k)
        cur.push(v)
        if (!idx.has(k)) idx.set(k, { text: v, n: 1 })
      }
      it.tags = cur
    }

    const ver = {
      id: nextId('v'),
      name: versionName,
      date: day,
      current: !it.versions.some((v) => v.current),
      note: r.source === 'zip' ? '来自备份包' : r.source === 'st' ? '来自酒馆' : r.source === 'scan' ? '自动扫描导入' : '本地导入',
      // 保留原始 JSON，供备份还原与批量导入酒馆使用
      /* markRaw 只对「普通对象」有效：导入行来自响应式数组，取到的 payload 本身就是 Proxy，
         直接存下来会让后续 IPC（更新/替换到酒馆）抛 An object could not be cloned。
         所以先 toPlain 去代理再 markRaw。 */
      raw: r.payload && typeof r.payload === 'object' ? markRaw(toPlain(r.payload)) : r.payload ?? undefined,
      srcFile: r.fileName || '',
      srcPath: r.srcPath || '',
      /* 卡片自己写的版本号（character_version，如 2.0），只作记录，不改版本名 */
      cardVersion: String(r.cardVersion || '').trim(),
      sig,
      key,
      /* 辅助指纹（名称 + 版本名 + 日期）：下次导入同一版本时即使正文残缺也能认出「已存在」 */
      aux,
      imgId: imgId || ''
    }
    if (r.buffer) setVersionBuffer(ver.id, r.buffer)
    it.versions.unshift(ver)
    if (!it.date) it.date = day
    it.updatedAt = day
    if (!it.stVersion) it.stVersion = versionName
    /* 当前版本兜底：旧逻辑里「谁先出现谁当 current」会让空壳版抢占当前版本
       （详情页读 current 的开场白 → 一片空白）。这里若当前版本是空壳、
       而刚导入的这版有正文，就把当前版本切到有正文的这版。 */
    const curVer = (it.versions || []).find((v) => v.current)
    if (curVer && curVer !== ver && hasBodyOf(cat, ver.raw) && !hasBodyOf(cat, curVer.raw)) {
      try {
        curVer.current = false
        ver.current = true
        it.stVersion = versionName
        it.imgId = ver.imgId || it.imgId || ''
      } catch (_) {}
    }
    // 当前版本换了图，条目图片跟着换（书架 / 详情页都读这里）
    if (ver.current) it.imgId = ver.imgId || it.imgId || ''
    if (r.srcPath && !it.srcPath) it.srcPath = r.srcPath
  }

  } finally {
    if (bulk) resumeItemsSave()
  }
  onProgress?.({ done: okRows.length, total: okRows.length })
  /* 落库前把标签写法统一一次（Gemini / gemini 只留一种，取用得多的写法） */
  try {
    normalizeAllTags()
  } catch (_) {}
  /* 兜底：整库按所在列表重新校正一次 category（含本批新建与老数据），
     保证导入结束当场所有条目都带类别，不用等下次启动 */
  try {
    tagCategories(store.items)
  } catch (_) {}
  return {
    created,
    merged,
    dup: duplicates.length,
    dupNames: duplicates,
    filled,
    skippedEmpty,
    skippedEmptyNames: emptyShellSkipped,
    total: okRows.length
  }
}

/* ---------------- 后台任务进度条 ---------------- */

/* 抓取 / 导入这类任务可能几十毫秒就跑完，直接隐藏等于用户没看见，
 * 所以结束时要留一小段「完成」态，让进度条能被看到。 */
let bgHideTimer = null

export function startBgJob(label, total = 0) {
  if (bgHideTimer) {
    clearTimeout(bgHideTimer)
    bgHideTimer = null
  }
  store.bgJob = { active: true, label, done: 0, total, hint: '', doneAll: false }
}

export function patchBgJob(patch = {}) {
  const cur = store.bgJob || {}
  store.bgJob = { ...cur, ...patch, active: true, doneAll: false }
}

export function endBgJob(hint = '') {
  const cur = store.bgJob || {}
  const total = Number(cur.total || 0)
  const done = Number(cur.done || 0)
  if (bgHideTimer) {
    clearTimeout(bgHideTimer)
    bgHideTimer = null
  }
  if (total > 0 && done >= total) {
    /* 全部走完：先显示完成态，900ms 后再收起 */
    store.bgJob = { ...cur, active: true, doneAll: true, done: total, total, hint: hint || '' }
    bgHideTimer = setTimeout(() => {
      store.bgJob = { active: false, label: '', done: 0, total: 0, hint: '', doneAll: false }
      bgHideTimer = null
    }, 900)
    return
  }
  store.bgJob = { active: false, label: '', done: 0, total: 0, hint: hint || '', doneAll: false }
}

/* ---------------- 条目 / 版本的图片 ---------------- */

/** 某条目某版本对应的图片哈希（不传版本就取当前版本） */
export function coverHashOf(item, version) {
  if (!item) return ''
  const v = version || bestVersionOf(item) || null
  return (v && v.imgId) || item.imgId || ''
}

/** 某条目某版本该显示的图片地址（没有就返回空串，界面显示首字占位） */
export function coverUrlOf(item, version) {
  if (!item) return ''
  const h = coverHashOf(item, version)
  if (h) return urlOf(h) || ''
  return item.cover || ''
}

/** 列表用封面地址：走缩略图的稳定 URL（thumb://local/<hash>.webp），不再返回大段 dataURL */
export function coverThumbOf(item, version) {
  if (!item) return ''
  const h = coverHashOf(item, version)
  if (h) return thumbUrl(h)
  return item.cover || ''
}

/**
 * 提前把图片从磁盘读进内存缓存，避免切版本时闪烁。
 * 默认只预读「每个条目当前版本」那一张：版本图按需读（切到哪一版再读哪一张）。
 * 避免条目一多就把所有历史版本的图全读一遍。
 */
export function primeCovers(list, opt = {}) {
  const all = !!opt.allVersions
  const hashes = []
  for (const it of list || []) {
    if (!it) continue
    if (all) {
      for (const v of it.versions || []) if (v.imgId) hashes.push(v.imgId)
    } else {
      const v = bestVersionOf(it) || (it.versions || [])[0]
      if (v && v.imgId) hashes.push(v.imgId)
    }
    if (it.imgId) hashes.push(it.imgId)
  }
  ensureImages(hashes)
}

/** 老数据迁移：把条目级 cover（dataURL）搬进图片仓库，记成内容哈希 */
export async function ensureCoverImages(opt = {}) {
  /* 分批迁移：一次只搬 max 张，避免启动时一口气解码几十 MB base64 把首屏卡住 */
  const max = Math.max(1, Number(opt.max || 2) || 2)
  let done = 0
  let changed = false
  for (const key of ['characters', 'worldbooks', 'presets', 'themes', 'others']) {
    for (const it of store.items[key] || []) {
      if (!it) continue
      if (done >= max) break
      if (it.cover && isDataUrl(it.cover)) {
        done++
        const h = await saveImageDataUrl(it.cover)
        if (h) {
          if (!it.imgId) it.imgId = h
          const cur = bestVersionOf(it) || (it.versions || [])[0]
          if (cur && !cur.imgId) cur.imgId = h
          it.cover = ''
          changed = true
        }
      }
      for (const v of it.versions || []) {
        if (v.cover && isDataUrl(v.cover)) {
          done++
          const h = await saveImageDataUrl(v.cover)
          if (h) {
            v.imgId = v.imgId || h
            delete v.cover
            changed = true
          }
        }
      }
      // 老数据只有一个条目级图片，历史上所有版本共用这一张：补成各版本共享同一引用（同内容只存一份）
      if (it.imgId) {
        for (const v of it.versions || []) {
          if (!v.imgId) {
            v.imgId = it.imgId
            changed = true
          }
        }
      }
      if (it.imgId) ensureImage(it.imgId)
    }
  }
  if (changed) saveItems()
  return changed
}

/* ================================================================== */
/*  以下为第二轮新增能力：酒馆联动 / 扫描 / 导出 / 版本比对              */
/* ================================================================== */

const api = () => window.api || null

/* ---------------- 内容签名（与主进程 png.cjs 完全同一算法） ---------------- */

function cardDataOf(json) {
  if (!json || typeof json !== 'object') return {}
  if (/chara_card/i.test(json.spec || '') && json.data && typeof json.data === 'object') return json.data
  return json
}

export function sigHash(str) {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193 ^ 0x5bd1e995
  const s = String(str || '')
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 ^= c
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = (h2 + c * (i + 1)) >>> 0
    h2 = (Math.imul(h2, 0x85ebca6b) ^ (h2 >>> 13)) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

export function cardSig(json) {
  const d = cardDataOf(json)
  const parts = [
    d.name || '',
    d.description || '',
    d.personality || '',
    d.scenario || '',
    d.first_mes || '',
    d.mes_example || '',
    d.system_prompt || '',
    d.post_history_instructions || ''
  ]
  return sigHash(parts.join('\u0001'))
}

/* ---------------- 酒馆连接状态监控 ---------------- */

/**
 * API 地址自动识别：酒馆目录下 config.yaml 里的 port → http://127.0.0.1:端口
 * 读到就写回设置（不用用户手填）；读不到返回 ok:false，界面回退到已保存的手动值。
 */
export async function refreshTavernUrlFromConfig(opt = {}) {
  const a = api()
  const info = store.stStatus.config || (store.stStatus.config = { ok: false, port: 0, url: '', path: '', error: '' })
  if (!a?.stConfigInfo) {
    info.ok = false
    info.error = 'NO_BRIDGE'
    return info
  }
  const r = await a.stConfigInfo({ tavernPath: store.settings.tavernPath || '' })
  info.ok = !!(r && r.ok)
  info.port = (r && r.port) || 0
  info.url = (r && r.url) || ''
  info.path = (r && r.path) || ''
  info.error = (r && r.error) || ''
  info.fromFile = !!(r && r.fromFile)
  if (info.ok && info.url && store.settings.tavernUrl !== info.url) {
    store.settings.tavernUrl = info.url
    saveSettings()
    if (!opt.silent) showToast(`已按 config.yaml 识别 API 地址：${info.url}`)
  }
  return info
}

/**
 * 首启与设置页统一入口：写入酒馆安装路径 → 读 config.yaml 得出 API 地址 → 探活一次
 * 返回识别结果，界面据此显示 API 地址与连接状态（读不到 config 时沿用已保存的地址）。
 */
export async function applyTavernPath(p) {
  const v = String(p || '').trim()
  store.settings.tavernPath = v
  saveSettings()
  if (!v) {
    store.stStatus.connected = false
    return { ok: false, url: '', fromFile: false, connected: false }
  }
  let info = null
  try {
    info = await refreshTavernUrlFromConfig({ silent: true })
  } catch (_) {}
  let connected = false
  try {
    connected = await checkStConnection(true)
  } catch (_) {}
  return {
    ok: true,
    url: (info && info.url) || store.settings.tavernUrl || '',
    fromFile: !!(info && info.fromFile),
    connected
  }
}

/* 启动后自动检查一次软件更新（仓库地址写死在 lib/update.js，无需用户配置）。
   检查失败静默返回；查到新版本交给右下角弹窗提示，
   点过「忽略本次」的同一个版本不再弹（换新版本照常提示）。 */
export async function checkAppUpdateOnStart(opt = {}) {
  const a = api()
  if (!a?.info) return null
  let current = '0.0.0'
  try {
    const info = await a.info()
    current = (info && info.version) || current
  } catch (_) {}
  /* 一天只打一次 GitHub 接口：当天已经查过就直接复用结果，有更新照样弹窗，不额外发请求 */
  const today = new Date().toISOString().slice(0, 10)
  if (!opt.force && String(store.settings.updateLastCheckDay || '') === today && store.appUpdate.latest) {
    const v = String(store.appUpdate.latest || '').trim()
    store.appUpdate = {
      ...store.appUpdate,
      current,
      ignored: !!v && String(store.settings.ignoredUpdateVersion || '').trim() === v
    }
    return { ...store.appUpdate, ok: true, configured: true, cached: true }
  }
  let r = null
  try {
    r = await checkForUpdate({
      owner: DEFAULT_UPDATE_SOURCE.owner,
      repo: DEFAULT_UPDATE_SOURCE.repo,
      current,
      fetchJson: a?.fetchJson
    })
  } catch (e) {
    return null
  }
  const latest = (r && r.latest) || ''
  const ignored = !!latest && String(store.settings.ignoredUpdateVersion || '').trim() === latest
  if (r && r.ok) {
    store.settings.updateLastCheckDay = today
    saveSettings()
  }
  store.appUpdate = {
    lastAt: nowStr(),
    hasUpdate: !!(r && r.hasUpdate),
    latest,
    current,
    notes: (r && r.notes) || '',
    url: (r && r.url) || '',
    downloadUrl: (r && r.downloadUrl) || '',
    downloadName: (r && r.downloadName) || '',
    downloadDigest: (r && r.downloadDigest) || '',
    downloadSize: Number((r && r.downloadSize) || 0),
    ignored,
    /* 链路 / 校验 / 错误分型：设置面板据此显示「走的哪条通道」「校验级别」「为什么失败」 */
    channel: (r && r.channel) || '',
    channelLabel: (r && r.channelLabel) || '',
    verify: (r && r.verify) || '',
    verifyLabel: (r && r.verifyLabel) || '',
    manifest: !!(r && r.manifest),
    manifestNote: (r && r.manifestNote) || '',
    kind: (r && r.kind) || '',
    error: (r && r.ok === false && r.error) || '',
    hint: (r && r.hint) || ''
  }
  /* 有更新时不再额外 toast —— 右下角弹窗已经说清楚了，不重复提示 */
  if (r && r.hasUpdate && opt.toast) showToast(`发现新版本 ${r.latest}`)
  return r
}

/* ---------- 应用内更新：右下角弹窗与设置面板共用同一份状态 ---------- */

/** 点「忽略本次」：只记住这一个版本号，出了新版本照常提示 */
export function ignoreAppUpdate() {
  const v = String(store.appUpdate.latest || '').trim()
  if (!v) return ''
  store.settings.ignoredUpdateVersion = v
  saveSettings()
  store.appUpdate.ignored = true
  showToast(`已忽略 v${v}，有新版本会再提示`)
  return v
}

/* 进度事件全局只挂一次：重复挂会让百分比乱跳 */
let updProgressBound = false
export function bindUpdProgress() {
  if (updProgressBound) return
  const a = api()
  if (!a?.onUpProgress) return
  updProgressBound = true
  a.onUpProgress((p) => {
    if (store.upd.phase !== 'downloading') return
    if (p && p.percent != null) store.upd.percent = Number(p.percent) || 0
    if (p && p.received != null) store.upd.received = Number(p.received) || 0
    if (p && p.total) store.upd.total = Number(p.total) || 0
    if (p && p.error) store.upd.error = String(p.error)
  })
}

/** 下载安装包：下完停在 ready，等用户点「重启并安装」 */
export async function startAppUpdate() {
  const a = api()
  if (!a?.upDownload) return showToast('请在桌面版里使用')
  if (store.upd.phase === 'downloading' || store.upd.phase === 'installing') return null
  const url = String(store.appUpdate.downloadUrl || store.appUpdate.url || '').trim()
  if (!url) return showToast('这条 Release 里没有可下载的安装包')
  bindUpdProgress()
  store.upd.mode = 'update'
  store.upd.phase = 'downloading'
  store.upd.percent = 0
  store.upd.received = 0
  store.upd.total = Number(store.appUpdate.downloadSize || 0)
  store.upd.error = ''
  store.upd.pkg = ''
  store.upd.toVersion = String(store.appUpdate.latest || '')
  try {
    const r = await a.upDownload({
      url,
      name: store.appUpdate.downloadName || '',
      /* 清单拿不到 sha256 时 digest 为空，改用大小做降级校验 */
      sha256: store.appUpdate.downloadDigest || '',
      size: Number(store.appUpdate.downloadSize || 0)
    })
    if (!r?.ok) {
      store.upd.phase = 'idle'
      store.upd.error = (r && r.error) || '下载失败'
      showToast('下载失败：' + store.upd.error)
      return null
    }
    store.upd.pkg = r.path || ''
    store.upd.sha256 = r.sha256 || ''
    if (r.size) store.upd.total = Number(r.size)
    store.upd.received = store.upd.total
    store.upd.percent = 100
    store.upd.phase = 'ready'
    return r
  } catch (e) {
    store.upd.phase = 'idle'
    store.upd.error = String((e && e.message) || e)
    showToast('下载失败：' + store.upd.error)
    return null
  }
}

/** 重启并安装：调用后当前进程会退出，安装完自动拉起新版本 */
export async function installAppUpdate() {
  const a = api()
  if (!a?.upInstall) return showToast('请在桌面版里使用')
  if (!store.upd.pkg) return showToast('安装包还没下载好')
  if (store.upd.phase === 'installing') return null
  store.upd.phase = 'installing'
  store.upd.error = ''
  try {
    const r = await a.upInstall({
      path: store.upd.pkg,
      toVersion: String(store.upd.toVersion || store.appUpdate.latest || '')
    })
    if (!r?.ok) {
      store.upd.phase = 'ready'
      store.upd.error = (r && r.error) || '安装失败'
      showToast('安装失败：' + store.upd.error)
      return null
    }
    return r
  } catch (e) {
    store.upd.phase = 'ready'
    store.upd.error = String((e && e.message) || e)
    return null
  }
}

export function resetAppUpdate() {
  store.upd.phase = 'idle'
  store.upd.mode = ''
  store.upd.percent = 0
  store.upd.received = 0
  store.upd.error = ''
  store.upd.pkg = ''
  store.upd.sha256 = ''
  store.upd.toVersion = ''
}

/* ---------- 更新看门狗回退：新版装完起不来，退回上一版 ---------- */
/** 启动时问主进程：上次更新是不是没成功（新版连续两次没熬过启动期就会判定可疑） */
export async function checkRollbackOnStart() {
  const a = api()
  const idle = { suspect: false, from: '', to: '', attempts: 0, target: '', busy: false, hint: '' }
  if (!a?.upState) {
    store.rollback = idle
    return idle
  }
  try {
    const r = await a.upState()
    const s = (r && r.ok && r.state) || null
    if (s && s.suspect && s.pending && s.pending.from) {
      store.rollback = {
        suspect: true,
        from: String(s.pending.from || ''),
        to: String(s.pending.to || ''),
        attempts: Number(s.attempts || 0),
        target: '',
        busy: false,
        hint: ''
      }
      return store.rollback
    }
  } catch (_) {}
  store.rollback = idle
  return idle
}

/** 执行回退：去 Release 列表里找到上一版安装包 → 下载 → 静默安装（复用同一条安装链路） */
export async function rollbackAppUpdate() {
  const a = api()
  if (!a?.upDownload || !a?.upInstall) return showToast('请在桌面版里使用')
  if (store.rollback.busy) return null
  const from = String(store.rollback.from || '').trim()
  if (!from) return showToast('不知道要退回哪个版本')
  store.rollback.busy = true
  store.rollback.hint = '正在查找上一版安装包…'
  try {
    const r = await listReleases({
      owner: DEFAULT_UPDATE_SOURCE.owner,
      repo: DEFAULT_UPDATE_SOURCE.repo,
      fetchJson: a.fetchJson
    })
    if (!r?.ok) {
      store.rollback.hint = r?.error || '拉取历史版本失败'
      showToast(store.rollback.hint)
      return null
    }
    const hit = (r.items || []).find((x) => String(x.latest) === from)
    if (!hit) {
      store.rollback.hint = '更新源里已经没有 ' + from + ' 这个版本的安装包了'
      showToast(store.rollback.hint)
      return null
    }
    store.rollback.target = hit.latest
    store.rollback.hint = '正在下载 ' + hit.latest + '…'
    bindUpdProgress()
    store.upd.mode = 'rollback'
    store.upd.phase = 'downloading'
    store.upd.percent = 0
    store.upd.received = 0
    store.upd.total = Number(hit.downloadSize || 0)
    store.upd.error = ''
    store.upd.pkg = ''
    store.upd.toVersion = hit.latest
    const d = await a.upDownload({
      url: hit.downloadUrl,
      name: hit.downloadName || '',
      sha256: hit.downloadDigest || ''
    })
    if (!d?.ok) {
      store.upd.phase = 'idle'
      store.rollback.hint = d?.error || '下载失败'
      showToast('回退下载失败：' + store.rollback.hint)
      return null
    }
    store.upd.pkg = d.path || ''
    store.upd.sha256 = d.sha256 || ''
    store.upd.phase = 'ready'
    store.upd.percent = 100
    store.rollback.hint = '下载完成，正在重启安装 ' + hit.latest + '…'
    const inst = await a.upInstall({ path: store.upd.pkg, toVersion: hit.latest })
    if (!inst?.ok) {
      store.upd.phase = 'ready'
      store.rollback.hint = inst?.error || '安装失败'
      showToast('回退安装失败：' + store.rollback.hint)
      return null
    }
    return inst
  } catch (e) {
    store.rollback.hint = String((e && e.message) || e)
    return null
  } finally {
    store.rollback.busy = false
  }
}

/** 不退了 / 已经自己处理好了：清掉看门狗状态，别每次启动都提示 */
export async function dismissRollback() {
  const a = api()
  try {
    if (a?.upClearSuspect) await a.upClearSuspect()
  } catch (_) {}
  store.rollback = { suspect: false, from: '', to: '', attempts: 0, target: '', busy: false, hint: '' }
}

/* ---------- 酒馆扩展版本校验：更新完第一次打开，不匹配就提示重新注入 ---------- */
const EXT_IDLE = { visible: false, installed: true, builtin: '', tavern: '', path: '', busy: false, state: '' }

/** 只读比对：问主进程要一次 extStatus，算出「要不要提示」；不写设置、不碰酒馆文件 */
async function probeStExt() {
  const a = api()
  const tp = String(store.settings.tavernPath || '').trim()
  if (!tp || !a?.stExtStatus) return { ok: false, reason: 'no-path' }
  let r = null
  try {
    r = await a.stExtStatus({ tavernPath: store.settings.tavernPath, user: store.settings.stUser })
  } catch (_) {
    return { ok: false, reason: 'error' }
  }
  if (!r || !r.ok) return { ok: false, reason: 'status' }
  /* 后端发现设置里的用户名在酒馆里并不存在（例如 zztest），已回退到真实用户目录。
     这里把纠正结果写回设置，后续注入 / 扫描都走同一个用户目录，避免两边各认一个。 */
  if (r.user && r.userCorrected && String(store.settings.stUser || '') !== String(r.user)) {
    store.settings.stUser = r.user
    saveSettings()
  }
  const builtin = String(r.latest || '')
  const tavern = String(r.version || '')
  const state = judgeExtVersion({ installed: !!r.installed, builtin, tavern })
  return { ok: true, installed: !!r.installed, builtin, tavern, state, path: r.path || '' }
}

/** 检查酒馆里的扩展版本与软件内置版本是否一致，不一致时点亮 extRemind */
export async function checkStExtVersion(opt = {}) {
  const p = await probeStExt()
  if (!p.ok) return { ...EXT_IDLE }
  const mismatch = p.state === 'missing' || p.state === 'upgrade' || p.state === 'newer'
  store.extRemind = {
    visible: !!mismatch,
    installed: p.installed,
    builtin: p.builtin,
    tavern: p.tavern,
    path: p.path,
    busy: false,
    state: p.state
  }
  if (mismatch && opt.toast) {
    if (p.state === 'upgrade') showToast('软件内置的扩展 v' + p.builtin + ' 比酒馆里的 v' + p.tavern + ' 新，可重新注入升级')
    else if (p.state === 'newer') showToast('酒馆里的扩展 v' + p.tavern + ' 比软件内置的 v' + p.builtin + ' 新，无需注入')
    else showToast('酒馆扩展还没装进酒馆')
  }
  return store.extRemind
}

/** 启动自动比对酒馆扩展版本（每次启动只跑一次）
 * 定位：独立于 GitHub 自身版本检查与 DC 更新检查的后台比对，晚几秒静默跑；
 * 只调用一次 extStatus 做读操作，不写盘、不自动注入、不弹窗打断：
 *   - 没配酒馆路径 / 扩展没装 / 读取或网络异常 → 静默返回，不留任何提示
 *   - 内置版本比酒馆里的新 → 点亮既有提示卡（角标同一入口，卡片里可直接重新注入）
 *   - 已是最新、或酒馆里的比内置新（软件被回退过）→ 静默，免得误导用户降级
 * 守卫用模块级标记，热重载或重复调用都不会发第二次请求。 */
let stExtAutoStarted = false
export async function autoCheckStExtOnStart() {
  if (stExtAutoStarted) return null
  stExtAutoStarted = true
  const p = await probeStExt()
  if (!p.ok || !p.installed) return null
  store.extRemind = {
    visible: p.state === 'upgrade',
    installed: true,
    builtin: p.builtin,
    tavern: p.tavern,
    path: p.path,
    busy: false,
    state: p.state === 'upgrade' ? 'upgrade' : ''
  }
  return store.extRemind
}

/** 弹窗里点「重新注入」：交给主进程按版本比对（旧版升级 / 同版本不重写）再复查版本 */
export async function reInjectStExt() {
  const a = api()
  if (!a?.stExtInject) return showToast('请在桌面版里使用')
  if (store.extRemind.busy) return null
  store.extRemind.busy = true
  try {
    const r = await a.stExtInject({ tavernPath: store.settings.tavernPath, user: store.settings.stUser })
    if (!r?.ok) {
      showToast(r?.error || '注入失败')
      return null
    }
    await checkStExtVersion()
    const ver = r.version || ''
    if (r.skipped) showToast(r.message || '酒馆里已是 v' + ver + '，未重写')
    else showToast((r.message || '已写入扩展 v' + ver) + '，刷新酒馆页面生效')
    return r
  } finally {
    store.extRemind.busy = false
  }
}

export function dismissExtRemind() {
  store.extRemind.visible = false
}


/** 手动指定时也允许：保留只读展示 + 手动兜底 */
export function setTavernUrl(url) {
  const v = String(url == null ? '' : url).trim()
  store.settings.tavernUrl = v
  saveSettings()
  return v
}

export async function checkStConnection(silent = true) {
  const st = store.stStatus
  if (st.checking) return st.connected
  st.checking = true
  const url = store.settings.tavernUrl || 'http://127.0.0.1:8000'
  st.host = url
  let ok = false
  try {
    if (api()?.stPing) {
      const r = await api().stPing({ url })
      ok = !!r.ok
      st.ms = r.ms || 0
    } else {
      const r = await fetch(url.replace(/\/+$/, '') + '/csrf-token', { cache: 'no-store' })
      ok = r.ok
    }
  } catch (_) {
    ok = false
  }
  st.connected = ok
  st.checkedAt = nowStr()
  st.checking = false
  if (!silent && !ok) showToast('没连上酒馆，请确认酒馆已经启动')
  return ok
}

/**
 * 酒馆端扩展在线状态：直接读通知桥的 status 通道（主进程已把 /health 的 ext 透传上来）
 * ext.online = 最近 8 秒内扩展有 /pending 心跳；agoMs = 心跳距今毫秒（无心跳为 null）
 * 注意：这只判断「扩展在不在」，不改变 st.connected 的真实酒馆探活结论。
 */
export async function refreshStExt() {
  const st = store.stStatus
  const a = api()
  if (!a?.bridgeStatus) {
    st.extOnline = false
    st.extAgoMs = null
    st.extCheckedAt = nowStr()
    return st.extOnline
  }
  try {
    const r = await a.bridgeStatus()
    st.bridgeRunning = !!(r && r.running)
    st.bridgePort = (r && r.port) || 0
    const ext = (r && r.ext) || null
    /* 桥自己都没起来时，任何历史心跳都不算数 */
    st.extOnline = !!(st.bridgeRunning && ext && ext.online)
    st.extAgoMs = ext && typeof ext.agoMs === 'number' ? ext.agoMs : null
    /* 酒馆上报的「当前在用」：fresh=false 表示没收到或已过期（酒馆关了 / 卡切走） */
    const s = (r && r.state) || null
    st.inUseFresh = !!(st.bridgeRunning && s && s.fresh)
    st.inUseName = st.inUseFresh ? s.name || '' : ''
    st.inUseVersion = st.inUseFresh ? s.version || '' : ''
    st.inUseExtVersion = st.inUseFresh ? s.extVersion || '' : ''
    st.inUseAgoMs = s && typeof s.agoMs === 'number' ? s.agoMs : null
  } catch (_) {
    st.extOnline = false
    st.extAgoMs = null
    st.inUseFresh = false
    st.inUseName = ''
    st.inUseVersion = ''
    st.inUseExtVersion = ''
    st.inUseAgoMs = null
  }
  st.extCheckedAt = nowStr()
  return st.extOnline
}

/**
 * 酒馆状态轮询：状态栏的「已连接 / 未连接」跟着酒馆启停变，
 * 左下角绿点跟的是「酒馆端扩展是否在线」，两者同一个定时器里一起读，不另开定时器。
 * 规则：窗口可见时每 3 秒读一次桥状态（含扩展心跳）；详情页开着时每 4 次（约 12 秒）
 * 顺带刷新一次版本对比。窗口隐藏（最小化/切走）时暂停，不做无意义的后台请求。
 */
let stWatchTimer = null
let stWatchTick = 0
export function startStWatch(intervalMs = 3000) {
  stopStWatch()
  stWatchTimer = setInterval(async () => {
    if (typeof document !== 'undefined' && document.hidden) return
    try {
      await checkStConnection(true)
    } catch (_) {}
    try {
      await refreshStExt()
    } catch (_) {}
    if (!store.stStatus.connected || !store.currentId) return
    stWatchTick += 1
    if (stWatchTick % 4) return
    const it = currentItem.value
    if (!it) return
    try {
      await refreshTavernCompare(it, { silent: true })
    } catch (_) {}
  }, intervalMs)
  return stWatchTimer
}

export function stopStWatch() {
  if (stWatchTimer) clearInterval(stWatchTimer)
  stWatchTimer = null
}

/** 窗口重新获得焦点 / 从后台切回来时立刻补一次（不用等下一个轮询周期） */
export async function pokeStStatus() {
  try {
    await checkStConnection(true)
  } catch (_) {}
  try {
    await refreshStExt()
  } catch (_) {}
  if (!store.stStatus.connected || !store.currentId) return
  const it = currentItem.value
  if (!it) return
  try {
    await refreshTavernCompare(it, { silent: true })
  } catch (_) {}
}

/* ---------------- 文件 / 日期 小工具 ---------------- */

function isoDay(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 文件日期：创建时间与修改时间里更早的那个 */
export function pickDate(stat) {
  if (!stat) return ''
  const c = stat.ctime || stat.mtime
  const m = stat.mtime || stat.ctime
  if (!c && !m) return ''
  return isoDay(Math.min(c || m, m || c))
}

export function scanFileKey(f) {
  return `${String(f.path || '').toLowerCase()}|${f.size || 0}|${Math.round(f.mtime || 0)}`
}

async function bytesOfPath(p) {
  if (!api()?.readBuffer) return null
  const r = await api().readBuffer(p)
  return r && r.ok ? r.data : null
}

function fileFromBytes(bytes, name) {
  try {
    return new File([bytes], name || 'file.bin')
  } catch (_) {
    return null
  }
}

/** 把任意本地路径变成可直接导入的一行（含分类 / payload / 签名） */
export async function makeImportRowFromPath(p, source = 'scan') {
  const s = api()?.stat ? await api().stat(p) : null
  const st = Array.isArray(s) ? s[0] : s
  const name = String(p || '').split(/[\\/]/).pop() || 'file.bin'
  const bytes = await bytesOfPath(p)
  if (!bytes) return { fileName: name, error: '读取文件失败', source, path: p, srcPath: p }
  const file = fileFromBytes(bytes, name)
  if (!file) return { fileName: name, error: '无法解析该文件', source, path: p, srcPath: p }
  let row = null
  try {
    const mod = await import('./lib/importer.js')
    const res = await mod.analyzeFiles([file])
    row = res && res[0]
    if (row && !row.version) row.version = mod.defaultVersionName(row.category || 'others', row.payload, name)
    /* 预设：文件名里带的版本号在这里就拆开预填，导入界面直接显示最终落库的结果
       （"万事成真V1.24_4" → 名称「万事成真」+ 版本名「V1.24_4」），
       不再出现名称一整串、版本名却是导入日期的情况。 */
    if (row && row.category === 'presets') {
      const pv = parsePresetName(String(row.name || name || ''))
      if (pv && pv.name) row.name = pv.name
      if (pv && pv.version) row.version = pv.version
    }
  } catch (e) {
    row = { fileName: name, error: '解析失败：' + String((e && e.message) || e) }
  }
  if (!row) row = { fileName: name, error: '无法识别该文件' }
  row.file = file
  row.buffer = bytes
  row.size = row.size || (bytes.byteLength || bytes.length || 0)
  row.path = p
  row.srcPath = p
  row.source = source
  // 日期 / 版本名同一套逻辑：卡片自带的「创建 / 修改」时间取更早那天优先。
  // 读不到才用文件系统里最早的时间（即导入日期）
  if (!row.date) {
    let payloadDay = ''
    try {
      const mod = await import('./lib/importer.js')
      payloadDay = mod.dateFromPayload ? mod.dateFromPayload(row.category, row.payload) : ''
    } catch (_) {}
    row.date = payloadDay || pickDate(st) || ''
  }
  if (!row.version) row.version = row.date || ''
  if (row.payload) row.sig = sigOfPayload(row.category, row.payload)
  /* 名称是自动解析出来的（不是用户手打的）：抓到 Discord 帖子标题时允许覆盖，
     用户一旦在导入界面手动改过名称，这个标记会变成 false，之后不再覆盖。
     注意：解析阶段已经按「名字来自卡片内容还是文件名」判过一次，
     卡片自带的角色名会带着 nameAuto=false 进来，这里不能无条件改回 true，
     否则帖子标题会把角色名顶掉（图片直链 + 帖子链接同时导入时就是这个现象）。 */
  if (typeof row.nameAuto !== 'boolean') row.nameAuto = true
  if (!row.nameSource) row.nameSource = row.nameAuto ? 'file' : 'card'
  return row
}

/**
 * 一个链接是否是直链文件（DC 临时附件 / CDN / 普通图链）
 * 注意：帖子链接（discord.com/channels/...）永远不是文件直链，必须优先排除
 */
export function isFileLink(url) {
  const u = String(url || '').trim()
  if (!/^https?:\/\//i.test(u)) return false
  // 帖子 / 频道链接：一律视为帖子（要抓标题），绝不能当下载直链
  if (/(?:discord\.com|discordapp\.com)\/channels\//i.test(u)) return false
  if (/ephemeral-attachments|\/attachments\//i.test(u)) return true
  if (/(?:media|cdn)\.discordapp\.(?:net|com)/i.test(u)) return true
  try {
    const p = new URL(u).pathname
    return /\.(png|jpe?g|webp|json|zip|charx|byaf)$/i.test(p)
  } catch (_) {
    return false
  }
}

/** 是否是 Discord 帖子链接（用来抓标题、做更新检查） */
export function isPostLink(url) {
  const u = String(url || '').trim()
  return /^https?:\/\/(?:www\.)?(?:discord\.com|discordapp\.com)\/channels\//i.test(u)
}

/**
 * 通过链接导入：链接指向文件时下载后解析成导入行
 * @param {string[]} urls 一行一个链接
 * @returns {Promise<{rows: object[], failed: object[]}>}
 */
export async function rowsFromUrls(urls) {
  // 进网络层之前统一清洗：从网页 / 聊天窗口复制来的链接常混入 U+FFFD、零宽字符、
  // 全角冒号等，直接传给 Electron net 会抛 ByteString 转换异常，这里先剔除再校验
  const list = (urls || []).map((u) => cleanUrl(u)).filter(Boolean)
  const rows = []
  const failed = []
  for (const url of list) {
    const ck = checkUrl(url)
    if (!ck.ok) {
      failed.push({ url, reason: ck.error })
      continue
    }
    const safeUrl = ck.url
    if (!isFileLink(safeUrl)) {
      failed.push({ url: safeUrl, reason: isPostLink(safeUrl) ? '这是帖子链接，只用来抓标题、给文件补来源，不会下载' : '不是文件直链' })
      continue
    }
    if (!api()?.download) {
      failed.push({ url: safeUrl, reason: '请在桌面版里使用' })
      continue
    }
    const dl = await api().download({ url: safeUrl })
    if (!dl || !dl.ok) {
      failed.push({ url: safeUrl, reason: (dl && dl.error) || '下载失败：直链可能已过期' })
      continue
    }
    const row = await makeImportRowFromPath(dl.path, 'dc')
    // 下载直链只记在 dlUrl（会过期，不当作帖子的来源链接）；帖子的 dcUrl 留给帖子链接
    row.dlUrl = safeUrl
    if (!row.cover && row.payload && row.category === 'characters') {
      row.cover = row.payload?.avatar || row.payload?.data?.avatar || ''
    }
    if (row.error) failed.push({ url: safeUrl, reason: row.error })
    else rows.push(row)
  }
  return { rows, failed }
}

/** 批量把酒馆里的角色卡 / 预设 / 世界书转成导入行 */
export async function listTavernByType(type = 'characters', extra = {}) {
  const a = api()
  if (!a) return { ok: false, error: '请在桌面版里使用', list: [] }
  const opt = { tavernPath: store.settings.tavernPath, user: store.settings.stUser, ...extra }
  if (type === 'presets') {
    if (!a.stScanPresets) return { ok: false, error: '版本过旧', list: [] }
    return await a.stScanPresets(opt)
  }
  if (type === 'worldbooks') {
    if (!a.stScanWorldsUnbound) return { ok: false, error: '版本过旧', list: [] }
    return await a.stScanWorldsUnbound(opt)
  }
  if (type === 'themes') {
    if (!a.stScanThemes) return { ok: false, error: '版本过旧', list: [] }
    return await a.stScanThemes(opt)
  }
  if (!a.stScanCharacters) return { ok: false, error: '版本过旧', list: [] }
  return await a.stScanCharacters(opt)
}

/* ---------------- 单个版本的内容（二进制 + JSON） ---------------- */

/* base64 → Uint8Array（图片仓库 img:read 回的是 base64） */
function b64ToBytes(b64) {
  try {
    const s = atob(String(b64 || ''))
    const out = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
    return out
  } catch (_) {
    return null
  }
}

function isPngBytes(b) {
  return !!b && b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
}

export async function loadVersionContent(version, item) {
  if (!version) return { buffer: null, json: null }
  /* 老库升级：raw 在侧车文件里，这里按需读回（不读整库，只读这一版） */
  let json = version.raw || null
  if (!json && version.rawFile) json = (await ensureVersionRaw(item || null, version)) || null
  let buffer = null
  /* 图片优先取资料库自己的副本（images/<imgId>.bin）：
     以前只认 srcPath —— 本地导入的版本根本没有 srcPath，从酒馆导入的版本 srcPath 又指向酒馆里那张旧文件，
     于是「更新到酒馆」永远只换文字、图片纹丝不动。 */
  const imgId = String(version.imgId || (item && item.imgId) || '')
  if (imgId && api()?.imgRead) {
    try {
      const r = await api().imgRead(imgId)
      if (r && r.ok && r.data) {
        const bytes = b64ToBytes(r.data)
        if (isPngBytes(bytes)) buffer = bytes
      }
    } catch (_) {
      /* 副本读不出来就往下走老路，别把更新流程卡死 */
    }
  }
  if (!buffer && version.srcPath && api()?.readBuffer) {
    buffer = await bytesOfPath(version.srcPath)
    if (!json && api()?.readCard) {
      const r = await api().readCard(version.srcPath)
      if (r && r.ok) json = r.json
    }
  }
  if (!buffer) {
    const cached = getVersionBuffer(version)
    if (cached && typeof cached !== 'string') buffer = cached
    else if (cached && typeof cached === 'string') buffer = await bytesOfPath(cached)
  }
  if (buffer && !(buffer instanceof Uint8Array) && buffer.length) buffer = new Uint8Array(buffer)
  return { buffer, json }
}

/** 分类对应的内容指纹（目前只有角色卡做比对） */
export function sigOfPayload(category, payload) {
  if (!payload) return ''
  if (category === 'characters') return cardSig(payload)
  return ''
}

/* ---------------- 与酒馆的对比 ---------------- */

/**
 * 拿资料库里的条目，对比酒馆里的同名角色卡
 * 结果写入 item.stCards：[{avatar,name,sig,world,same,matchVersionId,matchVersionName}]
 */
/**
 * 给条目的每个版本补内容指纹 digest（角色卡 / 世界书 / 预设 各用自己的算法，
 * 与主进程 electron/lib/digest.cjs 逐字节一致）。
 * raw 已落侧车时按需读回，不会把整库重新读一遍。
 */
export async function ensureItemDigests(item) {
  if (!item) return
  const cat = resolveCat(item)
  const a = apiOf()
  /* 「其他」分类不写死成某一类：以前这里用 othersKind(item) 一锤定音，而 othersKind 只看
     v.raw —— 原文落侧车（rawFile）时 raw 是 undefined，于是所有「其他」条目都被当成世界书
     算指纹，预设/美化永远算不出同一个值，对比自然一直「不一致」。
     现在「其他」把三类指纹都算出来存进 v.digests，比中任意一个都算一致。 */
  const kinds = cat === 'others' ? ['worldbooks', 'presets', 'themes'] : [cat]
  for (const v of item.versions || []) {
    if (!v) continue
    if (v.digest && (cat !== 'others' || Array.isArray(v.digests) && v.digests.length)) continue
    let got = false
    /* 侧车原文可能几十 MB：交给主进程读盘算 digest，渲染进程不读、不解析大 JSON */
    if (!v.raw && v.rawFile && a && a.dataDigest) {
      const ds = []
      for (const k of kinds) {
        try {
          const rr = await a.dataDigest({ sub: 'raw', name: v.rawFile, category: k })
          if (rr && rr.ok && rr.digest) ds.push(rr.digest)
        } catch (_) {}
      }
      if (ds.length) {
        const uniq = Array.from(new Set(ds))
        v.digest = uniq[0]
        if (uniq.length > 1) v.digests = uniq
        got = true
      }
    }
    if (got) continue
    const raw = v.raw || (await ensureVersionRaw(item, v))
    if (!raw) continue
    const ds = []
    for (const k of kinds) {
      try {
        const d = digestOf(k, raw)
        if (d) ds.push(d)
      } catch (_) {}
    }
    if (!ds.length) continue
    const uniq = Array.from(new Set(ds))
    v.digest = uniq[0]
    if (uniq.length > 1) v.digests = uniq
  }
}

/** 某个版本可用来比对的全部指纹（「其他」会有多个候选算法） */
function versionDigests(v) {
  if (!v) return []
  const out = []
  if (v.digest) out.push(String(v.digest))
  if (Array.isArray(v.digests)) for (const d of v.digests) if (d) out.push(String(d))
  return out
}

/** 按内容指纹找版本：命中就说明酒馆里那份与本版本内容一致 */
function findVersionByDigest(vers, digest) {
  if (!digest) return null
  const d = String(digest)
  for (const v of vers || []) if (v && versionDigests(v).includes(d)) return v
  return null
}

/** 条目全部版本的指纹集合（按内容召回酒馆同名项用） */
function itemDigestSet(item) {
  const s = new Set()
  for (const v of (item && item.versions) || []) for (const d of versionDigests(v)) s.add(d)
  return s
}

export async function refreshTavernCompare(item, opts = {}) {
  if (!item) return { ok: false, error: 'NoItem' }
  await ensureItemDigests(item)
  const a = api()
  if (!a || (!a.stScanCharacters && !a.stScanWorlds && !a.stScanPresets && !a.stScanThemes)) {
    item.stCards = []
    return { ok: false, error: 'NO_BRIDGE' }
  }
  const r = await scanTavernForCompare([catOf(item)], item, opts)
  return applyTavernCompare(item, r)
}

/** 角色卡名字归一化：(1)/(2) 副本尾缀、2.0 / 2 这类版本尾缀、「名字 + 短后缀」都收敛到同一基名 */
function normCardName(x) {
  return String(x || '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/[\s_-]*\d+(\.\d+)*$/, '')
    .trim()
    .toLowerCase()
}

/**
 * 角色卡候选召回（只召回，不定案）：已登记绑定 ∪ 卡内名精确 ∪ 归一化命中 ∪ 文件名包含。
 * 以前只认「完全相等 / 归一化相等」，且一命中就丢掉其余候选，导致
 * ① 卡内真名与文件名不同的卡召不回来（dk方亦楷.png 里 name=方亦楷）；
 * ② 同内容多卡被合并成一张。
 * 现在全部候选都进列表，由 applyTavernCompare 按「内容指纹 → 卡内名 → 绑定」定案。
 * @returns {Array<object>} 每项带 recall: string[]（bound / name / norm / file）
 */
function recallCharacters(list, item) {
  const name = String((item && item.name) || '').trim()
  if (!name) return []
  const bound = new Set()
  for (const al of item.stAliases || []) for (const av of al.avatars || []) bound.add(String(av))
  if (item.stAvatar) bound.add(String(item.stAvatar))
  for (const c of item.stCards || []) if (c && c.avatar) bound.add(String(c.avatar))
  const nameNorm = normCardName(name)
  const key = name.toLowerCase()
  const out = []
  for (const c of list) {
    const nm = String(c.name || '')
    const av = String(c.avatar || '')
    const detail = c.hasCard !== null && c.hasCard !== undefined
    /* 酒馆侧卡名是 {{char}} 之类占位符时不算真名，别拿它去精确匹配 */
    const realName = detail ? cleanCardName(nm, '') : ''
    const recall = []
    if (bound.has(av) || (detail && bound.has(nm))) recall.push('bound')
    /* 卡内名精确只看详扫结果：轻扫的 name 就是文件名，拿它当卡名会把「文件名命中」伪装成「卡名命中」 */
    if (realName && realName === name) recall.push('name')
    if (!recall.includes('name') && (normCardName(realName) === nameNorm || normCardName(av) === nameNorm)) recall.push('norm')
    if (av === name || av.toLowerCase().includes(key) || (realName && realName.toLowerCase().includes(key))) recall.push('file')
    if (!recall.length) continue
    out.push({ ...c, recall })
  }
  const rank = (c) => {
    if (c.recall.includes('bound')) return 0
    if (c.recall.includes('name')) return 1
    if (c.recall.includes('norm')) return 2
    return 3
  }
  out.sort((a, b) => rank(a) - rank(b) || String(a.avatar).localeCompare(String(b.avatar)))
  return out
}

/** 世界书 / 预设 / 美化 的名字归一化：(1) 副本尾缀、文件后缀、空格、大小写都不参与比较 */
function normSameName(x) {
  return String(x || '')
    .replace(/\.(json|png)$/i, '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase()
}

/**
 * 世界书 / 预设 / 美化的同名召回：条目名精确 → 归一化相等 → 文件名相等 → 已登记的目标路径
 * → **内容指纹一致** → 去掉版本尾缀后互相包含。
 * 以前只认「条目名 === 酒馆项名」，可酒馆里的名字来自 JSON 内的 name 或文件名、还常带 ·V1.4.0、
 * 「(1)」这类副本尾缀，一旦不一致就召不回来，界面上看着就是「对比没反应」。
 * 内容指纹这一路是兜底：名字再怎么写歪，只要内容一致就照样能比出来。
 */
function recallSameNamed(list, item) {
  const name = String(item.name || '')
  const key = normSameName(name)
  /* 去掉 v2.1 / 2.1.0 / 第2版 / [V2] 这类版本尾缀后的基名，用来做「弱召回」 */
  const base = key
    .replace(/[\[\(【（]?[vV]?\s*\d+(\.\d+)*[\]\)】）]?$/, '')
    .replace(/第[0-9一二三四五六七八九十]+版$/, '')
    .trim()
  const digests = itemDigestSet(item)
  const paths = new Set()
  const addPath = (p) => {
    const s = String(p || '').trim()
    if (!s) return
    paths.add(s.toLowerCase())
    const b = s.split(/[\\/]/).pop()
    if (b) paths.add(b.toLowerCase())
  }
  addPath(item.stTargetPath)
  for (const c of item.stCards || []) {
    addPath(c && c.path)
    addPath(c && c.file)
  }
  const weak = (k) => {
    if (!base || base.length < 4 || !k) return false
    const kb = k
      .replace(/[\[\(【（]?[vV]?\s*\d+(\.\d+)*[\]\)】）]?$/, '')
      .replace(/第[0-9一二三四五六七八九十]+版$/, '')
      .trim()
    if (!kb || kb.length < 4) return false
    return kb.includes(base) || base.includes(kb)
  }
  const out = []
  for (const c of list) {
    const nm = String(c.name || '')
    const file = String(c.file || '')
    const p = String(c.path || '')
    const recall = []
    if (nm === name) recall.push('name')
    if (!recall.length && key && (normSameName(nm) === key || (file && normSameName(file) === key))) recall.push('name')
    if (!recall.length && ((file && paths.has(file.toLowerCase())) || (p && paths.has(p.toLowerCase())))) recall.push('path')
    if (!recall.length && c.digest && digests.has(String(c.digest))) recall.push('content')
    if (!recall.length && (weak(normSameName(nm)) || (file && weak(normSameName(file))))) recall.push('weak')
    if (!recall.length) continue
    out.push({ ...c, recall })
  }
  /* 强依据在前，内容一致其次，弱名字包含放最后 */
  const rank = (c) => (c.recall.includes('name') ? 0 : c.recall.includes('path') ? 1 : c.recall.includes('content') ? 2 : 3)
  out.sort((a, b) => rank(a) - rank(b) || String(a.name || a.file).localeCompare(String(b.name || b.file)))
  return out
}

/** 一个条目在酒馆里的同名项（角色卡按名字/头像/内容召回，世界书与预设与美化按名字/文件名召回） */
function tavernSameName(list, item, kind) {
  if (kind === 'characters') return recallCharacters(list, item)
  return recallSameNamed(list, item)
}

/** 「其他」按内容判断它在酒馆里更像世界书还是预设 */
function othersKind(item) {
  const v = bestVersionOf(item) || (item.versions || [])[0]
  const raw = v && v.raw
  if (!raw || typeof raw !== 'object') return 'worldbooks'
  if (Array.isArray(raw.prompts) || Array.isArray(raw.prompt_order)) return 'presets'
  return 'worldbooks'
}

async function scanTavernForCompare(cats, item, opts = {}) {
  const a = api()
  const opt = { tavernPath: store.settings.tavernPath, user: store.settings.stUser }
  const out = { characters: [], worldbooks: [], presets: [], themes: [], errors: [] }
  const need = new Set(cats || [])
  if (need.has('others')) {
    out.othersWorlds = []
    out.othersPresets = []
  }
  if (need.has('characters') && a?.stScanCharacters) {
    /* 全量解析 170 张卡的 PNG + JSON 要 1 秒左右，主进程被占住，界面上就是「点进详情卡一下」。
       没要求全量时先轻扫拿名单（只 stat 不解析内容），再对召回出来的候选做详扫。
       铁律：进入配对的一律是详扫结果 —— 轻扫项没有卡内真名与内容指纹，
       拿它配对只能按文件名猜，正是「名字显示不一致 / 漏配错配」的根子。 */
    const detailed = (list) => (list || []).filter((c) => c && c.hasCard !== null && c.hasCard !== undefined)
    if (item && !opts.full) {
      const lite = await a.stScanCharacters({ ...opt, light: true })
      if (!lite?.ok) {
        out.errors.push(lite?.error || '找不到酒馆角色卡目录')
      } else {
        const cands = recallCharacters(lite.list || [], item)
        let list = []
        if (cands.length) {
          const r = await a.stScanCharacters({ ...opt, only: cands.map((c) => c.avatar) })
          if (r?.ok) list = detailed(r.list)
          else out.errors.push(r?.error || '找不到酒馆角色卡目录')
        }
        /* 候选一个都没召回时全量详扫兜底：卡内真名与文件名都对不上（小方.png 里 name=方亦楷）
           的情况只能靠详扫发现，不能因为轻扫没命中就断定酒馆里没有 */
        if (!list.length) {
          const full = await a.stScanCharacters(opt)
          if (full?.ok) list = detailed(full.list)
          else if (full?.error) out.errors.push(full.error)
        }
        out.characters = list
      }
    } else {
      const r = await a.stScanCharacters(opt)
      if (r?.ok) out.characters = detailed(r.list)
      else out.errors.push(r?.error || '找不到酒馆角色卡目录')
    }
  }
  if ((need.has('worldbooks') || need.has('others')) && a?.stScanWorlds) {
    const r = await a.stScanWorlds(opt)
    if (r?.ok) out.worldbooks = r.list || []
  }
  if ((need.has('presets') || need.has('others')) && a?.stScanPresets) {
    const r = await a.stScanPresets({ ...opt, includeSamplerPresets: true })
    if (r?.ok) out.presets = r.list || []
  }
  /* 美化以前完全没进对比链路：预设/美化的详情页永远看不到「酒馆里有没有同名项」，
     所以「对比功能不生效」。这里按分类把 themes/*.json 也扫进来。
     「其他」里也可能躺着美化，所以 others 一起带上。 */
  if ((need.has('themes') || need.has('others')) && a?.stScanThemes) {
    const r = await a.stScanThemes(opt)
    if (r?.ok) out.themes = r.list || []
    else if (r?.error) out.errors.push(r.error)
  }
  /* 世界书 / 预设 / 美化的扫描结果只有名字、大小、时间，没有内容指纹；
     而「与某个版本一致」全靠指纹比对，不在这里补算就永远只能判「不一致」 */
  await attachTavernDigests(a, out)
  return out
}

/**
 * 给扫描结果补算酒馆侧内容指纹（只读命中的那几个文件，不做全库解析）。
 * 失败一律静默跳过：没有指纹时退化为按名字比对，不影响其余分类。
 */
async function attachTavernDigests(a, scan) {
  if (!a?.stProbeDigests) return
  const jobs = [
    ['worldbooks', scan.worldbooks],
    ['presets', scan.presets],
    ['themes', scan.themes]
  ]
  for (const [kind, list] of jobs) {
    if (!Array.isArray(list) || !list.length) continue
    try {
      const r = await a.stProbeDigests({
        kind,
        files: list.map((x) => ({ path: x.path, name: x.name, engine: x.engine }))
      })
      if (!r?.ok || !Array.isArray(r.list)) continue
      const byPath = new Map()
      for (const x of r.list) {
        const k = String((x && x.path) || '').toLowerCase()
        if (k) byPath.set(k, x)
      }
      for (const it of list) {
        const hit = byPath.get(String(it.path || '').toLowerCase())
        if (hit && hit.digest) it.digest = hit.digest
      }
    } catch (_) {}
  }
}

function applyTavernCompare(item, scan) {
  const cat = resolveCat(item)
  const vers = item.versions || []
  /* 「其他」不再靠 othersKind 猜一类：原文常在侧车里、raw 拿不到时它永远猜成世界书，
     于是挂在「其他」里的预设/美化一个都召不回来。现在把三类候选合起来一起比。 */
  const type = cat
  const tag = (arr, k) => (arr || []).map((x) => ({ ...x, _kind: x._kind || k }))
  const list =
    type === 'presets'
      ? tag(scan.presets, 'presets')
      : type === 'themes'
        ? tag(scan.themes, 'themes')
        : type === 'worldbooks'
          ? tag(scan.worldbooks, 'worldbooks')
          : type === 'others'
            ? [
                ...tag(scan.worldbooks, 'worldbooks'),
                ...tag(scan.presets, 'presets'),
                ...tag(scan.themes, 'themes')
              ]
            : scan.characters || []
  const mine = tavernSameName(list, item, type)
  /* 覆盖 stCards 之前先记下真正的「已登记绑定」：条目当前绑定的那张 + 合并时记下的别名。
     不能把上一轮的候选列表整批当绑定，否则「上次只是召回过」会被误当成「已经确认绑过」。 */
  const prevAvatar = String(item.stAvatar || '')
  const boundSet = new Set()
  if (prevAvatar) boundSet.add(prevAvatar)
  for (const al of item.stAliases || []) for (const av of al.avatars || []) boundSet.add(String(av))

  item.stCards = mine.map((c) => {
    if (type === 'characters') {
      /* 定案顺序：内容指纹 → 卡内名精确 → 已登记绑定 → 未匹配。
         以前是「谁先命中谁算」，同一张卡同时满足多条时来源标不出来；
         归一化（剥尾缀）只用来召回，绝不能单独定案，否则 方亦楷 / 方亦楷的邻居 会被并成一张。 */
      const detail = c.hasCard !== null && c.hasCard !== undefined
      const hit =
        findVersionByDigest(vers, c.digest) ||
        vers.find((x) => x.sig && c.sig && x.sig === c.sig) ||
        null
      const iname = detail ? cleanCardName(c.name, '') : ''
      const nameExact = !!iname && iname === String(item.name || '')
      let by = 'none'
      if (hit) by = 'content'
      else if (nameExact) by = 'name'
      else if (boundSet.has(String(c.avatar || ''))) by = 'bound'
      return {
        avatar: c.avatar,
        name: iname || c.avatar,
        file: c.file || `${c.avatar}.png`,
        sig: c.sig,
        digest: c.digest || '',
        world: c.world || '',
        worlds: Array.isArray(c.worlds) ? c.worlds : [],
        /* same 只表示「内容与某个版本一致」，来源另看 by */
        same: !!hit,
        by,
        recall: Array.isArray(c.recall) ? c.recall : [],
        matchVersionId: hit ? hit.id : '',
        matchVersionName: hit ? hit.name : ''
      }
    }
    /* 世界书 / 预设 / 美化：「其他」里也是这几类。以前拿 item.stVersion（酒馆记住的版本名）
       之外还试过用「版本名 === 酒馆世界书名」，两边根本不是同一套命名，所以永远标不出来。
       现在统一按内容指纹比对（「其他」会把三类算法都算一遍），酒馆侧 c.digest 由主进程读文件算出；
       确实没有指纹可比时（例如酒馆那侧不是合法 JSON）才退回按版本名配对。 */
    const hit = findVersionByDigest(vers, c.digest) || vers.find((x) => x.name && x.name === item.stVersion) || null
    return {
      avatar: c.path || c.name,
      name: c.name || c.file || '',
      file: c.file || '',
      sig: '',
      digest: c.digest || '',
      kind: c._kind || type,
      engine: c.engine || '',
      path: c.path || '',
      same: !!hit,
      by: !hit ? 'none' : hit.digest || hit.digests ? 'content' : 'name',
      recall: Array.isArray(c.recall) ? c.recall : [],
      matchVersionId: hit ? hit.id : '',
      matchVersionName: hit ? hit.name : ''
    }
  })
  if (type === 'characters') {
    /* 自动回填只认有依据的那一种：仍绑着上一轮那张卡就继续绑；否则只在「唯一」的强命中
       （内容一致 / 卡名精确）上回填。多张并列或毫无依据时留空由用户重新绑定 ——
       以前这里无脑取 mine[0].avatar，把 V2.0 的条目绑到了 方亦楷 (1).png 上。 */
    const cards = item.stCards
    if (!prevAvatar || !cards.some((c) => c.avatar === prevAvatar)) {
      const strong = cards.filter((c) => c.by === 'content' || c.by === 'name')
      item.stAvatar = strong.length === 1 ? strong[0].avatar : ''
    }
  }
  if (type !== 'characters' && mine.length && !item.stTargetPath) item.stTargetPath = mine[0].path || ''
  item.stCardsTotal = item.stCards.length
  /* 张数 ≠ 角色数：名字相同但内容不同的多份副本，角色名只有一个 */
  item.stNameCount = new Set(item.stCards.map((c) => String(c.name || c.avatar || ''))).size
  item.stCheckedAt = nowStr()
  /* 扫描失败原因留在条目上：界面上要能说清「为什么一个都没比出来」（例如酒馆主题目录不存在），
     否则用户只会看到「还没有这个美化」，误以为对比功能又坏了 */
  item.stError = scan.errors && scan.errors.length ? String(scan.errors[0] || '') : ''
  if (!mine.length) return { ok: true, list: [], error: item.stError }
  return { ok: true, list: item.stCards }
}

/**
 * 把条目绑定到酒馆里某一张卡（只写资料库自身数据，绝不改动酒馆文件）。
 * 用于「绑定与内容不符」时由用户手动改绑。
 */
export function bindTavernCard(item, avatar) {
  if (!item) return false
  const av = String(avatar || '')
  item.stAvatar = av
  const hit = (item.stCards || []).find((c) => c && c.avatar === av)
  item.stTargetPath = hit && hit.path ? hit.path : item.stTargetPath || ''
  try { saveItems() } catch (_) {}
  return true
}

/** 一批条目一起对比（导入后 / 打开详情时用）：同一类只扫一次 */
export async function refreshTavernCompareBatch(list) {
  const targets = (list || []).filter(Boolean)
  if (!targets.length) return { ok: false, total: 0 }
  for (const item of targets) await ensureItemDigests(item)
  const cats = Array.from(new Set(targets.map((x) => catOf(x)).filter(Boolean)))
  const scan = await scanTavernForCompare(cats)
  for (const item of targets) applyTavernCompare(item, scan)
  return { ok: true, total: targets.length }
}

/* ---------------- 酒馆里的当前版本（按内容比对得出，不做使用状态监控） ---------------- */

/**
 * 条目在酒馆里的当前版本：拿酒馆里同名的卡 / 世界书 / 预设的实际内容，
 * 与资料库各版本做内容指纹比对，命中哪个版本就认为酒馆加载的是哪一版。
 * 只读一次对比结果（item.stCards 里已经由 refreshTavernCompare 算好），
 * 不轮询、不定时扫描，详情页打开时才刷新。
 * @returns {{known:boolean, versionId:string, versionName:string, avatar:string, count:number}}
 */
export function tavernCurrentVersion(item) {
  const empty = { known: false, versionId: '', versionName: '', avatar: '', count: 0 }
  if (!item) return empty
  const cards = Array.isArray(item.stCards) ? item.stCards : []
  if (!cards.length) return empty
  const hit = cards.find((c) => c && c.matchVersionId)
  if (!hit) return { ...empty, count: cards.length }
  return {
    known: true,
    versionId: String(hit.matchVersionId),
    versionName: String(hit.matchVersionName || ''),
    avatar: String(hit.avatar || ''),
    count: cards.length
  }
}

/** 该版本是否就是酒馆里当前加载的那一版（历史版本列表打标用） */
export function isTavernVersion(item, version) {
  if (!item || !version) return false
  const cur = tavernCurrentVersion(item)
  if (!cur.known) return false
  if (version.id && version.id === cur.versionId) return true
  /* 世界书 / 预设没有内容指纹时按版本名兜底匹配 */
  return !!cur.versionName && String(version.name || '') === cur.versionName
}

/* ---------------- 推到酒馆：新建 / 替换更新 ---------------- */

/** 占位符卡名（{{char}} 之类）不是真名，展示与匹配都不能用它 */
const CARD_PLACEHOLDER = /^\{\{\s*(char|user|persona|original|user_name)\s*\}\}$/i

/** 卡内真名清洗：空/占位符 → 回退给 fallback（一般是文件名 stem） */
function cleanCardName(name, fallback) {
  const n = String(name || '').trim()
  if (!n || CARD_PLACEHOLDER.test(n)) return String(fallback || '').trim()
  return n
}

/**
 * 条目在酒馆里的文件名（avatar）：显式传入 > 记录值 > 已写入路径的文件名 > 同名卡扫描结果 */
function stAvatarOf(item, opt = {}) {
  if (opt.stAvatar) return String(opt.stAvatar)
  if (item.stAvatar) return String(item.stAvatar)
  const p = String(item.stTargetPath || '')
  if (p) {
    const base = p.split(/[\\/]/).pop().replace(/\.(png|json)$/i, '')
    if (base) return base
  }
  const cards = item.stCards || []
  /* 只有「内容一致」或「卡内真名一致」才算有依据的默认目标。
     以前这里还有 cards[0] 兜底：酒馆里有多份同名副本时，取第一张等于随机写一张。 */
  const hit =
    cards.find((c) => c && c.same && c.by === 'content') ||
    cards.find((c) => c && c.name && c.name === item.name) ||
    null
  return hit ? String(hit.avatar || '') : ''
}

/** 取角色卡 JSON 的卡内真名；空 / 占位符时回退到给的备用名 */
function cardDisplayName(json, fallback) {
  const d = json && json.data ? json.data : json || {}
  return cleanCardName(d && d.name, fallback) || '未命名'
}

/** 角色卡 JSON 里绑定的世界书名（extensions.world 优先，其次内嵌书的名字） */
function cardWantWorld(json) {
  const d = json && json.data ? json.data : json || {}
  const w = String((d && d.extensions && d.extensions.world) || '')
  if (w) return w
  return String((d && d.character_book && d.character_book.name) || '')
}

/**
 * 按需取库内同名世界书的内容，交给主进程补写酒馆 worlds。
 * 只为消除「卡内 extensions.world 指向不存在的文件」这种悬空引用；
 * 主进程只在目标文件缺失时写，绝不覆盖酒馆已有世界书。
 */
async function worldSourceFor(name) {
  const key = String(name || '').trim()
  if (!key) return undefined
  let books = []
  try { books = (store.items && store.items.worldbooks) || [] } catch (_) { books = [] }
  const hit = books.find((b) => b && String(b.name || '').trim() === key)
  if (!hit) return undefined
  const vs = hit.versions || []
  const v = vs.find((x) => x && x.current) || vs[0]
  if (!v) return undefined
  try { await ensureVersionRaw(hit, v) } catch (_) {}
  const raw = v.raw
  if (!raw || typeof raw !== 'object') return undefined
  return { name: key, data: toPlain(raw) }
}

/** 体积人性化：聊天记录动辄几百 KB，直接给字节数看不出量级 */
function humanSize(n) {
  const b = Number(n) || 0
  if (b < 1024) return `${b} B`
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1048576).toFixed(1)} MB`
}

/** 命中的依据（与界面上的一致性标记同源）：按内容 / 按卡名 / 已绑定 / 未匹配 */
export function stByText(c) {
  if (!c) return ''
  if (c.by === 'content') return '按内容'
  if (c.by === 'name') return '按卡名'
  if (c.by === 'bound') return '已绑定'
  return '未匹配'
}

/**
 * 替换前确认「写哪一张」：酒馆允许同名角色并存（靠文件名区分），
 * 只按名字挑一张会写错文件（曾把 方亦楷.png 写成了另一版内容）。
 * 只有一张 → 直接用；多张 → 弹菜单让用户点明目标；一张都没有 → 交给主进程按名字定位。
 */
export async function withTavernTarget(item, unit, onPick) {
  /* 每次点击都先重扫一次酒馆：条目上的 stCards 可能是几天前扫的，
     那会儿酒馆里只有一张卡，于是"没弹窗、直接替换"就这么来的 */
  try {
    await refreshTavernCompare(item)
  } catch (_) {}
  const cards = (item && item.stCards) || []
  if (!cards.length) return onPick(null)
  /* 名字与文件名不是一回事（卡内真名 vs 酒馆里的 xxx.png），提示里两个都给 */
  const label = (c) => `${c.name || c.avatar}（${c.file || c.avatar + '.png'}）`
  /* 只有一张同名卡 → 不打扰，直接写这张，只留一条提示说明写到哪了 */
  if (cards.length === 1) {
    showToast(`酒馆里只有一张「${label(cards[0])}」，直接更新它`)
    return onPick(cards[0])
  }
  const evt = {
    clientX: Math.round(window.innerWidth / 2 - 130),
    clientY: 180,
    preventDefault() {},
    stopPropagation() {}
  }
  /* 靠「绑了几个聊天记录、各多大」区分副本：只凭文件名和大小根本分不出哪个在用 */
  const build = (stats) =>
    cards.map((c) => {
      const cs = (stats && stats[c.avatar]) || { count: 0, total: 0, files: [] }
      const lines = [`文件：${c.file || c.avatar + '.png'}`]
      lines.push(cs.count ? `聊天记录 ${cs.count} 个 · 合计 ${humanSize(cs.total)}` : '聊天记录 0 个')
      for (const f of (cs.files || []).slice(0, 3)) lines.push(`· ${f.name}  ${humanSize(f.size)}`)
      if (cs.count > 3) lines.push(`· …另有 ${cs.count - 3} 个聊天记录`)
      return {
        label: `写入「${c.name || c.avatar}」`,
        desc: lines.join('\n'),
        hint: stByText(c),
        action: () => onPick(c)
      }
    })
  const a = api()
  if (a && a.stChatStats) {
    a.stChatStats({
      tavernPath: store.settings.tavernPath,
      user: store.settings.stUser,
      avatars: cards.map((c) => c.avatar)
    })
      .then((r) => openMenu(evt, build(r && r.ok ? r.stats : null)))
      .catch(() => openMenu(evt, build(null)))
  } else {
    openMenu(evt, build(null))
  }
  showToast(`酒馆里有 ${cards.length} 张同名${unit || '条目'}，请选择要写入的那一张`)
}

/**
 * 推到酒馆：新建 / 替换更新
 * 新建（mode:'new'）= 直接新建一份：不判同族、不问覆盖，同族/同名时主进程自动另起独立基名。
 * @param {object} item
 * @param {{mode?:'new'|'replace', version?:object, stAvatar?:string,
 *          replaceWorld?:boolean, backupOldWorld?:boolean, silent?:boolean}} opt
 */
export async function pushItemToTavern(item, opt = {}) {
  if (!item) return { ok: false, error: '没有条目' }
  const a = api()
  if (!a || (!a.stImportCard && !a.stImportWorld && !a.stImportPreset)) {
    return { ok: false, error: '请在桌面版里操作' }
  }

  if (!store.stStatus.connected) await checkStConnection()

  /* 批量流程（opt.silent）不逐条弹提示、也不弹任何询问菜单：
     进度与结果由批量面板统一呈现，N 条 toast 会把界面刷成一片 */
  const silent = opt.silent === true
  const toast = silent ? () => {} : showToast

  const mode = opt.mode === 'replace' ? 'replace' : 'new'
  const versions = item.versions || []
  /* 必须写入「调用方选中的那一版」：
     旧逻辑 opt.version || current || [0]：右键旧版本导入/替换时若调用方没透传 version，
     就会静默回退到最新版 —— 界面提示成功、酒馆里却是最新版，就是这个坑。
     现在没指定就直接报错；只有 opt.allowLatest（批量补建）才允许回退。 */
  let version = opt.version || null
  if (!version && opt.versionId) version = versions.find((v) => v.id === opt.versionId) || null
  if (version && typeof version === 'string') version = versions.find((v) => v.id === version) || null
  if (!version) {
    if (!versions.length) return { ok: false, error: '这个条目还没有任何版本' }
    if (!opt.allowLatest) {
      return { ok: false, error: '没有指定要写入的版本，已阻止静默回退到最新版' }
    }
    version = versions.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0]
  }
  /* 老库升级：raw 在侧车文件，按需读回本次要写的那一版 */
  await ensureVersionRaw(item, version)
  const cat = resolveCat(item) === 'others' ? othersKind(item) : resolveCat(item)

  /* 大内容直通：世界书 / 预设 / 其他的原始内容是几十 MB 的 JSON 时，旧流程先把整本读进
   * 渲染进程、再当 IPC 参数搬给主进程，同一份内容三处各存一份，渲染进程内存峰值翻几倍，
   * 点「更新到酒馆」直接黑屏 / 闪退。这里只在内存里没有原文时把侧车文件名交给主进程，
   * 由主进程读盘、解析、写盘，渲染进程只拿结果。 */
  if (cat !== 'characters' && version && !version.raw && version.rawFile && a.stImportFromSidecar) {
    const wantReplace = opt.mode === 'replace'
    const rr = await a.stImportFromSidecar({
      sub: 'raw',
      /* 主进程拿 name 拼侧车文件名，这里必须是侧车文件名；
         下面这行原来还有一句 name: item.name，重复键会把文件名覆盖成条目名 → NOT_FOUND */
      name: version.rawFile,
      itemName: item.name,
      category: cat,
      tavernPath: store.settings.tavernPath,
      user: store.settings.stUser,
      engine: opt.engine || (item.stCards || [])[0]?.engine || '',
      targetPath: wantReplace ? opt.targetPath || item.stTargetPath || '' : '',
      replace: wantReplace,
      overwrite: wantReplace,
      replaceWorld: opt.replaceWorld === true,
      backupOldWorld: false,
      /* 主进程世界书写入读的是 backupOld，少了这个键，走侧车大文件直通时就不会有旧书备份 */
      backupOld: false
    })
    return finishPushFromSidecar(item, rr, cat, opt)
  }

  if (cat === 'worldbooks') {
    const content = version?.raw
    if (!content) return { ok: false, error: '这个版本没有世界书内容' }
    const r = await a.stImportWorld({
      tavernPath: store.settings.tavernPath,
      user: store.settings.stUser,
      name: item.name,
      data: toPlain(content),
      targetPath: mode === 'replace' ? item.stTargetPath || '' : '',
      replace: mode === 'replace',
      overwrite: mode === 'replace',
      backupOld: false
    })
    if (r?.ok) {
      item.stTargetPath = r.path || item.stTargetPath || ''
      refreshTavernCompareSoon(item)
      toast(
        mode === 'replace'
          ? `已更新世界书：${r.name || item.name}`
          : `已在酒馆新建世界书：${r.name || item.name}`
      )
    } else {
      toast('写入酒馆失败：' + ((r && r.error) || '未知错误'))
    }
    return r || { ok: false, error: '未知错误' }
  }

  if (cat === 'presets') {
    if (!a.stImportPreset) return { ok: false, error: '版本过旧，重启一下软件' }
    /* content 以前只在上面的世界书分支里定义过，预设分支引用的其实是未定义变量 ——
       预设「导入到酒馆 / 替换」必抛 ReferenceError。这里补上。 */
    const content = version?.raw
    if (!content) return { ok: false, error: '这个版本没有预设内容' }
    const r = await a.stImportPreset({
      tavernPath: store.settings.tavernPath,
      user: store.settings.stUser,
      name: presetImportName(item, version),
      version: String(version?.version || item.stVersion || '').trim(),
      data: toPlain(content),
      engine: opt.engine || (item.stCards || [])[0]?.engine || '',
      targetPath: mode === 'replace' ? opt.targetPath || item.stTargetPath || '' : '',
      replace: mode === 'replace',
      overwrite: mode === 'replace'
    })
    if (r?.ok) {
      item.stTargetPath = r.path || item.stTargetPath || ''
      /* 覆盖旧预设前留的备份（主进程返回原文）—— 与世界书 / 角色卡口径一致。
         备份是附加动作，失败不影响已经成功的替换。 */
      if (r.oldWorld && opt.backupOldWorld) {
        try {
          saveWorldBackup(item, r.oldWorld.name, r.oldWorld.data || r.oldWorld.text, '替换前自动备份')
        } catch (e) {
          console.warn('[preset backup] failed', e)
        }
      }
      refreshTavernCompareSoon(item)
      /* 落点写清楚：以前只报「成功」，实际写进了酒馆不读的目录，用户看不出问题在哪 */
      const where = r.engine ? `「${r.engine} Settings」` : ''
      toast(
        `已${mode === 'replace' ? '替换' : '导入'}预设：${item.name}` +
          (where ? `，落在${where}` : '') +
          (r.movedFrom ? '（已从旧目录改写到酒馆当前接口的目录）' : '')
      )
    } else {
      toast('写入酒馆失败：' + ((r && r.error) || '未知错误'))
    }
    return r || { ok: false, error: '未知错误' }
  }

  if (cat === 'themes') {
    /* 美化在酒馆里就是一个 themes/*.json 文件，没有「替换某张卡」的概念。
       以前这里会掉进下面「其他」分支交给 importAny 按内容猜类别，
       内容猜错就会把主题当世界书/预设写进错目录。这里直接写真正的主题 json
       （酒馆认 custom_css 字段，也认纯外观字段）。同名不覆盖，由主进程自动加序号。 */
    let theme = themeJsonOf(version, item)
    /* raw 常常只在侧车里（slimItems 落盘时被剥走），没加载过就会拼不出主题，这里补读一次 */
    if (!theme) {
      await ensureVersionRaw(item, version)
      theme = themeJsonOf(version, item)
    }
    if (!theme) return { ok: false, error: '这个版本没有可导入的内容' }
    if (!a.writeNamed) return { ok: false, error: '版本过旧，重启一下软件' }
    const tp = String(store.settings.tavernPath || '').replace(/[\\/]+$/, '')
    if (!tp) return { ok: false, error: '还没设置酒馆目录' }
    const dir = `${tp}/data/${store.settings.stUser || 'default-user'}/themes`
    const r = await a.writeNamed({ dir, name: `${safeName(item.name)}.json`, text: JSON.stringify(theme, null, 2) })
    if (r?.ok) {
      item.stTargetPath = r.path || item.stTargetPath || ''
      toast(`已写入酒馆美化：${item.name}`)
    } else {
      toast('写入酒馆失败：' + ((r && r.error) || '未知错误'))
    }
    return r || { ok: false, error: '未知错误' }
  }

  if (cat !== 'characters') {
    /* 「其他」分类：内容可能是世界书 / 预设 / 角色卡 JSON，交给主进程按内容判断该进哪个目录 */
    if (!a.stImportAny) return { ok: false, error: '版本过旧，重启一下软件' }
    const content = version?.raw
    if (!content) return { ok: false, error: '这个版本没有可写入的 JSON 内容' }
    const bin = await loadVersionContent(version)
    const r = await a.stImportAny({
      tavernPath: store.settings.tavernPath,
      user: store.settings.stUser,
      name: item.name,
      data: toPlain(content),
      buffer: toPlain(bin.buffer) || undefined,
      json: toPlain(bin.json || content),
      avatar: mode === 'replace' ? stAvatarOf(item, opt) : undefined,
      targetPath: mode === 'replace' ? opt.targetPath || item.stTargetPath || '' : '',
      engine: opt.engine || (item.stCards || [])[0]?.engine || '',
      replace: mode === 'replace',
      overwrite: mode === 'replace'
    })
    if (r?.ok) {
      /* 世界书 / 预设 走的是 importAny：它同样会返回被覆盖前的 oldWorld，
         但以前只有角色卡那条分支把它存进「其他」分类，这里漏了 —— 勾了「备份旧世界书」
         却看不到备份。备份是附加动作，失败不影响已经成功的替换。 */
      item.stTargetPath = r.path || item.stTargetPath || ''
      if (r.avatar) item.stAvatar = r.avatar
      refreshTavernCompareSoon(item)
      const kindText = r.mode ? '角色卡' : r.kind === 'presets' ? '预设' : '世界书'
      toast(`已${mode === 'replace' ? '替换' : '写入'}酒馆${kindText}：${r.name || item.name}`)
    } else {
      toast('写入酒馆失败：' + ((r && r.error) || '未知错误'))
    }
    return r || { ok: false, error: '未知错误' }
  }

  const content = await loadVersionContent(version, item)
  if (!content.buffer && !content.json) return { ok: false, error: '这个版本没有原始角色卡文件，无法写入酒馆' }

  /* 资料库没记酒馆文件名时，先扫一次同名卡；仍为空也不拦，交给主进程按名字在酒馆里定位 */
  let avatar = mode === 'replace' ? stAvatarOf(item, opt) : ''
  if (mode === 'replace' && !avatar && resolveCat(item) === 'characters') {
    try {
      refreshTavernCompareSoon(item)
    } catch (_) {}
    avatar = stAvatarOf(item, opt)
  }

  const wantWorld = cardWantWorld(content.json)
  const worldSource = mode === 'new' ? await worldSourceFor(wantWorld) : undefined

  const payload = {
    tavernPath: store.settings.tavernPath,
    user: store.settings.stUser,
    buffer: toPlain(content.buffer) || undefined,
    json: toPlain(content.json),
    name: item.name,
    replaceWorld: opt.replaceWorld === true,
    backupOldWorld: !!opt.backupOldWorld,
    avatar: mode === 'replace' ? avatar : undefined,
    /* 用户已经在前端点明写哪一份 → 主进程别再弹一次选择框；
       没点明（avatar 来自历史记录）时留空，让主进程弹窗兜底 */
    pickAvatar: mode === 'replace' ? String(opt.pickAvatar || '') || undefined : undefined,
    worldName: item.worldName || '',
    /* 新建不传任何「选哪一份」的参数：主进程直接按独立基名另起一份，不判同族、不问覆盖。
       下面这条是世界书补写用：卡内 extensions.world 指向的名，酒馆 worlds 下缺失时由主进程按这份内容补写 */
    worldSource
  }

  /* 新建 = 直接新建：主进程自己按独立基名另起一份，这里不做同族判定、不弹任何选择菜单，
     单条与多选共用这一条路径。 */
  let r = mode === 'replace' ? await a.stReplaceCard(payload) : await a.stImportCard(payload)
  /* 酒馆里根本没有这张卡（没导入过、或被改名了）：不报错、也不弹任何窗，直接当新卡写一份。
     「更新」和「导入」在用户眼里是同一个动作 —— 有就覆盖，没有就新建。 */
  if (mode === 'replace' && r && !r.ok && r.notFound) {
    /* 用户点的是「更新」，酒馆里没有这张卡 → 当新建写一份（同一套直接新建逻辑，不会覆盖任何卡）。 */
    r = await a.stImportCard({ ...payload, avatar: undefined, pickAvatar: undefined })
    if (r && r.ok) r.createdByUpdate = true
  }

  if (r?.ok) {
    if (r.oldWorld && opt.backupOldWorld) {
      /* 备份旧世界书是「顺手做的附加动作」，单独兜住异常：
         这里抛错会把整条成功链路打断，界面上就只剩一个空的提示层 */
      try {
        saveWorldBackup(item, r.oldWorld.name, r.oldWorld.data || r.oldWorld.text, '替换前自动备份')
      } catch (e) {
        console.warn('[world backup] failed', e)
      }
    }
    if (r.avatar) {
      item.stAvatar = r.avatar
      /* 写盘已经成功，比对失败不能反过来把这一步变成"失败/异常" */
      try {
        refreshTavernCompareSoon(item)
      } catch (e) {
        console.warn('[refresh compare] failed', e)
      }
    }
    /* 提示里既给卡内真名（酒馆里显示的那个名字），也给写进去的文件名 ——
       两个名字不一样时，用户找不到自己刚写进去的是哪一份。 */
    const realName = cardDisplayName(content.json, item.name)
    const where = r.avatar ? `（${r.avatar}.png）` : ''
    const worldNote = r.worldFilled ? `，已补世界书「${r.world}」` : ''
    toast(
      (r.createdByUpdate
        ? `酒馆里还没有这张卡，已新建：${realName}${where}`
        : mode === 'replace'
          ? `已更新：${realName}${where}`
          : `已在酒馆新建：${realName}${where}`) + worldNote
    )
  } else if (r && r.canceled) {
    toast('已取消，酒馆里的角色卡没有改动')
  } else if (r && r.needPick) {
    /* 酒馆里有多个同名副本、但这一轮没拿到用户点选（条目上的比对过期）：
       绝不能再静默写一张，提示用户到详情页点一次「更新到酒馆」由菜单定夺 */
    toast('酒馆里有多个同名角色，请在详情页点「更新到酒馆」选择写哪一份')
  } else {
    toast('写入酒馆失败：' + ((r && r.error) || '未知错误'))
  }
  return r || { ok: false, error: '未知错误' }
}

/* ---------------- 批量写入酒馆（多选版本） ---------------- */

/** 结果项归类文案：汇总面板直接用，避免前后端口径不一致 */
export function tavernBatchStatusText(r) {
  if (!r) return ''
  if (r.status === 'created') return '新建'
  if (r.status === 'skipped') return '跳过'
  return '失败'
}

/**
 * 把选中的多个版本串行写入酒馆（不并发写盘，一次只写一份）
 *
 * 批量只有一种行为：全部新建。
 * 每个选中版本各写一张新卡，遇到同族自动另起独立基名，酒馆里已有的卡一张都不动、一张都不覆盖。
 *
 * @param {object} item 资料库条目
 * @param {string[]} versionIds 选中的版本 id
 * @param {{onProgress?: (p: {index:number,total:number,versionName:string,phase:string})=>void}} opt
 * @returns {Promise<{ok:boolean,error?:string,total:number,okCount:number,failCount:number,skipCount:number,results:Array<object>}>}
 */
export async function pushVersionsToTavern(item, versionIds, opt = {}) {
  const ids = (Array.isArray(versionIds) ? versionIds : []).map((x) => String(x))
  const all = item && Array.isArray(item.versions) ? item.versions : []
  /* 按版本列表顺序执行（界面上的顺序），不按点击顺序 —— 用户看到的就是执行顺序 */
  const vers = all.filter((v) => v && ids.includes(String(v.id)))
  const total = vers.length
  const onProgress = typeof opt.onProgress === 'function' ? opt.onProgress : () => {}
  const out = { ok: false, error: '', total, okCount: 0, failCount: 0, skipCount: 0, results: [] }
  if (!total) return { ...out, error: '先选中要写入酒馆的版本' }

  const a = api()
  if (!a || (!a.stImportCard && !a.stImportWorld && !a.stImportPreset)) {
    return { ...out, error: '请在桌面版里操作' }
  }
  if (!store.stStatus.connected) await checkStConnection()

  /* 先把酒馆现状整条对比一次：写完要立刻给出「酒馆当前版本」标记，
     也避免拿几天前的 stCards 误导结果展示 */
  try {
    await refreshTavernCompare(item, { full: true })
  } catch (e) {
    console.warn('[batch push] refresh compare failed', e)
  }
  const results = []
  /* 本批已成功写入的内容指纹：同批次里内容重复的版本没有覆盖价值，直接跳过并说明 */
  const written = new Map()

  for (let i = 0; i < vers.length; i++) {
    const v = vers[i]
    const rec = {
      versionId: String(v.id),
      versionName: String(v.name || v.date || ''),
      date: String(v.date || ''),
      status: 'failed',
      fileName: '',
      avatar: '',
      note: '',
      error: '',
      worldFilled: false,
      worldName: ''
    }
    onProgress({ index: i + 1, total, versionName: rec.versionName, phase: 'start' })

    if (!v.raw && !v.rawFile) {
      rec.status = 'skipped'
      rec.error = '这一版没有保存原始内容，无法写入酒馆'
      results.push(rec)
      continue
    }
    if (!v.digest) {
      try { await ensureItemDigests(item) } catch (_) {}
    }
    const dg = String(v.digest || '')
    if (dg && written.has(dg)) {
      rec.status = 'skipped'
      rec.error = `与本批「${written.get(dg)}」内容完全相同，已跳过`
      results.push(rec)
      continue
    }

    /* 唯一行为：新建。与单条完全同一条路径（mode:'new'），主进程按独立基名另起一份，
       批量流程不弹任何选择菜单，也不会覆盖任何既有卡 */
    let r = null
    try {
      r = await pushItemToTavern(item, {
        version: v,
        mode: 'new',
        replaceWorld: false,
        backupOldWorld: false,
        silent: true
      })
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) }
    }

    if (r && r.ok) {
      rec.status = 'created'
      rec.avatar = String(r.avatar || '')
      const file = String(r.file || '') || (rec.avatar ? `${rec.avatar}.png` : '')
      rec.fileName = file.split(/[\\/]/).pop()
      rec.worldFilled = !!r.worldFilled
      rec.worldName = String(r.world || '')
      if (dg) written.set(dg, rec.versionName)
    } else if (r && r.canceled) {
      rec.status = 'skipped'
      rec.error = '已取消'
    } else {
      rec.status = 'failed'
      rec.error = String((r && r.error) || '未知错误')
    }
    results.push(rec)
  }

  const okCount = results.filter((x) => x.status === 'created').length
  const failCount = results.filter((x) => x.status === 'failed').length
  const skipCount = results.filter((x) => x.status === 'skipped').length

  /* 全部写完后统一刷新一次对比：逐条刷新会把酒馆扫描拖成 N 次 */
  try {
    await refreshTavernCompare(item, { full: true })
  } catch (e) {
    console.warn('[batch push] refresh compare failed', e)
  }
  onProgress({ index: total, total, versionName: '', phase: 'done' })
  return { ok: failCount === 0, error: '', total, okCount, failCount, skipCount, results }
}

/* ---------------- 世界书备份（放进「其他」） ---------------- */


/** 推送成功后刷新「酒馆里是哪一版」的比对：放到空闲时做，别卡住刚点完按钮的界面 */
function refreshTavernCompareSoon(item) {
  const run = () => {
    Promise.resolve(refreshTavernCompare(item)).catch((e) => console.warn('[refresh compare] failed', e))
  }
  try {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1500 })
    else setTimeout(run, 60)
  } catch (_) {
    setTimeout(run, 60)
  }
}

/** 侧车直通写入完成后的收尾：与本地分支同样的成功/失败处理 */
function finishPushFromSidecar(item, r, cat, opt = {}) {
  if (!r || !r.ok) {
    showToast('写入酒馆失败：' + ((r && r.error) || '未知错误'))
    return r || { ok: false, error: '未知错误' }
  }
  if (r.path) item.stTargetPath = r.path
  if (r.avatar) item.stAvatar = r.avatar
  if (r.oldWorld && opt.backupOldWorld) {
    try {
      saveWorldBackup(item, r.oldWorld.name, r.oldWorld.data || r.oldWorld.text, '更新前自动备份')
    } catch (e) {
      console.warn('[world backup] failed', e)
    }
  }
  try { saveItems() } catch (_) {}
  refreshTavernCompareSoon(item)
  const label = cat === 'presets' ? '预设' : cat === 'worldbooks' ? '世界书' : '内容'
  showToast('已写入酒馆' + label + '：' + (r.name || item.name))
  return r
}
export function worldBackupFolder(item) {
  const list = store.items.others || (store.items.others = [])
  let folder = list.find((x) => x.kind === 'world-backup' && x.name === item.name)
  if (!folder) {
    folder = {
      id: nextId('o'),
      /* 同 commitImport：类别随条目落盘，详情页当场就能认出「其他」 */
      category: 'others',
      kind: 'world-backup',
      name: item.name,
      desc: `「${item.name}」修改过的世界书备份`,
      tags: ['世界书备份'],
      hue: 95,
      cover: item.cover || '',
      date: new Date().toISOString().slice(0, 10),
      updatedAt: new Date().toISOString().slice(0, 10),
      stCards: [],
      backups: [],
      versions: []
    }
    list.push(folder)
  }
  if (!Array.isArray(folder.backups)) folder.backups = []
  return folder
}

export function saveWorldBackup(item, worldName, payload, note = '手动备份') {
  if (!payload) return null
  /* payload 可能来自主进程的 { text, entries, size }，也可能是旧调用方传的对象。
     一律只留「文本 + 条目数」：整本世界书对象留在响应式数据里，
     会被 vite/vue 深代理 + 每次整库序列化搬一遍，大世界书直接把界面卡成黑屏。 */
  let text = ''
  if (typeof payload === 'string') {
    text = payload
  } else if (payload.text) {
    text = String(payload.text)
  } else if (payload.data) {
    try { text = JSON.stringify(payload.data) } catch (_) { text = '' }
  } else {
    try { text = JSON.stringify(payload) } catch (_) { text = '' }
  }
  if (!text) return null
  const folder = worldBackupFolder(item)
  const day = new Date().toISOString().slice(0, 10)
  const id = nextId('wb')
  /* 条目数一律以真正写进侧车的文本为准：调用方传进来的 payload.entries 不可信
     （主进程 oldWorld 那条链路上常带 0，导致备份列表全显示「0 条」，看着像空备份）。 */
  let entries = 0
  try {
    const j = JSON.parse(text)
    entries = j && j.entries && typeof j.entries === 'object' ? Object.keys(j.entries).length : 0
  } catch (_) {
    entries = 0
  }
  if (!entries && payload && typeof payload === 'object' && payload.entries && typeof payload.entries === 'object') {
    entries = Object.keys(payload.entries).length
  }
  const fn = rawFileName(folder.id, id)
  putSidecar(BACKUP_SUB, fn, text)
  const rec = {
    id,
    worldName: String(worldName || item.name),
    date: day,
    at: nowStr(),
    note,
    entries: Number(entries) || 0,
    rawFile: fn,
    size: String(text).length
  }
  folder.backups.unshift(rec)
  folder.updatedAt = day
  saveItems()
  showToast(`已备份世界书：${rec.worldName}`)
  return rec
}

export function listWorldBackups(item) {
  const list = store.items.others || []
  const folder = list.find((x) => x.kind === 'world-backup' && x.name === item.name)
  const arr = folder && Array.isArray(folder.backups) ? folder.backups : []
  /* 只回传「瘦身视图」：绝不把 backups[].data / .text（整本世界书）塞进模板的响应式列表。
     旧库里残留的 data 在这里顺手落侧车并摘掉，避免每次打开「查看世界书备份」都把几十兆
     对象交给 Vue 深代理 + 模板 diff —— 这就是点开备份直接黑屏的根因。 */
  return arr.map((b) => {
    if (!b) return null
    if (b.data || b.text) {
      const fn = b.rawFile || rawFileName(folder.id, b.id)
      let text = ''
      try { text = b.text ? String(b.text) : JSON.stringify(b.data) } catch (_) { text = '' }
      if (text) putSidecar(BACKUP_SUB, fn, text)
      b.rawFile = fn
      delete b.data
      delete b.text
    }
    return {
      id: b.id,
      worldName: b.worldName,
      date: b.date,
      at: b.at,
      note: b.note,
      entries: b.entries,
      size: b.size,
      rawFile: b.rawFile || ''
    }
  }).filter(Boolean)
}

/** 把某个备份的世界书还原到酒馆 worlds 目录 */
export async function restoreWorldBackup(item, rec) {
  const a = api()
  if (!a?.stImportWorld) return { ok: false, error: '请在桌面版里操作' }
  const text = await ensureBackupText(rec)
  if (!text) return { ok: false, error: '这份备份内容已经找不到' }
  const r = await a.stImportWorld({
    tavernPath: store.settings.tavernPath,
    user: store.settings.stUser,
    name: rec.worldName,
    data: text,
    replace: true,
    backupOld: false
  })
  if (r?.ok) showToast('已还原世界书：' + rec.worldName)
  else showToast('还原失败：' + ((r && r.error) || ''))
  return r
}

/* ---------------- 更新角色卡（添加新版本） ---------------- */

/** 从本地文件给某个角色卡加一个新版本 */
export async function addNewVersionFromFile(item) {
  const a = api()
  if (!a?.pickFiles) {
    showToast('请在桌面版里操作')
    return null
  }
  /* 老数据可能没带 category，用 catOf 兜底，别让文件筛选条件凭字段缺失猜错 */
  const isChar = catOf(item) === 'characters'
  const files = await a.pickFiles({
    title: isChar ? '选择新版本的角色卡' : '选择新版本的文件',
    filters: isChar
      ? [{ name: '角色卡', extensions: ['png', 'json'] }]
      : [{ name: '数据文件', extensions: ['json', 'png'] }]
  })
  if (!files || !files.length) return null
  return await addNewVersionFromPath(item, files[0])
}

export async function addNewVersionFromPath(item, p, note = '更新角色卡') {
  const row = await makeImportRowFromPath(p, 'file')
  if (row.error) {
    showToast(row.error)
    return null
  }
  const { analyzeFiles } = await import('./lib/importer.js')
  const parsed = await analyzeFiles([row.file])
  const r = parsed[0]
  if (!r || r.error) {
    showToast((r && r.error) || '这个文件读不出来')
    return null
  }
  const day = row.date || new Date().toISOString().slice(0, 10)
  // 版本名默认就是这一版的日期（可改成字母 / 汉字），重名才顺延
  let vname = day
  const usedNames = new Set((item.versions || []).map((v) => String(v.name || '')))
  if (usedNames.has(vname)) {
    let n = 2
    while (usedNames.has(`${day} 第${n}版`)) n++
    vname = `${day} 第${n}版`
  }
  const ver = {
    id: nextId('v'),
    name: vname,
    date: day,
    current: false,
    note,
    raw: r.payload && typeof r.payload === 'object' ? markRaw(toPlain(r.payload)) : r.payload || undefined,
    srcFile: r.fileName || '',
    srcPath: p,
    sig: r.payload ? sigOfPayload(catOf(item), r.payload) : '',
    key: r.payload ? keyOfPayload(catOf(item), r.payload) : '',
    imgId: await imageIdOfRow(r)
  }
  const bytes = await bytesOfPath(p)
  if (bytes) setVersionBuffer(ver.id, bytes)
  item.versions = item.versions || []
  item.versions.unshift(ver)
  item.updatedAt = day
  showToast(`已添加新版本：${ver.name}`)
  return ver
}

/**
 * 用链接给当前条目加一个新版本（下载 → 解析 → 落成版本）
 * @param {object} item
 * @param {string} url 角色卡文件直链（png / json）
 */
export async function addNewVersionFromUrl(item, url) {
  const u = String(url || '').trim()
  if (!u) {
    showToast('请输入链接')
    return null
  }
  if (!/^https?:\/\//i.test(u)) {
    showToast('链接需要以 http(s):// 开头')
    return null
  }
  if (isPostLink(u)) {
    showToast('这是帖子链接，不是文件直链')
    return null
  }
  const a = api()
  if (!a?.download) {
    showToast('请在桌面版里使用')
    return null
  }
  showToast('正在下载…')
  const dl = await a.download({ url: u })
  if (!dl || !dl.ok) {
    showToast('下载失败：' + ((dl && dl.error) || '链接可能已过期'))
    return null
  }
  return await addNewVersionFromPath(item, dl.path, '链接更新')
}

/* ---------------- 版本删除 / 当前版本 ---------------- */

export function setCurrentVersion(item, version) {
  if (!item || !version) return
  for (const v of item.versions || []) v.current = false
  version.current = true
  item.stVersion = version.name
  // 换版本 = 换图：条目图跟着版本图走，详情页与书架同时生效
  if (version.imgId) ensureImage(version.imgId)
  if (version.raw && !version.key) version.key = keyOfPayload(catOf(item), version.raw)
}

/**
 * 删除若干版本（单个传一个 id 也行）
 * @returns {number} 实际删除数量
 */
export function deleteVersions(item, ids) {
  const set = new Set(Array.isArray(ids) ? ids : [ids])
  if (!item || !set.size) return 0
  const list = item.versions || []
  const keep = []
  let removed = 0
  for (const v of list) {
    if (set.has(v.id)) {
      BUFFERS.delete(v.id)
      removed++
    } else keep.push(v)
  }
  if (!removed) return 0
  // 删掉的若是当前版本，把「正文最全的那版」顶上（不再无条件取第一版，避免空壳版当道）
  if (!keep.some((v) => v.current) && keep.length) {
    const best = bestVersionOf({ versions: keep }) || keep[0]
    best.current = true
    item.stVersion = best.name
  }
  if (!keep.length) item.stVersion = ''
  item.versions = keep
  item.updatedAt = new Date().toISOString().slice(0, 10)
  return removed
}

/* ---------------- 条目重命名 / 合并 ---------------- */

/** 条目属于哪个分类（老数据没有 category 字段也能反查出来；实在查不到才回退当前 tab） */
export function categoryOf(item) {
  if (!item) return store.tab
  return catOf(item) || store.tab
}

/* ---------------- 预设专属：模型标签 / 标签编辑 ---------------- */

/**
/**
 * 预设展示名：老库里没拆分过的名字（如「神本无相V0.8」「YU_V1.3.5」）在首页只显示预设名，
 * 版本号留到详情页。按解析结果取名字部分，不改动已有数据。
 */
export function presetNameOf(item) {
  if (!item) return ''
  const n = String(item.name || '').trim()
  if (!n) return ''
  if (categoryOf(item) !== 'presets') return n
  const pv = parsePresetName(n)
  return String(pv.name || n).trim() || n
}

/**
 * 预设导入酒馆时的落盘名：统一「名字·V版本号」（例：YU·V1.4.0）
 * 版本号依次取：本次导入的版本对象 → 酒馆里在用的版本名 → 空（空则不加后缀）
 */
export function presetImportName(item, ver) {
  const name = String(presetNameOf(item) || item?.name || '').trim() || 'untitled'
  /* 版本号只认「数字打头」的写法：1.4.0 / v1.4.0 / 2.0-beta。
     版本字段偶尔存的是「版本2」这类说明文字，原样拼上去会出现「名字·V版本2」。 */
  const pick = (v) => {
    const s = String(v == null ? '' : v).trim().replace(/^v/i, '')
    return /^\d+(\.\d+)*([.\-_a-z].*)?$/i.test(s) ? s : ''
  }
  const raw = pick(ver && ver.version) || pick(ver && ver.name) || pick(item?.stVersion)
  return raw ? `${name}·V${raw}` : name
}

/**
 * 取预设的模型名（用于卡片上的模型标签）
 * 老数据没有 model 字段：从名字 + 版本名里现推一次，推不到就返回空
 */
export function presetModelOf(item) {
  if (!item) return ''
  const own = String(item.model || '').trim()
  if (own) return own
  const fromName = detectModel(String(item.name || '') + ' ' + String(item.stVersion || ''))
  return fromName || ''
}

/* ---------------- 标签：大小写归一 + 导入自动打标 ---------------- */

/** 标签的比较键：忽略首尾空白、全角半角差异与大小写（Gemini / gemini / Ｇｅｍｉｎｉ 是同一个标签） */
export function tagKeyOf(t) {
  let v = String(t == null ? '' : t)
  /* 零宽字符常伴着复制来的标签，肉眼看不出来却会造出"重复标签" */
  v = v.replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
  try {
    v = v.normalize('NFKC')
  } catch (_) { /* 老环境不支持就按原串处理 */ }
  return v.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * 全库标签写法统计：同一个比较键只保留一种写法。
 * 规则：用出现次数最多的那种写法；次数相同用库里先出现的写法。
 * 这样「Gemini」写得多就用 Gemini，不会被后导入的 gemini 改写。
 */
function tagCanonIndex() {
  const stat = new Map()
  for (const k of CAT_KEYS) {
    for (const it of store.items[k] || []) {
      for (const t of it.tags || []) {
        const v = String(t == null ? '' : t).trim()
        if (!v) continue
        const key = tagKeyOf(v)
        const cur = stat.get(key)
        if (cur) cur.n++
        else stat.set(key, { text: v, n: 1 })
      }
    }
  }
  return stat
}

/** 把一个标签写法映射到库里既有的写法（没有同键标签就原样返回） */
export function canonicalTag(t, index) {
  const v = String(t == null ? '' : t).trim()
  if (!v) return ''
  const idx = index || tagCanonIndex()
  const hit = idx.get(tagKeyOf(v))
  return hit ? hit.text : v
}

/**
 * 全库标签归一（启动时静默跑一次）：
 * 同一个标签的大小写 / 空白 / 全角差异合并成一种写法，并把条目内按 tagKeyOf 重复的标签删掉。
 * 只动标签数组，不碰条目、版本、原始 JSON。
 * @returns {number} 改动的标签个数（0 表示无需改动）
 */
export function normalizeAllTags() {
  const idx = tagCanonIndex()
  let changed = 0
  for (const k of CAT_KEYS) {
    for (const it of store.items[k] || []) {
      const arr = Array.isArray(it.tags) ? it.tags : []
      if (!arr.length) continue
      const seen = new Set()
      const next = []
      for (const t of arr) {
        const v = String(t == null ? '' : t).trim()
        if (!v) {
          changed++
          continue
        }
        const key = tagKeyOf(v)
        const canon = idx.get(key)?.text || v
        /* 同键只留第一个：即使用户之前的库里已经躺了两份「Gemini」，这里也会被清掉 */
        if (seen.has(key)) {
          changed++
          continue
        }
        seen.add(key)
        if (canon !== t) changed++
        next.push(canon)
      }
      if (next.length !== arr.length || next.some((v, i) => v !== arr[i])) it.tags = next
    }
  }
  if (changed) saveItems()
  return changed
}

/**
 * 模型标签统一（启动时跑一次，幂等）：
 * 历史预设的 tags 里存的是模型族名（gemini），而卡片徽标 / 详情页显示的是完整名（gemini 4）。
 * 这里把族名标签折成完整名、清掉同键重复，并给还没有模型标签的预设补上，
 * 让「标签数组」「模型徽标」「筛选栏」「标签编辑」四处口径完全一致。
 * 只动 presets 的 tags 数组，不碰名字、版本与原始 JSON。
 * @returns {number} 改动的条目数（0 表示无需改动）
 */
export function migrateModelTags() {
  let changed = 0
  for (const it of store.items.presets || []) {
    /* 用户明确删掉过模型标签的条目不再自动补回 */
    if (it.modelTagOff) continue
    const model = String(presetModelOf(it) || '').trim()
    if (!model) continue
    const family = model.split(/\s+/)[0]
    const modelKey = tagKeyOf(model)
    const familyKey = tagKeyOf(family)
    const arr = Array.isArray(it.tags) ? it.tags : []
    const seen = new Set()
    const next = []
    let touched = false
    for (const t of arr) {
      const v = String(t == null ? '' : t).trim()
      if (!v) {
        touched = true
        continue
      }
      /* 只折「族名」这一种标签（gemini → gemini 4）；用户自己写的其它标签原样保留 */
      const fold = modelKey !== familyKey && tagKeyOf(v) === familyKey
      if (fold) touched = true
      const val = fold ? model : v
      const key = tagKeyOf(val)
      if (seen.has(key)) {
        touched = true
        continue
      }
      seen.add(key)
      next.push(val)
    }
    /* 模型标签必须进 tags，筛选栏里才会出现「gemini 4」这一项 */
    if (!seen.has(modelKey)) {
      next.unshift(model)
      touched = true
    }
    if (touched || next.length !== arr.length || next.some((v, i) => v !== arr[i])) {
      it.tags = next
      changed++
    }
  }
  if (changed) saveItems()
  return changed
}

/**
 * 导入时自动生成的标签：
 * ① 卡片 / 预设文件自带的标签词条（角色卡 v2 的 data.tags、v1 的 tags）
 * ② 预设识别到的模型名（标题、名称、文件名里认出来的，如 Gemini / Claude）
 * 不做任何改写，交回给调用方按原样落库（大小写差异由归一逻辑收起）
 */
export function autoTagsOfRow(r) {
  const out = []
  const seen = new Set()
  const push = (t) => {
    const v = String(t == null ? '' : t).trim()
    if (!v) return
    const k = tagKeyOf(v)
    if (seen.has(k)) return
    seen.add(k)
    out.push(v)
  }
  const p = r && r.payload
  if (p && typeof p === 'object') {
    /* 各家导出格式放标签的字段不一样，常见的几种都收：
       tags / labels / categories，以及 extensions.tags、meta.tags、data.tags */
    const bags = [p.tags, p.data && p.data.tags, p.labels, p.categories, p.preset_tags,
      p.extensions && p.extensions.tags, p.meta && p.meta.tags]
    for (const bag of bags) {
      if (Array.isArray(bag)) bag.forEach(push)
      else if (typeof bag === 'string') String(bag).split(/[,，、]/).forEach(push)
    }
  }
  const cat = r && r.category
  if (cat === 'presets') {
    /* 标题 / 名称 / 文件名 / 文件里的 name 字段里认模型（Gemini / Claude / GPT…） */
    const names = [
      r.model, r.name, r.dcTitle, r.fileName, r.version,
      p && p.name, p && p.preset_name
    ].filter(Boolean)
    const m = String(r.model || '').trim() || detectModel(names.join(' '))
    /* 标签与卡片上的模型徽标统一用同一个完整模型名（gemini 4 / claude 3.7 sonnet）：
       以前这里只取族名（gemini），徽标却是完整名，于是同一个预设出现「gemini + gemini 4」
       两个标签；完整名那一版因为从没进过 tags，筛选栏里根本点不到、也改不了 */
    if (m) push(m)
  }
  return out
}

/**
 * 给若干条目批量加标签（预设的右键「编辑标签」/ 多选批量加标签都走这里）
 * 标签按用户输入的原样保存，只做去重（忽略大小写与首尾空白），不做任何模型归一化改写
 * @param {Array} items
 * @param {Array<string>} tags
 * @returns {{added:number, total:number}}
 */
export function addTagsToItems(items, tags) {
  const list = Array.isArray(items) ? items.filter(Boolean) : []
  const raw = (Array.isArray(tags) ? tags : String(tags || '').split(/[,，\s]+/))
    .map((t) => String(t || '').trim())
    .filter(Boolean)
  if (!list.length || !raw.length) return { added: 0, total: 0 }
  /* 库里已有同名标签（大小写不同也算同一个）时沿用既有写法，
     避免凭空造出「Gemini」和「gemini」两个标签 */
  const idx = tagCanonIndex()
  const input = raw.map((t) => canonicalTag(t, idx))
  let added = 0
  for (const it of list) {
    const cur = Array.isArray(it.tags) ? it.tags.slice() : []
    const seen = new Set(cur.map((t) => tagKeyOf(t)))
    for (const t of input) {
      const k = tagKeyOf(t)
      if (seen.has(k)) continue
      seen.add(k)
      cur.push(t)
      if (!idx.has(k)) idx.set(k, { text: t, n: 1 })
      added++
    }
    it.tags = cur
    it.updatedAt = new Date().toISOString().slice(0, 10)
  }
  saveItems()
  return { added, total: list.length }
}

/** 覆盖式设置单个条目的标签（右键「编辑标签」用） */
export function setItemTags(item, tags) {
  if (!item) return false
  const arr = (Array.isArray(tags) ? tags : String(tags || '').split(/[,，\s]+/))
    .map((t) => String(t || '').trim())
    .filter(Boolean)
  const idx = tagCanonIndex()
  /* 本条目自己的标签先清掉，否则「把 Gemini 改成 gemini」会被旧写法锁死 */
  for (const t of item.tags || []) {
    const key = tagKeyOf(t)
    if (idx.get(key)?.text === String(t).trim()) idx.delete(key)
  }
  const seen = new Set()
  item.tags = arr
    .map((t) => canonicalTag(t, idx))
    .filter((t) => {
      const k = tagKeyOf(t)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  /* 用户手改标签后，模型标签在不在由他决定：
     删掉了就记 modelTagOff，启动时的模型标签统一不再把它加回来 */
  const mk = tagKeyOf(presetModelOf(item) || '')
  if (mk) item.modelTagOff = !item.tags.some((t) => tagKeyOf(t) === mk)
  item.updatedAt = new Date().toISOString().slice(0, 10)
  saveItems()
  return true
}

/**
 * 已导入过的条目在酒馆里的来源路径集合（「从酒馆导入」列表用，避免重复展示）
 */
export function tavernImportedPaths() {
  const set = new Set()
  for (const k of CAT_KEYS) {
    for (const it of store.items[k] || []) {
      for (const v of it.versions || []) {
        const p = String(v.srcPath || v.srcFile || '').trim()
        if (p) set.add(p.toLowerCase())
      }
      const sp = String(it.srcPath || '').trim()
      if (sp) set.add(sp.toLowerCase())
    }
  }
  return set
}

/**
 * 重命名条目
 * 只改管理器里的条目名与版本展示，不动酒馆里的文件。
 * 酒馆侧按名字找同名卡，所以新名字就是之后对比 / 推送用的名字。
 * @returns {{ok:boolean, error?:string, duplicate?:boolean, old?:string, name?:string}}
 */
export function renameItem(item, rawName, opt = {}) {
  if (!item) return { ok: false, error: '条目不存在' }
  const name = String(rawName == null ? '' : rawName).trim()
  if (!name) return { ok: false, error: '名字不能为空' }
  if (name === item.name) return { ok: true, old: item.name, name }
  const cat = categoryOf(item)
  /* 预设：重命名也走 parsePresetName（跟导入 / 扫描同一套规则）。
     用户输入「神本无相V0.9」时，条目名只留「神本无相」，V0.9 写进版本号展示位。 */
  let pv = null
  let displayName = name
  if (cat === 'presets') {
    pv = parsePresetName(name)
    displayName = String(pv.name || name).trim() || name
  }
  const dup = (store.items[cat] || []).some((x) => x.id !== item.id && String(x.name || '') === displayName)
  if (dup && !opt.allowDuplicate) {
    return { ok: false, error: '同一分类下已有同名条目', duplicate: true, name: displayName }
  }
  const old = String(item.name || '')
  item.name = displayName
  /* 预设改名后要重算归组 key：这样「【Ako】1.9_Polaroid」被手动改成「Ako1.9_Polaroid」后
     就和已存在的「Ako」归到同一预设；同时把拆出来的版本号写回酒馆版本展示位。 */
  if (cat === 'presets') {
    item.presetKey = presetGroupKey(displayName, { bracketed: pv.bracketed }) || item.presetKey
    if (pv.version) item.stVersion = pv.version
    if (!item.model && pv.model) item.model = pv.model
  }
  // 黑名单按名字记，跟着改名一起同步，避免改名后失效
  const bl = store.settings.blacklist || []
  if (bl.includes(old)) store.settings.blacklist = Array.from(new Set(bl.map((x) => (x === old ? name : x))))
  saveItems()
  return { ok: true, old, name, duplicate: !!dup }
}

/** 一组名字的公共前缀（方亦楷哇哦 / 方亦楷哦哦 / 方亦楷好的 → 方亦楷） */
function commonPrefixOf(names) {
  const list = (names || []).map((n) => String(n || ''))
  if (list.length < 2) return ''
  let p = list[0]
  for (const n of list.slice(1)) {
    let i = 0
    while (i < p.length && i < n.length && p[i] === n[i]) i++
    p = p.slice(0, i)
    if (!p) break
  }
  /* 去掉末尾残留的连接词/标点：方亦楷哇哦 + 方亦楷哦哦 会截到「方亦楷」，
     但 方亦楷 + 方亦楷的邻居 会截到「方亦楷的」，这种尾巴要削干净才像个名字 */
  return p.replace(/[\s·\-_—,，、的之与和]+$/u, '')
}

/** 从路径里取酒馆卡的 avatar 名：…\characters\方亦楷哇哦.png → 方亦楷哇哦 */
function avatarFromPath(p) {
  const m = String(p || '').match(/[\\/]([^\\/]+)\.png$/i)
  return m ? m[1] : ''
}

/**
 * 合并多个条目为「同一个条目的多个版本」
 * - 目标条目：opt.targetId 指定，不指定就用传入顺序里的第一个
 * - 版本去重：sig / key 相同视为同一版本，跳过
 * - 图片：沿用现有内容哈希 imgId，同图多版本共享同一引用
 * - 其余条目从资料库移除（只动管理器记录，不删酒馆文件）
 * @param {string[]} ids
 * @param {{targetId?:string}} opt
 */
export function mergeItems(ids, opt = {}) {
  const uniq = Array.from(new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean)))
  if (uniq.length < 2) return { ok: false, error: '至少选两项才能合并' }

  const found = []
  for (const k of CAT_KEYS) {
    for (const it of store.items[k] || []) if (uniq.includes(it.id)) found.push({ tab: k, item: it })
  }
  if (found.length < 2) return { ok: false, error: '选中的条目不足两项' }

  const targetEntry = found.find((f) => f.item.id === (opt.targetId || '')) || found[0]
  const target = targetEntry.item
  // 只允许同一分类内合并：角色卡 / 世界书 / 预设 / 其他 的数据结构不同，混着合会坏数据
  if (found.some((f) => f.tab !== targetEntry.tab)) {
    return { ok: false, error: '只能合并在同一分类里的条目' }
  }
  if (!Array.isArray(target.versions)) target.versions = []

  const seenSig = new Set()
  const seenKey = new Set()
  const usedNames = new Set()
  for (const v of target.versions) {
    if (v.sig) seenSig.add(String(v.sig))
    if (v.key) seenKey.add(String(v.key))
    usedNames.add(String(v.name || ''))
  }

  let moved = 0
  let dup = 0
  const sources = found.filter((f) => f.item.id !== target.id)

  /* 合并后叫什么：
     酒馆里的同名角色常靠「名字 + 后缀」区分（方亦楷哇哦 / 方亦楷哦哦 / 方亦楷好的），
     合到一起时条目名取这几项的公共前缀（方亦楷），各项多出来的后缀（哇哦 / 哦哦 / 好的）
     写到自己版本名的前面：哇哦2026-01-01。没有公共前缀就保持目标条目名不变。 */
  const allNames = found.map((f) => String(f.item.name || '').trim()).filter(Boolean)
  let shared = allNames.length > 1 ? commonPrefixOf(allNames) : ''
  if (shared.length < 2 || allNames.every((n) => n === shared)) shared = ''
  const suffixOf = (n) => (shared && n.startsWith(shared) && n !== shared ? n.slice(shared.length).trim() : '')
  /* 被右键的那一项自己也可能带后缀（方亦楷哇哦），它原有的版本同样要标上「哇哦」，
     否则合并后只剩别人带前缀，一眼看不出这版来自哪张卡 */
  const targetSfx = suffixOf(String(target.name || '').trim())
  if (shared && target.name !== shared) target.name = shared
  if (targetSfx) {
    for (const v of target.versions || []) {
      const nm = String(v.name || '').trim()
      if (nm && !nm.startsWith(targetSfx)) v.name = targetSfx + nm
    }
  }

  for (const src of sources) {
    const s = src.item
    const sfx = suffixOf(String(s.name || '').trim())
    const sCards = Array.isArray(s.stCards) ? s.stCards : []
    const avatars = sCards.map((c) => String(c.avatar || '')).filter(Boolean)
    const movedIds = []
    for (const v of s.versions || []) {
      if ((v.sig && seenSig.has(String(v.sig))) || (v.key && seenKey.has(String(v.key)))) {
        dup++
        continue
      }
      // 版本整体搬过来，id 不变 → BUFFERS 里的原始二进制照样能取到
      const clone = { ...v, current: false }
      /* 这一版最初来自酒馆里的哪张卡（方亦楷哇哦.png）：合并后条目名变了，
         靠它还能把每一版对回酒馆里对应的那张卡 */
      const hitCard = sCards.find(
        (c) => (v.digest && c.digest && c.digest === v.digest) || (v.sig && c.sig && c.sig === v.sig)
      )
      clone.stAvatar =
        (hitCard && hitCard.avatar) ||
        v.stAvatar ||
        avatarFromPath(v.srcPath) ||
        (avatars.length === 1 ? avatars[0] : '') ||
        ''
      let vname = String(clone.name || clone.date || '').trim() || '合并版本'
      if (sfx) vname = sfx + vname
      if (usedNames.has(vname)) {
        const base = vname
        let n = 2
        while (usedNames.has(`${base} 第${n}版`)) n++
        vname = `${base} 第${n}版`
      }
      clone.name = vname
      usedNames.add(vname)
      if (clone.sig) seenSig.add(String(clone.sig))
      if (clone.key) seenKey.add(String(clone.key))
      target.versions.push(clone)
      movedIds.push(clone.id)
      moved++
    }
    /* 后台记录：这几张酒馆卡（方亦楷哇哦 / 哦哦 / 好的）在资料库里已合并成同一角色的不同版本 */
    if (!Array.isArray(target.stAliases)) target.stAliases = []
    target.stAliases.push({ name: String(s.name || ''), suffix: sfx, avatars, versionIds: movedIds })
    /* 酒馆里的候选卡也一并并进来：「更新到酒馆」就靠这份名单列出所有副本让用户挑 */
    if (!Array.isArray(target.stCards)) target.stCards = []
    for (const c of sCards) {
      const av = String(c.avatar || '')
      if (av && !target.stCards.some((x) => x.avatar === av)) target.stCards.push({ ...c })
    }
    /* 取消「没有依据就取第一张卡」的兜底：只有来源的当前版本确实对上了某张卡才记绑定，
       否则留空，等用户在对比区点「重新绑定」明确指定 */
    if (!target.stAvatar && avatars.length) {
      const sCur = (s.versions || []).find((x) => x.current)
      const hitCur =
        sCur &&
        sCards.find(
          (c) =>
            (sCur.digest && c.digest && c.digest === sCur.digest) ||
            (sCur.sig && c.sig && c.sig === sCur.sig)
        )
      if (hitCur && hitCur.avatar) target.stAvatar = hitCur.avatar
    }
    // 目标缺的信息用来源补（图、来源路径、日期、DC 链接、简介）
    if (!target.imgId && s.imgId) target.imgId = s.imgId
    if (!target.srcPath && s.srcPath) target.srcPath = s.srcPath
    if (!target.date && s.date) target.date = s.date
    if (!String(target.desc || '').trim() && String(s.desc || '').trim()) target.desc = s.desc
    if ((!target.dc || !target.dc.url) && s.dc && s.dc.url) target.dc = { ...s.dc }
    // 从原分类移除（只删管理器记录）
    store.items[src.tab] = (store.items[src.tab] || []).filter((x) => x.id !== s.id)
  }

  // 保证有且只有一个当前版本（没有 current 时选「正文最全的版本」，不再无条件取 versions[0]）
  const currents = target.versions.filter((v) => v.current)
  if (!currents.length && target.versions.length) {
    const best = bestVersionOf(target) || target.versions[0]
    best.current = true
  } else if (currents.length > 1) for (const v of currents.slice(1)) v.current = false
  const cur = target.versions.find((v) => v.current) || bestVersionOf(target) || target.versions[0]
  if (cur) {
    target.stVersion = cur.name
    if (cur.imgId) target.imgId = cur.imgId
    if (!target.date && cur.date) target.date = cur.date
  }
  target.updatedAt = new Date().toISOString().slice(0, 10)

  const removedIds = sources.map((s) => s.item.id)
  store.selected = store.selected.filter((id) => !removedIds.includes(id))
  saveItems()
  primeCovers([target])

  return {
    ok: true,
    name: target.name,
    moved,
    dup,
    removed: sources.length,
    removedNames: sources.map((s) => s.item.name),
    total: target.versions.length
  }
}

/* ---------------- 开场白（与酒馆一致：1 条默认 + N 条备选） ---------------- */

/**
 * 从角色卡 JSON 里取出开场白，口径与酒馆一致：
 * 默认开场白 = first_mes 原文（原样，不拆块）；备选开场白 = alternate_greetings。
 * @returns {{first: string, alternates: string[], total: number}}
 */
export function greetingsOf(json) {
  const d = cardDataOf(json || {})
  const first = String(d.first_mes || '').trim()
  const alternates = []
  for (const g of d.alternate_greetings || []) {
    const t = String(g || '').trim()
    if (t) alternates.push(t)
  }
  return { first, alternates, total: (first ? 1 : 0) + alternates.length }
}

/** 某一版的开场白 */
export function greetingsOfVersion(version) {
  if (!version) return { first: '', alternates: [], total: 0 }
  return greetingsOf(version.raw || null)
}

/* ---------------- 导出源文件 ---------------- */

/* 各分类导出源文件的扩展名。美化固定 json：酒馆导入美化只认 themes/*.json，
   导出 .css 酒馆读不到（样式是写在 json 的 custom_css 字段里的） */
const EXT_BY_CAT = { characters: 'png', worldbooks: 'json', presets: 'json', themes: 'json', others: 'json' }

function safeName(s) {
  return String(s || 'untitled')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

/**
 * 导出条目（或某个版本）的原始文件，文件名用角色名而不是下载时的乱码名
 */
export async function exportSourceFile(item, version) {
  const a = api()
  if (!a?.writeNamed) {
    showToast('请在桌面版里操作')
    return { ok: false }
  }
  const ver = version || bestVersionOf(item) || null
  const dir = await a.pickDir({ title: '导出到哪里', defaultPath: store.settings.exportDir || store.settings.backupLastDir })
  if (!dir) return { ok: false, canceled: true }
  store.settings.exportDir = dir
  saveSettings()

  const cat = catOf(item)
  let ext = EXT_BY_CAT[cat] || 'json'
  const suffix = ver && ver.name && ver.name !== item.name ? ` - ${safeName(ver.name)}` : ''
  const base = `${safeName(item.name)}${suffix}`

  if (cat === 'others' && (item.kind === 'world-backup' || item.kind === 'zip')) {
    if (item.srcPath) {
      const r = await a.copyTo({ src: item.srcPath, dir, name: item.srcPath.split(/[\\/]/).pop() })
      if (r?.ok) showToast('已导出：' + r.path)
      return r || { ok: false }
    }
  }

  let buffer = null
  let json = null
  if (cat === 'characters') {
    const content = await loadVersionContent(ver, item)
    buffer = content.buffer
    json = content.json
    if (!buffer) {
      showToast('这个版本没有原始角色卡文件')
      return { ok: false }
    }
  } else if (cat === 'themes') {
    /* 美化一律导出成酒馆 themes/*.json 的格式（{ name, ...外观字段, custom_css }）：
       酒馆导入美化只认 json，css 文件它读不到。CSS 与外观字段都塞进这一份里。 */
    json = themeJsonOf(ver, item)
    if (!json) {
      await ensureVersionRaw(item, ver)
      json = themeJsonOf(ver, item)
    }
    if (!json) {
      showToast('这个版本没有可导出的内容')
      return { ok: false }
    }
    ext = 'json'
  } else {
    json = ver?.raw || null
    if (!json) {
      showToast('这个版本没有可导出的内容')
      return { ok: false }
    }
  }

  const name = `${base}.${ext}`
  const r = await a.writeNamed({
    dir,
    name,
    buffer: buffer || undefined,
    text: buffer ? undefined : JSON.stringify(json, null, 2)
  })
  if (r?.ok) showToast('已导出：' + r.path)
  else showToast('导出失败：' + ((r && r.error) || ''))
  return r || { ok: false }
}

/** 右键改日期 */
export function setItemDate(item, date) {
  if (!item) return
  const d = String(date || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    showToast('日期格式应为 2024-05-01')
    return
  }
  item.date = d
  item.updatedAt = d
  showToast('日期已改为 ' + d)
}

/** 改条目备注：书架卡片名字下面显示的就是它（不写回酒馆里那张卡自己的备注） */
export function setItemDesc(item, text) {
  if (!item) return false
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120)
  if (String(item.desc || '') === t) return true
  item.desc = t
  item.updatedAt = new Date().toISOString().slice(0, 10)
  saveItems()
  return true
}

/** 改版本名：允许字母、汉字、数字，重名会被拒绝 */
export function setVersionName(item, version, name) {
  if (!item || !version) return false
  const nm = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 32)
  if (!nm) {
    showToast('版本名不能为空')
    return false
  }
  const dup = (item.versions || []).some((v) => v !== version && String(v.name || '') === nm)
  if (dup) {
    showToast('这个版本名已经用过了')
    return false
  }
  const old = version.name
  if (old === nm) return true
  version.name = nm
  item.updatedAt = new Date().toISOString().slice(0, 10)
  saveItems()
  showToast(`版本名已改为 ${nm}`)
  return true
}

/** 改某个版本的备注（随便写，留空即清掉） */
export function setVersionNote(item, version, note) {
  if (!item || !version) return false
  const t = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 40)
  if (String(version.note || '') === t) return true
  version.note = t
  item.updatedAt = new Date().toISOString().slice(0, 10)
  saveItems()
  showToast(t ? '备注已改为 ' + t : '备注已清空')
  return true
}

/** 改某个版本的日期（只有当前版本会带动条目本身的日期） */
export function setVersionDate(item, version, date) {
  if (!item || !version) return false
  const d = String(date || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    showToast('日期格式应为 2024-05-01')
    return false
  }
  version.date = d
  if (version.current || (item.versions || []).length === 1) item.date = d
  saveItems()
  showToast('版本日期已改为 ' + d)
  return true
}

/* ---------------- 自动扫描 ---------------- */

export function markScanIgnored(file) {
  const k = scanFileKey(file)
  const arr = store.settings.scanIgnored || (store.settings.scanIgnored = [])
  if (!arr.includes(k)) arr.push(k)
  saveSettings()
}

function importedPaths() {
  const set = new Set()
  for (const t of tabs) {
    for (const it of store.items[t.key] || []) {
      if (it.srcPath) set.add(String(it.srcPath).toLowerCase())
      for (const v of it.versions || []) {
        if (v.srcPath) set.add(String(v.srcPath).toLowerCase())
      }
    }
  }
  return set
}

/**
 * 扫描设置里的那个目录，找出「还没导入过、也没被忽略」的文件
 * @param {{manual?:boolean}} opt
 */
export async function runAutoScan(opt = {}) {
  const dir = store.settings.scanPath
  if (!dir) {
    if (opt.manual) showToast('先在设置里选一个要自动扫描的文件夹')
    return { ok: false, list: [] }
  }
  if (!api()?.scanDir) {
    if (opt.manual) showToast('请在桌面版里使用自动扫描')
    return { ok: false, list: [] }
  }
  store.scan.running = true
  // 注意：传给 IPC 的必须是纯数据，Vue 的 reactive 数组是 Proxy，结构化克隆会失败
  const r = await api().scanDir({
    dir: String(dir),
    exts: [...(store.settings.scanExts || [])].map((x) => String(x)),
    recursive: !!store.settings.scanRecursive
  })
  store.scan.running = false
  store.scan.lastAt = nowStr()
  if (!r || !r.ok) {
    if (opt.manual) showToast('扫描失败：' + ((r && r.error) || '目录不存在'))
    return { ok: false, list: [] }
  }

  const ignored = new Set(store.settings.scanIgnored || [])
  const done = importedPaths()
  const fresh = r.list.filter((f) => {
    const k = scanFileKey(f)
    if (ignored.has(k)) return false
    if (done.has(String(f.path).toLowerCase())) return false
    return true
  })

  const known = new Set(store.scan.files.map((f) => scanFileKey(f)))
  const added = fresh.filter((f) => !known.has(scanFileKey(f)))
  store.scan.files = fresh
  if (added.length && !opt.manual) {
    // 气泡常驻，不再自动收起，只提示一次
    showToast(`发现 ${added.length} 个可以导入的新文件`)
  }
  return { ok: true, list: fresh, added: added.length }
}

/** 气泡里：把选中的扫描文件丢进导入对话框 */
export async function importScanFiles(files) {
  const list = (files || []).filter(Boolean)
  if (!list.length) return
  const rows = []
  const big = list.length > 30
  if (big) startBgJob('读取扫描文件', list.length)
  for (let i = 0; i < list.length; i++) {
    const f = list[i]
    const row = await makeImportRowFromPath(f.path, 'scan')
    if (row.error) rows.push({ fileName: f.name, error: row.error, category: 'others', name: f.base, version: '', payload: null, cover: '', source: 'scan' })
    else rows.push({ ...row, file: row.file })
    if (big && (i + 1) % 8 === 0) {
      patchBgJob({ done: i + 1, total: list.length })
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  if (big) endBgJob()
  openImportWith(rows, 'scan')
}

/** 忽略这些扫描文件，以后不再提示 */
export function ignoreScanFiles(files) {
  for (const f of files || []) markScanIgnored(f)
  const keys = new Set((files || []).map((f) => scanFileKey(f)))
  store.scan.files = store.scan.files.filter((f) => !keys.has(scanFileKey(f)))
  showToast(`已忽略 ${(files || []).length} 个文件`)
}

/* ---------------- 从酒馆直接导入 ---------------- */

export async function listTavernCards(type = 'characters', extra = {}) {
  if (type === 'presets' || type === 'worldbooks' || type === 'themes') return await listTavernByType(type, extra)
  if (!api()?.stScanCharacters) return { ok: false, list: [] }
  return await api().stScanCharacters({
    tavernPath: store.settings.tavernPath,
    user: store.settings.stUser
  })
}

/**
 * 清理资料库里"已导入的纯采样参数预设"条目
 * 判据：酒馆 Settings 目录里那些没有 prompts / prompt_order 的 json（NovelAI、KoboldAI、
 * TextGen 等引擎自带的官方采样参数预设），它们不是用户要管理的预设。
 * 只移除资料库内的记录，不动酒馆里的文件。
 */
export async function pruneSamplerPresets() {
  const a = api()
  if (!a?.stScanPresets) return { ok: false, error: '版本过旧', removed: 0, names: [] }
  const base = { tavernPath: store.settings.tavernPath, user: store.settings.stUser }
  const all = await a.stScanPresets({ ...base, includeSamplerPresets: true })
  const kept = await a.stScanPresets({ ...base, includeSamplerPresets: false })
  if (!all?.ok || !kept?.ok) return { ok: false, error: all?.error || kept?.error || '扫描失败', removed: 0, names: [] }
  const keep = new Set((kept.list || []).map((x) => String(x.path || '').toLowerCase()))
  const sampler = new Set(
    (all.list || []).filter((x) => !keep.has(String(x.path || '').toLowerCase())).map((x) => String(x.path || '').toLowerCase())
  )
  if (!sampler.size) return { ok: true, removed: 0, names: [] }
  const arr = store.items.presets || []
  const gone = arr.filter((it) => {
    const paths = [it.srcPath, ...(it.versions || []).map((v) => v.srcPath)]
      .filter(Boolean)
      .map((p) => String(p).toLowerCase())
    return paths.some((p) => sampler.has(p))
  })
  if (!gone.length) return { ok: true, removed: 0, names: [] }
  const goneIds = new Set(gone.map((it) => it.id))
  store.items.presets = arr.filter((it) => !goneIds.has(it.id))
  store.selected = (store.selected || []).filter((id) => !goneIds.has(id))
  if (goneIds.has(store.currentId)) store.currentId = null
  saveItems()
  return { ok: true, removed: gone.length, names: gone.map((it) => it.name) }
}

export async function importFromTavern(cards, opt = {}) {
  const list = (cards || []).filter(Boolean)
  if (!list.length) return
  const rows = []
  const big = list.length > 30 || !!opt.forceJob
  if (big) startBgJob('从酒馆读取', list.length)
  for (let i = 0; i < list.length; i++) {
    const c = list[i]
    const row = await makeImportRowFromPath(c.path, 'st')
    if (row.error) rows.push({ fileName: c.file, error: row.error, category: 'characters', name: c.name, version: '', payload: null, cover: '', source: 'st' })
    else rows.push(row)
    if (big && (i + 1) % 8 === 0) {
      patchBgJob({ done: i + 1, total: list.length })
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  if (big) endBgJob()
  openImportWith(rows, 'st', { silent: !!opt.silent })
}

/* ---------------- 打开导入对话框的统一入口 ---------------- */

export function openImportWith(rows, from = 'file', opt = {}) {
  const incoming = (rows || []).map((r) => ({ ...r, include: !r.error }))
  const silent = !!opt.silent
  if (silent) {
    /* 静默：只更新弹窗状态里的行，不弹界面（「加入导入列表」先在后台准备，准备好了再弹） */
    const keep = Array.isArray(store.importDialog?.rows) ? store.importDialog.rows : []
    store.importDialog = {
      ...(store.importDialog || {}),
      visible: false,
      rows: [...keep, ...incoming],
      busy: false,
      dcUrl: '',
      from
    }
    return
  }
  store.importDialog = {
    visible: true,
    rows: incoming,
    busy: false,
    dcUrl: '',
    from
  }
}

export function closeImport() {
  store.importDialog.visible = false
  store.importDialog.rows = []
}

/* ---------------- 界面指引的演示数据 ----------------
 * 只在「界面指引」气泡期间存在：条目带 demoTour 标记，slimItems() 落盘时整条跳过，
 * 指引结束（下一步走完 / 跳过 / Esc / 组件卸载）即从内存移除，不会写进资料库。 */
export const TOUR_DEMO_IDS = { char: 'tour-demo-char', theme: 'tour-demo-theme' }

function emptyDc() {
  return { url: '', title: '', titleAt: '', lastCheckAt: '', hasUpdate: false, latestTitle: '' }
}

/** 给导入弹窗塞一行演示行（表头与「来源链接」列要有行才渲染）；validRows 会滤掉 demo 行，不会被导入 */
export function addTourDemoImportRow() {
  const d = store.importDialog
  if (!d || !Array.isArray(d.rows)) return
  if (d.rows.some((r) => r.demo)) return
  d.rows.push({
    fileName: '示例角色卡.png',
    name: '示例角色卡',
    category: 'characters',
    version: '',
    remark: '',
    dcUrl: '',
    dcTitle: '',
    dlUrl: '',
    cover: '',
    size: 0,
    source: 'demo',
    demo: true
  })
}

export function dropTourDemoImportRows() {
  const d = store.importDialog
  if (d && Array.isArray(d.rows)) d.rows = d.rows.filter((r) => !r.demo)
}

/** 建两条演示条目：角色卡（DC / 版本操作）+ 美化（效果预览），顺带满足「合并需选中 2 项」 */
export function startTourDemo() {
  if ((store.items.characters || []).some((it) => it && it.id === TOUR_DEMO_IDS.char)) return TOUR_DEMO_IDS
  const dt = new Date()
  const stamp = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
  store.items.characters.unshift({
    id: TOUR_DEMO_IDS.char,
    name: '示例角色卡',
    category: 'characters',
    demoTour: true,
    date: stamp,
    updatedAt: stamp,
    tags: ['示例'],
    dc: emptyDc(),
    stCards: [],
    stCheckedAt: '',
    versions: [
      { id: 'tour-demo-char-v1', name: '初版', date: stamp, note: '', fileName: '示例角色卡.png' },
      { id: 'tour-demo-char-v2', name: '修订版', date: `${stamp} 第2版`, note: '', fileName: '示例角色卡.png' }
    ]
  })
  store.items.themes.unshift({
    id: TOUR_DEMO_IDS.theme,
    name: '示例美化',
    category: 'themes',
    demoTour: true,
    date: stamp,
    updatedAt: stamp,
    tags: ['示例'],
    dc: emptyDc(),
    stCards: [],
    stCheckedAt: '',
    versions: [{ id: 'tour-demo-theme-v1', name: 'v1', date: stamp, note: '', fileName: '示例美化.zip' }]
  })
  return TOUR_DEMO_IDS
}

export function stopTourDemo() {
  for (const k of ['characters', 'worldbooks', 'presets', 'themes', 'others']) {
    const arr = store.items[k]
    if (!Array.isArray(arr)) continue
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] && arr[i].demoTour) arr.splice(i, 1)
    }
  }
  if (String(store.currentId || '').indexOf('tour-demo-') === 0) store.currentId = null
  if (Array.isArray(store.selected) && store.selected.length) {
    store.selected = store.selected.filter((id) => String(id).indexOf('tour-demo-') !== 0)
  }
  store.selectMode = false
  dropTourDemoImportRows()
}

/* ---------------- DC：批量静默抓标题 ---------------- */

export function dcConcurrency() {
  const n = Number(store.settings.dcConcurrency)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.round(n), 1), 10) : 3
}

/**
 * 后台静默批量抓 DC 标题（不开可见浏览器窗口）
 * @param {string[]} urls
 */
export async function probeDcTitles(urls) {
  // 清洗 + 校验后再交给主进程：Electron 的 net 请求头要求 Latin-1，
  // 混入 U+FFFD / 零宽 / 全角符号会直接抛 ByteString 异常
  const out = []
  const clean = []
  for (const raw of urls || []) {
    const u = cleanUrl(raw)
    const ck = checkUrl(u)
    if (!ck.ok) {
      out.push({ url: u, ok: false, reason: 'BAD_LINK', error: ck.error })
      continue
    }
    if (!clean.includes(ck.url)) clean.push(ck.url)
  }
  if (!clean.length) return out
  if (!api()?.probeDcMany) {
    return [...out, ...clean.map((url) => ({ url, ok: false, reason: 'NO_BRIDGE' }))]
  }
  const r = await api().probeDcMany({
    urls: clean,
    concurrency: dcConcurrency()
  })
  return [...out, ...((r && r.list) || [])]
}

/**
 * 检查更新：优先走可并发的批量抓取
 * @param {'all'|'current'|'selected'} scope
 * @param {{silent?: boolean}} [opt] silent=true 时不弹任何结果提示（启动自动检查用，
 *   有更新只靠顶栏角标/条目角标这类既有非阻塞方式体现，错误一律不打扰）
 */
export async function runUpdateCheckFast(scope = 'all', opt = {}) {
  const silent = opt.silent === true
  if (store.check.running) return
  // 记住这次用的检查方式，下次点复合按钮主体时沿用（启动自动检查不改用户的这个偏好）
  if (!silent && ['all', 'current', 'selected'].includes(scope)) store.settings.checkScope = scope
  let list = []
  if (scope === 'current') list = store.items[store.tab] || []
  else if (scope === 'selected') list = selectedItems.value
  else list = allItems.value

  const targets = list.filter((it) => it.dc?.url && !isBlacklisted(it))
  const skipped = list.length - targets.length
  if (!targets.length) {
    if (!silent) showToast(skipped ? `没有可检查的条目，跳过 ${skipped} 条` : '当前范围内没有填了 DC 链接的条目')
    return
  }
  store.check = { running: true, scope, total: targets.length, done: 0, lastAt: store.check.lastAt }

  const urlMap = new Map()
  for (const it of targets) {
    const u = dcOf(it).url
    if (!urlMap.has(u)) urlMap.set(u, [])
    urlMap.get(u).push(it)
  }

  let updated = 0
  let baselined = 0
  const errors = {}

  // 分批并发
  const urls = Array.from(urlMap.keys())
  const batch = Math.max(dcConcurrency(), 1)
  for (let i = 0; i < urls.length; i += batch) {
    const chunk = urls.slice(i, i + batch)
    const res = await probeDcTitles(chunk)
    for (const r of res) {
      const items = urlMap.get(r.url) || []
      for (const it of items) {
        const dc = dcOf(it)
        if (!r.ok) {
          const key = r.reason || 'ERROR'
          errors[key] = (errors[key] || 0) + 1
          continue
        }
        const cur = String(r.title || '').trim()
        const base = String(dc.title || '').trim()
        if (!base) {
          dc.title = cur
          dc.titleAt = todayStr()
          dc.hasUpdate = false
          baselined++
        } else {
          dc.latestTitle = cur
          dc.hasUpdate = cur !== base
          if (dc.hasUpdate) updated++
        }
        dc.lastCheckAt = nowStr()
        store.check.done++
      }
    }
    store.check.done = Math.min(store.check.done, targets.length)
  }
  store.check.done = targets.length
  store.check.running = false
  store.check.lastAt = nowStr()

  /* 启动自动检查：一条提示都不弹，有更新靠角标体现，出错也不打扰 */
  if (silent) return

  const parts = [`检查完成：${targets.length} 条，${updated} 条有更新`]
  if (baselined) parts.push(`${baselined} 条已记录基准标题`)
  if (skipped) parts.push(`跳过 ${skipped} 条`)
  const errKeys = Object.keys(errors)
  if (errKeys.length) {
    const txt = {
      NEED_TOKEN: '需要登录 Discord 才能读帖子',
      BROWSER_FAIL: '浏览器没抓到内容',
      BAD_LINK: '链接格式不对',
      EMPTY: '帖子里没有文本',
      NO_BRIDGE: '浏览器预览模式',
      NETWORK: '网络不可用',
    }
    parts.push(errKeys.map((k) => `${txt[k] || k} ${errors[k]} 条`).join('，'))
  }
  showToast(parts.join('，'))
}

/* ---------------- 启动时自动检查一次 DC 更新 ---------------- */

/* 模块级标记：App 卸载重挂 / 视图重建都不会让本次启动内的检查跑第二次 */
let dcAutoCheckStarted = false

/**
 * 每次启动软件自动检查一次 DC 更新（用完即止，不做「今天查过就跳过」的缓存）。
 * - 走的是右上角「检查更新」同一套 runUpdateCheckFast('all')，结果呈现完全一致；
 * - silent：不弹提示、不打断，有更新只靠顶栏/条目角标这类既有非阻塞方式告知；
 * - 未登录 / 没有 token、桥接缺失、网络异常、库为空：一律直接跳过并静默返回。
 */
export async function autoCheckDcUpdatesOnStart() {
  if (dcAutoCheckStarted) return { ok: true, skipped: 'ONCE' }
  dcAutoCheckStarted = true
  try {
    const a = api()
    if (!a?.probeDcMany) return { ok: true, skipped: 'NO_BRIDGE' }
    const list = allItems.value || []
    if (!list.some((it) => it.dc?.url && !isBlacklisted(it))) return { ok: true, skipped: 'NO_TARGET' }
    /* 没有登录态就别发请求：DC 读帖必须有账号 token，否则只会拿到一串 NEED_TOKEN */
    if (a.dcTokenStatus) {
      let has = false
      try {
        const t = await a.dcTokenStatus()
        has = !!(t && t.ok && t.has)
      } catch (_) {
        has = false
      }
      if (!has) return { ok: true, skipped: 'NO_TOKEN' }
    }
    await runUpdateCheckFast('all', { silent: true })
    return { ok: true }
  } catch (e) {
    /* 启动路径上绝不因为检查失败冒泡：静默吃掉，只留一条本地 debug 线索 */
    try { console.debug('[dc auto check] skipped', e && e.message) } catch (_) {}
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/* ---------------- 批量导出源文件 / 批量推到酒馆 ---------------- */

async function exportOneToDir(item, ver, dir) {
  const a = api()
  if (!a?.writeNamed) return { ok: false, error: '请在桌面版里操作' }
  const cat = catOf(item)
  const ext = EXT_BY_CAT[cat] || 'json'
  const suffix = ver && ver.name && ver.name !== item.name ? ` - ${safeName(ver.name)}` : ''
  const base = `${safeName(item.name)}${suffix}`

  if (cat === 'characters') {
    const c = await loadVersionContent(ver, item)
    if (!c.buffer) return { ok: false, error: '没有原始角色卡文件' }
    return (await a.writeNamed({ dir, name: `${base}.${ext}`, buffer: c.buffer })) || { ok: false }
  }
  if (cat === 'themes') {
    /* 与单条导出一致：美化成酒馆能直接导入的主题 json，不吐 css */
    let theme = themeJsonOf(ver, item)
    if (!theme) {
      await ensureVersionRaw(item, ver)
      theme = themeJsonOf(ver, item)
    }
    if (!theme) return { ok: false, error: '没有可导出的内容' }
    return (await a.writeNamed({ dir, name: `${base}.json`, text: JSON.stringify(theme, null, 2) })) || { ok: false }
  }
  const json = ver?.raw
  if (!json) return { ok: false, error: '没有可导出的内容' }
  return (await a.writeNamed({ dir, name: `${base}.${ext}`, text: JSON.stringify(json, null, 2) })) || { ok: false }
}

/** 批量导出：只选一次目录，逐个写源文件 */
export async function exportSourceFiles(items) {
  const list = (items || []).filter(Boolean)
  if (!list.length) return { ok: false }
  const a = api()
  if (!a?.pickDir) {
    showToast('请在桌面版里操作')
    return { ok: false }
  }
  const dir = await a.pickDir({ title: '批量导出到哪里', defaultPath: store.settings.exportDir || store.settings.backupLastDir })
  if (!dir) return { ok: false, canceled: true }
  store.settings.exportDir = dir
  saveSettings()

  let ok = 0
  const fails = []
  for (const it of list) {
    const ver = bestVersionOf(it) || (it.versions || [])[0] || null
    const r = await exportOneToDir(it, ver, dir)
    if (r.ok) ok++
    else fails.push(it.name)
  }
  showToast(`导出完成：成功 ${ok} 个${fails.length ? `，失败 ${fails.length} 个：${fails.slice(0, 3).join('、')}` : ''}`)
  return { ok: true, dir, okCount: ok, fails }
}

/** 批量在酒馆里新建（重名也建一份新的） */
export async function batchPushNew(items, opt = {}) {
  const list = (items || []).filter((x) => x && catOf(x))
  if (!list.length) {
    showToast('选中的里面没有可导入的条目')
    return { ok: false }
  }
  if (!store.stStatus.connected) await checkStConnection()
  let ok = 0
  const fails = []
  for (const it of list) {
    /* 显式挑最新版传下去：pushItemToTavern 已不允许「不传 version」，统一在这里补 */
    const v = bestVersionOf(it) || (it.versions || [])[0] || null
    const r = await pushItemToTavern(it, {
      mode: 'new',
      version: v,
      replaceWorld: opt.replaceWorld === true,
      backupOldWorld: !!opt.backupOldWorld
    })
    if (r.ok) ok++
    else fails.push(it.name)
  }
  showToast(`已在酒馆新建 ${ok} 个${fails.length ? `，失败 ${fails.length} 份` : ''}`)
  return { ok: true, okCount: ok, fails }
}

/* ---------------- 世界书备份文件夹（「其他」里的角色名文件夹） ---------------- */

export function openWbFolder(item) {
  store.wbFolder = { visible: true, id: item.id, name: item.name }
}

export function closeWbFolder() {
  store.wbFolder.visible = false
}

/** 按 id 取回「其他」里的备份文件夹条目（保证是响应式同一个对象） */
export function wbFolderById(id) {
  return (store.items.others || []).find((x) => x.id === id) || null
}

/** 备份文件夹里再加一条（供弹层手动记录） */
export function addWorldBackupRecord(folder, worldName, data, note) {
  if (!folder) return null
  if (!Array.isArray(folder.backups)) folder.backups = []
  const day = new Date().toISOString().slice(0, 10)
  const rec = {
    id: nextId('wb'),
    worldName: String(worldName || folder.name),
    date: day,
    at: nowStr(),
    note: note || '手动备份',
    entries: data && data.entries ? Object.keys(data.entries).length : 0,
    data
  }
  folder.backups.unshift(rec)
  folder.updatedAt = day
  return rec
}

/** 把某条备份导出成 JSON 文件（文件名用角色名，不用乱码名） */
export async function exportWorldBackupFile(item, rec) {
  const a = api()
  if (!a?.pickDir) return showToast('请在桌面版里操作')
  const dir = await a.pickDir({ title: '导出世界书备份', defaultPath: store.settings.backupLastDir || '' })
  if (!dir) return
  const name = safeName(`${item.name} 世界书 ${rec.date}${rec.note ? ' ' + rec.note : ''}`) + '.json'
  const r = await a.writeNamed({ dir, name, text: JSON.stringify(rec.data, null, 2) })
  if (r?.ok) showToast('已导出：' + r.path)
  else showToast('导出失败：' + ((r && r.error) || '未知错误'))
}

export function deleteWorldBackup(item, rec) {
  const folder = worldBackupFolder(item)
  folder.backups = (folder.backups || []).filter((x) => x.id !== rec.id)
  /* 立即落盘：深度 watch 是 400ms 防抖，删完马上关窗口就会把这次删除吞掉，
     表现为「删掉的备份重新打开软件又回来了」。 */
  saveItems()
  return folder.backups.length
}

/**
 * 把酒馆里当前正在用的世界书抓一份存到这个角色的备份里
 * （有人会在酒馆里直接改世界书，改完的版本需要单独留存）
 */
export async function pullTavernWorldbook(item) {
  const a = api()
  if (!a?.stScanWorlds || !a?.readFile) return showToast('请在桌面版里操作')
  const r = await a.stScanWorlds({ tavernPath: store.settings.tavernPath, user: store.settings.stUser })
  if (!r || !r.ok) return showToast('读不到酒馆世界书：' + ((r && r.error) || '检查设置里的酒馆路径'))
  const list = r.list || []
  const want = String(item.name || '').trim()
  const exact = list.find((x) => x.name === want)
  const fuzzy = list.find((x) => x.name.includes(want) || want.includes(x.name))
  const target = exact || fuzzy
  if (!target) return showToast(`酒馆里没找到「${want}」的世界书`)
  const txt = await a.readFile(target.path)
  if (!txt || !txt.ok) return showToast('读取世界书失败：' + ((txt && txt.error) || ''))
  let data = null
  try { data = JSON.parse(txt.data) } catch (_) { return showToast('这个世界书不是标准 JSON，读不了') }
  const rec = saveWorldBackup(item, target.name, data, '来自酒馆当前版本')
  return rec
}

// 世界书备份相关状态（「其他」里点开文件夹时用）
store.wbFolder = { visible: false, id: '', name: '' }

/* 调试出口：仅本地验收脚本使用，不影响界面逻辑 */
if (typeof window !== 'undefined') window.__TLS = { store, tavernImportedPaths, tagKeyOf }
