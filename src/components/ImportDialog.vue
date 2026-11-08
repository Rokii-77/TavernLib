<script setup>
import { ref, computed } from 'vue'
import { store, showToast, commitImport, tabs, probeDcTitles, listTavernCards, importFromTavern, dcConcurrency, makeImportRowFromPath, sigOfPayload, rowsFromUrls, isFileLink, isPostLink, pruneSamplerPresets, startBgJob, patchBgJob, endBgJob, tavernImportedPaths, autoTagsOfRow } from '../store.js'
import { cleanUrl, cleanText, checkUrl } from '../lib/urlsafe.js'
import { analyzeFiles, defaultVersionName, dateFromPayload } from '../lib/importer.js'
import { detectModel, parsePresetName } from '../lib/preset.js'

const fileInput = ref(null)
const dragOver = ref(false)
const busy = ref(false)

const rows = computed(() => store.importDialog.rows)
/* 弹窗内联进度：与左下角全局气泡共用 store.bgJob 这一份状态 */
const bgJob = computed(() => store.bgJob || {})
const bgPct = computed(() => {
  const total = Number(bgJob.value.total || 0)
  const done = Number(bgJob.value.done || 0)
  if (!total) return 0
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
})
const bgText = computed(() => {
  const total = Number(bgJob.value.total || 0)
  const done = Number(bgJob.value.done || 0)
  const label = bgJob.value.label || '处理中'
  return total ? `${label} ${done}/${total}${bgJob.value.doneAll ? ' · 完成' : ''}` : label
})
/** 列表最多渲染这么多行：几千条时否则光挂 DOM 就够卡了 */
const ROW_CAP = 300
const shownRows = computed(() => (rows.value.length > ROW_CAP ? rows.value.slice(0, ROW_CAP) : rows.value))
const rowsHidden = computed(() => Math.max(0, rows.value.length - ROW_CAP))
const parseState = ref({ done: 0, total: 0, active: false })

/* ---------- 链接导入（DC 临时附件直链 / 帖子链接） ---------- */
const linkInput = ref('')
const linkBusy = ref(false)
const linkResults = ref([])

/** 把后台的技术错误码翻成人话 */
function reasonText(r) {
  const s = String((r && (r.reason || r.error)) || '')
  if (/NEED_LOGIN|\u9700\u8981\u5148/i.test(s) || /\u9700\u8981\u5148/.test(s)) return '需先在管理器里登录一次 Discord'
  if (/TIMEOUT|\u8d85\u65f6/i.test(s)) return '抓取超时，可以再试一次'
  if (/404|EXPIRED|\u5931\u6548|\u5df2\u8fc7\u671f/i.test(s)) return '链接已失效或帖子被删'
  if (/403|DENIED|\u65e0\u6743/i.test(s)) return '没有权限访问该帖子'
  return s || '原因不明'
}
const linkStage = ref('')
const linkNeedLogin = ref(false)
const linkNeedToken = ref(false)

const linkItems = computed(() =>
  linkInput.value
    .split(/\r?\n/)
    .map((s) => cleanText(s).trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^(https?:\/\/\S+)\s*(.*)$/)
      const url = cleanUrl(m ? m[1] : l)
      const ck = checkUrl(url)
      const isFile = ck.ok && isFileLink(ck.url)
      const bad = ck.ok ? '' : ck.error
      return {
        url: ck.ok ? ck.url : url,
        raw: m ? m[1] : l,
        alias: m ? cleanText(m[2] || '').trim() : '',
        bad,
        isFile,
        isPost: ck.ok && !isFile && isPostLink(ck.url)
      }
    })
)
const fileLinks = computed(() => linkItems.value.filter((x) => x.isFile))
const postLinks = computed(() => linkItems.value.filter((x) => x.isPost))
const badLinks = computed(() => linkItems.value.filter((x) => x.bad || (!x.isFile && !x.isPost)))

/** 预览里链接太长会撑破布局，截断显示 */
function shortUrl(s, n = 62) {
  const v = String(s || '')
  return v.length > n ? v.slice(0, n) + '…' : v
}

function apiDc() {
  return !!(window.api && window.api.probeDcMany)
}

/** 导入时会自动打上的标签预览（仅预设分类） */
function autoTagsPreview(r) {
  if (!r || r.error) return []
  if (r.category !== 'presets') return []
  try {
    return autoTagsOfRow(r)
  } catch (_) {
    return []
  }
}

/** Discord 附件 / CDN 直链：链接里带着频道与消息 ID，可以直接反查所在帖子的标题 */
const DC_FILE_RE = /(?:cdn|media)\.discord(?:app)?\.(?:net|com)\/(?:ephemeral-)?attachments\/\d+\/\d+(?:\/|$)/i
function isDcFileLink(url) {
  return DC_FILE_RE.test(String(url || ''))
}

/**
 * 附件链接的比对键：只取 attachments/<频道>/<消息>/<文件名>。
 * 链接经过转义 / 带 query 参数时字面量会变，靠这个键才能把「抓到的标题」对回原来那一行。
 */
