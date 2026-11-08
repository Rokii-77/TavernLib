/**
 * 更新看门狗（回退用）：判断「新版装完能不能正常启动」
 *
 * 依据只有一个：安装完成后，新版能不能熬过启动观察期。
 *  - 安装前 markPending({from,to}) 记一笔
 *  - 每次启动 bootTick(当前版本)：
 *      · 跑在新版上，且上一次启动没熬过观察期就没了 → 算一次「没起来」，计数 +1
 *      · 还跑在旧版上（覆盖安装失败/被退回）→ 同样计数 +1
 *  - 启动后 stable()：熬过观察期 → 更新算成功，清掉 pending
 *  - 连续 2 次都没熬过去 → suspect=true，界面提示「可回退到上一版」
 *
 * 状态文件放在 userData 下，纯同步读写，任何异常都不向外抛（不能因为看门狗把启动搞崩）。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const SUSPECT_AFTER = 2
const STALE_DAYS = 7
/* 启动观察期：和 main.cjs 里 stable() 的延时保持一致（20 秒）。
   上次启动到现在不足这个间隔就又起来了，说明上一次没熬过去 */
const BOOT_GRACE_MS = 20 * 1000

let stateFile = ''
let appVersion = ''

function nowIso() {
  return new Date().toISOString()
}

function emptyState() {
  return {
    pending: null, // { from, to, at }
    attempts: 0, // 新版没熬过启动期的次数
    suspect: false,
    suspectAt: '',
    lastBootOkFor: '',
    lastBootOkAt: '',
    launchAt: '', // 上一次启动的时刻，用来判断「上次有没有熬过观察期」
    updatedAt: ''
  }
}

function init(dir, opt = {}) {
  appVersion = String(opt.version || '')
  try {
    const d = path.resolve(String(dir || ''))
    fs.mkdirSync(d, { recursive: true })
    stateFile = path.join(d, 'update-state.json')
    return true
  } catch (_) {
    stateFile = ''
    return false
  }
}

function filePath() {
  return stateFile
}

function read() {
  const base = emptyState()
  if (!stateFile) return base
  try {
    const txt = fs.readFileSync(stateFile, 'utf8')
    const obj = JSON.parse(txt)
    if (!obj || typeof obj !== 'object') return base
    return {
      ...base,
      ...obj,
      pending: obj.pending && typeof obj.pending === 'object' ? obj.pending : null,
      attempts: Number(obj.attempts || 0) || 0,
      suspect: !!obj.suspect
    }
  } catch (_) {
    return base
  }
}

function write(s) {
  if (!stateFile) return false
  try {
    const next = { ...s, updatedAt: nowIso() }
    fs.writeFileSync(stateFile, JSON.stringify(next, null, 2), 'utf8')
    return true
  } catch (_) {
    return false
  }
}

/** 安装前调用：记下从哪个版本升到哪个版本 */
function markPending(info = {}) {
  const from = String(info.from || appVersion || '').trim()
  const to = String(info.to || '').trim()
  if (!to || from === to) return { ok: false, error: '版本号无效' }
  const s = read()
  s.pending = { from, to, at: nowIso() }
  s.attempts = 0
  s.suspect = false
  s.suspectAt = ''
  s.launchAt = ''
  write(s)
  return { ok: true, pending: s.pending }
}

/** 启动时调用：返回当前是否可疑 + 尝试次数 */
function bootTick(version) {
  const cur = String(version || appVersion || '').trim()
  const s = read()
  /* 老状态自动过期：超过 7 天没结论就别一直挂着吓人 */
  if (s.pending && s.pending.at) {
    const age = Date.now() - new Date(s.pending.at).getTime()
    if (!(age >= 0) || age > STALE_DAYS * 24 * 3600 * 1000) {
      s.pending = null
      s.attempts = 0
      s.suspect = false
      s.suspectAt = ''
      write(s)
      return { ...s, changed: true }
    }
  }
  if (s.pending) {
    const to = String(s.pending.to || '').trim()
    const from = String(s.pending.from || '').trim()
    if (to && cur === to) {
      /* 跑在新版上：看上一次启动有没有熬过观察期。
         上一次启动到这次启动不足观察期 → 上次是「没起来」，这才是真实的崩溃循环
         （覆盖安装后一直是新版，不会退回旧版，靠旧版计数永远等不到报警） */
      const last = s.launchAt ? new Date(s.launchAt).getTime() : 0
      const gap = last > 0 ? Date.now() - last : -1
      const diedEarly = gap >= 0 && gap < BOOT_GRACE_MS
      if (diedEarly) {
        s.attempts = Number(s.attempts || 0) + 1
        if (s.attempts >= SUSPECT_AFTER) {
          s.suspect = true
          if (!s.suspectAt) s.suspectAt = nowIso()
        }
      } else {
        s.attempts = 1
      }
    } else if (from && cur === from) {
      /* 还在旧版：说明上一次新版没熬过启动观察期（或用户已经退回去了） */
      s.attempts = Number(s.attempts || 0) + 1
      if (s.attempts >= SUSPECT_AFTER) {
        s.suspect = true
        if (!s.suspectAt) s.suspectAt = nowIso()
      }
    }
  }
  s.launchAt = nowIso()
  write(s)
  return { ...s, changed: true }
}

/** 启动后稳定运行一段时间后调用：更新算成功 */
function stable(version) {
  const cur = String(version || appVersion || '').trim()
  const s = read()
  s.lastBootOkFor = cur
  s.lastBootOkAt = nowIso()
  if (s.pending && String(s.pending.to || '') === cur) {
    s.pending = null
    s.attempts = 0
    s.suspect = false
    s.suspectAt = ''
  }
  write(s)
  return { ...s }
}

/** 用户已经自己处理完了（回退成功 / 不想再看这条提示） */
function clear() {
  const s = read()
  s.pending = null
  s.attempts = 0
  s.suspect = false
  s.suspectAt = ''
  s.launchAt = ''
  write(s)
  return { ok: true, state: s }
}

module.exports = { init, filePath, state: read, markPending, bootTick, stable, clear, SUSPECT_AFTER }
