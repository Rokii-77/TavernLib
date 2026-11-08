/**
 * 内容指纹（渲染进程版，与 electron/lib/digest.cjs 逐字节一致）
 * 修改这里必须同步改主进程那份，否则「酒馆当前版本」比对会失效。
 */

function fnv1a(str, basis) {
  let h = basis >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

export function hashStr(str) {
  const s = String(str == null ? '' : str)
  const a = fnv1a(s, 0x811c9dc5)
  const b = fnv1a(s, 0x01000193)
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

export function canon(v) {
  if (v === null || v === undefined) return 'null'
  const t = typeof v
  if (t === 'number') return Number.isFinite(v) ? String(v) : 'null'
  if (t === 'boolean') return v ? 'true' : 'false'
  if (t === 'string') return JSON.stringify(v)
  if (t === 'function') return 'null'
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  if (t === 'object') {
    const keys = Object.keys(v).filter((k) => typeof v[k] !== 'function' && v[k] !== undefined).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
  }
  return 'null'
}

export function cardPayloadOf(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.data && typeof raw.data === 'object') return raw.data
  return raw
}

export function charDigest(raw) {
  const d = cardPayloadOf(raw)
  if (!d) return ''
  return hashStr(canon(d))
}

function worldEntryKey(e) {
  const src = e && typeof e === 'object' ? e : {}
  const comment = String(src.comment || src.name || '')
  const keys = Array.isArray(src.keys) ? src.keys : Array.isArray(src.key) ? src.key : src.key ? [src.key] : []
  const content = String(src.content || '')
  return comment + '\u0001' + keys.map((x) => String(x)).join('\u0002') + '\u0001' + content
}

export function worldDigest(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const entries = src.entries
  let list = []
  if (Array.isArray(entries)) {
    list = entries.map(worldEntryKey)
  } else if (entries && typeof entries === 'object') {
    list = Object.keys(entries).map((k) => worldEntryKey(entries[k]))
  }
  list.sort()
  return hashStr(list.join('\u0003'))
}

export function presetDigest(raw) {
  if (!raw || typeof raw !== 'object') return ''
  return hashStr(canon(raw))
}

export function digestOf(category, raw) {
  if (!raw) return ''
  if (category === 'worldbooks') return worldDigest(raw)
  if (category === 'presets') return presetDigest(raw)
  return charDigest(raw)
}
