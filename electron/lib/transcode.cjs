/* 图片魔数 + 转码参数判定
 *
 * 背景：Discord / 图床的 ?format=webp&width=&height= 会把 PNG 重新编码成缩略图，
 * PNG 里内嵌的 tEXt/chara 元数据（角色卡本体）随之被丢掉，导进来只剩一张空白卡。
 * 这段判定在 net:download 里最容易回归，抽成纯函数以便单测覆盖。 */

const TRANSCODE_KEYS = ['format', 'width', 'height', 'quality']
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])

const isPng = (buf) => !!buf && buf.length > 8 && buf.subarray(0, 4).equals(PNG_MAGIC)

const isWebp = (buf) =>
  !!buf &&
  buf.length > 12 &&
  buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
  buf.subarray(8, 12).toString('latin1') === 'WEBP'

const isJpeg = (buf) => !!buf && buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8

/** Discord 附件直链（带签名，过期失效） */
const isDiscordMedia = (url) =>
  /(?:media|cdn)\.discordapp\.(?:net|com)\/(?:ephemeral-)?attachments\//i.test(String(url || ''))

/** 链接上是否挂着转码参数 */
const hasTranscode = (url) => {
  try {
    const u = new URL(String(url))
    return TRANSCODE_KEYS.some((k) => u.searchParams.has(k))
  } catch (_) {
    return false
  }
}

/** 拿到的不是 PNG，且来源可能被转码 → 值得去掉参数重下一次原图 */
const needOriginal = (url, buf) => !isPng(buf) && (isDiscordMedia(url) || hasTranscode(url))

/** 去参数重下的候选链接：先全删，再试显式 format=png */
function retryCandidates(url) {
  const out = []
  try {
    const u = new URL(String(url))
    for (const k of TRANSCODE_KEYS) u.searchParams.delete(k)
    out.push(u.toString())
  } catch (_) {}
  try {
    const u = new URL(String(url))
    for (const k of TRANSCODE_KEYS) u.searchParams.delete(k)
    u.searchParams.set('format', 'png')
    out.push(u.toString())
  } catch (_) {}
  return out.filter((t) => t && t !== String(url))
}

/** 转码图的人话类型名；不是 webp/jpeg 返回 null */
const imageKind = (buf) => (isWebp(buf) ? 'WebP' : isJpeg(buf) ? 'JPEG' : null)

/** 内容其实是 PNG、后缀却写着 .webp / .jpg（图床常见）：把后缀改回 .png，
 *  否则下游按后缀判断会把它当转码图，解析出空白角色卡。 */
function normalizePngName(base) {
  const b = String(base || '')
  if (/\.png$/i.test(b)) return b
  return b.replace(/\.[a-z0-9]{2,5}$/i, '') + '.png'
}

module.exports = {
  TRANSCODE_KEYS,
  isPng,
  isWebp,
  isJpeg,
  isDiscordMedia,
  hasTranscode,
  needOriginal,
  retryCandidates,
  imageKind,
  normalizePngName
}
