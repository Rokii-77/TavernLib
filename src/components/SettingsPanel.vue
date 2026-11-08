<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { store, saveSettings, showToast, isBlacklisted, clearLibrary, flushSnapshot, runAutoScan, setTheme, setCustomCss, refreshTavernUrlFromConfig, startAppUpdate, installAppUpdate, bindUpdProgress, checkStExtVersion, checkRollbackOnStart, rollbackAppUpdate, dismissRollback } from '../store.js'
import { checkForUpdate, DEFAULT_UPDATE_SOURCE, REPO_URL, REPO_WEB } from '../lib/update.js'
import { exportBackupZip } from '../lib/backup.js'
import { BASE_CSS_TEMPLATE } from '../lib/theme.js'
import { openFirstRun } from '../store.js'

/* ---------- 完整备份：把库内全部条目打包成一个 zip
 * 入口原在顶栏，现移到设置页「维护」区块（顶栏不再放这个按钮） */
const backing = ref(false)
const backPct = ref(0)
const backPhase = ref('')
async function doFullBackup() {
  if (backing.value) return
  backing.value = true
  backPct.value = 0
  backPhase.value = '打包中'
  try {
    const r = await exportBackupZip(store.items, {
      source: 'full',
      onProgress: (p) => {
        if (!p) return
        if (p.phase === 'pack') {
          backPhase.value = '打包中'
          backPct.value = p.total ? Math.round((p.done / p.total) * 100) : 0
        } else if (p.phase === 'zip') {
          backPhase.value = '压缩中'
          backPct.value = Number(p.percent || 0)
        } else if (p.phase === 'write') {
          backPhase.value = '写入中'
          backPct.value = Number(p.percent || 0)
        }
      }
    })
    if (r.canceled) showToast('已取消备份')
    else if (!r.saved) showToast('备份失败：' + (r.error || '未知错误'))
    else showToast(`已备份 ${r.count} 个条目 → ${r.path}`)
  } catch (e) {
    showToast('备份异常：' + (e && e.message ? e.message : e))
  } finally {
    backing.value = false
    backPct.value = 0
    backPhase.value = ''
  }
}

/* ---------- 外观：跟随系统 / 夜间 / 日间 + 自定义 CSS ----------
 * 主题与 CSS 都是「点了就生效」，不走底部保存按钮：改完立刻能看到效果，
 * 不满意按「清空」一键还原；setTheme / setCustomCss 内部已经落盘。 */
const themeMode = computed(() => store.settings.theme)
const cssDraft = ref(store.settings.customCss || '')

function pickTheme(mode) {
  setTheme(mode)
}

function applyCss() {
  const text = cssDraft.value || ''
  setCustomCss(text)
  showToast(text.trim() ? '自定义 CSS 已应用' : '已恢复内置样式')
}

function insertTemplate() {
  cssDraft.value = BASE_CSS_TEMPLATE
}

function clearCss() {
  cssDraft.value = ''
  setCustomCss('')
  showToast('已恢复内置样式')
}

/* 导入 .css 文件：只在渲染进程读文本，不落盘、不改原文件 */
function pickCssFile() {
  const inp = document.createElement('input')
  inp.type = 'file'
  inp.accept = '.css,text/css,text/plain'
  inp.onchange = async () => {
    const f = inp.files && inp.files[0]
    if (!f) return
    try {
      const text = await f.text()
      if (!text.trim()) return showToast('这个文件是空的')
      cssDraft.value = text
      setCustomCss(text)
      showToast(`已导入 ${f.name}`)
    } catch (e) {
      showToast('读取文件失败：' + (e && e.message ? e.message : e))
    }
  }
  inp.click()
}


const bl = ref('')

/* ---------- 酒馆 API 地址（自动读 config.yaml） ---------- */
const apiManual = ref(false)
const apiBusy = ref(false)
const cfg = computed(() => store.stStatus.config || {})

async function detectApiUrl() {
  if (!String(store.settings.tavernPath || '').trim()) return showToast('先在上面填好酒馆安装路径')
  apiBusy.value = true
  try {
    const r = await refreshTavernUrlFromConfig({ silent: true })
    if (r.ok) showToast('已按 config.yaml 识别 API 地址：' + r.url)
    else showToast('没读到 config.yaml 里的 port，可手动填写')
  } finally {
    apiBusy.value = false
  }
}

/* ---------- 酒馆扩展：自动识别 + 一键安装 / 更新 ---------- */
const extInfo = ref({ installed: false, version: '', latest: '', outdated: false, path: '' })
const extBusy = ref(false)

const extText = computed(() => {
  if (!String(store.settings.tavernPath || '').trim()) return '未设置路径'
  const latest = extInfo.value.latest ? 'v' + extInfo.value.latest : '—'
  const mine = extInfo.value.installed ? (extInfo.value.version ? 'v' + extInfo.value.version : '未知版本') : '未安装'
  return '内置 ' + latest + '｜酒馆 ' + mine
})

