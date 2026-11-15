/**
 * 软件更新检查（GitHub Releases）
 *
 * 仓库还没建好，owner/repo 先留空 → 点「检查更新」只提示「尚未配置更新源」，不报错。
 * 之后打包 exe 传到 GitHub Releases，把 owner/repo 填上（或改这里默认值）就能用。
 *
 * 判定逻辑：拉 releases/latest → 比对 tag_name 与本地版本 → 有新版就给出
 * 版本号 / 更新说明 / 下载入口（优先 exe 安装包，其次仓库页面）。
 */

/** 默认更新源：仓库地址写死在这里，设置页不再让用户手填 */
export const DEFAULT_UPDATE_SOURCE = {
  owner: 'Rokii-77',
  repo: 'TavernLib'
}

/** 仓库主页（设置页展示用） */
export const REPO_URL = `https://github.com/${DEFAULT_UPDATE_SOURCE.owner}/${DEFAULT_UPDATE_SOURCE.repo}.git`
export const REPO_WEB = `https://github.com/${DEFAULT_UPDATE_SOURCE.owner}/${DEFAULT_UPDATE_SOURCE.repo}`

/** 更新清单文件（放在仓库根目录，raw 直链读取，不占 api.github.com 配额） */
export const UPDATE_MANIFEST_PATH = 'update/latest.json'
/** 安装包命名前缀：TavernLib-Setup-<版本>.exe */
export const INSTALLER_PREFIX = 'TavernLib-Setup'

/** 检查结果里 channel 的展示名（界面标注走的哪条通道） */
export const CHANNEL_LABELS = {
  redirect: 'github.com releases/latest（302）',
  'redirect-html': 'github.com releases/latest（页面解析）',
  atom: 'releases.atom',
  api: 'api.github.com（兜底）'
}

/** 错误分型：界面按 kind 给出不同提示，限流不再被当成「已是最新」 */
export const UPDATE_ERROR_KIND = {
  RATE_LIMIT: 'ratelimit',
  NETWORK: 'network',
  NO_RELEASE: 'no-release',
  UNKNOWN: 'unknown'
}

/** 归一化版本串：v1.2.3 / 1.2.3-beta.1 → { nums: [1,2,3], pre: 'beta.1', raw } */
export function parseVersion(input) {
  const raw = String(input == null ? '' : input).trim()
  const m = raw.match(/(\d+(?:\.\d+)*)(?:[-+._\s]?([0-9A-Za-z.\-]+))?/)
  if (!m) return { nums: [], pre: '', raw }
  const nums = m[1].split('.').map((x) => Number(x) || 0)
  let pre = String(m[2] || '')
  // 纯数字、或形如 "1" 的尾巴不算预发布标记
  if (/^\d+$/.test(pre)) pre = ''
  return { nums, pre, raw }
}

/** 比版本：a > b 返回 1，a < b 返回 -1，相同 0 */
export function compareVersion(a, b) {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  const n = Math.max(va.nums.length, vb.nums.length)
  for (let i = 0; i < n; i++) {
    const x = va.nums[i] || 0
    const y = vb.nums[i] || 0
    if (x > y) return 1
    if (x < y) return -1
  }
  // 数字段相同：正式版高于预发布版
  if (va.pre && !vb.pre) return -1
  if (!va.pre && vb.pre) return 1
  if (va.pre === vb.pre) return 0
  return va.pre > vb.pre ? 1 : -1
}

/** 从 release 里挑一个最合适的下载入口：Windows 安装包优先，其次任意 exe/zip，最后回仓库页
 *  digest 是 GitHub 自动算的 "sha256:xxxx"，拿它做完整性比对；没有就留空，后续跳过校验 */
export function pickDownloadUrl(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : []
  const pick = (re) => assets.find((a) => re.test(String(a?.name || '')))
  const hit =
    pick(/\.exe$/i) ||
    pick(/setup.*\.exe$/i) ||
    pick(/\.(msi|zip|7z)$/i) ||
    assets.find((a) => a?.browser_download_url)
  if (hit?.browser_download_url) {
    return {
      url: hit.browser_download_url,
      name: hit.name || '',
      digest: String(hit.digest || ''),
      size: Number(hit.size || 0)
    }
  }
  return { url: String(release?.html_url || ''), name: '', digest: '', size: 0 }
}

