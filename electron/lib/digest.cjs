'use strict'

/**
 * 内容指纹（跨进程同算法）
 *
 * 主进程与渲染进程各有一份同样的实现：
 *   electron/lib/digest.cjs   ← 主进程用（读酒馆文件后算指纹）
 *   src/lib/digest.js         ← 渲染进程用（读资料库版本算指纹）
 * 两边算法必须逐字节一致，否则「酒馆当前版本」永远匹配不上。
 *
 * 角色卡走 PNG 内嵌 JSON（png.cardSig / digest），世界书走「条目归一化」，
 * 预设走「整体规范化 JSON」，这样即使酒馆把世界书写成 uid 键的对象、
 * 资料库里存的是数组条目，也能算出同一个指纹。
 */

/** FNV-1a 32 位 */
function fnv1a(str, basis) {
  let h = basis >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

/** 16 位十六进制字符串指纹（两组 FNV，降低碰撞） */
function hashStr(str) {
  const s = String(str == null ? '' : str)
  const a = fnv1a(s, 0x811c9dc5)
  const b = fnv1a(s, 0x01000193)
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

/** 稳定序列化：对象键排序，跳过 undefined / 函数 */
function canon(v) {
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

/** 角色卡：兼容 { spec, data } 与裸 data 两种形态 */
function cardPayloadOf(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.data && typeof raw.data === 'object') return raw.data
  return raw
}

function charDigest(raw) {
  const d = cardPayloadOf(raw)
  if (!d) return ''
  return hashStr(canon(d))
}

/** 世界书单条目归一化：角色卡 character_book 与酒馆 world info 字段不同，取公共语义 */
function worldEntryKey(e) {
  const src = e && typeof e === 'object' ? e : {}
  const comment = String(src.comment || src.name || '')
  const keys = Array.isArray(src.keys) ? src.keys : Array.isArray(src.key) ? src.key : src.key ? [src.key] : []
  const content = String(src.content || '')
  return comment + '\u0001' + keys.map((x) => String(x)).join('\u0002') + '\u0001' + content
}

function worldDigest(raw) {
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

function presetDigest(raw) {
  if (!raw || typeof raw !== 'object') return ''
  return hashStr(canon(raw))
}

/** 按分类算版本指纹 */
function digestOf(category, raw) {
  if (!raw) return ''
  if (category === 'worldbooks') return worldDigest(raw)
  if (category === 'presets') return presetDigest(raw)
  return charDigest(raw)
}

module.exports = { hashStr, canon, cardPayloadOf, charDigest, worldDigest, presetDigest, digestOf }
