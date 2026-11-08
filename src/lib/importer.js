import JSZip from 'jszip'

/* ============ 通用工具 ============ */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function b64ToUtf8(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}

/** 提取 PNG 的 tEXt/iTXt 文本块（角色卡数据存在 chara / ccv3 关键字里） */
export function pngTextChunks(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer)
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return null
  const view = new DataView(arrayBuffer)
  const out = {}
  let off = 8
  while (off + 8 <= bytes.length) {
    const len = view.getUint32(off)
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7])
    const start = off + 8
    if (type === 'tEXt') {
      const data = bytes.subarray(start, start + len)
      const z = data.indexOf(0)
      if (z > 0) {
        const key = new TextDecoder('latin1').decode(data.subarray(0, z))
        out[key] = new TextDecoder('latin1').decode(data.subarray(z + 1))
      }
    } else if (type === 'iTXt') {
      // keyword\0 compFlag compMethod \0 lang \0 translated \0 text(utf8)
      const data = bytes.subarray(start, start + len)
      let i = data.indexOf(0)
      if (i > 0) {
        const key = new TextDecoder('latin1').decode(data.subarray(0, i))
        let p = i + 3
        const langEnd = data.indexOf(0, p)
        const transEnd = langEnd > 0 ? data.indexOf(0, langEnd + 1) : -1
        if (transEnd > 0) out[key] = new TextDecoder('utf-8').decode(data.subarray(transEnd + 1))
      }
    }
    if (type === 'IEND') break
    off = start + len + 4
  }
  return out
}

export function fileExt(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '')
  return m ? m[1].toLowerCase() : ''
}

export function stripExt(name) {
  return (name || '').replace(/\.[a-z0-9]+$/i, '')
}