/* ---------- 地址拼装：三条检查通道 + 下载直链 + 清单 ---------- */

/** 主通道：github.com/releases/latest，匿名访问，靠 302 的 Location 拿 tag（不消耗 API 配额） */
export function releasesLatestUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}/releases/latest`
}

/** 退路：releases.atom，纯 XML 订阅源，同样不消耗 API 配额 */
export function releasesAtomUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}/releases.atom`
}

/** 兜底：api.github.com（匿名配额有限，仅前两条都失败时才用） */
export function apiLatestUrl(owner, repo) {
  return `https://api.github.com/repos/${owner}/${repo}/releases/latest`
}

/** 别名保留：老代码里的 apiBase 就是兜底通道地址 */
function apiBase(owner, repo) {
  return apiLatestUrl(owner, repo)
}

/** 更新清单 raw 直链（main 分支根目录下的 update/latest.json） */
export function manifestUrl(owner, repo) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/main/${UPDATE_MANIFEST_PATH}`
}

/** 默认安装包名：TavernLib-Setup-<版本>.exe */
export function defaultInstallerName(version) {
  return `${INSTALLER_PREFIX}-${String(version || '').trim()}.exe`
}

/** Release 资产下载直链：按 tag + 文件名拼 */
export function releaseDownloadUrl(owner, repo, tag, fileName) {
  const t = encodeURIComponent(String(tag || '').trim())
  const f = encodeURIComponent(String(fileName || '').trim())
  return `https://github.com/${owner}/${repo}/releases/download/${t}/${f}`
}

/** 默认安装包直链：TavernLib-Setup-<版本>.exe */
export function defaultInstallerUrl(owner, repo, tag, version) {
  return releaseDownloadUrl(owner, repo, tag, defaultInstallerName(version))
}

/** Release 详情页（浏览器打开用） */
export function releaseTagPageUrl(owner, repo, tag) {
  return `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(String(tag || '').trim())}`
}

/* ---------- 错误分型 ---------- */

const RATE_LIMIT_MESSAGE = 'GitHub 接口限流（403 / rate limit）：当前网络出口 IP 的匿名配额可能被占满'
const NETWORK_MESSAGE = '网络不可达：连不上 github.com，请检查代理 / VPN 或 DNS 后重试'
const NO_RELEASE_MESSAGE = '仓库还没有发布任何 Release（或 tag 指向的 Release 已删除）'

/** 403 / 429 或响应体明确提到 rate limit → 判定为限流 */
export function isRateLimited(status, text) {
  if (Number(status) === 403 || Number(status) === 429) return true
  return /rate limit|api rate limit exceeded|secondary rate|abuse detection/i.test(String(text || ''))
}

/** status 0（请求没发出去/被断开）或典型网络错误码 → 判定为网络不可达 */
export function isNetworkFailure(status, err) {
  if (Number(status) === 0) return true
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPROTO|fetch failed|socket hang up|请求超时|timed? ?out|网络|TLS|certificate|CERT_/i.test(String(err || ''))
}

/** kind → 可读提示（限流明确要求「稍后重试 / 换网络」，不说已是最新） */
export function errorMessageOf(kind, fallback = '', status = 0) {
  if (kind === UPDATE_ERROR_KIND.RATE_LIMIT) return `${RATE_LIMIT_MESSAGE}，请稍后重试或更换网络（开关代理 / VPN）后再检查`
  if (kind === UPDATE_ERROR_KIND.NETWORK) return NETWORK_MESSAGE
  if (kind === UPDATE_ERROR_KIND.NO_RELEASE) return NO_RELEASE_MESSAGE
  const f = String(fallback || '').trim()
  if (f) return `检查失败：${f}`
  return status ? `检查失败（HTTP ${status}）` : '检查失败'
}

/** kind → 操作建议 */
export function hintOf(kind) {
  if (kind === UPDATE_ERROR_KIND.RATE_LIMIT) return '这条提示不代表「已是最新」：GitHub 只是拒绝了这次查询。等配额恢复，或换一条网络（切到直连 / 换节点）再点「立即检查」。'
  if (kind === UPDATE_ERROR_KIND.NETWORK) return '确认能打开 github.com 后再试；若开着代理，试试切换全局 / 规则模式，或先关掉再检查。'
  if (kind === UPDATE_ERROR_KIND.NO_RELEASE) return '发布一个 Release（打 tag 并上传 TavernLib-Setup-<版本>.exe）后即可检查到新版本。'
  return ''
}