const extNeedUpdate = computed(() => !!extInfo.value.latest && extInfo.value.outdated)
const extActionText = computed(() => {
  if (extBusy.value) return '处理中…'
  if (!extInfo.value.installed) return '安装'
  return extNeedUpdate.value ? '更新' : '重新注入'
})

async function refreshExt() {
  const a = window.api
  const tp = String(store.settings.tavernPath || '').trim()
  if (!tp || !a?.stExtStatus) {
    extInfo.value = { installed: false, version: '', latest: '', outdated: false, path: '' }
    return
  }
  try {
    const r = await a.stExtStatus({ tavernPath: store.settings.tavernPath, user: store.settings.stUser })
    extInfo.value =
      r && r.ok
        ? {
            installed: !!r.installed,
            version: r.version || '',
            latest: r.latest || '',
            outdated: !!r.outdated,
            path: r.path || ''
          }
        : { installed: false, version: '', latest: r?.latest || '', outdated: false, path: '' }
  } catch (_) {
    extInfo.value = { installed: false, version: '', latest: '', outdated: false, path: '' }
  }
}

async function injectExt() {
  const a = window.api
  if (!a?.stExtInject) return showToast('请在桌面版里使用')
  extBusy.value = true
  try {
    const r = await a.stExtInject({ tavernPath: store.settings.tavernPath, user: store.settings.stUser })
    if (!r?.ok) return showToast(r?.error || '注入失败')
    await refreshExt()
    /* 注入完顺带复查一次版本，右下角那张「需要重新注入」的卡要跟着消失 */
    Promise.resolve(checkStExtVersion()).catch(() => {})
    showToast('已写入扩展 v' + (r.version || extInfo.value.latest || '') + '，刷新酒馆页面生效')
  } finally {
    extBusy.value = false
  }
}

watch(
  () => store.settings.tavernPath,
  () => {
    refreshExt()
  }
)

/* ---------- 软件数据保存路径 ---------- */
const dataDir = ref('')
const dataDefault = ref('')
const dataCustom = ref(false)
const dataBusy = ref(false)

async function refreshDataDir() {
  const a = window.api
  if (!a?.dataInfo) return
  const r = await a.dataInfo()
  if (r?.ok) {
    dataDir.value = r.dir || ''
    dataDefault.value = r.defaultDir || ''
    dataCustom.value = !!r.custom
  }
}

async function pickFolder(title, defaultPath) {
  const a = window.api
  if (!a?.pickDir) {
    showToast('请在桌面版里使用')
    return ''
  }
  const picked = await a.pickDir({ title, defaultPath: defaultPath || '' })
  if (!picked) return ''
  return Array.isArray(picked) ? picked[0] : picked
}

async function openFolder(p) {
  const a = window.api
  if (!p) return showToast('还没设置路径')
  if (!a?.reveal) return showToast('请在桌面版里使用')
  const r = await a.reveal({ target: p, isDir: true })
  if (r && r.ok === false) showToast('打不开：' + (r.error || '未知原因'))
}

async function changeDataDir() {
  const a = window.api
  if (!a?.dataSetDir) return showToast('请在桌面版里使用')
  const dir = await pickFolder('选择软件数据保存位置', dataDir.value)
  if (!dir) return
  if (dir === dataDir.value) return showToast('就是这个目录')
  const ok = window.confirm(
    `把软件数据换到：\n${dir}\n\n资料库条目、设置、Discord 凭据都会一起搬过去，重启管理器后生效。继续？`
  )
  if (!ok) return
  dataBusy.value = true
  try {
    await flushSnapshot()
    const r = await a.dataSetDir({ dir, migrate: true })
    if (!r?.ok) return showToast('切换失败：' + (r?.error || '未知原因'))
    dataDir.value = r.dir || dir
    dataCustom.value = true
    showToast('已切换数据位置，重启管理器后生效')
  } finally {
    dataBusy.value = false
  }
}

async function resetDataDir() {
  const a = window.api
  if (!a?.dataSetDir) return showToast('请在桌面版里使用')
  const ok = window.confirm(`数据位置恢复为默认：\n${dataDefault.value}\n\n重启管理器后生效。继续？`)
  if (!ok) return
  dataBusy.value = true
  try {
    await flushSnapshot()
    const r = await a.dataSetDir({ dir: '', migrate: false })
    if (!r?.ok) return showToast('恢复失败：' + (r?.error || '未知原因'))
    dataDir.value = r.dir || dataDefault.value
    dataCustom.value = false
    showToast('已恢复默认数据位置，重启管理器后生效')
  } finally {
    dataBusy.value = false
  }
}

