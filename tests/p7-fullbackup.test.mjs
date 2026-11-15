/* P7：完整备份会「软件内黑屏」
   根因：几百 MB 图片全部在渲染进程主线程里打包 + DEFLATE 压缩 + 一次性 arrayBuffer 走 IPC，
   主线程被按住几十秒不重绘，窗口整块黑掉。
   这里用静态守卫钉住修复要点，防止后人把压缩级别调回去。 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const backup = readFileSync(path.join(ROOT, 'src/lib/backup.js'), 'utf8')
const main = readFileSync(path.join(ROOT, 'electron/main.cjs'), 'utf8')
const preload = readFileSync(path.join(ROOT, 'electron/preload.cjs'), 'utf8')
const settings = readFileSync(path.join(ROOT, 'src/components/SettingsPanel.vue'), 'utf8')

const out = []
function ok(name, cond, extra) {
  out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''))
  return !!cond
}

ok('完整备份不再用 DEFLATE 压缩图片', !/compression:\s*'DEFLATE'/.test(backup))
ok('完整备份改用 STORE（图片本就压过）', /compression:\s*'STORE'/.test(backup))
ok('打包过程会主动让出主线程', backup.includes('yieldUI') && backup.includes('setTimeout(r, 0)'))
ok('每条之间回报进度（界面能显示 x/y）', backup.includes("phase: 'pack'"))
ok('写盘按分片进行', backup.includes('WRITE_CHUNK') && backup.includes('blob.slice('))

ok('主进程写盘为异步实现', /await fsp\.(writeFile|appendFile)/.test(main))
ok('主进程写盘支持 append 分片追加', main.includes('fsp.appendFile') && main.includes('opt.append'))
ok('preload 透传写盘选项', preload.includes("invoke('fs:writeBuffer', filePath, buffer, opt"))

ok('设置页展示备份进度', /backPhase/.test(settings) && /backPct/.test(settings))

const fail = out.filter((l) => l.startsWith('FAIL'))
console.log(out.join('\n'))
console.log(`\nP7 完整备份：${out.length - fail.length}/${out.length} PASS`)
if (fail.length) process.exit(1)
