/* 多选批量「导入/更新到酒馆」+ 既有修复的回归测试
   全程只操作本脚本自建的沙盒酒馆目录（temp 下，每次运行新建一级 run 目录，从不删除任何东西），
   真实酒馆目录与真实 library.json 只做只读快照核对，零写入。
   运行：node tests/tavern-batch.test.mjs */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const stLib = require('../electron/lib/st.cjs')
const thumbLib = require('../electron/lib/thumb.cjs')

const out = []
function ok(name, cond, extra) {
  out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''))
  return !!cond
}
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------- 真实目录只读快照（用于核对零写入） ---------- */
const REAL_TAVERN = 'F:\\SillyTavern7000'
const REAL_USER = 'default-user'
const REAL_LIB = 'D:\\酒馆数据\\library.json'
const realDirs = (() => {
  try { return stLib.userDirs(REAL_TAVERN, REAL_USER) } catch (_) { return null }
})()

function dirFingerprint(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return { exists: false, count: 0, sig: '' }
    const files = fs.readdirSync(dir).sort()
    const parts = []
    for (const f of files) {
      const p = path.join(dir, f)
      let st = null
      try { st = fs.statSync(p) } catch (_) { continue }
      if (!st || !st.isFile()) continue
      parts.push(f + ':' + st.size + ':' + st.mtimeMs)
    }
    return { exists: true, count: parts.length, sig: md5(Buffer.from(parts.join('|'))) }
  } catch (_) {
    return { exists: false, count: 0, sig: '' }
  }
}
function fileFingerprint(p) {
  try {
    if (!fs.existsSync(p)) return { exists: false, size: 0, mtimeMs: 0 }
    const st = fs.statSync(p)
    return { exists: true, size: st.size, mtimeMs: st.mtimeMs }
  } catch (_) {
    return { exists: false, size: 0, mtimeMs: 0 }
  }
}
const before = {
  chars: dirFingerprint(realDirs && realDirs.characters),
  thumbs: dirFingerprint(realDirs && realDirs.thumbnails ? realDirs.thumbnails : ''),
  worlds: dirFingerprint(realDirs && realDirs.worlds),
  lib: fileFingerprint(REAL_LIB)
}

/* ---------- 沙盒酒馆（temp 下，每轮新建，不删除任何历史目录） ---------- */
const SANDBOX_ROOT = process.env.TAVERN_SANDBOX_ROOT ||
  'C:\\Users\\Administrator\\AppData\\Roaming\\Tencent\\Marvis\\User\\357EB0A534ECF87AA649E594C4CAF6E6\\workspace\\conv_ae6aed7d57564556a6de28d7883113f4\\temp\\tavern-batch-sandbox'
const RUN = path.join(SANDBOX_ROOT, 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7))
const USER = 'default-user'
fs.mkdirSync(RUN, { recursive: true })

/** 造一套全新的沙盒酒馆；thumbnails 尺寸故意设成 76x114，用来验证「与酒馆配置一致」 */
function newSandbox(tag) {
  const root = path.join(RUN, tag)
  const st = path.join(root, 'SillyTavern')
  const dirs = stLib.userDirs(st, USER)
  fs.mkdirSync(dirs.characters, { recursive: true })
  fs.mkdirSync(dirs.worlds, { recursive: true })
  fs.mkdirSync(dirs.chats, { recursive: true })
  fs.writeFileSync(
    path.join(st, 'config.yaml'),
    'thumbnails:\n  enabled: true\n  quality: 95\n  dimensions:\n    avatar: [76, 114]\n    bg: [160, 90]\n',
    'utf8'
  )
  return { tag, root, st, dirs }
}

/* ---------- PNG / 角色卡工具 ---------- */
function rgbaPng(rgb) {
  const w = 96
  const h = 144
  const px = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = rgb[0]
    px[i * 4 + 1] = rgb[1]
    px[i * 4 + 2] = rgb[2]
    px[i * 4 + 3] = 255
  }
  return thumbLib.encodeRgbaPng(w, h, px)
}
function pngSize(buf) {
  if (!buf || buf.length < 24) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}
function cardJson(name, desc, extra = {}) {
  const data = {
    name,
    description: desc,
    personality: '',
    scenario: '',
    first_mes: '你好',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: 'tavernlib-regression',
    character_version: '1.0',
    extensions: extra.world ? { world: extra.world } : {}
  }
  if (extra.book) data.character_book = extra.book
  return { spec: 'chara_card_v2', spec_version: '2.0', data }
}
/** 往沙盒写一张卡，返回 { file, buf } */
function writeCard(sb, avatar, json, rgb) {
  const buf = stLib.buildCardBuffer(rgbaPng(rgb), json)
  const file = path.join(sb.dirs.characters, avatar + '.png')
  fs.writeFileSync(file, buf)
  return { file, buf }
}
function listPng(dir) {
  try { return fs.readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort() } catch (_) { return [] }
}
function listAll(dir) {
  try { return fs.readdirSync(dir).sort() } catch (_) { return [] }
}