/* ---------- 扫描下载 ---------- */
const scanBusy = ref(false)

async function chooseScanDir() {
  const dir = await pickFolder('选择要自动扫描的文件夹', store.settings.scanPath)
  if (!dir) return
  store.settings.scanPath = dir
  saveSettings()
  showToast('扫描目录已设为：' + dir)
}

async function scanNow() {
  if (!String(store.settings.scanPath || '').trim()) return showToast('先选一个扫描目录')
  scanBusy.value = true
  try {
    await runAutoScan({ manual: true })
  } finally {
    scanBusy.value = false
  }
}

/* ---------- 检查更新（GitHub Releases） ---------- */
const appVersion = ref('')
const updBusy = ref(false)
const updResult = ref(null) // { ok, configured, hasUpdate, latest, notes, downloadUrl, url, error, hint }

async function refreshAppVersion() {
  const a = window.api
  if (a?.info) {
    const r = await a.info()
    appVersion.value = r?.version || ''
  }
  if (!appVersion.value) appVersion.value = '0.0.0'
}

function updateSource() {
  /* 更新源写死在 lib/update.js，界面不提供改的地方 */
  return { owner: DEFAULT_UPDATE_SOURCE.owner, repo: DEFAULT_UPDATE_SOURCE.repo }
}

async function checkUpdate() {
  if (updBusy.value) return
  updBusy.value = true
  updResult.value = null
  try {
    const { owner, repo } = updateSource()
    const r = await checkForUpdate({
      owner,
      repo,
      current: appVersion.value,
      fetchJson: window.api?.fetchJson
    })
    updResult.value = r
    /* 手动检查的结果也同步给右下角弹窗，两边看到的是同一个版本 */
    if (r && r.ok && r.hasUpdate) {
      store.appUpdate = {
        ...store.appUpdate,
        lastAt: new Date().toISOString(),
        hasUpdate: true,
        latest: r.latest || '',
        current: r.current || appVersion.value,
        notes: r.notes || '',
        url: r.url || '',
        downloadUrl: r.downloadUrl || '',
        downloadName: r.downloadName || '',
        downloadDigest: r.downloadDigest || '',
        downloadSize: Number(r.downloadSize || 0),
        ignored: String(store.settings.ignoredUpdateVersion || '').trim() === String(r.latest || '').trim()
      }
    }
    if (!r.configured) showToast('尚未配置更新源')
    else if (!r.ok) showToast('检查失败：' + (r.error || '未知原因'))
    else if (r.hasUpdate) showToast(`发现新版本 v${r.latest}`)
    else showToast('已是最新版本')
  } finally {
    updBusy.value = false
  }
}

async function openRepo() {
  const a = window.api
  if (a?.openExternal) return a.openExternal(REPO_WEB)
  window.open(REPO_WEB, '_blank')
}

async function openDownload() {
  const url = updResult.value?.downloadUrl || updResult.value?.url
  if (!url) return showToast('这条 Release 没有可用的下载入口')
  const a = window.api
  if (!a?.openExternal) return showToast('请在桌面版里使用')
  await a.openExternal(url)
}
const updNotes = computed(() => {
  const t = String(updResult.value?.notes || '').trim()
  return t.length > 1200 ? t.slice(0, 1200) + '…' : t
})

/* ---------- 下载 / 安装进度：直接读 store.upd，和右下角弹窗共用一份 ---------- */
const upPhase = computed(() => store.upd.phase)
const upPercent = computed(() => store.upd.percent)
const upReceived = computed(() => store.upd.received)
const upTotal = computed(() => store.upd.total)
const upError = computed(() => store.upd.error)

function fmtMB(n) {
  const v = Number(n) || 0
  if (!v) return '—'
  if (v < 1024 * 1024) return (v / 1024).toFixed(0) + ' KB'
  return (v / 1024 / 1024).toFixed(1) + ' MB'
}

/* 面板里点下载时，把本次检查拿到的地址交给 store，两处界面共用同一次下载 */
async function downloadUpdate() {
  const r = updResult.value || {}
  if (r.downloadUrl && store.appUpdate.downloadUrl !== r.downloadUrl) {
    store.appUpdate = {
      ...store.appUpdate,
      hasUpdate: true,
      latest: r.latest || store.appUpdate.latest,
      url: r.url || '',
      downloadUrl: r.downloadUrl,
      downloadName: r.downloadName || '',
      downloadDigest: r.downloadDigest || '',
      downloadSize: Number(r.downloadSize || 0),
      notes: r.notes || '',
      ignored: false
    }
  }
  await startAppUpdate()
}

async function installUpdate() {
  await installAppUpdate()
}

