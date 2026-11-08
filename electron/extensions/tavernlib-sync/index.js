/* 洛书匣 · 酒馆实时同步扩展（由洛书匣桌面端联动）
   作用：资料库管理器把角色卡 / 世界书 / 预设导入或替换进酒馆后，这里自动静默刷新对应列表，
        不需要手动刷新页面，也不会打断正在进行的聊天。
   2026-11-08：桥端口改为 7799-7809 自动探测；支持 world / preset 刷新；面板显示扩展版本号。
   1.5.0：轮询失败退避 1.5s→3s→6s 封顶，失败时清端口缓存重新扫 7799-7809，成功立刻回 1.5s。 */

const VERSION = '1.0.0'
const PORT_START = 7799
const PORT_END = 7809
/* 轮询退避：正常 1.5 秒；请求失败依次退到 3 秒、6 秒、12 秒并封顶，成功一次立刻回到 1.5 秒
 * 封顶 12 秒是为了管理器完全关掉时把空转降到最低，同时恢复后最多 12 秒内能接上 */
const POLL_DELAYS = [1500, 3000, 6000, 12000]
const PROBE_MS = 1200
const EXT_KEY = 'tavernlibSync'
const PANEL_URL = '/scripts/extensions/third-party/tavernlib-sync/settings.html'

let lastSeq = null
let busy = false
let bridgePort = 0
let probing = null
let evCache = null
let lastWorldAt = 0
let lastPresetAt = 0
let failCount = 0
let pollTimer = null

function getCtx() {
  try {
    const st = window.SillyTavern
    if (st && typeof st.getContext === 'function') return st.getContext()
  } catch (_) {}
  return null
}

/* ---------- 桥端口探测（7799-7809，命中 app === 'TavernLib' 即采用并缓存） ---------- */
function baseUrl(port) {
  return 'http://127.0.0.1:' + port
}

async function probePort(port) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), PROBE_MS) : null
  try {
    const r = await fetch(baseUrl(port) + '/health', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
    if (timer) clearTimeout(timer)
    if (!r.ok) return false
    const j = await r.json()
    return !!(j && j.app === 'TavernLib')
  } catch (_) {
    if (timer) clearTimeout(timer)
    return false
  }
}

/** 返回可用端口：已有缓存直接用；失败时重新探测（缓存失效） */
async function resolvePort(force) {
  if (!force && bridgePort) return bridgePort
  if (probing) return probing
  probing = (async () => {
    bridgePort = 0
    for (let p = PORT_START; p <= PORT_END; p++) {
      if (await probePort(p)) {
        bridgePort = p
        return p
      }
    }
    return 0
  })()
  try {
    return await probing
  } finally {
    probing = null
  }
}

function dropPort() {
  bridgePort = 0
}

/* ---------- 开关（与酒馆设置一起持久化） ---------- */
function readEnabled() {
  const ctx = getCtx()
  const bag = ctx && ctx.extensionSettings
  const saved = bag && bag[EXT_KEY]
  return !saved || saved.enabled !== false
}

function saveEnabled(value) {
  const ctx = getCtx()
  try {
    if (ctx && ctx.extensionSettings) {
      ctx.extensionSettings[EXT_KEY] = Object.assign({}, ctx.extensionSettings[EXT_KEY], { enabled: !!value })
      if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced()
    }
  } catch (e) {
    console.warn('[洛书匣] 保存开关状态失败', e)
  }
}

/* ---------- 角色列表刷新 ---------- */
async function refreshCharacters() {
  const ctx = getCtx()
  try {
    if (ctx && typeof ctx.getCharacters === 'function') {
      await ctx.getCharacters()
      return
    }
    if (typeof window.getCharacters === 'function') {
      await window.getCharacters()
    }
  } catch (e) {
    console.warn('[洛书匣] 刷新角色列表失败', e)
  }
}

/** 让页面重新拉取头像文件：cache:'reload' 会用服务器新图覆盖浏览器缓存条目，
 *  再给已渲染的 img 打时间戳兜底，避免 React 复用旧 src 时仍显示老图。 */
async function bustAvatarCache(avatar, name) {
  const list = []
  const add = (v) => {
    if (!v) return
    list.push('/characters/' + encodeURIComponent(v))
    list.push('/thumbnail?type=avatar&file=' + encodeURIComponent(v))
  }
  add(avatar)
  if (name) {
    add(/\.png$/i.test(name) ? name : name + '.png')
    add(name)
  }
  for (const u of [...new Set(list)]) {
    try {
      await fetch(u, { cache: 'reload' })
    } catch (_) {}
  }
  const stamp = Date.now()
  document.querySelectorAll('img').forEach((img) => {
    const s = img.getAttribute('src') || ''
    if (!s) return
    if (s.includes('/characters/') || (s.includes('/thumbnail') && s.includes('type=avatar'))) {
      try {
        const u = new URL(s, location.origin)
        u.searchParams.set('_tl', String(stamp))
        img.setAttribute('src', u.toString())
      } catch (_) {}
    }
  })
}

