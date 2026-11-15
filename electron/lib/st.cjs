'use strict'
/* 酒馆（SillyTavern）文件层操作：扫描、导入新建、替换更新、世界书读写备份
   全程直接操作 data/<user>/ 下的文件，酒馆开不开都能用；
   刷新前端由本地通知服务 + 酒馆前端扩展完成。 */

const fs = require('node:fs')
const path = require('node:path')
const png = require('./png.cjs')
const digest = require('./digest.cjs')
const thumb = require('./thumb.cjs')

/* ---------------- 目录 ---------------- */

function userDirs(tavernPath, user) {
  const root = path.join(String(tavernPath || ''), 'data', String(user || 'default-user'))
  return {
    root,
    characters: path.join(root, 'characters'),
    worlds: path.join(root, 'worlds'),
    chats: path.join(root, 'chats'),
    extensions: path.join(root, 'extensions'),
    /* 酒馆缩略图缓存：data/<user>/thumbnails/avatar/<avatar>.<fmt>，按 avatar 文件名一一对应。
       首屏由酒馆前端懒生成（并发生成常失败），所以洛书匣写完卡后主动在这里落一份。 */
    thumbnails: path.join(root, 'thumbnails', 'avatar')
  }
}

function exists(p) {
  try { return fs.existsSync(p) } catch (_) { return false }
}

/* ---------------- 真实用户目录解析 ----------------
 * 酒馆的用户目录是 data/<user>/。settings.stUser 是历史遗留值（可能被重置成
 * 一个根本不存在的名字，如 zztest），以前所有路径都直接拼它，于是扩展明明装在
 * data/default-user 下也被判成「未安装」。
 * 这里统一解析：优先传入值 → default-user → data 下真实存在的用户目录；
 * 酒馆 config.yaml 里 enableUserAccounts: false 时酒馆只用 default-user，直接以它为准。
 * 判定（extStatus）与写入（requireTavern / injectExt）都走这一份逻辑，避免再次漂移。 */

/** 读酒馆 config.yaml 的多账号开关：true / false / null（读不到或没这一项 = 未知） */
function userAccountsEnabled(tavernPath) {
  try {
    const p = path.join(String(tavernPath || ''), 'config.yaml')
    if (!exists(p)) return null
    const text = fs.readFileSync(p, 'utf8')
    const m = text.match(/^[ \t]*enableUserAccounts[ \t]*:[ \t]*(true|false)/im)
    if (!m) return null
    return m[1].toLowerCase() === 'true'
  } catch (_) {
    return null
  }
}

/** data 下真实存在的用户目录名（跳过 _cache / _uploads 这类系统目录） */
function listUserDirs(tavernPath) {
  const dataRoot = path.join(String(tavernPath || ''), 'data')
  let subs = []
  try { subs = fs.readdirSync(dataRoot, { withFileTypes: true }) } catch (_) { return [] }
  const out = []
  for (const d of subs) {
    if (!d.isDirectory()) continue
    if (d.name.startsWith('_') || d.name.startsWith('.')) continue
    out.push(d.name)
  }
  return out
}

/**
 * 解析实际使用的酒馆用户目录
 * @returns {{user:string, want:string, corrected:boolean, dirs:object,
 *            candidates:Array<{user:string, dirs:object}>, accounts:boolean|null}}
 */
function resolveUserDir(tavernPath, user) {
  const tp = String(tavernPath || '')
  const want = String(user || '').trim() || 'default-user'
  const accounts = userAccountsEnabled(tp)
  const order = []
  const add = (u) => { if (u && !order.includes(u)) order.push(u) }
  if (accounts === false) {
    /* 酒馆没开多账号：任何非 default-user 的值都是死值，只认 default-user */
    add('default-user')
  } else {
    add(want)
    add('default-user')
    for (const u of listUserDirs(tp)) add(u)
  }
  let hit = ''
  for (const u of order) {
    if (exists(path.join(tp, 'data', u))) { hit = u; break }
  }
  const picked = hit || (accounts === false ? 'default-user' : want)
  return {
    user: picked,
    want,
    corrected: picked !== want,
    accounts,
    dirs: userDirs(tp, picked),
    candidates: order.map((u) => ({ user: u, dirs: userDirs(tp, u) }))
  }
}

/** 扩展的历史安装位置（早期 GitHub 安装写的是 public/scripts/extensions/third-party） */
function legacyExtRoots(tavernPath) {
  const tp = String(tavernPath || '')
  return [
    path.join(tp, 'public', 'scripts', 'extensions', 'third-party'),
    path.join(tp, 'public', 'extensions')
  ]
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

/** 写入前校验：酒馆目录必须真实存在（不自动创建，避免路径填错时在别处凭空生成空目录） */
function requireTavern(tavernPath, user) {
  const tp = String(tavernPath || '').trim()
  if (!tp) return { ok: false, error: '还没设置酒馆安装路径（形如 F:\\SillyTavern）', dirs: userDirs(tavernPath, user) }
  if (!exists(tp)) return { ok: false, error: '找不到酒馆目录：' + tp + '，请在设置里填写正确的酒馆安装路径', dirs: userDirs(tavernPath, user) }
  /* stUser 可能是不存在的死值：这里统一回退到真实存在的用户目录，保证「判定」与「写入」同源 */
  const rs = resolveUserDir(tp, user)
  const dirs = rs.dirs
  if (!exists(dirs.root)) {
    return {
      ok: false,
      error: '酒馆目录里找不到数据目录：' + dirs.root + '，请确认酒馆已至少启动过一次',
      dirs,
      user: rs.user
    }
  }
  try {
    fs.accessSync(dirs.root, fs.constants.W_OK)
  } catch (_) {
    return {
      ok: false,
      error: '没有写入权限：' + dirs.root + '，请检查目录权限或以管理员身份运行',
      dirs,
      user: rs.user
    }
  }
  return { ok: true, dirs, user: rs.user, want: rs.want, corrected: rs.corrected }
}

/** 酒馆的文件名规则：去掉路径非法字符，保留中文与空格 */
function safeFile(name, fallback = 'untitled') {
  let s = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\.+$/, '')
    .trim()
    .slice(0, 120)
  if (!s) s = fallback
  return s
}

/* ---------------- 扫描 ---------------- */

/** 列出酒馆里的角色卡：avatar 文件名 + 卡内信息 + 内容签名
 * opts.light = true 时不解析 PNG 内容（只给文件名与大小），用于书架/对比时的「先列名单」；
 * opts.only = ['avatar1', ...] 时只解析这些文件（大小写不敏感）。
 * 之前无条件解析每张 PNG，是进书架卡顿的主因之一。 */