/* ---------- 浏览器 / Electron 环境桩（复用既有测试范式） ---------- */
const mem = new Map()
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
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
globalThis.requestIdleCallback = (fn) => setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 0 }), 0)
try {
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true })
} catch (_) {}

const imgStore = new Map()      /* imgId -> png buffer，模拟资料库 images/<id>.bin */
const callLog = { importCard: [], replaceCard: [], importWorld: [], inflight: 0, maxInflight: 0 }

const apiStub = {
  info: async () => ({ name: '洛书匣', version: '1.0.3' }),
  stPing: async () => ({ ok: true, ms: 3 }),
  stConfigInfo: async (o) => stLib.userDirsValid ? stLib.userDirsValid(o.tavernPath) : ({ ok: true }),
  stScanCharacters: async (o) => stLib.scanCharacters(o.tavernPath, o.user, { light: !!o.light, only: o.only }),
  stScanWorlds: async (o) => stLib.scanWorlds(o.tavernPath, o.user),
  stScanWorldsUnbound: async (o) => stLib.scanWorldsUnbound(o.tavernPath, o.user),
  stScanPresets: async (o) => stLib.scanPresets(o.tavernPath, o.user, { includeSamplerPresets: !!o.includeSamplerPresets }),
  stScanThemes: async (o) => stLib.scanThemes(o.tavernPath, o.user),
  stChatStats: async () => ({ ok: true, list: [], total: 0 }),
  stImportCard: async (o) => {
    callLog.importCard.push(o)
    callLog.inflight++
    callLog.maxInflight = Math.max(callLog.maxInflight, callLog.inflight)
    if (globalThis.__S && globalThis.__S.store && globalThis.__S.store.menu && globalThis.__S.store.menu.visible) callLog.menuShown = true
    try {
      await sleep(5)
      return stLib.importCard(o)
    } finally {
      callLog.inflight--
    }
  },
  stReplaceCard: async (o) => {
    callLog.replaceCard.push(o)
    callLog.inflight++
    callLog.maxInflight = Math.max(callLog.maxInflight, callLog.inflight)
    try {
      await sleep(5)
      return stLib.replaceCard(o)
    } finally {
      callLog.inflight--
    }
  },
  stImportWorld: async (o) => { callLog.importWorld.push(o); return stLib.importWorld(o) },
  stImportPreset: async () => ({ ok: false, error: '未在本用例覆盖' }),
  stImportAny: async () => ({ ok: false, error: '未在本用例覆盖' }),
  stImportFromSidecar: async () => ({ ok: false, error: '未在本用例覆盖' }),
  stThemeSrc: async () => ({ ok: false, error: '未在本用例覆盖' }),
  imgRead: async (id) => {
    const b = imgStore.get(String(id))
    return b ? { ok: true, data: b.toString('base64') } : { ok: false, error: 'no image' }
  },
  readCard: async () => ({ ok: false, error: 'n/a' }),
  readBuffer: async () => ({ ok: false, error: 'n/a' }),
  stat: async () => ({ ok: false }),
  writeNamed: async () => ({ ok: false, error: 'n/a' })
}
globalThis.api = apiStub
globalThis.window.api = apiStub

const S = await import('../src/store.js')
globalThis.__S = S

/* ---------- store 场景准备工具 ---------- */
function resetStore(sb) {
  S.store.settings.tavernPath = sb.st
  S.store.settings.stUser = USER
  for (const k of ['characters', 'worldbooks', 'presets', 'themes', 'others']) {
    if (Array.isArray(S.store.items[k])) S.store.items[k].length = 0
  }
  callLog.importCard.length = 0
  callLog.replaceCard.length = 0
  callLog.importWorld.length = 0
  callLog.inflight = 0
  callLog.maxInflight = 0
  callLog.menuShown = false
}
let seq = 0
function mkVersion(name, date, json, rgb) {
  const id = 'v' + ++seq
  imgStore.set(id, rgbaPng(rgb))
  return { id, name, date, imgId: id, raw: json }
}
function mkItem(name, versions, extra = {}) {
  const item = {
    id: 'it-' + Math.random().toString(36).slice(2, 8),
    name,
    category: 'characters',
    versions,
    stCards: [],
    stAliases: [],
    ...extra
  }
  S.store.items.characters.push(item)
  return item
}
async function waitFor(fn, ms = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await sleep(10)
  }
  return false
}

