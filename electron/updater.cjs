/* ---------------- 应用内更新（下载 → 静默安装 → 自动重启） ----------------
 * 不依赖 electron-updater，走最小实现：
 *   1. 渲染进程用 lib/update.js 查 releases/latest，拿到 exe 直链与 sha256
 *   2. 这里负责把 exe 下到 temp\tavernlib-update，边下边把进度推给界面
 *   3. 「重启并安装」时写一个一次性 .cmd：等旧进程退出 → NSIS /S 静默覆盖安装
 *      （/D 指定回当前安装目录，避免装到别处）→ 启动新 exe → 自删脚本
 * 全程无窗口（windowsHide），不会弹安装向导。
 */
const { app, ipcMain, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const https = require('node:https')
const http = require('node:http')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const rollback = require('./lib/rollback.cjs') // 更新看门狗：判断新版能否正常启动

const PRODUCT = '洛书匣'
/** 从安装包文件名里猜版本号（Setting x.y.z.exe），拿不到就交空 */
function guessVersionFromName(file) {
  const m = String(file || '').match(/(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*)/)
  return m ? m[1] : ''
}
let lastPkg = '' // 最近一次下载好的安装包路径

function updateDir() {
  const d = path.join(app.getPath('temp'), 'tavernlib-update')
  fs.mkdirSync(d, { recursive: true })
  return d
}

function send(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed() && w.webContents) w.webContents.send(channel, payload)
    } catch (_) {}
  }
}

function safeHttpsUrl(u) {
  try {
    const p = new URL(String(u || ''))
    if (!/^https?:$/.test(p.protocol)) return null
    return p.toString()
  } catch (_) {
    return null
  }
}

/* 跟随 3xx 下载到 target，边写边回报进度 */
function downloadTo(url, target, onProgress, redirects = 0) {
  return new Promise((resolve) => {
    if (redirects > 6) return resolve({ ok: false, error: '重定向次数过多' })
    const u = safeHttpsUrl(url)
    if (!u) return resolve({ ok: false, error: '下载地址不合法' })

    const isHttp = u.startsWith('http://')
    const client = isHttp ? http : https
    const req = client.get(
      u,
      {
        headers: {
          'User-Agent': 'LuoshuBox-Updater',
          Accept: 'application/octet-stream'
        },
        timeout: 60000
      },
      (res) => {
        const st = res.statusCode || 0
        if (st >= 300 && st < 400 && res.headers.location) {
          res.resume()
          const next = new URL(res.headers.location, u).toString()
          return resolve(downloadTo(next, target, onProgress, redirects + 1))
        }
        if (st !== 200) {
          res.resume()
          return resolve({ ok: false, error: `下载失败（HTTP ${st}）`, status: st })
        }

        const total = Number(res.headers['content-length'] || 0)
        let received = 0
        let lastSent = 0
        const fd = fs.createWriteStream(target)
        const hash = crypto.createHash('sha256')

        res.on('data', (chunk) => {
          received += chunk.length
          hash.update(chunk)
          const now = Date.now()
          if (now - lastSent > 200) {
            lastSent = now
            onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : 0 })
          }
        })
        res.on('end', () => {
          fd.end(() => {
            onProgress({ received, total: total || received, percent: 100 })
            resolve({ ok: true, path: target, size: received, sha256: hash.digest('hex') })
          })
        })
        res.on('error', (e) => {
          try { fd.destroy() } catch (_) {}
          resolve({ ok: false, error: String((e && e.message) || e) })
        })
        res.pipe(fd)
        fd.on('error', (e) => {
          try { res.destroy() } catch (_) {}
          resolve({ ok: false, error: '写文件失败：' + String((e && e.message) || e) })
        })
      }
    )
    req.on('timeout', () => {
      try { req.destroy() } catch (_) {}
      resolve({ ok: false, error: '下载超时' })
    })
    req.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }))
  })
}

/* 生成一次性安装脚本：旧进程退出 → 静默安装到原目录 → 启动新版本
 * 用 PowerShell（UTF-8 BOM，能正确解析中文路径）+ Hidden 窗口，
 * 比 .cmd 稳：cmd 默认按 GBK 读脚本，中文路径会乱码。 */
