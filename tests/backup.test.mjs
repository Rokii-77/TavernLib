import JSZip from 'jszip'
import { buildBackupZip } from '../src/lib/backup.js'

const items = {
  characters: [
    {
      id: 'c1',
      name: '艾拉 · 酒馆老板娘',
      desc: '红发老板娘',
      tags: ['奇幻'],
      hue: 18,
      dc: { url: 'https://discord.com/channels/1/2', title: '艾拉 v3.3' },
      stVersion: 'v3.3',
      updatedAt: '2026-11-02',
      versions: [
        { id: 'v1', name: 'v3.3 汉化', current: true, raw: { spec: 'chara_card_v2', data: { name: '艾拉' } } },
        { id: 'v2', name: 'v3.2', current: false }
      ]
    }
  ],
  worldbooks: [{ id: 'w1', name: '克苏鲁/世界书', desc: 'x', tags: [], versions: [{ name: '2026-10', current: true }] }],
  presets: [{ id: 'p1', name: '长文续写', desc: 'y', tags: [], versions: [{ name: '1.4', current: true }] }]
}

const { blob, manifest, fileName, count } = await buildBackupZip(items, { source: 'full' })
const buf = Buffer.from(await blob.arrayBuffer())
const back = await JSZip.loadAsync(buf)
const files = Object.keys(back.files).sort()

console.log('文件名:', fileName)
console.log('条目数:', count, '| 计数:', JSON.stringify(manifest.counts))
console.log('包大小:', (buf.length / 1024).toFixed(1) + 'KB')
console.log('包内文件:')
for (const f of files) console.log('  ' + f)

const card = JSON.parse(await back.file('characters/艾拉 · 酒馆老板娘/v3.3 汉化.json').async('string'))
console.log('角色卡原始 JSON 还原:', JSON.stringify(card))
const manifestIn = JSON.parse(await back.file('manifest.json').async('string'))
console.log('manifest 条目:', manifestIn.entries.length, '| 首条:', manifestIn.entries[0].name, manifestIn.entries[0].current_version)

// 断言
const need = [
  'manifest.json',
  'characters/艾拉 · 酒馆老板娘/v3.3 汉化.json',
  'characters/艾拉 · 酒馆老板娘/history/v3.2.json',
  'worldbooks/克苏鲁_世界书/2026-10.json',
  'presets/长文续写/1.4.json'
]
const missing = need.filter((n) => !files.includes(n))
console.log(missing.length ? 'FAIL 缺失: ' + missing.join(', ') : 'PASS 结构完整（含非法字符名转义、历史版本、manifest）')