/* 之前点过「忽略本次」想反悔：清掉记住的版本号，下次（或现在）照常提示 */
function resumeUpdatePrompt() {
  store.settings.ignoredUpdateVersion = ''
  saveSettings()
  store.appUpdate = { ...store.appUpdate, ignored: false }
  showToast('已恢复更新提示')
}

/* ---------- 故障记录：崩溃 / 报错日志 ---------- */
const logInfo = ref({ count: 0, latest: null, dir: '' })
const logBusy = ref(false)

async function refreshLogs() {
  const a = window.api
  if (!a?.logList) return
  try {
    const r = await a.logList()
    if (r?.ok) logInfo.value = { count: r.count || 0, latest: r.latest || null, dir: r.dir || '' }
  } catch (_) {}
}

/* 一键复制最近一条报错：粘到聊天里发给开发者定位最快 */
async function copyLatestLog() {
  const a = window.api
  if (!a?.logLatest) return showToast('请在桌面版里使用')
  if (logBusy.value) return
  logBusy.value = true
  try {
    const r = await a.logLatest()
    if (!r?.ok) return showToast(r?.error || '还没有报错记录')
    try {
      await navigator.clipboard.writeText(String(r.text || ''))
      showToast('报错内容已复制')
    } catch (e) {
      showToast('复制失败，请点「打开日志目录」手动取文件')
    }
  } finally {
    logBusy.value = false
  }
}

/* 复制报错文件：把最新那份日志文件本身放进剪贴板，粘到聊天窗口就是一个文件 */
async function copyLogFile() {
  const a = window.api
  if (!a?.logCopyFile) return showToast('请在桌面版里使用')
  if (!logInfo.value.count) return showToast('还没有报错记录')
  if (logBusy.value) return
  logBusy.value = true
  try {
    const r = await a.logCopyFile()
    if (!r?.ok) return showToast(r?.error || '复制失败')
    showToast(r.fallback === 'path' ? '已复制报错文件路径' : '报错文件已复制，可直接粘贴发送')
  } finally {
    logBusy.value = false
  }
}

async function clearLogs() {
  const a = window.api
  if (!a?.logClear) return showToast('请在桌面版里使用')
  if (!logInfo.value.count) return showToast('没有历史报错记录')
  const yes = window.confirm(`将删除 ${logInfo.value.count} 条报错记录，删除后不可恢复。确定清理？`)
  if (!yes) return
  logBusy.value = true
  try {
    const r = await a.logClear()
    if (!r?.ok) return showToast('清理失败：' + (r?.error || '未知原因'))
    showToast(`已清理 ${r.removed || 0} 条报错记录`)
    await refreshLogs()
  } finally {
    logBusy.value = false
  }
}

async function openLogDir() {
  const a = window.api
  if (!a?.logOpenDir) return showToast('请在桌面版里使用')
  const r = await a.logOpenDir()
  if (r && r.ok === false) showToast('打不开日志目录：' + (r.error || '未知原因'))
}

/* 退回上一版：走同一条下载安装链路，装完自动重启 */
async function doRollback() {
  const ok = window.confirm(
    `将退回更新前的版本 v${store.rollback.from}，当前版本会被覆盖安装，本次更新引入的功能会消失。确定退回？`
  )
  if (!ok) return dismissRollback()
  await rollbackAppUpdate()
}