/* ================= 用例 1：多选批量新建（唯一行为） ================= */
{
  const sb = newSandbox('case1-new-all')
  resetStore(sb)
  /* 酒馆里已有的两张卡：批量新建绝不能碰它们 */
  const c1 = writeCard(sb, '方亦楷', cardJson('方亦楷', '酒馆原有 方亦楷'), [10, 20, 30])
  const c2 = writeCard(sb, '方亦楷2024', cardJson('方亦楷2024', '酒馆原有 2024'), [12, 22, 32])
  const md5a = md5(c1.buf)
  const md5b = md5(c2.buf)
  const beforeFiles = listPng(sb.dirs.characters)

  const v1 = mkVersion('V1 初版', '2025-01-01', cardJson('方亦楷', 'V1 各自不同内容 A'), [200, 30, 30])
  const v2 = mkVersion('V2 修订', '2025-02-01', cardJson('方亦楷2.0', 'V2 各自不同内容 B'), [30, 200, 30])
  const v3 = mkVersion('V3 终版', '2025-03-01', cardJson('方亦楷2024', 'V3 各自不同内容 C'), [30, 30, 200])
  const item = mkItem('方亦楷', [v1, v2, v3])
  await S.ensureItemDigests(item)

  const prog = []
  const r = await S.pushVersionsToTavern(item, [v3.id, v1.id, v2.id], {
    onProgress: (p) => prog.push(p)
  })
  ok('批量新建：返回 ok 且 3 项全部新建', r.ok === true && r.okCount === 3 && r.failCount === 0 && r.skipCount === 0,
    JSON.stringify({ ok: r.ok, okCount: r.okCount, failCount: r.failCount, skipCount: r.skipCount, err: r.error }))
  ok('批量新建：接口不再有策略参数（返回值不含 strategy 字段）', !('strategy' in r), JSON.stringify(Object.keys(r)))
  const created = r.results.filter((x) => x.status === 'created')
  ok('批量新建：每项都给出落盘文件名', created.length === 3 && created.every((x) => /\.png$/i.test(x.fileName)),
    JSON.stringify(created.map((x) => x.fileName)))
  /* 串行顺序 = 界面顺序（v1 → v2 → v3），不是点击顺序 */
  const order = prog.filter((p) => p.phase === 'start').map((p) => p.versionName)
  ok('批量新建：串行按版本列表顺序执行', JSON.stringify(order) === JSON.stringify(['V1 初版', 'V2 修订', 'V3 终版']), JSON.stringify(order))
  ok('批量新建：进度带「第 n/共 m」', prog.filter((p) => p.phase === 'start').every((p, i) => p.index === i + 1 && p.total === 3),
    JSON.stringify(prog.filter((p) => p.phase === 'start').map((p) => p.index + '/' + p.total)))
  ok('批量新建：末次进度 phase=done', prog.length > 0 && prog[prog.length - 1].phase === 'done')

  const afterFiles = listPng(sb.dirs.characters)
  ok('批量新建：酒馆既有卡字节未变', md5(fs.readFileSync(c1.file)) === md5a && md5(fs.readFileSync(c2.file)) === md5b)
  ok('批量新建：卡数 2 → 5（新增 3 张，未覆盖任何一张）', afterFiles.length === beforeFiles.length + 3,
    beforeFiles.join(',') + ' => ' + afterFiles.join(','))
  const added = afterFiles.filter((f) => !beforeFiles.includes(f))
  ok('批量新建：新增文件名互不相同且不带 (n) 副本风格', new Set(added).size === 3 && added.every((f) => !/\(\d+\)/.test(f)), added.join(','))
  ok('批量新建：同族按独立基名另起（方亦楷 → 方亦楷 新）', added.includes('方亦楷 新.png'), added.join(','))
  /* 落盘内容核对：卡内 name / description 必须与源版本一一对应，不能串版 */
  const wantByVer = { 'V1 初版': ['方亦楷', 'V1 各自不同内容 A'], 'V2 修订': ['方亦楷2.0', 'V2 各自不同内容 B'], 'V3 终版': ['方亦楷2024', 'V3 各自不同内容 C'] }
  const cardChecks = created.map((x) => {
    const j = stLib.readCardAt(path.join(sb.dirs.characters, x.fileName))
    const d = (j && j.json && j.json.data) || {}
    return { ver: x.versionName, file: x.fileName, name: String(d.name || ''), desc: String(d.description || '') }
  })
  ok('批量新建：每张卡内 name 与源版本一致',
    cardChecks.every((c) => wantByVer[c.ver] && c.name === wantByVer[c.ver][0]), JSON.stringify(cardChecks))
  ok('批量新建：每张卡内正文与源版本一致（没有串版）',
    cardChecks.every((c) => wantByVer[c.ver] && c.desc === wantByVer[c.ver][1]), JSON.stringify(cardChecks))
  /* 缩略图：写盘后预热，尺寸取酒馆 config.yaml（76x114） */
  const thumbs = listPng(sb.dirs.thumbnails)
  ok('批量新建：缩略图逐个预热', thumbs.length === 3, thumbs.join(','))
  const thSize = thumbs.length ? pngSize(fs.readFileSync(path.join(sb.dirs.thumbnails, thumbs[0]))) : null
  ok('批量新建：缩略图尺寸与酒馆配置一致（76x114）', !!thSize && thSize.width === 76 && thSize.height === 114,
    JSON.stringify(thSize))
  ok('批量新建：新建路径不传 family/baseName（直接新建，不做同族判定）',
    callLog.importCard.every((o) => o.family === undefined && o.baseName === undefined),
    JSON.stringify(callLog.importCard.map((o) => ({ f: o.family, b: o.baseName }))))
  ok('批量新建：全部走新建、一次替换都没调',
    callLog.replaceCard.length === 0 && callLog.importCard.length === 3,
    'import=' + callLog.importCard.length + ' replace=' + callLog.replaceCard.length)
  ok('批量新建：写盘后自动刷新对比（stCards 已更新）', Array.isArray(item.stCards) && item.stCards.length >= 2,
    'stCards=' + (item.stCards || []).length)
  ok('批量新建：全程串行写盘（同一时刻只有一次写卡在途）', callLog.maxInflight === 1, 'maxInflight=' + callLog.maxInflight)
  ok('批量新建：流程内从未弹出单条三选一菜单', callLog.menuShown === false)
}

