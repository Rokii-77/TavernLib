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

function apiBase(owner, repo) {
  return `https://api.github.com/repos/${owner}/${repo}/releases/latest`
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
    return { ok: false, configured: true, error: '当前环境不支持联网检查（请在桌面版里使用）' }
  }
  const res = await fetchJson({
    url: apiBase(o, r),
    method: 'GET',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'TavernLib' }
  })
  if (!res || res.ok === false) {
    const status = res?.status || 0
    let msg = res?.error || ''
    if (status === 404) msg = '仓库或 Release 不存在（检查 owner / repo，或还没发布第一个版本）'
    else if (status === 403) msg = 'GitHub 接口访问受限（触发限流），稍后再试'
    return { ok: false, configured: true, error: msg || '检查失败', status }
  }
  const rel = res.data || {}
  /* tag 常写成 v0.1.7，界面统一按「数字版本」展示，避免出现 vv0.1.7 */
  const rawTag = String(rel.tag_name || rel.name || '').trim()
  const latest = rawTag.replace(/^[vV]+/, '')
  if (!latest) return { ok: false, configured: true, error: 'Release 里没有版本号（tag_name 为空）' }
  const hasUpdate = compareVersion(latest, current) > 0
  const dl = pickDownloadUrl(rel)
  return {
    ok: true,
    configured: true,
    current: String(current || ''),
    latest,
    hasUpdate,
    name: String(rel.name || latest),
    notes: String(rel.body || ''),
    publishedAt: String(rel.published_at || ''),
    prerelease: !!rel.prerelease,
    url: String(rel.html_url || ''),
    downloadUrl: dl.url,
    downloadName: dl.name,
    downloadDigest: dl.digest || '',
    downloadSize: dl.size || 0,
    ignoredPrerelease: includePrerelease ? false : !!rel.prerelease
  }
}