function scanCharacters(tavernPath, user, opts = {}) {
  const dirs = resolveUserDir(tavernPath, user).dirs
  if (!exists(dirs.characters)) return { ok: false, error: '找不到角色卡目录：' + dirs.characters, dir: dirs.characters, list: [] }
  const out = []
  const light = !!opts.light
  const only = Array.isArray(opts.only) && opts.only.length
    ? new Set(opts.only.map((x) => String(x || '').replace(/\.png$/i, '').toLowerCase()))
    : null
  for (const name of fs.readdirSync(dirs.characters)) {
    if (!/\.png$/i.test(name)) continue
    const full = path.join(dirs.characters, name)
    let st = null
    try { st = fs.statSync(full) } catch (_) { continue }
    if (!st.isFile()) continue
    const avatar = name.replace(/\.png$/i, '')
    if (light || (only && !only.has(avatar.toLowerCase()))) {
      out.push({
        avatar,
        file: name,
        path: full,
        name: avatar,
        sig: '',
        digest: '',
        hasCard: null,
        world: '',
        worlds: [],
        creator: '',
        size: st.size,
        ctime: st.birthtimeMs || st.ctimeMs,
        mtime: st.mtimeMs
      })
      continue
    }
    let json = null
    try { json = png.readCardJson(fs.readFileSync(full)) } catch (_) {}
    const data = png.cardData(json)
    // 角色卡绑定世界书的几种写法都收进来：extensions.world / 内嵌书名字 / data.extensions.world
    const w1 = String(data?.extensions?.world || '')
    const w2 = String(data?.character_book?.name || '')
    const w3 = String(data?.data?.extensions?.world || '')
    const worlds = Array.from(new Set([w1, w2, w3].filter(Boolean)))
    out.push({
      avatar: name.replace(/\.png$/i, ''),
      file: name,
      path: full,
      name: String(data?.name || name.replace(/\.png$/i, '')),
      sig: json ? png.cardSig(json) : '',
      digest: json ? digest.charDigest(data) : '',
      hasCard: !!json,
      world: worlds[0] || '',
      worlds,
      creator: String(data?.creator || data?.created_by || ''),
      size: st.size,
      ctime: st.birthtimeMs || st.ctimeMs,
      mtime: st.mtimeMs
    })
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return { ok: true, dir: dirs.characters, list: out }
}

/**
 * 只对指定的几个文件算内容指纹（对比酒馆当前加载的是哪一版用）
 * 与「全量扫描」相比，这里只读 1~N 个同名候选文件，进书架/进详情都不会卡。
 * opt = { kind: 'characters' | 'worldbooks' | 'presets' | 'themes', files: [{ path, name, engine }] }
 */
function probeDigests(opt = {}) {
  const kind = String(opt.kind || 'characters')
  const files = Array.isArray(opt.files) ? opt.files : []
  const out = []
  for (const f of files) {
    const full = String((f && f.path) || '')
    if (!full || !exists(full)) continue
    const base = path.basename(full)
    const stem = base.replace(/\.(png|json)$/i, '')
    try {
      if (kind === 'characters') {
        const buf = fs.readFileSync(full)
        const json = png.readCardJson(buf)
        const data = png.cardData(json)
        out.push({
          path: full,
          file: base,
          avatar: stem,
          name: String(data?.name || stem),
          sig: json ? png.cardSig(json) : '',
          digest: json ? digest.charDigest(data) : '',
          world: String(data?.extensions?.world || ''),
          size: buf.length
        })
      } else if (kind === 'worldbooks') {
        const j = readWorldFile(full)
        out.push({
          path: full,
          file: base,
          name: stem,
          digest: j ? digest.worldDigest(j) : '',
          entries: j && j.entries && typeof j.entries === 'object' ? Object.keys(j.entries).length : 0
        })
      } else if (kind === 'themes') {
        /* 美化：指纹只算样式内容与外观字段，主题名等元信息不参与（见 digest.cjs 的 themeDigest） */
        let j = null
        try { j = JSON.parse(fs.readFileSync(full, 'utf8')) } catch (_) { j = null }
        out.push({
          path: full,
          file: base,
          name: String((j && j.name) || '').trim() || stem,
          digest: j ? digest.themeDigest(j) : '',
          kind: j && String((j && (j.customCSS || j.custom_css)) || '').trim() ? 'css' : 'ui'
        })
      } else {
        let j = null
        try { j = JSON.parse(fs.readFileSync(full, 'utf8')) } catch (_) { j = null }
        out.push({
          path: full,
          file: base,
          name: stem,
          digest: j ? digest.presetDigest(j) : '',
          engine: path.basename(path.dirname(full)).replace(/\s*settings$/i, '')
        })
      }
    } catch (e) {
      out.push({ path: full, file: base, name: stem, digest: '', error: String((e && e.message) || e) })
    }
  }
  return { ok: true, kind, list: out }
}

/** 列出酒馆里的世界书 */
function scanWorlds(tavernPath, user) {
  const dirs = resolveUserDir(tavernPath, user).dirs
  if (!exists(dirs.worlds)) return { ok: false, error: '找不到世界书目录：' + dirs.worlds, dir: dirs.worlds, list: [] }
  const out = []
  for (const name of fs.readdirSync(dirs.worlds)) {
    if (!/\.json$/i.test(name)) continue
    const full = path.join(dirs.worlds, name)
    let st = null
    try { st = fs.statSync(full) } catch (_) { continue }
    if (!st.isFile()) continue
    out.push({
      name: name.replace(/\.json$/i, ''),
      file: name,
      path: full,
      size: st.size,
      ctime: st.birthtimeMs || st.ctimeMs,
      mtime: st.mtimeMs
    })
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return { ok: true, dir: dirs.worlds, list: out }
}

/** 判断一个 json 是否是"带提示词内容的真预设"。
 * 酒馆在 NovelAI / KoboldAI / TextGen 等 Settings 目录里还放了一堆只有采样参数的
 * 官方引擎预设（几百字节到 2KB，没有 prompts），它们不是用户要导入的预设。 */
function isPromptPreset(full) {
  let j = null
  try {
    j = JSON.parse(fs.readFileSync(full, 'utf8'))
  } catch (_) {
    return false
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return false
  if (Array.isArray(j.prompts) && j.prompts.length) return true
  if (Array.isArray(j.prompt_order) && j.prompt_order.length) return true
  return false
}

/** 列出酒馆里的预设（各引擎的设置目录里的 json）
 * opts.includeSamplerPresets = true 时连只有采样参数的引擎预设一起列出（默认屏蔽） */
function scanPresets(tavernPath, user, opts = {}) {
  const includeSampler = !!opts.includeSamplerPresets
  const dirs = resolveUserDir(tavernPath, user).dirs
  const out = []
  const hidden = []
  if (!exists(dirs.root)) return { ok: false, error: '找不到酒馆用户目录：' + dirs.root, list: out }
  let subs = []
  try { subs = fs.readdirSync(dirs.root, { withFileTypes: true }) } catch (_) { return { ok: false, error: '读不了酒馆用户目录', list: out } }
  for (const d of subs) {
    if (!d.isDirectory()) continue
    if (!/settings$/i.test(d.name)) continue
    const sub = path.join(dirs.root, d.name)
    let files = []
    try { files = fs.readdirSync(sub) } catch (_) { continue }
    for (const name of files) {
      if (!/\.json$/i.test(name)) continue
      const full = path.join(sub, name)
      let st = null
      try { st = fs.statSync(full) } catch (_) { continue }
      if (!st.isFile()) continue
      const item = {
        name: name.replace(/\.json$/i, ''),
        file: name,
        path: full,
        engine: d.name.replace(/\s*settings$/i, ''),
        size: st.size,
        ctime: st.birthtimeMs || st.ctimeMs,
        mtime: st.mtimeMs
      }
      if (!includeSampler && !isPromptPreset(full)) {
        hidden.push(item)
        continue
      }
      out.push(item)
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return { ok: true, list: out, hidden: hidden.length, hiddenList: hidden }
}

/** 酒馆「UI 主题」里真正影响外观的字段（themes/*.json 有两种：写 CSS 的、只存这些字段的） */
const UI_THEME_KEYS = [
  'main_text_color', 'italics_text_color', 'underline_text_color', 'quote_text_color',
  'blur_tint_color', 'chat_tint_color', 'user_mes_blur_tint_color', 'bot_mes_blur_tint_color',
  'shadow_color', 'border_color', 'blur_strength', 'shadow_width', 'font_scale', 'chat_width',
  'avatar_style', 'chat_display', 'noShadows', 'fast_ui_mode', 'waifuMode', 'reduced_motion',
  'compact_input_area', 'hideChatAvatars_enabled', 'expand_message_actions', 'media_display',
  'click_to_edit', 'timestamps_enabled', 'mesIDDisplay_enabled', 'message_token_count_enabled'
]

/** 从主题 json 里摘出外观字段（命中字段太少就说明不是 UI 主题） */
function uiThemeFieldsOf(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null
  const hit = UI_THEME_KEYS.filter((k) => k in j).length
  if (hit < 3) return null
  const out = {}
  for (const k of UI_THEME_KEYS) if (k in j) out[k] = j[k]
  return out
}

/** 列出酒馆里的美化主题（themes/*.json，名称与样式都在 json 里） */
function scanThemes(tavernPath, user) {
  const dirs = resolveUserDir(tavernPath, user).dirs
  const out = []
  if (!exists(dirs.root)) return { ok: false, error: '找不到酒馆用户目录：' + dirs.root, list: out }
  const dir = path.join(dirs.root, 'themes')
  if (!exists(dir)) return { ok: false, error: '找不到酒馆主题目录：' + dir, list: out }
  let files = []
  try { files = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) {
    return { ok: false, error: '读不了酒馆主题目录', list: out }
  }
  for (const d of files) {
    if (!d.isFile() || !/\.json$/i.test(d.name)) continue
    const full = path.join(dir, d.name)
    let st = null
    try { st = fs.statSync(full) } catch (_) { continue }
    if (!st.isFile()) continue
    let j = null
    try { j = JSON.parse(fs.readFileSync(full, 'utf8')) } catch (_) { j = null }
    const css = String((j && (j.customCSS || j.custom_css)) || '')
    /* 酒馆的美化有两种写法：① 自己写 CSS（customCSS）；② 只在 json 里存颜色、模糊、头像形状等外观字段。
       两种都算美化，区别只在预览怎么还原，不能把不写 CSS 的那种直接丢掉 */
    const fields = uiThemeFieldsOf(j)
    if (!css.trim() && !fields) continue
    const nm = String((j && j.name) || '').trim() || d.name.replace(/\.json$/i, '')
    out.push({
      name: nm,
      file: d.name,
      path: full,
      cssLen: css.length,
      kind: css.trim() ? 'css' : 'ui',
      theme: fields || null,
      size: st.size,
      ctime: st.birthtimeMs || st.ctimeMs,
      mtime: st.mtimeMs
    })
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return { ok: true, dir, list: out }
}

/* 酒馆界面自己的样式表（public/style.css + css/toggle-dependent.css）：
   美化预览要拿它们当底，选择器、气泡/头像等开关类才能和酒馆里一致 */
let uiCssCache = { path: '', mtime: 0, css: '' }
let faFontCache = { path: '', mtime: 0, css: '' }
/* 酒馆的字体图标：
   fontawesome.min.css 只声明 font-family，真正的 @font-face 在 css/solid.min.css 里，
   指向 ../webfonts/fa-solid-900.woff2。
   预览 iframe 是 srcdoc 文档，file:// 子资源（尤其是字体）很容易被拦，
   与其赌能不能加载，不如直接把 woff2 内联成 data URL 注进去，图标 100% 可显示。
   顺带补上 solid.min.css 的那条 font-weight 规则——没有它浏览器会退到 400 字重。 */
function readFaFont(tavernPath) {
  const root = String(tavernPath || '').trim()
  if (!root) return { ok: false, error: '还没设置酒馆路径' }
  const woff2 = path.join(root, 'public', 'webfonts', 'fa-solid-900.woff2')
  const ttf = path.join(root, 'public', 'webfonts', 'fa-solid-900.ttf')
  const pick = exists(woff2) ? woff2 : exists(ttf) ? ttf : ''
  if (!pick) return { ok: false, error: '找不到图标字体文件：' + woff2 }
  let mtime = 0
  try { mtime = fs.statSync(pick).mtimeMs } catch (_) {}
  if (faFontCache.path === pick && faFontCache.mtime === mtime && faFontCache.css) {
    return { ok: true, path: pick, css: faFontCache.css, len: faFontCache.css.length }
  }
  let b64 = ''
  try { b64 = fs.readFileSync(pick).toString('base64') } catch (_) {}
  if (!b64) return { ok: false, error: '读不了图标字体文件：' + pick }
  const fmt = pick.toLowerCase().endsWith('.ttf') ? 'truetype' : 'woff2'
  const css = `@font-face{font-family:"Font Awesome 6 Free";font-style:normal;font-weight:900;font-display:block;src:url(data:font/${fmt};base64,${b64}) format("${fmt}")}\n.fa-solid,.fas{font-weight:900}\n`
  faFontCache = { path: pick, mtime, css }
  return { ok: true, path: pick, css, len: css.length }
}

function readUiCss(tavernPath) {
  const root = String(tavernPath || '').trim()
  if (!root) return { ok: false, error: '还没设置酒馆路径' }
  /* 酒馆界面不是只靠 style.css：
     布局靠 st-tailwind.css（flex-container / wide100p / alignitemscenter 这些类），
     背景层靠 backgrounds.css（#bg1 / #bg_custom），
     角色管理面板的网格、标签、世界书、扩展面板也各有自己的样式表。
     缺了这些，预览的 DOM 结构再对，布局类也全部失效 → 面板看起来「变形」。 */
  const extraCss = [
    ['css', 'toggle-dependent.css'],
    ['css', 'st-tailwind.css'],
    ['css', 'backgrounds.css'],
    ['css', 'tags.css'],
    ['css', 'world-info.css'],
    ['css', 'rm-groups.css'],
    ['css', 'extensions-panel.css'],
    ['css', 'promptmanager.css'],
    ['css', 'scrollable-button.css'],
    ['css', 'animations.css'],
    ['css', 'mobile-styles.css']
  ].map((p) => path.join(root, 'public', ...p))
  const files = [path.join(root, 'public', 'style.css'), ...extraCss]
  const main = files[0]
  if (!exists(main)) return { ok: false, error: '找不到酒馆样式文件：' + main }
  let mtime = 0
  for (const f of files) {
    try { mtime = Math.max(mtime, fs.statSync(f).mtimeMs) } catch (_) {}
  }
  if (uiCssCache.path === main && uiCssCache.mtime === mtime && uiCssCache.css) {
    return { ok: true, path: main, css: uiCssCache.css, len: uiCssCache.css.length }
  }
  const parts = []
  for (const f of files) {
    if (!exists(f)) continue
    try { parts.push(fs.readFileSync(f, 'utf8')) } catch (_) {}
  }
  const css = parts.join('\n\n')
  if (!css.trim()) return { ok: false, error: '读不了酒馆样式文件' }
  uiCssCache = { path: main, mtime, css }
  return { ok: true, path: main, css, len: css.length }
}

/* 详情页预览回源：老库里的美化只存了 { css, name }，外观字段（颜色/模糊/头像形状）被丢掉了。
   源文件还在酒馆里就直接读原始 json 把字段补齐，不用重新导入一遍。
   只允许读酒馆 themes 目录下的 json，别的一概拒绝。 */
/** 在酒馆 themes 目录里按主题名找文件：先比文件名（去掉 .json），再比 json 里的 name */
function findThemeFileByName(base, name) {
  const want = String(name || '').trim()
  if (!want || !exists(base)) return ''
  let files = []
  try { files = fs.readdirSync(base).filter((f) => /\.json$/i.test(f)) } catch (_) { return '' }
  const stem = want.replace(/\.json$/i, '')
  for (const f of files) if (f.replace(/\.json$/i, '') === stem) return path.join(base, f)
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(base, f), 'utf8'))
      if (String((j && j.name) || '') === want) return path.join(base, f)
    } catch (_) {}
  }
  return ''
}

function readThemeSrc(tavernPath, user, filePath, themeName) {
  const want = String(filePath || '').trim()
  const dirs = resolveUserDir(tavernPath, user).dirs
  const base = path.join(dirs.root, 'themes')
  let real = ''
  if (want) {
    try { real = path.resolve(want) } catch (_) { real = '' }
  }
  /* 从备份 zip 恢复进来的老美化没留下 srcPath，侧车里也只剩空壳，
     只剩名字可用 —— 按名字在酒馆 themes 目录里捞一次，避免预览退化成统一的默认深色 */
  if (!real || !exists(real)) {
    const nm = String(themeName || '').trim() || want
    if (!nm) return { ok: false, error: '没有源文件路径' }
    const hit = findThemeFileByName(base, nm)
    if (!hit) return { ok: false, error: '源文件已不在：' + (want || nm) }
    real = hit
  }
  const rel = path.relative(path.resolve(base), real)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: '只允许读酒馆 themes 目录里的文件' }
  if (!/\.json$/i.test(real)) return { ok: false, error: '不是 json 文件' }
  let j = null
  try { j = JSON.parse(fs.readFileSync(real, 'utf8')) } catch (_) { return { ok: false, error: '解析不了主题 json' } }
  const css = String((j && (j.customCSS || j.custom_css)) || '')
  return {
    ok: true,
    path: real,
    name: String((j && j.name) || ''),
    css,
    theme: uiThemeFieldsOf(j)
  }
}

/** 只列出没被任何角色卡绑定的世界书 */
function scanWorldsUnbound(tavernPath, user) {
  const all = scanWorlds(tavernPath, user)
  if (!all.ok) return all
  const chars = scanCharacters(tavernPath, user)
  const bound = new Set()
  const addBound = (v) => {
    let s = String(v || '').trim().toLowerCase()
    if (!s) return
    bound.add(s)
    bound.add(s.replace(/\.json$/i, ''))
  }
  for (const c of chars.list || []) {
    addBound(c.world)
    for (const w of c.worlds || []) addBound(w)
  }
  const isBound = (w) => {
    const stem = String(w.name || '').toLowerCase()
    return bound.has(stem) || bound.has(stem + '.json') || bound.has(String(w.file || '').toLowerCase())
  }
  const list = (all.list || []).filter((w) => !isBound(w))
  return { ok: true, dir: all.dir, list, boundCount: bound.size, total: (all.list || []).length }
}

/* ---------------- 世界书：角色内嵌 book ↔ 酒馆 world info ---------------- */

function truthy(v, def = false) {
  return typeof v === 'boolean' ? v : def
}

function num(v, def) {
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}

/** 角色卡 character_book（数组条目）→ 酒馆世界书（以 uid 为键的对象） */
function bookToWorldInfo(book, fallbackName) {
  const src = book && typeof book === 'object' ? book : {}
  const list = Array.isArray(src.entries) ? src.entries : []
  const entries = {}
  list.forEach((e, i) => {
    const ext = e.extensions || {}
    const uid = Number.isFinite(Number(e.id)) ? Number(e.id) : i
    entries[String(uid)] = {
      uid,
      key: Array.isArray(e.keys) ? e.keys : e.key ? [e.key] : [],
      keysecondary: Array.isArray(e.secondary_keys) ? e.secondary_keys : [],
      comment: String(e.name || e.comment || ''),
      content: String(e.content || ''),
      constant: truthy(e.constant, false),
      vectorized: false,
      selective: truthy(e.selective, true),
      selectiveLogic: num(ext.selectiveLogic, 0),
      addMemo: true,
      order: num(e.insertion_order, 100),
      position: num(ext.position, 0),
      disable: e.enabled === false,
      excludeRecursion: truthy(ext.exclude_recursion, false),
      preventRecursion: truthy(ext.prevent_recursion, false),
      delayUntilRecursion: num(ext.delay_until_recursion, 0),
      probability: num(ext.probability, 100),
      useProbability: truthy(ext.useProbability, true),
      depth: num(ext.depth, 4),
      group: String(ext.group || ''),
      groupOverride: false,
      groupWeight: 100,
      scanDepth: null,
      caseSensitive: null,
      matchWholeWords: null,
      useGroupScoring: null,
      automationId: '',
      role: num(ext.role, 0),
      sticky: 0,
      cooldown: 0,
      delay: 0
    }
  })
  return {
    name: String(src.name || fallbackName || ''),
    entries,
    originalData: src
  }
}

function readWorldFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return JSON.parse(raw)
  } catch (_) {
    return null
  }
}

