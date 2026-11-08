const { app, BrowserWindow, ipcMain, dialog, shell, protocol } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const fsp = fs.promises
const { execFileSync } = require('node:child_process')
const pngLib = require('./lib/png.cjs')
const stLib = require('./lib/st.cjs')
const scanLib = require('./lib/scan.cjs')
const bridge = require('./lib/bridge.cjs')
const diag = require('./lib/diag.cjs')
const dc = require('./lib/dc.cjs')
const thumbs = require('./lib/thumbs.cjs')
const digestLib = require('./lib/digest.cjs')
const tc = require('./lib/transcode.cjs') // 图片魔数 / 转码参数判定（单独成模块以便单测）
require('./updater.cjs') // 应用内更新：下载 + 静默安装 + 自动重启（注册 up:* IPC）
const crashlog = require('./lib/crashlog.cjs') // 崩溃/报错记录：自动落盘 + 30 天清理

/* 封面缩略图走自定义协议 thumb://local/<hash>.webp 直接给界面，
 * 不再把图片当 dataURL 塞进渲染进程，URL 也就稳定了（同一张图永远同一个地址）。
 * 自定义协议必须在 ready 之前登记权限。 */
const THUMB_SCHEME = 'thumb'
protocol.registerSchemesAsPrivileged([
  {
    scheme: THUMB_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
  }
])

/* ---------------- 可自定义的软件数据保存目录 ----------------
 * 引导配置固定放在默认位置（%APPDATA%\tavern-lib\datadir.json），
 * 这样即使数据目录被换到别处，下次启动仍能找回配置，不会「丢库」。
 * app.setPath('userData') 必须在 ready 之前调用。 */
/* 启动耗时诊断：TAVERNLIB_BOOTTIME=1 时在主进程 stdout 打出各阶段时间点 */
const __BOOT_T0 = Date.now()
const __boot = (label) => {
  if (process.env.TAVERLIB_BOOTTIME || process.env.TAVERNLIB_BOOTTIME) {
    console.log('[boot]', label, Date.now() - __BOOT_T0 + 'ms')
  }
  /* 冷启动卡顿排查：设了 TAVERNLIB_BOOTLOG 就把各节点耗时追加落盘，
     免去抢 GUI 进程 stdout（Start-Process 拿不到它的控制台输出） */
  const logFile = process.env.TAVERNLIB_BOOTLOG
  if (logFile) {
    try {
      fs.appendFileSync(logFile, label + '\t' + (Date.now() - __BOOT_T0) + '\t' + new Date().toISOString() + '\n')
    } catch (_) {}
  }
}
__boot('main-start')

const LIB_FILE = 'library.json'

/* 改名「洛书匣」后 productName 变了，Electron 默认的 userData 也会跟着变成
 * %APPDATA%\洛书匣 —— 老用户打开就是空库。这里显式把 userData 钉回原来的目录
 * （优先取已经有 library.json 的那一个），资料库 / 设置 / 图片仓库都原地不动。 */
const APP_DATA_ROOT = app.getPath('appData')
const LEGACY_DATA_DIRS = [
  path.join(APP_DATA_ROOT, 'tavern-lib'),
  path.join(APP_DATA_ROOT, 'TavernLib')
]

function pickLegacyDataDir() {
  const hasLib = (d) => fs.existsSync(path.join(d, LIB_FILE))
  return LEGACY_DATA_DIRS.find(hasLib) || LEGACY_DATA_DIRS.find((d) => fs.existsSync(d)) || LEGACY_DATA_DIRS[0]
}

const DEFAULT_DATA_DIR = pickLegacyDataDir()
if (DEFAULT_DATA_DIR !== app.getPath('userData')) {
  try {
    fs.mkdirSync(DEFAULT_DATA_DIR, { recursive: true })
    app.setPath('userData', DEFAULT_DATA_DIR)
  } catch (_) {}
}

const BOOT_FILE = path.join(APP_DATA_ROOT, 'tavern-lib', 'datadir.json')

function readBootDir() {
  try {
    const j = JSON.parse(fs.readFileSync(BOOT_FILE, 'utf8'))
    return j && typeof j.dataDir === 'string' ? j.dataDir.trim() : ''
  } catch (_) {
    return ''
  }
}

function writeBootDir(dataDir) {
  try {
    if (!dataDir) {
      if (fs.existsSync(BOOT_FILE)) fs.unlinkSync(BOOT_FILE)
      return true
    }
    fs.mkdirSync(path.dirname(BOOT_FILE), { recursive: true })
    fs.writeFileSync(BOOT_FILE, JSON.stringify({ dataDir }, null, 2), 'utf8')
    return true
  } catch (_) {
    return false
  }
}

const bootDataDir = readBootDir()
let activeDataDir = DEFAULT_DATA_DIR
if (bootDataDir) {
  try {
    fs.mkdirSync(bootDataDir, { recursive: true })
    app.setPath('userData', bootDataDir)
    activeDataDir = bootDataDir
  } catch (_) {
    activeDataDir = DEFAULT_DATA_DIR
  }
}

const isDev = !app.isPackaged
const DEV_URL = process.env.VITE_DEV_URL || 'http://localhost:5199'
const FORCE_DIST = process.env.FORCE_DIST === '1'
const SNAPSHOT_OUT = process.env.SNAPSHOT_OUT || ''
const EVAL_FILE = process.env.TAVERNLIB_EVAL || ''
// 双击启动时默认加载已构建好的 dist；仅当显式设置 VITE_DEV_URL 才走本地开发服务器
const useDevServer = isDev && !FORCE_DIST && !!process.env.VITE_DEV_URL

let win = null

/** 自动化验收钩子：设置 SNAPSHOT_OUT 后，页面加载完成即执行 TAVERNLIB_EVAL 指向的脚本，
 *  结果写入 SNAPSHOT_OUT 指定的 JSON 文件并退出。默认不启用，仅本地调试用。 */
async function runSnapshot() {
  let data = { ok: true, result: null }
  try {
    const body = EVAL_FILE ? fs.readFileSync(EVAL_FILE, 'utf8') : 'return { note: "no eval file" }'
    const result = await win.webContents.executeJavaScript(`(async () => { ${body} })()`, true)
    data.result = result
  } catch (e) {
    data = { ok: false, error: String((e && e.message) || e) }
  }
  try {
    fs.writeFileSync(SNAPSHOT_OUT, JSON.stringify(data, null, 2), 'utf8')
  } catch (_) {}
  const shot = process.env.TAVERNLIB_SHOT || ''
  if (shot) {
    try {
      const img = await win.webContents.capturePage()
      fs.writeFileSync(shot, img.toPNG())
    } catch (_) {}
  }
  setTimeout(() => app.quit(), 200)
}

