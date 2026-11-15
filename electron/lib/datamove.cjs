/* 数据目录整库搬迁（纯 Node，不依赖 electron，便于单测）
 *
 * 一个「数据目录」里除了索引文件，还有三个仓库：
 *   images/<imgId>.bin          封面源图（按内容哈希命名，来自酒馆卡片）
 *   raw/<itemId>__<verId>.json  条目版本原始内容（不可再生，丢了就没了）
 *   thumbs/<imgId>.webp         缩略图缓存（可再生，顺手带上省一次重建）
 *
 * 关键约定：
 *   1. 只负责「复制 + 校验」，不负责改指针（datadir.json 由调用方在校验通过后写），
 *      这样中途失败时旧目录继续可用，绝不会出现「指向半个库」的白图状态。
 *   2. 索引 / 凭据这类小文件强制覆盖（目标已有则先备份再覆盖）；
 *      三个仓库按哈希 / 版本命名，同名即同内容，目标已存在就跳过，不重复搬。
 *   3. 复制前算总字节并检查目标盘可用空间，空间不足直接拒绝，不做半截事。
 */
const fs = require('fs')
const fsp = fs.promises
const path = require('path')

const DEFAULT_DIRS = [
  { name: 'images', required: true },
  { name: 'raw', required: true },
  { name: 'thumbs', required: false }
]

/** 递归列出目录下所有文件（含大小），目录不存在时返回空数组 */
async function listFilesDeep(root) {
  const out = []
  const walk = async (dir) => {
    let ents = []
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true })
    } catch (_) {
      return
    }
    for (const e of ents) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full)
      } else if (e.isFile()) {
        try {
          const st = await fsp.stat(full)
          out.push({ path: full, size: st.size })
        } catch (_) {}
      }
    }
  }
  await walk(root)
  return out
}

function fileSizeOf(p) {
  try {
    return fs.statSync(p).size
  } catch (_) {
    return 0
  }
}

function freeBytesOf(dir) {
  try {
    const st = fs.statfsSync(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch (_) {
    return null
  }
}

const fmtMB = (n) => (Number(n || 0) / 1048576).toFixed(1) + ' MB'

/**
 * 把 srcDir 的数据整库复制到 dstDir，并校验复制结果。
 * @param {string} srcDir 当前数据目录（绝对路径）
 * @param {string} dstDir 目标数据目录（绝对路径，需已存在且可写）
 * @param {{files?:string[], dirs?:{name:string,required:boolean}[], onProgress?:(p:object)=>void, backupStamp?:string}} opt
 * @returns {Promise<{ok:boolean, error?:string, files:number, bytes:number, skipped:number, backedUp:string, dirs:string[], totalBytes:number}>}
 */
async function migrateDataDir(srcDir, dstDir, opt = {}) {
  const files = Array.isArray(opt.files) && opt.files.length ? opt.files : ['library.json', 'dc-token.bin']
  const dirs = Array.isArray(opt.dirs) && opt.dirs.length ? opt.dirs : DEFAULT_DIRS
  const onProgress = typeof opt.onProgress === 'function' ? opt.onProgress : null
  const send = (p) => {
    try {
      onProgress?.(p)
    } catch (_) {}
  }

  const result = { ok: false, files: 0, bytes: 0, skipped: 0, backedUp: '', dirs: [], totalBytes: 0 }

  /* 1) 目标目录已经有一份索引：先备份，别把那边原有的资料库冲掉 */
  const dstIndex = path.join(dstDir, files[0])
  if (fs.existsSync(dstIndex)) {
    const stamp = String(opt.backupStamp || new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14))
    const bak = dstIndex + '.bak-' + stamp
    try {
      fs.copyFileSync(dstIndex, bak)
      result.backedUp = bak
    } catch (_) {}
  }

  /* 2) 生成任务清单 */
  const tasks = []
  for (const name of files) {
    const src = path.join(srcDir, name)
    if (!fs.existsSync(src)) continue
    tasks.push({ from: src, to: path.join(dstDir, name), size: fileSizeOf(src), required: name === files[0], force: true, group: name })
  }
  for (const d of dirs) {
    const src = path.join(srcDir, d.name)
    if (!fs.existsSync(src)) continue
    const list = await listFilesDeep(src)
    for (const f of list) {
      tasks.push({
        from: f.path,
        to: path.join(dstDir, d.name, path.relative(src, f.path)),
        size: f.size,
        required: d.required !== false,
        force: false,
        group: d.name
      })
    }
    result.dirs.push(d.name)
  }

  const totalBytes = tasks.reduce((a, t) => a + (t.size || 0), 0)
  result.totalBytes = totalBytes

  /* 3) 空间检查：留 5% + 8MB 余量 */
  const need = Math.round(totalBytes * 1.05) + 8 * 1024 * 1024
  const free = freeBytesOf(dstDir)
  if (free !== null && free < need) {
    result.error = `目标盘空间不够：需要约 ${fmtMB(totalBytes)}，可用 ${fmtMB(free)}，请换位置或先清理`
    return result
  }

  /* 4) 复制（索引 / 凭据强制覆盖，仓库跳过同名文件） */
  send({ phase: 'start', done: 0, total: tasks.length, totalBytes })
  let copied = 0
  let copiedBytes = 0
  let skipped = 0
  let done = 0
  let lastEmit = 0
  const failed = []
  for (const t of tasks) {
    try {
      await fsp.mkdir(path.dirname(t.to), { recursive: true })
      if (!t.force && fs.existsSync(t.to)) {
        skipped++
      } else {
        await fsp.copyFile(t.from, t.to)
        copied++
        copiedBytes += t.size || 0
      }
    } catch (e) {
      if (t.required) failed.push(t.group + '/' + path.basename(t.from) + '：' + String((e && e.message) || e))
    }
    done++
    const now = Date.now()
    if (now - lastEmit > 150 || done === tasks.length) {
      lastEmit = now
      send({ phase: 'copy', done, total: tasks.length, bytes: copiedBytes, totalBytes })
    }
  }
  if (failed.length) {
    result.error = '数据复制失败（数据位置未改动，仍用原目录）：' + failed.slice(0, 3).join(' ｜ ')
    return result
  }

  /* 5) 校验：源里有的，目标必须也有；数量对不上就不切指针 */
  send({ phase: 'verify', done: tasks.length, total: tasks.length, bytes: copiedBytes, totalBytes })
  const missing = []
  for (const name of files) {
    if (fs.existsSync(path.join(srcDir, name)) && !fs.existsSync(path.join(dstDir, name))) missing.push(name)
  }
  for (const d of dirs) {
    const srcPath = path.join(srcDir, d.name)
    if (!fs.existsSync(srcPath)) continue
    const srcCount = (await listFilesDeep(srcPath)).length
    const dstCount = (await listFilesDeep(path.join(dstDir, d.name))).length
    if (dstCount < srcCount) missing.push(`${d.name}（源 ${srcCount} / 目标 ${dstCount}）`)
  }
  if (missing.length) {
    result.error = '复制后校验未通过（数据位置未改动，仍用原目录）：' + missing.join('、')
    return result
  }

  send({ phase: 'done', done: 1, total: 1 })
  return { ...result, ok: true, files: copied, bytes: copiedBytes, skipped }
}

module.exports = { migrateDataDir, listFilesDeep, fileSizeOf, freeBytesOf, fmtMB, DEFAULT_DIRS }