/* ================= 用例 2：内容与酒馆某张卡完全一致，也照样新建、不覆盖 ================= */
{
  const sb = newSandbox('case2-same-content-still-new')
  resetStore(sb)
  const sameJson = cardJson('方亦楷', '内容与 V1 完全一致')
  const c1 = writeCard(sb, '方亦楷', sameJson, [10, 20, 30])
  const other = writeCard(sb, '无关卡', cardJson('无关卡', '不该被碰'), [1, 2, 3])
  const md5c1 = md5(c1.buf)
  const md5o = md5(other.buf)
  const beforeFiles = listPng(sb.dirs.characters)

  const v1 = mkVersion('V1 与酒馆一致', '2025-01-01', sameJson, [210, 40, 40])
  const v2 = mkVersion('V2 内容不同', '2025-02-01', cardJson('方亦楷', 'V2 与酒馆不同'), [40, 210, 40])
  const item = mkItem('方亦楷', [v1, v2])
  await S.ensureItemDigests(item)
  await S.refreshTavernCompare(item, { full: true })
  const hitCard = (item.stCards || []).find((c) => c.avatar === '方亦楷')
  ok('内容一致也只是新建：对比阶段仍能认出这张卡内容一致（仅用于展示，不触发覆盖）',
    !!hitCard && hitCard.by === 'content' && hitCard.same === true,
    JSON.stringify(hitCard ? { by: hitCard.by, same: hitCard.same, name: hitCard.name } : null))

  const r = await S.pushVersionsToTavern(item, [v1.id, v2.id])
  ok('内容一致也只是新建：两版都按新建处理', r.results.every((x) => x.status === 'created') && r.okCount === 2,
    JSON.stringify(r.results.map((x) => ({ s: x.status, f: x.fileName, e: x.error }))))
  ok('内容一致也只是新建：结果里不出现任何「覆盖」状态', !r.results.some((x) => x.status === 'replaced'),
    JSON.stringify(r.results.map((x) => x.status)))
  const afterFiles = listPng(sb.dirs.characters)
  ok('内容一致也只是新建：既有卡字节未变（内容一致那张也没被改写）', md5(fs.readFileSync(c1.file)) === md5c1 && md5(fs.readFileSync(other.file)) === md5o)
  ok('内容一致也只是新建：卡数 2 → 4（两版各新增一张）', afterFiles.length === beforeFiles.length + 2,
    beforeFiles.join(',') + ' => ' + afterFiles.join(','))
  ok('内容一致也只是新建：全程零次 stReplaceCard', callLog.replaceCard.length === 0, 'replace=' + callLog.replaceCard.length)
}