function createWindow() {
  __boot('createWindow')
  /* 窗口 / 任务栏图标：用项目自带的图标文件（打包后仍在 electron/assets 里） */
  const winIcon = path.join(__dirname, 'assets', 'icon.png')
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#111317',
    autoHideMenuBar: true,
    title: '洛书匣',
    /* 无边框：Windows 原生标题栏不跟随主题、也不吃页面自定义 CSS。
       去掉它，顶栏改由页面内的 .topbar 充当（自己的 DOM，主题与 CSS 都能直接作用），
       最小化 / 最大化 / 关闭 三个按钮在 .topbar 里自绘。 */
    frame: false,
    ...(fs.existsSync(winIcon) ? { icon: winIcon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      /* 酒馆状态靠定时探测刷新；窗口失焦/最小化时若被节流，用户切回来看到的还是旧状态，
         只能靠重启资料库兜底。关掉节流让 6s 一次的探测照常跑。 */
      backgroundThrottling: false
    }
  })

  // 崩溃 / 黑屏现场采集（仅 TAVERNLIB_DIAG 设置时生效）
  try { diag.attachWindow(win) } catch (_) {}

  if (useDevServer) {
    win.loadURL(DEV_URL)
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  __boot('loadFile-called')
  }

  win.webContents.once('did-finish-load', () => __boot('did-finish-load'))
  win.webContents.on('dom-ready', () => __boot('dom-ready'))

  // 自绘标题栏按钮：最大化状态变化时通知渲染层换图标
  const pushMaxState = () => {
    try { if (win && !win.isDestroyed()) win.webContents.send('win:maxChanged', win.isMaximized()) } catch (_) {}
  }
  win.on('maximize', pushMaxState)
  win.on('unmaximize', pushMaxState)
  win.on('enter-full-screen', pushMaxState)
  win.on('leave-full-screen', pushMaxState)

  if (SNAPSHOT_OUT) {
    win.webContents.once('did-finish-load', runSnapshot)
  }

  // 隐藏的 webp 编码窗口不参与「关窗即退出」，主窗口关掉时一起销毁
  win.on('closed', () => {
    try { thumbs.shutdownEncoder() } catch (_) {}
    win = null
  })
}

app.whenReady().then(() => {
  __boot('app-ready')
  // 崩溃现场采集开关（TAVERNLIB_DIAG）
  try {
    diag.init()
    diag.attachProcessHooks()
  } catch (_) {}
  /* 崩溃与报错记录：写到 <数据目录>/crash-logs，启动清一次 30 天前的，之后每天清一次
     只记录不拦截，任何失败都不影响软件启动 */
  try {
    crashlog.init(path.join(app.getPath('userData'), 'crash-logs'), { version: app.getVersion() })
    crashlog.attach({ version: app.getVersion() })
    crashlog.attachApp(app)
    setInterval(() => {
      try {
        crashlog.cleanupOld(30)
      } catch (_) {}
    }, 24 * 3600 * 1000).unref?.()
  } catch (_) {}
  // 本机通知桥：负责「卡更新后让酒馆界面静默刷新」+ 接收酒馆上报的「当前在用卡片/版本」
  // 端口 7799-7809 自动顺延；全部占用时启动失败，错误记在 bridge.status() 里，不静默当成功
  try {
    bridge
      .start()
      .then((r) => {
        if (!r || !r.ok) console.warn('[bridge] ' + ((r && r.error) || '通知桥启动失败'))
      })
      .catch((e) => console.warn('[bridge] ' + (e && e.message ? e.message : e)))
  } catch (e) {
    console.warn('[bridge] ' + (e && e.message ? e.message : e))
  }
  // 封面缩略图协议：命中缓存直接读盘，缺图现场生成（失败退回原图，封面不会空白）
  try {
    protocol.handle(THUMB_SCHEME, async (request) => {
      try {
        const u = new URL(request.url)
        const name = decodeURIComponent(u.pathname || '').replace(/^\/+/, '').replace(/\.webp$/i, '')
        const r = await thumbs.readThumb(name)
        if (!r) return new Response('not found', { status: 404 })
        return new Response(r.buf, {
          headers: {
            'content-type': r.mime,
            'cache-control': 'public, max-age=31536000, immutable'
          }
        })
      } catch (e) {
        return new Response('err', { status: 500 })
      }
    })
  } catch (_) {}
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/* ---------------- 主进程能力：为后续接入酒馆 API / 备份做底座 ---------------- */

/**
 * 链接清洗：从网页 / 聊天窗口复制来的链接常带 U+FFFD 替换字符、零宽字符、控制符、
 * 全角符号。这些字符进入 fetch / net 的 URL 或请求头时会抛
 * "Cannot convert argument to a ByteString because the character at index N ..."。
 * 统一在进网络层前剔除，并把非 ASCII 的路径部分做 percent-encode。
 */
function sanitizeUrl(input) {
  let s = String(input == null ? '' : input)
  s = s
    .replace(/\uFFFD/g, '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u200B-\u200F\u2028\u2029\uFEFF]/g, '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\u3000\u00A0]/g, ' ')
    .trim()
  if (/[^\x20-\x7E]/.test(s)) {
    try {
      s = encodeURI(decodeURI(s))
    } catch (_) {
      s = encodeURI(s)
    }
  }
  return s
}

/** 校验成可安全交给网络层的 http(s) 链接 */
function safeHttpUrl(raw) {
  const s = sanitizeUrl(raw)
  if (!s) return { ok: false, error: '链接是空的' }
  if (!/^https?:\/\//i.test(s)) return { ok: false, error: '链接需要以 http(s):// 开头' }
  if (/[^\x21-\x7E]/.test(s)) return { ok: false, error: '链接里含无法识别的字符，请重新复制一次链接' }
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: '只支持 http(s) 链接' }
    return { ok: true, url: u.toString() }
  } catch (_) {
    return { ok: false, error: '链接格式不对' }
  }
}

