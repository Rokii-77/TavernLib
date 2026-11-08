'use strict'
/* PNG 文本块（tEXt / iTXt）读写：用于读取与重写角色卡内嵌的 chara / ccv3 JSON */

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

let TABLE = null
function crcTable() {
  if (TABLE) return TABLE
  TABLE = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    TABLE[n] = c
  }
  return TABLE
}

function crc32(buf) {
  const t = crcTable()
  let c = -1
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function isPng(buf) {
  if (!buf || buf.length < 8) return false
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) return false
  return true
}

function extractChunks(buf) {
  const chunks = []
  let off = 8
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const name = buf.toString('latin1', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    chunks.push({ name, data })
    off = off + 8 + len + 4
    if (name === 'IEND') break
    if (off > buf.length) break
  }
  return chunks
}

function buildPng(chunks) {
  const parts = [SIG]
  for (const c of chunks) {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(c.data.length, 0)
    const type = Buffer.from(c.name, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([type, c.data])), 0)
    parts.push(len, type, c.data, crc)
  }
  return Buffer.concat(parts)
}

function textChunk(key, value) {
  return {
    name: 'tEXt',
    data: Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')])
  }
}

function chunkKey(c) {
  if (c.name !== 'tEXt' && c.name !== 'iTXt') return ''
  const z = c.data.indexOf(0)
  if (z <= 0) return ''
  return c.data.toString('latin1', 0, z)
}

function chunkValue(c) {
  if (c.name === 'tEXt') {
    const z = c.data.indexOf(0)
    return z < 0 ? '' : c.data.toString('latin1', z + 1)
  }
  // iTXt: keyword\0 compFlag compMethod \0 lang \0 translated \0 text
  const z = c.data.indexOf(0)
  if (z < 0) return ''
  let p = z + 3
  const langEnd = c.data.indexOf(0, p)
  const transEnd = langEnd > 0 ? c.data.indexOf(0, langEnd + 1) : -1
  if (transEnd < 0) return ''
  return c.data.toString('utf8', transEnd + 1)
}

/** 读取 PNG 里所有文本块 → { chara: 'base64...', ccv3: '...' } */
function readTextChunks(buf) {
  const out = {}
  if (!isPng(buf)) return out
  for (const c of extractChunks(buf)) {
    const k = chunkKey(c)
    if (k) out[k] = chunkValue(c)
  }
  return out
}

/** 重写指定文本块，其余块原样保留。
 *  注意：旧的同名块必须**全部**丢弃（PNG 里 tEXt/iTXt 可能出现在 IDAT 之后，
 *  若只丢弃插入点之前的，残留的旧块会被 readTextChunks 以「后者覆盖前者」的语义读回来，
 *  表现为写了新内容但读到的还是旧内容）。 */
function writeTextChunks(buf, map) {
  const chunks = extractChunks(buf)
  const keys = new Set(Object.keys(map))
  const out = []
  let placed = false
  const place = () => {
    for (const [k, v] of Object.entries(map)) out.push(textChunk(k, v))
    placed = true
  }
  for (const c of chunks) {
    const k = chunkKey(c)
    if (k && keys.has(k)) {
      if (!placed) place()
      continue
    }
    if (c.name === 'IDAT' && !placed) place()
    out.push(c)
  }
  if (!placed) {
    const idx = out.findIndex((c) => c.name === 'IEND')
    const at = idx < 0 ? out.length : idx
    for (const [k, v] of Object.entries(map)) out.splice(at, 0, textChunk(k, v))
  }
  return buildPng(out)
}

/** 从 PNG 里取出角色卡 JSON（ccv3 优先，其次 chara） */
function readCardJson(buf) {
  const t = readTextChunks(buf)
  const raw = t.ccv3 || t.chara
  if (!raw) return null
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
  } catch (_) {
    return null
  }
}

/** 把角色卡 JSON 写回 PNG（同时写 chara 与 ccv3，保持与酒馆一致） */
function writeCardJson(pngBuf, json) {
  const b64 = Buffer.from(JSON.stringify(json), 'utf8').toString('base64')
  return writeTextChunks(pngBuf, { chara: b64, ccv3: b64 })
}

/** 取角色卡的实际数据部分（v2/v3 在 data 里，v1 是扁平） */
function cardData(json) {
  if (!json || typeof json !== 'object') return {}
  if (/chara_card/i.test(json.spec || '') && json.data && typeof json.data === 'object') return json.data
  return json
}

/** 内容指纹：用于判断某个版本是否与酒馆里的卡一致（两端同一算法） */
function sigHash(str) {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193 ^ 0x5bd1e995
  const s = String(str || '')
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 ^= c
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = (h2 + c * (i + 1)) >>> 0
    h2 = (Math.imul(h2, 0x85ebca6b) ^ (h2 >>> 13)) >>> 0
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'))
}

/** 角色卡内容签名（只取判定"是不是同一份内容"用得到的字段） */
function cardSig(json) {
  const d = cardData(json)
  const parts = [
    d.name || '',
    d.description || '',
    d.personality || '',
    d.scenario || '',
    d.first_mes || '',
    d.mes_example || '',
    d.system_prompt || '',
    d.post_history_instructions || ''
  ]
  return sigHash(parts.join('\u0001'))
}

module.exports = {
  isPng,
  readTextChunks,
  writeTextChunks,
  readCardJson,
  writeCardJson,
  cardData,
  cardSig,
  sigHash
}