function fmtLogTime(t) {
  if (!t) return ''
  const d = new Date(t)
  if (isNaN(d.getTime())) return String(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

onMounted(() => {
  refreshAppVersion()
  refreshDataDir()
  refreshExt()
  refreshLogs()
  checkRollbackOnStart()
  /* 进度事件全局只在 store 里挂一次，这里不再重复注册 */
  bindUpdProgress()
  if (String(store.settings.tavernPath || '').trim()) {
    Promise.resolve(refreshTavernUrlFromConfig({ silent: true })).catch(() => {})
  }
})

const totalItems = computed(() => {
  const it = store.items || {}
  return ['characters', 'worldbooks', 'presets', 'themes', 'others'].reduce(
    (n, k) => n + (Array.isArray(it[k]) ? it[k].length : 0),
    0
  )
})

function clearAll() {
  if (!totalItems.value) return
  const ok = window.confirm(`将删除资料库里全部 ${totalItems.value} 个条目，不可撤销。确定继续？`)
  if (!ok) return
  clearLibrary()
}

function close() {
  store.settingsPanel.visible = false
}

function addBlack() {
  const v = bl.value.trim()
  if (!v) return
  if (store.settings.blacklist.includes(v)) {
    showToast('已在黑名单中')
    return
  }
  store.settings.blacklist.push(v)
  bl.value = ''
}

function rmBlack(i) {
  store.settings.blacklist.splice(i, 1)
}

function save() {
  saveSettings()
  showToast('设置已保存')
  close()
}

async function browsePath(key) {
  const a = window.api
  if (!a?.pickDir) return showToast('请在桌面版里使用')
  const dir = await a.pickDir({ title: '选择文件夹', defaultPath: store.settings[key] || '' })
  if (!dir) return
  store.settings[key] = Array.isArray(dir) ? dir[0] : dir
  saveSettings()
  showToast('已选择：' + store.settings[key])
}
</script>

<template>
  <div class="mask" @click.self="close">
    <div class="panel">
      <header>
        <h2>设置</h2>
        <button class="x" @click="close">✕</button>
      </header>

      <div class="body">
        <section>
          <h3>酒馆连接</h3>
          <label class="row">
            <span>酒馆安装路径</span>
            <div class="field">
              <input v-model="store.settings.tavernPath" placeholder="例如 D:\SillyTavern" />
              <button class="ghost" @click="browsePath('tavernPath')">浏览</button>
            </div>
          </label>
          <div class="row inline">
            <span>API 地址</span>
            <span class="pathval">
              <b>{{ store.settings.tavernUrl || '待识别' }}</b>
              <button class="ghost tiny" :disabled="apiBusy" @click="detectApiUrl">
                {{ apiBusy ? '识别中…' : '重新识别' }}
              </button>
              <button class="ghost tiny" @click="apiManual = !apiManual">{{ apiManual ? '收起' : '手动填写' }}</button>
            </span>
          </div>
          <label v-if="apiManual" class="row">
            <span>手动指定</span>
            <div class="field">
              <input v-model="store.settings.tavernUrl" placeholder="http://127.0.0.1:8000" @change="saveSettings()" />
            </div>
          </label>
          <label class="row inline">
            <span>启动时自动探测酒馆</span>
            <input type="checkbox" v-model="store.settings.autoDetect" class="sw" />
          </label>
          <div class="row inline">
            <span>酒馆正在使用</span>
            <span class="pathval">
              <b v-if="store.stStatus.inUseFresh">{{ store.stStatus.inUseName || '（未开卡）' }}<template v-if="store.stStatus.inUseVersion"> · {{ /^v/i.test(store.stStatus.inUseVersion) ? store.stStatus.inUseVersion : 'v' + store.stStatus.inUseVersion }}</template></b>
              <b v-else>—</b>
              <span v-if="!store.stStatus.inUseFresh" class="hint">酒馆未上报</span>
            </span>
          </div>
        </section>

        <section>
          <h3>软件数据</h3>
          <div class="row inline">
            <span>数据保存路径</span>
            <span class="pathval">
              {{ dataDir || '读取中…' }}
              <button v-if="dataDir" class="ghost tiny" @click="openFolder(dataDir)">打开</button>
            </span>
          </div>
          <div class="row">
            <span>更改位置</span>
            <div class="field">
              <button class="ghost" :disabled="dataBusy" @click="changeDataDir">选择新文件夹</button>
              <button v-if="dataCustom" class="ghost" :disabled="dataBusy" @click="resetDataDir">恢复默认</button>
            </div>
          </div>
        </section>

        <section data-guide="set-scan">
          <h3>扫描下载</h3>
          <label class="row">
            <span>扫描目录</span>
            <div class="field">
              <input v-model="store.settings.scanPath" placeholder="例如 D:\Downloads" />
              <button class="ghost" @click="chooseScanDir">选择</button>
              <button v-if="store.settings.scanPath" class="ghost" @click="openFolder(store.settings.scanPath)">打开</button>
            </div>
          </label>
          <label class="row inline">
            <span>启动时自动扫描</span>
            <input type="checkbox" v-model="store.settings.scanOnStart" class="sw" />
          </label>
          <label class="row inline">
            <span>包含子文件夹</span>
            <input type="checkbox" v-model="store.settings.scanRecursive" class="sw" />
          </label>
          <div class="row inline">
            <span>立即扫描一次</span>
            <span class="pathval">
              <button class="ghost tiny" :disabled="scanBusy" @click="scanNow">{{ scanBusy ? '扫描中…' : '开始扫描' }}</button>
            </span>
          </div>
        </section>

        <section>
          <h3>更新检查</h3>
          <div class="row block">
            <span>更新黑名单</span>
            <div class="bl-box">
              <div class="bl-add">
                <input v-model="bl" placeholder="条目名或 DC 链接，回车添加" @keyup.enter="addBlack" />
                <button class="ghost" @click="addBlack">添加</button>
              </div>
              <div v-if="store.settings.blacklist.length" class="bl-list">
                <span v-for="(b, i) in store.settings.blacklist" :key="b + i" class="bl-item">
                  {{ b }}
                  <button @click="rmBlack(i)">✕</button>
                </span>
              </div>
            </div>
          </div>
        </section>

        <section>
          <h3>版本更新</h3>
          <div class="row inline">
            <span>当前版本</span>
            <span class="pathval"><b>{{ appVersion || '读取中…' }}</b></span>
          </div>
          <div class="row inline">
            <span>更新仓库</span>
            <span class="pathval">
              <a class="repo-link" :title="REPO_WEB" @click="openRepo">{{ REPO_URL }}</a>
            </span>
          </div>
          <div class="row inline">
            <span>酒馆扩展</span>
            <span class="pathval">
              <b :class="{ need: extNeedUpdate }">{{ extText }}</b>
              <em v-if="extNeedUpdate" class="need-tag">需要更新</em>
              <button class="ghost tiny" :disabled="extBusy || !String(store.settings.tavernPath || '').trim()" @click="injectExt">
                {{ extActionText }}
              </button>
            </span>
          </div>
          <div class="row inline">
            <span>检查最新版本</span>
            <span class="pathval">
              <button class="ghost tiny" :disabled="updBusy" @click="checkUpdate">
                {{ updBusy ? '检查中…' : '立即检查' }}
              </button>
              <button
                v-if="updResult?.hasUpdate && updResult.downloadUrl && upPhase !== 'ready'"
                class="ghost tiny"
                :disabled="upPhase === 'downloading' || upPhase === 'installing'"
                @click="downloadUpdate"
              >
                {{ upPhase === 'downloading' ? ('下载中 ' + upPercent + '%') : '下载并更新' }}
              </button>
              <button
                v-if="upPhase === 'ready'"
                class="tiny upd-cta"
                :disabled="upPhase === 'installing'"
                @click="installUpdate"
              >
                {{ upPhase === 'installing' ? '正在重启安装…' : '重启并安装' }}
              </button>
              <button
                v-if="updResult?.hasUpdate && updResult.downloadUrl && upPhase !== 'downloading'"
                class="ghost tiny"
                :disabled="upPhase === 'installing'"
                @click="openDownload"
              >
                浏览器下载
              </button>
              <button v-if="store.appUpdate.ignored" class="ghost tiny" @click="resumeUpdatePrompt">
                恢复更新提示
              </button>
              <button v-if="store.rollback.suspect" class="ghost tiny" :disabled="store.rollback.busy" @click="doRollback">
                {{ store.rollback.busy ? '处理中…' : '退回 v' + store.rollback.from }}
              </button>
            </span>
          </div>
          <div v-if="updResult" class="upd-box">
            <p v-if="!updResult.configured" class="upd-line warn">
              {{ updResult.error }}<template v-if="updResult.hint">：{{ updResult.hint }}</template>
            </p>
            <p v-else-if="!updResult.ok" class="upd-line warn">检查失败：{{ updResult.error }}</p>
            <template v-else-if="updResult.hasUpdate">
              <p class="upd-line ok">有新版本 v{{ updResult.latest }}</p>
              <p v-if="updResult.publishedAt" class="upd-line dim">发布时间：{{ updResult.publishedAt.slice(0, 10) }}</p>
              <pre v-if="updNotes" class="upd-notes">{{ updNotes }}</pre>
              <p v-else class="upd-line dim">这条 Release 没写更新说明</p>
              <p v-if="updResult.downloadName" class="upd-line dim">下载文件：{{ updResult.downloadName }}</p>
              <div v-if="upPhase === 'downloading'" class="upd-progress">
                <div class="bar"><i :style="{ width: upPercent + '%' }"></i></div>
                <p class="upd-line dim">{{ upPercent }}% · {{ fmtMB(upReceived) }} / {{ fmtMB(upTotal) }}</p>
              </div>
              <p v-else-if="upPhase === 'ready'" class="upd-line ok">
                安装包已就绪（{{ fmtMB(upTotal) }}），点「重启并安装」会自动覆盖安装并重启
              </p>
              <p v-else-if="upPhase === 'installing'" class="upd-line ok">正在退出并安装，完成后会自动重启…</p>
              <p v-if="upError" class="upd-line warn">下载/安装失败：{{ upError }}</p>
            </template>
            <p v-else class="upd-line ok">已是最新版本 {{ updResult.current }}</p>
          </div>
        </section>

        <section>
          <h3>故障记录</h3>
          <div class="row inline">
            <span>历史记录</span>
            <span class="pathval">
              <b>{{ logInfo.count ? logInfo.count + ' 条' : '暂无' }}</b>
              <em v-if="logInfo.latest && logInfo.latest.time" class="dim">
                最近 {{ fmtLogTime(logInfo.latest.time) }}
              </em>
            </span>
          </div>
          <div class="row inline">
            <span>日志目录</span>
            <span class="pathval">
              <a class="repo-link" :title="logInfo.dir || ''" @click="openLogDir">{{ logInfo.dir || '读取中…' }}</a>
            </span>
          </div>
          <p class="hint">
            软件崩溃、主进程报错、渲染进程异常会自动落到上面这个目录；后台每天检查一遍，超过 30 天的记录自动清掉。
          </p>
          <div class="row inline">
            <span>操作</span>
            <span class="pathval">
              <button class="ghost tiny" :disabled="logBusy || !logInfo.count" @click="copyLogFile">复制报错文件</button>
              <button class="ghost tiny" :disabled="logBusy || !logInfo.count" @click="copyLatestLog">复制报错内容</button>
              <button class="ghost tiny" :disabled="logBusy || !logInfo.count" @click="clearLogs">清理历史记录</button>
              <button class="ghost tiny" :disabled="logBusy" @click="openLogDir">打开日志目录</button>
            </span>
          </div>
        </section>

        <section>
          <h3>外观</h3>
          <div class="row inline">
            <span>界面配色</span>
            <span class="pathval seg">
              <button :class="{ on: themeMode === 'auto' }" @click="pickTheme('auto')">跟随系统</button>
              <button :class="{ on: themeMode === 'dark' }" @click="pickTheme('dark')">默认黑</button>
              <button :class="{ on: themeMode === 'light' }" @click="pickTheme('light')">默认白</button>
            </span>
          </div>
          <div class="row block">
            <span>自定义 CSS</span>
            <div class="css-box">
              <textarea
                v-model="cssDraft"
                class="css-area"
                spellcheck="false"
                placeholder="在这里粘贴 CSS，例如：&#10;:root { --accent: #7fc4e8; }&#10;.card { border-radius: 14px !important; }"
              ></textarea>
              <div class="css-ops">
                <button class="primary" :disabled="cssDraft === (store.settings.customCss || '')" @click="applyCss">应用到界面</button>
                <button class="ghost" @click="pickCssFile">导入 CSS 文件</button>
                <button class="ghost" @click="insertTemplate">插入基础模板</button>
                <button class="ghost" :disabled="!cssDraft" @click="clearCss">清空</button>
              </div>
            </div>
          </div>
        </section>

        <section data-guide="set-backup">
          <h3>维护</h3>
          <div class="row inline">
            <span>完整备份</span>
            <span class="pathval">
              把库内全部条目打包成一个压缩包
              <button class="ghost tiny" :disabled="backing" @click="doFullBackup">{{ backing ? backPhase + ' ' + backPct + '%' : '立即备份' }}</button>
            </span>
          </div>
          <div class="row inline">
            <span>资料库条目</span>
            <span class="pathval">
              共 {{ totalItems }} 条
              <button class="ghost tiny" :disabled="!totalItems" @click="clearAll">清空条目</button>
            </span>
          </div>
          <div class="row inline">
            <span>首次使用引导</span>
            <span class="pathval">
              连接酒馆 / 装扩展 / 导入资料 / 日常使用
              <button class="ghost tiny" @click="openFirstRun">重新查看</button>
            </span>
          </div>
        </section>
      </div>

      <footer>
        <span class="state">洛书匣 v1.0.0 · 改动前建议先做一次整库备份</span>
        <div class="btns">
          <button @click="close">取消</button>
          <button class="primary" @click="save">保存</button>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 500;
  background: var(--mask);
  backdrop-filter: blur(3px);
  display: grid;
  place-items: center;
}
.panel {
  width: min(660px, 92vw);
  max-height: 84vh;
  display: flex;
  flex-direction: column;
  background: var(--panel-solid);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}
header {
  display: flex;
  align-items: center;
  padding: 15px 18px 12px;
  border-bottom: 1px solid var(--line-soft);
}
h2 { font-size: 15px; margin: 0; font-weight: 600; }
.x {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--muted);
  font-size: 13px;
  padding: 2px 6px;
}
.x:hover { color: var(--text); background: var(--panel-2); }