/** 请求头只保留 Latin-1 可表示的值，非法字符直接剔除 */
function safeHeaders(headers) {
  const out = {}
  if (!headers || typeof headers !== 'object') return out
  for (const k of Object.keys(headers)) {
    const key = String(k)
    if (!/^[A-Za-z0-9-]+$/.test(key)) continue
    let v = String(headers[k] == null ? '' : headers[k])
    if (/[^\x20-\x7E]/.test(v)) v = v.replace(/[^\x09\x20-\x7E]/g, '')
    out[key] = v
  }
  return out
}

// 通用 HTTP 代理（绕过浏览器 CORS，直连本地酒馆）
ipcMain.handle('net:fetch', async (_e, { url, method = 'GET', headers = {}, body = null }) => {
  try {
    const ck = safeHttpUrl(url)
    if (!ck.ok) return { ok: false, status: 0, error: ck.error }
    const res = await fetch(ck.url, {
      method,
      headers: safeHeaders(headers),
      body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    })
    const text = await res.text()
    let data = text
    try { data = JSON.parse(text) } catch (_) {}
    return { ok: res.ok, status: res.status, data }
  } catch (err) {
    return { ok: false, status: 0, error: String(err && err.message ? err.message : err) }
  }
})

// 选择已有备份 zip
ipcMain.handle('dialog:openBackup', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择备份文件',
    filters: [{ name: 'ZIP 备份', extensions: ['zip'] }],
    properties: ['openFile']
  })
  if (r.canceled || !r.filePaths.length) return null
  return r.filePaths[0]
})

// 保存备份 zip
// dir 有值且 silent=true：直接存到该目录（不弹窗，同名自动加序号）
// 否则弹系统保存对话框，dir 作为默认起始目录
ipcMain.handle('dialog:saveBackup', async (_e, arg) => {
  const name = typeof arg === 'string' ? arg : (arg && arg.name) || ''
  const dir = typeof arg === 'object' && arg ? String(arg.dir || '').trim() : ''
  const silent = !!(arg && typeof arg === 'object' && arg.silent)
  const fileName = name || `tavern-backup-${Date.now()}.zip`

  if (dir && silent) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      let target = path.join(dir, fileName)
      if (fs.existsSync(target)) {
        const ext = path.extname(fileName)
        const stem = path.basename(fileName, ext)
        let n = 2
        while (fs.existsSync(target) && n < 1000) {
          target = path.join(dir, `${stem}-${n}${ext}`)
          n++
        }
      }
      return target
    } catch (e) {
      return null
    }
  }

  let defaultPath = fileName
  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      defaultPath = path.join(dir, defaultPath)
    } catch (_) {}
  }
  const r = await dialog.showSaveDialog(win, {
    title: '保存备份',
    defaultPath,
    filters: [{ name: 'ZIP 备份', extensions: ['zip'] }]
  })
  if (r.canceled || !r.filePath) return null
  return r.filePath
})

// 在资源管理器里定位文件 / 打开目录（备份目录用）
ipcMain.handle('shell:reveal', async (_e, { target, isDir } = {}) => {
  try {
    const p = String(target || '').trim()
    if (!p) return { ok: false, error: '路径为空' }
    if (isDir) {
      fs.mkdirSync(p, { recursive: true })
      const r = await shell.openPath(p)
      return r ? { ok: false, error: r } : { ok: true }
    }
    shell.showItemInFolder(p)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
})

ipcMain.handle('fs:readFile', async (_e, p) => {
  try { return { ok: true, data: fs.readFileSync(p, 'utf-8') } }
  catch (e) { return { ok: false, error: String(e.message) } }
})

// 写二进制文件（ZIP 备份落盘）
/* 备份写盘：支持分片追加（append）。几百 MB 的备份如果一次性同步写，
   主进程会被按住不放，窗口整块不重绘 —— 渲染端按 8MB 分片过来，这里异步落盘 */
ipcMain.handle('fs:writeBuffer', async (_e, filePath, buffer, opt) => {
  try {
    if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'INVALID_PATH' }
    const append = !!(opt && typeof opt === 'object' && opt.append)
    const buf = Buffer.from(buffer)
    if (append) await fsp.appendFile(filePath, buf)
    else await fsp.writeFile(filePath, buf)
    const st = await fsp.stat(filePath)
    return { ok: true, size: st.size }
  } catch (e) {
    return { ok: false, error: String(e.message) }
  }
})

ipcMain.handle('shell:openExternal', async (_e, url) => {
  if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
})

/* ---------------- Discord 标题探测 ----------------
 * 链接形如 https://discord.com/channels/{guild_id}/{channel_id}[/{message_id}]
 * 统一走后台隐藏浏览器抓页面上第一个可见文本行作为「帖子标题」（不需要任何 Token）
 */
function parseDcLink(url) {
  const m = String(url || '').match(/discord(?:app)?\.com\/channels\/(\d+)\/(\d+)(?:\/(\d+))?/i)
  if (!m) return null
  return { guildId: m[1], channelId: m[2], messageId: m[3] || '' }
}

ipcMain.handle('dc:probe', async (_e, { url }) => {
  const ids = parseDcLink(url)
  if (!ids) {
    return { ok: false, reason: 'BAD_LINK', error: '链接格式不对，应形如 discord.com/channels/服务器/频道' }
  }
  const r = await dc.probeOne(url, { timeout: 15000 })
  return r.ok
    ? { ok: true, title: r.title, reason: 'TOKEN' }
    : { ok: false, reason: r.reason || 'TOKEN_FAIL', error: r.error }
})

/* ---------------- 自绘标题栏（无边框窗口） ---------------- */
ipcMain.handle('win:minimize', async () => {
  try { if (win && !win.isDestroyed()) win.minimize() } catch (_) {}
  return { ok: true }
})
ipcMain.handle('win:toggleMax', async () => {
  try {
    if (!win || win.isDestroyed()) return { ok: false }
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return { ok: true, maximized: win.isMaximized() }
  } catch (_) {
    return { ok: false }
  }
})
ipcMain.handle('win:close', async () => {
  try { if (win && !win.isDestroyed()) win.close() } catch (_) {}
  return { ok: true }
})
ipcMain.handle('win:isMax', async () => {
  try { return { ok: true, maximized: !!win && !win.isDestroyed() && win.isMaximized() } } catch (_) { return { ok: false, maximized: false } }
})

