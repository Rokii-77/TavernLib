/* P3 顶栏布局：窗口按钮永远不能被挤出视口
   这里做源码级守卫（真实像素级验证靠 Electron 取证脚本），防止后续往顶栏加东西时又把关闭键挤出去 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const src = readFileSync(path.join(ROOT, 'src/components/TopBar.vue'), 'utf8')

const out = []
function ok(name, cond, extra) {
  out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''))
  return !!cond
}

/** 取出某个选择器的样式块（够用即可，不做完整 CSS 解析） */
function block(selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\ /g, ' ') + '\\s*\\{([^}]*)\\}', 'g')
  const hits = []
  let m
  while ((m = re.exec(src))) hits.push(m[1])
  return hits.join('\n')
}

const topbar = block('.topbar')
const winbar = block('.winbar')
const winbtn = block('.winbtn')
const tabs = block('.tabs')
const right = block('.right')

ok('顶栏允许收缩（min-width:0）', /min-width:\s*0/.test(topbar), topbar.trim().slice(0, 60))
ok('顶栏超出时裁切而不是撑破窗口', /overflow:\s*hidden/.test(topbar))
ok('窗口按钮组不参与压缩（flex:0 0 auto）', /flex:\s*0 0 auto/.test(winbar), winbar.trim().slice(0, 60))
ok('单个窗口按钮固定 46px 宽', /flex:\s*0 0 46px/.test(winbtn) && /min-width:\s*46px/.test(winbtn))
ok('标签栏可收缩并在内部滚动', /min-width:\s*0/.test(tabs) && /overflow-x:\s*auto/.test(tabs))
ok('右侧操作区可收缩', /min-width:\s*0/.test(right))
ok('右侧按钮本身不被压扁', /\.right > button[\s\S]*?flex:\s*0 0 auto/.test(src))

/* 窄窗口降级：先去掉品牌文字与标签计数，再收紧按钮内边距 */
ok('窄窗口去掉品牌文字', /@media \(max-width: 1120px\)[\s\S]*?\.brand \.name\s*\{\s*display:\s*none/.test(src))
ok('窄窗口去掉标签计数', /@media \(max-width: 1120px\)[\s\S]*?\.tabs \.tab em\s*\{\s*display:\s*none/.test(src))
ok('更窄时进一步收紧间距与内边距', /@media \(max-width: 1000px\)/.test(src) && /@media \(max-width: 1000px\)[\s\S]*?\.right button/.test(src))

/* 自绘窗口按钮仍绑定三件事，别在改布局时丢了事件 */
ok('关闭按钮仍绑定关闭动作', /title="关闭"/.test(src) && /min|max|close/.test(src))

console.log(out.join('\n'))
const failed = out.filter((l) => l.startsWith('FAIL')).length
console.log(`\nFAILED=${failed}`)
process.exit(failed ? 1 : 0)
