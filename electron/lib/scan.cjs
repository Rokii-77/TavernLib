'use strict'
/* 自动扫描目录：找出可导入的候选文件（默认不递归子目录） */

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_EXTS = ['png', 'json', 'zip', 'charx', 'byaf']

function normExt(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '')
  return m ? m[1].toLowerCase() : ''
}

/**
 * @param {string} dir
 * @param {{exts?: string[], recursive?: boolean, max?: number}} opts
 * @returns {{ok:boolean, dir:string, list:Array, error?:string}}
 */
function scanDir(dir, opts = {}) {
  const exts = new Set((opts.exts && opts.exts.length ? opts.exts : DEFAULT_EXTS).map((e) => String(e).toLowerCase()))
  const recursive = !!opts.recursive
  const max = Number(opts.max) || 4000
  const out = []
  const root = String(dir || '')
  if (!root || !fs.existsSync(root)) return { ok: false, dir: root, list: [], error: '目录不存在：' + root }

  const walk = (cur, depth) => {
    if (out.length >= max) return
    let names = []
    try { names = fs.readdirSync(cur) } catch (_) { return }
    for (const name of names) {
      if (out.length >= max) return
      if (name.startsWith('.')) continue
      const full = path.join(cur, name)
      let st = null
      try { st = fs.statSync(full) } catch (_) { continue }
      if (st.isDirectory()) {
        if (recursive && depth < 3) walk(full, depth + 1)
        continue
      }
      if (!st.isFile()) continue
      const ext = normExt(name)
      if (!exts.has(ext)) continue
      const ctime = st.birthtimeMs || st.ctimeMs
      const mtime = st.mtimeMs
      // 默认日期取"创建时间 / 修改时间"里较早的那个
      const dateMs = Math.min(ctime, mtime)
      const d = new Date(dateMs)
      const pad = (n) => String(n).padStart(2, '0')
      out.push({
        path: full,
        name,
        base: name.replace(/\.[a-z0-9]+$/i, ''),
        ext,
        size: st.size,
        ctime,
        mtime,
        date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      })
    }
  }

  walk(root, 0)
  out.sort((a, b) => b.mtime - a.mtime)
  return { ok: true, dir: root, list: out }
}

/** 文件指纹：路径 + 大小 + 修改时间（用于"已导入/已忽略"去重） */
function fileKey(f) {
  return `${String(f.path || '').toLowerCase()}|${f.size || 0}|${Math.round(f.mtime || 0)}`
}

module.exports = { scanDir, fileKey, DEFAULT_EXTS }
