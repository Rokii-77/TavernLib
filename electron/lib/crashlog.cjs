/* 崩溃与报错记录：自动落盘，供用户在设置里一键复制、一键清理
 *
 * 落盘位置：<软件数据目录>/crash-logs/crash-YYYYMMDD-HHmmss-SSS-<类别>.txt
 * 保留策略：默认 30 天（backfillCleanup 在启动时跑一次，程序运行期间每天跑一次）
 *          另外限制最多 200 个文件，避免短时间反复报错把磁盘写满
 * 设计原则：记录日志本身绝不影响软件运行 —— 所有写入/删除失败一律静默吞掉
 */
const fs = require('node:fs')
const path = require('node:path')

const KEEP_DAYS = 30
const MAX_FILES = 200
const PREFIX = 'crash-'

let logDir = ''
let appVersion = ''
let started = false

function pad(n, w = 2) {
  return String(n).padStart(w, '0')
}

function stamp(d) {
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds()) +
    '-' +
    pad(d.getMilliseconds(), 3)
  )
}

function human(d) {
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes()) +
    ':' +
    pad(d.getSeconds()) +
    '.' +
    pad(d.getMilliseconds(), 3)
  )
}

function ensure() {
  if (!logDir) return false
  try {
    fs.mkdirSync(logDir, { recursive: true })
    return true
  } catch (_) {
    return false
  }
}

/* 详情序列化：Error 取 message+stack，其余对象尽力 JSON 化，超长截断 */
function detailToText(detail) {
  if (detail == null) return ''
  let text = ''
  if (detail instanceof Error) {
    text = (detail.stack || '') + '\n' + (detail.message || '')
  } else if (typeof detail === 'string') {
    text = detail
  } else {
    try {
      text = JSON.stringify(detail, (k, v) => (v instanceof Error ? { message: v.message, stack: v.stack } : v), 2)
    } catch (_) {
      text = String(detail)
    }
  }
  if (text.length > 20000) text = text.slice(0, 20000) + '\n…（内容过长，已截断）'
  return text
}

function init(dir, opt = {}) {
  logDir = String(dir || '')
  appVersion = String(opt.version || '')
  if (!ensure()) return false
  cleanupOld(opt.keepDays || KEEP_DAYS)
  return true
}

function dirPath() {
  return logDir
}

/* 写一条记录：返回 { ok, file }；任何异常都不向外抛
   同一个错误在 DUPE_MS 内只写一份：渲染层循环报错不至于把目录刷成几万个小文件 */
let lastKey = ''
let lastAt = 0
let lastFile = ''
const DUPE_MS = 60 * 1000

function record(category, detail, extra = {}) {
  if (!logDir) return { ok: false, error: '尚未初始化' }
  if (!ensure()) return { ok: false, error: '无法创建目录：' + logDir }
  const now = new Date()
  const cat = String(category || 'error').replace(/[\\/\s]+/g, '-').slice(0, 40)
  const body = detailToText(detail) || ''
  const key = cat + '\u0000' + body.slice(0, 400)
  if (key === lastKey && now.getTime() - lastAt < DUPE_MS && lastFile) {
    return { ok: true, skipped: true, file: lastFile, name: path.basename(lastFile) }
  }
  const name = PREFIX + stamp(now) + '-' + cat + '.txt'
  const file = path.join(logDir, name)
  const lines = [
    '[时间] ' + human(now),
    '[类别] ' + cat,
    '[版本] ' + (appVersion || '未知'),
    '[平台] ' + process.platform + ' ' + (process.getSystemVersion ? process.getSystemVersion() : '') + ' ' + process.arch,
    '[进程] pid ' + process.pid
  ]
  const keys = extra && typeof extra === 'object' ? Object.keys(extra) : []
  for (const k of keys) {
    if (k === 'version' || k === 'category') continue
    const v = detailToText(extra[k])
    if (v) lines.push('[' + k + '] ' + v.replace(/\n/g, ' ').slice(0, 500))
  }
  lines.push('[详情]', body || '（无）')
  try {
    fs.writeFileSync(file, lines.join('\n'), 'utf8')
    lastKey = key
    lastAt = now.getTime()
    lastFile = file
    trimMax()
    return { ok: true, file, name }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

function listFiles() {
  if (!ensure()) return []
  let names = []
  try {
    names = fs.readdirSync(logDir).filter((n) => n.startsWith(PREFIX) && n.endsWith('.txt'))
  } catch (_) {
    return []
  }
  const out = []
  for (const n of names) {
    const full = path.join(logDir, n)
    try {
      const st = fs.statSync(full)
      out.push({ name: n, path: full, size: st.size, time: st.mtime.getTime() })
    } catch (_) {}
  }
  out.sort((a, b) => b.time - a.time)
  return out
}

function latestFile() {
  const all = listFiles()
  return all.length ? all[0] : null
}

/* 读最新一条记录的全文（设置里「复制报错」用） */
function readLatest() {
  const f = latestFile()
  if (!f) return { ok: false, error: '还没有报错记录', dir: logDir, count: 0 }
  try {
    const text = fs.readFileSync(f.path, 'utf8')
    return { ok: true, text, name: f.name, path: f.path, count: listFiles().length, dir: logDir }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), dir: logDir, count: listFiles().length }
  }
}

