/**
 * 主题（日间 / 夜间）与自定义 CSS
 * ------------------------------------------------------------
 * 只做两件事，全部作用在 <html> 上，不碰任何组件逻辑：
 *   1. data-theme="dark" | "light"  →  style.css 里两套 CSS 变量随之切换
 *   2. 一个 <style id="tavernlib-custom-css"> 节点  →  用户粘贴 / 导入的 CSS
 * 这样白天/晚上切换只是换变量，卡片、书架、详情页全部沿用原有布局，不改结构。
 */

/** 支持的主题模式：dark 夜间 / light 日间 / auto 跟随系统 */
export const THEMES = ['dark', 'light', 'auto']

/** 系统当前是深色还是浅色 */
export function systemTheme() {
  try {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch (_) {
    return 'dark'
  }
}

/** auto 时解析成实际生效的 dark / light */
export function resolveTheme(mode) {
  const m = THEMES.includes(mode) ? mode : 'dark'
  return m === 'auto' ? systemTheme() : m
}

/** 主题切换时同步 index.html 的 <html> 属性；同时更新窗口主题色，避免标题栏留白边 */
export function applyTheme(mode) {
  const m = THEMES.includes(mode) ? mode : 'dark'
  const el = typeof document !== 'undefined' ? document.documentElement : null
  if (!el) return resolveTheme(m)
  const effective = resolveTheme(m)
  el.dataset.theme = effective
  el.dataset.themeMode = m
  el.style.colorScheme = effective
  return effective
}

/** 跟随系统时监听系统明暗变化（只在 auto 下由调用方触发重绘） */
export function onSystemThemeChange(handler) {
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const fn = () => handler && handler(systemTheme())
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  } catch (_) {
    return () => {}
  }
}

const STYLE_ID = 'tavernlib-custom-css'

/* ------------------------------------------------------------------
 * 自定义 CSS 的优先级提升
 * 组件样式是 scoped 的（编译成 .topbar[data-v-xxxx]），一条普通选择器
 * （.topbar）特异性天然低于它，用户写 .topbar { background: ... } 会被静默吃掉，
 * 以前只能靠用户自己加 !important 才生效。
 * 这里把用户的每条选择器统一提到 :root:root:root 之下（等价于多 3 个类级特异性），
 * 让普通写法也能覆盖内置样式；:root 变量、@media/@keyframes 等按原样处理，不改语义。
 * ------------------------------------------------------------------ */

/** 按顶层逗号切选择器（括号 / 引号内的逗号不切） */
function splitSelectorList(sel) {
  const parts = []
  let buf = ''
  let depth = 0
  let quote = ''
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i]
    if (quote) {
      buf += c
      if (c === '\\') { buf += sel[i + 1] || ''; i++ } else if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue }
    if (c === '(' || c === '[') depth++
    if (c === ')' || c === ']') depth--
    if (c === ',' && depth <= 0) { parts.push(buf); buf = ''; continue }
    buf += c
  }
  parts.push(buf)
  return parts
}

function boostSelector(sel) {
  const raw = sel.trim()
  if (!raw) return sel
  /* 不是普通选择器（含 @ 或关键词）就原样返回 */
  if (/^@/.test(raw) || /^(from|to|[\d.]+%)$/i.test(raw)) return sel
  /* :root 本身：累加 3 个，压过 :root[data-theme] 这类内置变量声明 */
  if (/:root\b/.test(raw)) return sel.replace(/:root\b/, ':root:root:root')
  if (/^html\b/.test(raw)) return sel.replace(/^html\b/, 'html:root:root:root')
  /* 通配符只改盒模型之类，不抢背景，保持原样以免误伤 */
  if (/^\*/.test(raw)) return sel
  return ':root:root:root ' + raw
}