ipcMain.handle('app:info', async () => ({
  version: app.getVersion(),
  platform: process.platform,
  electron: process.versions.electron,
  author: 'Roki',
  name: '洛书匣'
}))

/* ================= 酒馆端口自动识别 =================
 * 从酒馆目录下的 config.yaml 读 port，推导 http://127.0.0.1:端口，
 * 用户不用再手填 URL；文件缺失时返回 ok:false 让界面回退到手动值。 */
function tavernConfigCandidates(tavernPath) {
  const root = String(tavernPath || '').trim()
  const list = []
  if (!root) return list
  list.push(path.join(root, 'config.yaml'))
  list.push(path.join(root, 'default', 'config.yaml'))
  return list
}

function parseYamlScalar(text, key) {
  const re = new RegExp('^\\s*' + key + '\\s*:\\s*(.+?)\\s*(#.*)?$', 'm')
  const m = re.exec(text)
  if (!m) return ''
  return String(m[1]).replace(/^['"]|['"]$/g, '').trim()
}

ipcMain.handle('st:configInfo', async (_e, { tavernPath } = {}) => {
  const root = String(tavernPath || '').trim()
  if (!root) return { ok: false, error: 'NO_TAVERN_PATH' }
  for (const p of tavernConfigCandidates(root)) {
    try {
      if (!fs.existsSync(p)) continue
      const text = fs.readFileSync(p, 'utf8')
      const port = parseInt(parseYamlScalar(text, 'port'), 10)
      const whitelist = parseYamlScalar(text, 'whitelistMode')
      const protocol = 'http'
      const host = '127.0.0.1'
      const safePort = Number.isFinite(port) && port > 0 ? port : 8000
      return {
        ok: true,
        path: p,
        port: safePort,
        host,
        url: `${protocol}://${host}:${safePort}`,
        fromFile: Number.isFinite(port) && port > 0,
        whitelistMode: whitelist
      }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }
  return { ok: false, error: 'NO_CONFIG', port: 8000, host: '127.0.0.1', url: 'http://127.0.0.1:8000' }
})

/* ================= 软件数据保存目录 + 数据快照 ================= */
// 资料库条目与设置除了 localStorage，还额外落一份 library.json 到数据目录，
// 这样把数据目录换到别的盘也能把库带走。

const libPath = () => path.join(app.getPath('userData'), LIB_FILE)

ipcMain.handle('data:info', async () => {
  const dir = app.getPath('userData')
  return {
    ok: true,
    dir,
    defaultDir: DEFAULT_DATA_DIR,
    custom: dir !== DEFAULT_DATA_DIR,
    hasSnapshot: fs.existsSync(libPath())
  }
})

ipcMain.handle('data:saveLibrary', async (_e, text) => {
  try {
    const p = libPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, String(text == null ? '' : text), 'utf8')
    return { ok: true, path: p }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
})

ipcMain.handle('data:loadLibrary', async () => {
  try {
    const p = libPath()
    if (!fs.existsSync(p)) return { ok: false, error: 'NO_SNAPSHOT' }
    return { ok: true, text: fs.readFileSync(p, 'utf8') }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
})

/* ---- 侧车文件（版本原始内容 / 世界书备份）----
 * 版本书里的 raw 与世界书备份的整本内容原本都塞在 library.json 里，
 * 库涨到 60MB 后每次启动读盘、每次保存写盘都要搬这一坨，是书架卡顿的直接原因。
 * 这里把它们挪到 数据目录/raw、数据目录/backups 下按需读写，library.json 只留索引。 */
const SIDECAR_SUBS = new Set(['raw', 'backups'])

function sidecarPath(sub, name) {
  const s = String(sub || '')
  if (!SIDECAR_SUBS.has(s)) return null
  const base = String(name || '').replace(/[\\/:*?"<>|]/g, '_')
  if (!base) return null
  const dir = path.join(app.getPath('userData'), s)
  const full = path.join(dir, base)
  const root = path.resolve(app.getPath('userData'))
  if (!path.resolve(full).startsWith(root + path.sep)) return null
  return full
}

ipcMain.handle('data:putFile', async (_e, { sub, name, text } = {}) => {
  try {
    const p = sidecarPath(sub, name)
    if (!p) return { ok: false, error: 'BAD_PATH' }
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const body = String(text == null ? '' : text)
    fs.writeFileSync(p, body, 'utf8')
    return { ok: true, path: p, size: Buffer.byteLength(body) }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
})

ipcMain.handle('data:readFile', async (_e, { sub, name } = {}) => {
  try {
    const p = sidecarPath(sub, name)
    if (!p) return { ok: false, error: 'BAD_PATH' }
    if (!fs.existsSync(p)) return { ok: false, error: 'NOT_FOUND' }
    const st = fs.statSync(p)
    return { ok: true, text: fs.readFileSync(p, 'utf8'), size: st.size, path: p }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
})

ipcMain.handle('data:removeFile', async (_e, { sub, name } = {}) => {
  try {
    const p = sidecarPath(sub, name)
    if (!p) return { ok: false, error: 'BAD_PATH' }
    if (fs.existsSync(p)) fs.unlinkSync(p)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
})

ipcMain.handle('data:listFiles', async (_e, { sub } = {}) => {
  try {
    const p = sidecarPath(sub, 'x')
    if (!p) return { ok: false, error: 'BAD_PATH', list: [] }
    const dir = path.dirname(p)
    if (!fs.existsSync(dir)) return { ok: true, list: [] }
    const list = fs.readdirSync(dir).map((f) => {
      let size = 0
      try { size = fs.statSync(path.join(dir, f)).size } catch (_) {}
      return { name: f, size }
    })
    return { ok: true, list }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), list: [] }
  }
})

/** 切换数据保存目录：写引导配置（重启生效），并把快照 / token 复制到新目录 */
ipcMain.handle('data:setDir', async (_e, { dir, migrate = true } = {}) => {
  const want = String(dir || '').trim()
  let target = ''
  if (want) {
    try {
      target = path.resolve(want)
    } catch (_) {
      return { ok: false, error: '路径不合法' }
    }
    if (!path.isAbsolute(target)) return { ok: false, error: '请选一个绝对路径' }
    if (/^[a-z]:\\(windows|program files|program files \(x86\)|programdata)(\\|$)/i.test(target)) {
      return { ok: false, error: '不能放在系统目录里，请换一个普通文件夹' }
    }
    try {
      fs.mkdirSync(target, { recursive: true })
      const probe = path.join(target, '.tavernlib-write-test')
      fs.writeFileSync(probe, 'ok')
      fs.unlinkSync(probe)
    } catch (e) {
      return { ok: false, error: '这个目录不可写：' + String((e && e.message) || e) }
    }
  }

  const cur = app.getPath('userData')
  const same = !!target && path.resolve(target) === path.resolve(cur)
  if (!writeBootDir(target === path.resolve(DEFAULT_DATA_DIR) ? '' : target)) {
    return { ok: false, error: '写配置失败，可能没有权限' }
  }

  const copied = []
  if (migrate && target && !same) {
    for (const f of [LIB_FILE, 'dc-token.bin']) {
      try {
        const src = path.join(cur, f)
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(target, f))
          copied.push(f)
        }
      } catch (_) {}
    }
  }

  return {
    ok: true,
    dir: target || DEFAULT_DATA_DIR,
    same,
    needRestart: !same,
    copied
  }
})

/* ================= 文件系统辅助（供导入 / 导出 / 扫描使用） ================= */

function dateOf(ctime, mtime) {
  const d = new Date(Math.min(ctime || mtime, mtime || ctime))
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

ipcMain.handle('fs:stat', async (_e, paths) => {
  const arr = Array.isArray(paths) ? paths : [paths]
  const out = []
  for (const p of arr) {
    try {
      const s = fs.statSync(p)
      const ctime = s.birthtimeMs || s.ctimeMs
      out.push({ path: p, ok: true, size: s.size, ctime, mtime: s.mtimeMs, date: dateOf(ctime, s.mtimeMs), dir: s.isDirectory() })
    } catch (e) {
      out.push({ path: p, ok: false, error: String(e.message) })
    }
  }
  return Array.isArray(paths) ? out : out[0]
})

ipcMain.handle('fs:exists', async (_e, p) => {
  try { return fs.existsSync(p) } catch (_) { return false }
})

ipcMain.handle('fs:readBuffer', async (_e, p) => {
  try {
    const buf = fs.readFileSync(p)
    return { ok: true, data: new Uint8Array(buf) }
  } catch (e) {
    return { ok: false, error: String(e.message) }
  }
})

ipcMain.handle('fs:readCard', async (_e, p) => {
  return stLib.readCardAt(p)
})

ipcMain.handle('dialog:pickDir', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, {
    title: opts.title || '选择文件夹',
    defaultPath: opts.defaultPath || undefined,
    properties: ['openDirectory', 'createDirectory']
  })
  if (r.canceled || !r.filePaths.length) return null
  return r.filePaths[0]
})

ipcMain.handle('dialog:pickFiles', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, {
    title: opts.title || '选择文件',
    filters: opts.filters || [
      { name: '角色卡 / 数据', extensions: ['png', 'json', 'zip', 'charx', 'byaf'] },
      { name: '全部文件', extensions: ['*'] }
    ],
    properties: ['openFile', 'multiSelections']
  })
  if (r.canceled || !r.filePaths.length) return []
  return r.filePaths
})

/** 把内容写成文件（导出源文件 / 备份世界书） */
ipcMain.handle('fs:writeNamed', async (_e, { dir, name, buffer, base64, text }) => {
  try {
    if (!dir) return { ok: false, error: '没有选择保存位置' }
    fs.mkdirSync(dir, { recursive: true })
    let target = path.join(dir, String(name || 'untitled'))
    if (fs.existsSync(target)) {
      const ext = path.extname(target)
      const base = target.slice(0, target.length - ext.length)
      let i = 1
      while (fs.existsSync(`${base} (${i})${ext}`)) i++
      target = `${base} (${i})${ext}`
    }
    if (buffer) fs.writeFileSync(target, Buffer.from(buffer))
    else if (base64) fs.writeFileSync(target, Buffer.from(base64, 'base64'))
    else fs.writeFileSync(target, String(text == null ? '' : text), 'utf8')
    return { ok: true, path: target }
  } catch (e) {
    return { ok: false, error: String(e.message) }
  }
})

ipcMain.handle('fs:copyTo', async (_e, { src, dir, name }) => {
  try {
    if (!src || !fs.existsSync(src)) return { ok: false, error: '源文件不存在' }
    fs.mkdirSync(dir, { recursive: true })
    let target = path.join(dir, String(name || path.basename(src)))
    if (fs.existsSync(target) && path.resolve(target) !== path.resolve(src)) {
      const ext = path.extname(target)
      const base = target.slice(0, target.length - ext.length)
      let i = 1
      while (fs.existsSync(`${base} (${i})${ext}`)) i++
      target = `${base} (${i})${ext}`
    }
    fs.copyFileSync(src, target)
    return { ok: true, path: target }
  } catch (e) {
    return { ok: false, error: String(e.message) }
  }
})

/* ================= 自动扫描 ================= */

ipcMain.handle('scan:dir', async (_e, opts = {}) => scanLib.scanDir(opts.dir, opts))

/* ================= 酒馆连接状态 ================= */

ipcMain.handle('st:ping', async (_e, { url } = {}) => {
  const base = String(url || 'http://127.0.0.1:8000').replace(/\/+$/, '')
  const t0 = Date.now()
  try {
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), 2500)
    const r = await fetch(base + '/csrf-token', { signal: ctrl.signal })
    clearTimeout(to)
    return { ok: r.ok, status: r.status, ms: Date.now() - t0, url: base }
  } catch (e) {
    return { ok: false, error: String(e.message || e), url: base }
  }
})