/** 备份世界书时只回传文本 + 条目数 + 字节数，不把整棵对象树过 IPC */
function worldBackupText(file) {
  const text = fs.readFileSync(file, 'utf8')
  let entries = 0
  try {
    const j = JSON.parse(text)
    entries = j && j.entries && typeof j.entries === 'object' ? Object.keys(j.entries).length : 0
  } catch (_) {}
  let size = 0
  try { size = fs.statSync(file).size } catch (_) {}
  return { text, entries, size }
}

/* ---------------- 导入 / 替换 ---------------- */

/**
 * 给「另起基名新建」算一个真正不撞名的基名。
 * 用户选定独立基名后不该继续生成 (n) 副本，所以这里先看同名文件是否已被占用，
 * 占用就派生「X 新 / X 新2 …」，直到拿到一个干净基名；名字为空时兜底 'character'。
 */
function independentBaseName(dirs, name) {
  const base = safeFile(String(name || '').trim() || 'character')
  let candidate = base
  let i = 1
  while (exists(path.join(dirs.characters, candidate + '.png')) || exists(path.join(dirs.chats, candidate))) {
    candidate = `${base} 新${i === 1 ? '' : i}`
    i++
    if (i > 99) break
  }
  return candidate
}

/** 生成酒馆里不重名的 avatar 文件名（酒馆允许同名角色并存，靠文件名区分） */
function uniqueAvatar(dirs, baseName) {
  const base = safeFile(baseName || 'character')
  let candidate = base
  let i = 1
  while (exists(path.join(dirs.characters, candidate + '.png')) || exists(path.join(dirs.chats, candidate))) {
    candidate = `${base} (${i})`
    i++
    if (i > 999) break
  }
  return candidate
}

