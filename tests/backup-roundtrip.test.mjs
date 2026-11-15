/* 备份导出 → 导入 的正文完整性与去重回归测试
   覆盖四处根因修复：
   ① 导出侧 payloadOf 异步化：先 await ensureVersionRaw 读侧车，再退到版本图片内嵌卡，最后才合成最小卡
   ② 导入侧不再把 images/*.png 当封面直接跳过：png 里的 chara 作为该版本 payload 来源，且不额外生成版本行
   ③ store.keyOfPayload 之外补辅助指纹 +「同基名同日期即同一版本」合并，残缺卡不再无条件新增版本
   ④ 当前版本兜底改为「选正文最完整的版本」，空壳版不再抢占
*/

import JSZip from 'jszip'

/* ---------- 模拟主进程 IPC ---------- */
const SIDECAR = new Map() // 侧车 raw 文件：name -> text
const IMGSTORE = new Map() // 图片仓库：hash -> { b64, mime }

globalThis.window = {
  api: {
    dataPutFile: async ({ sub, name, text }) => {
      SIDECAR.set(name, text)
      return { ok: true }
    },
    dataReadFile: async ({ sub, name }) => (SIDECAR.has(name) ? { ok: true, text: SIDECAR.get(name) } : { ok: false }),
    imgSave: async ({ hash, buffer }) => {
      const b = Buffer.from(buffer).toString('base64')
      IMGSTORE.set(hash, { b64: b, mime: 'image/png' })
      return { ok: true }
    },
    imgRead: async (hash) => {
      const r = IMGSTORE.get(hash)
      return r ? { ok: true, data: r.b64, mime: r.mime } : { ok: false }
    },
    thumbPrefetch: () => {}
  }
}

const store = await import('../src/store.js')
const { buildBackupZip } = await import('../src/lib/backup.js')
const { analyzeOneFile, pngTextChunks, cardFromPngBuffer } = await import('../src/lib/importer.js')

const out = []
function ok(name, cond, extra) {
  out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''))
  return !!cond
}

/* ---------- 造一张「带 chara 数据块」的 png ---------- */
function makeCardPng(card) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const type = Buffer.from('tEXt', 'latin1')
  const b64 = Buffer.from(JSON.stringify(card), 'utf8').toString('base64')
  const data = Buffer.concat([Buffer.from('chara', 'latin1'), Buffer.from([0]), Buffer.from(b64, 'latin1')])
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4) // 解析器不校验 CRC，占位即可
  return Buffer.concat([sig, len, type, data, crc])
}

const FIRST_MES = '夜色沉下去的时候，酒馆的木门被风推开了。她抬眼看过来，手里还捏着半干的抹布。'
const FULL_CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '艾拉',
    description: '红发老板娘，嘴上不饶人心里软。',
    personality: '嘴硬心软',
    scenario: '深夜酒馆',
    first_mes: FIRST_MES,
    alternate_greetings: ['再来一杯？'],
    mes_example: '<START>',
    character_version: '3.3'
  }
}
const THIN_CARD = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '艾拉', description: '' } }

/* ---------- ① 导出兜底链 ---------- */
{
  /* 场景 A：raw 落侧车（ragFile），侧车是精简卡 → 必须从版本图片里解析出完整卡 */
  SIDECAR.set('c100__v100.json', JSON.stringify(THIN_CARD))
  IMGSTORE.set('hashA', { b64: makeCardPng(FULL_CARD).toString('base64'), mime: 'image/png' })

  const items = {
    characters: [
      {
        id: 'c100',
        name: '艾拉',
        category: 'characters',
        desc: '',
        tags: [],
        stVersion: '2026-11-01',
        updatedAt: '2026-11-01',
        versions: [
          { id: 'v100', name: '2026-11-01', date: '2026-11-01', current: true, rawFile: 'c100__v100.json', imgId: 'hashA' }
        ]
      }
    ]
  }
  const { blob } = await buildBackupZip(items)
  const zip = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()))
  const card = JSON.parse(await zip.file('characters/艾拉/2026-11-01.json').async('string'))
  ok('导出：侧车精简卡时从版本图片解析出完整卡', card?.data?.first_mes === FIRST_MES, 'first_mes 长度 ' + String(card?.data?.first_mes || '').length)
  ok('导出：图片兜底后不再打元数据缺失标记', card.tavernlib_meta_only !== true)
}

