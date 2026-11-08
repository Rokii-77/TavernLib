'use strict'
/* Discord 帖子标题抓取：只用账号 token 直连 REST（全程无窗口，不使用内置浏览器）

   说明（2026-11 实测）：Discord 网页端登录态存在页面 localStorage（键名 token），
   因此首次使用时从本机浏览器的 Discord 登录数据里读一次 token，加密存到本机 userData。 */

const { net, app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const tokenpick = require('./tokenpick.cjs')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 链接清洗：从网页 / 聊天窗口复制来的帖子链接常带 U+FFFD、零宽字符、全角符号。
 * 这些字符进入 fetch 的 URL / 请求头会抛 ByteString 异常，这里先剔除。
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

function parseDiscordUrl(url) {
  const s = sanitizeUrl(url)
  const m = /discord(?:app)?\.com\/channels\/(\d+)\/(\d+)(?:\/(\d+))?/.exec(s)
  if (m) return { guild: m[1], channel: m[2], message: m[3] || '' }
  /* 附件 / CDN 直链也带着频道与消息 ID：
     https://cdn.discordapp.com/attachments/<channel>/<message>/<file>
     https://cdn.discordapp.com/ephemeral-attachments/<channel>/<message>/<file>
     导入时用户经常只贴文件直链，这里也认出来，才能反查它所在帖子的标题。 */
  const a = /(?:cdn|media)\.discord(?:app)?\.(?:net|com)\/(?:ephemeral-)?attachments\/(\d+)\/(\d+)(?:\/|$)/.exec(s)
  if (a) return { guild: '', channel: a[1], message: a[2], via: 'attachment' }
  return null
}

/* ---------------- 账号 token（可选方案，存本地并加密） ---------------- */

function tokenFile() {
  return path.join(app.getPath('userData'), 'dc-token.bin')
}

function setToken(tok) {
  const s = String(tok || '').trim()
  if (!s) return { ok: false, error: 'token 是空的' }
  try {
    const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(s) : Buffer.from(s, 'utf8')
    fs.writeFileSync(tokenFile(), buf)
    return { ok: true, enc: safeStorage.isEncryptionAvailable() }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
}

function getToken() {
  try {
    if (!fs.existsSync(tokenFile())) return ''
    const buf = fs.readFileSync(tokenFile())
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(buf)
      } catch (_) {
        return buf.toString('utf8')
      }
    }
    return buf.toString('utf8')
  } catch (_) {
    return ''
  }
}