/**
 * 在酒馆 characters 目录里按名字定位真实的卡文件：先比文件名（avatar），再比卡内角色名
 * 返回 { avatar, file, buffer }，找不到返回 null
 */
function locateCardByName(dirs, name) {
  const want = String(name || '').trim().toLowerCase()
  if (!want) return null
  let files = []
  try {
    files = fs.readdirSync(dirs.characters)
  } catch (_) {
    return null
  }
  const pngs = files.filter((f) => /\.png$/i.test(f))
  for (const f of pngs) {
    if (f.replace(/\.png$/i, '').toLowerCase() === want) {
      const file = path.join(dirs.characters, f)
      try {
        return { avatar: f.replace(/\.png$/i, ''), file, buffer: fs.readFileSync(file) }
      } catch (_) {}
    }
  }
  for (const f of pngs) {
    const file = path.join(dirs.characters, f)
    try {
      const b = fs.readFileSync(file)
      const d = png.cardData(png.readCardJson(b))
      if (String((d && d.name) || '').trim().toLowerCase() === want) {
        return { avatar: f.replace(/\.png$/i, ''), file, buffer: b }
      }
    } catch (_) {}
  }
  return null
}

/**
 * 某张卡绑定的聊天记录（chats/<avatar>/*.jsonl）数量与各自体积
 * 同名卡副本靠文件名区分不了时，这是最直观的区分依据：哪个副本真在用
 */
function chatStatsOf(dirs, avatar) {
  const out = { count: 0, total: 0, files: [] }
  const name = String(avatar || '').trim()
  if (!name) return out
  const dir = path.join(dirs.chats, name)
  let list = []
  try {
    list = fs.readdirSync(dir, { withFileTypes: true })
  } catch (_) {
    return out
  }
  for (const ent of list) {
    if (ent.isDirectory()) continue
    if (!/\.jsonl$/i.test(ent.name)) continue
    try {
      const s = fs.statSync(path.join(dir, ent.name))
      out.count++
      out.total += s.size
      out.files.push({ name: ent.name, size: s.size, mtime: s.mtimeMs })
    } catch (_) {}
  }
  /* 大的排前面：通常就是主力存档 */
  out.files.sort((a, b) => b.size - a.size || b.mtime - a.mtime)
  return out
}

/**
 * 角色名的「同族」归一：去掉 .png、酒馆副本号 (1)、以及 2.0 / 2024 这类版本尾缀。
 * 统一成一个函数，供「传进来的基名」和「磁盘上的文件名」共用同一套规则——
 * 之前只有文件名侧归一，传 方亦楷2.0 去判同族就一张都匹配不上。
 */