ipcMain.handle('st:scanCharacters', async (_e, { tavernPath, user, light, only } = {}) =>
  stLib.scanCharacters(tavernPath, user, { light, only })
)

/* 只给指定的几个文件算内容指纹：进书架/进详情对比「酒馆当前版本」用，不做全库扫描 */
ipcMain.handle('st:probeDigests', async (_e, { kind, files } = {}) =>
  stLib.probeDigests({ kind, files: Array.isArray(files) ? files : [] })
)

ipcMain.handle('st:scanWorlds', async (_e, { tavernPath, user } = {}) => stLib.scanWorlds(tavernPath, user))

ipcMain.handle('st:scanWorldsUnbound', async (_e, { tavernPath, user } = {}) => stLib.scanWorldsUnbound(tavernPath, user))

ipcMain.handle('st:scanPresets', async (_e, { tavernPath, user, includeSamplerPresets } = {}) => stLib.scanPresets(tavernPath, user, { includeSamplerPresets }))

ipcMain.handle('st:scanThemes', async (_e, { tavernPath, user } = {}) => stLib.scanThemes(tavernPath, user))

/** 酒馆自己的 style.css：美化预览要用它当底，选择器才能和酒馆里一致 */
ipcMain.handle('st:uiCss', async (_e, { tavernPath } = {}) => stLib.readUiCss(tavernPath))