.body { padding: 6px 18px 4px; overflow-y: auto; }
.pathval {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-2);
  word-break: break-all;
}
.pathval button.tiny {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 5px;
  border: 1px solid var(--line);
  color: var(--text-2);
}
.pathval button.tiny:hover { color: var(--text); border-color: rgba(212, 162, 76, 0.5); }
.pathval b { font-weight: 600; color: var(--text-3, var(--muted)); }
.pathval b.ok { color: #4ec9a6; }
.pathval em.ver {
  font-style: normal;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--line);
  color: var(--text-3, var(--muted));
}
.pathval b.need { color: #e0a75a; }
.pathval em.need-tag {
  font-style: normal;
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid rgba(224, 167, 90, 0.55);
  color: #e0a75a;
}
a.repo-link {
  color: var(--accent-2);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  word-break: break-all;
}
a.repo-link:hover { color: var(--accent); }
.hint.warn { color: #d9a13b; }
section { padding: 13px 0; border-bottom: 1px solid var(--line-soft); }
section:last-child { border-bottom: none; }
h3 { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--accent-2); letter-spacing: 0.3px; }
.hint { margin: 0 0 10px; font-size: 11.5px; color: var(--muted); line-height: 1.6; }

.row { display: flex; align-items: center; gap: 12px; margin-bottom: 9px; }
.row > span { width: 118px; flex-shrink: 0; font-size: 12.5px; color: var(--text-2); }
.row.inline { justify-content: space-between; }
.row.inline > span { width: auto; }
.field { flex: 1; display: flex; gap: 7px; min-width: 0; }
.field input { flex: 1; min-width: 0; }
input {
  font-family: inherit;
  font-size: 12.5px;
  color: var(--text);
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 6px 9px;
  outline: none;
}
input:focus { border-color: rgba(212, 162, 76, 0.5); }
input[type='checkbox'] { width: 15px; height: 15px; accent-color: #d4a24c; }

.row.block { align-items: flex-start; }
.bl-box { flex: 1; }

/* ---------- 外观区：主题分段按钮 + CSS 编辑框 ---------- */
.pathval.seg { gap: 6px; flex-wrap: wrap; }
.pathval.seg > button {
  font-size: 11.5px;
  padding: 3px 10px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--text-2);
}
.pathval.seg > button.on {
  color: #20180a;
  font-weight: 600;
  border-color: transparent;
  background: linear-gradient(180deg, var(--accent-2), var(--accent));
}
.pathval.seg .dimtext { font-size: 11px; color: var(--muted); }

.css-box { flex: 1; display: flex; flex-direction: column; gap: 8px; }
.link-box { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.link-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-2);
  padding: 5px 8px;
  border: 1px solid var(--line-soft);
  border-radius: 6px;
}
.link-row b { min-width: 56px; color: var(--text); font-weight: 600; }
.link-ops { display: flex; gap: 8px; margin-top: 2px; }
.css-area {
  width: 100%;
  min-height: 168px;
  resize: vertical;
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--text);
  font: 12px/1.6 ui-monospace, Consolas, "Cascadia Mono", monospace;
  outline: none;
  tab-size: 2;
  white-space: pre;
  overflow: auto;
  user-select: text;
}
.css-area:focus { border-color: rgba(212, 162, 76, 0.55); }
.css-area::placeholder { color: var(--muted); }
.css-ops { display: flex; gap: 7px; flex-wrap: wrap; }
.css-ops button { font-size: 12px; padding: 4px 11px; }
.css-ops button[disabled] { opacity: 0.45; cursor: not-allowed; }
.css-box .hint { margin: 0; }
.bl-add { display: flex; gap: 7px; }
.bl-add input { flex: 1; }
.bl-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
.bl-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--text-2);
  background: var(--panel-3);
  border-radius: 6px;
  padding: 3px 5px 3px 8px;
}
.bl-item button {
  background: transparent;
  border: none;
  color: var(--muted);
  font-size: 10px;
  padding: 0 2px;
}
.bl-item button:hover { color: #e08a7c; }

/* 抓取方式 */
.mode-line { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.mode {
  flex: 1; min-width: 210px;
  display: flex; align-items: flex-start; gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--panel-2);
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text-2);
}
.mode.on { border-color: rgba(212, 162, 76, 0.6); background: rgba(212, 162, 76, 0.08); color: var(--text); }
.mode input[type='radio'] { width: 14px; height: 14px; margin-top: 2px; accent-color: #d4a24c; }
.mode span { display: flex; flex-direction: column; gap: 2px; }
.mode em { font-style: normal; font-size: 10.5px; color: var(--muted); }
.sub-box {
  border-left: 2px solid rgba(212, 162, 76, 0.35);
  padding-left: 10px;
  margin-bottom: 4px;
}
.sub-box .hint { margin-top: 4px; }
.sub-tip { font-size: 10.5px; color: var(--muted); }
.test-res {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--accent-2);
  word-break: break-all;
  line-height: 1.6;
}

/* 检查更新结果 */
.upd-box {
  margin-top: 8px;
  padding: 9px 11px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-2);
}
.upd-line { margin: 0 0 5px; font-size: 11.5px; line-height: 1.6; color: var(--text-2); word-break: break-word; }
.upd-line:last-child { margin-bottom: 0; }
.upd-line.ok { color: #4ec9a6; }
.upd-line.warn { color: #d9a441; }
.upd-line.dim { color: var(--muted); }
.upd-notes {
  margin: 6px 0;
  padding: 8px 10px;
  max-height: 180px;
  overflow-y: auto;
  font-family: inherit;
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 6px;
}

footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 18px;
  border-top: 1px solid var(--line-soft);
}
.state { font-size: 12px; color: var(--muted); }
.btns { display: flex; gap: 8px; }
</style>
