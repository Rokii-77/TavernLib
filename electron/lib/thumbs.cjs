/* 封面缩略图缓存
 *
 * - 源图：<userData>/images/<hash>.bin（已有图片仓库，内容哈希去重）
 * - 缩略图：<userData>/thumbs/<hash>.webp（约 200px 宽，单张 8~20KB）
 *
 * 分工：
 *   1) 主进程 nativeImage 负责解码 + 缩放（原生代码，不占渲染进程主线程）
 *   2) webp 编码放在一个隐藏的编码窗口（独立渲染进程，不阻塞界面线程）
 *   3) 生成走后台队列，限并发、逐张让出事件循环，界面可继续操作
 *   4) 渲染层只用 thumb://local/<hash>.webp 这种稳定 URL 引用，不再传大段 dataURL
 */
const path = require('node:path')
const fs = require('node:fs')
const { app, nativeImage, BrowserWindow } = require('electron')

const THUMB_WIDTH = 200
const THUMB_QUALITY = 0.82
const MAX_CONCURRENCY = 3
/** 单张缩略图生成的硬超时（解码 + 编码 + 落盘），超时即放弃这一张，队列继续跑 */
const GENERATE_TIMEOUT = 12000
/** 界面来请求时最多等这么久，等不到就直接给原图，保证封面不会一直空着 */
const READ_WAIT = 3500
const HASH_RE = /^[0-9a-z]{8,64}$/

const imageDir = () => path.join(app.getPath('userData'), 'images')
let thumbDirCache = ''
function thumbDir() {
  if (!thumbDirCache) {
    thumbDirCache = path.join(app.getPath('userData'), 'thumbs')
    fs.mkdirSync(thumbDirCache, { recursive: true })
  }
  return thumbDirCache
}
const thumbPath = (hash) => path.join(thumbDir(), hash + '.webp')

/** 缩略图文件是否真的可用：0 字节 / 只写了一半 / 头不对的文件一律算缺失，删掉重建。
 *  否则一次异常退出留下的坏文件会被永久当成"已生成"，封面就一直是白的。 */
function isValidThumbFile(p) {
  try {
    const st = fs.statSync(p)
    if (!st.isFile() || st.size < 64) return false
    const fd = fs.openSync(p, 'r')
    let head = null
    try {
      const b = Buffer.alloc(16)
      fs.readSync(fd, b, 0, 16, 0)
      head = b
    } finally {
      fs.closeSync(fd)
    }
    if (!head) return false
    const isWebp = head.slice(0, 4).toString('latin1') === 'RIFF' && head.slice(8, 12).toString('latin1') === 'WEBP'
    const isJpg = head[0] === 0xff && head[1] === 0xd8
    return isWebp || isJpg
  } catch (_) {
    return false
  }
}

function hasThumb(hash) {
  if (!HASH_RE.test(String(hash || ''))) return false
  let p = ''
  try {
    p = thumbPath(hash)
  } catch (_) {
    return false
  }
  if (isValidThumbFile(p)) return true
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p)
  } catch (_) {}
  return false
}

function sniffMime(buf) {
  if (!buf || !buf.length) return 'application/octet-stream'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf[9] === 0x45) return 'image/webp'
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif'
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
  return 'image/webp'
}

/* ---------------- 隐藏编码窗口（独立渲染进程，只做 webp 编码） ---------------- */

let encoderWin = null
let encoderReady = null

function shutdownEncoder() {
  try {
    if (encoderWin && !encoderWin.isDestroyed()) encoderWin.destroy()
  } catch (_) {}
  encoderWin = null
  encoderReady = null
}

function getEncoder() {
  if (encoderWin && !encoderWin.isDestroyed()) return Promise.resolve(encoderWin)
  if (encoderReady) return encoderReady
  encoderReady = (async () => {
    const w = new BrowserWindow({
      show: false,
      width: 64,
      height: 64,
      skipTaskbar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false
      }
    })
    w.on('closed', () => {
      if (encoderWin === w) {
        encoderWin = null
        encoderReady = null
      }
    })
    /* 编码窗口一旦崩溃或无响应，必须把缓存的 ready 一起清掉：
     * 否则后面的请求全会打到这个废窗口上，executeJavaScript 永不给结果，
     * 生成队列会被卡死（界面表现就是封面成片变白）。 */
    try {
      w.webContents.on('render-process-gone', () => {
        if (encoderWin === w) shutdownEncoder()
      })
      w.webContents.on('unresponsive', () => {
        if (encoderWin === w) shutdownEncoder()
      })
    } catch (_) {}
    await w.loadURL('about:blank')
    encoderWin = w
    return w
  })().catch((e) => {
    encoderReady = null
    throw e
  })
  return encoderReady
}

