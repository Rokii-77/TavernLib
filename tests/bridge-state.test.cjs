/* 通知桥 /state 接收端：酒馆扩展上报「当前在用哪张卡 / 什么版本」，管理器缓存后给设置页显示
   覆盖：POST /state 写入、GET /status.state 透传、过期判定、非法 body 不炸、GET 方式被拒 */

const path = require('node:path')
const bridge = require(path.resolve(__dirname, '../electron/lib/bridge.cjs'))

const out = []
function ok(name, cond, extra) {
  out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''))
  return !!cond
}

async function post(port, body) {
  const r = await fetch(`http://127.0.0.1:${port}/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  })
  return { status: r.status, json: await r.json() }
}

async function main() {
  const started = await bridge.start()
  ok('桥启动成功', !!started.ok, JSON.stringify(started))
  if (!started.ok) return finish()
  const port = started.port

  /* 1. 一开始没有上报：state.fresh 必须是 false，不能被历史数据污染 */
  let s = await (await fetch(`http://127.0.0.1:${port}/status`)).json()
  ok('初始 fresh=false', s.state && s.state.fresh === false)
  ok('初始 name 为空', s.state && s.state.name === '')

  /* 2. 正常上报 */
  const p = await post(port, JSON.stringify({ name: '测试角色', version: '1.2.3', extVersion: '1.5.0' }))
  ok('POST /state 返回 200', p.status === 200)
  ok('POST /state 回包 ok', p.json && p.json.ok === true)
  ok('POST 回包带回 state.name', p.json.state && p.json.state.name === '测试角色')

  s = await (await fetch(`http://127.0.0.1:${port}/status`)).json()
  ok('status.state.fresh=true', s.state.fresh === true)
  ok('status.state.name 透传', s.state.name === '测试角色')
  ok('status.state.version 透传', s.state.version === '1.2.3')
  ok('status.state.extVersion 透传', s.state.extVersion === '1.5.0')
  ok('status.state.agoMs 是数字', typeof s.state.agoMs === 'number' && s.state.agoMs >= 0)

  /* 3. 上报本身也算扩展心跳：ext.online 应为真 */
  ok('上报顺带刷新扩展心跳', s.ext && s.ext.online === true)

  /* 4. 脏数据不应该炸，且要截断超长字段 */
  const bad = await post(port, '{不是合法json')
  ok('非法 JSON 仍返回 200', bad.status === 200)
  ok('非法 JSON 清空 name', bad.json.state && bad.json.state.name === '')

  const long = await post(port, JSON.stringify({ name: 'x'.repeat(500), version: 'y'.repeat(300) }))
  ok('超长 name 被截断到 200', long.json.state.name.length === 200)
  ok('超长 version 被截断到 100', long.json.state.version.length === 100)

  /* 5. GET 方式要被拒 */
  const g = await fetch(`http://127.0.0.1:${port}/state`)
  ok('GET /state 返回 405', g.status === 405)

  /* 6. 空卡（酒馆没开卡）也要能上报，name/version 为空字符串 */
  const empty = await post(port, JSON.stringify({ name: '', version: '' }))
  ok('空卡上报成功', empty.json.ok === true && empty.json.state.name === '')
  ok('空卡仍算 fresh', empty.json.state.fresh === true)

  /* 7. 主进程用的是 bridge.status()（不是 HTTP /status），这条字段漏了界面就永远显示未上报 */
  await post(port, JSON.stringify({ name: '主进程通道', version: '9.9' }))
  const local = bridge.status()
  ok('bridge.status() 带 state 字段', !!local.state)
  ok('bridge.status().state.name 正确', local.state && local.state.name === '主进程通道')
  ok('bridge.status().state.fresh 正确', local.state && local.state.fresh === true)

  bridge.stop()
  ok('桥已停止', true)
  finish()
}

function finish() {
  const fail = out.filter((l) => l.startsWith('FAIL'))
  console.log(out.join('\n'))
  console.log(`\n通知桥状态上报：${out.length - fail.length}/${out.length} PASS`)
  if (fail.length) process.exit(1)
  process.exit(0)
}

main().catch((e) => {
  console.log(out.join('\n'))
  console.log('FAIL 用例异常退出：' + (e && e.message ? e.message : e))
  process.exit(1)
})