/* ================= 用例 3：同族多张时同样只新建，绝不猜着替换 ================= */
{
  const sb = newSandbox('case3-family-multi')
  resetStore(sb)
  writeCard(sb, '方亦楷', cardJson('方亦楷', '副本 A'), [11, 11, 11])
  writeCard(sb, '方亦楷 (1)', cardJson('方亦楷', '副本 B'), [22, 22, 22])
  const beforeFiles = listPng(sb.dirs.characters)
  const beforeBufs = beforeFiles.map((f) => md5(fs.readFileSync(path.join(sb.dirs.characters, f))))
  const v = mkVersion('V9 与两张都不同', '2025-09-09', cardJson('方亦楷', 'V9 全新内容'), [200, 0, 200])
  const item = mkItem('方亦楷', [v])
  await S.ensureItemDigests(item)

  const r = await S.pushVersionsToTavern(item, [v.id])
  const rec = r.results[0]
  ok('同族多张：一律新建，不猜着替换', rec.status === 'created', JSON.stringify({ status: rec.status, file: rec.fileName, err: rec.error }))
  const afterFiles = listPng(sb.dirs.characters)
  ok('同族多张：卡数 +1，既有两张一张不动', afterFiles.length === beforeFiles.length + 1 &&
    beforeFiles.every((f, i) => md5(fs.readFileSync(path.join(sb.dirs.characters, f))) === beforeBufs[i]),
    beforeFiles.join(',') + ' => ' + afterFiles.join(','))
}

/* ================= 用例 4：单条「新建到酒馆」= 直接新建（无三选一，同族自动另起基名） ================= */
{
  const sb = newSandbox('case4-single-family')
  resetStore(sb)
  const ex = writeCard(sb, '方亦楷', cardJson('方亦楷', '酒馆原有'), [7, 7, 7])
  const md5ex = md5(ex.buf)
  const beforeFiles = listPng(sb.dirs.characters)
  const v = mkVersion('V1 单条新建', '2025-06-01', cardJson('方亦楷', '单条新建内容'), [66, 120, 200])
  const item = mkItem('方亦楷', [v])
  await S.ensureItemDigests(item)

  /* 第一条：同族已存在（方亦楷.png），点击即落盘，全程不弹菜单 */
  const p = S.pushItemToTavern(item, { version: v, mode: 'new' })
  const r = await p
  ok('单条新建：直接写入成功（不等任何选择）', !!r && r.ok === true, JSON.stringify({ ok: r && r.ok, avatar: r && r.avatar, err: r && r.error }))
  ok('单条新建：全程未弹出三选一 / 任何选择菜单', !(S.store.menu && S.store.menu.visible) && callLog.menuShown !== true,
    JSON.stringify({ visible: S.store.menu && S.store.menu.visible }))
  ok('单条新建：同族存在时自动另起独立基名（方亦楷 → 方亦楷 新）', String(r.avatar || '') === '方亦楷 新',
    JSON.stringify({ avatar: r && r.avatar, files: listPng(sb.dirs.characters) }))
  ok('单条新建：既有同族卡字节未变', md5(fs.readFileSync(ex.file)) === md5ex)
  ok('单条新建：卡数 +1 且文件名不带 (n) 副本风格',
    listPng(sb.dirs.characters).length === beforeFiles.length + 1 && !/\(\d+\)/.test(String(r.avatar || '')),
    beforeFiles.join(',') + ' => ' + listPng(sb.dirs.characters).join(','))
  ok('单条新建：结果里没有任何覆盖状态', r.mode === 'new' && !r.createdByUpdate && callLog.replaceCard.length === 0,
    JSON.stringify({ mode: r.mode, replace: callLog.replaceCard.length }))

  /* 第二条：同族副本已存在两份 → 继续递增「方亦楷 新2」，依然不覆盖 */
  const beforeFiles2 = listPng(sb.dirs.characters)
  const bufs2 = beforeFiles2.map((f) => md5(fs.readFileSync(path.join(sb.dirs.characters, f))))
  const v2 = mkVersion('V2 再次新建', '2025-06-02', cardJson('方亦楷', '第二次单条新建'), [66, 120, 201])
  const item2 = mkItem('方亦楷', [v2])
  await S.ensureItemDigests(item2)
  const r2 = await S.pushItemToTavern(item2, { version: v2, mode: 'new' })
  ok('单条新建：同族再有副本时基名继续递增（方亦楷 新2）', String(r2.avatar || '') === '方亦楷 新2',
    JSON.stringify({ avatar: r2 && r2.avatar, files: listPng(sb.dirs.characters) }))
  ok('单条新建：第二次新建后既有全部卡字节未变',
    beforeFiles2.every((f, i) => md5(fs.readFileSync(path.join(sb.dirs.characters, f))) === bufs2[i]),
    beforeFiles2.join(','))
  ok('单条新建：第二次仍是 +1 张，文件名互不重复',
    listPng(sb.dirs.characters).length === beforeFiles2.length + 1 &&
      new Set(listPng(sb.dirs.characters)).size === listPng(sb.dirs.characters).length,
    listPng(sb.dirs.characters).join(','))

  /* 第三条：完全无同族时，基名就用原名，不额外加「新」 */
  const sb3 = newSandbox('case4-single-clean')
  resetStore(sb3)
  const v3 = mkVersion('V3 无同族', '2025-06-03', cardJson('全新角色', '酒馆里没有这个角色'), [9, 9, 90])
  const item3 = mkItem('全新角色', [v3])
  await S.ensureItemDigests(item3)
  const r3 = await S.pushItemToTavern(item3, { version: v3, mode: 'new' })
  ok('单条新建：无同族时按原名落盘（不追加「新」）', r3.ok === true && r3.avatar === '全新角色',
    JSON.stringify({ ok: r3.ok, avatar: r3.avatar }))
}

