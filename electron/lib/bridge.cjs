'use strict'
/* 洛书匣通知桥：给酒馆端扩展 tavernlib-sync 提供轮询接口
 * - 端口不写死：从 7799 起在 7799-7809 区间依次尝试，被占用就顺延
 * - /health 返回 { ok, app, seq, port, ext:{ online, agoMs } }，供扩展探测当前桥端口
 * - /pending 返回最近一次通知（含 world / preset），供扩展刷新世界书 / 预设
 * - ext.online：8 秒内有过 /pending 命中（即酒馆里的扩展在正常轮询）
 */
const http = require('node:http')

const PORT_START = 7799
const PORT_END = 7809
const HOST = '127.0.0.1'

let server = null
let port = 0
let seq = 0
let lastError = ''
let starting = null
let last = { action: 'idle', avatar: '', name: '', world: '', preset: '', at: 0 }
/* 扩展心跳：扩展每轮 /pending 命中就记一次时间（只记时间，不累加计数）
 * 用于判断「酒馆里的扩展是否还在正常轮询」，而不是「酒馆是否开着我」 */
const EXT_ONLINE_MS = 8000
let lastPendingAt = 0

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Cache-Control', 'no-store')
}

function json(res, body, code) {
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function extInfo() {
  const agoMs = lastPendingAt ? Date.now() - lastPendingAt : null
  const online = agoMs !== null && agoMs <= EXT_ONLINE_MS
  return { online, agoMs }
}

/* 扩展上报的「酒馆当前在用」状态：POST /state 写入
 * 只保留最近一次；超过 STATE_TTL_MS 没更新就当作过期（酒馆关了或卡切走了）
 * 用于「正在用哪一版」标记：软件侧据此显示酒馆里当前这张卡的名称与版本 */
const STATE_TTL_MS = 30000
let extState = { name: '', version: '', extVersion: '', stVersion: '', at: 0 }

function stateInfo() {
  const agoMs = extState.at ? Date.now() - extState.at : null
  const fresh = agoMs !== null && agoMs <= STATE_TTL_MS
  return {
    fresh: !!fresh,
    agoMs,
    name: fresh ? extState.name : '',
    version: fresh ? extState.version : '',
    extVersion: fresh ? extState.extVersion : '',
    stVersion: fresh ? extState.stVersion : ''
  }
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    let raw = ''
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolve(v)
    }
    req.on('data', (c) => {
      raw += c
      if (raw.length > limit) {
        finish(raw.slice(0, limit))
        try { req.destroy() } catch (_) {}
      }
    })
    req.on('end', () => finish(raw))
    req.on('error', () => finish(raw))
    req.setTimeout(3000, () => finish(raw))
  })
}

function handle(req, res) {
  cors(res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  let pathname = '/'
  try {
    pathname = new URL(req.url || '/', 'http://' + HOST + ':' + (port || PORT_START)).pathname
  } catch (_) {
    pathname = '/'
  }
  if (pathname === '/health') {
    json(res, { ok: true, app: 'TavernLib', seq, port, ext: extInfo() })
    return
  }
  if (pathname === '/pending') {
    lastPendingAt = Date.now()
    json(res, {
      ok: true,
      seq,
      action: last.action,
      avatar: last.avatar,
      name: last.name,
      world: last.world,
      preset: last.preset,
      at: last.at
    })
    return
  }
  if (pathname === '/ack') {
    last.action = 'idle'
    json(res, { ok: true })
    return
  }
  if (pathname === '/state') {
    if (req.method !== 'POST') {
      json(res, { ok: false, error: 'use POST' }, 405)
      return
    }
    readBody(req, 16384).then((raw) => {
      let body = {}
      try { body = JSON.parse(raw || '{}') || {} } catch (_) { body = {} }
      const str = (v, n) => String(v === undefined || v === null ? '' : v).slice(0, n)
      extState = {
        name: str(body.name, 200),
        version: str(body.version, 100),
        extVersion: str(body.extVersion, 50),
        stVersion: str(body.stVersion, 50),
        at: Date.now()
      }
      /* 上报本身也算扩展活着，顺带刷心跳 */
      lastPendingAt = Date.now()
      json(res, { ok: true, state: stateInfo() })
    })
    return
  }
  if (pathname === '/status') {
    json(res, { ok: true, app: 'TavernLib', running: !!server, port, seq, ext: extInfo(), state: stateInfo() })
    return
  }
  json(res, { ok: false, error: 'not found' }, 404)
}

/** 在单个端口上尝试监听：被占用返回 retry=true */
function listenOn(p) {
  return new Promise((resolve) => {
    let s
    try {
      s = http.createServer(handle)
    } catch (e) {
      resolve({ ok: false, retry: false, error: '创建通知服务失败：' + (e && e.message ? e.message : e) })
      return
    }
    let settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      resolve(r)
    }
    s.once('error', (e) => {
      try { s.close() } catch (_) {}
      const code = e && e.code
      if (code === 'EADDRINUSE' || code === 'EACCES') finish({ ok: false, retry: true, code })
      else finish({ ok: false, retry: false, error: '通知服务启动失败：' + (e && e.message ? e.message : e) })
    })
    s.listen(p, HOST, () => {
      server = s
      port = p
      finish({ ok: true, port: p, running: true })
    })
  })
}

async function start() {
  if (server) return { ok: true, port, running: true }
  if (starting) return starting
  starting = (async () => {
    let lastCode = ''
    for (let p = PORT_START; p <= PORT_END; p++) {
      const r = await listenOn(p)
      if (r.ok) {
        lastError = ''
        return { ok: true, port: r.port, running: true }
      }
      if (!r.retry) {
        lastError = r.error || '通知服务启动失败'
        return { ok: false, error: lastError }
      }
      lastCode = r.code || lastCode
    }
    lastError = '端口 ' + PORT_START + '-' + PORT_END + ' 全被占用，通知服务未启动' + (lastCode ? '（' + lastCode + '）' : '')
    return { ok: false, error: lastError }
  })()
  try {
    return await starting
  } finally {
    starting = null
  }
}

function stop() {
  if (!server) return { ok: true }
  const s = server
  server = null
  port = 0
  try { s.close() } catch (_) {}
  return { ok: true }
}

function status() {
  return { ok: true, running: !!server, port, seq, error: lastError, ext: extInfo(), state: stateInfo() }
}

/** 通知酒馆前端：刷角色卡 / 世界书 / 预设 */
function notify(payload = {}) {
  seq++
  last = {
    action: payload.action || 'reload',
    avatar: payload.avatar || '',
    name: payload.name || '',
    world: payload.world || '',
    preset: payload.preset || '',
    at: Date.now()
  }
  return { ok: true, seq, port }
}

module.exports = { start, stop, status, notify, PORT_START, PORT_END }
