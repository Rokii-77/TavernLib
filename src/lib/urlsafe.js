/**
 * URL / 文本清洗与校验（渲染进程侧统一入口）
 *
 * 背景：从 Discord、网页、聊天软件复制的链接里经常混进不可见字符——
 *   - U+FFFD（65533，替换字符，复制时编码丢失产生）
 *   - 零宽字符 U+200B/200C/200D/2060、BOM U+FEFF
 *   - 换行、制表符等控制字符
 * 这些字符一旦进到网络层（fetch / IPC 请求头），Chromium 会直接抛
 *   "Cannot convert argument to a ByteString because the character at index N has a value of 65533"
 * 这类原始异常。所以所有链接在进入网络层之前，必须先过这里。
 */

/** 会被网络层拒收的字符（U+FFFD、零宽、BOM、C0/C1 控制符） */
const BAD_CHARS = /[\uFFFD\u200B-\u200D\u2060\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g

/** 通用文本清洗：去不可见字符、收敛空白、trim */
export function cleanText(v) {
  return String(v == null ? '' : v)
    .replace(BAD_CHARS, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** 判断字符串里是否含上面这类非法字符（用于给出更准确的中文提示） */
const BAD_CHARS_TEST = /[\uFFFD\u200B-\u200D\u2060\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/
export function hasBadChars(v) {
  return BAD_CHARS_TEST.test(String(v == null ? '' : v))
}

const FULLWIDTH = [
  [/：/g, ':'],
  [/／/g, '/'],
  [/？/g, '?'],
  [/＆/g, '&'],
  [/＝/g, '='],
  [/％/g, '%'],
  [/＃/g, '#'],
  [/＠/g, '@'],
  [/．/g, '.']
]

/** 只做清洗，不校验合法性 */
export function cleanUrl(raw) {
  let s = String(raw == null ? '' : raw)
  s = s.replace(BAD_CHARS, '')
  for (const [re, to] of FULLWIDTH) s = s.replace(re, to)
  // 去掉所有空白（链接里不该有空格，粘贴时常带进尾随空格/换行）
  s = s.replace(/[\s\u00A0]+/g, '')
  return s
}

/**
 * 清洗 + 校验一条链接
 * @returns {{ok:boolean, url:string, error:string}}
 */
export function checkUrl(raw) {
  const cleaned = cleanUrl(raw)
  if (!cleaned) return { ok: false, url: '', error: '链接是空的' }
  let s = cleaned
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    // 常见：只贴了 discord.com/channels/... 少了协议头
    if (/^[\w.-]+\.[a-z]{2,}(?::\d+)?\//i.test(s)) s = 'https://' + s
    else return { ok: false, url: '', error: '链接需要以 http(s):// 开头' }
  }
  let u
  try {
    u = new URL(s)
  } catch (_) {
    return { ok: false, url: '', error: '链接格式不对（可能复制不完整，请重新复制一次）' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, url: '', error: '只支持 http / https 链接' }
  }
  if (!u.hostname || !u.hostname.includes('.')) {
    return { ok: false, url: '', error: '链接里没有有效的域名' }
  }
  // 域名里不允许出现非 ASCII（中文域名请用 punycode 形式）
  if (/[^\x20-\x7E]/.test(u.hostname)) {
    return { ok: false, url: '', error: '链接域名含有非法字符，请重新复制' }
  }
  return { ok: true, url: u.toString(), error: '' }
}

/** 布尔快捷判断 */
export function isValidUrl(v) {
  return checkUrl(v).ok
}