export function boostCustomCss(css) {
  const src = String(css || '')
  let i = 0

  /** 原样复制一个块（用于 @keyframes / @font-face 等不允许改选择器的地方） */
  function copyRawBlock() {
    let depth = 1
    let out = ''
    while (i < src.length) {
      const c = src[i]
      if (c === '"' || c === "'") {
        const q = c
        let j = i + 1
        while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++ }
        out += src.slice(i, j + 1)
        i = j + 1
        continue
      }
      if (c === '{') depth++
      if (c === '}') { depth--; if (depth === 0) { i++; return out } }
      out += c
      i++
    }
    return out
  }

  function parseBlock() {
    let out = ''
    while (i < src.length) {
      let prelude = ''
      while (i < src.length) {
        const c = src[i]
        if (c === '/' && src[i + 1] === '*') {
          const j = src.indexOf('*/', i + 2)
          const stop = j < 0 ? src.length : j + 2
          prelude += src.slice(i, stop)
          i = stop
          continue
        }
        if (c === '"' || c === "'") {
          const q = c
          let j = i + 1
          while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++ }
          prelude += src.slice(i, j + 1)
          i = j + 1
          continue
        }
        if (c === '{' || c === '}' || c === ';') break
        prelude += c
        i++
      }
      if (i >= src.length) { out += prelude; break }
      const ch = src[i]
      if (ch === '}') { i++; return { out: out + prelude, closed: true } }
      if (ch === ';') { i++; out += prelude + ';'; continue }
      /* ch === '{' */
      i++
      const head = prelude.trim()
      const at = head.startsWith('@') ? head.split(/\s+/)[0].toLowerCase() : ''
      const grouping = ['@media', '@supports', '@layer', '@container', '@scope', '@document'].includes(at)
      if (grouping) {
        const r = parseBlock()
        out += head + '{' + r.out + '}'
        if (r.closed) continue
        break
      }
      if (at) {
        out += head + '{' + copyRawBlock() + '}'
        continue
      }
      /* 普通样式规则：只提升选择器，声明体递归原样透传 */
      const boosted = splitSelectorList(head).map(boostSelector).join(',')
      const r = parseBlock()
      out += boosted + '{' + r.out + '}'
      if (r.closed) continue
      break
    }
    return { out, closed: false }
  }

  return parseBlock().out
}

/** 把用户自定义 CSS 注入页面；空串则移除节点（等于恢复默认外观） */
export function applyCustomCss(css) {
  if (typeof document === 'undefined') return
  const text = String(css || '')
  let node = document.getElementById(STYLE_ID)
  if (!text.trim()) {
    if (node) node.textContent = ''
    return
  }
  if (!node) {
    node = document.createElement('style')
    node.id = STYLE_ID
    document.head.appendChild(node)
  }
  /* 用户写的 CSS 只放在这个节点里，不 eval、不插到模板，写坏最多是这块样式失效 */
  node.textContent = boostCustomCss(text)
}

/** 一次性把主题 + 自定义 CSS 应用到界面（启动时 / 保存设置后调用） */
export function applyAppearance(settings) {
  const s = settings || {}
  applyTheme(s.theme)
  applyCustomCss(s.customCss)
}

/**
 * 自定义 CSS 基础模板
 * 用户在设置里点「插入基础模板」就得到这一段，改颜色 / 圆角 / 字号即可；
 * 想还原直接清空即可，不影响功能。
 */
export const BASE_CSS_TEMPLATE = `/* ===== TavernLib 自定义 CSS 基础模板 =====
   直接改这里的值即可，改完点「应用到界面」立即生效。
   选择器都基于现有结构与变量，不改布局，只调颜色 / 圆角 / 字号 / 阴影。
   提示：内置样式带 scoped 属性、优先级略高，个别属性不生效时在后面加 !important 即可。 */

/* 1) 全局配色：白天或夜里都能单独微调（:root 同时作用于两套主题） */
:root {
  --accent: #d4a24c;          /* 主色（按钮、选中框） */
  --accent-2: #f0c675;        /* 主色高光 */
  --radius: 10px;             /* 圆角 */
}

/* 只改夜间 */
:root[data-theme="dark"] {
  --bg: #0f1114;
  --panel: #1b1f25;
  --text: #e7e9ec;
}

/* 只改白天 */
:root[data-theme="light"] {
  --bg: #f3f4f6;
  --panel: #ffffff;
  --text: #1c2128;
}

/* 2) 顶栏：换底色 / 加阴影 */
.topbar {
  /* background: linear-gradient(180deg, #1a1e25, #14171c) !important; */
}

/* 3) 书架卡片：悬停 / 选中态 */
.card {
  /* border-radius: 14px; */
}
.card:hover {
  /* transform: translateY(-2px); */
}
.card.picked {
  /* box-shadow: 0 0 0 2px var(--accent); */
}

/* 4) 详情页与弹窗 */
.panel, .modal, .ask-box {
  /* border-radius: 14px; */
}

/* 5) 细滚动条 */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb {
  background: var(--line);
  border-radius: 8px;
}

/* 6) 想给某个元素单独上样式时，先按 F12 看清 it 的 class，再写在这里 */
`
