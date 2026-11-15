/* 权威源回归测试：数据目录里的 library.json 是唯一真相，localStorage 只留时间戳缓存
 *
 * 覆盖四件事：
 *   ① 旧 localStorage（整库缓存）不得覆盖较新的 library.json
 *   ② 外部改写 library.json 后：启动生效、运行期轮询（syncFromDataFile）生效
 *   ③ library.json 缺失时回落 localStorage，并立刻补写 json
 *   ④ 外部删掉的条目重启后不复活（整体覆盖，不做按 id 并集合并）
 *
 * 做法：Node 里给 window.api / localStorage 打桩，跑真实 src/store.js。
 * 「重启」用 import 带不同 query 拿到全新模块实例来模拟（模块级状态全部重置，
 * localStorage 桩对象跨实例共享 —— 和真实重启一致）。
 */

const mem = new Map() // 模拟 localStorage（跨「重启」保留）
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)) },
  removeItem: (k) => { mem.delete(k) },
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size }
}

/* ---------- 模拟数据目录里的 library.json ---------- */
const DISK = { exists: false, text: '', mtimeMs: 0 }

function writeDisk(obj, savedAt) {
  const snap = obj && obj.items ? obj : { items: obj, settings: {}, savedAt: savedAt || new Date().toISOString() }
  if (savedAt) snap.savedAt = savedAt
  DISK.text = JSON.stringify(snap)
  DISK.exists = true
  DISK.mtimeMs += 1
  return snap
}

function readDisk() {
  if (!DISK.exists) return null
  try { return JSON.parse(DISK.text) } catch (_) { return null }
}

globalThis.window = {
  api: {
    loadLibrary: async () => (DISK.exists
      ? { ok: true, text: DISK.text, mtimeMs: DISK.mtimeMs, size: DISK.text.length }
      : { ok: false, error: 'NO_SNAPSHOT' }),
    saveLibrary: async (text) => {
      DISK.text = String(text == null ? '' : text)
      DISK.exists = true
      DISK.mtimeMs += 1
      return { ok: true, path: 'sandbox/library.json', mtimeMs: DISK.mtimeMs, size: DISK.text.length }
    },
    dataPutFile: async () => ({ ok: true }),
    dataReadFile: async () => ({ ok: false }),
    imgSave: async () => ({ ok: true }),
    imgRead: async () => ({ ok: false })
  }
}

/* ---------- 测试脚手架 ---------- */
const out = []
function ok(name, cond, extra) {
  out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''))
  return !!cond
}

const ITEMS_KEY = 'tavern-lib-items'
let seq = 0
/** 模拟「重启软件」：拿一个全新模块实例（模块级状态全重置，localStorage 桩不变） */
function boot() {
  seq += 1
  return import('../src/store.js?restart=' + seq + '-' + Date.now())
}

const mkItem = (id, name = id) => ({
  id,
  name,
  note: '',
  versions: [{
    id: id + '-v1',
    label: '第1版',
    at: '2026-11-01T00:00:00.000Z',
    current: true,
    raw: { name, first_mes: '开场白：' + name }
  }]
})

const idsOf = (S) => (S.store.items.characters || []).map((it) => it.id).sort()
const totalOf = (S) => ['characters', 'worldbooks', 'presets', 'themes', 'others']
  .reduce((n, k) => n + ((S.store.items[k] || []).length), 0)

/** 轮询等待某个条件成立（防抖落盘是异步的，不能靠固定 sleep 猜时间） */
async function waitFor(fn, timeout = 4000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    let r = false
    try { r = !!fn() } catch (_) { r = false }
    if (r) return true
    await new Promise((res) => setTimeout(res, 60))
  }
  return false
}

/** 老版本留下的整库缓存（localStorage 里塞着完整条目） */
function seedLegacyCache(ids) {
  mem.set(ITEMS_KEY, JSON.stringify({
    characters: ids.map((id) => mkItem(id)),
    worldbooks: [],
    presets: [],
    themes: [],
    others: []
  }))
}

/* ================= ① 旧 localStorage 不覆盖较新 json ================= */
mem.clear()
seedLegacyCache(['cache-1', 'cache-2', 'cache-3'])
writeDisk({ characters: [mkItem('json-1'), mkItem('json-2')] }, '2026-11-15T08:00:00.000Z')

let S = await boot()
ok('① 模块启动时旧缓存先垫底（3 条）', totalOf(S) === 3, '实际 ' + totalOf(S))

