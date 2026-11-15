/* 卡详情「没有默认开场白」取值缺陷回归测试
 *
 * 背景：版本 raw 落盘时被剥成侧车文件（version.rawFile），重启后 version.raw 是 undefined。
 *       详情页旧实现直接读 activeVersion.raw，“还没读回来”和“确实没有”被判成同一种空，
 *       数据完好的卡（159 张）也一律显示「这一版没有默认开场白」。
 *
 * 覆盖：
 *   ① 三态判定纯函数（加载中 / 正常 / 真空卡 / 有备选无默认 / 读不到 raw）
 *   ② 「何时需要读侧车 / 读回来了算不算就绪」
 *   ③ 预载结果直接喂三态，raw 挂回版本后不再重复读盘
 *   ④ store.ensureVersionRaw 并发去重（两份并发只读一次盘）
 *   ⑤ 详情页接线契约（源码级）：预载 + 三态渲染 + 弹层同样三态
 *
 * 全程离线，不写 D:\酒馆数据，不碰 F:\SillyTavern7000。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GREET_RAW, GREET_STATE, greetRawNeedOf, greetRawResultOf, preloadGreetRaw, greetingViewOf } from '../src/lib/greetingView.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const out = []
function ok(name, cond, extra) {
  out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''))
  return !!cond
}

const g = (first, alternates = []) => ({ first, alternates, total: (first ? 1 : 0) + alternates.length })

/* ---------------- ① 三态判定 ---------------- */
{
  /* raw 未就绪：必须给加载态，不能落成空提示 */
  const loading = greetingViewOf({ greets: g('', []), rawState: GREET_RAW.LOADING })
  ok('① raw 未就绪 → 状态 loading', loading.state === GREET_STATE.LOADING, loading.state)
  ok('① 加载态不算「没有」：message 是读取提示', loading.loading === true && loading.message.includes('正在读取'))
  ok('① 加载态不算「没有」：message 里没有「没有默认开场白」', !loading.message.includes('没有默认开场白'))

  /* raw 就绪 + first_mes 有值 → 正常 */
  const normal = greetingViewOf({ greets: g('你好，{{user}}。', ['备选一', '备选二']), rawState: GREET_RAW.READY })
  ok('① 有默认开场白 → 状态 ok', normal.state === GREET_STATE.OK, normal.state)
  ok('① 正常态原文原样给出', normal.first === '你好，{{user}}。' && normal.alternates.length === 2)
  ok('① 正常态计数 1+2=3', normal.total === 3, String(normal.total))
  ok('① 正常态不显示空文案', normal.message === '' && normal.loading === false)
  ok('① 正常态标题说明「默认 1 条｜其他 2 条」', normal.subText === '默认 1 条｜其他 2 条', normal.subText)
  ok('① 有备选时可打开全部开场白', normal.canOpenAll === true)

  /* raw 就绪但 first_mes 为空、也没有备选 → 才是真正为空 */
  const empty = greetingViewOf({ greets: g('', []), rawState: GREET_RAW.READY })
  ok('① 真真空卡 → 状态 empty', empty.state === GREET_STATE.EMPTY, empty.state)
  ok('① 真真空卡文案', empty.message === '这一版没有默认开场白', empty.message)
  ok('① 空卡不给「打开全部」入口', empty.canOpenAll === false && empty.subText === '')

  /* 没有默认、但有备选：文案要说清有几条备选 */
  const alt = greetingViewOf({ greets: g('', ['备选一', '备选二', '备选三']), rawState: GREET_RAW.READY })
  ok('① 有备选无默认 → 状态 alternates', alt.state === GREET_STATE.ALTERNATES, alt.state)
  ok('① 有备选无默认文案带条数', alt.message === '本卡无默认开场白，有 3 条备选', alt.message)
  ok('① 有备选无默认也不算 ok（不能进正文渲染分支）', alt.state !== GREET_STATE.OK && alt.first === '')
  ok('① 有备选无默认仍可打开全部', alt.canOpenAll === true && alt.total === 3)

  /* raw 读不到：数据不可用，同样不能断言“没有” */
  const bad = greetingViewOf({ greets: g('', []), rawState: GREET_RAW.UNREADABLE })
  ok('① raw 不可读 → 状态 unreadable', bad.state === GREET_STATE.UNREADABLE, bad.state)
  ok('① raw 不可读文案指向数据而非“没有开场白”', bad.message.includes('读不到') && !bad.message.includes('没有默认开场白'))

  /* 兜底：调用方不传状态时按 ready 处理，不炸 */
  ok('① 不传 greets 不炸且按空卡处理', greetingViewOf({}).state === GREET_STATE.EMPTY)
  ok('① 不传状态默认按 ready', greetingViewOf({ greets: g('甲') }).state === GREET_STATE.OK)
  ok('① 脏数据（备选含空串/非数组）被清洗', greetingViewOf({ greets: { first: '', alternates: ['', '有'], total: 9 } }).alternates.length === 1)
  ok('① 首尾空白不算开场白（与 store 口径一致）', greetingViewOf({ greets: g('   ') }).state === GREET_STATE.EMPTY)

  /* 加载态若已经拿到值（内存里本来就有 raw），不该被加载态盖住 */
  const loadingButHas = greetingViewOf({ greets: g('已经在内存里的开场白', []), rawState: GREET_RAW.LOADING })
  ok('① 加载中但已有值 → 直接正常渲染（不闪加载态）', loadingButHas.state === GREET_STATE.OK && loadingButHas.loading === false)
}