function normCardName(x) {
  return String(x || '')
    .replace(/\.png$/i, '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/[\s_-]*\d+(\.\d+)*$/, '')
    .trim()
    .toLowerCase()
}

/**
 * 找出 characters 里「同一角色的多个副本」：方亦楷.png / 方亦楷 (1).png / 方亦楷(2).png
 * 用于替换前确认，避免写错副本
 */
function sameBaseCandidates(dirs, avatar) {
  /* 基名与文件名必须走同一套归一：baseName 本身带版本尾缀（方亦楷2.0 / 方亦楷2024）时
     也要能判出同族，否则新建会绕过三选一继续追加 (n) 副本 */
  const base = normCardName(avatar)
  if (!base) return []
  let files = []
  try {
    files = fs.readdirSync(dirs.characters)
  } catch (_) {
    return []
  }
  const out = []
  const loose = []
  for (const f of files) {
    if (!/\.png$/i.test(f)) continue
    const stem = f.replace(/\.png$/i, '')
    /* (1)/(2) 是酒馆存副本的写法，2.0 / 2 这类版本号尾缀同样是在同一角色名下并存，
       两者都归一掉再比：方亦楷 (1) / 方亦楷2.0 → 方亦楷 */
    const plain = normCardName(stem)
    /* 排序权重：同名本体 → 带 (1)/(2) 的副本 → 「名字 + 后缀」的变体
       （酒馆里常用 方亦楷哇哦 / 方亦楷哦哦 这种方式让同名角色并存，只认数字后缀就全漏掉了） */
    let rank = -1
    const lower = stem.trim().toLowerCase()
    if (plain === base) {
      rank = lower === base ? 0 : 1
    } else if (lower.length > base.length && lower.startsWith(base) && lower.length - base.length <= 12) {
      rank = 2
    }
    if (rank < 0) continue
    const file = path.join(dirs.characters, f)
    try {
      const s = fs.statSync(file)
      /* 聊天统计单独 try：统计目录缺失/读不动时也要把这张卡列出来，
         否则候选一空就成了「不弹窗、直接替换」，正是用户反馈的那个乱象 */
      let chats = { count: 0, total: 0, files: [] }
      try {
        chats = chatStatsOf(dirs, stem)
      } catch (_) {}
      const rec = { avatar: stem, file, size: s.size, mtime: s.mtimeMs, rank, chats }
      if (rank <= 1) out.push(rec)
      else loose.push(rec)
    } catch (_) {}
  }
  /* 有「同名本体 / (1)(2) 副本」时就只认这些，不再把「名字 + 后缀」的卡混进来，
     免得把别的角色（比如 方亦楷的邻居）误判成同一张卡的副本 */
  const list = out.length ? out : loose
  /* 名字最"干净"的排前面（方亦楷 优先于 方亦楷 (1)，再往后才是各种后缀变体） */
  list.sort((a, b) => a.rank - b.rank || a.avatar.length - b.avatar.length || a.mtime - b.mtime)
  return list.map(({ rank, ...rest }) => rest)
}

/**
 * 在酒馆 characters 目录里按名字找一张现成的卡，用作「只有 JSON、没有图片」时的底图
 */
function findCardImageByName(dirs, name) {
  const loc = locateCardByName(dirs, name)
  return loc ? loc.buffer : null
}

/** 酒馆缩略图配置：默认跟随酒馆（avatar 96x144，可在 config.yaml 的 thumbnails.dimensions 里改） */
function thumbConfig(tavernPath) {
  const out = { enabled: true, width: 96, height: 144 }
  try {
    const p = path.join(String(tavernPath || ''), 'config.yaml')
    if (!exists(p)) return out
    const text = fs.readFileSync(p, 'utf8')
    const en = text.match(/^[ \t]*thumbnails[ \t]*:[ \t]*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+enabled[ \t]*:[ \t]*(true|false)/im)
    if (en) out.enabled = en[1].toLowerCase() === 'true'
    const dim = text.match(/^[ \t]+avatar[ \t]*:[ \t]*\[[ \t]*(\d+)[ \t]*,[ \t]*(\d+)[ \t]*\]/im)
    if (dim) {
      out.width = parseInt(dim[1], 10) || 96
      out.height = parseInt(dim[2], 10) || 144
    }
  } catch (_) {}
  return out
}

/**
 * 预热一张角色卡的缩略图缓存（酒馆侧 data/<user>/thumbnails/avatar/<avatar>）
 * 酒馆首屏并发生成，常见几张生成失败 → 缩略图空白/串图，刷新才恢复；
 * 这里按酒馆同样的规则先落一份缓存，让酒馆直接命中。
 * 只补缓存，不删除、不改名酒馆任何现有文件；已有且比原图新时直接跳过。
 * @returns {{ok:boolean, cached?:boolean, generated?:'thumb'|'copy', path?:string, error?:string, skipped?:string}}
 */
function warmAvatarThumbnail(tavernPath, user, avatar) {
  const name = String(avatar || '').trim()
  if (!name) return { ok: false, error: 'NO_AVATAR' }
  const pre = requireTavern(tavernPath, user)
  if (!pre.ok) return { ok: false, error: pre.error }
  const dirs = pre.dirs
  const src = path.join(dirs.characters, name)
  if (!exists(src)) return { ok: false, error: 'NO_SRC' }
  const cfg = thumbConfig(tavernPath)
  if (!cfg.enabled) return { ok: true, skipped: 'disabled' }
  const dst = path.join(dirs.thumbnails, name)
  try {
    if (exists(dst)) {
      const so = fs.statSync(src)
      const dc = fs.statSync(dst)
      /* 与酒馆 generateThumbnail 的判据一致：原图比缓存新才需要重做 */
      if (so.mtimeMs <= dc.ctimeMs) return { ok: true, cached: true, path: dst }
    }
    const buf = fs.readFileSync(src)
    let out = null
    try {
      out = thumb.makeThumbPng(buf, cfg.width, cfg.height)
    } catch (_) {
      out = null
    }
    const generated = out ? 'thumb' : 'copy'
    /* 解不了（16bit / 隔行 / 调色板缺失）就复制原图兜底：
       缓存存在即可让酒馆跳过并发生成，尺寸大一点不影响列表显示 */
    if (!out) out = buf
    ensureDir(dirs.thumbnails)
    const tmp = dst + '.tmp'
    fs.writeFileSync(tmp, out)
    fs.renameSync(tmp, dst)
    return { ok: true, generated, path: dst, bytes: out.length }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/**
 * 导入到酒馆（新建一张卡，同名也新建）
 * @param {object} opt
 *  tavernPath, user, buffer(png), json, name, replaceWorld, backupOldWorld
 */
function importCard(opt) {
  const pre = requireTavern(opt.tavernPath, opt.user)
  if (!pre.ok) return { ok: false, error: pre.error }
  const dirs = pre.dirs
  ensureDir(dirs.characters)

  const json = opt.json || null
  const data = png.cardData(json)
  const displayName = String(opt.name || data?.name || 'character')
  /* 新建就是直接新建：这一步不再问用户「覆盖哪一份」。
     同族 / 同名已存在时由 independentBaseName 另起独立基名（X → X 新 → X 新2），
     再由 uniqueAvatar 兜底，保证既有卡一张都不碰、文件名也不会落成看不出差别的 (n) 副本。
     想改已有卡请走 replaceCard（「更新到酒馆」）。 */
  const baseName = independentBaseName(dirs, displayName)
  const avatar = uniqueAvatar(dirs, baseName)

  let buf = opt.buffer ? Buffer.from(opt.buffer) : null
  if (!png.isPng(buf) && json) {
    // 资料库里这一版只有 JSON（例如从酒馆导入 / 粘贴进来的版本）时，借酒馆里同名卡当底图
    const donor = findCardImageByName(dirs, displayName)
    if (donor) buf = donor
  }
  if (!buf) return { ok: false, error: '缺少角色卡图片数据，无法写入' }
  if (!png.isPng(buf)) return { ok: false, error: '不是有效的 PNG 角色卡' }

  // 世界书：新卡自带 character_book 且勾了"替换世界书"时写入 worlds
  let worldName = ''
  let writtenWorld = ''
  let worldFilled = false
  let oldWorld = null
  const wantWorld = String(data?.extensions?.world || '').trim()
  if (opt.replaceWorld) {
    const book = data?.character_book
    if (book && Array.isArray(book.entries) && book.entries.length) {
      worldName = wantWorld || String(book.name || displayName)
      const file = path.join(dirs.worlds, safeFile(worldName) + '.json')
      if (opt.backupOldWorld && exists(file)) {
        oldWorld = { name: worldName, file, data: readWorldFile(file) }
      }
      ensureDir(dirs.worlds)
      const wi = bookToWorldInfo(book, worldName)
      fs.writeFileSync(file, JSON.stringify(wi, null, 2), 'utf8')
      writtenWorld = worldName
    } else if (wantWorld) {
      worldName = wantWorld
    }
    // 让角色卡指向这个世界书
    if (worldName && json) {
      const target = /chara_card/i.test(json.spec || '') ? json.data : json
      if (target && typeof target === 'object') {
        target.extensions = target.extensions && typeof target.extensions === 'object' ? target.extensions : {}
        target.extensions.world = worldName
        buf = png.writeCardJson(buf, json)
      }
    }
  }

  /* 卡里写了 extensions.world，但酒馆 worlds 下没有这个文件时，卡在酒馆里就是「世界书悬空」：
     读得到名字、点开是空的。这里按需从资料库同名世界书补一份过去（只补缺，绝不覆盖酒馆已有世界书）。
     opt.worldSource = { name, data } 由界面在新建前从库内同名世界书取好传下来。 */
  if (wantWorld && !exists(path.join(dirs.worlds, safeFile(wantWorld) + '.json'))) {
    const srcBook = opt.worldSource && opt.worldSource.data
    if (srcBook && typeof srcBook === 'object') {
      try {
        ensureDir(dirs.worlds)
        const file = path.join(dirs.worlds, safeFile(wantWorld) + '.json')
        /* 库里的世界书可能是酒馆 world info（entries 对象），也可能是角色卡内嵌的
           character_book（entries 数组）——后者必须先转成酒馆的格式，否则写过去读不出来 */
        const payload = Array.isArray(srcBook.entries) ? bookToWorldInfo(srcBook, wantWorld) : srcBook
        fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
        worldFilled = true
        if (!worldName) worldName = wantWorld
      } catch (_) {}
    }
  }

  // 关键：新内容必须写进 PNG 的 chara 数据块。
  // 否则写进酒馆的是「原图自带的那份旧 JSON」——表现为文件写了、图片换了，但酒馆里角色卡内容没变。
  if (json) buf = png.writeCardJson(buf, json)

  const file = path.join(dirs.characters, avatar + '.png')
  fs.writeFileSync(file, buf)
  /* 写完立刻预热缩略图：酒馆首屏是并发生成，刚写进去的这张常生成失败 → 列表里空白或串图 */
  const thumbResult = warmAvatarThumbnail(opt.tavernPath, pre.user || opt.user, avatar + '.png')
  return {
    ok: true,
    avatar,
    file,
    path: file,
    name: displayName,
    world: writtenWorld || worldName,
    worldFilled,
    oldWorld,
    thumb: thumbResult,
    mode: 'new'
  }
}

/**
 * 更新到酒馆（替换同名 avatar 的卡，聊天记录与角色槽位都不变）
 * @param {object} opt tavernPath, user, avatar, buffer, json, replaceWorld, backupOldWorld, worldName
 */
function replaceCard(opt) {
  const pre = requireTavern(opt.tavernPath, opt.user)
  if (!pre.ok) return { ok: false, error: pre.error }
  const dirs = pre.dirs
  let avatar = String(opt.avatar || '').trim()
  if (!avatar) {
    /* 资料库没记录它在酒馆里的文件名（从酒馆导入的卡、或记录被清过）时，
       直接按名字在酒馆里定位目标卡，避免"读得到酒馆状态却替换不进去" */
    const want = String(opt.name || png.cardData(opt.json || {})?.name || '').trim()
    const loc = want ? locateCardByName(dirs, want) : null
    if (!loc) return { ok: false, notFound: true, error: '酒馆里没有这张角色卡' }
    avatar = loc.avatar
  }
  let target = path.join(dirs.characters, avatar + '.png')

  /* 酒馆里存在「同名多份」（方亦楷.png 与 方亦楷 (1).png）时，写哪张都不算错，
     但必须先问一句，避免把正在用的那张盖掉。opt.pickAvatar 由用户选择后回传。 */
  if (!opt.pickAvatar) {
    const cands = sameBaseCandidates(dirs, avatar)
    if (cands.length > 1) return { ok: false, needPick: true, avatar, candidates: cands }
  }

  /* 兜底：资料库记录的 avatar 与酒馆里的真实文件名不一致时（酒馆曾自动改名），
     按「同名文件」→「卡内角色名」找回真正的目标卡，避免"替换"变成"另存一张新卡" */
  if (!exists(target)) {
    try {
      const files = fs.readdirSync(dirs.characters).filter((f) => /\.png$/i.test(f))
      let hit = files.find((f) => f.replace(/\.png$/i, '').toLowerCase() === avatar.toLowerCase())
      if (!hit) {
        const want = String(png.cardData(opt.json || {})?.name || '').trim().toLowerCase()
        if (want) {
          hit = files.find((f) => {
            try {
              const d = png.cardData(png.readCardJson(fs.readFileSync(path.join(dirs.characters, f))))
              return String((d && d.name) || '').trim().toLowerCase() === want
            } catch (_) {
              return false
            }
          })
        }
      }
      if (hit) {
        target = path.join(dirs.characters, hit)
        avatar = hit.replace(/\.png$/i, '')
      }
    } catch (_) {}
  }

  let buf = opt.buffer ? Buffer.from(opt.buffer) : null
  if (!png.isPng(buf)) {
    // 资料库里这一版只有 JSON（常见于从酒馆导入 / 粘贴进来的版本）时，用酒馆里现有的这张卡当底图
    if (exists(target)) {
      const cur = fs.readFileSync(target)
      if (png.isPng(cur)) buf = cur
    }
  }
  if (!png.isPng(buf)) {
    return { ok: false, notFound: !exists(target), error: exists(target) ? '不是有效的 PNG 角色卡' : '酒馆里找不到这张角色卡文件，无法替换' }
  }

  const json = opt.json || png.readCardJson(buf)
  const data = png.cardData(json)

  let oldWorld = null
  let worldName = ''
  let writtenWorld = ''

  if (opt.replaceWorld) {
    const book = data?.character_book
    const wantWorld = String(opt.worldName || data?.extensions?.world || '').trim()
    if (book && Array.isArray(book.entries) && book.entries.length) {
      worldName = wantWorld || String(book.name || avatar)
      const wfile = path.join(dirs.worlds, safeFile(worldName) + '.json')
      if (exists(wfile)) {
        const cur = readWorldFile(wfile)
        if (opt.backupOldWorld) oldWorld = { name: worldName, file: wfile, data: cur }
      }
      ensureDir(dirs.worlds)
      fs.writeFileSync(wfile, JSON.stringify(bookToWorldInfo(book, worldName), null, 2), 'utf8')
      writtenWorld = worldName
    } else if (wantWorld) {
      worldName = wantWorld
    }
    if (worldName && json) {
      const d = /chara_card/i.test(json.spec || '') ? json.data : json
      if (d && typeof d === 'object') {
        d.extensions = d.extensions && typeof d.extensions === 'object' ? d.extensions : {}
        d.extensions.world = worldName
        buf = png.writeCardJson(buf, json)
      }
    }
  } else if (exists(target)) {
    // 不替换世界书时保留原来绑定的世界书字段
    try {
      const oldJson = png.readCardJson(fs.readFileSync(target))
      const oldWorldField = String(png.cardData(oldJson)?.extensions?.world || '')
      const d = /chara_card/i.test(json?.spec || '') ? json.data : json
      if (oldWorldField && d && typeof d === 'object') {
        d.extensions = d.extensions && typeof d.extensions === 'object' ? d.extensions : {}
        if (!d.extensions.world) {
          d.extensions.world = oldWorldField
          buf = png.writeCardJson(buf, json)
        }
      }
    } catch (_) {}
  }

  // 关键：把新内容真正写进 PNG 的 chara 数据块（否则落盘的仍是底图自带的旧内容）
  if (json) buf = png.writeCardJson(buf, json)

  fs.writeFileSync(target, buf)
  /* 更新同样预热缩略图：原图 mtime 变新后，酒馆下次进列表才重做，这中间看到的是旧图 */
  const thumbResult = warmAvatarThumbnail(opt.tavernPath, pre.user || opt.user, avatar + '.png')
  return {
    ok: true,
    avatar,
    file: target,
    path: target,
    name: String(data?.name || avatar),
    world: writtenWorld || worldName,
    oldWorld,
    thumb: thumbResult,
    mode: 'replace'
  }
}

/** 把一份世界书写进酒馆的 worlds 目录 */
function importWorld(opt = {}) {
  let data = opt.data
  if (typeof data === 'string') {
    try { data = JSON.parse(data) } catch (_) { return { ok: false, error: '世界书内容不是标准 JSON' } }
  }
  if (!data || typeof data !== 'object') return { ok: false, error: '没有世界书内容' }
  const pre = requireTavern(opt.tavernPath, opt.user)
  if (!pre.ok) return { ok: false, error: pre.error }
  const dirs = pre.dirs
  const want = String(opt.name || data.name || 'untitled').trim() || 'untitled'
  const base = safeFile(want)
  ensureDir(dirs.worlds)

  let worldName = base
  let target = path.join(dirs.worlds, base + '.json')
  const overwriteMode = !!opt.overwrite || !!opt.replace
  /* 替换模式：优先写回条目记录的那份世界书（酒馆里可能被自动改过名，如「名字 (2).json」） */
  if (overwriteMode && opt.targetPath) {
    const tp = String(opt.targetPath)
    if (/\.json$/i.test(tp) && exists(tp)) {
      target = tp
      worldName = path.basename(tp).replace(/\.json$/i, '')
    }
  }
  if (exists(target) && !overwriteMode) {
    let i = 1
    while (exists(path.join(dirs.worlds, `${base} (${i}).json`))) i++
    worldName = `${base} (${i})`
    target = path.join(dirs.worlds, worldName + '.json')
  }
  let oldWorld = null
  if (opt.backupOld && exists(target)) {
    try {
      oldWorld = { name: worldName, file: target, ...worldBackupText(target) }
    } catch (_) {
      oldWorld = null
    }
  }
  fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf8')
  return { ok: true, name: worldName, file: target, path: target, oldWorld }
}

/* settings.json 里的 main_api（酒馆当前在用的聊天接口）与预设目录名的对应关系。
   酒馆的预设管理器每个接口各占一个 Settings 目录，预设管理器只显示当前接口那个目录里的文件，
   写进别的目录就等于「写成功了但酒馆里看不到」。 */
const API_PRESET_DIRS = {
  openai: ['OpenAI'],
  claude: ['OpenAI'],
  makersuite: ['OpenAI'],
  vertexai: ['OpenAI'],
  mistralai: ['MistralAI', 'OpenAI'],
  cohere: ['Cohere'],
  perplexity: ['Perplexity'],
  groq: ['Groq'],
  deepseek: ['DeepSeek', 'OpenAI'],
  xai: ['xAI', 'OpenAI'],
  ai21: ['AI21', 'OpenAI'],
  together: ['TogetherAI', 'OpenAI'],
  openrouter: ['OpenRouter', 'OpenAI'],
  infermaticai: ['InfermaticAI', 'OpenAI'],
  electronhub: ['ElectronHub', 'OpenAI'],
  custom: ['OpenAI'],
  google: ['Google'],
  textgenerationwebui: ['TextGenerationWebUI', 'Ooba'],
  ooba: ['Ooba', 'TextGenerationWebUI'],
  tabby: ['Tabby', 'TextGenerationWebUI'],
  ollama: ['Ollama', 'TextGenerationWebUI'],
  llamacpp: ['llama.cpp', 'TextGenerationWebUI'],
  vllm: ['vLLM', 'TextGenerationWebUI'],
  kobold: ['KoboldAI'],
  koboldhorde: ['KoboldAI Horde', 'KoboldAI'],
  novel: ['NovelAI'],
  scale: ['Scale'],
  dreamgen: ['DreamGen']
}

/** 目录名/引擎名归一化：「TextGenerationWebUI Settings」与「textgenerationwebui」视为同一个 */
function normEngine(s) {
  return String(s || '').toLowerCase().replace(/[\s_\-]+/g, '')
}

/** 读酒馆自己记录的当前聊天接口（data/<user>/settings.json 的 main_api） */
function readMainApi(tavernPath, user) {
  const dirs = resolveUserDir(tavernPath, user).dirs
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dirs.root, 'settings.json'), 'utf8'))
    return String(j?.main_api || j?.mainApi || '').trim()
  } catch (_) {
    return ''
  }
}

