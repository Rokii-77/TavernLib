/**
 * 酒馆文本格式化（预览用）
 *
 * 照 SillyTavern 的真实实现搬过来的等价逻辑，来源：
 *   - public\script.js:1800 messageFormatting()
 *   - public\script.js:522  new showdown.Converter({...})
 *   - public\scripts\showdown-underscore.js  (单下划线斜体)
 *   - public\scripts\showdown-exclusion.js
 *
 * 酒馆的 showdown 配置（决定「哪些写法算包裹」）：
 *   emoji: true                       :smile: 这类短代码
 *   literalMidWordUnderscores: true   词中间的 _ 不当作斜体
 *   parseImgDimensions: true
 *   tables: true
 *   underline: true                   => __文本__ 变 <u>，_文本_ 才是 <em>
 *   simpleLineBreaks: true            单个换行变 <br>
 *   strikethrough: true               ~~文本~~ 变 <del>
 *   disableForced4SpacesIndentedSublists: true
 *   extensions: [markdownUnderscoreExt()]
 *
 * 注意：酒馆默认 power_user.encode_tags = true，所以消息里直写的 <em> 这类标签
 * 会被转义成纯文本显示；只有关掉这个开关才会被浏览器当成标签解析。
 */

const PLACEHOLDER = (i) => `\u0001${i}\u0001`

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 酒馆的六种双引号包裹（ASCII / 弯引号 / 法式 / 直角 / 白直角 / 全角） */
const QUOTE_RE =
  /(".*?")|(\u201C[\s\S]*?\u201D)|(\u00AB[\s\S]*?\u00BB)|(\u300C[\s\S]*?\u300D)|(\u300E[\s\S]*?\u300F)|(\uFF02[\s\S]*?\uFF02)/g

function wrapQuotes(s) {
  return s.replace(QUOTE_RE, (m, p1, p2, p3, p4, p5, p6) => {
    if (p1) return `<q>"${p1.slice(1, -1)}"</q>`
    if (p2) return `<q>\u201C${p2.slice(1, -1)}\u201D</q>`
    if (p3) return `<q>\u00AB${p3.slice(1, -1)}\u00BB</q>`
    if (p4) return `<q>\u300C${p4.slice(1, -1)}\u300D</q>`
    if (p5) return `<q>\u300E${p5.slice(1, -1)}\u300F</q>`
    if (p6) return `<q>\uFF02${p6.slice(1, -1)}\uFF02</q>`
    return m
  })
}