function clearToken() {
  try {
    if (fs.existsSync(tokenFile())) fs.unlinkSync(tokenFile())
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
}

/** 验一个 token 是否有效（顺带拿到账号名） */
async function verifyToken(tok) {
  const s = String(tok || '').trim()
  if (!s) return { ok: false, error: '空 token' }
  try {
    const res = await net.fetch('https://discord.com/api/v9/users/@me', {
      headers: { Authorization: s, 'User-Agent': UA, Accept: 'application/json' }
    })
    if (res.status === 401) return { ok: false, error: 'token 无效或已过期' }
    if (!res.ok) return { ok: false, error: `接口返回 ${res.status}` }
    const j = await res.json().catch(() => null)
    const who = j && (j.global_name || j.username) ? `${j.global_name || j.username}` : ''
    return { ok: true, who }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
}

/** 从本机浏览器的登录态里自动捞 token 并存下来 */
async function autoPickToken() {
  try {
    const r = await tokenpick.findToken((tok) => verifyToken(tok))
    if (!r.ok) {
      const scanned = (r.report || []).filter((x) => x.found)
      const hint = scanned.length
        ? '在浏览器里找到了疑似凭据但都失效了，请重新登录 Discord 网页版后再试'
        : '没在 Chrome / Edge / Brave / Vivaldi / Opera / Discord 客户端里找到 Discord 登录凭据，请先用浏览器登录一次 discord.com'
      return { ok: false, error: hint, report: r.report || [] }
    }
    const saved = setToken(r.token)
    if (!saved.ok) return { ok: false, error: '找到了但保存失败：' + (saved.error || '') }
    return { ok: true, from: r.from, who: r.who || '', enc: !!saved.enc, report: r.report || [] }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
}

/* ---------------- REST 抓取（自备 token，全程无窗口） ---------------- */

async function probeByToken(url) {
  const p = parseDiscordUrl(url)
  if (!p) return { ok: false, error: '链接格式不对' }
  const token = getToken()
  if (!token) return { ok: false, needToken: true, reason: 'NO_TOKEN', error: '还没填 Discord token' }
  if (/[^\x21-\x7E]/.test(token)) {
    return { ok: false, needToken: true, reason: 'BAD_TOKEN', error: 'token 里含非法字符（可能复制时带进了空格/换行），请重新填入' }
  }
  const api = (path) =>
    net.fetch('https://discord.com/api/v9' + path, {
      headers: { Authorization: token, 'User-Agent': UA, Accept: 'application/json' }
    })
  const firstLine = (content) => {
    for (const line of String(content || '').split(/\r?\n/)) {
      const t = line.replace(/\s+/g, ' ').trim()
      if (t) return t
    }
    return ''
  }
  try {
    // 1) 帖子（线程）的标题就是该线程频道的 name，和页面上顶端红框/绿框一致；
    //    而 messages?around 取到的是"游标附近"的第一条消息，很多时候是最新评论，不能用
    let denied = null
    try {
      const cr = await api(`/channels/${p.channel}`)
      if (cr.status === 401) return { ok: false, needToken: true, reason: 'BAD_TOKEN', error: 'token 无效或已过期' }
      if (cr.status === 403) denied = { ok: false, reason: 'DENIED', error: '没有权限看这个频道' }
      else if (cr.status === 404) denied = { ok: false, reason: '404', error: '频道或消息不存在' }
      else if (cr.ok) {
        const ch = await cr.json().catch(() => null)
        const name = ch && ch.name ? String(ch.name).replace(/\s+/g, ' ').trim() : ''
        const isThread = ch && [10, 11, 12].includes(Number(ch.type))
        if (isThread && name) return { ok: true, title: name.slice(0, 200), via: 'thread-name' }
      }
    } catch (_) {}

    // 2) 兜底：按消息取首行（普通频道里的消息链接走这条）
    const u = p.message
      ? `/channels/${p.channel}/messages?around=${p.message}&limit=1`
      : `/channels/${p.channel}/messages?limit=1`
    const res = await api(u)
    if (res.status === 401) return { ok: false, needToken: true, reason: 'BAD_TOKEN', error: 'token 无效或已过期' }
    if (!res.ok) return denied || { ok: false, error: `接口返回 ${res.status}` }
    const arr = await res.json().catch(() => [])
    const msg = Array.isArray(arr) && arr.length ? arr[0] : null
    if (!msg) return denied || { ok: false, reason: 'EMPTY', error: '这条帖子没有内容' }
    // 论坛父频道里消息可能是"帖子楼"，楼层自带 thread.name
    const tName = msg.thread && msg.thread.name ? String(msg.thread.name).replace(/\s+/g, ' ').trim() : ''
    if (tName) return { ok: true, title: tName.slice(0, 200), via: 'message-thread-name' }
    let title = firstLine(msg.content)
    if (!title && Array.isArray(msg.attachments) && msg.attachments.length) title = msg.attachments[0].filename || ''
    if (!title) return denied || { ok: false, reason: 'EMPTY', error: '这条帖子没有文字内容' }
    return { ok: true, title: title.slice(0, 200), via: 'api' }
  } catch (e) {
    return { ok: false, error: String(e.message || e), stage: 'api' }
  }
}

/* ---------------- 对外入口 ---------------- */

/**
 * 抓一条：只用账号 token 走 REST，全程不弹任何窗口（已停用内置浏览器方案）
 */
async function probeOne(url, opts = {}) {
  const clean = sanitizeUrl(url)
  if (!clean) return { ok: false, reason: 'BAD_LINK', error: '链接是空的' }
  if (!/^https?:\/\//i.test(clean)) return { ok: false, reason: 'BAD_LINK', error: '链接需要以 http(s):// 开头' }
  const r = await probeByToken(clean)
  if (r.ok) return r
  return Object.assign({}, r, { mode: 'token' })
}

/** 批量抓取：并发受控，静默无界面 */
async function probeMany(items, opts = {}) {
  const list = Array.isArray(items) ? items : []
  const concurrency = Math.max(1, Math.min(Number(opts.concurrency) || 3, 8))
  const results = new Array(list.length).fill(null)
  let idx = 0
  const worker = async () => {
    while (true) {
      const i = idx++
      if (i >= list.length) return
      const url = list[i]
      results[i] = Object.assign({ url }, await probeOne(url, opts))
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length || 1) }, worker))
  return results
}

module.exports = {
  probeMany,
  probeOne,
  probeByToken,
  parseDiscordUrl,
  setToken,
  getToken,
  clearToken,
  verifyToken,
  autoPickToken
}
