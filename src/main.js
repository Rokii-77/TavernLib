import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import * as S from './store.js'

/* 启动耗时埋点：验收脚本（CDP）读取 window.__bootT，用于对比优化前后 */
window.__bootT = window.__bootT || {}
window.__bootT.moduleStart = performance.now()

const app = createApp(App)

/* 外观先铺上（日/夜 + 自定义 CSS），再挂载，避免先闪一下夜间再变白天 */
try {
  S.applyAppearanceFromSettings()
} catch (_) {}

/* 兜底：组件内部再出异常也不让整页变白/黑屏 —— 顶部留一条提示条，数据照旧，
 * 异常细节打到控制台（Ctrl+Shift+I 可见），避免「点了按钮就黑屏、什么也看不到」。 */
function reportFatal(msg) {
  try {
    console.error('[app error]', msg)
    let bar = document.getElementById('app-error-bar')
    if (!bar) {
      bar = document.createElement('div')
      bar.id = 'app-error-bar'
      bar.style.cssText =
        'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#3a1a1a;color:#ffd7d7;' +
        'font:12px/1.6 system-ui,-apple-system,"Microsoft YaHei";padding:8px 12px;' +
        'border-top:1px solid #7a3b3b;max-height:30vh;overflow:auto;white-space:pre-wrap'
      bar.title = '点击关闭'
      bar.addEventListener('click', () => bar.remove())
      document.body.appendChild(bar)
    }
    bar.textContent = '界面出现异常（已拦截，数据未受影响，点击本行关闭）：\n' + String(msg).slice(0, 800)
  } catch (_) {}
}

/* 报错同时落盘一份：用户点设置里的「复制最近报错」就能把完整堆栈发出来。
 * 每次启动最多送 20 条，避免某个循环报错把磁盘写爆、把界面卡住。 */
let logQuota = 20
function reportToDisk(category, detail, source) {
  if (logQuota <= 0) return
  logQuota -= 1
  try {
    window.api?.logReport?.({ category, detail: String(detail || '').slice(0, 8000), source: String(source || '') })
  } catch (_) {}
}

app.config.errorHandler = (err) => {
  reportFatal((err && err.stack) || err)
  reportToDisk('vue-error', (err && err.stack) || err, 'errorHandler')
}
window.addEventListener('error', (e) => {
  reportFatal((e && e.error && e.error.stack) || (e && e.message))
  reportToDisk('renderer-error', (e && e.error && e.error.stack) || (e && e.message), e && e.filename ? `${e.filename}:${e.lineno}` : '')
})
window.addEventListener('unhandledrejection', (e) => {
  reportFatal((e && e.reason && e.reason.stack) || (e && e.reason))
  reportToDisk('renderer-rejection', (e && e.reason && e.reason.stack) || String((e && e.reason) || ''), 'unhandledrejection')
})

app.mount('#app')
window.__bootT.mounted = performance.now()

// 调试与自动化验收钩子（Electron 未打包运行时可用）
// 说明：这里不再注入任何示例数据，资料库内容一律只来自真实导入
window.__tavern = S
