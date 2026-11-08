'use strict'
/* 崩溃与异常现场记录（默认关闭，设置 TAVERNLIB_DIAG=<日志文件绝对路径> 后启用）

   覆盖窗口：
   - 渲染进程崩溃 / OOM（render-process-gone）
   - 子进程、GPU 进程崩溃（child-process-gone）
   - 页面无响应、加载失败、preload 抛错
   - 渲染进程 console（error / warning 级别）
   - 主进程未捕获异常 / 未处理的 Promise 拒绝

   写盘采用「同步追加 + 单行 JSON」，即使进程正在崩溃也能尽量落下现场。
   日志只在主进程写，渲染端不做任何事，避免影响性能。 */

const fs = require('node:fs')
const path = require('node:path')

const file = String(process.env.TAVERNLIB_DIAG || '').trim()
let enabled = false
let ready = false

function init() {
  if (!file) return { enabled: false }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '', 'utf8')
    enabled = true
    ready = true
  } catch (_) {
    enabled = false
  }
  return { enabled, file: enabled ? file : '' }
}

function log(type, data) {
  if (!enabled || !ready) return
  const line = JSON.stringify({
    at: new Date().toISOString(),
    pid: process.pid,
    type,
    data: data === undefined ? null : data
  })
  try {
    fs.appendFileSync(file, line + '\n', 'utf8')
  } catch (_) {}
}

/** 把主进程层面的异常全部接管下来（不再静默） */
function attachProcessHooks() {
  if (!enabled) return
  process.on('uncaughtException', (e) => {
    log('main:uncaughtException', { message: String((e && e.message) || e), stack: String((e && e.stack) || '') })
  })
  process.on('unhandledRejection', (e) => {
    log('main:unhandledRejection', { message: String((e && e.message) || e), stack: String((e && e.stack) || '') })
  })
}

/** 给一个 BrowserWindow 挂上崩溃 / 无响应 / 控制台现场采集 */
function attachWindow(win) {
  if (!enabled || !win) return
  const wc = win.webContents

  wc.on('render-process-gone', (_e, details) => {
    log('renderer:gone', details || {})
  })
  wc.on('unresponsive', () => {
    log('renderer:unresponsive', { url: safeUrl(wc) })
  })
  wc.on('did-fail-load', (_e, code, desc, url) => {
    log('renderer:did-fail-load', { code, desc, url })
  })
  wc.on('preload-error', (_e, preload, err) => {
    log('renderer:preload-error', { preload, message: String((err && err.message) || err), stack: String((err && err.stack) || '') })
  })
  wc.on('console-message', (_e, level, message, line, source) => {
    // 0=verbose 1=info 2=warning 3=error，只记 warning 以上，避免刷屏
    if (level >= 2) log('renderer:console', { level, message: String(message).slice(0, 800), line, source })
  })
  // 渲染进程里还没被捕获的异常：让页面自己报上来
  try {
    wc.executeJavaScript(`(() => {
      if (window.__tlDiagBound) return true
      window.__tlDiagBound = true
      window.addEventListener('error', (e) => {
        try { console.error('[tl-diag] error:', (e && e.message) || '', e && e.error && e.error.stack || '') } catch (_) {}
      })
      window.addEventListener('unhandledrejection', (e) => {
        try { console.error('[tl-diag] rejection:', String(e && e.reason && (e.reason.message || e.reason))) } catch (_) {}
      })
      return true
    })()`, true).catch(() => {})
  } catch (_) {}
}

function safeUrl(wc) {
  try {
    return wc.getURL()
  } catch (_) {
    return ''
  }
}

/** 记录一次自定义事件（例如某个重操作开始/结束、耗时） */
function mark(type, data) {
  log(type, data)
}

module.exports = { init, attachProcessHooks, attachWindow, mark, enabled: () => enabled, file: () => file }