/* ---------------- ② 何时读侧车 / 读回算不算就绪 ---------------- */
{
  ok('② 没版本 → 不用读', greetRawNeedOf(null) === GREET_RAW.READY && greetRawNeedOf(undefined) === GREET_RAW.READY)
  ok('② raw 已在内存 → 不用读', greetRawNeedOf({ raw: { first_mes: 'x' }, rawFile: 'a.json' }) === GREET_RAW.READY)
  ok('② raw 为 null 也视为未就绪（需要读）', greetRawNeedOf({ raw: null, rawFile: 'a.json' }) === 'read')
  ok('② 有侧车文件名 → 需要读', greetRawNeedOf({ rawFile: 'c1__v1.json' }) === 'read')
  ok('② 连侧车名都没有 → 判不可读（不再误报“没有开场白”）', greetRawNeedOf({}) === GREET_RAW.UNREADABLE)

  ok('② 读到 raw → ready', greetRawResultOf({ data: { first_mes: 'x' } }) === GREET_RAW.READY)
  ok('② 读不到 raw（undefined/null）→ unreadable', greetRawResultOf(undefined) === GREET_RAW.UNREADABLE && greetRawResultOf(null) === GREET_RAW.UNREADABLE)
}

/* ---------------- ②b 切换版本重新预载（详情页 loader 的真实取数路径） ---------------- */
{
  const SIDECARS = {
    'a.json': { data: { first_mes: 'A 的开场白' } },
    'b.json': { data: { first_mes: '', alternate_greetings: ['B 的备选一', 'B 的备选二'] } }
  }
  let reads = 0
  /* 模拟 store 的 ensureVersionRaw：读一次就把 raw 挂回 version，下次命中内存 */
  const ensureRaw = async (ver) => {
    reads += 1
    await new Promise((r) => setTimeout(r, 10))
    ver.raw = SIDECARS[ver.rawFile]
    return ver.raw
  }
  const viewOf = (ver, state) => greetingViewOf({ greets: { first: ver.raw?.data?.first_mes || '', alternates: ver.raw?.data?.alternate_greetings || [] }, rawState: state })

  const v1 = { id: 'v1', rawFile: 'a.json' }
  const v2 = { id: 'v2', rawFile: 'b.json' }
  const v3 = { id: 'v3', rawFile: 'gone.json' }

  const s1 = await preloadGreetRaw({ version: v1, ensureRaw })
  ok('②b 打开详情页：首次预载读一次盘 → ready', s1 === GREET_RAW.READY && reads === 1, 'reads=' + reads)
  ok('②b 预载后正常渲染默认开场白', viewOf(v1, s1).state === GREET_STATE.OK && viewOf(v1, s1).first === 'A 的开场白')

  const s2 = await preloadGreetRaw({ version: v2, ensureRaw })
  ok('②b 切到另一版本：重新预载（读第二次）', s2 === GREET_RAW.READY && reads === 2, 'reads=' + reads)
  const v2view = viewOf(v2, s2)
  ok('②b 切版本后按新版本渲染（有备选无默认文案）', v2view.state === GREET_STATE.ALTERNATES && v2view.message === '本卡无默认开场白，有 2 条备选', v2view.message)

  const s1again = await preloadGreetRaw({ version: v1, ensureRaw })
  ok('②b 切回已预载过的版本：不再读盘', s1again === GREET_RAW.READY && reads === 2, 'reads=' + reads)
  ok('②b 切回后渲染回原版本内容', viewOf(v1, s1again).first === 'A 的开场白')

  const s3 = await preloadGreetRaw({ version: v3, ensureRaw })
  ok('②b 侧车缺失的版本 → unreadable（不显示“没有开场白”）', s3 === GREET_RAW.UNREADABLE && reads === 3, 'reads=' + reads)
  const v3view = viewOf(v3, s3)
  ok('②b unreadable 文案不与空卡混淆', v3view.state === GREET_STATE.UNREADABLE && !v3view.message.includes('没有默认开场白'))

  const noRawFile = { id: 'v4' }
  const before = reads
  const s4 = await preloadGreetRaw({ version: noRawFile, ensureRaw })
  ok('②b 没有侧车的版本：直接判不可读且不读盘', s4 === GREET_RAW.UNREADABLE && reads === before)

  const boom = await preloadGreetRaw({ version: { id: 'v5', rawFile: 'x.json' }, ensureRaw: async () => { throw new Error('EIO') } })
  ok('②b 读盘抛错也判 unreadable（不炸界面）', boom === GREET_RAW.UNREADABLE)

  const noVer = await preloadGreetRaw({ version: null, ensureRaw })
  ok('②b 没有版本 → ready（不需要提示任何空）', noVer === GREET_RAW.READY)
}