function safeDecode(s) {
  try { return decodeURIComponent(String(s || '')) } catch (_) { return String(s || '') }
}

function stripHtml(s) {
  const t = String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    /* 先解实体再去标签：atom 里的 content 是转义过的 HTML（&lt;p&gt;），
       只按原顺序处理会把标签原样留下 */
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return t.length > 1200 ? t.slice(0, 1200) + '…' : t
}

/** 从 302 的 Location（绝对或相对都行）里抠 tag */
export function parseTagFromLocation(location) {
  const m = String(location || '').match(/\/releases\/tag\/([^/?#]+)/i)
  return m && m[1] ? safeDecode(m[1]) : ''
}

/** 从 releases/latest 的 HTML 里抠 tag 链接（拿不到 Location 时兜底用） */
export function parseTagFromHtml(html) {
  const s = typeof html === 'string' ? html : ''
  if (!s) return ''
  const m = s.match(/\/releases\/tag\/([A-Za-z0-9._\-+%]+)/)
  return m && m[1] ? safeDecode(m[1]) : ''
}

/** 从 releases.atom 里取最新一条 entry 的 tag / 更新时间 / 说明 */
export function parseAtomLatest(xml) {
  const s = typeof xml === 'string' ? xml : ''
  if (!s) return null
  const entry = (s.match(/<entry>[\s\S]*?<\/entry>/i) || [])[0] || ''
  const block = entry || s
  if (!entry && !/<feed[\s>]/i.test(s)) return null
  if (!entry) return null
  let tag = ''
  const link = block.match(/<link[^>]*href=["']([^"']*\/releases\/tag\/[^"']+)["']/i)
  if (link) tag = parseTagFromLocation(link[1])
  if (!tag) {
    const id = block.match(/<id>\s*tag:github\.com,[^<]*?\/([^<]+?)\s*<\/id>/i)
    if (id) tag = String(id[1]).trim()
  }
  if (!tag) {
    const title = stripHtml((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '')
    const v = title.match(/v?\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.\-]+)?/)
    if (v) tag = v[0]
  }
  const notes = stripHtml((block.match(/<content[^>]*>([\s\S]*?)<\/content>/i) || [])[1] || '')
  const publishedAt = String((block.match(/<updated>([^<]+)<\/updated>/i) || [])[1] || '').trim()
  return { tag, notes, publishedAt }
}

/**
 * 解析最新 tag：github.com 302 → releases.atom → api.github.com
 * 返回 { ok, tag, via, viaLabel, notes, publishedAt, status, kind, error, hint, tried }
 */
export async function resolveLatestTag({ owner, repo, fetchJson } = {}) {
  const o = String(owner || '').trim()
  const r = String(repo || '').trim()
  const tried = []
  if (typeof fetchJson !== 'function') {
    return { ok: false, kind: UPDATE_ERROR_KIND.UNKNOWN, error: '当前环境不支持联网检查（请在桌面版里使用）', tried }
  }
  let noRelease = false
  let rateLimited = false
  let networkFailed = false
  let lastError = ''
  let lastStatus = 0

  const call = async (payload) => {
    try {
      const res = await fetchJson(payload)
      return res && typeof res === 'object' ? res : { ok: false, status: 0, error: '没有响应' }
    } catch (e) {
      return { ok: false, status: 0, error: String((e && e.message) || e) }
    }
  }

  /* ① github.com/releases/latest：跟随由主进程关掉（redirect: 'manual'），自己读 302 的 Location */
  const latestUrl = releasesLatestUrl(o, r)
  tried.push({ channel: 'redirect', url: latestUrl })
  {
    const res = await call({
      url: latestUrl,
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'TavernLib' }
    })
    const st = Number(res.status || 0)
    const err = String(res.error || '')
    if (st >= 300 && st < 400) {
      const loc = String(res.location || '')
      const tag = parseTagFromLocation(loc)
      if (tag) return { ok: true, tag, via: 'redirect', viaLabel: CHANNEL_LABELS.redirect, status: st, tried }
      /* 302 落到 /releases（没有 tag 段）→ 仓库一条 Release 都没有 */
      if (/\/releases\/?$/i.test(loc.replace(/\?.*$/, ''))) noRelease = true
      lastStatus = st
      lastError = loc ? `Location 里没有 tag：${loc}` : '响应没有 Location'
    } else if (st >= 200 && st < 300) {
      const tag = parseTagFromHtml(typeof res.data === 'string' ? res.data : '')
      if (tag) return { ok: true, tag, via: 'redirect-html', viaLabel: CHANNEL_LABELS['redirect-html'], status: st, tried }
      lastStatus = st
      lastError = '页面里没找到 releases/tag 链接'
    } else {
      lastStatus = st
      lastError = err || `HTTP ${st}`
      if (isRateLimited(st, err)) rateLimited = true
      if (isNetworkFailure(st, err)) networkFailed = true
    }
  }

  /* ② releases.atom：XML 订阅源，取第一条 entry */
  const atomUrl = releasesAtomUrl(o, r)
  tried.push({ channel: 'atom', url: atomUrl })
  {
    const res = await call({ url: atomUrl, method: 'GET', headers: { Accept: 'application/atom+xml', 'User-Agent': 'TavernLib' } })
    const st = Number(res.status || 0)
    const err = String(res.error || '')
    const body = typeof res.data === 'string' ? res.data : ''
    if (st >= 200 && st < 300) {
      const a = parseAtomLatest(body)
      if (a && a.tag) {
        return {
          ok: true,
          tag: a.tag,
          via: 'atom',
          viaLabel: CHANNEL_LABELS.atom,
          notes: a.notes || '',
          publishedAt: a.publishedAt || '',
          status: st,
          tried
        }
      }
      /* 订阅源能读通却没有任何 entry → 确实没有 Release */
      if (/<feed[\s>]/i.test(body)) noRelease = true
      lastStatus = st
      lastError = 'atom 里没有 release 条目'
    } else {
      lastStatus = st
      lastError = err || `HTTP ${st}`
      if (isRateLimited(st, err)) rateLimited = true
      if (isNetworkFailure(st, err)) networkFailed = true
    }
  }

  /* ③ 兜底：api.github.com（会消耗匿名配额，只在上面两条都失败时才走） */
  const apiUrl = apiLatestUrl(o, r)
  tried.push({ channel: 'api', url: apiUrl })
  {
    const res = await call({ url: apiUrl, method: 'GET', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'TavernLib' } })
    const st = Number(res.status || 0)
    const err = String(res.error || '')
    if (st >= 200 && st < 300) {
      const d = res.data && typeof res.data === 'object' ? res.data : {}
      const tag = String(d.tag_name || d.name || '').trim()
      if (tag) {
        return {
          ok: true,
          tag,
          via: 'api',
          viaLabel: CHANNEL_LABELS.api,
          notes: stripHtml(String(d.body || '')),
          publishedAt: String(d.published_at || ''),
          status: st,
          tried
        }
      }
      lastStatus = st
      lastError = 'Release 里没有版本号（tag_name 为空）'
      noRelease = true
    } else {
      lastStatus = st
      lastError = err || `HTTP ${st}`
      if (st === 404) noRelease = true
      if (isRateLimited(st, err)) rateLimited = true
      if (isNetworkFailure(st, err)) networkFailed = true
    }
  }

  /* 判定优先级：确实没有 Release > 限流 > 网络不可达 > 未知 */
  let kind = UPDATE_ERROR_KIND.UNKNOWN
  if (noRelease) kind = UPDATE_ERROR_KIND.NO_RELEASE
  else if (rateLimited) kind = UPDATE_ERROR_KIND.RATE_LIMIT
  else if (networkFailed) kind = UPDATE_ERROR_KIND.NETWORK
  return {
    ok: false,
    kind,
    error: lastError || '三条通道都没拿到最新版本',
    status: lastStatus,
    hint: hintOf(kind),
    tried
  }
}

/**
 * 读取仓库里的更新清单 update/latest.json
 * 返回 { ok, version, tag, file, size, sha256 } 或 { ok:false, reason }
 */
export async function fetchUpdateManifest({ owner, repo, fetchJson, version } = {}) {
  const o = String(owner || '').trim()
  const r = String(repo || '').trim()
  if (typeof fetchJson !== 'function') return { ok: false, reason: '当前环境不支持联网' }
  /* 带时间戳绕过 raw 的 CDN 缓存（清单更新后能立刻读到新值） */
  const url = `${manifestUrl(o, r)}?t=${Date.now()}`
  let res = null
  try {
    res = await fetchJson({
      url,
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'TavernLib', 'Cache-Control': 'no-cache' }
    })
  } catch (e) {
    return { ok: false, reason: '清单请求异常：' + String((e && e.message) || e) }
  }
  const st = Number(res?.status || 0)
  if (st === 404) return { ok: false, reason: '仓库里还没有 update/latest.json（404）' }
  if (!res || res.ok === false) return { ok: false, reason: '清单读取失败（' + (st || res?.error || '未知') + '）' }
  let raw = res.data
  /* 主进程一般已把响应体 JSON.parse 好；万一拿到的是原始文本，这里再兜一次 */
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch (_) { return { ok: false, reason: '清单内容不是合法 JSON' } }
  }
  const m = raw && typeof raw === 'object' ? raw : null
  if (!m) return { ok: false, reason: '清单内容不是合法 JSON' }
  const v = String(m.version || '').trim()
  const tag = String(m.tag || '').trim()
  const file = String(m.file || '').trim()
  const size = Number(m.size || 0)
  const sha = String(m.sha256 || '').trim().toLowerCase().replace(/^sha256:/, '')
  if (!file) return { ok: false, reason: '清单缺少 file 字段' }
  if (!/^[0-9a-f]{64}$/.test(sha)) return { ok: false, reason: '清单 sha256 格式不对（应为 64 位十六进制）' }
  if (version && v && compareVersion(v, version) !== 0) {
    return { ok: false, reason: `清单版本 ${v} 与 Release tag ${version} 不一致` }
  }
  return { ok: true, version: v, tag, file, size, sha256: sha }
}