/** 酒馆字体图标：把 webfonts/fa-solid-900.woff2 内联成 data URL，预览里图标不依赖 file:// 能否加载 */
ipcMain.handle('st:faFont', async (_e, { tavernPath } = {}) => stLib.readFaFont(tavernPath))

/** 回读美化主题的源文件（老库里没存外观字段时，预览靠它补齐） */
ipcMain.handle('st:themeSrc', async (_e, { tavernPath, user, file, name } = {}) =>
  stLib.readThemeSrc(tavernPath, user, file, name))

/** 酒馆里配套扩展的安装状态（只读） */
ipcMain.handle('st:extStatus', async (_e, { tavernPath, user } = {}) => stLib.extStatus(tavernPath, user))

/** 把随软件打包的扩展一键注入酒馆 extensions 目录 */
ipcMain.handle('st:extInject', async (_e, { tavernPath, user } = {}) => stLib.injectExt(tavernPath, user))

/** 下载一个链接（DC 图片直链等）到临时目录，返回本地路径
 *  注意：Discord 的 ?format=webp 会把 PNG 重新编码，角色卡内嵌的 chara 元数据会丢，
 *  所以带 format/quality 时会自动去掉这些参数再请求一次原图。 */
const isPng = tc.isPng

async function fetchToFile(rawUrl) {
  const ck = safeHttpUrl(rawUrl)
  if (!ck.ok) return { ok: false, error: ck.error, badUrl: true }
  const url = ck.url
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/png,image/*,*/*;q=0.8'
    },
    redirect: 'follow'
  })
  if (!res.ok) return { ok: false, status: res.status, error: 'HTTP ' + res.status }
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) return { ok: false, error: '下载到空文件' }
  return { ok: true, buf }
}

ipcMain.handle('net:download', async (_e, { url } = {}) => {
  try {
    // 先清洗 + 校验：非法字符（U+FFFD、零宽、全角等）在这里就被拦下，
    // 不会以 ByteString 异常的形式抛到界面上
    const ck = safeHttpUrl(url)
    if (!ck.ok) return { ok: false, error: ck.error }
    let u = ck.url

    const isDiscordMedia = tc.isDiscordMedia(u)

    let got = await fetchToFile(u)
    if (!got.ok) {
      return {
        ok: false,
        error: isDiscordMedia
          ? `下载失败（HTTP ${got.status || '?'}）：Discord 附件链接带签名，过期就会失效，请重新复制一条新链接`
          : got.error
      }
    }

    // Discord / 图床的 ?format=webp&width=&height= 会把 PNG 重新编码成缩略图，
    // 内嵌的 tEXt/chara 元数据（角色卡本体）随之丢失，导进来只剩一张空白卡。
    // 只要拿到的不是 PNG，就先去转码参数重下一次原图。
    if (tc.needOriginal(u, got.buf)) {
      for (const t of tc.retryCandidates(u)) {
        const again = await fetchToFile(t)
        if (again.ok && tc.isPng(again.buf)) {
          u = t
          got = again
          break
        }
      }
    }

    let base = 'file'
    try {
      base = decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || 'file')
    } catch (_) {}
    base = base.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
    if (!/\.[a-z0-9]{2,5}$/i.test(base)) base += '.png'

    // 内容其实是 PNG、后缀却写着 .webp/.jpg（图床常见）：按真实类型改名。
    // 否则下游按后缀判断会把它当转码图，解析出空白角色卡。
    if (isPng(got.buf)) base = tc.normalizePngName(base)

    const looksHtml = /^<(!doctype|html|\?xml)/i.test(got.buf.subarray(0, 64).toString('latin1').trim())

    // 拿到的不是 PNG：说明链接给的是转码/压缩过的图（webp、jpeg），角色卡内嵌数据已丢。
    // 直接报清楚原因，别让用户对着一个空白条目猜。
    if (!isPng(got.buf)) {
      if (looksHtml) {
        return { ok: false, error: '这个链接返回的是网页而不是图片，请复制附件本身的直链（右键图片 → 复制图片地址）' }
      }
      const isArchive = /\.(json|zip|charx|byaf)$/i.test(base)
      const kind = tc.imageKind(got.buf)
      const looksImage = !!kind || isDiscordMedia || /\.(png|webp|jpe?g)$/i.test(base)
      if (!isArchive && looksImage) {
        const shown = kind || '非 PNG'
        const hint = isDiscordMedia
          ? '请改用原始附件链接（去掉 &format=...&width=...&height=... 参数），或重新复制一条新链接'
          : '请改用原始图片直链（去掉 format / width / height 这类转码参数），或重新复制一条链接'
        return {
          ok: false,
          error: `这个链接返回的是被转码压缩过的图片（${shown}），角色卡内嵌数据已丢失，导入只会得到一张空白卡；${hint}`
        }
      }
    }

    const dir = path.join(app.getPath('temp'), 'tavernlib-download')
    fs.mkdirSync(dir, { recursive: true })
    let target = path.join(dir, base)
    if (fs.existsSync(target)) target = path.join(dir, Date.now() + '-' + base)
    fs.writeFileSync(target, got.buf)
    return { ok: true, path: target, size: got.buf.length, name: base }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
})