/* ---------------- ③ 预载结果直接喂三态，不重复读盘 ---------------- */
{
  const raw = { data: { first_mes: '开场白', alternate_greetings: ['备选一'] } }
  let reads = 0
  /* 模拟 store 的 ensureVersionRaw：读一次就把 raw 挂到 version 上 */
  const version = { id: 'v1', rawFile: 'c1__v1.json' }
  /* preloadGreetRaw 只把 version 传给 ensureRaw（详情页那侧再自己补 item） */
  const ensureRaw = async (ver) => {
    reads += 1
    ver.raw = raw
    return raw
  }

  const s1 = await preloadGreetRaw({ version, ensureRaw })
  ok('③ 首次：raw 不在内存 → 读一次侧车并判 ready', s1 === GREET_RAW.READY && reads === 1, 'reads=' + reads)

  const gv = greetingViewOf({ greets: { first: raw.data.first_mes, alternates: raw.data.alternate_greetings }, rawState: s1 })
  ok('③ 预载后开场白判成 ok 并带出备选', gv.state === GREET_STATE.OK && gv.first === '开场白' && gv.alternates.length === 1, gv.state)

  ok('③ raw 挂回版本对象（下次不再读盘）', version.raw === raw && greetRawNeedOf(version) === GREET_RAW.READY)
  const s2 = await preloadGreetRaw({ version, ensureRaw })
  ok('③ 再预载一次仍然只读一次盘', s2 === GREET_RAW.READY && reads === 1, 'reads=' + reads)
}

