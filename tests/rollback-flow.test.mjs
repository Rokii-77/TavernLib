/* 回退链路 + 每日检查限频 的 store 层测试
   与 update-flow.test.mjs 同样的做法：Node 里打桩浏览器环境，跑真实 store.js */

const mem = new Map()
const out = []
function ok(name, cond, extra) {
  out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''))
  return !!cond
}

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
try {
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true })
} catch (_) {}
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)

/* ---------- 桩：可控返回看门狗状态、历史版本、下载安装 ---------- */
const calls = { upDownload: [], upInstall: [], upClearSuspect: 0, clearJobs: [] }
let watchdog = { pending: null, attempts: 0, suspect: false }
let releases = []
let installFails = false
let downloadFails = false

const apiStub = {
  info: async () => ({ version: '0.1.7' }),
  fetchJson: async () => ({ ok: true, status: 200, data: [] }),
  upState: async () => ({ ok: true, state: watchdog, file: 'C:/u/update-state.json', current: '0.1.7' }),
  upClearSuspect: async () => {
    calls.upClearSuspect += 1
    watchdog = { pending: null, attempts: 0, suspect: false }
    return { ok: true, state: watchdog }
  },
  upDownload: async (p) => {
    calls.upDownload.push(p)
    if (downloadFails) return { ok: false, error: '网络中断' }
    return { ok: true, path: 'C:/temp/old.exe', size: 200, sha256: 'cafe' }
  },
  upInstall: async (p) => {
    calls.upInstall.push(p)
    if (installFails) return { ok: false, error: '安装脚本启动失败' }
    return { ok: true, restarting: true }
  },
  onUpProgress: () => noop,
  openExternal: async () => ({ ok: true })
}
globalThis.api = apiStub
globalThis.window.api = apiStub

const S = await import('../src/store.js')

/* ---------- 1) 每日检查限频 ---------- */
/* 检查链路已改走 github.com 302（api.github.com 只做最后兜底）：
   这里按 URL 分流打桩，主通道命中后不允许再打 api */
let fetchCount = 0
let apiHit = 0
apiStub.fetchJson = async (req) => {
  const url = String((req && req.url) || '')
  fetchCount += 1
  if (/api\.github\.com/.test(url)) {
    apiHit += 1
    return { ok: true, status: 200, data: { tag_name: 'v0.1.9', name: 'v0.1.9', assets: [] } }
  }
  if (/releases\/latest$/.test(url)) {
    return { ok: false, status: 302, location: 'https://github.com/Rokii-77/TavernLib/releases/tag/v0.1.9' }
  }
  if (/raw\.githubusercontent/.test(url)) return { ok: false, status: 404, data: '' }
  if (/releases\.atom$/.test(url)) return { ok: false, status: 404, data: '' }
  return { ok: false, status: 0, error: 'unexpected ' + url }
}
const t1 = await S.checkAppUpdateOnStart({ force: true })
ok('首次强制检查走网络并记下当天日期', fetchCount >= 1 && !!S.store.settings.updateLastCheckDay && !!t1, String(S.store.settings.updateLastCheckDay))
const firstFetch = fetchCount
const r2 = await S.checkAppUpdateOnStart()
ok('同一天再次启动不发请求（复用缓存）', fetchCount === firstFetch && r2 && r2.cached === true, 'fetch=' + fetchCount)
ok('缓存命中仍然保留「有更新」状态', S.store.appUpdate.latest === '0.1.9' && S.store.appUpdate.hasUpdate === true)
ok('主通道 302 命中后不再请求 api.github.com', apiHit === 0, 'api=' + apiHit)
ok('检查链路标注为 redirect 通道', S.store.appUpdate.channel === 'redirect', String(S.store.appUpdate.channel))
const r3 = await S.checkAppUpdateOnStart({ force: true })
ok('手动点「立即检查」可以绕过缓存', fetchCount > firstFetch && !(r3 && r3.cached), 'fetch=' + fetchCount + ' ok=' + !!(r3 && r3.ok))
ok('跨天会重新请求', (() => {
  S.store.settings.updateLastCheckDay = '2000-01-01'
  return true
})())

/* ---------- 2) 看门狗启动检查 ---------- */
watchdog = { pending: { from: '0.1.6', to: '0.1.7', at: new Date().toISOString() }, attempts: 2, suspect: true }
const rb1 = await S.checkRollbackOnStart()
ok('可疑状态被读出（提示可退回 0.1.6）', rb1.suspect === true && rb1.from === '0.1.6' && rb1.to === '0.1.7', JSON.stringify(rb1))
ok('尝试次数透传', rb1.attempts === 2)