function dcFileKey(url) {
  const m = /(?:cdn|media)\.discord(?:app)?\.(?:net|com)\/(?:ephemeral-)?attachments\/(\d+)\/(\d+)\/([^?#\s]+)/i.exec(
    String(url || '')
  )
  return m ? `${m[1]}/${m[2]}/${m[3]}` : ''
}

/**
 * 抓到帖子标题后怎么用：
 * ① 记进来源标题（详情页/更新检查都要用）
 * ② 名称保持导入时解析出来的名字：帖子标题是整串营销语（「神本无相⚖️Gemini/Claude⚖️小说向…」），
 *    顶掉预设名会把条目认成另一个东西，所以标题只做来源记录，绝不覆盖名称
 * ③ 从标题里认模型（标题常写着 [Gemini 2.5 Pro]）；版本名还是文件里解析出来的那个时，
 *    允许用标题里的版本号补一次
 */
function applyTitleToRow(row, title) {
  const t = String(title || '').trim()
  if (!row || !t) return
  row.dcTitle = t
  if (row.category === 'presets') {
    const pv = parsePresetName(t)
    const stem = String(row.fileName || '').replace(/\.[^.]+$/, '')
    const ver = String(row.version || '').trim()
    if ((!ver || ver === stem) && pv && pv.version) row.version = pv.version
    const m = detectModel(t)
    if (!String(row.model || '').trim()) {
      if (m) row.model = m
      else autofillModel(row, t)
    }
  } else if (row.nameAuto !== false) {
    row.name = t
    row.nameAuto = false
  }
}

/**
 * 抓标题：一次调用内自带「没凭据就自动去本机浏览器读一次，再自动重抓」，
 * 全程无需用户再点任何按钮（原来需要手动点「读取凭据并重试」）。
 */
async function probeDcTitlesAuto(urls) {
  const list = Array.isArray(urls) ? urls.filter(Boolean) : []
  if (!list.length) return []
  const fallback = () => list.map((u) => ({ url: u, ok: false, reason: 'PROBE_FAIL' }))
  const first = await probeDcTitles(list).catch(fallback)
  const needToken = (first || []).some(
    (r) => !r.ok && (r.reason === 'NO_TOKEN' || r.reason === 'BAD_TOKEN' || r.needToken)
  )
  if (!needToken || !window.api?.dcTokenAuto) return first
  let picked = false
  try {
    const tr = await window.api.dcTokenAuto()
    picked = !!tr?.ok
  } catch (_) {}
  if (!picked) return first
  linkStage.value = '已自动读到本机 Discord 登录凭据，正在重新抓取标题…'
  return await probeDcTitles(list).catch(() => first)
}

/**
 * 一个按钮完成：文件直链下载解析 + 帖子链接自动配对 DC 链接 + 后台抓标题
 * 点下按钮的瞬间就同时开抓（标题抓取和文件下载并行），不必等下载完
 */
async function addByLinks() {
  const items = linkItems.value
  if (!items.length) return showToast('先把链接粘进来，一行一个')
  if (!window.api?.download) return showToast('请在桌面版里使用')

  const files = fileLinks.value
  const posts = postLinks.value
  const failed = badLinks.value.map((x) => ({ url: x.raw || x.url, reason: x.bad || '既不是文件直链也不是帖子链接' }))
  let added = []

  /* 能反查标题的两种链接：Discord 帖子链接、Discord 附件直链（附件 URL 里带着频道 / 消息 ID） */
  const dcFileUrls = files.map((x) => x.url).filter((u) => isDcFileLink(u))
  const probeUrls = [...posts.map((p) => p.url), ...dcFileUrls.filter((u) => !posts.some((p) => p.url === u))]

  linkBusy.value = true
  linkResults.value = []
  linkNeedLogin.value = false
  const stages = []
  linkStage.value = probeUrls.length
    ? `分两路同时进行：下载 ${files.length} 个直链 / 抓取 ${probeUrls.length} 个帖子标题…`
    : `正在下载并解析 ${files.length} 个文件直链…`

  try {
    // 0) 点下按钮即刻发起标题抓取（与下载并行，不阻塞）：两者都在下载开始前就发起，互不等待
    const probePromise =
      probeUrls.length && apiDc()
        ? probeDcTitlesAuto(probeUrls)
        : Promise.resolve([])

    // 1) 文件直链：下载 → 解析成导入行
    if (files.length) {
      let outcome = { rows: [], failed: [] }
      try {
        outcome = await rowsFromUrls(files.map((x) => x.url))
      } catch (e) {
        showToast('解析失败：' + (e.message || e))
      }
      added = outcome.rows || []
      failed.push(...(outcome.failed || []))

      for (const row of added) {
        const src = files.find((x) => x.url === row.dlUrl)
        if (src?.alias) row.name = src.alias
        if (!row.version) row.version = defaultVersionName(row.category, row.payload, row.fileName)
        if (!row.date) row.date = dateFromPayload(row.category, row.payload)
        if (row.payload && !row.sig) row.sig = sigOfPayload(row.category, row.payload)
      }
      if (added.length) store.importDialog.rows = [...store.importDialog.rows, ...added]
    }
    stages.push(`文件 ${added.length}/${files.length}`)

    // 2) 帖子链接：只配给「还没有 dcUrl」的行（即还没绑定帖子来源的行）
    const all = store.importDialog.rows
    const targets = [
      ...all.filter((r) => added.includes(r)),
      ...all.filter((r) => !added.includes(r))
    ].filter((r) => !r.error && !r.dcUrl)
    if (posts.length) stages.push(`待绑定帖子 ${targets.length} 个`)

    const assigned = []
    for (const p of posts) {
      const t = targets.find((r) => !r.dcUrl)
      if (!t) break
      t.dcUrl = p.url
      if (p.alias) t.name = p.alias
      assigned.push({ post: p, row: t })
    }
    if (posts.length && assigned.length < posts.length) {
      failed.push(...posts.slice(assigned.length).map((p) => ({ url: p.url, reason: '没有可配对的导入文件' })))
    }

    // 3) 收回并行抓取结果并回填
    const probeRaw = await probePromise
    /* 结果回填到哪一行：帖子链接按配对关系找，附件直链按「频道/消息/文件名」键找 */
    const urlKey = (u) => dcFileKey(u) || String(u || '').trim()
    const rowByUrl = new Map()
    for (const a of assigned) if (a && a.post && a.post.url) rowByUrl.set(urlKey(a.post.url), a.row)
    for (const r of added) if (r.dlUrl) rowByUrl.set(urlKey(r.dlUrl), r)
    if (probeUrls.length) {
      const list = (probeRaw || []).map((r, i) => ({
        url: r.url || probeUrls[i] || '',
        ok: !!r.ok,
        title: String(r.title || '').trim(),
        reason: r.reason || r.error || '',
        needLogin: !!r.needLogin,
        needToken: r.reason === 'NO_TOKEN' || r.reason === 'BAD_TOKEN' || !!r.needToken
      }))
      const needToken = list.some((x) => x.needToken)
      linkNeedToken.value = needToken
      linkNeedLogin.value = false
      list.forEach((r) => {
        if (!r.ok || !r.title) return
        applyTitleToRow(rowByUrl.get(urlKey(r.url)), r.title)
      })
      const okCount = list.filter((x) => x.ok).length
      /* 只抓到标题、却没有可下载附件直链的帖子链接：标题照样展示出来，别悄悄丢掉 */
      const titleOnly = list.filter((r) => r.ok && r.title && !rowByUrl.get(urlKey(r.url)))
      if (titleOnly.length) stages.push(`仅抓到标题 ${titleOnly.length} 条`)
      stages.push(`标题 ${okCount}/${list.length}`)
      linkResults.value = [
        ...list.map((r) => ({ ok: r.ok, url: r.url, title: r.title, reason: r.reason })),
        ...failed.map((f) => ({ ok: false, url: f.url, title: '', reason: f.reason }))
      ]
      showToast(
        `已加入 ${added.length} 个文件` +
          `，抓到 ${okCount}/${list.length} 个帖子标题` +
          (titleOnly.length ? `（${titleOnly.length} 条仅抓到标题）` : '') +
          (failed.length ? `，${failed.length} 个没处理` : '') +
          (linkNeedToken.value ? '，抓标题需要先把本机浏览器的 Discord 登录凭据读过来' : '') +
          (linkNeedLogin.value ? '，需先在管理器里登录一次 Discord' : '')
      )
    } else {
      linkResults.value = [
        ...added.map((r) => ({ ok: true, url: r.dlUrl || '', title: r.name || r.fileName, reason: '' })),
        ...failed.map((f) => ({ ok: false, url: f.url, title: '', reason: f.reason }))
      ]
      showToast(
        added.length
          ? `已加入 ${added.length} 个` + (failed.length ? `，${failed.length} 个没处理` : '')
          : `没解析出可导入的内容：${failed[0]?.reason || '链接可能已过期'}`
      )
    }
  } finally {
    linkBusy.value = false
    linkStage.value = ''
  }
}

/* 抓标题只用账号凭据静默直连：没凭据时一键从本机浏览器读一次（不弹任何窗口） */
async function autoGrabToken() {
  if (!window.api?.dcTokenAuto) return showToast('请在桌面版里使用')
  linkBusy.value = true
  linkStage.value = '正在从本机浏览器读 Discord 登录凭据…'
  try {
    const r = await window.api.dcTokenAuto()
    if (r?.ok) {
      showToast('已读到登录凭据，正在重试抓标题')
      await retryTitles()
    } else {
      showToast('没读到凭据：' + (r?.error || '请确认本机浏览器登录过 Discord'))
    }
  } finally {
    linkBusy.value = false
    linkStage.value = ''
  }
}

async function retryTitles() {
  /* 待抓标题的行：有帖子链接的用帖子链接；只贴了附件直链的用附件链接反查（URL 里带着频道/消息 ID） */
  const rows = store.importDialog.rows.filter((r) => !r.error && !r.dcTitle && (r.dcUrl || isDcFileLink(r.dlUrl)))
  if (!rows.length) return showToast('没有待抓标题的帖子')
  if (!apiDc()) return showToast('请在桌面版里使用')
  const urlOf = (r) => r.dcUrl || r.dlUrl || ''
  linkBusy.value = true
  linkStage.value = `正在后台抓取 ${rows.length} 个帖子标题…`
  try {
    const res = await probeDcTitlesAuto(rows.map(urlOf))
    let ok = 0
    let needLogin = false
    let needToken = false
    res.forEach((r, i) => {
      if (r.needLogin) needLogin = true
      if (r.reason === 'NO_TOKEN' || r.reason === 'BAD_TOKEN' || r.needToken) needToken = true
      const t = String(r.title || '').trim()
      if (r.ok && t) {
        applyTitleToRow(rows[i], t)
        ok++
      }
    })
    linkNeedToken.value = needToken
    linkNeedLogin.value = false
    linkResults.value = res.map((r, i) => ({
      ok: !!r.ok,
      url: urlOf(rows[i] || {}) || '',
      title: String(r.title || '').trim(),
      reason: r.reason || r.error || ''
    }))
    showToast(
      `抓到 ${ok}/${res.length} 个标题` +
        (linkNeedToken.value ? '，需要先读取本机浏览器的 Discord 登录凭据' : '')
    )
  } finally {
    linkBusy.value = false
    linkStage.value = ''
  }
}

/* ---------- 导入前补抓来源标题（气泡进度 + 自动回填） ---------- */

/**
 * 单行：在「来源链接」里填好 DC 链接后（失焦 / 回车）立刻抓这条链接的标题，
 * 过程放在气泡进度里，抓到的标题直接回填到该行（详情页、检查更新都要用这个标题）。
 */
async function grabTitleOfRow(row) {
  const url = String((row && row.dcUrl) || '').trim()
  if (!row || row.error || !url) return
  if (!isPostLink(url) && !isDcFileLink(url)) return
  /* 同一链接已经抓过就不重复抓；换了链接就重抓并覆盖旧标题 */
  if (row.dcTitle && row.dcTitleUrl === url) return
  if (!apiDc()) return showToast('请在桌面版里使用')
  const prev = row.dcTitle || ''
  /* label 只给名字，数字由进度组件拼成「抓取来源标题 1/1」，避免出现两组数字 */
  startBgJob('抓取来源标题', 1)
  patchBgJob({ done: 0 })
  try {
    const res = await probeDcTitlesAuto([url])
    const r = (res && res[0]) || {}
    const t = String(r.title || '').trim()
    if (r.ok && t) {
      applyTitleToRow(row, t)
      row.dcTitleUrl = url
      patchBgJob({ label: '已回填来源标题', done: 1, total: 1 })
      showToast('已回填标题：' + t)
    } else {
      if (prev) row.dcTitle = prev
      patchBgJob({ done: 1, total: 1 })
      showToast('没抓到标题：' + reasonText(r))
    }
  } finally {
    endBgJob()
  }
}

/**
 * 批量：点「导入」时，把填了来源链接但还没抓到标题的行统一补抓一遍，
 * 抓取进度走气泡，抓完再真正执行导入，标题随条目一起存进资料库。
 */
const TITLE_CHUNK = 6
async function grabTitlesBeforeImport(batch) {
  const todo = (batch || []).filter((r) => !r.error && !r.dcTitle && (r.dcUrl || isDcFileLink(r.dlUrl)))
  if (!todo.length || !apiDc()) return 0
  const total = todo.length
  let ok = 0
  let done = 0
  startBgJob('抓取来源标题', total)
  try {
    for (let i = 0; i < total; i += TITLE_CHUNK) {
      const part = todo.slice(i, i + TITLE_CHUNK)
      const res = await probeDcTitlesAuto(part.map((r) => r.dcUrl || r.dlUrl || ''))
      /* 一批内部也逐条推进，这样「3/5」会一跳一跳地走，不会一批只动一次 */
      ;(res || []).forEach((r, k) => {
        const t = String((r && r.title) || '').trim()
        if (r && r.ok && t && part[k]) {
          applyTitleToRow(part[k], t)
          ok++
        }
        done++
        patchBgJob({ label: '抓取来源标题', done: Math.min(done, total), total })
      })
      if ((res || []).length < part.length) {
        done = Math.min(total, i + part.length)
        patchBgJob({ label: '抓取来源标题', done, total })
      }
    }
  } catch (_) {
  } finally {
    endBgJob()
  }
  return ok
}

/* ---------- 文件 ---------- */

function pickFiles() {
  fileInput.value?.click()
}

const LIST_CHUNK = 4

/**
 * 预设自动抓模型：从文件名 + DC 帖子标题里认一遍常见酒馆模型，填进模型字段（可手动改）。
 * 已经有值就不覆盖，避免把用户手填的内容冲掉。
 */
function autofillModel(r, extraText = '') {
  if (!r || r.category !== 'presets') return
  if (String(r.model || '').trim()) return
  r.model = detectModel([r.fileName, r.name, r.remark, extraText, r.dcTitle].filter(Boolean).join(' '))
}

/** 用户在表格里把分类改成「预设」时，也顺手抓一次模型 */
function onCatChange(r) {
  autofillModel(r)
}

/**
 * 后台静默分批解析：每 4 个文件让出主线程一次，解析到一批就先挂进列表，
 * 界面全程可滚动、可编辑、可继续拖文件（不再像以前那样一次卡到全部解析完）。
 */
async function handleFiles(fileList) {
  const list = Array.from(fileList || [])
  if (!list.length) return
  busy.value = true
  parseState.value = { done: 0, total: list.length, active: true }
  try {
    await analyzeFiles(list, {
      chunk: LIST_CHUNK,
      onProgress: (p) => {
        parseState.value = { done: p.done, total: p.total, active: p.done < p.total }
      }
    }).then((res) => {
      // 统一补默认版本名 / 日期 / 内容签名（这一步很快，一次做完避免中途半成品）
      for (const r of res) {
        if (!r.version) r.version = defaultVersionName(r.category, r.payload, r.fileName)
        if (!r.date) r.date = dateFromPayload(r.category, r.payload)
        r.sig = r.payload ? sigOfPayload(r.category, r.payload) : ''
        // 预设：按文件名先抓一遍模型（有 DC 标题的话后面抓到标题会再补一次）
        if (r.category === 'presets') autofillModel(r)
      }
      store.importDialog.rows = [...store.importDialog.rows, ...res]
    })
  } catch (e) {
    showToast('解析失败：' + (e.message || e))
  } finally {
    busy.value = false
    parseState.value = { ...parseState.value, active: false }
  }
}

function onFileChange(e) {
  handleFiles(e.target.files)
  e.target.value = ''
}

function onDrop(e) {
  dragOver.value = false
  handleFiles(e.dataTransfer.files)
}

function removeRow(i) {
  store.importDialog.rows.splice(i, 1)
}

function catLabel(key) {
  return tabs.find((t) => t.key === key)?.label || '其他'
}

const validRows = computed(() => rows.value.filter((r) => !r.error && !r.demo))
const errorRows = computed(() => rows.value.filter((r) => r.error))
/** 正在导入：抓标题 + 写入期间窗口不关，按钮置灰防重复点 */
const importing = ref(false)

/**
 * 点「确定导入」：立刻收掉所有弹窗，整段工作（补抓标题 → 写入资料库）都放到气泡里跑，
 * 界面上不再挂着进度条，用户该干别的就干别的。
 */
async function doImport() {
  if (importing.value) return
  if (!validRows.value.length) {
    showToast('没有可导入的条目')
    return
  }
  const batch = validRows.value
  for (const r of batch) {
    if (r.payload && !r.sig) r.sig = sigOfPayload(r.category, r.payload)
  }
  const total = batch.length
  importing.value = true
  hideDialog()
  try {
    /* ① 还有没抓到标题的来源链接：先补一遍（气泡显示进度） */
    await grabTitlesBeforeImport(batch)

    /* ② 写入资料库：气泡显示写入进度，小批量逐条刷新、大批量每 40 条刷新一次 */
    startBgJob('导入资料', total)
    try {
      const r = await commitImport(batch, {
        chunk: total <= 200 ? 1 : 40,
        onProgress: (p) => patchBgJob({ done: p.done, total: p.total })
      })
      const names = (r.dupNames || []).slice(0, 3).join('、')
      patchBgJob({ label: '导入完成', done: total, total })
      showToast(
        r.dup
          ? `该版本已存在，已跳过 ${r.dup} 项${names ? `：${names}${r.dup > 3 ? ' 等' : ''}` : ''}；新增 ${r.created} 项`
          : `导入完成：新增 ${r.created} 项，并入已有 ${r.merged} 项`
      )
    } catch (e) {
      showToast('导入失败：' + (e.message || e))
    } finally {
      endBgJob()
    }
  } finally {
    importing.value = false
    store.importDialog.rows = []
  }
}

/** 只收界面不清数据：后台还要接着用这一段行，等准备完再重新弹出来 */
function hideDialog() {
  store.importDialog.visible = false
}

function close() {
  store.importDialog.visible = false
  store.importDialog.rows = []
}

/* ---------- 从酒馆直接导入 ---------- */

const stOpen = ref(false)
const stAll = ref([])
const stPick = ref([])
const stQuery = ref('')
const stType = ref('characters')
const stHiddenCount = ref(0)
/** 被「隐藏已导入」过滤掉的条数，只用于提示 */
const stImportedCount = ref(0)
const stShowSampler = ref(false)

const ST_TYPES = [
  { key: 'characters', label: '角色卡' },
  { key: 'presets', label: '预设' },
  { key: 'worldbooks', label: '世界书' },
  { key: 'themes', label: '美化' }
]

const stShown = computed(() => {
  const q = stQuery.value.trim().toLowerCase()
  if (!q) return stAll.value
  return stAll.value.filter((c) => String((c.avatar || '') + (c.name || '') + (c.file || '')).toLowerCase().includes(q))
})

/**
 * 每个类型单独缓存扫描结果：打开面板立刻可见，切类型先出缓存、后台再补扫，
 * 不再「等角色卡全扫完才能点别的类型」。已导入过的条目默认不列出来，列表更干净。
 */
const stCache = {}
const stLoadingType = ref('')
const stHideImported = ref(true)
let stToken = 0

const stKey = (type) => (type === 'presets' && stShowSampler.value ? 'presets+sampler' : type)

function applyStList(r) {
  const imported = stHideImported.value ? tavernImportedPaths() : null
  const list = r?.list || []
  stAll.value = list
    .filter((c) => !imported || !imported.has(String(c.path || '').toLowerCase()))
    .map((c) => ({
      ...c,
      mtimeText: c.mtime ? new Date(c.mtime).toLocaleDateString('zh-CN') : ''
    }))
  stHiddenCount.value = r?.hidden || 0
  stImportedCount.value = imported ? Math.max(0, list.length - stAll.value.length) : 0
}

async function openStPicker() {
  if (!window.api?.stScanCharacters) return showToast('请在桌面版里使用')
  stOpen.value = true
  // 不 await：面板先出来，扫描在后台跑，期间随时能切类型
  loadStList(stType.value || 'characters')
}

async function loadStList(type, keepShowSampler, force) {
  stType.value = type
  stPick.value = []
  if (!keepShowSampler) stShowSampler.value = false
  const key = stKey(type)
  const cached = stCache[key]
  if (cached && !force) {
    applyStList(cached)
    return
  }
  const my = ++stToken
  stLoadingType.value = type
  stAll.value = []
  const r = await listTavernCards(type, type === 'presets' ? { includeSamplerPresets: stShowSampler.value } : {})
  // 扫描期间用户又切了类型：这份结果只管进缓存，不动当前面板
  if (!r?.ok) {
    if (my === stToken) {
      stLoadingType.value = ''
      stAll.value = []
      showToast('读不到酒馆数据：' + (r?.error || '未知原因'))
    }
    return
  }
  stCache[key] = r
  if (my !== stToken) return
  stLoadingType.value = ''
  applyStList(r)
}

/** 手动重扫当前类型（缓存会命中，所以要有这个入口） */
async function rescanSt() {
  await loadStList(stType.value, true, true)
}

function toggleHideImported() {
  stHideImported.value = !stHideImported.value
  applyStList(stCache[stKey(stType.value)])
}

/** 清理资料库里已经导入进来的纯采样参数预设条目 */
async function pruneImported() {
  const r = await pruneSamplerPresets()
  if (!r?.ok) return showToast('清理失败：' + (r?.error || '未知原因'))
  if (!r.removed) return showToast('资料库里没有这类条目')
  showToast(`已从资料库移除 ${r.removed} 个采样参数预设`)
}

/** 显示 / 隐藏酒馆自带的纯采样参数预设（NovelAI、KoboldAI、TextGen 等引擎目录） */
async function toggleSamplerPresets() {
  stShowSampler.value = !stShowSampler.value
  await loadStList('presets', true)
}

function togglePick(c) {
  const i = stPick.value.findIndex((x) => x.path === c.path)
  if (i >= 0) stPick.value.splice(i, 1)
  else stPick.value.push(c)
}

const isPicked = (c) => stPick.value.some((x) => x.path === c.path)
const stAllPicked = computed(() => stShown.value.length > 0 && stShown.value.every((c) => isPicked(c)))

/* 全选/取消全选（当前列表已选满时再点就是取消） */
function pickAll() {
  stPick.value = stAllPicked.value ? [] : [...stShown.value]
}

/**
 * 点「加入导入列表」：
 * ① 立刻收掉界面上所有弹窗（导入框 + 酒馆选择框），把选中的东西交给气泡后台准备
 * ② 后台跑解析 + 抓来源标题（气泡里显示进度，界面不挡着）
 * ③ 准备完再把导入列表弹回来，用户核对后点「确定导入」
 */
async function confirmStImport() {
  if (!stPick.value.length) return showToast('先选几个要导入的')
  const chosen = [...stPick.value]
  stPick.value = []
  stOpen.value = false
  hideDialog()
  try {
    await importFromTavern(chosen, { silent: true, forceJob: true })
    /* 解析完顺手把来源链接的标题补齐，省得用户还要再点一次重试 */
    await grabTitlesBeforeImport(validRows.value)
  } catch (e) {
    showToast('准备失败：' + (e.message || e))
  }
  /* 加载完了再弹回来：这次让用户点「确定导入」 */
  store.importDialog.visible = true
}
</script>

<template>
  <div class="mask" @click.self="close">
    <div class="dialog">
      <header>
        <h2>导入</h2>
        <button class="x" @click="close">✕</button>
      </header>

      <!-- 链接导入 -->
      <div class="dc-box" data-guide="import-link">
        <div class="dc-head">
          <span class="dc-title">通过链接导入</span>
        </div>
        <textarea
          v-model="linkInput"
          rows="3"
          placeholder="一行一条：文件直链或 DC 帖子链接"
        ></textarea>
        <div class="dc-ops">
          <button class="small primary" :disabled="linkBusy || !linkItems.length" @click="addByLinks">
            {{ linkBusy ? '处理中…' : `导入 ${linkItems.length}` }}
          </button>
          <span class="dc-cnt">
            {{ linkBusy ? linkStage : `直链 ${fileLinks.length} 条 / 帖子 ${postLinks.length} 条` }}
          </span>
        </div>

        <!-- 抓标题 / 导入的实时进度：直接贴在弹窗里，不用去角落找全局气泡 -->
        <div v-if="bgJob.active" class="bg-inline" :class="{ done: bgJob.doneAll }">
          <span class="bi-txt">{{ bgText }}</span>
          <span class="bi-pct">{{ bgPct }}%</span>
          <span class="bi-bar"><i :style="{ width: bgPct + '%' }"></i></span>
        </div>

        <!-- 识别预览：直链和帖子分开列，避免混错位置 -->
        <div v-if="linkItems.length && !linkBusy" class="split">
          <div class="split-col">
            <div class="split-h">下载直链 {{ fileLinks.length }} 条</div>
            <div v-for="(x, i) in fileLinks.slice(0, 4)" :key="'f' + i" class="split-row ok">
              <span class="dot"></span>{{ shortUrl(x.url) }}
            </div>
            <div v-if="fileLinks.length > 4" class="split-more">还有 {{ fileLinks.length - 4 }} 条</div>
            <div v-if="!fileLinks.length" class="split-none">无</div>
          </div>
          <div class="split-col">
            <div class="split-h">帖子链接 {{ postLinks.length }} 条</div>
            <div v-for="(x, i) in postLinks.slice(0, 4)" :key="'p' + i" class="split-row ok">
              <span class="dot"></span>{{ shortUrl(x.url) }}
            </div>
            <div v-if="postLinks.length > 4" class="split-more">还有 {{ postLinks.length - 4 }} 条</div>
            <div v-if="!postLinks.length" class="split-none">无</div>
          </div>
          <div v-if="badLinks.length" class="split-col bad-col">
            <div class="split-h">无法识别 {{ badLinks.length }} 条</div>
            <div v-for="(x, i) in badLinks.slice(0, 3)" :key="'b' + i" class="split-row bad" :title="x.bad || '既不是文件直链也不是帖子链接'">
              <span class="dot"></span>{{ shortUrl(x.raw || x.url) }}
            </div>
          </div>
        </div>

        <div v-if="linkNeedToken || linkNeedLogin" class="dc-tip">
          <span>需要 Discord 登录凭据</span>
          <button class="tiny" :disabled="linkBusy" @click="autoGrabToken">从本机浏览器读取凭据</button>
          <button class="tiny" :disabled="linkBusy" @click="retryTitles">重试抓标题</button>
        </div>
        <div v-if="linkResults.length" class="dc-res">
          <div v-for="(r, i) in linkResults" :key="i" class="dc-res-row">
            <span class="idx">{{ i + 1 }}</span>
            <span class="tt" :class="{ bad: !r.ok }">{{ r.ok ? r.title : '失败：' + reasonText(r) }}</span>
          </div>
        </div>
      </div>

      <div
        data-guide="import-file"
        class="drop"
        :class="{ over: dragOver }"
        @dragover.prevent="dragOver = true"
        @dragleave.prevent="dragOver = false"
        @drop.prevent="onDrop"
        @click="pickFiles"
      >
        <input ref="fileInput" type="file" multiple accept=".png,.json,.zip,.charx,.byaf,.css" @change="onFileChange" hidden />
        <div class="drop-inner">
          <div class="ico">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" />
              <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
            </svg>
          </div>
          <p>拖入文件，或点击选择</p>
        </div>
      </div>

      <div class="st-line" data-guide="import-st">
        <button class="small" @click="openStPicker">从酒馆直接导入</button>
      </div>

      <div v-if="rows.length" class="table">
        <div class="t-head">
          <span class="c-thumb"></span>
          <span class="c-file">文件</span>
          <span class="c-cat">分类</span>
          <span class="c-name">名称</span>
          <span class="c-ver">版本名</span>
          <span class="c-note">备注</span>
          <span class="c-dc">来源链接</span>
          <span class="c-del"></span>
        </div>
        <div class="t-body">
          <div v-for="(r, i) in shownRows" :key="i" class="t-row" :class="{ bad: r.error }">
            <span class="c-thumb">
              <img v-if="r.cover" :src="r.cover" alt="" />
              <span v-else class="ph">{{ (r.name || '?').slice(0, 1) }}</span>
            </span>
            <span class="c-file">
              <b>{{ r.fileName }}</b>
              <em v-if="r.error">{{ r.error }}</em>
              <em v-else>
                {{ r.size ? (r.size / 1024).toFixed(0) + ' KB' : '' }}
                <template v-if="r.source === 'zip'"> · 来自备份包</template>
                <template v-else-if="r.source === 'scan'"> · 来自扫描</template>
                <template v-else-if="r.source === 'st'"> · 来自酒馆</template>
                <template v-else-if="r.source === 'dc'"> · 来自链接</template>
                <template v-if="r.srcPath"> · {{ r.srcPath }}</template>
              </em>
            </span>
            <span class="c-cat">
              <select v-model="r.category" :disabled="!!r.error" @change="onCatChange(r)">
                <option v-for="t in tabs" :key="t.key" :value="t.key">{{ t.label }}</option>
              </select>
            </span>
            <span class="c-name">
              <input v-model="r.name" :disabled="!!r.error" @input="r.nameAuto = false" />
              <!-- 预设：模型名自动识别后可改；导入后显示在卡片备注下方 -->
              <input
                v-if="r.category === 'presets'"
                v-model="r.model"
                class="model-in"
                :disabled="!!r.error"
                placeholder="模型"
              />
              <!-- 导入时会自动带上的标签：卡片自带词条 + 预设识别到的模型名（此处只预览，保存后可在书架上改） -->
              <span
                v-if="autoTagsPreview(r).length"
                class="auto-tags"
                :title="'导入后自动打标签：' + autoTagsPreview(r).join('、')"
              >
                <label>标签</label>
                <em v-for="t in autoTagsPreview(r).slice(0, 4)" :key="t">{{ t }}</em>
              </span>
            </span>
            <span class="c-ver"><input v-model="r.version" :disabled="!!r.error" placeholder="版本名" /></span>
            <span class="c-note">
              <input v-model="r.remark" :disabled="!!r.error" placeholder="备注" />
            </span>
            <span class="c-dc" :data-guide="i === 0 ? 'import-dc' : null">
              <input
                v-model="r.dcUrl"
                :disabled="!!r.error"
                placeholder="来源链接"
                class="uri"
                @change="grabTitleOfRow(r)"
              />
              <em v-if="r.dcTitle">{{ r.dcTitle }}</em>
              <em v-else-if="r.dlUrl" class="dl">直链下载 · {{ r.dlUrl.length > 46 ? r.dlUrl.slice(0, 46) + '…' : r.dlUrl }}</em>
            </span>
            <span class="c-del"><button class="ghost" @click="removeRow(i)">✕</button></span>
          </div>
          <div v-if="rowsHidden" class="t-more">还有 {{ rowsHidden }} 项未显示</div>
        </div>
      </div>

      <footer>
        <span class="state">
          <template v-if="busy">
            {{ parseState.done }}/{{ parseState.total }} 已解析
          </template>
          <template v-else-if="rows.length">
            可导入 {{ validRows.length }} 项<template v-if="errorRows.length">，{{ errorRows.length }} 项无法识别</template>
          </template>
          <template v-else>等待选择文件</template>
        </span>
        <div class="btns">
          <button @click="close">取消</button>
          <button class="primary" :disabled="!validRows.length || busy" @click="doImport">
            确定导入 {{ validRows.length || '' }} 项
          </button>
        </div>
      </footer>
    </div>

    <!-- 酒馆导入：先选分类 -->
    <div v-if="stOpen" class="mask2" @click.self="stOpen = false">
      <div class="picker">
        <div class="pk-head">
          <h3>从酒馆导入</h3>
          <div class="pk-types">
            <button
              v-for="t in ST_TYPES"
              :key="t.key"
              class="small"
              :class="{ on: stType === t.key }"
              @click="loadStList(t.key)"
            >
              {{ t.label }}
            </button>
          </div>
          <input v-model="stQuery" class="search" placeholder="搜索名称" />
          <button
            class="small"
            :class="{ on: stHideImported }"
            title="资料库里已经有的条目不再列出来"
            @click="toggleHideImported"
          >
            {{ stHideImported ? '已隐藏导入过的' : '显示全部' }}
          </button>
          <button class="small" @click="rescanSt" :disabled="!!stLoadingType">重新扫描</button>
          <button class="x" @click="stOpen = false">✕</button>
        </div>
        <div v-if="stType === 'worldbooks' || stType === 'presets'" class="pk-note">
          <template v-if="stType === 'presets'">
            <button
              class="small"
              style="margin-left: 8px"
              :title="stHiddenCount ? `已屏蔽 ${stHiddenCount} 个纯采样参数文件` : ''"
              @click="toggleSamplerPresets"
            >
              {{ stShowSampler ? '隐藏采样参数文件' : '显示采样参数文件' }}
            </button>
            <button class="small" style="margin-left: 6px" @click="pruneImported">清掉资料库里已导入的这类条目</button>
          </template>
        </div>
        <div class="pk-body">
          <div v-if="stLoadingType === stType && !stShown.length" class="pk-tip">正在读取{{ ST_TYPES.find((t) => t.key === stType)?.label }}…</div>
          <div v-else-if="!stShown.length" class="pk-tip">
            <template v-if="stType === 'worldbooks'">没有未绑定的世界书</template>
            <template v-else-if="stImportedCount">都导入过了，已隐藏 {{ stImportedCount }} 项</template>
            <template v-else>没找到，先在设置里确认酒馆目录</template>
          </div>
          <div
            v-for="c in stShown"
            :key="c.path"
            class="pk-row"
            :class="{ on: isPicked(c) }"
            @click="togglePick(c)"
          >
            <span class="tick" :class="{ on: isPicked(c) }"></span>
            <span class="pk-name">{{ c.name || c.avatar || c.file }}</span>
            <span class="pk-meta">{{ c.engine || c.avatar || c.file }}<template v-if="c.cssLen">｜{{ c.cssLen }} 字</template></span>
            <span class="pk-meta">{{ c.mtimeText || '' }}</span>
          </div>
        </div>
        <div class="pk-foot">
          <div class="pk-left">
            <button class="small" @click="pickAll" :disabled="!stShown.length">
              {{ stAllPicked ? '取消全选' : '全选' }}
            </button>
            <span class="state">已选 {{ stPick.length }} 个</span>
          </div>
          <div class="btns">
            <button @click="stOpen = false">取消</button>
            <button class="primary" :disabled="!stPick.length" @click="confirmStImport">加入导入列表</button>
          </div>
        </div>
      </div>
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
.dialog {
  width: min(1000px, 94vw);
  max-height: 88vh;
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
  align-items: baseline;
  gap: 12px;
  padding: 15px 18px 12px;
  border-bottom: 1px solid var(--line-soft);
}
h2 { font-size: 15px; margin: 0; font-weight: 600; }
.sub { font-size: 11.5px; color: var(--muted); }
.x {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--muted);
  font-size: 13px;
  padding: 2px 6px;
}
.x:hover { color: var(--text); background: var(--panel-2); }