{
  /* 场景 B：完全拿不到正文 → 合成最小卡必须带「元数据缺失」标记 */
  const items = {
    characters: [
      {
        id: 'c200',
        name: '无源卡',
        category: 'characters',
        desc: '只剩名字',
        tags: [],
        versions: [{ id: 'v200', name: 'v1', current: true }]
      }
    ]
  }
  const { blob } = await buildBackupZip(items)
  const zip = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()))
  const card = JSON.parse(await zip.file('characters/无源卡/v1.json').async('string'))
  ok('导出：正文与图片都没有时合成最小卡并标记元数据缺失', card.tavernlib_meta_only === true)
}

{
  /* 场景 C：世界书 entries 与美化 css 必须整份写入，不能只剩元信息 */
  const items = {
    worldbooks: [
      {
        id: 'w100',
        name: '克苏鲁',
        category: 'worldbooks',
        versions: [
          {
            id: 'wv100',
            name: '2026-10',
            current: true,
            raw: { name: '克苏鲁', entries: { 0: { key: ['黄印'], content: '旧日支配者的印记' } } }
          }
        ]
      }
    ],
    themes: [
      {
        id: 't100',
        name: '暗夜',
        category: 'themes',
        versions: [{ id: 'tv100', name: '1.0', current: true, raw: { css: ':root{--bg:#111}', theme: { blur: 8 } } }]
      }
    ]
  }
  const { blob } = await buildBackupZip(items)
  const zip = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()))
  const wb = JSON.parse(await zip.file('worldbooks/克苏鲁/2026-10.json').async('string'))
  const th = JSON.parse(await zip.file('themes/暗夜/1.0.json').async('string'))
  ok('导出：世界书写入完整 entries', !!wb.entries && !!wb.entries['0'], JSON.stringify(wb).slice(0, 60))
  ok('导出：美化写入完整 css', th.css === ':root{--bg:#111}')
  ok('导出：世界书/美化不打元数据缺失标记', wb.tavernlib_meta_only !== true && th.tavernlib_meta_only !== true)
}

/* ---------- ② 导入侧读 png 内嵌卡 ---------- */
{
  const zip = new JSZip()
  zip.file('characters/艾拉/2026-11-01.json', JSON.stringify(THIN_CARD))
  zip.file('characters/艾拉/images.json', JSON.stringify({ versions: { '2026-11-01': 'images/abc.png' }, cover: 'images/abc.png' }))
  zip.file('characters/艾拉/images/abc.png', makeCardPng(FULL_CARD))
  const buf = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))

  const rows = await analyzeOneFile({
    name: 'backup.zip',
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    text: async () => ''
  })
  const rowsChar = rows.filter((r) => r.category === 'characters')
  ok('导入：images/*.png 不再被当封面跳过（只产出 1 条版本记录）', rowsChar.length === 1, '实得 ' + rowsChar.length)
  ok('导入：该版本 payload 取自 png 内嵌完整卡', rowsChar[0]?.payload?.data?.first_mes === FIRST_MES)
  ok('导入：版本名仍来自目录内 json 文件名', rowsChar[0]?.version === '2026-11-01', String(rowsChar[0]?.version))
}

/* ---------- ③ 同基名同日期合并 / 辅助指纹 ---------- */
{
  /* 先导入一份精简卡（模拟老库里的空壳版本），再导入同日同版本名的完整卡 */
  const thinRows = [
    {
      fileName: 'a.json',
      source: 'zip',
      category: 'characters',
      name: '艾拉',
      version: '2026-11-01',
      date: '2026-11-01',
      payload: THIN_CARD
    }
  ]
  const r1 = await store.commitImport(thinRows)
  const item = store.store.items.characters.find((x) => x.name === '艾拉')
  ok('去重前置：空壳版本先正常建出 1 版', r1.created === 1 && item?.versions?.length === 1, JSON.stringify(r1))

  const fullRows = [
    {
      fileName: 'a-full.json',
      source: 'zip',
      category: 'characters',
      name: '艾拉',
      version: '2026-11-01',
      date: '2026-11-01',
      payload: FULL_CARD
    }
  ]
  const r2 = await store.commitImport(fullRows)
  ok('去重：同基名同日期的完整卡不再新增版本', item.versions.length === 1, '版本数 ' + item.versions.length)
  ok('去重：残缺版本被完整卡补全', item.versions[0].raw?.data?.first_mes === FIRST_MES)
  ok('去重：返回结果带上补全计数', r2.filled >= 1, JSON.stringify(r2))

  const aux = store.auxKeyOfPayload('characters', THIN_CARD, { name: '艾拉', version: '2026-11-01', day: '2026-11-01' })
  const aux2 = store.auxKeyOfPayload('characters', FULL_CARD, { name: '艾拉', version: '2026-11-01', day: '2026-11-01' })
  ok('辅助指纹：残缺卡与完整卡算出同一个值', !!aux && aux === aux2, String(aux))

  const thinKey = store.keyOfPayload('characters', THIN_CARD)
  const fullKey = store.keyOfPayload('characters', FULL_CARD)
  ok('对照：正文指纹在两份卡上仍不相同（说明必须靠辅助指纹兜底）', thinKey !== fullKey)
}