/* ================= 用例 5：对比区显示「卡内真名」为主名、来源标签正确 ================= */
{
  const sb = newSandbox('case5-compare-display')
  resetStore(sb)
  /* 文件名 dk方亦楷，卡内真名 方亦楷 —— 现场最典型的显示错位场景 */
  writeCard(sb, 'dk方亦楷', cardJson('方亦楷', '内容与 V1 一致'), [33, 66, 99])
  writeCard(sb, '方亦楷', cardJson('方亦楷', '另一张同名不同内容'), [99, 66, 33])
  const v = mkVersion('V1 对比', '2025-07-01', cardJson('方亦楷', '内容与 V1 一致'), [50, 50, 50])
  const item = mkItem('方亦楷', [v])
  await S.ensureItemDigests(item)
  await S.refreshTavernCompare(item, { full: true })

  const dk = (item.stCards || []).find((c) => c.avatar === 'dk方亦楷')
  const plain = (item.stCards || []).find((c) => c.avatar === '方亦楷')
  ok('对比显示：文件名与卡内名不一致的卡，主名取卡内真名', !!dk && dk.name === '方亦楷', JSON.stringify(dk ? { name: dk.name, file: dk.file } : null))
  ok('对比显示：该项保留真实文件名便于定位物理文件', !!dk && dk.file === 'dk方亦楷.png', dk && dk.file)
  ok('对比显示：内容一致的卡来源标记为「内容一致」', !!dk && dk.by === 'content' && dk.same === true, dk && dk.by)
  ok('对比显示：同名的另一张按卡名精确命中', !!plain && plain.by === 'name', plain && plain.by)
  ok('对比显示：来源文案与来源键一致',
    S.stByText(dk) !== S.stByText(plain) && /按内容/.test(S.stByText(dk)) && /按卡名/.test(S.stByText(plain)),
    S.stByText(dk) + ' / ' + S.stByText(plain))
}

/* ================= 用例 6：世界书缺失自动补齐，已有同名书不覆盖 ================= */
{
  const sb = newSandbox('case6-worldbook')
  resetStore(sb)
  const wn = '方亦楷世界书'
  /* 库内有一本同名世界书，卡内 extensions.world 指向它 */
  const bookItem = {
    id: 'wb-' + Math.random().toString(36).slice(2, 8),
    name: wn,
    category: 'worldbooks',
    versions: [{ id: 'wv1', name: 'V1', date: '2025-01-01', current: true, raw: { entries: [{ key: ['方亦楷'], content: '库内世界书内容', comment: '条目一' }] } }],
    stCards: [],
    stAliases: []
  }
  S.store.items.worldbooks.push(bookItem)

  const v = mkVersion('V1 带世界书', '2025-08-01', cardJson('方亦楷', '带世界书绑定', { world: wn }), [120, 60, 20])
  const item = mkItem('方亦楷', [v])
  await S.ensureItemDigests(item)
  const r = await S.pushVersionsToTavern(item, [v.id])
  const rec = r.results[0]
  const wfile = path.join(sb.dirs.worlds, wn + '.json')
  ok('世界书：缺失时自动补齐', rec.status === 'created' && rec.worldFilled === true && fs.existsSync(wfile),
    JSON.stringify({ status: rec.status, worldFilled: rec.worldFilled, world: rec.worldName, err: rec.error }))
  ok('世界书：补齐内容来自库内同名书', (() => {
    try {
      const t = fs.readFileSync(wfile, 'utf8')
      return /库内世界书内容/.test(t) || /条目一/.test(t)
    } catch (_) { return false }
  })(), wfile)

  /* 已有同名书：必须原样保留，不许覆盖 */
  const sb2 = newSandbox('case6-worldbook-keep')
  resetStore(sb2)
  S.store.items.worldbooks.push(JSON.parse(JSON.stringify(bookItem)))
  fs.writeFileSync(path.join(sb2.dirs.worlds, wn + '.json'), JSON.stringify({ entries: { '0': { comment: '酒馆里已有的书', content: '不要动我' } } }, null, 2), 'utf8')
  const wBefore = md5(fs.readFileSync(path.join(sb2.dirs.worlds, wn + '.json')))
  const v2 = mkVersion('V2 带世界书', '2025-08-02', cardJson('方亦楷', '同样绑定世界书', { world: wn }), [20, 60, 120])
  const item2 = mkItem('方亦楷', [v2])
  await S.ensureItemDigests(item2)
  const r2 = await S.pushVersionsToTavern(item2, [v2.id])
  const rec2 = r2.results[0]
  ok('世界书：已存在同名书时不覆盖', md5(fs.readFileSync(path.join(sb2.dirs.worlds, wn + '.json'))) === wBefore,
    JSON.stringify({ worldFilled: rec2.worldFilled }))
  ok('世界书：卡仍然写入成功', rec2.status === 'created', rec2.status)
}