/* DC 区 */
.dc-box {
  margin: 12px 18px 0;
  padding: 11px 12px;
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.015);
}
.dc-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 7px; }
.dc-title { font-size: 12.5px; color: var(--text-2); font-weight: 500; }
.dc-hint { font-size: 11px; color: #5f6875; }
.dc-box textarea {
  width: 100%;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text);
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 7px 9px;
  outline: none;
  resize: vertical;
}
.dc-box textarea:focus { border-color: rgba(212, 162, 76, 0.5); }
.dc-ops { display: flex; align-items: center; gap: 12px; margin-top: 7px; }
.bg-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 7px;
  padding: 6px 9px;
  border-radius: 8px;
  background: rgba(212, 162, 76, 0.07);
  border: 1px solid rgba(212, 162, 76, 0.28);
  font-size: 12px;
}
.bg-inline.done { border-color: rgba(212, 162, 76, 0.55); }
.bg-inline .bi-txt { color: var(--text); flex-shrink: 0; }
.bg-inline .bi-pct { color: var(--accent-2); margin-left: auto; font-variant-numeric: tabular-nums; }
.bg-inline .bi-bar {
  width: 96px;
  height: 4px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.1);
  overflow: hidden;
  flex-shrink: 0;
}
.bg-inline .bi-bar i {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--accent-2);
  transition: width 0.18s ease;
}
.dc-cnt { font-size: 11px; color: #5f6875; }

/* 链接识别预览 */
.split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 8px;
}
.split-col {
  border: 1px solid var(--line-soft);
  border-radius: 8px;
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.014);
  min-width: 0;
}
.split-col.bad-col { grid-column: 1 / -1; border-color: rgba(208, 118, 106, 0.35); }
.split-h { font-size: 11px; color: var(--text-2); margin-bottom: 4px; }
.split-h em { font-style: normal; color: #5f6875; font-size: 10.5px; }
.split-row {
  display: flex; align-items: center; gap: 6px;
  font-size: 10.5px; color: var(--muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  line-height: 1.7;
}
.split-row .dot { width: 5px; height: 5px; border-radius: 50%; background: #4a8f6a; flex-shrink: 0; }
.split-row.bad .dot { background: #d0766a; }
.split-more, .split-none { font-size: 10.5px; color: #4f5864; margin-top: 2px; }
.c-dc em.dl { color: #5f6875; }
.small { font-size: 12px; padding: 4px 11px; }
.chk {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11.5px; color: var(--muted); cursor: pointer;
}
.chk input { accent-color: var(--accent-2); }
.dc-tip {
  margin-top: 8px; padding: 6px 9px; border-radius: 6px; font-size: 11px; color: #d7b06a;
  background: rgba(212, 162, 76, 0.09); border: 1px solid rgba(212, 162, 76, 0.28);
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
.dc-tip span { flex: 1; min-width: 160px; }
.dc-res { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; max-height: 112px; overflow-y: auto; }
.dc-res-row { display: flex; align-items: center; gap: 9px; font-size: 11.5px; }
.dc-res-row .idx { color: #5f6875; width: 16px; flex-shrink: 0; }
.dc-res-row .tt {
  flex: 1; min-width: 0; color: var(--text-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dc-res-row .tt.bad { color: #d0766a; }
.tiny { font-size: 10.5px; padding: 2px 7px; }

.drop {
  margin: 12px 18px;
  border: 1.5px dashed #39414d;
  border-radius: 12px;
  padding: 14px;
  text-align: center;
  cursor: pointer;
  transition: all 0.16s ease;
}
.drop:hover, .drop.over {
  border-color: rgba(212, 162, 76, 0.75);
  background: rgba(212, 162, 76, 0.05);
}
.drop-inner .ico { color: var(--accent); display: flex; justify-content: center; margin-bottom: 4px; }
.drop-inner p { margin: 0 0 2px; font-size: 12.5px; color: var(--text-2); }
.drop-inner span { font-size: 11px; color: var(--muted); }

.st-line { margin: 0 18px 10px; display: flex; align-items: center; gap: 10px; }

.table {
  margin: 0 18px;
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.t-head, .t-row {
  display: grid;
  grid-template-columns: 42px 1.2fr 86px 0.95fr 0.7fr 1.2fr 1.15fr 34px;
  gap: 9px;
  align-items: center;
  padding: 8px 12px;
}
.t-head {
  font-size: 11.5px;
  color: #5f6875;
  background: rgba(255, 255, 255, 0.02);
  border-bottom: 1px solid var(--line-soft);
}
.t-body { overflow-y: auto; }
.t-row { border-bottom: 1px solid var(--line-soft); font-size: 12.5px; }
.t-more {
  padding: 9px 12px;
  font-size: 11.5px;
  color: var(--muted);
  text-align: center;
  border-top: 1px solid var(--line-soft);
}
.t-row:last-child { border-bottom: none; }
.t-row.bad { opacity: 0.72; }

.c-thumb img, .c-thumb .ph {
  width: 32px;
  height: 38px;
  border-radius: 5px;
  object-fit: cover;
  display: grid;
  place-items: center;
  background: var(--panel-3);
  color: var(--muted);
  font-size: 13px;
}
.c-file { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.c-file b {
  font-weight: 500;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.c-file em { font-style: normal; font-size: 10.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t-row.bad .c-file em { color: #d0766a; }
.c-name { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.c-name .model-in { font-size: 10.5px; padding: 3px 6px; }
.c-name .auto-tags { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; font-size: 10.5px; color: var(--muted); }
.c-name .auto-tags label { opacity: 0.7; }
.c-name .auto-tags em { font-style: normal; padding: 0 5px; border-radius: 4px; background: rgba(255, 255, 255, 0.07); color: var(--accent-2); max-width: 88px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-dc { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.c-note { display: flex; min-width: 0; }
.c-note input { width: 100%; font-size: 11.5px; }
.c-dc em { font-style: normal; font-size: 10.5px; color: var(--accent-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
input.uri { font-size: 11px; }

select, input {
  width: 100%;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--text);
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 5px 8px;
  outline: none;
}
select:focus, input:focus { border-color: rgba(212, 162, 76, 0.5); }
.c-del button { padding: 3px 7px; font-size: 11.5px; }

.tips { margin: 4px 18px 0; font-size: 12px; color: var(--muted); }
.tips p { margin: 0 0 6px; color: var(--text-2); font-size: 12.5px; }
.tips ul { margin: 0; padding-left: 18px; line-height: 1.9; }
.tips b { color: var(--accent-2); font-weight: 500; }

footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 18px;
  border-top: 1px solid var(--line-soft);
  margin-top: 14px;
}
.state { font-size: 12px; color: var(--muted); }
.btns { display: flex; gap: 8px; }
.btns button.primary:disabled { opacity: 0.45; cursor: default; }

/* 酒馆选择器 */
.mask2 {
  position: fixed; inset: 0; z-index: 600;
  background: var(--mask);
  display: grid; place-items: center;
}
.picker {
  width: min(620px, 88vw);
  max-height: 76vh;
  display: flex; flex-direction: column;
  background: var(--panel-solid);
  border: 1px solid var(--line);
  border-radius: 13px;
  overflow: hidden;
}
.pk-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line-soft);
}
.pk-head h3 { font-size: 13.5px; margin: 0; }
.pk-head .search { flex: 1; }
.pk-types { display: flex; gap: 5px; }
.pk-types button { color: var(--muted); }
.pk-types button.on { color: var(--text); border-color: rgba(212, 162, 76, 0.65); background: rgba(212, 162, 76, 0.1); }
.pk-note { font-size: 11px; color: #5f6875; padding: 8px 16px 2px; }
.pk-body { overflow-y: auto; padding: 6px; }
.pk-tip { font-size: 12px; color: var(--muted); padding: 18px; text-align: center; }
.pk-row {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 9px; border-radius: 8px; cursor: pointer;
  font-size: 12.5px; color: var(--text-2);
}
.pk-row:hover { background: var(--panel-2); }
.pk-row.on { background: rgba(212, 162, 76, 0.09); }
.tick {
  width: 13px; height: 13px; border-radius: 4px;
  border: 1px solid #4a545f; flex-shrink: 0;
}
.tick.on { background: var(--accent-2); border-color: var(--accent-2); }
.pk-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.pk-meta { font-size: 11px; color: var(--muted); flex-shrink: 0; }
.pk-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 11px 14px; border-top: 1px solid var(--line-soft);
}
/* 左下角：全选 + 已选数量 */
.pk-left { display: flex; align-items: center; gap: 10px; }
.pk-left .state { font-size: 12px; color: var(--muted); }
</style>