await S.hydrateFromDataFile()
ok('① 启动以 json 为准（2 条，缓存里的 3 条不覆盖）', totalOf(S) === 2, '实际 ' + totalOf(S))
ok('① 条目来自 json 而非缓存', JSON.stringify(idsOf(S)) === JSON.stringify(['json-1', 'json-2']), idsOf(S).join(','))
const stamp1 = JSON.parse(mem.get(ITEMS_KEY) || '{}')
ok('① localStorage 降级为时间戳（不再存条目正文）', !Array.isArray(stamp1.characters) && !!stamp1.savedAt,
  '内容 ' + String(mem.get(ITEMS_KEY)).slice(0, 80))
ok('① 缓存戳 savedAt 与 json 一致', stamp1.savedAt === '2026-11-15T08:00:00.000Z', stamp1.savedAt)

/* ================= ③ 保存链路：savedAt + 本地戳 ================= */
S.store.items.characters.push(mkItem('local-new'))
S.saveItems()
const wrote = await waitFor(() => (readDisk()?.items?.characters || []).length === 3)
const diskAfterSave = readDisk()
ok('③ saveItems 防抖后把新条目写进 library.json', wrote && !!diskAfterSave,
  'characters=' + (diskAfterSave?.items?.characters || []).length)
ok('③ json 里同时写了 savedAt 与 savedLocalAt',
  !!diskAfterSave?.savedAt && !!diskAfterSave?.savedLocalAt,
  'savedAt=' + diskAfterSave?.savedAt + ' savedLocalAt=' + diskAfterSave?.savedLocalAt)
const stamp2 = JSON.parse(mem.get(ITEMS_KEY) || '{}')
ok('③ localStorage 存的 savedAt 跟着更新', stamp2.savedAt === diskAfterSave.savedAt,
  'cache=' + stamp2.savedAt + ' json=' + diskAfterSave.savedAt)

/* ================= ② 外部改写 json：运行期同步生效 ================= */
/* 先把手里的改动落盘，进入「内存与磁盘一致」的静止状态（等价于用户停止编辑后） */
await S.flushSnapshot()
/* 手工把 json 改成只剩 1 条（模拟人工清理库） */
writeDisk({ characters: [mkItem('ext-1')] }, '2026-11-15T09:00:00.000Z')
const changed = await S.syncFromDataFile({ notify: false })
ok('② 运行期同步检测到外部改写', changed === true, 'changed=' + changed)
ok('② 外部改写整体覆盖内存（旧条目一并清掉，不做并集）',
  JSON.stringify(idsOf(S)) === JSON.stringify(['ext-1']), idsOf(S).join(','))

const again = await S.syncFromDataFile({ notify: false })
ok('② 时间戳没动时不重复拉取', again === false, 'changed=' + again)

/* 轮询：App.vue 里 startLibrarySync 走的就是 syncFromDataFile，这里覆盖其注册/停止 */
const timer = S.startLibrarySync()
ok('② 定时轮询可注册', !!timer)
S.stopLibrarySync()
ok('② 定时轮询可停止', true)

/* 外部再改一次 + 另一处启用轮询调用的同一入口 */
writeDisk({ characters: [mkItem('ext-2'), mkItem('ext-3')] }, '2026-11-15T10:00:00.000Z')
const nowChanged = await S.syncLibraryNow()
ok('② 聚焦/可见性触发的 syncLibraryNow 生效', nowChanged === true &&
  JSON.stringify(idsOf(S)) === JSON.stringify(['ext-2', 'ext-3']), idsOf(S).join(','))

/* 外部改写后「重启」也生效 */
writeDisk({ characters: [mkItem('ext-9')] }, '2026-11-15T11:00:00.000Z')
S = await boot()
await S.hydrateFromDataFile()
ok('② 外部改写后重启生效', JSON.stringify(idsOf(S)) === JSON.stringify(['ext-9']), idsOf(S).join(','))

/* ================= ④ 外部删条目后重启不复活 ================= */
writeDisk({ characters: [mkItem('keep-1'), mkItem('gone-1')] }, '2026-11-15T12:00:00.000Z')
S = await boot()
await S.hydrateFromDataFile()
ok('④ 前置：两条都在', totalOf(S) === 2, '实际 ' + totalOf(S))
await new Promise((r) => setTimeout(r, 50))
/* 外部把 gone-1 删掉 */
writeDisk({ characters: [mkItem('keep-1')] }, '2026-11-15T13:00:00.000Z')
S = await boot() // 重启
await S.hydrateFromDataFile()
ok('④ 删掉的条目不复活（重启后只剩 keep-1）',
  JSON.stringify(idsOf(S)) === JSON.stringify(['keep-1']), idsOf(S).join(','))