/** 列出酒馆里各引擎的设置目录（预设就存在这些目录里） */
function presetDirs(tavernPath, user) {
  const dirs = resolveUserDir(tavernPath, user).dirs
  const out = []
  if (!exists(dirs.root)) return out
  let subs = []
  try { subs = fs.readdirSync(dirs.root, { withFileTypes: true }) } catch (_) { return out }
  for (const d of subs) {
    if (!d.isDirectory()) continue
    if (!/settings$/i.test(d.name)) continue
    out.push({ engine: d.name.replace(/\s*settings$/i, ''), dir: path.join(dirs.root, d.name) })
  }
  return out
}

/** 把一份预设写进酒馆（优先写回同一引擎目录，没有就写第一个设置目录） */
function importPreset(opt = {}) {
  let data = opt.data
  if (typeof data === 'string') {
    try { data = JSON.parse(data) } catch (_) { return { ok: false, error: '预设内容不是标准 JSON' } }
  }
  if (!data || typeof data !== 'object') return { ok: false, error: '没有预设内容' }
  const pre = requireTavern(opt.tavernPath, opt.user)
  if (!pre.ok) return { ok: false, error: pre.error }
  const dirs = pre.dirs

  /* 落盘名统一「名字·V版本号」（例：YU·V1.4.0）：
     前端已拼好（name 里带 ·V）时不重复追加；没给版本号就只用名字 */
  let want = String(opt.name || data.name || data.preset_name || 'untitled').trim() || 'untitled'
  const rawVer = String(opt.version || data.version || data.preset_version || '').trim().replace(/^v/i, '')
  /* 只认数字版本号（1.4.0 / 2.0-beta）：「版本2」这种说明文字不拼进文件名 */
  const okVer = /^\d+(\.\d+)*([.\-_a-z].*)?$/i.test(rawVer) ? rawVer : ''
  if (okVer && !/[·・]V/i.test(want) && !/[\s_-]v?\d+\.\d/i.test(want)) want = want + '·V' + okVer
  const base = safeFile(want)
  const list = presetDirs(opt.tavernPath, opt.user)
  const api = readMainApi(opt.tavernPath, opt.user)
  let engine = String(opt.engine || '').trim()
  let targetDir = ''
  let movedFrom = ''

  /* ① 上次写进哪儿（资料库记录的 stTargetPath）—— 复用，保证「更新」落到同一份文件上 */
  let recDir = ''
  if (opt.targetPath) {
    const d = path.dirname(String(opt.targetPath))
    if (exists(d)) recDir = d
  }

  /* ② 酒馆当前在用的接口决定它读哪个 Settings 目录。
     以前 engine 为空时静默取 list[0]，在 Windows 上恒等于 KoboldAI Settings，
     于是「提示成功、酒馆预设管理器里却看不到」——这里必须先按 main_api 解析。 */
  let apiDir = ''
  const cands = API_PRESET_DIRS[api.toLowerCase()] || []
  for (const c of cands) {
    const hit = list.find((x) => normEngine(x.engine) === normEngine(c))
    if (hit) {
      apiDir = hit.dir
      break
    }
  }

  if (recDir) {
    /* 记录目录与当前接口目录一致 → 原样复用；不一致（历史错写进了别的引擎目录）→ 改写到接口目录，
       否则「更新」会继续往酒馆看不见的地方写 */
    if (!apiDir || path.resolve(recDir).toLowerCase() === path.resolve(apiDir).toLowerCase()) {
      targetDir = recDir
    } else {
      movedFrom = recDir
    }
  }
  if (!targetDir && apiDir) targetDir = apiDir

  /* ③ 调用方明确点名了引擎（界面上选过） */
  if (!targetDir && engine) {
    const hit = list.find((x) => normEngine(x.engine) === normEngine(engine))
    if (hit) targetDir = hit.dir
  }
  /* ④ 酒馆里就一个设置目录时没有歧义，直接用 */
  if (!targetDir && list.length === 1) targetDir = list[0].dir

  /* 一条都确定不了就不写：宁可报明确错误，也不能「提示成功、酒馆里没有」 */
  if (!targetDir) {
    const names = list.map((x) => x.engine).join(' / ') || '（一个 Settings 目录都没有找到）'
    return {
      ok: false,
      error:
        `酒馆里找不到该写进哪个预设目录：settings.json 的 main_api=${api || '未读到'}，可选目录为 ${names}。` +
        '请先在酒馆里新建一个预设、或切换一次聊天接口让它生成对应目录，再重试'
    }
  }

  const dirHit = list.find((x) => path.resolve(x.dir).toLowerCase() === path.resolve(targetDir).toLowerCase())
  if (dirHit) engine = dirHit.engine
  else if (!engine) engine = path.basename(targetDir).replace(/\s*settings$/i, '')
  ensureDir(targetDir)

  const overwrite = !!opt.overwrite || !!opt.replace
  let name = base
  let target = path.join(targetDir, base + '.json')
  if (exists(target) && !overwrite) {
    let i = 1
    while (exists(path.join(targetDir, `${base} (${i}).json`))) i++
    name = `${base} (${i})`
    target = path.join(targetDir, name + '.json')
  }

  /* 覆盖旧预设前留一份原文，由前端存成备份（与角色卡 / 世界书一致的口径） */
  let oldWorld = null
  if (overwrite && exists(target)) {
    try {
      const text = fs.readFileSync(target, 'utf8')
      let entries = 0
      try {
        const j = JSON.parse(text)
        if (Array.isArray(j?.prompts)) entries = j.prompts.length
        else entries = j?.prompt_order ? 1 : 0
      } catch (_) {}
      oldWorld = { name, file: target, text, entries }
    } catch (_) {
      oldWorld = null
    }
  }

  fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf8')
  return { ok: true, kind: 'presets', name, engine, file: target, path: target, oldWorld, movedFrom }
}