/** 导入到酒馆（新建，同名也新建） */
ipcMain.handle('st:importCard', async (_e, opt = {}) => {
  try {
    const r = stLib.importCard(opt)
    if (r.ok) bridge.notify({ action: 'reload', avatar: r.avatar, name: r.name })
    return r
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

/** 同名卡副本各自的聊天记录统计（前端选择器用；一次问一批 avatar） */
ipcMain.handle('st:chatStats', async (_e, { tavernPath, user, avatars } = {}) => {
  try {
    const dirs = stLib.userDirs(tavernPath, user)
    const out = {}
    for (const a of Array.isArray(avatars) ? avatars : []) {
      if (!a) continue
      out[a] = stLib.chatStatsOf(dirs, a)
    }
    return { ok: true, stats: out }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

/** 更新到酒馆（替换同名卡，聊天记录不变） */
ipcMain.handle('st:replaceCard', async (_e, opt = {}) => {
  try {
    let r = stLib.replaceCard(opt)
    /* 酒馆里有同角色的多份卡（xxx.png / xxx (1).png）时，让用户挑要替换的那一份 */
    if (r && r.needPick && !opt.pickAvatar) {
      const cands = r.candidates || []
      const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB')
      const fmtTime = (t) => {
        const d = new Date(t)
        const p = (x) => String(x).padStart(2, '0')
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
      }
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        title: '酒馆里有多个同名角色卡',
        message: `酒馆里找到 ${cands.length} 份「${r.avatar}」的卡，要替换哪一份？`,
        detail: cands.map((c, i) => {
          const cs = c.chats || { count: 0, total: 0, files: [] }
          const lines = [`${i + 1}. ${c.avatar}.png    ${fmtSize(c.size)}    修改于 ${fmtTime(c.mtime)}`]
          lines.push(
            cs.count
              ? `     聊天记录 ${cs.count} 个，合计 ${fmtSize(cs.total)}`
              : '     聊天记录 0 个（这张没被用过）'
          )
          /* 明细只列最大的 3 个：最常用/最大的存档最能区分，太长会撑爆弹窗 */
          for (const f of cs.files.slice(0, 3)) {
            lines.push(`       · ${f.name}    ${fmtSize(f.size)}`)
          }
          if (cs.count > 3) lines.push(`       · …另有 ${cs.count - 3} 个聊天记录`)
          return lines.join('\n')
        }).join('\n\n'),
        buttons: [...cands.map((c, i) => `${i + 1}. ${c.avatar}.png`), '取消'],
        defaultId: 0,
        cancelId: cands.length,
        noLink: true
      })
      if (response >= cands.length) return { ok: false, canceled: true }
      const pick = cands[response].avatar
      r = stLib.replaceCard({ ...opt, avatar: pick, pickAvatar: pick })
    }
    if (r.ok) bridge.notify({ action: 'reload', avatar: r.avatar, name: r.name })
    return r
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

/** 写入 / 还原世界书 */
ipcMain.handle('st:importWorld', async (_e, opt = {}) => {
  try {
    const r = stLib.importWorld(opt)
    if (r.ok) bridge.notify({ action: 'reload', world: r.name })
    return r
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

/** 写入 / 还原预设（各引擎 Settings 目录里的 json） */
ipcMain.handle('st:importPreset', async (_e, opt = {}) => {
  try {
    const r = stLib.importPreset(opt)
    if (r.ok) bridge.notify({ action: 'reload', preset: r.name })
    return r
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

/** 内容类型未知的「其他」条目：按内容自动选酒馆里合适的位置 */
ipcMain.handle('st:importAny', async (_e, opt = {}) => {
  try {
    const r = stLib.importAny(opt)
    if (r.ok) bridge.notify({ action: 'reload', name: r.name })
    return r
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

/* ---- 侧车直通：渲染进程不解析大 JSON，也不把大对象搬上 IPC ----
 * 「更新到酒馆」崩溃的直接原因：世界书 / 预设版本的原始内容是几十 MB 的 JSON，
 * 旧流程在渲染进程 JSON.parse 出一整个对象，再结构化克隆过 IPC 传给主进程，
 * 同一份内容在三处各存一份，渲染进程峰值内存直接翻几倍 → 黑屏 / 闪退。
 * 这里改成只传侧车文件名，由主进程读盘、解析、写盘，渲染进程只拿「成功/失败」。 */
ipcMain.handle('st:importFromSidecar', async (_e, opt = {}) => {
  try {
    const { sub, name, kind, category } = opt
    const p = sidecarPath(sub, name)
    if (!p) return { ok: false, error: 'BAD_PATH' }
    if (!fs.existsSync(p)) return { ok: false, error: 'NOT_FOUND' }
    const st = fs.statSync(p)
    if (st.size > 256 * 1024 * 1024) return { ok: false, error: 'TOO_LARGE' }
    const text = fs.readFileSync(p, 'utf8')
    let data = null
    try {
      data = JSON.parse(text)
    } catch (e) {
      return { ok: false, error: 'BAD_JSON: ' + String((e && e.message) || e) }
    }
    const payload = { ...opt, data }
    delete payload.sub
    delete payload.name
    delete payload.kind
    delete payload.category
    /* 侧车文件名用完即弃，写进酒馆的显示名另有 itemName 传进来 */
    if (opt.itemName) payload.name = String(opt.itemName)
    delete payload.itemName
    let r
    if (category === 'presets' || kind === 'preset') r = stLib.importPreset(payload)
    else if (category === 'others' || kind === 'any') r = stLib.importAny(payload)
    else r = stLib.importWorld(payload)
    if (r && r.ok) {
      if (category === 'presets' || kind === 'preset') bridge.notify({ action: 'reload', preset: r.name })
      else bridge.notify({ action: 'reload', world: r.name, name: r.name })
    }
    return r
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
})

/** 侧车内容摘要：由主进程算，避免渲染进程为了比对 digest 去 parse 几十 MB JSON */
ipcMain.handle('dataDigest', async (_e, { sub, name, category } = {}) => {
  try {
    const p = sidecarPath(sub, name)
    if (!p) return { ok: false, error: 'BAD_PATH', digest: '' }
    if (!fs.existsSync(p)) return { ok: false, error: 'NOT_FOUND', digest: '' }
    const text = fs.readFileSync(p, 'utf8')
    const data = JSON.parse(text)
    return { ok: true, digest: digestLib.digestOf(String(category || 'characters'), data) }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), digest: '' }
  }
})

/* ================= 图片仓库（内容哈希去重，一张图只存一份） ================= */

const IMG_HASH_RE = /^[0-9a-z]{8,64}$/
const imageDir = () => path.join(app.getPath('userData'), 'images')

ipcMain.handle('img:save', async (_e, { hash, buffer } = {}) => {
  try {
    const h = String(hash || '')
    if (!IMG_HASH_RE.test(h)) return { ok: false, error: 'BAD_HASH' }
    const dir = imageDir()
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, h + '.bin')
    if (!fs.existsSync(target)) fs.writeFileSync(target, Buffer.from(buffer || []))
    return { ok: true, path: target }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

ipcMain.handle('img:read', async (_e, hash) => {
  try {
    const h = String(hash || '')
    if (!IMG_HASH_RE.test(h)) return { ok: false, error: 'BAD_HASH' }
    const target = path.join(imageDir(), h + '.bin')
    if (!fs.existsSync(target)) return { ok: false, error: 'NOT_FOUND' }
    const buf = fs.readFileSync(target)
    let mime = 'image/png'
    if (buf[0] === 0xff && buf[1] === 0xd8) mime = 'image/jpeg'
    else if (buf.slice(0, 4).toString('latin1') === 'GIF8') mime = 'image/gif'
    else if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') mime = 'image/webp'
    else if (buf.slice(0, 2).toString('latin1') === 'BM') mime = 'image/bmp'
    return { ok: true, mime, size: buf.length, data: buf.toString('base64') }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

/* ================= 封面缩略图（thumbs/<hash>.webp，nativeImage + 后台队列） ================= */

/** 批量入队后台生成（静默，界面可继续操作） */
ipcMain.handle('thumb:prefetch', async (_e, hashes) => {
  try {
    return { ok: true, queued: thumbs.prefetch(hashes) }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

/** 等某一张生成完成（命中原图缓存直接返回） */
ipcMain.handle('thumb:ensure', async (_e, hash) => {
  try {
    return await thumbs.ensure(hash)
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

/** 批量查询哪些已经有缩略图 */
ipcMain.handle('thumb:stat', async (_e, hashes) => {
  try {
    return { ok: true, ...thumbs.stat(hashes) }
  } catch (e) {
    return { ok: false, error: String(e.message || e), have: [], miss: [] }
  }
})

/* ================= Discord 批量抓标题 ================= */

ipcMain.handle('dc:probeMany', async (_e, { urls, concurrency, timeout, mode } = {}) => {
  try {
    const list = await dc.probeMany(urls || [], { concurrency, timeout, mode })
    return { ok: true, list }
  } catch (e) {
    return { ok: false, error: String(e.message || e), list: [] }
  }
})

/* 抓取方式 = 账号 token（免登录窗口）：token 只落在本机 userData，加密保存 */
ipcMain.handle('dc:tokenSet', async (_e, { token } = {}) => {
  try {
    return dc.setToken(token)
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

ipcMain.handle('dc:tokenClear', async () => {
  try {
    return dc.clearToken()
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

ipcMain.handle('dc:tokenStatus', async () => {
  try {
    const t = dc.getToken()
    return { ok: true, has: !!t, tail: t ? t.slice(-4) : '' }
  } catch (e) {
    return { ok: false, has: false, error: String(e.message || e) }
  }
})

/* 从本机浏览器的登录态里自动捞 token（用户点一下，免去手贴） */
ipcMain.handle('dc:tokenAuto', async () => {
  try {
    return await dc.autoPickToken()
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

/* 设置面板的“测试抓取”：返回完整诊断，方便定位到底卡在哪一步 */
ipcMain.handle('dc:test', async (_e, { url, mode } = {}) => {
  try {
    const r = await dc.probeOne(url, { mode, timeout: 22000 })
    return Object.assign({ mode: 'token' }, r)
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

/* ================= 本机通知桥（酒馆前端扩展轮询用） ================= */

ipcMain.handle('bridge:status', async () => bridge.status())
ipcMain.handle('bridge:notify', async (_e, payload) => bridge.notify(payload || {}))

/* ================= 崩溃与报错记录（渲染进程上报 + 设置里复制/清理） ================= */
/* 渲染进程的 window.onerror / unhandledrejection 由界面自己捕获后送进来，
   主进程只负责落盘，不让渲染层决定写哪、写多少 */
ipcMain.handle('log:report', async (_e, payload = {}) => {
  const p = payload && typeof payload === 'object' ? payload : { detail: String(payload) }
  return crashlog.record(String(p.category || 'renderer-error').slice(0, 40), p.detail || p.message || '', {
    页面: p.url || '',
    来源: p.source || ''
  })
})

ipcMain.handle('log:list', async () => {
  const files = crashlog.listFiles()
  return {
    ok: true,
    dir: crashlog.dirPath(),
    count: files.length,
    latest: files.length ? { name: files[0].name, path: files[0].path, time: files[0].time, size: files[0].size } : null
  }
})

/* 复制报错：把最新一条记录的全文交给渲染进程写剪贴板 */
ipcMain.handle('log:latest', async () => crashlog.readLatest())

/* 清理历史记录：只删 crash-logs 目录里本软件生成的日志，不碰其它任何文件 */
ipcMain.handle('log:clear', async () => crashlog.clearAll())

/* 复制报错文件：把最新那份 .log 文件本身放进剪贴板（粘到聊天窗口就是一个文件，不是一段文本） */
ipcMain.handle('log:copyFile', async () => {
  const files = crashlog.listFiles()
  const target = files && files.length ? files[0] : null
  if (!target || !target.path) return { ok: false, error: '还没有报错记录' }
  const p = target.path
  if (!fs.existsSync(p)) return { ok: false, error: '文件已不存在' }
  try {
    /* Windows 10 起 Set-Clipboard -Path 支持把文件对象放进剪贴板（等价于资源管理器里 Ctrl+C） */
    const quoted = '"' + String(p).replace(/"/g, '""') + '"'
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Set-Clipboard -LiteralPath ${quoted}`],
      { windowsHide: true, timeout: 8000 }
    )
    return { ok: true, path: p, name: target.name, size: target.size, time: target.time }
  } catch (e) {
    /* 剪贴板失败时兜底：至少单独复制路径，用户能在资源管理器里定位 */
    try {
      const { clipboard } = require('electron')
      clipboard.writeText(p)
      return { ok: true, fallback: 'path', path: p, name: target.name }
    } catch (_) {
      return { ok: false, error: '复制失败：' + String((e && e.message) || e) }
    }
  }
})

ipcMain.handle('log:openDir', async () => {
  const d = crashlog.dirPath()
  if (!d) return { ok: false, error: '还没记录过报错' }
  try {
    await shell.openPath(d)
    return { ok: true, dir: d }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
})

