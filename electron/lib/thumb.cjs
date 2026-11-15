/* 缩略图预热：按酒馆的规则（avatar 固定 cover 到 96x144，见酒馆 src/endpoints/thumbnails.js）
 * 自己在 data/<user>/thumbnails/avatar/ 下落一份缓存。
 *
 * 为什么要自己生成：酒馆首屏是「并发生成一批缩略图」，同一批里有几张会生成失败（Jimp 抢 IO / 大图超时），
 * 表现就是刚写进酒馆的卡缩略图空白或串成别的卡，刷新一次才恢复。
 * 洛书匣写完卡主动把这份缓存补上，酒馆启动时直接命中缓存，不再走那条并发路径。
 *
 * 纯 node:zlib 实现（不引入新依赖）：解 PNG IDAT → 反滤波 → cover 裁剪缩放 → 重新编码。
 * 遇到解不了的格式（16bit / 调色板缺失 / 隔行 / 超大图）直接返回 null，调用方退化为「复制原图」，
 * 保证永远有缓存可选，不会因为缩略图失败影响写卡本身。
 */

const zlib = require('node:zlib')

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

let crcTable = null
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function readChunks(buf) {
  const out = []
  let pos = 8
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const dataStart = pos + 8
    if (dataStart + len + 4 > buf.length) break
    out.push({ type, data: buf.subarray(dataStart, dataStart + len) })
    pos = dataStart + len + 4
  }
  return out
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** 解成 RGBA 像素（Uint8Array，w*h*4）；不支持的情况返回 null */
function decodePngToRgba(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null
  const chunks = readChunks(buf)
  const ihdr = chunks.find((c) => c.type === 'IHDR')
  if (!ihdr || ihdr.data.length < 13) return null
  const width = ihdr.data.readUInt32BE(0)
  const height = ihdr.data.readUInt32BE(4)
  const bitDepth = ihdr.data[8]
  const colorType = ihdr.data[9]
  const interlace = ihdr.data[12]
  if (!width || !height || bitDepth !== 8 || interlace !== 0) return null
  if (width * height > 4096 * 4096) return null

  let channels = 0
  if (colorType === 0) channels = 1
  else if (colorType === 2) channels = 3
  else if (colorType === 3) channels = 1
  else if (colorType === 4) channels = 2
  else if (colorType === 6) channels = 4
  else return null

  let palette = null
  const plte = chunks.find((c) => c.type === 'PLTE')
  if (plte) palette = plte.data
  if (colorType === 3 && !palette) return null
  let trns = null
  const trnsChunk = chunks.find((c) => c.type === 'tRNS')
  if (trnsChunk) trns = trnsChunk.data

  const idat = chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)
  if (!idat.length) return null
  let raw
  try {
    raw = zlib.inflateSync(Buffer.concat(idat))
  } catch (_) {
    return null
  }

  const bpp = channels // bitDepth 固定 8
  const stride = width * bpp
  if (raw.length < (stride + 1) * height) return null

  const out = new Uint8Array(width * height * 4)
  let prev = new Uint8Array(stride)
  let cur = new Uint8Array(stride)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const ft = raw[pos++]
    for (let x = 0; x < stride; x++) {
      const v = raw[pos++]
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let val
      if (ft === 0) val = v
      else if (ft === 1) val = v + a
      else if (ft === 2) val = v + b
      else if (ft === 3) val = v + ((a + b) >> 1)
      else if (ft === 4) val = v + paeth(a, b, c)
      else return null
      cur[x] = val & 0xff
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const s = x * bpp
      if (colorType === 6) {
        out[o] = cur[s]
        out[o + 1] = cur[s + 1]
        out[o + 2] = cur[s + 2]
        out[o + 3] = cur[s + 3]
      } else if (colorType === 2) {
        out[o] = cur[s]
        out[o + 1] = cur[s + 1]
        out[o + 2] = cur[s + 2]
        out[o + 3] = 255
      } else if (colorType === 4) {
        out[o] = out[o + 1] = out[o + 2] = cur[s]
        out[o + 3] = cur[s + 1]
      } else if (colorType === 0) {
        out[o] = out[o + 1] = out[o + 2] = cur[s]
        out[o + 3] = 255
      } else {
        const idx = cur[s]
        const p = palette && idx * 3 + 2 < palette.length ? idx * 3 : 0
        out[o] = palette ? palette[p] : 0
        out[o + 1] = palette ? palette[p + 1] : 0
        out[o + 2] = palette ? palette[p + 2] : 0
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255
      }
    }
    const t = prev
    prev = cur
    cur = t
  }
  return { width, height, data: out }
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodeRgbaPng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** 居中 cover 裁剪 + 最近邻缩放（足够缩略图用，且不会产生额外依赖） */
function coverResize(img, tw, th) {
  const { width: sw, height: sh, data } = img
  const srcRatio = sw / sh
  const dstRatio = tw / th
  let cw = sw
  let ch = sh
  if (srcRatio > dstRatio) cw = Math.max(1, Math.round(sh * dstRatio))
  else ch = Math.max(1, Math.round(sw / dstRatio))
  const ox = Math.floor((sw - cw) / 2)
  const oy = Math.floor((sh - ch) / 2)
  const out = new Uint8Array(tw * th * 4)
  for (let y = 0; y < th; y++) {
    const sy = oy + Math.min(ch - 1, Math.floor(((y + 0.5) * ch) / th))
    for (let x = 0; x < tw; x++) {
      const sx = ox + Math.min(cw - 1, Math.floor(((x + 0.5) * cw) / tw))
      const s = (sy * sw + sx) * 4
      const o = (y * tw + x) * 4
      out[o] = data[s]
      out[o + 1] = data[s + 1]
      out[o + 2] = data[s + 2]
      out[o + 3] = data[s + 3]
    }
  }
  return out
}

/** 原图 PNG → 目标尺寸缩略图 PNG；解不了返回 null */
function makeThumbPng(buf, tw = 96, th = 144) {
  const img = decodePngToRgba(buf)
  if (!img) return null
  const px = coverResize(img, tw, th)
  return encodeRgbaPng(tw, th, px)
}

module.exports = { makeThumbPng, decodePngToRgba, encodeRgbaPng }