/** 行内 markdown：顺序和 showdown 一致，长的先匹配 */
function inline(s) {
  let t = s
  // 图片 ![alt](url) —— 比链接先
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, src) =>
    /^(https?:|data:|file:)/i.test(src) ? `<img src="${src}" alt="${alt}">` : m
  )
  // 链接 [文本](url)
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, txt, href) =>
    /^(https?:|mailto:)/i.test(href) ? `<a href="${href}" target="_blank" rel="noreferrer">${txt}</a>` : m
  )
  // ***粗斜体***
  t = t.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>')
  // **粗体**
  t = t.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
  // __下划线__（酒馆开了 underline:true）
  t = t.replace(/(^|[^A-Za-z0-9_])__(?=\S)([\s\S]*?\S)__(?![A-Za-z0-9_])/g, '$1<u>$2</u>')
  // *斜体*
  t = t.replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
  // _斜体_（词内不处理：literalMidWordUnderscores + \b 边界）
  t = t.replace(/(^|[^A-Za-z0-9_])_(?=\S)([^_]*?\S)_(?![A-Za-z0-9_])/g, '$1<em>$2</em>')
  // ~~删除线~~
  t = t.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
  // 反斜杠转义
  t = t.replace(/\\([\\`*_{}[\]()#+\-.!>~])/g, '$1')
  return t
}

/** 块级：引用 / 列表 / 标题 / 分割线 / 段落（段落内单换行变 <br>，对齐 simpleLineBreaks） */
function blocks(s) {
  const lines = s.split('\n')
  const out = []
  let i = 0
  const flushPara = (buf) => {
    if (!buf.length) return
    out.push(`<p>${buf.join('<br>')}</p>`)
    buf.length = 0
  }
  const buf = []
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*$/.test(line)) {
      flushPara(buf)
      i++
      continue
    }
    // 引用
    if (/^>\s?/.test(line)) {
      flushPara(buf)
      const q = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        q.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      out.push(`<blockquote>${q.join('<br>')}</blockquote>`)
      continue
    }
    // 无序列表
    if (/^\s*[*+-]\s+/.test(line)) {
      flushPara(buf)
      const items = []
      while (i < lines.length && /^\s*[*+-]\s+/.test(lines[i])) {
        items.push(`<li>${lines[i].replace(/^\s*[*+-]\s+/, '')}</li>`)
        i++
      }
      out.push(`<ul>${items.join('')}</ul>`)
      continue
    }
    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushPara(buf)
      const items = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(`<li>${lines[i].replace(/^\s*\d+[.)]\s+/, '')}</li>`)
        i++
      }
      out.push(`<ol>${items.join('')}</ol>`)
      continue
    }
    // 标题
    const h = /^\s*(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flushPara(buf)
      out.push(`<h${h[1].length}>${h[2]}</h${h[1].length}>`)
      i++
      continue
    }
    // 分割线
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara(buf)
      out.push('<hr>')
      i++
      continue
    }
    buf.push(line)
    i++
  }
  flushPara(buf)
  return out.join('\n')
}

/**
 * 主入口：把酒馆消息正文渲染成 HTML（和酒馆 .mes_text 里看到的一致）
 */
export function tavernFormat(text) {
  if (text == null) return ''
  let s = String(text).replace(/\r\n?/g, '\n')

  /* 1. 代码先抽出来，免得里面的 * _ ~ 被当成包裹语法（酒馆也是先跳过 ``` / ~~~ / `） */
  const stash = []
  const keep = (html) => {
    stash.push(html)
    return PLACEHOLDER(stash.length - 1)
  }
  s = s.replace(/```([\s\S]*?)```/g, (m, body) => keep(`<pre><code>${escHtml(body.replace(/^\n/, ''))}</code></pre>`))
  s = s.replace(/~~~([\s\S]*?)~~~/g, (m, body) => keep(`<pre><code>${escHtml(body.replace(/^\n/, ''))}</code></pre>`))
  s = s.replace(/``([\s\S]*?)``/g, (m, body) => keep(`<code>${escHtml(body)}</code>`))
  s = s.replace(/`([^`\n]+)`/g, (m, body) => keep(`<code>${escHtml(body)}</code>`))

  /* 2. 转义尖括号：酒馆默认 encode_tags=true，直写的 <em> 会变成纯文本 */
  s = escHtml(s)

  /* 3. 六种双引号包成 <q> */
  s = wrapQuotes(s)

  /* 4. 块级 + 行内 */
  s = blocks(s)
  s = inline(s)

  /* 5. 还原代码块 */
  s = s.replace(/\u0001(\d+)\u0001/g, (m, n) => stash[Number(n)] || '')
  return s
}

/** 取出这段 HTML 里实际生效的包裹标签（用于对照表显示「命中什么标签」） */
export function tagsOf(html) {
  const set = new Set()
  const re = /<\/?([a-z][a-z0-9]*)\b[^>]*>/gi
  let m
  const ignore = new Set(['p', 'br'])
  while ((m = re.exec(html))) {
    const t = m[1].toLowerCase()
    if (!ignore.has(t)) set.add(t)
  }
  return [...set]
}

/** 渲染出来的纯文本（去掉标签），用来确认文字没被吃掉 */
export function textOf(html) {
  return html
    .replace(/<br\s*\/?>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

const SENTENCE = '今晚的麦酒还带着凉气。'

/**
 * 同一句话 × 酒馆支持的每一种包裹方式
 * kind: md = markdown 语法；quote = 酒馆 messageFormatting 的引号包裹；html = 直接写标签
 */
export const WRAP_CASES = [
  { group: '不包裹', label: '原样文本', syntax: SENTENCE, note: '什么都没包，只吃 .mes_text 的基础字体与颜色' },

  { group: 'Markdown 强调', label: '单星号斜体', syntax: `*${SENTENCE}*`, note: 'showdown → <em>' },
  { group: 'Markdown 强调', label: '双星号粗体', syntax: `**${SENTENCE}**`, note: 'showdown → <strong>' },
  { group: 'Markdown 强调', label: '三星号粗斜体', syntax: `***${SENTENCE}***`, note: 'showdown → <strong><em>' },
  { group: 'Markdown 强调', label: '单下划线斜体', syntax: `_${SENTENCE}_`, note: '酒馆扩展 markdownUnderscoreExt → <em>' },
  { group: 'Markdown 强调', label: '双下划线（underline 开启）', syntax: `__${SENTENCE}__`, note: '酒馆开了 underline:true → <u>，不是粗体' },
  { group: 'Markdown 强调', label: '波浪线删除线', syntax: `~~${SENTENCE}~~`, note: 'strikethrough:true → <del>' },
  { group: 'Markdown 强调', label: '星号内嵌粗体', syntax: `*${SENTENCE.slice(0, 6)}**${SENTENCE.slice(6)}***`, note: '斜体里再套粗体' },

  { group: '引号包裹（q）', label: '英文双引号', syntax: `"${SENTENCE}"`, note: 'messageFormatting → <q>"…"</q>' },
  { group: '引号包裹（q）', label: '中文弯引号', syntax: `\u201C${SENTENCE}\u201D`, note: '→ <q>“…”</q>' },
  { group: '引号包裹（q）', label: '法式引号', syntax: `\u00AB${SENTENCE}\u00BB`, note: '→ <q>«…»</q>' },
  { group: '引号包裹（q）', label: '直角引号', syntax: `\u300C${SENTENCE}\u300D`, note: '→ <q>「…」</q>' },
  { group: '引号包裹（q）', label: '白直角引号', syntax: `\u300E${SENTENCE}\u300F`, note: '→ <q>『…』</q>' },
  { group: '引号包裹（q）', label: '全角双引号', syntax: `\uFF02${SENTENCE}\uFF02`, note: '→ <q>＂…＂</q>' },
  { group: '引号 + 强调', label: '引号里套斜体', syntax: `"*${SENTENCE}*"`, note: '<q> 里的 em 取 EmColor，q 本身取 QuoteColor' },

  { group: '行内代码', label: '单反引号', syntax: '`今晚的麦酒还带着凉气。`', note: '→ <code>' },
  { group: '行内代码', label: '双反引号', syntax: '``今晚的麦酒还带着凉气。``', note: 'showdown 双反引号 → <code>' },

  { group: '块级', label: '三反引号代码块', syntax: '```\n今晚的麦酒还带着凉气。\n```', note: '→ <pre><code>' },
  { group: '块级', label: '引用块', syntax: `> ${SENTENCE}`, note: '→ <blockquote>，带 QuoteColor 左边线' },
  { group: '块级', label: '一级标题', syntax: `# ${SENTENCE}`, note: '→ <h1>' },
  { group: '块级', label: '二级标题', syntax: `## ${SENTENCE}`, note: '→ <h2>' },
  { group: '块级', label: '无序列表', syntax: `- ${SENTENCE}`, note: '→ <ul><li>' },
  { group: '块级', label: '分割线', syntax: `---`, note: '→ <hr>' },

  { group: 'HTML 标签（encode_tags 关闭时）', label: 'em 直写', syntax: `<em>${SENTENCE}</em>`, note: '默认 encode_tags=true 会被转义成纯文本' },
  { group: 'HTML 标签（encode_tags 关闭时）', label: 'u 直写', syntax: `<u>${SENTENCE}</u>`, note: '下划线色取 --SmartThemeUnderlineColor' },
  { group: 'HTML 标签（encode_tags 关闭时）', label: 'q 直写', syntax: `<q>${SENTENCE}</q>`, note: '引用色取 --SmartThemeQuoteColor' },
  { group: 'HTML 标签（encode_tags 关闭时）', label: 'font 上色', syntax: `<font color="#e2b96f">${SENTENCE}</font>`, note: 'font[color] 里的 em/u/q 继承色' },
  { group: 'HTML 标签（encode_tags 关闭时）', label: 'del 直写', syntax: `<del>${SENTENCE}</del>`, note: '删除线' },
  { group: 'HTML 标签（encode_tags 关闭时）', label: 'mark 高亮', syntax: `<mark>${SENTENCE}</mark>`, note: '高亮背景' },
  { group: 'HTML 标签（encode_tags 关闭时）', label: 'small 小字', syntax: `<small>${SENTENCE}</small>`, note: '缩小字号' },
  { group: 'HTML 标签（encode_tags 关闭时）', label: 'rp 注音标签', syntax: `<rp>${SENTENCE}</rp>`, note: '酒馆 style.css 里 .mes_text rp { display:block }' }
]

/* ---------------- 字体解析 ---------------- */

/** 从 CSS 里抽 @font-face 的定义（预览面板要告诉用户「这套美化到底用了什么字体」） */
export function fontFacesOf(css) {
  const out = []
  const src = String(css || '')
  const re = /@font-face\s*\{([^}]*)\}/gi
  let m
  while ((m = re.exec(src))) {
    const body = m[1]
    const pick = (k) => {
      const r = new RegExp(`${k}\\s*:\\s*([^;]+)`, 'i')
      const mm = r.exec(body)
      return mm ? mm[1].trim().replace(/^["']|["']$/g, '') : ''
    }
    out.push({
      family: pick('font-family'),
      weight: pick('font-weight'),
      style: pick('font-style'),
      src: pick('src')
    })
  }
  return out
}

/** 从 CSS 里收集 font-family 声明（按出现顺序去重） */
export function cssFontFamiliesOf(css) {
  const set = []
  const re = /font-family\s*:\s*([^;{}]+)/gi
  let m
  while ((m = re.exec(String(css || '')))) {
    const v = m[1].trim()
    if (v && !set.includes(v)) set.push(v)
  }
  return set
}

/** 字体族串拆成数组：'A, "B", serif' → ['A','B','serif'] */
export function splitFamilies(v) {
  return String(v || '')
    .split(',')
    .map((x) => x.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}