/* ---------------- ④ store.ensureVersionRaw 并发去重 ---------------- */
{
  const mem = new Map()
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
    key: (i) => [...mem.keys()][i] ?? null,
    get length() { return mem.size }
  }
  let diskReads = 0
  const SIDECAR = JSON.stringify({ data: { first_mes: '侧车里的开场白', alternate_greetings: ['备选一'] } })
  globalThis.window = {
    api: {
      loadLibrary: async () => ({ ok: false, error: 'NO_SNAPSHOT' }),
      saveLibrary: async () => ({ ok: true }),
      dataReadFile: async ({ sub, name }) => {
        diskReads += 1
        /* 让两次并发请求真的重叠，验证共用同一次读盘 */
        await new Promise((r) => setTimeout(r, 30))
        if (sub === 'raw' && name === 'c9__v1.json') return { ok: true, text: SIDECAR }
        return { ok: false }
      },
      dataPutFile: async () => ({ ok: true }),
      imgSave: async () => ({ ok: true }),
      imgRead: async () => ({ ok: false })
    }
  }

  const S = await import('../src/store.js?greetview=' + Date.now())
  const v1 = { id: 'v1', rawFile: 'c9__v1.json' }
  const v2 = { id: 'v2', rawFile: 'c9__v1.json' } // 同一侧车（例如两个版本共用或同一版本被两份引用）

  const [a, b] = await Promise.all([S.ensureVersionRaw({ id: 'c9' }, v1), S.ensureVersionRaw({ id: 'c9' }, v2)])
  ok('④ 并发预载同一侧车只读一次盘', diskReads === 1, 'diskReads=' + diskReads)
  ok('④ 两个版本都拿到 raw', !!a && !!b && a.data.first_mes === '侧车里的开场白' && b === a)
  ok('④ raw 挂回版本对象（下次直接用内存）', v1.raw === a && v2.raw === a)

  const c = await S.ensureVersionRaw({ id: 'c9' }, v1)
  ok('④ 再取一次不再读盘（内存命中）', diskReads === 1 && c === a, 'diskReads=' + diskReads)

  /* 侧车缺失：返回 undefined，由 greetRawResultOf 判成 unreadable（不是“没有开场白”） */
  const missing = await S.ensureVersionRaw({ id: 'c9' }, { id: 'vx', rawFile: 'not-exist.json' })
  ok('④ 侧车缺失返回 undefined', missing === undefined)
  ok('④ 侧车缺失 → 开场白判 unreadable（不误报空卡）', greetRawResultOf(missing) === GREET_RAW.UNREADABLE)
}

