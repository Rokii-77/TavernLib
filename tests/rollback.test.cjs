/* 看门狗（回退判定）单测：node --test 或直接 node 跑都行 */
'use strict'

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const rb = require('../electron/lib/rollback.cjs')

const fails = []
function ok(name, fn) {
  try {
    fn()
    console.log('PASS  ' + name)
  } catch (e) {
    fails.push(name + ' :: ' + (e && e.message))
    console.log('FAIL  ' + name + ' :: ' + (e && e.message))
  }
}

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-rb-'))
  rb.init(dir, { version: '1.0.0' })
  return dir
}

ok('没有待观察记录时 bootTick 不报警', () => {
  fresh()
  const s = rb.bootTick('1.0.0')
  assert.strictEqual(s.suspect, false)
  assert.strictEqual(s.pending, null)
})

ok('安装前记账：pending 记录 from/to', () => {
  fresh()
  const r = rb.markPending({ from: '1.0.0', to: '1.0.1' })
  assert.strictEqual(r.ok, true)
  const s = rb.state()
  assert.strictEqual(s.pending.from, '1.0.0')
  assert.strictEqual(s.pending.to, '1.0.1')
  assert.strictEqual(s.attempts, 0)
})

ok('新版正常启动 + 稳定运行 → 更新成功，清掉 pending', () => {
  fresh()
  rb.markPending({ from: '1.0.0', to: '1.0.1' })
  const s1 = rb.bootTick('1.0.1')
  assert.strictEqual(s1.suspect, false)
  assert.strictEqual(s1.attempts, 1)
  const s2 = rb.stable('1.0.1')
  assert.strictEqual(s2.pending, null)
  assert.strictEqual(s2.suspect, false)
  assert.strictEqual(s2.lastBootOkFor, '1.0.1')
})

ok('新版起不来：连续两次跑在旧版上 → suspect=true', () => {
  fresh()
  rb.markPending({ from: '1.0.0', to: '1.0.1' })
  const a = rb.bootTick('1.0.0')
  assert.strictEqual(a.attempts, 1)
  assert.strictEqual(a.suspect, false, '第一次还不报警')
  const b = rb.bootTick('1.0.0')
  assert.strictEqual(b.attempts, 2)
  assert.strictEqual(b.suspect, true, '第二次判定可疑')
  assert.ok(b.suspectAt, '要记录判定时间')
})

ok('新版起不来（真实崩溃循环）：装了新版连续两次没熬过观察期 → suspect=true', () => {
  fresh()
  rb.markPending({ from: '1.0.0', to: '1.0.1' })
  /* 第一次：刚装完，startup 后 8 秒退出，没到 stable 的 20 秒 */
  const a = rb.bootTick('1.0.1')
  assert.strictEqual(a.attempts, 1)
  assert.strictEqual(a.suspect, false, '第一次还不报警')
  /* 第二次：用户重开，距上次启动远不到观察期 */
  const b = rb.bootTick('1.0.1')
  assert.strictEqual(b.attempts, 2)
  assert.strictEqual(b.suspect, true, '第二次判定可疑')
  assert.ok(b.suspectAt, '要记录判定时间')
})

ok('suspect 会持久化，重启后读得到', () => {
  const dir = fresh()
  rb.markPending({ from: '1.0.0', to: '1.0.1' })
  rb.bootTick('1.0.0')
  rb.bootTick('1.0.0')
  /* 模拟重启：同一目录重新 init */
  rb.init(dir, { version: '1.0.0' })
  const s = rb.state()
  assert.strictEqual(s.suspect, true)
  assert.strictEqual(s.pending.from, '1.0.0')
})

ok('用户点「不用了」→ clear 后不再报警', () => {
  fresh()
  rb.markPending({ from: '1.0.0', to: '1.0.1' })
  rb.bootTick('1.0.0')
  rb.bootTick('1.0.0')
  assert.strictEqual(rb.state().suspect, true)
  rb.clear()
  const s = rb.state()
  assert.strictEqual(s.suspect, false)
  assert.strictEqual(s.pending, null)
  assert.strictEqual(s.attempts, 0)
})

ok('回退也算一次版本切换：从新版退回旧版后，旧版稳定运行即清理', () => {
  fresh()
  rb.clear()
  rb.markPending({ from: '1.0.1', to: '1.0.0' })
  const s1 = rb.bootTick('1.0.0')
  assert.strictEqual(s1.suspect, false)
  rb.stable('1.0.0')
  assert.strictEqual(rb.state().pending, null)
})

ok('版本号没变（from === to）不记账，避免自己骗自己', () => {
  fresh()
  const r = rb.markPending({ from: '1.0.0', to: '1.0.0' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(rb.state().pending, null)
})

ok('过期记录自动作废（超过 7 天不再挂着吓人）', () => {
  const dir = fresh()
  rb.markPending({ from: '1.0.0', to: '1.0.1' })
  const f = rb.filePath()
  const obj = JSON.parse(fs.readFileSync(f, 'utf8'))
  obj.pending.at = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString()
  fs.writeFileSync(f, JSON.stringify(obj), 'utf8')
  const s = rb.bootTick('1.0.0')
  assert.strictEqual(s.pending, null)
  assert.strictEqual(s.suspect, false)
})

ok('状态文件损坏时不崩，按空状态处理', () => {
  const dir = fresh()
  const f = rb.filePath()
  fs.writeFileSync(f, '{坏掉的 json', 'utf8')
  const s = rb.state()
  assert.strictEqual(s.pending, null)
  assert.strictEqual(s.suspect, false)
})

console.log('')
if (fails.length) {
  console.log('FAILED=' + fails.length)
  process.exit(1)
}
console.log('FAILED=0')
