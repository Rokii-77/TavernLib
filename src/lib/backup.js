import JSZip from 'jszip'
import { store } from '../store.js'
import { imageBytes, extOfMime } from './images.js'

/* 完整备份 / 导出 ZIP
   结构：
   manifest.json
   characters/<角色名>/<版本名>.json (+ images.json + images/<hash>.png)
   characters/<角色名>/history/<版本名>.json
   worldbooks/<名称>/<版本名>.json
   presets/<名称>/<版本名>.json
   others/<名称>/<版本名>.json

   图片规则（对应 bug A / 版本级图片）：
   - 每个版本的图片按内容哈希命名落在 images/ 下，同图只打包一份，多版本共用
   - images.json 记录「版本名 → 图片文件」，导入时据此还原每个版本各自的图片
   - 图片放在 images/ 子目录，不会被当成角色卡文件（否则导入后会凭空多出版本）

   保存路径：
   - Electron 运行时：弹系统保存对话框 → 主进程写盘（api.saveBackup + api.writeBuffer）
   - 浏览器预览：走 Blob 下载（功能等价，路径由浏览器决定）
*/

const CAT_LABEL = { characters: '角色卡', worldbooks: '世界书', presets: '预设', themes: '美化', others: '其他' }

/* 备份全程在渲染进程里跑，全套图片几百 MB，必须主动让出主线程，
   否则窗口会整块卡住不重绘（表现为「软件内黑屏」）。 */
const YIELD_EVERY = 4
const WRITE_CHUNK = 8 * 1024 * 1024

function yieldUI() {
  return new Promise((r) => setTimeout(r, 0))
}

