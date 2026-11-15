/* 类别判定 + 美化导出格式：防「导入完美化详情页预览整块不渲染」「导出成 css 酒馆不认」回归
   覆盖 src/lib/itemcat.js 的纯函数，以及对源码接线的静态检查 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { CAT_ORDER, catIndex } from '../src/lib/itemcat.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const out = []
function ok(name, cond, extra) {
  out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''))
  return !!cond
}

/* ---------- 纯判定 ---------- */
const lists = {
  characters: [{ id: 'c1', name: '卡' }],
  worldbooks: [{ id: 'w1', name: '书' }],
  presets: [{ id: 'p1', name: '预设' }],
  themes: [{ id: 't1', name: '美化' }],
  others: [{ id: 'o1', name: '其它' }]
}

ok('CAT_ORDER 顺序固定', JSON.stringify(CAT_ORDER) === JSON.stringify(['characters', 'worldbooks', 'presets', 'themes', 'others']))
ok('有 category 直接采用', catIndex(lists, { id: 't1', category: 'themes' }) === 'themes')
ok('没有 category 按引用反查', catIndex(lists, lists.themes[0]) === 'themes')
ok('没有 category 按 id 反查（副本）', catIndex(lists, { id: 't1', name: '美化' }) === 'themes')

/* 回归：历史 bug —— 运行期新建的美化条目缺 category，被判定成非美化，预览整块不渲染 */
const fresh = { id: 'tx', name: '新导入的美化' }
lists.themes.push(fresh)
ok('运行期新建的条目（无 category）当场判为 themes', catIndex(lists, fresh) === 'themes')

ok('列表里查不到返回空串', catIndex(lists, { id: 'nope' }) === '')
ok('空条目安全', catIndex(lists, null) === '' && catIndex(lists, undefined) === '')
ok('lists 为空但条目自带 category 仍可用', catIndex(null, { id: 't1', category: 'themes' }) === 'themes')
ok('lists 缺该分类数组不抛错', catIndex({ characters: null }, { id: 'x' }) === '')
ok('id 为空不误匹配空 id 条目', catIndex({ others: [{ id: '' }] }, { id: '' }) === '')

/* ---------- 源码接线：别再退回「直接读 item.category」 ---------- */
const storeSrc = readFileSync(path.join(ROOT, 'src/store.js'), 'utf8')
const detailSrc = readFileSync(path.join(ROOT, 'src/views/CardDetail.vue'), 'utf8')
const shelfSrc = readFileSync(path.join(ROOT, 'src/views/Bookshelf.vue'), 'utf8')

ok('store 引入 itemcat 纯函数', /from '\.\/lib\/itemcat\.js'/.test(storeSrc))
ok('catOf 走 catIndex 判定', /catIndex\(items, item\)/.test(storeSrc))
ok('tagCategories 用 CAT_ORDER 遍历', /for \(const k of CAT_ORDER\)/.test(storeSrc))
ok('category 不再写成不可枚举属性', !/enumerable: false[^}]*category|Object\.defineProperty\(it, 'category'/.test(storeSrc))
ok('导入新建条目自带 category', /category: cat,/.test(storeSrc))
ok('导入收尾补齐整库类别', /tagCategories\(store\.items\)/.test(storeSrc))
ok('详情页用 catOf 判定美化', /isTheme = computed\(\(\) => catOf\(props\.item\) === 'themes'\)/.test(detailSrc))
ok('详情页不再直接读 item.category', !/item\.category\s*===/.test(detailSrc))
ok('书架用 catOf 判定', /catOf\(it\)/.test(shelfSrc))

/* ---------- 导出格式：美化必须是酒馆认的 json ---------- */
ok('美化扩展名是 json', /themes:\s*'json'/.test(storeSrc))
ok('存在拼装酒馆主题的函数', /export function themeJsonOf/.test(storeSrc))
ok('主题 json 写 custom_css 字段', /out\.custom_css = css/.test(storeSrc))
ok('单条导出美化走 themeJsonOf', /json = themeJsonOf\(ver, item\)/.test(storeSrc))
ok('批量导出美化走 themeJsonOf', /theme = themeJsonOf\(ver, item\)/.test(storeSrc))
ok('推酒馆美化写 themes 目录', /themes`[\s\S]{0,200}writeNamed/.test(storeSrc) || /data\/\$\{store\.settings\.stUser \|\| 'default-user'\}\/themes/.test(storeSrc))
ok('不再把美化导出成 css 文件', !/name: `\$\{base\}\.css`/.test(storeSrc))

console.log(out.join('\n'))
const failed = out.filter((l) => l.startsWith('FAIL')).length
console.log(`\nFAILED=${failed}`)
process.exit(failed ? 1 : 0)