/** 探下载直链的真实文件大小（HEAD 拿 Content-Length，用于没有清单时的降级大小校验） */
export async function probeDownloadSize(url, fetchJson) {
  if (typeof fetchJson !== 'function') return 0
  try {
    const res = await fetchJson({
      url,
      method: 'HEAD',
      redirect: 'follow',
      withHeaders: true,
      headers: { 'User-Agent': 'TavernLib' }
    })
    const st = Number(res?.status || 0)
    if (st >= 200 && st < 300) {
      const n = Number((res.headers && res.headers['content-length']) || 0)
      if (n > 0) return n
    }
  } catch (_) {}
  return 0
}

/**
 * 列出历史版本（回退用）：返回 [{ latest(纯数字版本), tag, notes, publishedAt, downloadUrl, downloadName, downloadDigest, downloadSize }]
 * 只保留带安装包入口的版本，按版本号从高到低排
 */
export async function listReleases({ owner, repo, fetchJson } = {}) {
  const o = String(owner || '').trim()
  const r = String(repo || '').trim()
  if (!o || !r) return { ok: false, configured: false, error: '尚未配置更新源', items: [] }
  if (typeof fetchJson !== 'function') return { ok: false, configured: true, error: '当前环境不支持联网检查（请在桌面版里使用）', items: [] }
  const res = await fetchJson({
    url: `https://api.github.com/repos/${o}/${r}/releases?per_page=20`,
    method: 'GET',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'TavernLib' }
  })
  if (!res || res.ok === false) {
    const status = res?.status || 0
    let msg = res?.error || '拉取历史版本失败'
    if (status === 404) msg = '仓库或 Release 不存在'
    else if (status === 403) msg = 'GitHub 接口访问受限（触发限流），稍后再试'
    return { ok: false, configured: true, error: msg, status, items: [] }
  }
  const list = Array.isArray(res.data) ? res.data : []
  const items = []
  for (const rel of list) {
    const tag = String(rel?.tag_name || rel?.name || '').trim()
    const version = tag.replace(/^[vV]+/, '')
    if (!version) continue
    const dl = pickDownloadUrl(rel)
    /* 回退必须有安装包可下；只有仓库页地址的版本跳过 */
    if (!dl.url || !/^https?:\/\//i.test(dl.url) || !dl.name) continue
    items.push({
      latest: version,
      tag,
      notes: String(rel?.body || ''),
      publishedAt: String(rel?.published_at || ''),
      prerelease: !!rel?.prerelease,
      url: String(rel?.html_url || ''),
      downloadUrl: dl.url,
      downloadName: dl.name,
      downloadDigest: dl.digest || '',
      downloadSize: Number(dl.size || 0)
    })
  }
  items.sort((a, b) => compareVersion(b.latest, a.latest))
  return { ok: true, configured: true, items }
}