/* ---------- ④ 当前版本兜底选最完整的 ---------- */
{
  const item = {
    name: '兜底',
    versions: [
      { id: 'a', name: '2026-11-01', current: true, raw: THIN_CARD },
      { id: 'b', name: '2026-10-01', current: false, raw: FULL_CARD }
    ]
  }
  const best = store.bestVersionOf(item)
  ok('当前版本：空壳版当道时改选正文最完整的版本', best.id === 'b')

  const items = { characters: [item], worldbooks: [], presets: [], themes: [], others: [] }
  store.ensureCurrentVersion(items)
  ok('当前版本：ensureCurrentVersion 把 current 切到完整版', item.versions.find((v) => v.current).id === 'b')
}

/* ---------- ⑤ 端到端：导出 → 清空 → 重新导入 ---------- */
{
  /* 从干净库开始：重建两条角色（各 2 版）+ 1 本世界书 */
  store.store.items = { characters: [], worldbooks: [], presets: [], themes: [], others: [] }
  const mk = (name, ver, first) => ({
    fileName: `${name}-${ver}.json`,
    source: 'zip',
    category: 'characters',
    name,
    version: ver,
    date: ver,
    payload: { spec: 'chara_card_v2', spec_version: '2.0', data: { ...FULL_CARD.data, name, first_mes: first } }
  })
  const rows = [
    mk('艾拉', '2026-11-01', FIRST_MES),
    mk('艾拉', '2026-10-01', '十月的开场白，短一些。'),
    mk('林小满', '2026-11-02', '清晨的花市刚开，她抱着花束回头笑了一下。'),
    mk('林小满', '2026-09-20', '秋天第一束花。')
  ]
  await store.commitImport(rows)
  const before = {
    items: store.store.items.characters.length,
    versions: store.store.items.characters.reduce((n, it) => n + it.versions.length, 0)
  }
  const firstMesOf = (items, name) => {
    const it = items.find((x) => x.name === name)
    const v = store.bestVersionOf(it)
    return String(v?.raw?.data?.first_mes || '')
  }
  const srcFirst = {}
  for (const it of store.store.items.characters) srcFirst[it.name] = firstMesOf(store.store.items.characters, it.name)

  /* 模拟落盘：raw 被剥进侧车（这是产生重复的真实前提） */
  store.store.items = store.slimItems()
  const slimOk = store.store.items.characters.every((it) => it.versions.every((v) => v.raw === undefined && !!v.rawFile))
  ok('端到端：落盘后 raw 已剥离为侧车（复现真实前置状态）', slimOk)

  const { blob } = await buildBackupZip(store.store.items)
  const zipBuf = Buffer.from(await blob.arrayBuffer())
  const zip = await JSZip.loadAsync(zipBuf)
  const cardFiles = Object.keys(zip.files).filter((f) => /^characters\/.+\/[^/]+\.json$/.test(f) && !/images\.json$/.test(f))
  const exportedHasFirst = []
  for (const f of cardFiles) {
    const j = JSON.parse(await zip.file(f).async('string'))
    exportedHasFirst.push(String(j?.data?.first_mes || '').length > 0)
  }
  ok('端到端：备份包里每个版本 json 都带开场白', exportedHasFirst.length === 4 && exportedHasFirst.every(Boolean), JSON.stringify(exportedHasFirst))

  /* 清空条目后重新导入 */
  store.store.items = { characters: [], worldbooks: [], presets: [], themes: [], others: [] }
  const imported = await analyzeOneFile({
    name: 'backup.zip',
    arrayBuffer: async () => zipBuf.buffer.slice(zipBuf.byteOffset, zipBuf.byteOffset + zipBuf.byteLength),
    text: async () => ''
  })
  const acc = { created: 0, merged: 0, dup: 0, total: 0 }
  /* 分批导入（每个 zip 行一条），与软件里的真实调用方式一致 */
  for (const r of imported.filter((x) => !x.error && x.payload !== null)) {
    const res = await store.commitImport([r])
    acc.created += res.created
    acc.merged += res.merged
    acc.dup += res.dup
    acc.total += res.total
  }

  const after = {
    items: store.store.items.characters.length,
    versions: store.store.items.characters.reduce((n, it) => n + it.versions.length, 0)
  }
  ok('端到端：条目数回到原值', after.items === before.items, `${before.items} → ${after.items}`)
  ok('端到端：版本数回到原值', after.versions === before.versions, `${before.versions} → ${after.versions}`)

  const dupVer = store.store.items.characters.some((it) => it.versions.some((v) => /第\s*\d+\s*版/.test(String(v.name || ''))))
  ok('端到端：没有产生「第 N 版」重复版本', !dupVer, store.store.items.characters.map((it) => it.versions.map((v) => v.name).join(',')).join(' | '))

  const afterFirst = {}
  for (const it of store.store.items.characters) afterFirst[it.name] = firstMesOf(store.store.items.characters, it.name)
  const sameLen = Object.keys(srcFirst).every((n) => afterFirst[n] && afterFirst[n].length === srcFirst[n].length)
  ok('端到端：开场白字数与源一致', sameLen, JSON.stringify(Object.keys(srcFirst).map((n) => `${n}:${srcFirst[n].length}→${(afterFirst[n] || '').length}`)))

  const allHaveFirst = store.store.items.characters.every((it) => it.versions.every((v) => String(v.raw?.data?.first_mes || '').length > 0))
  ok('端到端：每一个版本都保留了开场白', allHaveFirst)
}

