const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('api', {
  fetchJson: (payload) => ipcRenderer.invoke('net:fetch', payload),
  openBackup: () => ipcRenderer.invoke('dialog:openBackup'),
  saveBackup: (arg) => ipcRenderer.invoke('dialog:saveBackup', typeof arg === 'string' ? { name: arg } : (arg || {})),
  reveal: (opts) => ipcRenderer.invoke('shell:reveal', opts || {}),
  writeBuffer: (filePath, buffer, opt) => ipcRenderer.invoke('fs:writeBuffer', filePath, buffer, opt || {}),
  readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  probeDc: (payload) => ipcRenderer.invoke('dc:probe', payload),
  info: () => ipcRenderer.invoke('app:info'),

  /* 无边框窗口的自绘按钮（最小化 / 最大化-还原 / 关闭） */
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winToggleMax: () => ipcRenderer.invoke('win:toggleMax'),
  winClose: () => ipcRenderer.invoke('win:close'),
  winIsMax: () => ipcRenderer.invoke('win:isMax'),
  onWinMaxChange: (fn) => {
    const h = (_e, v) => { try { fn(!!v) } catch (_) {} }
    ipcRenderer.on('win:maxChanged', h)
    return () => ipcRenderer.removeListener('win:maxChanged', h)
  },

  /* 软件数据保存目录 + 数据快照 */
  dataInfo: () => ipcRenderer.invoke('data:info'),
  dataSetDir: (opts) => ipcRenderer.invoke('data:setDir', opts || {}),
  saveLibrary: (text) => ipcRenderer.invoke('data:saveLibrary', text),
  loadLibrary: () => ipcRenderer.invoke('data:loadLibrary'),
  /* 侧车文件：版本原始内容（raw）/ 世界书备份（backups）按需读写，不再塞进 library.json */
  dataPutFile: (opts) => ipcRenderer.invoke('data:putFile', opts || {}),
  dataReadFile: (opts) => ipcRenderer.invoke('data:readFile', opts || {}),
  dataRemoveFile: (opts) => ipcRenderer.invoke('data:removeFile', opts || {}),
  dataListFiles: (opts) => ipcRenderer.invoke('data:listFiles', opts || {}),

  /* 文件系统 */
  stat: (paths) => ipcRenderer.invoke('fs:stat', paths),
  exists: (p) => ipcRenderer.invoke('fs:exists', p),
  readBuffer: (p) => ipcRenderer.invoke('fs:readBuffer', p),
  readCard: (p) => ipcRenderer.invoke('fs:readCard', p),
  pickDir: (opts) => ipcRenderer.invoke('dialog:pickDir', opts || {}),
  pickFiles: (opts) => ipcRenderer.invoke('dialog:pickFiles', opts || {}),
  writeNamed: (payload) => ipcRenderer.invoke('fs:writeNamed', payload),
  copyTo: (payload) => ipcRenderer.invoke('fs:copyTo', payload),
  /** 拖进窗口的文件 → 真实磁盘路径（拿不到就返回空串） */
  pathOfFile: (file) => {
    try { return webUtils.getPathForFile(file) || '' } catch (_) { return '' }
  },

  /* 自动扫描 */
  scanDir: (opts) => ipcRenderer.invoke('scan:dir', opts || {}),

  /* 酒馆 */
  stPing: (opts) => ipcRenderer.invoke('st:ping', opts || {}),
  stScanCharacters: (opts) => ipcRenderer.invoke('st:scanCharacters', opts || {}),
  stScanWorlds: (opts) => ipcRenderer.invoke('st:scanWorlds', opts || {}),
  stScanWorldsUnbound: (opts) => ipcRenderer.invoke('st:scanWorldsUnbound', opts || {}),
  stScanPresets: (opts) => ipcRenderer.invoke('st:scanPresets', opts || {}),
  stScanThemes: (opts) => ipcRenderer.invoke('st:scanThemes', opts || {}),
  stUiCss: (opts) => ipcRenderer.invoke('st:uiCss', opts || {}),
  stFaFont: (opts) => ipcRenderer.invoke('st:faFont', opts || {}),
  stThemeSrc: (opts) => ipcRenderer.invoke('st:themeSrc', opts || {}),
  stExtStatus: (opts) => ipcRenderer.invoke('st:extStatus', opts || {}),
  stExtInject: (opts) => ipcRenderer.invoke('st:extInject', opts || {}),
  download: (opts) => ipcRenderer.invoke('net:download', opts || {}),
  stImportCard: (opts) => ipcRenderer.invoke('st:importCard', opts || {}),
  stReplaceCard: (opts) => ipcRenderer.invoke('st:replaceCard', opts || {}),
  /** 同名卡副本的聊天记录统计（几个存档、各多大），供「要替换哪一份」的选择器展示 */
  stChatStats: (opts) => ipcRenderer.invoke('st:chatStats', opts || {}),
  stImportWorld: (opts) => ipcRenderer.invoke('st:importWorld', opts || {}),
  stImportPreset: (opts) => ipcRenderer.invoke('st:importPreset', opts || {}),
  stImportAny: (opts) => ipcRenderer.invoke('st:importAny', opts || {}),
  /** 大内容直通：只传侧车文件名，主进程读盘解析后写入酒馆（避免渲染进程 OOM） */
  stImportFromSidecar: (opts) => ipcRenderer.invoke('st:importFromSidecar', opts || {}),
  /** 从酒馆 config.yaml 读 port 推导 API 地址 */
  stConfigInfo: (opts) => ipcRenderer.invoke('st:configInfo', opts || {}),
  /* 图片仓库（按内容哈希去重） */
  imgSave: (opts) => ipcRenderer.invoke('img:save', opts || {}),
  imgRead: (hash) => ipcRenderer.invoke('img:read', hash),

  /* 封面缩略图缓存（thumbs/<hash>.webp） */
  thumbPrefetch: (hashes) => ipcRenderer.invoke('thumb:prefetch', hashes || []),
  thumbEnsure: (hash) => ipcRenderer.invoke('thumb:ensure', hash),
  thumbStat: (hashes) => ipcRenderer.invoke('thumb:stat', hashes || []),

  /* Discord */
  probeDcMany: (opts) => ipcRenderer.invoke('dc:probeMany', opts || {}),
  dcTest: (opts) => ipcRenderer.invoke('dc:test', opts || {}),
  dcTokenSet: (token) => ipcRenderer.invoke('dc:tokenSet', { token }),
  dcTokenClear: () => ipcRenderer.invoke('dc:tokenClear'),
  dcTokenStatus: () => ipcRenderer.invoke('dc:tokenStatus'),
  dcTokenAuto: () => ipcRenderer.invoke('dc:tokenAuto'),

  /* 崩溃与报错记录：上报 + 查看/复制/清理 */
  logReport: (payload) => ipcRenderer.invoke('log:report', payload || {}),
  logList: () => ipcRenderer.invoke('log:list'),
  logLatest: () => ipcRenderer.invoke('log:latest'),
  logClear: () => ipcRenderer.invoke('log:clear'),
  logOpenDir: () => ipcRenderer.invoke('log:openDir'),
  /* 复制报错文件本身（粘到聊天窗口直接是文件） */
  logCopyFile: () => ipcRenderer.invoke('log:copyFile'),

  /* 应用内更新：下载安装包 → 静默安装 → 自动重启 */
  upDownload: (opts) => ipcRenderer.invoke('up:download', opts || {}),
  upInstall: (opts) => ipcRenderer.invoke('up:install', opts || {}),
  upState: () => ipcRenderer.invoke('up:state'),
  upClearSuspect: () => ipcRenderer.invoke('up:clearSuspect'),
  onUpProgress: (fn) => {
    const h = (_e, v) => { try { fn(v || {}) } catch (_) {} }
    ipcRenderer.on('up:progress', h)
    return () => ipcRenderer.removeListener('up:progress', h)
  },

  /* 本机通知桥 */
  bridgeStatus: () => ipcRenderer.invoke('bridge:status'),
  bridgeNotify: (payload) => ipcRenderer.invoke('bridge:notify', payload || {})
})