function safeName(s) {
  return (
    String(s || 'untitled')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'untitled'
  )
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/** 优先用导入时保留的原始 JSON；没有则按条目元数据合成一份最小卡（带分类标记） */
function payloadOf(it, v) {
  if (v && v.raw && typeof v.raw === 'object') return v.raw
  const data = {
    name: it.name,
    description: it.desc || '',
    tags: Array.isArray(it.tags) ? it.tags : [],
    version: v?.name || it.stVersion || '',
    dc_url: it.dc?.url || '',
    dc_title: it.dc?.title || '',
    updated_at: it.updatedAt || ''
  }
  if (it.category === 'characters') {
    return { spec: 'chara_card_v2', spec_version: '2.0', tavernlib_category: 'characters', data }
  }
  return { tavernlib_category: it.category || 'others', name: it.name, data }
}

function dataUrlToBase64(cover) {
  const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(String(cover || ''))
  if (!m) return null
  const ext = m[1].toLowerCase().replace('jpeg', 'jpg')
  return { ext, b64: m[2] }
}

/** 取一个版本对应的图片二进制（走内容哈希仓库；老数据回落到 dataURL） */
async function imageOfVersion(it, v) {
  const h = (v && v.imgId) || (it.versions || []).find((x) => x.current)?.imgId || it.imgId || ''
  if (h) {
    const r = await imageBytes(h)
    if (r && r.bytes && r.bytes.length) return { hash: h, bytes: r.bytes, ext: extOfMime(r.mime) }
  }
  const raw = (v && v.cover) || it.cover || ''
  const d = dataUrlToBase64(raw)
  if (!d) return null
  const bin = atob(d.b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const hash = (v && v.imgId) || it.imgId || ''
  return { hash: hash || 'raw' + bytes.length, bytes, ext: d.ext }
}

/**
 * 生成备份 Blob
 * @param {Record<string, Array>} itemsByCat
 * @param {{source?: string, onlyIds?: string[]}} opts
 */
export async function buildBackupZip(itemsByCat, opts = {}) {
  const zip = new JSZip()
  const only = opts.onlyIds && opts.onlyIds.length ? new Set(opts.onlyIds) : null
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null
  const report = (p) => {
    try {
      if (onProgress) onProgress(p)
    } catch (_) {}
  }
  let totalItems = 0
  for (const list of Object.values(itemsByCat || {})) {
    totalItems += (list || []).filter((it) => !only || only.has(it.id)).length
  }
  let doneItems = 0
  const manifest = {
    app: 'TavernLib',
    format: 'tavern-lib-backup',
    format_version: 1,
    source: opts.source || 'full',
    created_at: new Date().toISOString(),
    counts: {},
    entries: []
  }

  for (const [cat, list] of Object.entries(itemsByCat || {})) {
    const arr = (list || []).filter((it) => !only || only.has(it.id))
    if (!arr.length) continue
    const folder = zip.folder(cat)
    let n = 0
    for (const it of arr) {
      const versions = it.versions && it.versions.length ? it.versions : [{ name: it.stVersion || 'v1', current: true }]
      const cur = versions.find((v) => v.current) || versions[0]
      const dir = folder.folder(safeName(it.name))
      const imgIndex = { cover: '', versions: {} }
      // 当前版本
      dir.file(`${safeName(cur.name || 'v1')}.json`, JSON.stringify(payloadOf(it, cur), null, 2))
      // 历史版本
      for (const v of versions) {
        if (v === cur) continue
        dir.file(`history/${safeName(v.name || 'v')}.json`, JSON.stringify(payloadOf(it, v), null, 2))
      }
      // 版本图片：按内容哈希命名，同图只打包一份
      for (const v of versions) {
        const img = await imageOfVersion(it, v)
        if (!img) continue
        const name = `images/${img.hash}.${img.ext}`
        if (!dir.file(name)) dir.file(name, img.bytes)
        const vname = safeName(v.name || 'v1')
        imgIndex.versions[vname] = name
        if (v === cur) imgIndex.cover = name
      }
      if (!imgIndex.cover) {
        const any = Object.values(imgIndex.versions)[0]
        if (any) imgIndex.cover = any
      }
      if (Object.keys(imgIndex.versions).length || imgIndex.cover) {
        dir.file('images.json', JSON.stringify({ versions: imgIndex.versions, cover: imgIndex.cover }, null, 2))
      }

      manifest.entries.push({
        category: cat,
        category_label: CAT_LABEL[cat] || cat,
        name: it.name,
        current_version: cur.name || '',
        versions: versions.map((v) => v.name).filter(Boolean),
        dc_url: it.dc?.url || '',
        dc_title: it.dc?.title || '',
        updated_at: it.updatedAt || ''
      })
      n++
      doneItems++
      report({ phase: 'pack', done: doneItems, total: totalItems })
      /* 每几条让出一次主线程：几百张图连续 await 会把渲染线程饿死 */
      if (doneItems % YIELD_EVERY === 0) await yieldUI()
    }
    manifest.counts[cat] = n
  }

  zip.file('manifest.json', JSON.stringify(manifest, null, 2))
  report({ phase: 'zip', percent: 0 })
  const blob = await zip.generateAsync(
    {
      type: 'blob',
      /* 图片本来就是压缩过的（png/webp/jpg），再 DEFLATE 一遍只会把主线程按死几十秒，
         体积几乎不变 —— 直接 STORE，速度快一个量级 */
      compression: 'STORE'
    },
    (meta) => {
      report({ phase: 'zip', percent: Math.round((meta && meta.percent) || 0) })
    }
  )
  return {
    blob,
    manifest,
    count: manifest.entries.length,
    fileName: `tavernlib-${manifest.source === 'full' ? 'backup' : 'export'}-${stamp()}.zip`
  }
}

/**
 * 生成并保存备份
 * @returns {Promise<{saved:boolean, canceled?:boolean, path?:string, count?:number, browser?:boolean, error?:string}>}
 */
export async function exportBackupZip(itemsByCat, opts = {}) {
  const { blob, fileName, count } = await buildBackupZip(itemsByCat, opts)
  if (!count) return { saved: false, error: '没有可备份的条目' }

  const api = typeof window !== 'undefined' ? window.api : null

  if (api && api.saveBackup && api.writeBuffer) {
    // 不单独设备份路径：默认用上次保存过的位置打开，每次都可以自己挑
    const dir = (store.settings.backupLastDir || '').trim()
    const target = await api.saveBackup({ name: fileName, dir, silent: false })
    if (!target) return { saved: false, canceled: true }
    try {
      const sep = target.includes('\\') ? '\\' : '/'
      const d = target.slice(0, target.lastIndexOf(sep))
      if (d) store.settings.backupLastDir = d
    } catch (_) {}
    /* 分片写盘：一次性把几百 MB 转成 Uint8Array 再走 IPC，渲染进程和主进程各留一份
       完整副本，很容易把窗口顶到「未响应」。8MB 一片，写完让出一次事件循环。 */
    const totalBytes = blob.size || 0
    let offset = 0
    let first = true
    if (!totalBytes) {
      const r = await api.writeBuffer(target, new Uint8Array(0), { append: false })
      if (!r || !r.ok) return { saved: false, error: (r && r.error) || '写入失败' }
    }
    while (offset < totalBytes) {
      const end = Math.min(offset + WRITE_CHUNK, totalBytes)
      const buf = new Uint8Array(await blob.slice(offset, end).arrayBuffer())
      const r = await api.writeBuffer(target, buf, { append: !first })
      if (!r || !r.ok) return { saved: false, error: (r && r.error) || '写入失败' }
      first = false
      offset = end
      ;(opts.onProgress || (() => {}))({
        phase: 'write',
        done: offset,
        total: totalBytes,
        percent: totalBytes ? Math.round((offset / totalBytes) * 100) : 100
      })
      await yieldUI()
    }
    return { saved: true, path: target, count }
  }

  // 浏览器预览降级：触发下载
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
  return { saved: true, path: fileName, count, browser: true }
}