const ENCODE_JS = (b64) => `(async () => {
  try {
    const blob = await (await fetch('data:image/png;base64,${b64}')).blob()
    const bmp = await createImageBitmap(blob)
    const cvs = new OffscreenCanvas(bmp.width, bmp.height)
    const g = cvs.getContext('2d')
    g.drawImage(bmp, 0, 0)
    const out = await cvs.convertToBlob({ type: 'image/webp', quality: ${THUMB_QUALITY} })
    if (!out || out.type !== 'image/webp') return ''
    const u = new Uint8Array(await out.arrayBuffer())
    let s = ''
    const CH = 0x8000
    for (let i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, u.subarray(i, i + CH))
    return btoa(s)
  } catch (_) {
    return ''
  }
})()`

/** 单张 webp 编码的超时上限：编码窗口卡住时立刻放弃并重建，不让队列跟着停摆 */
const ENCODE_TIMEOUT = 4000

async function encodeWebp(pngBuffer) {
  let w = null
  try {
    w = await getEncoder()
  } catch (_) {
    return null
  }
  if (!w || w.isDestroyed() || !w.webContents || w.webContents.isDestroyed()) {
    shutdownEncoder()
    return null
  }
  const b64 = pngBuffer.toString('base64')
  let timer = null
  try {
    const res = await Promise.race([
      w.webContents.executeJavaScript(ENCODE_JS(b64), true),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error('ENCODE_TIMEOUT')), ENCODE_TIMEOUT)
      })
    ])
    if (!res) return null
    const buf = Buffer.from(String(res), 'base64')
    return buf.length ? buf : null
  } catch (_) {
    /* 超时 / 窗口已死：干掉编码窗口，下一张自动重建；本次走 nativeImage 兜底 */
    shutdownEncoder()
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/* ---------------- 生成单张缩略图 ---------------- */

async function generate(hash) {
  const h = String(hash || '')
  if (!HASH_RE.test(h)) return { ok: false, error: 'BAD_HASH' }
  const target = thumbPath(h)
  if (isValidThumbFile(target)) return { ok: true, cached: true, size: 0 }

  const src = path.join(imageDir(), h + '.bin')
  if (!fs.existsSync(src)) return { ok: false, error: 'SRC_NOT_FOUND' }

  let img = null
  try {
    img = nativeImage.createFromBuffer(fs.readFileSync(src))
  } catch (_) {
    img = null
  }
  if (!img || img.isEmpty()) return { ok: false, error: 'DECODE_FAILED' }

  try {
    const sz = img.getSize()
    if (sz.width > THUMB_WIDTH) img = img.resize({ width: THUMB_WIDTH, quality: 'good' })
  } catch (_) {}

  let bytes = null
  try {
    bytes = await encodeWebp(img.toPNG())
  } catch (_) {
    bytes = null
  }
  // 编码窗口不可用时退回 nativeImage 的 jpeg 编码（体积同样是 8~20KB 量级）
  if (!bytes) {
    try {
      bytes = img.toJPEG(82)
    } catch (_) {
      bytes = null
    }
  }
  if (!bytes || !bytes.length) return { ok: false, error: 'ENCODE_FAILED' }
  /* 落盘前再验一次头部：编码窗口偶尔会回半截数据，直接写就会留下一个
   * 看着存在、解码却是空的坏文件（封面白块来源之一） */
  const headOK =
    (bytes.slice(0, 4).toString('latin1') === 'RIFF' && bytes.slice(8, 12).toString('latin1') === 'WEBP') ||
    (bytes[0] === 0xff && bytes[1] === 0xd8)
  if (!headOK) return { ok: false, error: 'BAD_OUTPUT' }

  /* 先写临时文件再改名：中途被杀进程也不会留下半个缩略图 */
  const tmp = target + '.tmp'
  try {
    fs.writeFileSync(tmp, bytes)
    fs.renameSync(tmp, target)
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch (_) {}
    return { ok: false, error: String((e && e.message) || e) }
  }
  return { ok: true, size: bytes.length }
}

/* ---------------- 后台队列（限并发 + 让出事件循环） ---------------- */

const queue = []
const queued = new Set()
const waiting = new Map()
let active = 0

function pump() {
  while (active < MAX_CONCURRENCY && queue.length) {
    const h = queue.shift()
    queued.delete(h)
    active++
    const waiters = waiting.get(h) || []
    waiting.delete(h)
    /* 单张生成最多占用一个并发位这么久：万一底层解码/编码卡住，
     * 也要把并发位还回来，不能让整个队列停摆（封面成片白的直接原因） */
    Promise.race([
      generate(h).catch(() => ({ ok: false })),
      new Promise((res) => setTimeout(() => res({ ok: false, error: 'GENERATE_TIMEOUT' }), GENERATE_TIMEOUT))
    ])
      .then((r) => {
        for (const fn of waiters) fn(r)
      })
      .finally(() => {
        active--
        setImmediate(pump)
      })
  }
}

/** 后台排队生成；front=true 插队（界面正在请求的那张优先） */
function schedule(hash, front = false) {
  const h = String(hash || '')
  if (!HASH_RE.test(h)) return
  if (queued.has(h) || hasThumb(h)) return
  queued.add(h)
  if (front) queue.unshift(h)
  else queue.push(h)
  if (active < MAX_CONCURRENCY) pump()
}

/** 等某一张生成完成（叠加在后台队列上，不重复生成） */
function ensure(hash) {
  const h = String(hash || '')
  if (!HASH_RE.test(h)) return Promise.resolve({ ok: false, error: 'BAD_HASH' })
  if (hasThumb(h)) return Promise.resolve({ ok: true, cached: true })
  return new Promise((resolve) => {
    const list = waiting.get(h) || []
    list.push(resolve)
    waiting.set(h, list)
    schedule(h, true)
  })
}

/** 批量入队（后台静默，不阻塞调用方） */
function prefetch(hashes) {
  let n = 0
  for (const h of Array.isArray(hashes) ? hashes : []) {
    const s = String(h || '')
    if (!HASH_RE.test(s) || hasThumb(s) || queued.has(s)) continue
    schedule(s, false)
    n++
  }
  return n
}

/** 交给自定义协议 thumb://local/<hash>.webp 读取（缺图时现场生成，失败退回原图） */
async function readThumb(hash) {
  const h = String(hash || '')
  if (!HASH_RE.test(h)) return null
  const target = thumbPath(h)
  if (!isValidThumbFile(target)) {
    /* 等生成，但只等一小会儿：队列再慢也不能让封面请求一直挂着，
     * 等不到就先拿原图顶上，缩略图生成好后下次刷新自然会用上 */
    try {
      await Promise.race([ensure(h), new Promise((res) => setTimeout(res, READ_WAIT))])
    } catch (_) {}
  }
  try {
    if (isValidThumbFile(target)) {
      const buf = fs.readFileSync(target)
      return { buf, mime: sniffMime(buf) }
    }
  } catch (_) {}
  // 兜底：缩略图没生成出来就直接把原图给界面，封面不会变空白
  try {
    const src = path.join(imageDir(), h + '.bin')
    if (fs.existsSync(src)) {
      const buf = fs.readFileSync(src)
      return { buf, mime: sniffMime(buf) }
    }
  } catch (_) {}
  return null
}

function stat(hashes) {
  const have = []
  const miss = []
  for (const h of Array.isArray(hashes) ? hashes : []) {
    const s = String(h || '')
    if (!HASH_RE.test(s)) continue
    ;(hasThumb(s) ? have : miss).push(s)
  }
  return { have, miss }
}

module.exports = {
  THUMB_WIDTH,
  hasThumb,
  schedule,
  ensure,
  prefetch,
  readThumb,
  stat,
  shutdownEncoder
}
