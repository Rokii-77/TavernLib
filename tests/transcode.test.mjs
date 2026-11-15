/* P1 链接导入：转码图判定 / 去参数重下 / 后缀纠正
   覆盖 electron/lib/transcode.cjs 的纯函数，防「Discord 链接再导进来又变空白卡」回归 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const tc = require('../electron/lib/transcode.cjs')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const out = []
function ok(name, cond, extra) {
  out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''))
  return !!cond
}

/* ---------- 构造真实魔数的样本 ---------- */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([20, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1'), Buffer.alloc(12)])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)])
const HTML = Buffer.from('<!DOCTYPE html><html><body>404</body></html>')

ok('PNG 魔数识别', tc.isPng(PNG) === true)
ok('WebP 魔数识别', tc.isWebp(WEBP) === true && tc.isPng(WEBP) === false)
ok('JPEG 魔数识别', tc.isJpeg(JPEG) === true)
ok('空/短 buffer 不误判', tc.isPng(Buffer.alloc(2)) === false && tc.isWebp(Buffer.alloc(2)) === false)

/* ---------- Discord 链接识别 ---------- */
ok('cdn.discordapp 附件链接识别',
  tc.isDiscordMedia('https://cdn.discordapp.com/attachments/1/2/a.png') === true)
ok('media.discordapp.net 附件链接识别',
  tc.isDiscordMedia('https://media.discordapp.net/ephemeral-attachments/1/2/a.png') === true)
ok('普通图床不算 Discord', tc.isDiscordMedia('https://img.example.com/a.png') === false)

/* ---------- 转码参数判定 ---------- */
ok('format=webp 算转码参数', tc.hasTranscode('https://x.com/a.png?format=webp') === true)
ok('width/height/quality 都算',
  tc.hasTranscode('https://x.com/a.png?width=300&height=300&quality=lossless') === true)
ok('Discord 签名参数 ex/is/hm 不算转码',
  tc.hasTranscode('https://cdn.discordapp.com/attachments/1/2/a.png?ex=abc&is=def&hm=ghi') === false)
ok('坏链接不抛异常', tc.hasTranscode('not a url') === false)

/* ---------- 该不该去参数重下 ---------- */
ok('拿回 PNG 就不重下（即使链接带 format）',
  tc.needOriginal('https://x.com/a.png?format=webp', PNG) === false)
ok('拿到 WebP + 带 format → 重下',
  tc.needOriginal('https://x.com/a.png?format=webp', WEBP) === true)
ok('拿到 WebP + Discord 域名 → 重下（签名参数里没有 format 也要试）',
  tc.needOriginal('https://cdn.discordapp.com/attachments/1/2/a.png?ex=a&is=b&hm=c', WEBP) === true)
ok('拿到 WebP + 普通静态地址且无参数 → 不重下（重下也没用）',
  tc.needOriginal('https://x.com/a.webp', WEBP) === false)

/* ---------- 重下候选链接 ---------- */
const cand = tc.retryCandidates('https://cdn.discordapp.com/attachments/1/2/a.png?ex=1&is=2&hm=3&format=webp&width=300&height=300')
ok('候选1：剥掉全部转码参数、保留签名参数',
  cand[0] === 'https://cdn.discordapp.com/attachments/1/2/a.png?ex=1&is=2&hm=3', cand[0])
ok('候选2：再显式要求 format=png',
  cand[1] === 'https://cdn.discordapp.com/attachments/1/2/a.png?ex=1&is=2&hm=3&format=png', cand[1])
ok('候选里不会出现原链接本身', !cand.includes('https://cdn.discordapp.com/attachments/1/2/a.png?ex=1&is=2&hm=3&format=webp&width=300&height=300'))
ok('无参数链接只剩「显式 format=png」一条候选，且不含原链接',
  tc.retryCandidates('https://x.com/a.png').length === 1 &&
  tc.retryCandidates('https://x.com/a.png')[0] === 'https://x.com/a.png?format=png',
  JSON.stringify(tc.retryCandidates('https://x.com/a.png')))

/* ---------- 后缀纠正 ---------- */
ok('.webp 后缀但内容是 PNG → 改名 .png', tc.normalizePngName('a.webp') === 'a.png')
ok('.jpg 后缀但内容是 PNG → 改名 .png', tc.normalizePngName('卡.jpg') === '卡.png')
ok('已经是 .png 不动', tc.normalizePngName('a.png') === 'a.png')
ok('没有后缀补 .png', tc.normalizePngName('file') === 'file.png')
ok('多点文件名只换最后一段', tc.normalizePngName('a.b.c.webp') === 'a.b.c.png')

/* ---------- 类型名（用于报错文案） ---------- */
ok('WebP 报 WebP', tc.imageKind(WEBP) === 'WebP')
ok('JPEG 报 JPEG', tc.imageKind(JPEG) === 'JPEG')
ok('网页不当图片', tc.imageKind(HTML) === null)

/* ---------- 主进程接线检查：别把逻辑留在 main 里各写一份 ---------- */
const mainSrc = readFileSync(path.join(ROOT, 'electron/main.cjs'), 'utf8')
ok('main 已引入 transcode 模块', /require\('\.\/lib\/transcode\.cjs'\)/.test(mainSrc))
ok('main 用 needOriginal 判定是否重下', /tc\.needOriginal\(/.test(mainSrc))
ok('main 用 retryCandidates 生成重下链接', /tc\.retryCandidates\(/.test(mainSrc))
ok('main 用 normalizePngName 纠正后缀', /tc\.normalizePngName\(/.test(mainSrc))
ok('main 不再自带一份 isWebp 实现', !/const isWebp\s*=/.test(mainSrc))
ok('转码图仍然明确报错而不是静默空白卡', /被转码压缩过的图片/.test(mainSrc))

console.log(out.join('\n'))
const failed = out.filter((l) => l.startsWith('FAIL')).length
console.log(`\nFAILED=${failed}`)
process.exit(failed ? 1 : 0)