watchdog = { pending: null, attempts: 0, suspect: false }
const rb2 = await S.checkRollbackOnStart()
ok('状态正常时不提示', rb2.suspect === false && rb2.from === '')

/* ---------- 3) 执行回退（找版本 → 下载 → 安装） ---------- */
watchdog = { pending: { from: '0.1.6', to: '0.1.7', at: new Date().toISOString() }, attempts: 2, suspect: true }
await S.checkRollbackOnStart()
releases = [
  { latest: '0.1.7', downloadUrl: 'https://x/0.1.7.exe', downloadName: 'Setup 0.1.7.exe', downloadSize: 300, downloadDigest: '' },
  { latest: '0.1.6', downloadUrl: 'https://x/0.1.6.exe', downloadName: 'Setup 0.1.6.exe', downloadSize: 200, downloadDigest: 'sha256:beef' }
]
apiStub.fetchJson = async () => ({ ok: true, status: 200, data: releases.map((x) => ({ tag_name: 'v' + x.latest, assets: [{ name: x.downloadName, browser_download_url: x.downloadUrl, size: x.downloadSize }] })) })
calls.upDownload.length = 0
calls.upInstall.length = 0
const inst = await S.rollbackAppUpdate()
ok('回退下载的是旧版安装包', calls.upDownload.length === 1 && calls.upDownload[0].url === 'https://x/0.1.6.exe', JSON.stringify(calls.upDownload[0]))
ok('回退安装带上了旧版本号', calls.upInstall.length === 1 && calls.upInstall[0].toVersion === '0.1.6', JSON.stringify(calls.upInstall[0]))
ok('回退流程返回重启安装', !!(inst && inst.restarting))
ok('回退期间不残留 busy', S.store.rollback.busy === false)

/* 更新源里已经没有那一版 */
releases = [{ latest: '0.1.7', downloadUrl: 'https://x/0.1.7.exe', downloadName: 'Setup 0.1.7.exe', downloadSize: 300 }]
apiStub.fetchJson = async () => ({ ok: true, status: 200, data: releases.map((x) => ({ tag_name: 'v' + x.latest, assets: [{ name: x.downloadName, browser_download_url: x.downloadUrl }] })) })
calls.upDownload.length = 0
const inst2 = await S.rollbackAppUpdate()
ok('找不到旧版时给出可读提示且不下载', inst2 === null && calls.upDownload.length === 0 && /没有 0\.1\.6/.test(S.store.rollback.hint), S.store.rollback.hint)

/* 下载失败 */
apiStub.fetchJson = async () => ({
  ok: true,
  status: 200,
  data: [
    { tag_name: 'v0.1.6', assets: [{ name: 'Setup 0.1.6.exe', browser_download_url: 'https://x/0.1.6.exe' }] }
  ]
})
downloadFails = true
const inst3 = await S.rollbackAppUpdate()
ok('回退下载失败时不继续安装', inst3 === null && /网络中断/.test(S.store.rollback.hint) && S.store.upd.phase === 'idle', S.store.rollback.hint)
downloadFails = false
installFails = true
const inst4 = await S.rollbackAppUpdate()
ok('回退安装失败时给出可读提示', inst4 === null && /安装脚本/.test(S.store.rollback.hint), S.store.rollback.hint)
installFails = false

/* ---------- 4) 「不用了」清状态 ---------- */
await S.checkRollbackOnStart()
const before = calls.upClearSuspect
await S.dismissRollback()
ok('点「不用了」会通知主进程清掉状态', calls.upClearSuspect === before + 1)
ok('清完界面状态复位', S.store.rollback.suspect === false && S.store.rollback.from === '')

/* ---------- 5) 安装更新时把目标版本传给主进程（供看门狗记账） ---------- */
S.store.appUpdate = { ...S.store.appUpdate, latest: '0.1.9' }
S.store.upd = { ...S.store.upd, phase: 'ready', pkg: 'C:/temp/new.exe', toVersion: '0.1.9' }
calls.upInstall.length = 0
await S.installAppUpdate()
ok('安装传参带 toVersion', calls.upInstall[0] && calls.upInstall[0].toVersion === '0.1.9', JSON.stringify(calls.upInstall[0]))

console.log(out.join('\n'))
const failed = out.filter((l) => l.startsWith('FAIL')).length
console.log('')
console.log('FAILED=' + failed)
if (failed) process.exit(1)
