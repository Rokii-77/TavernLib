---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 89261578e3c3881014e3d7386d6938b4_48025852dba211f1bff2525400cd780f
    ReservedCode1: 8xuwxhG0TmMalMXkbQ4BqKBSqJsO6pElKQWng1s8nYqTETYcfORFdOloiVZm2h9/4Boc1tG95D4MLbTZAiHOlSl/k23+CZ/QVCHcxp9QmFSZSUfeNHtD9uhEomtAqdlWn9XZDV7/pxxwE+fc2+r6FhvtrqlpfDznZcG4ntNfONxgzPwf5DDSQP0wh+8=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 89261578e3c3881014e3d7386d6938b4_48025852dba211f1bff2525400cd780f
    ReservedCode2: 8xuwxhG0TmMalMXkbQ4BqKBSqJsO6pElKQWng1s8nYqTETYcfORFdOloiVZm2h9/4Boc1tG95D4MLbTZAiHOlSl/k23+CZ/QVCHcxp9QmFSZSUfeNHtD9uhEomtAqdlWn9XZDV7/pxxwE+fc2+r6FhvtrqlpfDznZcG4ntNfONxgzPwf5DDSQP0wh+8=
---

# 洛书匣 · TavernLib

## 下载安装（Windows 10 / 11）

**⬇️ 下载安装包：[TavernLib-Setup-1.0.3.exe](https://github.com/Rokii-77/TavernLib/releases/download/v1.0.3/TavernLib-Setup-1.0.3.exe)**（85,895,123 字节 / 81.92 MB）

安装步骤：

1. 点上面这个链接，下载 `TavernLib-Setup-1.0.3.exe`
2. 双击运行，选择安装位置，一路下一步
3. 装完桌面会出现「洛书匣」图标，双击打开就能用

> 安装包没有做数字签名，如果 Windows 弹出「已保护你的电脑」，点**更多信息 → 仍要运行**即可。

**普通用户只需要下载上面那个 exe，其余文件都是源码，不用管。** 所有历史版本见 [Release 下载页](https://github.com/Rokii-77/TavernLib/releases/latest)。

---

面向 SillyTavern（酒馆）的本地资料库管理器。把散落在各种网盘、DC 帖子、酒馆目录里的**角色卡、世界书、预设、美化主题**收拢到一处集中管理，带导入、分类、查重、比对更新、备份与回退。

- 桌面端：Electron 33 + Vue 3 + Vite
- 平台：Windows 10 / 11（x64）
- 当前版本：1.0.3

---

## 功能

### 资料库管理
- 五个分类：角色卡、世界书、预设、美化主题、其它，可切换视图与批量操作
- 单条支持名称、分类、版本、备注、DC 原帖链接、标签录入
- 卡片右键菜单：编辑、导出、复制、删除、检查更新、定位文件
- 条目去重标识（内容指纹），同一文件重复导入会被识别

### 导入
- **目录扫描**：指定一个文件夹，递归识别四类资产，结果分批列出后勾选入库
- **单文件 / 多文件导入**：拖拽或点选，自动判定分类与元信息
- **DC 链接导入**：粘贴 Discord 帖子链接，直接读取附件并入库
- **酒馆目录导入**：从已安装的酒馆实例里把现有资产整批搬进资料库

### 更新检查
- 每个条目可记录 DC 帖子的「基准标题」
- 检查时读取帖子当前标题与基准比对，标题变化即视为有新版本，卡片右上角出标记
- 支持整库一键检查与单条检查，可配置只读 Bot Token 自动抓取标题

### 备份与回退
- 整库 ZIP 备份，含清单文件，可指定备份目录
- 单项导出为角色卡 V2 规范文件，能直接丢回酒馆使用
- 备份回退：按时间线查看历史备份并原地还原

### 美化主题
- 主题 CSS 支持粘贴、导入、编辑，内置基础模板
- 软件内直接预览长文本、聊天消息等原版样式效果
- 一键把主题 CSS 注入酒馆，切换主题即时生效

### 酒馆联动
- 随包携带 `tavernlib-sync` 酒馆扩展，一键注入到指定酒馆实例
- 通知桥（本机回环端口）实时回传酒馆端的当前卡、版本、状态
- 顶部状态栏显示酒馆连接状态、当前角色、扩展版本

### 使用体验
- 首次启动两步引导：设置酒馆目录 → 注入扩展
- 11 步界面指引，跟着气泡走一遍就能上手（演示条目不会写进资料库）
- 缩略图自动生成，大图与特殊格式自动转码
- 数据目录可自定义，换位置不丢库
- 内置更新检查，可从 GitHub Releases 获取新版本

---

## 开发与构建

需要 Node.js 18+ 与 pnpm。

```bash
pnpm install        # 安装依赖
pnpm dev            # 开发模式（Vite 热更新，浏览器预览界面）
pnpm app            # 以 Electron 窗口启动
pnpm build          # 构建前端产物到 dist/
pnpm pack:dir       # 打包免安装目录版到 release/win-unpacked/
pnpm dist           # 打包 NSIS 安装包到 release/
```

Windows 下也可直接双击 `打开酒馆资料库.bat` 启动（需要先执行过 `pnpm install` 与 `pnpm build`）。

## 数据位置

- 资料库与设置默认存放在 `%APPDATA%\tavern-lib`（`library.json` + 图片仓库）
- 数据目录可在「设置 → 数据目录」改成任意位置，引导配置单独存放，换目录不会丢库
- 备份文件默认位置可在「设置 → 备份路径」修改

## 目录结构

```
electron/            主进程
  main.cjs           窗口、IPC、数据目录、文件读写
  preload.cjs        渲染进程桥
  updater.cjs        版本更新下载
  lib/               DC 抓取、扫描、缩略图、转码、备份回退、通知桥等
  extensions/        随包携带的酒馆扩展 tavernlib-sync
src/                 渲染进程（Vue 3）
  views/             书架、角色卡详情
  components/        导入、设置、顶部栏、首启引导、界面指引等
  lib/               格式化、导入、备份、主题、预览等纯逻辑
public/ build/       静态资源与打包图标
```

## 说明

- 本软件只做本地文件管理与酒馆联动，不联网上传任何资料；联网仅用于 DC 帖子标题读取与版本更新检查
- 角色卡、世界书等内容版权归原作者所有，请遵守原帖的转载要求

## 许可

个人自用与学习交流。二次分发请保留出处。
*（内容由AI生成，仅供参考）*
