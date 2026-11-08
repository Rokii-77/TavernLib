/* 图片仓库（内容哈希去重）
 *
 * 设计：
 * - 一张图按「内容」算一个哈希，磁盘上只落一份 <hash>.bin（用户数据目录/images）
 * - 条目 current 版本、每个历史版本只存 imgId（哈希），多版本共用同一张图时共享引用
 * - 渲染时通过 IMG[hash] 拿 dataURL；数据在 index.json 里不再存大段 base64
 */
import { reactive } from 'vue'

export const IMG = reactive({}) // hash -> dataURL（渲染缓存）
const pending = new Map()

const api = () => (typeof window !== 'undefined' ? window.api : null)

/** 与 store 里 sigHash 同一算法（避免循环引用，这里独立一份） */
export function hashText(str) {
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

export function isDataUrl(s) {
  return /^data:image\//i.test(String(s || ''))
}

export function mimeOf(dataUrl) {
  const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)[;,]/.exec(String(dataUrl || ''))
  return m ? m[1].toLowerCase() : 'image/png'
}

export function extOfMime(mime) {
  const m = String(mime || '').toLowerCase()
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg'
  if (m.includes('webp')) return 'webp'
  if (m.includes('gif')) return 'gif'
  if (m.includes('bmp')) return 'bmp'
  return 'png'
}

/** 从二进制头判断图片类型；不是图片返回空 */
export function sniffImageMime(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  if (b.length < 8) return ''
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  const head = String.fromCharCode(b[0], b[1], b[2], b[3])
  if (head === 'GIF8') return 'image/gif'
  if (head === 'RIFF' && String.fromCharCode(b[8], b[9], b[10], b[11]) === 'WEBP') return 'image/webp'
  if (head.startsWith('BM')) return 'image/bmp'
  return ''
}

export function b64Payload(dataUrl) {
  const s = String(dataUrl || '')
  const i = s.indexOf('base64,')
  return i >= 0 ? s.slice(i + 7) : ''
}

export function b64ToBytes(b64) {
  const bin = atob(String(b64 || ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToB64(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < u.length; i += chunk) bin += String.fromCharCode.apply(null, u.subarray(i, i + chunk))
  return btoa(bin)
}

export function bytesToDataUrl(bytes, mime = 'image/png') {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  if (!u.length) return ''
  return `data:${mime};base64,${bytesToB64(u)}`
}

export function urlOf(hash) {
  return hash ? IMG[hash] || '' : ''
}

/** 封面缩略图的稳定 URL（同一张图永远同一个地址，由主进程按需生成/读缓存）
 *  thumb://local/<hash>.webp -> <userData>/thumbs/<hash>.webp */
export function thumbUrl(hash) {
  const h = String(hash || '')
  if (!h) return ''
  return `thumb://local/${h}.webp`
}

/** 把一批封面的缩略图丢给主进程后台生成（静默、分批，不阻塞界面） */
export function prefetchThumbs(hashes) {
  const a = api()
  if (!a?.thumbPrefetch) return
  const list = Array.from(new Set((hashes || []).map((h) => String(h || '')).filter(Boolean)))
  if (!list.length) return
  try {
    a.thumbPrefetch(list)
  } catch (_) {}
}

export function hashOfDataUrl(dataUrl) {
  const b = b64Payload(dataUrl)
  return b ? hashText(b) : ''
}

async function pushToDisk(hash, bytes) {
  const a = api()
  if (!a?.imgSave) return
  try {
    await a.imgSave({ hash, buffer: bytes })
  } catch (_) {}
}

/** 存一张 dataURL 图片，返回内容哈希（同内容只落一份） */
export async function saveImageDataUrl(dataUrl) {
  const b = b64Payload(dataUrl)
  if (!b) return ''
  const mime = mimeOf(dataUrl)
  const h = hashText(b)
  if (!IMG[h]) IMG[h] = `data:${mime};base64,${b}`
  await pushToDisk(h, b64ToBytes(b))
  return h
}

/** 存一张二进制图片，返回内容哈希 */
export async function saveImageBytes(bytes, mime = '') {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  if (!u.length) return ''
  const type = mime || sniffImageMime(u)
  if (!type) return ''
  const b = bytesToB64(u)
  const h = hashText(b)
  if (!IMG[h]) IMG[h] = `data:${type};base64,${b}`
  await pushToDisk(h, u)
  return h
}

export async function ensureImage(hash) {
  if (!hash) return ''
  if (IMG[hash]) return IMG[hash]
  if (pending.has(hash)) return await pending.get(hash)
  const a = api()
  if (!a?.imgRead) return ''
  const task = (async () => {
    try {
      const r = await a.imgRead(hash)
      if (r?.ok && r.data) {
        const u = `data:${r.mime || 'image/png'};base64,${r.data}`
        IMG[hash] = u
        return u
      }
    } catch (_) {}
    return ''
  })()
  pending.set(hash, task)
  const u = await task
  pending.delete(hash)
  return u
}

export function ensureImages(hashes) {
  const list = Array.from(new Set((hashes || []).filter(Boolean))).filter((h) => !IMG[h] && !pending.has(h))
  if (!list.length) return
  // 限并发读盘：一次几百个 IPC 读会把渲染线程拖住，按 6 路并发排队
  const LIMIT = 6
  let cursor = 0
  const worker = async () => {
    while (cursor < list.length) {
      const h = list[cursor++]
      if (IMG[h] || pending.has(h)) continue
      await ensureImage(h)
    }
  }
  for (let i = 0; i < Math.min(LIMIT, list.length); i++) worker()
}

/** 取某张图的原始字节（备份打包用） */
export async function imageBytes(hash) {
  if (!hash) return null
  const url = IMG[hash] || (await ensureImage(hash))
  if (!url) return null
  try {
    return { bytes: b64ToBytes(b64Payload(url)), mime: mimeOf(url) }
  } catch (_) {
    return null
  }
}