/** 内容类型未知的条目：按内容判断它该进酒馆的哪个位置 */
function importAny(opt = {}) {
  let data = opt.data
  if (typeof data === 'string') {
    try { data = JSON.parse(data) } catch (_) { return { ok: false, error: '内容不是标准 JSON' } }
  }
  if (!data || typeof data !== 'object') return { ok: false, error: '没有内容' }
  if (!Array.isArray(data)) {
    const entries = data.entries
    const entryCount = entries ? (Array.isArray(entries) ? entries.length : Object.keys(entries).length) : 0
    if (entryCount) return importWorld(opt)
    if (data.prompts || data.prompt_order) return importPreset(opt)
    if (/chara_card/i.test(data.spec || '') || data.first_mes !== undefined) {
      if (!opt.buffer && !opt.json) return { ok: false, error: '这一条缺少角色卡图片文件，无法写入酒馆' }
      const cardOpt = { ...opt, json: opt.json || data }
      if (!cardOpt.avatar && cardOpt.targetPath) {
        cardOpt.avatar = path.basename(String(cardOpt.targetPath)).replace(/\.(png|json)$/i, '')
      }
      return opt.replace ? replaceCard(cardOpt) : importCard(cardOpt)
    }
  }
  return { ok: false, error: '这一类内容在酒馆里没有对应位置，只能导出源文件' }
}

/* ---------------- 单卡读取 / 导出 ---------------- */
function readCardAt(file) {
  try {
    const buf = fs.readFileSync(file)
    const json = png.readCardJson(buf)
    return { ok: true, json, data: png.cardData(json), sig: json ? png.cardSig(json) : '' }
  } catch (e) {
    return { ok: false, error: String(e.message) }
  }
}

/** 把资料库里的条目写成一个真正的角色卡文件（导出源文件 / 备份） */
function buildCardBuffer(pngBuffer, json) {
  if (!pngBuffer) return null
  const buf = Buffer.from(pngBuffer)
  if (!png.isPng(buf)) return null
  if (!json) return buf
  return png.writeCardJson(buf, json)
}

/* ---------------- 酒馆扩展：自动识别 + 一键注入 ---------------- */

/** 随软件打包的扩展副本 */
function extSourceDir() {
  return path.join(__dirname, '..', 'extensions', 'tavernlib-sync')
}

function readExtVersion(dir) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    return String(json.version || '').trim()
  } catch (_) {
    return ''
  }
}

/** 递归列出目录下所有文件（返回相对路径） */
function walkFiles(dir, root, out) {
  const list = out || []
  const base = root || dir
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (_) {
    return list
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walkFiles(full, base, list)
    else if (e.isFile()) list.push(path.relative(base, full))
  }
  return list
}

/** 酒馆里的扩展安装状态（只读，不改动酒馆文件）
 *  latest = 安装包内置扩展源的版本号；outdated = 酒馆中版本与内置版本不一致 */
function extStatus(tavernPath, user) {
  const latest = readExtVersion(extSourceDir())
  const tp = String(tavernPath || '').trim()
  if (!tp) {
    return {
      ok: false,
      installed: false,
      version: '',
      latest,
      outdated: false,
      path: '',
      user: '',
      userCorrected: false,
      checked: [],
      error: '还没设置酒馆安装路径（形如 F:\\SillyTavern）'
    }
  }
  if (!exists(tp)) {
    return {
      ok: false,
      installed: false,
      version: '',
      latest,
      outdated: false,
      path: '',
      user: '',
      userCorrected: false,
      checked: [],
      error: '找不到酒馆目录：' + tp + '，请在设置里填写正确的酒馆安装路径'
    }
  }

  /* 候选目录（按可能性排序）：
     ① 解析出来的真实用户目录（stUser 无效时已回退 default-user / 实际存在的用户目录）
     ② data 下其它真实存在的用户目录（历史数据里换过用户名的情况）
     ③ 历史 GitHub 安装位置 public/scripts/extensions/third-party
     ④ public/extensions
     任一命中 manifest.json 就算已安装，并回报命中的真实路径 */
  const rs = resolveUserDir(tp, user)
  const checked = []
  const pushTarget = (dir) => {
    const t = path.join(dir, 'tavernlib-sync')
    if (!checked.includes(t)) checked.push(t)
  }
  pushTarget(rs.dirs.extensions)
  for (const c of rs.candidates) pushTarget(c.dirs.extensions)
  for (const root of legacyExtRoots(tp)) pushTarget(root)

  let target = ''
  for (const t of checked) {
    if (exists(path.join(t, 'manifest.json'))) {
      target = t
      break
    }
  }
  const base = { latest, user: rs.user, userCorrected: rs.corrected, checked }
  if (!target) {
    return { ok: true, installed: false, version: '', outdated: false, path: checked[0] || '', ...base }
  }
  const version = readExtVersion(target)
  /* 与注入逻辑同一套版本比较：酒馆里比内置旧才算 outdated，比内置新不算 */
  const cmp = compareVersion(version, latest)
  const outdated = cmp === 0 ? false : cmp === null ? !!latest && version !== latest : cmp < 0
  return { ok: true, installed: true, version, outdated, path: target, ...base }
}