/* ---------- 世界书 / 预设刷新（走酒馆前端事件，事件缺失时降级不报错） ---------- */
async function getEvents() {
  if (evCache) return evCache
  const ctx = getCtx()
  let eventSource = ctx && ctx.eventSource
  let types = (ctx && (ctx.eventTypes || ctx.event_types)) || {}
  try {
    const mod = await import('../../../../script.js')
    if (mod) {
      eventSource = mod.eventSource || eventSource
      types = mod.event_types || types || {}
    }
  } catch (_) {
    // 拿不到模块就用 context 上的，仍拿不到则事件刷新降级为不动
  }
  evCache = { eventSource: eventSource || null, types: types || {} }
  return evCache
}

async function emitEvent(names, arg) {
  const { eventSource, types } = await getEvents()
  if (!eventSource || typeof eventSource.emit !== 'function') return false
  for (const n of names) {
    const type = types[n]
    if (!type) continue
    try {
      await eventSource.emit(type, arg)
      return true
    } catch (e) {
      console.warn('[洛书匣] 触发 ' + n + ' 失败', e)
    }
  }
  return false
}

async function refreshWorldInfo(name) {
  const now = Date.now()
  if (now - lastWorldAt < 500) return
  lastWorldAt = now
  await emitEvent(['WORLDINFO_UPDATED', 'WORLD_INFO_UPDATED'], name || undefined)
}

async function refreshPreset(name) {
  const now = Date.now()
  if (now - lastPresetAt < 500) return
  lastPresetAt = now
  await emitEvent(['PRESET_CHANGED', 'OAI_PRESET_CHANGED_AFTER', 'OAI_PRESET_CHANGED'], name || undefined)
}

/* ---------- 上报「酒馆当前在用哪张卡 / 哪个版本」----------
 * 管理器侧原来只往酒馆推刷新，没有接收端，界面上「正在用哪一版」一直是空的。
 * 现在每轮轮询成功后 POST /state，管理器缓存后在设置页显示；
 * 内容没变时 15 秒才重发一次，避免频繁请求；卡名/版本一变立刻发。
 */
function currentCardInfo() {
  try {
    const c = ctx || {}
    const chars = Array.isArray(c.characters) ? c.characters : []
    let ch = null
    const id = c.characterId
    if (id !== undefined && id !== null && chars[id]) ch = chars[id]
    if (!ch && c.name2) {
      ch = chars.find((x) => x && (x.name === c.name2 || (x.data && x.data.name === c.name2))) || null
    }
    if (!ch) return { name: '', version: '' }
    const d = ch.data || ch
    return { name: d.name || ch.name || '', version: String(d.character_version || ch.character_version || '') }
  } catch (_) {
    return { name: '', version: '' }
  }
}

let lastStateKey = ''
let lastStateAt = 0
async function reportState(port) {
  if (!port) return
  const info = currentCardInfo()
  const key = info.name + '|' + info.version
  const t = Date.now()
  if (key === lastStateKey && t - lastStateAt < 15000) return
  try {
    await fetch(baseUrl(port) + '/state', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: info.name, version: info.version, extVersion: VERSION })
    })
    lastStateKey = key
    lastStateAt = t
  } catch (_) {
    /* 管理器没开就静默跳过，下一轮自然重试 */
  }
}

/* ---------- 轮询通知桥 ----------
 * 返回 true=本轮成功；false=失败（会触发退避 + 清端口缓存重扫）；null=这轮跳过（开关关闭 / 上一轮还没结束）
 */
async function poll() {
  if (busy || !readEnabled()) return null
  busy = true
  try {
    const port = await resolvePort()
    if (!port) return false
    const r = await fetch(baseUrl(port) + '/pending', { cache: 'no-store' })
    if (!r.ok) {
      dropPort()
      return false
    }
    const j = await r.json()
    if (!j || typeof j.seq !== 'number') {
      dropPort()
      return false
    }
    /* 端口通了就顺带把「当前在用哪张卡」报给管理器（内部有节流，不会每轮都发） */
    await reportState(port)
    if (lastSeq === null) {
      lastSeq = j.seq
      return true
    }
    if (j.seq !== lastSeq) {
      lastSeq = j.seq
      if (j.action === 'reload') {
        const hasCard = !!(j.avatar || j.name)
        const hasWorld = !!j.world
        const hasPreset = !!j.preset
        if (hasCard) {
          await bustAvatarCache(j.avatar, j.name)
          await refreshCharacters()
          setTimeout(() => {
            bustAvatarCache(j.avatar, j.name)
          }, 400)
        }
        if (hasWorld) await refreshWorldInfo(j.name || '')
        if (hasPreset) await refreshPreset(j.name || '')
      }
    }
    return true
  } catch (_) {
    // 管理器没开就静默忽略，下次重新探测端口
    dropPort()
    return false
  } finally {
    busy = false
  }
}