/* 同一会话内外部删除也立即生效且不复活 */
writeDisk({ characters: [] }, '2026-11-15T14:00:00.000Z')
await S.syncFromDataFile({ notify: false })
ok('④ 外部清空后内存同步清空', totalOf(S) === 0, '实际 ' + totalOf(S))
await new Promise((r) => setTimeout(r, 50))
writeDisk({ characters: [mkItem('keep-2')] }, '2026-11-15T15:00:00.000Z')
await S.syncFromDataFile({ notify: false })
ok('④ 清空后旧条目没有被缓存反填回来', JSON.stringify(idsOf(S)) === JSON.stringify(['keep-2']), idsOf(S).join(','))

/* ================= ⑤ json 缺失：回落 localStorage 并补写 ================= */
mem.clear()
seedLegacyCache(['fb-1', 'fb-2'])
DISK.exists = false
DISK.text = ''
S = await boot()
ok('⑤ json 缺失时先按缓存垫底', totalOf(S) === 2, '实际 ' + totalOf(S))
const hydrated = await S.hydrateFromDataFile()
ok('⑤ 缺失时 hydrate 返回 false（没有可拉取的 json）', hydrated === false, 'return=' + hydrated)
await new Promise((r) => setTimeout(r, 80))
const repaired = readDisk()
ok('⑤ 回落内容已补写回 library.json', !!repaired && Array.isArray(repaired.items?.characters) &&
  repaired.items.characters.length === 2, 'characters=' + (repaired?.items?.characters || []).length)
ok('⑤ 补写的 json 带 savedAt / savedLocalAt', !!repaired?.savedAt && !!repaired?.savedLocalAt,
  'savedAt=' + repaired?.savedAt)

/* json 损坏也走回落 + 补写 */
mem.clear()
seedLegacyCache(['bad-1'])
DISK.exists = true
DISK.text = '{"items":{坏的json'
DISK.mtimeMs += 1
S = await boot()
const badHydrated = await S.hydrateFromDataFile()
await new Promise((r) => setTimeout(r, 80))
const badRepaired = readDisk()
ok('⑤ json 损坏时回落缓存', totalOf(S) === 1 && JSON.stringify(idsOf(S)) === JSON.stringify(['bad-1']), idsOf(S).join(','))
ok('⑤ json 损坏后已重写成合法 json', badHydrated === false && !!badRepaired?.items?.characters?.length,
  'characters=' + (badRepaired?.items?.characters || []).length)

/* ================= ⑥ 空内存不得把磁盘上的库写空（启动保护） ================= */
mem.clear() // 新格式：localStorage 无条目
writeDisk({ characters: [mkItem('safe-1'), mkItem('safe-2')] }, '2026-11-15T16:00:00.000Z')
S = await boot()
/* 模拟某个启动早期路径调了 saveItems（内存还是空的、json 还没读进来） */
S.saveItems()
await new Promise((r) => setTimeout(r, 80))
const guarded = readDisk()
ok('⑥ 启动恢复前空内存不会把 json 写空', (guarded?.items?.characters || []).length === 2,
  'characters=' + (guarded?.items?.characters || []).length)
await S.hydrateFromDataFile()
ok('⑥ 恢复后条目正常', totalOf(S) === 2, '实际 ' + totalOf(S))

/* ================= ⑦ 覆盖前排队未落盘的旧内容不得晚一步写回 ================= */
/* 场景：用户刚改完（防抖 600ms 还没落盘），此时外部把 json 清理了 —— 旧内容不能被写回去 */
mem.clear()
writeDisk({ characters: [mkItem('ep-1'), mkItem('ep-2')] }, '2026-11-15T17:00:00.000Z')
S = await boot()
await S.hydrateFromDataFile()
S.store.items.characters.push(mkItem('ep-stale'))
S.saveItems() // 排一个 600ms 的落盘任务（不等待）
writeDisk({ characters: [mkItem('ep-ext')] }, '2026-11-15T18:00:00.000Z')
const epChanged = await S.syncFromDataFile({ notify: false })
await new Promise((r) => setTimeout(r, 1500)) // 等旧防抖任务本应触发的时刻过去
const epDisk = readDisk()
ok('⑦ 外部清理后内存随之覆盖', JSON.stringify(idsOf(S)) === JSON.stringify(['ep-ext']), idsOf(S).join(','))
ok('⑦ 覆盖前排队的旧内容没有被晚一步写回磁盘',
  JSON.stringify((epDisk?.items?.characters || []).map((it) => it.id)) === JSON.stringify(['ep-ext']),
  (epDisk?.items?.characters || []).map((it) => it.id).join(',') + ' changed=' + epChanged)

/* ---------- 输出结果 ---------- */
console.log(out.join('\n'))
const failed = out.filter((l) => l.startsWith('FAIL'))
console.log(`\n${out.length - failed.length}/${out.length} 通过`)
process.exit(failed.length ? 1 : 0)