/** 删掉 dir 下所有空子目录（自底向上），dir 自身保留；仅用于扩展目录内部清理 */
function pruneEmptyDirs(dir) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const full = path.join(dir, e.name)
    pruneEmptyDirs(full)
    try {
      if (!fs.readdirSync(full).length) fs.rmdirSync(full)
    } catch {
      /* 清理失败不影响注入 */
    }
  }
}

/** 版本号比较：返回 1(左新) / 0(相同) / -1(左旧) / null(无法比较)
 *  支持 1.1.0 / v1.1 / 1.1.0-beta.1 这类常见写法，段数不同也能比 */
function compareVersion(a, b) {
  const norm = (v) =>
    String(v == null ? '' : v)
      .trim()
      .replace(/^v/i, '')
      .split(/[.+\-]/)
      .filter((x) => x !== '')
  const pa = norm(a)
  const pb = norm(b)
  if (!pa.length || !pb.length) return null
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const sa = pa[i]
    const sb = pb[i]
    if (sa === undefined) return -1
    if (sb === undefined) return 1
    const na = /^\d+$/.test(sa) ? parseInt(sa, 10) : NaN
    const nb = /^\d+$/.test(sb) ? parseInt(sb, 10) : NaN
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na > nb) return 1
      if (na < nb) return -1
      continue
    }
    // 数字段优先于预发布标记：1.1.0 > 1.1.0-beta
    if (!Number.isNaN(na) && Number.isNaN(nb)) return 1
    if (Number.isNaN(na) && !Number.isNaN(nb)) return -1
    if (sa > sb) return 1
    if (sa < sb) return -1
  }
  return 0
}

/** 覆盖前把目标目录整份复制到备份根（不动原目录），返回备份路径；失败返回 ''
 *  备份放在酒馆 extensions 目录之外，避免被酒馆当成扩展加载 */
function backupExtDir(target, backupRoot, fromVersion) {
  if (!backupRoot) return ''
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const stamp =
    '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  const name = 'tavernlib-sync-v' + (fromVersion || 'unknown') + '-' + stamp
  const dest = path.join(backupRoot, name)
  try {
    ensureDir(dest)
    for (const rel of walkFiles(target)) {
      const to = path.join(dest, rel)
      ensureDir(path.dirname(to))
      fs.writeFileSync(to, fs.readFileSync(path.join(target, rel)))
    }
    return dest
  } catch (_) {
    return ''
  }
}

/** 一键注入：把扩展文件复制进 <tavernPath>/data/<user>/extensions/tavernlib-sync
 *  按版本比对决定行为：
 *    - 未安装                        -> 安装
 *    - 已装版本低于内置版本           -> 备份旧版后覆盖升级（并清掉旧版残留文件）
 *    - 已装版本与内置版本相同         -> 跳过，不重复覆盖（opts.force 时强制重写）
 *    - 已装版本高于内置版本           -> 跳过，不降级（opts.force 时强制重写）
 *  只处理 tavernlib-sync 目录内部，目录本身保留，不触碰同级其它扩展
 *  opts.backupRoot：旧版备份根目录（由主进程传入，位于酒馆目录之外）
 *  逐文件用 readFileSync + writeFileSync（打包进 asar 后 copyFileSync 不适用） */
function injectExt(tavernPath, user, opts) {
  const opt = opts && typeof opts === 'object' ? opts : {}
  const force = !!opt.force
  const backupRoot = opt.backupRoot ? String(opt.backupRoot) : ''
  const src = extSourceDir()
  if (!exists(path.join(src, 'manifest.json'))) {
    return { ok: false, error: '安装包里找不到扩展文件：' + src }
  }
  const req = requireTavern(tavernPath, user)
  if (!req.ok) return { ok: false, error: req.error }
  const rels = walkFiles(src)
  if (!rels.length) return { ok: false, error: '安装包里的扩展文件是空的：' + src }
  /* 与状态判定同源：先在「真实用户目录 + 历史安装位置」里找已存在的 tavernlib-sync，
     命中就更新那一份；都没有才装到解析出的用户目录。
     以前判定看 A、注入写 B，用户会遇到「装完仍显示未安装」 */
  const rs = resolveUserDir(tavernPath, user)
  const cands = []
  const addCand = (dir) => {
    const t = path.join(dir, 'tavernlib-sync')
    if (!cands.includes(t)) cands.push(t)
  }
  addCand(rs.dirs.extensions)
  for (const c of rs.candidates) addCand(c.dirs.extensions)
  for (const root of legacyExtRoots(tavernPath)) addCand(root)
  const existTarget = cands.find((t) => exists(path.join(t, 'manifest.json'))) || ''
  const target = existTarget || path.join(req.dirs.extensions, 'tavernlib-sync')
  const keep = new Set(rels.map((r) => r.split(path.sep).join('/')))
  const builtin = readExtVersion(src)
  const hasTarget = exists(path.join(target, 'manifest.json'))
  const installed = hasTarget ? readExtVersion(target) : ''
  const cmp = hasTarget ? compareVersion(installed, builtin) : null

  // 版本比对：版本号读不出来（cmp 为 null）时按“需要覆盖”处理，保证能把旧目录修好
  let mode = 'install'
  if (hasTarget) {
    if (cmp === 0) mode = 'same'
    else if (cmp !== null && cmp > 0) mode = 'newer'
    else mode = 'upgrade'
  }
  if ((mode === 'same' || mode === 'newer') && !force) {
    return {
      ok: true,
      skipped: true,
      changed: false,
      mode: mode === 'same' ? 'skipped-same' : 'skipped-newer',
      version: installed || builtin,
      fromVersion: installed,
      latest: builtin,
      outdated: mode !== 'same',
      path: target,
      user: req.user || rs.user,
      files: rels.map((r) => path.join(target, r)),
      backup: '',
      message:
        mode === 'same'
          ? '酒馆里已是 v' + (installed || builtin) + '，无需重复写入'
          : '酒馆里是更新的 v' + installed + '（内置 v' + builtin + '），未降级'
    }
  }

  let backup = ''
  try {
    // 覆盖前先把旧目录整份备份（放在酒馆 extensions 之外，避免被当成扩展加载）
    if (hasTarget) backup = backupExtDir(target, backupRoot, installed)
    // 增量清理：先删掉目标目录里新包不存在的文件（目录本身保留，不碰同级其它扩展）
    if (exists(target)) {
      for (const rel of walkFiles(target)) {
        if (keep.has(rel.split(path.sep).join('/'))) continue
        fs.unlinkSync(path.join(target, rel))
      }
      pruneEmptyDirs(target)
    }
    for (const rel of rels) {
      const to = path.join(target, rel)
      ensureDir(path.dirname(to))
      const buf = fs.readFileSync(path.join(src, rel))
      fs.writeFileSync(to, buf)
    }
  } catch (e) {
    return { ok: false, error: '写入扩展失败：' + (e && e.message ? e.message : e) }
  }
  const version = readExtVersion(target) || readExtVersion(src)
  const forcedRewrite = force && (mode === 'same' || mode === 'newer')
  return {
    ok: true,
    skipped: false,
    changed: true,
    forced: forcedRewrite,
    mode: forcedRewrite ? 'rewrite' : hasTarget ? 'upgrade' : 'install',
    version,
    fromVersion: installed,
    latest: builtin,
    outdated: false,
    path: target,
    user: req.user || rs.user,
    files: rels.map((r) => path.join(target, r)),
    backup,
    message: forcedRewrite
      ? '已强制重写 v' + version
      : hasTarget
        ? '已从 v' + (installed || '未知') + ' 升级到 v' + version
        : '已安装 v' + version
  }
}

module.exports = {
  userDirs,
  extStatus,
  injectExt,
  ensureDir,
  exists,
  safeFile,
  scanCharacters,
  probeDigests,
  scanWorlds,
  scanWorldsUnbound,
  scanPresets,
  scanThemes,
  readUiCss,
  readFaFont,
  readThemeSrc,
  bookToWorldInfo,
  readWorldFile,
  importCard,
  replaceCard,
  importWorld,
  importPreset,
  importAny,
  presetDirs,
  readCardAt,
  buildCardBuffer,
  uniqueAvatar,
  independentBaseName,
  chatStatsOf,
  sameBaseCandidates,
  thumbConfig,
  warmAvatarThumbnail
}
