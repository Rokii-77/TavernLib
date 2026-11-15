/**
 * 开场白富文本渲染：Markdown / HTML → 安全 HTML
 *
 * 酒馆卡的开场白绝大多数是 `<p>` / `<br>` 结构的 HTML，也有不少带 `*动作*`、`**加粗**`
 * 这类 Markdown 标记。纯文本白名单渲染之前，这些标记全是源码，读起来很难受。
 *
 * 安全边界（渲染的是别人卡里的内容，必须当不可信输入处理）：
 *  - 只走 DOMPurify 白名单，脚本 / iframe / object / form / style 标签一律丢弃；
 *  - 事件属性（onerror 等）、srcdoc、javascript: 协议由 DOMPurify 默认拦掉，这里再显式禁一遍；
 *  - 图片允许加载，但只认 http(s)，且去掉 srcset / 不加载未知协议；
 *  - 链接不带 href：应用内点击不外跳、也不新开窗口（需要访问时用户自己复制）。
 */
import DOMPurify from 'dompurify'
import { marked } from 'marked'

marked.setOptions({ gfm: true, breaks: true })

/** 是否含 HTML 标签（有就按 HTML 处理，不再套 Markdown，避免 <p> 被当成字面量转义） */
const HTML_TAG_RE = /<\/?[a-z][a-z0-9-]*(\s[^<>]*)?\/?>/i
/** 是否含 Markdown 标记：加粗、斜体、代码、标题、列表、引用、链接 */
const MD_RE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|^\s*[-*+]\s+\S|^\s*\d+\.\s+\S|^#{1,6}\s+\S|^\s*>\s+\S|\[[^\]\n]+\]\([^)\n]+\))/m

export function hasHtmlMarkup(text) {
  return HTML_TAG_RE.test(String(text || ''))
}

export function hasMarkdownMarkup(text) {
  return MD_RE.test(String(text || ''))
}

/** 是否有可切换的富文本标记（纯文本没必要给「源码」按钮） */
export function hasRichMarkup(text) {
  const s = String(text || '')
  return hasHtmlMarkup(s) || hasMarkdownMarkup(s)
}

const PURIFY_CFG = {
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select',
    'textarea', 'link', 'meta', 'base', 'svg', 'math', 'audio', 'video', 'source', 'track'],
  FORBID_ATTR: ['srcdoc', 'formaction', 'action', 'srcset', 'href', 'xlink:href', 'ping', 'autofocus'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  KEEP_CONTENT: true
}

/* 会被剔除的内联样式属性：定位 / 层级 / 变形 / 过滤，避免卡里内容糊到整个应用界面上 */
const RISKY_CSS_RE = /^(position|inset|inset-[a-z]+|top|right|bottom|left|z-index|transform|translate|rotate|scale|filter|backdrop-filter|float|clear|mix-blend-mode)$/i

let hooked = false
function ensureHook() {
  if (hooked) return
  hooked = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!node || node.nodeType !== 1) return
    const tag = node.tagName
    if (tag === 'IMG') {
      const src = String(node.getAttribute('src') || '').trim()
      /* 只认常见图片协议：data: 图片体积不可控，file: 会读到本地磁盘，一律不留 */
      if (!/^https?:\/\//i.test(src) && !/^data:image\//i.test(src)) node.removeAttribute('src')
      node.setAttribute('loading', 'lazy')
      node.setAttribute('decoding', 'async')
      node.setAttribute('referrerpolicy', 'no-referrer')
    }
    /* 内联样式保留颜色/字号这类排版属性，但定位类样式会把内容糊到整个应用上，必须剔掉 */
    const style = node.getAttribute('style')
    if (style) {
      const kept = style
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .filter((d) => !RISKY_CSS_RE.test(d.split(':')[0].trim()))
      if (kept.length) node.setAttribute('style', kept.join('; '))
      else node.removeAttribute('style')
    }
    /* id 会和应用自身元素撞车（尤其美化预览注入的 CSS 选择器），统一去掉 */
    node.removeAttribute('id')
  })
}

/**
 * 把开场白文本渲染成安全 HTML
 * @param {string} src 原始文本（HTML 或 Markdown 或纯文本）
 * @returns {string} 已净化的 HTML
 */
export function renderRichText(src) {
  const raw = String(src == null ? '' : src)
  if (!raw.trim()) return ''
  ensureHook()
  let html
  if (hasHtmlMarkup(raw)) {
    /* 只有行内标签、既没有块级标签也没有 <br> 的卡，换行会被浏览器吃到一起，这里补成 <br> */
    html = BLOCK_TAG_RE.test(raw) || /<br\b/i.test(raw)
      ? raw
      : raw.replace(/\r\n?/g, '\n').replace(/\n/g, '<br>')
  } else if (hasMarkdownMarkup(raw)) {
    html = marked.parse(raw)
  } else {
    /* 纯文本：转义后按换行断段，避免把 < 之类的字面量当标签 */
    html = escapeHtml(raw).replace(/\r\n?/g, '\n').replace(/\n/g, '<br>')
  }
  try {
    return DOMPurify.sanitize(html, PURIFY_CFG)
  } catch (_) {
    return escapeHtml(raw).replace(/\r\n?/g, '\n').replace(/\n/g, '<br>')
  }
}

const BLOCK_TAG_RE = /<\/?(p|div|br|li|ul|ol|h[1-6]|blockquote|pre|table|thead|tbody|tr|td|th|hr|section|article|details|figure|dl|dt|dd)\b/i

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}