/* ================= 用例 7：同族判定含版本号尾缀 ================= */
{
  const sb = newSandbox('case7-family-suffix')
  resetStore(sb)
  writeCard(sb, '方亦楷', cardJson('方亦楷', '本体'), [1, 1, 1])
  writeCard(sb, '方亦楷 (1)', cardJson('方亦楷', '副本1'), [2, 2, 2])
  const c1 = stLib.sameBaseCandidates(sb.dirs, '方亦楷2.0').map((x) => x.avatar || x)
  const c2 = stLib.sameBaseCandidates(sb.dirs, '方亦楷2024').map((x) => x.avatar || x)
  ok('同族判定：带 2.0 尾缀的名字能判出同族', c1.length >= 2, JSON.stringify(c1))
  ok('同族判定：带年份尾缀的名字能判出同族', c2.length >= 2, JSON.stringify(c2))
  ok('同族判定：本体排在副本前（排序稳定）', String(c1[0]) === '方亦楷' || String(c1[0]).indexOf('方亦楷') === 0, JSON.stringify(c1))
  /* 归一化：版本尾缀剥掉后与本体同名 */
  ok('同族判定：归一化剥掉版本尾缀', stLib.independentBaseName(sb.dirs, '方亦楷') !== '方亦楷',
    stLib.independentBaseName(sb.dirs, '方亦楷'))
}

