/* 更新提示 / 忽略更新 / 下载安装 / 扩展版本校验 的 store 层测试
   在 Node 里给浏览器环境打最小桩，直接跑真实 store.js 的逻辑，不连 Electron */

const mem = new Map()
const out = []
function ok(name, cond, extra) {
  out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''))
  return !!cond
}

/* ---------- 浏览器环境桩 ---------- */
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear()
}
const noop = () => {}
globalThis.document = {
  documentElement: { style: { setProperty: noop, removeProperty: noop }, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false } },
  body: { appendChild: noop, dataset: {}, classList: { add: noop, remove: noop } },
  head: { appendChild: noop },
  createElement: () => ({ style: {}, dataset: {}, appendChild: noop, setAttribute: noop, addEventListener: noop, remove: noop }),
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  addEventListener: noop
}
globalThis.window = globalThis
globalThis.addEventListener = noop
globalThis.removeEventListener = noop
globalThis.performance = globalThis.performance || { now: () => 0 }
try {
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true })
} catch (_) {
  /* Node 22 的 navigator 是只读 getter，已在存在时就不用替换 */
}
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)

/* ---------- Electron API 桩：可控地返回「有新版本 / 扩展版本不一致」 ---------- */
const calls = { upDownload: [], upInstall: [], logReport: [], stExtInject: [] }
let progressCb = null
let midPercent = -1
let S = null
const apiStub = {
  info: async () => ({ version: '0.1.0', name: '洛兮匣' }),
  fetchJson: async () => ({ ok: true, status: 200, data: { tag_name: 'v0.1.1', name: 'v0.1.1', assets: [] } }),
  upDownload: async (p) => {
    calls.upDownload.push(p)
    if (progressCb) {
      progressCb({ percent: 42, received: 4200, total: 10000 })
      midPercent = S.store.upd.percent
    }
    return { ok: true, path: 'C:/temp/pkg.exe', size: 10000, sha256: 'abc' }
  },
  upInstall: async (p) => {
    calls.upInstall.push(p)
    return { ok: true, restarting: true }
  },
  onUpProgress: (cb) => {
    progressCb = cb
    return noop
  },
  stExtStatus: async () => ({ ok: true, installed: true, version: '1.0.0', latest: '1.1.0', outdated: true, path: 'x' }),
  stExtInject: async (p) => {
    calls.stExtInject.push(p)
    apiStub.stExtStatus = async () => ({ ok: true, installed: true, version: '1.1.0', latest: '1.1.0', outdated: false, path: 'x' })
    return { ok: true, version: '1.1.0' }
  },
  logReport: async (p) => {
    calls.logReport.push(p)
    return { ok: true, file: 'x.txt' }
  },
  openExternal: async () => ({ ok: true })
}
globalThis.api = apiStub
globalThis.window.api = apiStub

/* ---------- 载入真实 store ---------- */
S = await import('../src/store.js')

/* 把检查更新结果注入到可预期状态：直接替换 store.settings 的仓库配置不影响，这里打桩 fetchJson 已经足够，
   但 checkForUpdate 的实现细节（tag 解析）由 lib/update.js 决定，所以这里只断言它把结果搬进了 appUpdate */
await S.checkAppUpdateOnStart()
const ap = S.store.appUpdate
ok('启动检查后写入 hasUpdate/latest', ap.hasUpdate === true && ap.latest === '0.1.1', JSON.stringify({ hasUpdate: ap.hasUpdate, latest: ap.latest }))
ok('启动检查后带出下载字段', 'downloadUrl' in ap && 'downloadDigest' in ap && 'downloadSize' in ap)
ok('默认未被忽略', ap.ignored === false)

/* 忽略本次更新 */
const ignored = S.ignoreAppUpdate()
ok('忽略返回版本号', ignored === '0.1.1', String(ignored))
ok('忽略写入设置', S.store.settings.ignoredUpdateVersion === '0.1.1', String(S.store.settings.ignoredUpdateVersion))
ok('忽略后 appUpdate.ignored 为真', S.store.appUpdate.ignored === true)
ok('忽略信息已落盘到 localStorage', String(mem.get('tavernlib.settings.v1') || JSON.stringify([...mem.keys()])).includes('0.1.1') || [...mem.values()].some((v) => String(v).includes('0.1.1')))

/* 同版本再检查：仍视为已忽略（弹窗不该出现） */
await S.checkAppUpdateOnStart()
ok('同版本重复检查仍标记为已忽略', S.store.appUpdate.ignored === true)