/* 清空全部历史记录（用户在设置里主动点，需先确认） */
function clearAll() {
  if (!ensure()) return { ok: false, error: '无法访问目录', dir: logDir }
  const all = listFiles()
  let removed = 0
  for (const f of all) {
    try {
      fs.unlinkSync(f.path)
      removed++
    } catch (_) {}
  }
  return { ok: true, removed, dir: logDir }
}

/* 删除超过 keepDays 天的记录 */
function cleanupOld(keepDays = KEEP_DAYS) {
  if (!ensure()) return { ok: false, removed: 0 }
  const limit = Date.now() - Math.max(1, keepDays) * 86400000
  let removed = 0
  for (const f of listFiles()) {
    if (f.time >= limit) continue
    try {
      fs.unlinkSync(f.path)
      removed++
    } catch (_) {}
  }
  return { ok: true, removed }
}

/* 数量兜底：超过 MAX_FILES 时从最旧的开始删 */
function trimMax() {
  const all = listFiles()
  if (all.length <= MAX_FILES) return 0
  let removed = 0
  for (const f of all.slice(MAX_FILES)) {
    try {
      fs.unlinkSync(f.path)
      removed++
    } catch (_) {}
  }
  return removed
}

/* 挂主进程级钩子：未捕获异常、Promise 未处理拒绝、渲染进程/子进程消失
 * 只记录不退出 —— 交给 Electron 默认行为，避免把用户卡在崩溃弹窗里 */
function attach({ version = '' } = {}) {
  if (started) return
  started = true
  if (version) appVersion = String(version)

  process.on('uncaughtException', (err) => {
    record('main-uncaught', err)
  })
  process.on('unhandledRejection', (reason) => {
    record('main-rejection', reason)
  })
}

/* 渲染进程崩溃/被杀、GPU 等子进程崩溃由 app 事件上报，单独挂一次 */
function attachApp(app) {
  if (!app || !app.on) return
  const onGone = (tag) => (event, details) => {
    const d = details || {}
    record(tag, '进程消失，原因：' + (d.reason || '未知') + (d.exitCode != null ? '（exitCode ' + d.exitCode + '）' : ''), {
      进程: d.type || d.name || '',
      退出码: d.exitCode != null ? String(d.exitCode) : '',
      原因: d.reason || ''
    })
  }
  app.on('render-process-gone', onGone('renderer-gone'))
  app.on('child-process-gone', onGone('child-gone'))
  app.on('gpu-process-crashed', (event, killed) => {
    record('gpu-crashed', 'GPU 进程崩溃，killed=' + String(!!killed))
  })
}

module.exports = {
  init,
  record,
  listFiles,
  latestFile,
  readLatest,
  clearAll,
  cleanupOld,
  trimMax,
  attach,
  attachApp,
  dirPath,
  KEEP_DAYS,
  MAX_FILES
}