function buildInstallScript(installerPath, installDir, exePath) {
  const dir = updateDir()
  const ps1 = path.join(dir, `apply-update-${Date.now()}.ps1`)
  const q = (v) => String(v).replace(/'/g, "''")
  const logPath = q(path.join(dir, 'apply.log'))
  const lines = [
    `"boot $(Get-Date -Format HH:mm:ss)" | Out-File -LiteralPath '${logPath}' -Append -Encoding utf8`,
    'Start-Sleep -Seconds 3',
    `$p = Start-Process -FilePath '${q(installerPath)}' -ArgumentList '/S /D=${q(installDir)}' -Wait -WindowStyle Hidden`,
    `"installed $(Get-Date -Format HH:mm:ss)" | Out-File -LiteralPath '${logPath}' -Append -Encoding utf8`,
    'Start-Sleep -Seconds 2',
    `Start-Process -FilePath '${q(exePath)}'`,
    `"relaunched $(Get-Date -Format HH:mm:ss)" | Out-File -LiteralPath '${logPath}' -Append -Encoding utf8`,
    'Start-Sleep -Seconds 1',
    'Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue'
  ]
  fs.writeFileSync(ps1, '\ufeff' + lines.join('\r\n'), 'utf-8')
  return ps1
}

function currentInstallInfo() {
  // 打包后 process.execPath 就在安装目录里，更新时原地覆盖
  const exePath = process.execPath
  const installDir = path.dirname(exePath)
  return { exePath, installDir }
}

ipcMain.handle('up:download', async (_e, { url, name, sha256 } = {}) => {
  const u = safeHttpsUrl(url)
  if (!u) return { ok: false, error: '下载地址不合法' }

  let fileName = String(name || '').replace(/[\\/:*?"<>|]/g, '_').trim()
  if (!fileName) {
    try { fileName = decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || '') } catch (_) {}
  }
  if (!/\.exe$/i.test(fileName)) fileName = (fileName || 'update') + '.exe'

  const target = path.join(updateDir(), fileName)
  try { if (fs.existsSync(target)) fs.unlinkSync(target) } catch (_) {}

  const r = await downloadTo(u, target, (p) => send('up:progress', p))
  if (!r.ok) {
    try { if (fs.existsSync(target)) fs.unlinkSync(target) } catch (_) {}
    return r
  }

  if (sha256) {
    const want = String(sha256).toLowerCase().replace(/^sha256:/, '')
    if (want && r.sha256.toLowerCase() !== want) {
      try { fs.unlinkSync(target) } catch (_) {}
      return { ok: false, error: '安装包校验失败（sha256 不一致），已删除' }
    }
  }

  lastPkg = r.path
  return { ok: true, path: r.path, size: r.size, sha256: r.sha256, name: fileName }
})

ipcMain.handle('up:install', async (_e, { path: pkgPath, toVersion } = {}) => {
  const installer = String(pkgPath || lastPkg || '').trim()
  if (!installer || !fs.existsSync(installer)) return { ok: false, error: '安装包不存在，请重新下载' }
  if (!/\.exe$/i.test(installer)) return { ok: false, error: '安装包类型不对' }

  const { exePath, installDir } = currentInstallInfo()

  /* 装之前记一笔「从哪个版本到哪个版本」：新版起不来时，看门狗靠这条记录判断要不要提示回退 */
  try {
    const from = String(app.getVersion() || '')
    const to = String(toVersion || '').trim() || guessVersionFromName(installer)
    if (to) {
      rollback.init(app.getPath('userData'), { version: from })
      rollback.markPending({ from, to })
    }
  } catch (_) {}
  let bat = ''
  try {
    bat = buildInstallScript(installer, installDir, exePath)
  } catch (e) {
    return { ok: false, error: '准备安装脚本失败：' + String((e && e.message) || e) }
  }

  try {
    /* 关键：直接 spawn 的脚本会随 Electron 主进程退出被结束，活不到安装那一步。
       改用 WMI 创建进程（父进程是 WmiPrvSE，不受本进程生命周期影响），
       脚本才能真正等我们退出后完成安装并重启。 */
    const inner = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${bat}"`
    const psCmd =
      "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments " +
      "@{CommandLine='" + inner.replace(/'/g, "''") + "'} | Out-Null"
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], {
      windowsHide: true
    })
  } catch (e) {
    return { ok: false, error: '启动安装失败：' + String((e && e.message) || e) }
  }

  // 给界面一点时间把「正在重启安装」画出来，再退出，避免脚本等待超时
  setTimeout(() => {
    try { app.exit(0) } catch (_) { app.quit() }
  }, 1200)

  return { ok: true, restarting: true, installDir }
})

/* 启动时清理上一次遗留的安装包（安装成功后就没用了） */
function cleanupOldPackages() {
  try {
    const d = updateDir()
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f)
      if (f === path.basename(lastPkg)) continue
      const age = Date.now() - fs.statSync(p).mtimeMs
      if (age > 24 * 3600 * 1000) fs.unlinkSync(p)
    }
  } catch (_) {}
}

/* ---------------- 看门狗 IPC：给界面判断「要不要提示回退」 ---------------- */
function rollbackReady() {
  try {
    rollback.init(app.getPath('userData'), { version: app.getVersion() })
    return true
  } catch (_) {
    return false
  }
}

ipcMain.handle('up:state', () => {
  try {
    if (!rollbackReady()) return { ok: false, error: '看门狗状态目录不可用' }
    return { ok: true, state: rollback.state(), file: rollback.filePath(), current: app.getVersion() }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
})

/* 用户已经回退好了 / 不想再看到提示 */
ipcMain.handle('up:clearSuspect', () => {
  try {
    if (!rollbackReady()) return { ok: false, error: '看门狗状态目录不可用' }
    rollback.clear()
    return { ok: true, state: rollback.state() }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
})

app.whenReady().then(() => {
  setTimeout(cleanupOldPackages, 3000)
  /* 看门狗：上次装完新版如果没熬过启动期，这里会记上一笔；连续两次就提示可回退 */
  try {
    if (rollbackReady()) {
      const s = rollback.bootTick(app.getVersion())
      if (s && s.suspect) console.warn('[update] 新版未能正常启动，界面会提示可回退到 ' + String(s.pending && s.pending.from))
    }
  } catch (_) {}
  /* 启动后稳定跑满 20 秒 → 这次更新算成功，清掉待观察记录 */
  setTimeout(() => {
    try {
      if (rollbackReady()) rollback.stable(app.getVersion())
    } catch (_) {}
  }, 20 * 1000).unref?.()
})

module.exports = { PRODUCT }
