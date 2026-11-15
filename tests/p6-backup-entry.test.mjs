/* P6：完整备份入口从顶栏搬到设置页「维护」区块
   守卫两件事：顶栏不再有备份按钮（否则窄窗口又要把窗口键挤出去）、设置页确实提供了入口 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const topbar = readFileSync(path.join(ROOT, 'src/components/TopBar.vue'), 'utf8')
const settings = readFileSync(path.join(ROOT, 'src/components/SettingsPanel.vue'), 'utf8')

const out = []
function ok(name, cond, extra) {
  out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''))
  return !!cond
}

ok('顶栏不再出现「完整备份」按钮文案', !topbar.includes('完整备份'))
ok('顶栏不再引用 doFullBackup', !topbar.includes('doFullBackup'))
ok('顶栏不再直接引 backup.js', !topbar.includes("from '../lib/backup.js'"))

ok('设置页出现「完整备份」入口', settings.includes('完整备份'))
ok('设置页调用 doFullBackup', settings.includes('doFullBackup'))
ok('设置页引入 exportBackupZip', settings.includes("import { exportBackupZip } from '../lib/backup.js'"))

/* 入口必须落在「维护」区块里，不要散落成孤立按钮 */
const mi = settings.indexOf('<h3>维护</h3>')
const 维护块 = mi >= 0 ? settings.slice(mi, mi + 1200) : ''
ok('「完整备份」位于维护区块内', 维护块.includes('完整备份'))

const fail = out.filter((l) => l.startsWith('FAIL'))
console.log(out.join('\n'))
console.log(`\nP6 备份入口：${out.length - fail.length}/${out.length} PASS`)
if (fail.length) process.exit(1)