/**
 * 检查更新
 * @param {object} opt
 * @param {string} opt.owner   仓库 owner
 * @param {string} opt.repo    仓库名
 * @param {string} opt.current 当前版本（package.json version）
 * @param {function} opt.fetchJson 主进程 net:fetch（返回 { ok, status, data }）
 * @param {boolean} opt.includePrerelease 是否接受预发布版（当前只看 latest，保留参数位）
 */
export async function checkForUpdate({ owner, repo, current, fetchJson, includePrerelease = false } = {}) {
  const o = String(owner || '').trim()
  const r = String(repo || '').trim()
  if (!o || !r) {
    return {
      ok: false,
      configured: false,
      error: '尚未配置更新源',
      hint: '仓库还没建好：打包出 exe 传到 GitHub Releases 后，把 owner / repo 填到下面即可启用。'
    }
  }
  if (typeof fetchJson !== 'function') {
    return { ok: false, configured: true, kind: UPDATE_ERROR_KIND.UNKNOWN, error: '当前环境不支持联网检查（请在桌面版里使用）' }
  }

  /* ① 先解析最新 tag：github.com 302 → releases.atom → api.github.com（只有前两条都失败才碰 API） */
  const tagRes = await resolveLatestTag({ owner: o, repo: r, fetchJson })
  if (!tagRes.ok) {
    const kind = tagRes.kind || UPDATE_ERROR_KIND.UNKNOWN
    return {
      ok: false,
      configured: true,
      kind,
      status: Number(tagRes.status || 0),
      error: errorMessageOf(kind, tagRes.error, tagRes.status),
      detail: String(tagRes.error || ''),
      hint: tagRes.hint || hintOf(kind),
      tried: Array.isArray(tagRes.tried) ? tagRes.tried : []
    }
  }
  const tag = String(tagRes.tag || '').trim()
  /* tag 常写成 v1.0.2，界面统一按「数字版本」展示，避免出现 vv1.0.2 */
  const latest = tag.replace(/^[vV]+/, '')
  if (!latest) {
    return { ok: false, configured: true, kind: UPDATE_ERROR_KIND.NO_RELEASE, error: 'Release 里没有版本号（tag 为空）', tried: tagRes.tried }
  }
  const hasUpdate = compareVersion(latest, current) > 0

  /* ② 校验信息：优先读仓库里的 update/latest.json；取不到就降级成大小校验，绝不因此拒绝更新 */
  const mf = await fetchUpdateManifest({ owner: o, repo: r, fetchJson, version: latest })
  let downloadName = ''
  let downloadSize = 0
  let downloadDigest = ''
  let verify = 'none'
  let verifyLabel = '无校验'
  if (mf.ok) {
    downloadName = mf.file
    downloadSize = Number(mf.size || 0)
    downloadDigest = mf.sha256
    verify = 'sha256'
    verifyLabel = 'SHA256 完整校验（更新清单）'
  } else {
    downloadName = defaultInstallerName(latest)
    downloadSize = await probeDownloadSize(releaseDownloadUrl(o, r, tag, downloadName), fetchJson)
    downloadDigest = ''
    verify = downloadSize > 0 ? 'size' : 'none'
    verifyLabel = downloadSize > 0 ? '仅大小校验（清单不可用，已降级）' : '无校验（清单与文件大小都拿不到）'
  }
  const downloadUrl = releaseDownloadUrl(o, r, tag, downloadName)
  const prerelease = /-(alpha|beta|rc|pre)/i.test(latest)
  return {
    ok: true,
    configured: true,
    channel: tagRes.via || '',
    channelLabel: tagRes.viaLabel || CHANNEL_LABELS[tagRes.via] || '',
    current: String(current || ''),
    latest,
    tag,
    hasUpdate,
    name: `v${latest}`,
    notes: String(tagRes.notes || ''),
    publishedAt: String(tagRes.publishedAt || ''),
    prerelease,
    url: releaseTagPageUrl(o, r, tag),
    downloadUrl,
    downloadName,
    downloadDigest,
    downloadSize,
    verify,
    verifyLabel,
    manifest: !!mf.ok,
    manifestNote: mf.ok ? '' : String(mf.reason || ''),
    ignoredPrerelease: includePrerelease ? false : prerelease
  }
}