/* ---------- ⑥ 世界书 / 美化：完整正文绝不被打着「补全」旗号的空壳覆盖 ---------- */
{
  store.store.items = { characters: [], worldbooks: [], presets: [], themes: [], others: [] }
  const entries = {}
  for (let i = 0; i < 12; i++) entries[String(i)] = { key: [`k${i}`], content: `条目正文${i}——旧日支配者的低语`.repeat(3) }
  const WB_FULL = { name: '克苏鲁', entries }
  const WB_THIN = { tavernlib_category: 'worldbooks', tavernlib_meta_only: true, name: '克苏鲁', data: { name: '克苏鲁' } }
  const wbRow = (payload, version) => ({
    fileName: `${version}.json`,
    source: 'zip',
    category: 'worldbooks',
    name: '克苏鲁',
    version,
    date: version,
    payload
  })
  await store.commitImport([wbRow(WB_FULL, '2026-09-22')])
  const r = await store.commitImport([wbRow(WB_THIN, '2026-09-22')])
  const wb = store.store.items.worldbooks[0]
  const cur = store.bestVersionOf(wb)
  ok('世界书：空壳 json 不覆盖完整 entries', Object.keys(cur.raw.entries || {}).length === 12, `条目数 ${Object.keys(cur.raw.entries || {}).length}`)
  ok('世界书：同版本只合并、不新增版本', wb.versions.length === 1 && r.filled === 0, JSON.stringify({ v: wb.versions.length, filled: r.filled }))

  /* 同一本书的两个真实版本：2026-09-22 与 2026-09-22 第2版（后者在源库里就是空壳） */
  const r2 = await store.commitImport([wbRow(WB_THIN, '2026-09-22 第2版')])
  const wb2 = store.store.items.worldbooks[0]
  ok('世界书：同基名不同版本名是两个版本，不被并成一个', wb2.versions.length === 2 && r2.created === 0, `版本数 ${wb2.versions.length}`)
  ok('世界书：第一个版本仍是完整版', Object.keys(store.bestVersionOf(wb2).raw.entries || {}).length === 12)

  /* 美化：洛书匣自己的 { css, name, theme } 必须被认成美化，而不是「其他」 */
  const { classifyJson, themePayloadOf } = await import('../src/lib/importer.js')
  const ci = classifyJson({ css: '.a{color:red}', name: '暗夜', theme: { chat: {} } })
  ok('美化：{css,...} 归入 themes', ci.category === 'themes', ci.category)
  const ci2 = classifyJson({ css: '', name: '暗夜', theme: null })
  ok('美化：css 被剥空的壳版本仍归入 themes，不另建「其他」条目', ci2.category === 'themes', ci2.category)
  const tp = themePayloadOf({ css: '.x{color:blue}', name: '暗夜', theme: { chat: {} } })
  ok('美化：themePayloadOf 认得 css 字段（CSS 不再清零）', tp.css === '.x{color:blue}', tp.css)
  const TH_CSS = '.chat{background:#111}'.repeat(40)
  const themeRow = (payload, version) => ({
    fileName: `${version}.json`,
    source: 'zip',
    category: 'themes',
    name: '暗夜',
    version,
    date: version,
    payload
  })
  await store.commitImport([themeRow({ css: TH_CSS, name: '暗夜', theme: { chat: {} } }, '2026-10-01')])
  await store.commitImport([themeRow({ css: '', name: '暗夜' }, '2026-10-01')])
  const th = store.store.items.themes[0]
  ok('美化：空 css 不覆盖完整 css', String(store.bestVersionOf(th).raw.css || '').length === TH_CSS.length, String(store.bestVersionOf(th).raw.css || '').length)
}