/** 从美化 CSS 的头部注释里取个名字，取不到就返回空（调用方回落到文件名） */
export function cssNameOf(css) {
  const text = String(css || '').slice(0, 4000)
  const clean = (s) =>
    String(s || '')
      .replace(/^[\s*/#-]+|[\s*/]+$/g, '')
      .replace(/^(@?name|名称|主题名|美化名)\s*[:：]\s*/i, '')
      .trim()
  let m = /@name\s*[:：]?\s*([^\r\n*]+)/i.exec(text)
  if (m) {
    const v = clean(m[1])
    if (v && v.length <= 60) return v
  }
  const block = /^\s*\/\*+([\s\S]{0,400}?)\*\//.exec(text)
  if (block) {
    const firstLine = block[1].split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || ''
    const v = clean(firstLine)
    if (v && v.length <= 60) return v
  }
  return ''
}

/* ============ JSON 分类判定 ============ */

const PRESET_KEYS = [
  'temperature', 'top_p', 'top_k', 'top_a', 'min_p', 'repetition_penalty',
  'frequency_penalty', 'presence_penalty', 'openai_max_tokens', 'openai_max_context',
  'max_context_unlocked', 'prompts', 'prompt_order', 'wi_format', 'stream_openai',
  'max_tokens', 'context_size'
]

/* 酒馆「UI 主题」的外观字段：themes/*.json 除了写 CSS 那一类，还有只存这些字段的 */
export const UI_THEME_KEYS = [
  'main_text_color', 'italics_text_color', 'underline_text_color', 'quote_text_color',
  'blur_tint_color', 'chat_tint_color', 'user_mes_blur_tint_color', 'bot_mes_blur_tint_color',
  'shadow_color', 'border_color', 'blur_strength', 'shadow_width', 'font_scale', 'chat_width',
  'avatar_style', 'chat_display', 'noShadows', 'fast_ui_mode', 'waifuMode', 'reduced_motion',
  'compact_input_area', 'hideChatAvatars_enabled', 'expand_message_actions', 'media_display',
  'click_to_edit', 'timestamps_enabled', 'mesIDDisplay_enabled', 'message_token_count_enabled'
]

/**
 * 判断一份 JSON 属于哪一类
 * @returns {{category:string, kind:string, name:string}}
 */
export function classifyJson(obj) {
  if (!obj || typeof obj !== 'object') return { category: 'others', kind: 'unknown', name: '' }

  // 本软件自己写出的条目：分类直接记在字段里，避免「其他」被误判
  const ownCat = obj.tavernlib_category
  if (ownCat) {
    const nm = (obj.data && obj.data.name) || obj.name || ''
    return { category: ownCat, kind: ownCat, name: nm }
  }

  // 角色卡 v2/v3：{ spec:'chara_card_v2', data:{...} }
  if (/chara_card/i.test(obj.spec || '') && obj.data && typeof obj.data === 'object') {
    return { category: 'characters', kind: 'character', name: obj.data.name || '' }
  }

  const root = obj

  // 角色卡 v1：扁平字段
  if (
    root.name &&
    (root.first_mes !== undefined || root.description !== undefined ||
      root.personality !== undefined || root.scenario !== undefined ||
      root.mes_example !== undefined || root.char_name !== undefined)
  ) {
    return { category: 'characters', kind: 'character', name: root.name || root.char_name || '' }
  }

  // 世界书：entries 里是条目对象，条目有 content / key(s)
  if (root.entries && (Array.isArray(root.entries) ? root.entries.length : Object.keys(root.entries).length)) {
    const sample = Array.isArray(root.entries) ? root.entries[0] : Object.values(root.entries)[0]
    if (sample && typeof sample === 'object' &&
      (sample.content !== undefined || sample.key !== undefined || sample.keys !== undefined)) {
      const nm = root.name || root.originalData?.name || ''
      return { category: 'worldbooks', kind: 'worldbook', name: nm }
    }
  }

  // 美化主题（酒馆 themes/*.json）：样式全写在 customCSS，老版本字段名是 custom_css
  if (typeof root.customCSS === 'string' || typeof root.custom_css === 'string') {
    return { category: 'themes', kind: 'theme', name: root.name || '' }
  }

  // 美化主题的另一种写法：json 里没有 CSS，只存颜色 / 模糊 / 头像形状等外观字段
  if (UI_THEME_KEYS.filter((k) => k in root).length >= 3) {
    return { category: 'themes', kind: 'ui-theme', name: root.name || '' }
  }

  // 预设：采样参数命中 >= 2 个，或含 prompts / prompt_order
  const hits = PRESET_KEYS.filter((k) => k in root).length
  if (root.prompts || root.prompt_order || hits >= 2) {
    return { category: 'presets', kind: 'preset', name: root.name || root.preset_name || '' }
  }

  // 正则脚本 / 快捷回复 等
  if (Array.isArray(root) && root.length && root[0] && (root[0].findRegex || root[0].regex)) {
    return { category: 'others', kind: 'regex', name: '正则脚本集' }
  }

  return { category: 'others', kind: 'other', name: root.name || root.id || '' }
}

/**
 * 美化主题的 raw：留 CSS 源 + 一份外观字段
 * （写 CSS 的主题用 css；只存字段的主题用 theme，预览和导出都按这两样还原）
 */
export function themePayloadOf(json) {
  if (!json || typeof json !== 'object') return json
  const css = typeof json.customCSS === 'string' ? json.customCSS
    : typeof json.custom_css === 'string' ? json.custom_css : ''
  const theme = {}
  for (const k of UI_THEME_KEYS) if (k in json) theme[k] = json[k]
  const hasTheme = Object.keys(theme).length >= 3
  return {
    css: String(css || ''),
    name: String(json.name || ''),
    theme: hasTheme ? theme : null
  }
}

/* ============ 单文件解析 ============ */

async function readArrayBuffer(file) {
  return await file.arrayBuffer()
}

async function readText(file) {
  return await file.text()
}

function toDataUrl(buf, mime = 'image/png') {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return `data:${mime};base64,${btoa(bin)}`
}

/** 解析 PNG 角色卡 */
async function parsePngCard(file) {
  const buf = await readArrayBuffer(file)
  const chunks = pngTextChunks(buf)
  const raw = chunks?.ccv3 || chunks?.chara
  if (!raw) return null
  let json
  try { json = JSON.parse(b64ToUtf8(raw)) } catch (_) { return null }
  const info = classifyJson(json)
  const data = /chara_card/i.test(json.spec || '') ? json.data : json
  return {
    category: 'characters',
    kind: 'character',
    name: data?.name || stripExt(file.name),
    payload: json,
    meta: {
      creator: data?.creator || data?.created_by || '',
      firstMes: (data?.first_mes || '').slice(0, 120)
    },
    cover: toDataUrl(buf)
  }
}

/** 解析 JSON 文件 */
async function parseJsonFile(file) {
  const text = await readText(file)
  let json
  try { json = JSON.parse(text) } catch (e) {
    return { error: 'JSON 解析失败：' + e.message }
  }
  const info = classifyJson(json)
  return {
    category: info.category,
    kind: info.kind,
    name: info.name || stripExt(file.name),
    payload: info.category === 'themes' ? themePayloadOf(json) : json
  }
}

/** 解析 ZIP 备份包
 *  - 卡图片放在 images/ 下按内容哈希命名，多版本共用同一张图只存一份
 *  - 每个条目目录下的 images.json 记录「版本名 → 图片文件」
 *  - images/ 里的图片只当图片用，绝不当成角色卡（避免凭空多出一个版本）
 */
async function parseZip(file) {
  const buf = await readArrayBuffer(file)
  const zip = await JSZip.loadAsync(buf)
  const items = []
  let indexMeta = null

  const names = Object.keys(zip.files)

  // 1) 先收集图片资源与索引
  const imgFiles = new Map() // path -> entry
  const dirIndex = new Map() // dir -> { byVersion:{}, byStem:{}, single:'' }
  for (const path of names) {
    const entry = zip.files[path]
    if (entry.dir) continue
    if (/(^|\/)__MACOSX\//.test(path) || /(^|\/)\._/.test(path)) continue
    const base = path.split('/').pop()
    const ext = fileExt(base)
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
      imgFiles.set(path, entry)
      const idx = dirIndex.get(dir) || { byVersion: {}, byStem: {}, list: [] }
      idx.list.push(path)
      if (!/^cover\./i.test(base)) idx.byStem[stripExt(base)] = path
      dirIndex.set(dir, idx)
    }
    if (ext === 'json' && /^images\.json$/i.test(base)) {
      try {
        const t = await entry.async('string')
        const j = JSON.parse(t)
        const idx = dirIndex.get(dir) || { byVersion: {}, byStem: {}, list: [] }
        // images.json 里记的是相对条目目录的路径（images/xxx.png），这里补全成包内绝对路径，
        // 否则拿相对路径去 imgFiles 里查必然查不到，导入后图片就退回成汉字占位
        const full = (p) => (p ? (dir ? dir + '/' + String(p) : String(p)) : '')
        idx.byVersion = {}
        for (const [k, v] of Object.entries((j && j.versions) || {})) idx.byVersion[k] = full(v)
        if (j && j.cover) idx.cover = full(j.cover)
        dirIndex.set(dir, idx)
      } catch (_) {}
    }
  }

  const imgCache = new Map()
  async function imgDataUrl(path) {
    if (!path) return ''
    if (imgCache.has(path)) return imgCache.get(path)
    const entry = imgFiles.get(path)
    let out = ''
    if (entry) {
      try {
        const ab = await entry.async('arraybuffer')
        const mime = /\.jpe?g$/i.test(path) ? 'image/jpeg' : /\.webp$/i.test(path) ? 'image/webp'
          : /\.gif$/i.test(path) ? 'image/gif' : 'image/png'
        out = toDataUrl(ab, mime)
      } catch (_) {}
    }
    imgCache.set(path, out)
    return out
  }

  /** 在某个目录的索引里挑图片（allowLoose：允许退到 cover / 唯一图片） */
  function pickInDir(dir, stem, versionName, allowLoose) {
    const idx = dirIndex.get(dir)
    if (!idx) return ''
    const v = versionName || stem
    if (idx.byVersion && idx.byVersion[v]) return idx.byVersion[v]
    if (idx.byStem && idx.byStem[stem]) return idx.byStem[stem]
    if (!allowLoose) return ''
    if (idx.cover) return idx.cover
    if (idx.list && idx.list.length === 1) return idx.list[0]
    return ''
  }

  /** 为一个条目目录挑出图片：优先 images.json 的版本映射，其次同名图片，再退到唯一图片
   *  历史版本 JSON 在 <条目>/history 下，图片索引却在上一级，所以 history 目录要回退到父目录查映射 */
  function pickImagePath(dir, stem, versionName, isCurrent) {
    const own = pickInDir(dir, stem, versionName, isCurrent)
    if (own) return own
    const m = /^(.*)\/history$/i.exec(String(dir || ''))
    if (m) return pickInDir(m[1], stem, versionName, false)
    return ''
  }

  // 2) 遍历文件产出条目
  for (const path of names) {
    const entry = zip.files[path]
    if (entry.dir) continue
    if (/(^|\/)__MACOSX\//.test(path) || /(^|\/)\._/.test(path)) continue
    const base = path.split('/').pop()
    const ext = fileExt(base)
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    const inHistory = /(^|\/)history\//i.test(path)

    if (ext === 'json' && /^(index|manifest|backup|metadata)\.json$/i.test(base)) {
      try {
        const t = await entry.async('string')
        indexMeta = JSON.parse(t)
      } catch (_) {}
      continue
    }
    if (ext === 'json' && /^images\.json$/i.test(base)) continue

    if (ext === 'png') {
      // 备份包里的版本配图本身就是一张带 chara 数据的角色卡 png，
      // images/ 下的 png 与「打包生成」的 cover.* 一律只当图片用，绝不再生成一个版本
      const isResImg = /(^|\/)images\//i.test(path)
      const dirIdxNow = dirIndex.get(dir)
      const isPkgCover = /^cover\./i.test(base) && !!(dirIdxNow && dirIdxNow.byVersion && Object.keys(dirIdxNow.byVersion).length)
      if (isResImg || isPkgCover) continue
      // 只有「图片里真的带角色卡数据」才算角色卡；备份包里的图片只当图片
      const ab = await entry.async('arraybuffer')
      const chunks = pngTextChunks(ab)
      const raw = chunks?.ccv3 || chunks?.chara
      if (!raw) continue
      try {
        const json = JSON.parse(b64ToUtf8(raw))
        const data = /chara_card/i.test(json.spec || '') ? json.data : json
        items.push({
          category: 'characters',
          kind: 'character',
          name: data?.name || stripExt(base),
          version: '',
          isCurrent: true,
          payload: json,
          cover: toDataUrl(ab),
          fromPath: path
        })
      } catch (_) {}
      continue
    }

    if (ext === 'json') {
      try {
        const t = await entry.async('string')
        const json = JSON.parse(t)
        const info = classifyJson(json)
        if (info.kind === 'unknown') continue
        const stem = stripExt(base)
        const coverPath = pickImagePath(dir, stem, stem, !inHistory)
        items.push({
          category: info.category,
          kind: info.kind,
          name: info.name || stripExt(dir.split('/').pop() || base),
          version: stem,
          isCurrent: !inHistory,
          payload: info.category === 'themes' ? themePayloadOf(json) : json,
          cover: await imgDataUrl(coverPath),
          fromPath: path
        })
      } catch (_) {}
    }
  }

  // 当前版本排前面，导入后它就是选中版本
  items.sort((a, b) => (a.isCurrent === b.isCurrent ? 0 : a.isCurrent ? -1 : 1))

  return { items, indexMeta }
}

/* ============ 对外主入口 ============ */

/**
 * 识别一批拖入/选中的文件
 * @returns {Promise<Array>} 每个文件一条记录：
 * { fileName, category, kind, name, version, cover, payload, error, source }
 */
/** 让出主线程一帧：大批量解析时界面还能重绘、还能点得动 */
const yieldToUi = () => new Promise((r) => setTimeout(r, 0))

/** 卡片内层数据：v2/v3 规范在 json.data 里，老卡可能直接摊平在顶层 */
function cardBody(payload) {
  if (!payload || typeof payload !== 'object') return null
  const d = payload.data && typeof payload.data === 'object' ? payload.data : payload
  return d && typeof d === 'object' ? d : null
}

/** 卡片自带备注（角色卡作者写的 creator_notes）：压成一行，太长的截断 */
export function cardRemarkOf(category, payload) {
  const d = cardBody(payload)
  const keys = ['creator_notes', 'creator_notes_multilingual', 'creatorcomment', 'creator_comment', 'comment', 'notes']
  let raw = ''
  for (const k of keys) {
    const v = d ? d[k] : ''
    if (typeof v === 'string' && v.trim()) {
      raw = v
      break
    }
  }
  if (!raw && payload && typeof payload === 'object') {
    for (const k of keys) {
      const v = payload[k]
      if (typeof v === 'string' && v.trim()) {
        raw = v
        break
      }
    }
  }
  if (!raw) return ''
  const one = raw.replace(/\r\n?/g, '\n').replace(/\s*\n+\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim()
  return one.length > 200 ? one.slice(0, 200) + '…' : one
}

/** 卡片自带版本号（character_version，如 2.0）；没有就返回空 */
export function cardVersionOf(category, payload) {
  const d = cardBody(payload)
  const cands = [d && d.character_version, payload && payload.character_version, d && d.card_version]
  for (const c of cands) {
    if (c === undefined || c === null) continue
    if (typeof c === 'object') continue
    const s = String(c).trim()
    if (s && s.length <= 32) return s
  }
  return ''
}

/** 导入行统一补齐「备注 / 卡片版本号」：版本名默认就用卡片自带的版本号，用户仍可在表格里改 */
function decorateRow(row) {
  if (!row || row.error) return row
  try {
    const remark = cardRemarkOf(row.category, row.payload)
    const cardVersion = cardVersionOf(row.category, row.payload)
    return { ...row, remark, cardVersion, version: String(row.version || '').trim() || cardVersion }
  } catch (_) {
    return { ...row, remark: '', cardVersion: '' }
  }
}

/** 解析单个文件，返回 0 条（无法识别时返回 1 条带 error 的记录）或 N 条（zip 会拆成多条） */
export async function analyzeOneFile(file) {
  const ext = fileExt(file.name)
  const base = {
    fileName: file.name,
    size: file.size,
    name: stripExt(file.name),
    version: '',
    category: 'others',
    kind: 'unknown',
    source: 'file',
    error: '',
    cover: '',
    payload: null
  }

  try {
    if (ext === 'png') {
      const r = await parsePngCard(file)
      if (!r) return [{ ...base, kind: 'png-no-data', error: 'PNG 中未找到角色卡数据块' }]
      return [decorateRow({ ...base, ...r, name: r.name || stripExt(file.name) })]
    }

    if (ext === 'json') {
      const r = await parseJsonFile(file)
      if (r.error) return [{ ...base, error: r.error }]
      return [decorateRow({ ...base, ...r, name: r.name || stripExt(file.name) })]
    }

    /* 酒馆美化 CSS：整份样式文本作为版本内容，归到「美化」分类 */
    if (ext === 'css') {
      const css = String((await file.text()) || '')
      if (!css.trim()) return [{ ...base, category: 'themes', kind: 'css', error: 'CSS 文件是空的' }]
      return [
        decorateRow({
          ...base,
          category: 'themes',
          kind: 'css',
          name: cssNameOf(css) || stripExt(file.name),
          payload: { css }
        })
      ]
    }

    if (ext === 'zip') {
      const { items, indexMeta } = await parseZip(file)
      if (!items.length) return [{ ...base, kind: 'zip-empty', error: '压缩包内未发现可识别的数据' }]
      return items.map((it) =>
        decorateRow({
          ...base,
          ...it,
          fileName: `${file.name} › ${it.fromPath || it.name}`,
          name: it.name,
          source: 'zip',
          zipName: file.name,
          zipMeta: indexMeta
        })
      )
    }

    if (ext === 'charx' || ext === 'byaf') {
      return [{ ...base, kind: 'pack', error: 'charx / byaf 容器暂未支持（第二阶段）' }]
    }

    return [{ ...base, error: `不支持的文件类型 .${ext}` }]
  } catch (e) {
    return [{ ...base, error: String(e && e.message ? e.message : e) }]
  }
}

/**
 * 后台静默分批解析：每解析 CHUNK 个文件就让出主线程一次，并回调进度
 * @param {FileList|File[]} fileList
 * @param {{onProgress?:(p:{done:number,total:number,rows:number})=>void, chunk?:number, shouldStop?:()=>boolean}} opt
 */
export async function analyzeFiles(fileList, opt = {}) {
  const list = Array.from(fileList || [])
  const onProgress = typeof opt.onProgress === 'function' ? opt.onProgress : null
  const chunk = Math.max(1, Number(opt.chunk) || 4)
  const out = []
  for (let i = 0; i < list.length; i++) {
    if (typeof opt.shouldStop === 'function' && opt.shouldStop()) break
    out.push(...(await analyzeOneFile(list[i])))
    if ((i + 1) % chunk === 0 || i === list.length - 1) {
      onProgress?.({ done: i + 1, total: list.length, rows: out.length })
      await yieldToUi()
    }
  }
  return out
}

/** 卡片自带日期：创建/修改时间取更早的那个，作为文件系统时间缺失时的兜底 */
export function dateFromPayload(category, payload) {
  const d = payload && payload.data && typeof payload.data === 'object' ? payload.data : payload
  if (!d || typeof d !== 'object') return ''
  let earliest = null
  const cands = [
    d.create_date,
    d.created_at,
    d.creation_date,
    d.modify_date,
    d.update_date,
    d.updated_at,
    d.date,
    payload && payload.create_date,
    payload && payload.modify_date
  ]
  for (const c of cands) {
    if (c === undefined || c === null || c === '') continue
    const t = typeof c === 'number' ? new Date(c) : new Date(String(c))
    if (Number.isNaN(t.getTime())) continue
    const y = t.getFullYear()
    if (y < 2000 || y > 2100) continue
    if (!earliest || t.getTime() < earliest.getTime()) earliest = t
  }
  if (!earliest) return ''
  const p2 = (n) => String(n).padStart(2, '0')
  return `${earliest.getFullYear()}-${p2(earliest.getMonth() + 1)}-${p2(earliest.getDate())}`
}

/**
 * 依据卡片内容生成默认版本名：默认就是这一版的日期
 * 角色卡取卡片自带的「创建 / 修改」时间中更早的那天；读不到就返回空，
 * 由导入流程用文件系统里最早的时间（即导入日期）兜底。
 * 版本名本身允许用户改成任意字母 / 汉字。
 */
export function defaultVersionName(category, payload) {
  return dateFromPayload(category, payload) || ''
}
