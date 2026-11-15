/* 历史版本列表（回退目标检索）单测：只测纯函数，不联网 */
import assert from 'node:assert'
import { listReleases, compareVersion } from '../src/lib/update.js'

const fails = []
function ok(name, fn) {
  try {
    fn()
    console.log('PASS  ' + name)
  } catch (e) {
    fails.push(name)
    console.log('FAIL  ' + name + ' :: ' + (e && e.message))
  }
}
async function okAsync(name, fn) {
  try {
    await fn()
    console.log('PASS  ' + name)
  } catch (e) {
    fails.push(name)
    console.log('FAIL  ' + name + ' :: ' + (e && e.message))
  }
}

function mk(rel) {
  return {
    ok: true,
    status: 200,
    data: Array.isArray(rel) ? rel : [rel]
  }
}

await okAsync('未配置仓库时直接返回 configured=false', async () => {
  const r = await listReleases({ owner: '', repo: '', fetchJson: async () => mk([]) })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.configured, false)
  assert.deepStrictEqual(r.items, [])
})

await okAsync('没有 fetchJson 时提示去桌面版', async () => {
  const r = await listReleases({ owner: 'a', repo: 'b' })
  assert.strictEqual(r.ok, false)
  assert.ok(/桌面版/.test(r.error))
})

await okAsync('正常列表：去掉 v 前缀、带安装包的才算、按版本倒序', async () => {
  const r = await listReleases({
    owner: 'Rokii-77',
    repo: 'TavernLib',
    fetchJson: async () =>
      mk([
        {
          tag_name: 'v0.1.5',
          body: 'old',
          published_at: '2026-01-01T00:00:00Z',
          assets: [{ name: '洛书匣 Setup 0.1.5.exe', browser_download_url: 'https://x/0.1.5.exe', size: 100 }]
        },
        {
          tag_name: '0.1.7',
          assets: [{ name: 'Setup 0.1.7.exe', browser_download_url: 'https://x/0.1.7.exe', size: 300 }]
        },
        {
          tag_name: 'v0.1.6',
          assets: [{ name: 'Setup 0.1.6.exe', browser_download_url: 'https://x/0.1.6.exe', size: 200 }]
        },
        /* 没有安装包的版本要跳过（回退没法用） */
        { tag_name: 'v0.1.4', assets: [] }
      ])
  })
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(
    r.items.map((x) => x.latest),
    ['0.1.7', '0.1.6', '0.1.5']
  )
  assert.strictEqual(r.items[1].downloadUrl, 'https://x/0.1.6.exe')
  assert.strictEqual(r.items[1].downloadName, 'Setup 0.1.6.exe')
  assert.strictEqual(r.items[1].downloadSize, 200)
})

await okAsync('版本号顺序按语义比较而不是字符串', async () => {
  const r = await listReleases({
    owner: 'a',
    repo: 'b',
    fetchJson: async () =>
      mk([
        { tag_name: 'v0.1.9', assets: [{ name: 'a.exe', browser_download_url: 'https://x/9.exe' }] },
        { tag_name: 'v0.1.10', assets: [{ name: 'b.exe', browser_download_url: 'https://x/10.exe' }] }
      ])
  })
  assert.deepStrictEqual(
    r.items.map((x) => x.latest),
    ['0.1.10', '0.1.9']
  )
})

await okAsync('网络失败/限流给出可读错误', async () => {
  const r403 = await listReleases({ owner: 'a', repo: 'b', fetchJson: async () => ({ ok: false, status: 403 }) })
  assert.strictEqual(r403.ok, false)
  assert.ok(/限流/.test(r403.error))
  const r404 = await listReleases({ owner: 'a', repo: 'b', fetchJson: async () => ({ ok: false, status: 404 }) })
  assert.ok(/不存在/.test(r404.error))
})

ok('compareVersion 基本语义（回退选版本要用）', () => {
  assert.ok(compareVersion('0.1.10', '0.1.9') > 0)
  assert.ok(compareVersion('0.1.9', '0.1.10') < 0)
  assert.strictEqual(compareVersion('0.1.9', '0.1.9'), 0)
})

console.log('')
if (fails.length) {
  console.log('FAILED=' + fails.length)
  process.exit(1)
}
console.log('FAILED=0')