/* ---------------- ⑤ 详情页接线契约（源码级） ---------------- */
{
  const detail = fs.readFileSync(path.join(root, 'src/views/CardDetail.vue'), 'utf8')
  const lib = fs.readFileSync(path.join(root, 'src/lib/greetingView.js'), 'utf8')

  ok('⑤ 详情页引用了三态判定模块', detail.includes("from '../lib/greetingView.js'"))
  ok('⑤ 开场白不再直接读 activeVersion.raw 判空', !/const greets = computed\(\(\) => greetingsOfVersion\(activeVersion\.value\)\)/.test(detail))
  ok('⑤ greets 经 greetingViewOf 三态化', /const greets = computed\(\(\) =>[\s\S]{0,160}greetingViewOf\(/.test(detail))
  ok('⑤ 预载用 store 的 ensureVersionRaw', /greetRawNeedOf\(v\)[\s\S]{0,400}ensureVersionRaw\(props\.item, v\)/.test(detail))
  ok('⑤ 预载前先判是否需要读盘（fresh raw 不重复读）',
    detail.includes('greetRawNeedOf(v)') && !detail.includes('greetRawResultOf(raw)'))
  ok('⑤ 打开详情页/切换版本会重新预载（watch activeVersion + item.id，immediate）',
    /watch\(\[activeVersion, \(\) => props\.item\.id\], \(\) => activeGreetRaw\.load\(\), \{ immediate: true \}\)/.test(detail))
  ok('⑤ 预载有竞态保护（切版本丢掉旧结果）', /const mine = \+\+seq[\s\S]{0,900}if \(mine !== seq\) return/.test(detail))
  ok('⑤ 模板按三态渲染（loading / unreadable / 其他）',
    detail.includes("greets.state === 'loading'") && detail.includes("greets.state === 'unreadable'") && detail.includes("greets.state !== 'ok'"))
  /* 注释里提到旧文案是允许的（那是坑记录），只查真正渲染/执行的代码 */
  const detailCode = detail
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || t.startsWith('<!--'))
    })
    .join('\n')
  ok('⑤ 模板/脚本不再硬写「这一版没有默认开场白」', !detailCode.includes('这一版没有默认开场白'))
  ok('⑤ 模板/脚本不再硬写「这一版没有开场白」', !detailCode.includes('这一版没有开场白'))
  ok('⑤ 空/备选文案集中在 lib 里（便于测试与复用）',
    lib.includes('这一版没有默认开场白') && /本卡无默认开场白，有 \$\{alternates\.length\} 条备选/.test(lib))
  ok('⑤ 标题计数改用三态的 subText', detail.includes('v-if="greets.subText"'))
  ok('⑤ 加载态有可见的转圈元素', detail.includes('greet-spin') && /@keyframes greet-spin/.test(detail))
  ok('⑤ 打开全部开场白弹层也预载（双击未选中的版本也能读到）',
    detail.includes('const modalGreetRaw = createGreetRawLoader') && /greetOpen\.value = true[\s\S]{0,120}modalGreetRaw\.load\(\)/.test(detail))
  ok('⑤ 弹层同样三态 + 条数用 greetView.total',
    detail.includes("greetView.state === 'loading'") && detail.includes('{{ greetView.total }} 条') && detail.includes('{{ greetView.message }}'))
  ok('⑤ 开场白正文只保留富文本渲染（详情页 + 弹层都用 RichText）',
    /<RichText class="op-text" :text="greets\.first"/.test(detail) &&
    /<RichText class="greet-body" :text="greetCur\?\.text \|\| ''"/.test(detail))
  ok('⑤ RichText 自己管「源码 / 渲染」切换，默认渲染态',
    fs.readFileSync(path.join(root, 'src/components/RichText.vue'), 'utf8').includes("const mode = ref('render')"))
  ok('⑤ 纯文本自动隐藏切换入口（hasRichMarkup 判定）',
    /canToggle = computed\(\(\) => props\.toggle && hasRichMarkup\(raw\.value\)\)/.test(
      fs.readFileSync(path.join(root, 'src/components/RichText.vue'), 'utf8')))
  ok('⑤ 开场白预载复用 preloadGreetRaw（走同一个 ensureVersionRaw）',
    /preloadGreetRaw\(\{ version: v, ensureRaw: \(\) => ensureVersionRaw\(props\.item, v\) \}\)/.test(detail))
  /* 正则预览已整体下线：不残留组件、模块、状态或回调 */
  ok('⑤ 详情页不再引用正则预览模块/组件',
    !detail.includes('regexPreview') && !detail.includes('regexScripts') && !detail.includes('GreetingRegex'))
  ok('⑤ 不再有正则入口状态（cardRegex / greetRegex / regexGlobalOn）',
    !detail.includes('createRegexView') && !detail.includes('regexGlobalOn') && !detail.includes('onRegexGlobalToggle'))
  ok('⑤ 正则相关文件已删除（模块 / 组件 / 测试）',
    ['src/lib/regexScripts.js', 'src/lib/regexPreview.js', 'src/lib/regexPreviewMemory.js', 'src/components/GreetingRegex.vue', 'tests/greeting-regex.test.mjs']
      .every((rel) => !fs.existsSync(path.join(root, rel))))
  ok('⑤ test 脚本不再包含已删除的正则测试', !fs.readFileSync(path.join(root, 'package.json'), 'utf8').includes('greeting-regex.test.mjs'))
  ok('⑤ 主进程侧车白名单不再放行 regexpreview', !fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8').includes('regexpreview'))
}

/* ---------------- 汇总 ---------------- */
console.log(out.join('\n'))
const failed = out.filter((l) => l.startsWith('FAIL')).length
console.log(`\n共 ${out.length} 项，FAILED=${failed}`)
process.exit(failed ? 1 : 0)