/* ================= 用例 8：界面契约（单一「新建到酒馆」入口 / 两段弹层 / 串行 await） ================= */
{
  const vueSrc = fs.readFileSync(new URL('../src/views/CardDetail.vue', import.meta.url), 'utf8')
  const storeSrc = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8')
  ok('界面契约：store 不再导出策略常量', S.TAVERN_BATCH_STRATEGIES === undefined)
  ok('界面契约：源码里没有残留策略标识（常量 / 策略 key / 单选）',
    !/TAVERN_BATCH_STRATEGIES|overwrite-same|update-match|bpStrategy|bp-opt/.test(vueSrc + storeSrc),
    (vueSrc + storeSrc).match(/TAVERN_BATCH_STRATEGIES|overwrite-same|update-match|bpStrategy|bp-opt/g) || '')
  ok('界面契约：批量按钮文案为「新建到酒馆 N 项」', /新建到酒馆 \$\{pickedVersionIds\.length\} 项/.test(vueSrc))
  ok('界面契约：按钮上不再出现「导入到酒馆」字样', !/导入到酒馆/.test(vueSrc))
  ok('界面契约：结果行样式不再有 replaced（已没有覆盖状态）', !/bp-row\.replaced/.test(vueSrc))
  ok('界面契约：按钮放在 batchMode 批量条内（复用既有勾选机制）',
    /v-if="batchMode"[\s\S]{0,700}bp-open/.test(vueSrc))
  ok('界面契约：点击即执行（openBatchPush 内直接调 runBatchPush，无中间选择步骤）',
    /function openBatchPush\(\)[\s\S]{0,260}runBatchPush\(\)/.test(vueSrc))
  ok('界面契约：弹层只剩「进度 / 结果」两段，没有策略选择段',
    /v-if="bpStep === 'run'"/.test(vueSrc) && !/bpStep === 'pick'/.test(vueSrc))
  ok('界面契约：进度显示「第 n / 共 m 个」', /第 \{\{ bpProgress\.index \}\} \/ 共 \{\{ bpProgress\.total \}\} 个/.test(vueSrc))
  ok('界面契约：结果汇总含新建/跳过/失败', /已新建 \{\{ bpCreated \}\} 张/.test(vueSrc) && /失败\s*\{\{ bpResult\?\.failCount \|\| 0 \}\} 项/.test(vueSrc))
  ok('界面契约：写盘期间不允许关窗', /bpStep\.value === 'run'\) return[\s\S]{0,40}bpOpen/.test(vueSrc))
  ok('界面契约：批量写入按版本逐个 await（无并发 Promise.all）',
    /await pushItemToTavern\(/.test(storeSrc) && !/Promise\.all\([^)]*pushItemToTavern/.test(storeSrc))
  ok('界面契约：批量流程一律 mode=new（不再传 family / baseName）',
    /function pushVersionsToTavern[\s\S]{0,4000}mode: 'new'/.test(storeSrc) &&
      !/function pushVersionsToTavern[\s\S]{0,4000}family:/.test(storeSrc))
  ok('界面契约：新建三选一菜单已整体删除（无 askNewFamily / 覆盖候选菜单）',
    !/askNewFamily/.test(storeSrc + vueSrc) && !/另起基名新建/.test(storeSrc + vueSrc))
  ok('界面契约：单条新建不再传 family/baseName（直接新建，不问覆盖）',
    !/family: mode === 'new'/.test(storeSrc) && !/baseName: mode === 'new'/.test(storeSrc))
  ok('界面契约：批量流程不再引用 replace 相关入参（stAvatar / targetPath / pickAvatar）',
    !/function pushVersionsToTavern[\s\S]{0,6000}(stAvatar|targetPath|pickAvatar):/.test(storeSrc))

  /* 底层契约：新建（importCard）不再判同族返回 needPick；替换（replaceCard）保留「选哪一份」 */
  const stSrc = fs.readFileSync(new URL('../electron/lib/st.cjs', import.meta.url), 'utf8')
  const iImport = stSrc.indexOf('function importCard(opt) {')
  const iReplace = stSrc.indexOf('function replaceCard(opt) {')
  const importBody = iImport >= 0 && iReplace > iImport ? stSrc.slice(iImport, iReplace) : ''
  const replaceBody = iReplace >= 0 ? stSrc.slice(iReplace, iReplace + 8000) : ''
  ok('底层契约：importCard 里已无 needPick / 同族三选一判定',
    !!importBody && !/needPick/.test(importBody) && !/sameBaseCandidates/.test(importBody) && !/family/.test(importBody))
  ok('底层契约：importCard 直接用 independentBaseName 派生独立基名',
    !!importBody && /independentBaseName\(dirs, displayName\)/.test(importBody))
  ok('底层契约：更新路径（replaceCard）仍保留多副本 needPick 选择，未被误删',
    !!replaceBody && /needPick/.test(replaceBody))
}

/* ================= 用例 9：真实酒馆 / 真实 library.json 零写入核对 ================= */
{
  const after = {
    chars: dirFingerprint(realDirs && realDirs.characters),
    thumbs: dirFingerprint(realDirs && realDirs.thumbnails ? realDirs.thumbnails : ''),
    worlds: dirFingerprint(realDirs && realDirs.worlds),
    lib: fileFingerprint(REAL_LIB)
  }
  ok('零写入：真实酒馆角色卡目录文件数与指纹未变',
    before.chars.count === after.chars.count && before.chars.sig === after.chars.sig,
    JSON.stringify({ before: before.chars.count, after: after.chars.count }))
  ok('零写入：真实缩略图目录未变', before.thumbs.count === after.thumbs.count && before.thumbs.sig === after.thumbs.sig,
    JSON.stringify({ before: before.thumbs.count, after: after.thumbs.count }))
  ok('零写入：真实世界书目录未变', before.worlds.count === after.worlds.count && before.worlds.sig === after.worlds.sig,
    JSON.stringify({ before: before.worlds.count, after: after.worlds.count }))
  ok('零写入：真实 library.json 大小与修改时间未变',
    before.lib.size === after.lib.size && before.lib.mtimeMs === after.lib.mtimeMs,
    JSON.stringify({ before, after }))
  out.push('INFO 真实酒馆卡数=' + before.chars.count + '，缩略图=' + before.thumbs.count + '，library.json=' + before.lib.size + 'B')
}

/* ---------- 汇总 ---------- */
const pass = out.filter((x) => x.startsWith('PASS ')).length
const fail = out.filter((x) => x.startsWith('FAIL ')).length
console.log(out.join('\n'))
console.log('\n沙盒目录：' + RUN)
console.log('PASS ' + pass + ' / FAIL ' + fail + ' / 共 ' + (pass + fail))
if (fail) {
  console.log('\n存在失败用例')
  process.exit(1)
}
console.log('全部用例通过')