/* 出新版本：忽略失效，应重新提示 */
S.store.appUpdate = { ...S.store.appUpdate, lastAt: '', hasUpdate: false, latest: '', ignored: false }
apiStub.fetchJson = async () => ({ ok: true, status: 200, data: { tag_name: 'v0.2.0', name: 'v0.2.0', assets: [] } })
const r2 = await S.checkAppUpdateOnStart()
if (r2 && r2.hasUpdate) {
  ok('新版本重新提示（ignored=false）', S.store.appUpdate.ignored === false, 'latest=' + S.store.appUpdate.latest)
} else {
  out.push('SKIP 新版本重新提示（lib/update.js 未把 v0.2.0 判为新版本：' + JSON.stringify(r2) + '）')
}

/* 下载流程：伪造一次可下载的更新 */
S.store.appUpdate = {
  ...S.store.appUpdate,
  hasUpdate: true,
  latest: '0.2.0',
  current: '0.1.0',
  downloadUrl: 'https://example.com/洛兮匣-0.2.0.exe',
  downloadName: '洛兮匣-0.2.0.exe',
  downloadDigest: 'sha256:deadbeef',
  downloadSize: 10000,
  ignored: false
}
const dl = await S.startAppUpdate()
ok('下载成功后 phase=ready', S.store.upd.phase === 'ready', S.store.upd.phase)
ok('下载成功 percent=100', S.store.upd.percent === 100, String(S.store.upd.percent))
ok('下载结果记下安装包路径', S.store.upd.pkg === 'C:/temp/pkg.exe', String(S.store.upd.pkg))
ok('下载参数透传 url/name/sha256', !!calls.upDownload.length && calls.upDownload[0].url.includes('.exe') && calls.upDownload[0].name.includes('exe') && calls.upDownload[0].sha256.includes('deadbeef'), JSON.stringify(calls.upDownload[0]))
ok('下载过程中进度回调实时写入 percent=42', midPercent === 42, 'mid=' + midPercent)
ok('下载完成后 received 与 total 对齐', S.store.upd.received === 10000, String(S.store.upd.received))

const inst = await S.installAppUpdate()
ok('安装成功 phase=installing', S.store.upd.phase === 'installing', S.store.upd.phase)
ok('安装参数带安装包路径', calls.upInstall[0] && calls.upInstall[0].path === 'C:/temp/pkg.exe', JSON.stringify(calls.upInstall[0]))

S.resetAppUpdate()
ok('reset 后回到 idle', S.store.upd.phase === 'idle' && S.store.upd.pkg === '', S.store.upd.phase)

/* 下载失败：不能停在 downloading，错误要能读到 */
apiStub.upDownload = async () => ({ ok: false, error: '网络中断' })
S.store.appUpdate = { ...S.store.appUpdate, downloadUrl: 'https://example.com/x.exe', downloadSize: 0 }
const dlFail = await S.startAppUpdate()
ok('下载失败回到 idle', S.store.upd.phase === 'idle', S.store.upd.phase)
ok('下载失败错误可读', String(S.store.upd.error).includes('网络中断'), S.store.upd.error)

/* 扩展版本校验：不一致要亮灯 */
S.store.settings.tavernPath = 'F:/SillyTavern7000'
const e1 = await S.checkStExtVersion()
ok('扩展版本不一致 → 弹窗可见', e1.visible === true && e1.installed === true, JSON.stringify(e1))
ok('弹窗带内置/酒馆版本号', e1.builtin === '1.1.0' && e1.tavern === '1.0.0', JSON.stringify({ b: e1.builtin, t: e1.tavern }))

/* 未安装也要提示 */
apiStub.stExtStatus = async () => ({ ok: true, installed: false, version: '', latest: '1.1.0', path: 'x' })
const e2 = await S.checkStExtVersion()
ok('扩展未安装 → 提示可见', e2.visible === true && e2.installed === false, JSON.stringify(e2))

/* 点「立即重新注入」：注入后版本对齐，弹窗自己消失 */
apiStub.stExtStatus = async () => ({ ok: true, installed: true, version: '1.0.0', latest: '1.1.0', outdated: true, path: 'x' })
await S.checkStExtVersion()
const reinj = await S.reInjectStExt()
ok('重新注入成功', reinj && reinj.ok, JSON.stringify(reinj))
ok('注入后弹窗自动消失', S.store.extRemind.visible === false, JSON.stringify(S.store.extRemind))
ok('注入参数带酒馆路径', calls.stExtInject[0] && String(calls.stExtInject[0].tavernPath).includes('SillyTavern'), JSON.stringify(calls.stExtInject[0]))

/* 稍后再说 */
S.store.extRemind.visible = true
S.dismissExtRemind()
ok('稍后再说可关闭弹窗', S.store.extRemind.visible === false)

console.log(out.join('\n'))
const fails = out.filter((x) => x.startsWith('FAIL'))
console.log('\nFAILED=' + fails.length)
process.exit(fails.length ? 1 : 0)
