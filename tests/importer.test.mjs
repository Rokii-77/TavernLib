import { classifyJson, defaultVersionName, fileExt, stripExt } from '../src/lib/importer.js'

const cases = [
  ['角色卡 v2', { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '艾拉', first_mes: '你好' } }, 'characters'],
  ['角色卡 v1', { name: '林小满', first_mes: '嗨', description: 'x' }, 'characters'],
  ['世界书', { name: '克苏鲁', entries: { 0: { uid: 0, key: ['深潜者'], content: '...' } } }, 'worldbooks'],
  ['世界书(数组)', { entries: [{ keys: ['a'], content: 'b' }] }, 'worldbooks'],
  ['预设', { name: '长文续写', temperature: 0.8, top_p: 0.9, prompts: [{ identifier: 'main' }] }, 'presets'],
  ['预设(少字段)', { name: '预设A', temperature: 1, top_k: 40 }, 'presets'],
  ['其他', { foo: 1, bar: 2 }, 'others']
]

let pass = 0
for (const [label, obj, expect] of cases) {
  const r = classifyJson(obj)
  const ok = r.category === expect
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(12)} -> ${r.category} (期望 ${expect})  名称=${r.name || '(空)'}`)
  if (ok) pass++
}
console.log(`\n结果: ${pass}/${cases.length}`)
console.log('默认版本名:', defaultVersionName('characters'))
console.log('扩展名:', fileExt('a.b.PNG'), '| 去扩展:', stripExt('艾拉 v3.2.json'))