/* ---------- ⑦ 同一角色的两个不同版本：正文指纹撞车也不能吞掉版本 ---------- */
{
  store.store.items = { characters: [], worldbooks: [], presets: [], themes: [], others: [] }
  /* 两张卡描述 / 开场白完全相同，只有 mes_example 不同 → keyOfPayload 算出来一样 */
  const mkCard = (mes) => ({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name: '方亦楷', description: '同一段描述', first_mes: '同一段开场白', mes_example: mes, character_version: '2.0' }
  })
  const cRow = (payload, version) => ({
    fileName: `方亦楷-${version}.json`,
    source: 'zip',
    category: 'characters',
    name: '方亦楷',
    version,
    date: '2026-11-02',
    payload
  })
  const rows = [cRow(mkCard('<START>A'), '2026-11-02'), cRow(mkCard('<START>B'), '2026-11-02 第2版')]
  ok('指纹撞车：两份卡正文指纹确实相同（前置条件）', store.keyOfPayload('characters', rows[0].payload) === store.keyOfPayload('characters', rows[1].payload))
  await store.commitImport(rows)
  const it = store.store.items.characters[0]
  ok('指纹撞车：同批导入保留两个版本，不再被无条件跳过', it.versions.length === 2, it.versions.map((v) => v.name).join(','))
}

/* ---------- ⑧ 条目名还原：卡内名带版本后缀也不拆条目 ---------- */
{
  store.store.items = { characters: [], worldbooks: [], presets: [], themes: [], others: [] }
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name: '方亦楷2.0', description: '描述', first_mes: '开场白', character_version: '2.0' }
  }
  const it = { id: 'c900', category: 'characters', name: '方亦楷', desc: '', tags: [], stVersion: '2026-11-02', versions: [{ id: 'v900', name: '2026-11-02', date: '2026-11-02', current: true, raw: card }] }
  store.store.items.characters = [it]
  const { blob } = await buildBackupZip(store.store.items)
  const buf = Buffer.from(await blob.arrayBuffer())
  const zip = await JSZip.loadAsync(buf)
  const f = Object.keys(zip.files).find((p) => /^characters\/.+\/[^/]+\.json$/.test(p) && !/images\.json$/.test(p))
  const exported = JSON.parse(await zip.file(f).async('string'))
  ok('导出：json 写入 tavernlib_item_name（原始条目名）', exported.tavernlib_item_name === '方亦楷', String(exported.tavernlib_item_name))

  const row = await analyzeOneFile({
    name: 'tavernlib-backup-x.zip',
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    text: async () => ''
  })
  ok('导入：按原始条目名还原，不被卡内名拆成两条', row[0] && row[0].name === '方亦楷', row[0] && row[0].name)
}

const fail = out.filter((l) => l.startsWith('FAIL'))
console.log(out.join('\n'))
console.log(`\n备份导出→导入回归：${out.length - fail.length}/${out.length} PASS`)
if (fail.length) process.exit(1)