/** 失败次数换算成本轮间隔：1.5s → 3s → 6s，封顶 6s */
function pollDelay() {
  return POLL_DELAYS[Math.min(failCount, POLL_DELAYS.length - 1)]
}

function schedulePoll(ms) {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = setTimeout(tick, ms)
}

/** 每轮结束再排下一轮（不用固定 setInterval，失败才能拉长间隔） */
async function tick() {
  let ok = null
  try {
    ok = await poll()
  } catch (_) {
    ok = false
  }
  if (ok === true) failCount = 0
  else if (ok === false) failCount += 1
  schedulePoll(pollDelay())
}

/* ---------- 扩展面板（酒馆标准 inline-drawer 结构） ---------- */
let mounting = false
let statusTimer = null

function panelEl(id) {
  return document.getElementById(id)
}

function paintState(online) {
  const box = panelEl('luoshu-sync-state')
  if (!box) return
  box.classList.toggle('on', !!online)
  box.classList.toggle('off', !online)
  const txt = box.querySelector('.luoshu-sync-text')
  if (txt) txt.textContent = online ? '已连接' : '未连接'
}

function paintVersion() {
  const el = panelEl('luoshu-sync-ver')
  if (el) el.textContent = 'v' + VERSION
}

async function updatePanelStatus() {
  if (!panelEl('luoshu-sync-state')) return
  paintVersion()
  // 开关关闭时不探测，状态保持「未连接」，避免被 5s 定时器覆盖回「已连接」
  if (!readEnabled()) {
    paintState(false)
    return
  }
  const port = await resolvePort(true)
  paintState(!!port)
}

function bindSwitch() {
  const box = panelEl('luoshu-sync-enabled')
  if (!box || box.dataset.luoshuBound) return
  box.dataset.luoshuBound = '1'
  box.checked = readEnabled()
  box.addEventListener('change', () => {
    const on = !!box.checked
    saveEnabled(on)
    if (on) {
      lastSeq = null
      /* 重新打开：清掉退避，立刻按正常节奏跑一轮 */
      failCount = 0
      if (pollTimer) clearTimeout(pollTimer)
      tick()
      updatePanelStatus()
    } else {
      paintState(false)
    }
  })
}

async function mountSettingsPanel() {
  if (mounting) return true
  try {
    const host = panelEl('extensions_settings') || panelEl('extensions_settings2')
    if (!host) return false
    if (panelEl('luoshu-sync-drawer')) {
      bindSwitch()
      paintVersion()
      return true
    }
    mounting = true

    const box = document.createElement('div')
    box.id = 'luoshu-sync-drawer'
    box.className = 'inline-drawer'
    box.innerHTML =
      '' +
      '<div class="inline-drawer-toggle inline-drawer-header">' +
      '<b>洛书匣 · 酒馆实时同步</b>' +
      '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>' +
      '</div>' +
      '<div class="inline-drawer-content"></div>'
    host.appendChild(box)

    const content = box.querySelector('.inline-drawer-content')
    try {
      const r = await fetch(PANEL_URL, { cache: 'no-store' })
      content.innerHTML = r.ok ? await r.text() : ''
    } catch (_) {
      content.innerHTML = ''
    }

    bindSwitch()
    paintVersion()
    updatePanelStatus()
    if (!statusTimer) statusTimer = setInterval(updatePanelStatus, 5000)
    return true
  } catch (e) {
    console.warn('[洛书匣] 扩展面板挂载失败', e)
    return false
  } finally {
    mounting = false
  }
}

if (typeof window !== 'undefined') {
  /* 第一轮稍等酒馆把上下文准备好；之后由 tick 自己排下一轮（失败会退避） */
  schedulePoll(900)

  // 酒馆加载扩展后可能重渲染 #extensions_settings，节点被清掉时自动补挂（幂等）
  const guard = async () => {
    if (!panelEl('luoshu-sync-drawer')) await mountSettingsPanel()
  }
  const start = () => {
    setTimeout(guard, 400)
    setInterval(guard, 2000)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
}
