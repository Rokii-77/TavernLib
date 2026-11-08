<script setup>
/* 右下角提示卡：软件更新 + 酒馆扩展版本不一致
 * 只做展示与转发操作，状态与动作都在 store 里（设置面板用的是同一份状态） */
import { computed, onMounted } from 'vue'
import {
  store,
  ignoreAppUpdate,
  startAppUpdate,
  installAppUpdate,
  bindUpdProgress,
  checkStExtVersion,
  reInjectStExt,
  dismissExtRemind,
  resetAppUpdate,
  checkRollbackOnStart,
  rollbackAppUpdate,
  dismissRollback,
  showToast
} from '../store.js'

const ap = computed(() => store.appUpdate)
const upd = computed(() => store.upd)
const ext = computed(() => store.extRemind)
const rb = computed(() => store.rollback)

/* 下载/安装过程中的卡不能按版本忽略条件藏起来，否则进度就看不到了 */
const showUpdate = computed(() => {
  /* 回退复用了同一条下载链路，进度归回退卡显示，不再额外冒出一张「发现新版本」 */
  if (upd.value.mode === 'rollback') return false
  if (upd.value.phase !== 'idle') return true
  if (!ap.value.hasUpdate) return false
  return !ap.value.ignored
})

const sizeText = computed(() => fmtMB(upd.value.total || ap.value.downloadSize || 0))

function fmtMB(n) {
  const v = Number(n) || 0
  if (!v) return '—'
  if (v < 1024 * 1024) return (v / 1024).toFixed(0) + ' KB'
  return (v / 1024 / 1024).toFixed(1) + ' MB'
}

function onIgnore() {
  ignoreAppUpdate()
}

function onDownload() {
  startAppUpdate()
}

function onInstall() {
  installAppUpdate()
}

async function openRelease() {
  const a = window.api
  const url = ap.value.url || ap.value.downloadUrl
  if (!url) return
  if (a?.openExternal) await a.openExternal(url)
}

async function onReInject() {
  await reInjectStExt()
}

function onLaterExt() {
  dismissExtRemind()
}

async function onRollback() {
  await rollbackAppUpdate()
}

async function onRollbackLater() {
  await dismissRollback()
}

onMounted(() => {
  bindUpdProgress()
  /* 上次的下载状态不跨进程沿用，进程重启后一律回到 idle（安装包还在的话设置里可见） */
  resetAppUpdate()
  /* 看门狗：上次更新后新版没正常起来的话，这里会点亮回退提示 */
  checkRollbackOnStart()
})
</script>

<template>
  <div class="upd-stack">
    <!-- 看门狗：新版装完没正常起来 → 提示退回上一版 -->
    <transition name="pop">
      <div v-if="rb.suspect" class="card rb">
        <div class="head">
          <b>新版本似乎没能正常启动</b>
          <button class="x" title="不再提示" @click="onRollbackLater">✕</button>
        </div>
        <p class="line">
          装完 <i>v{{ rb.to || '?' }}</i> 后连续 {{ rb.attempts || 2 }} 次启动都没成功，现在跑的还是 <i>v{{ rb.from }}</i>。
          可以退回这次更新前的版本。
        </p>
        <p v-if="rb.hint" class="line dim">{{ rb.hint }}</p>
        <p v-if="rb.busy && upd.phase === 'downloading' && upd.total" class="line dim">
          {{ upd.percent }}% · {{ fmtMB(upd.received) }} / {{ fmtMB(upd.total) }}
        </p>
        <div class="acts">
          <button class="primary" :disabled="rb.busy" @click="onRollback">
            {{ rb.busy ? '处理中…' : '退回 v' + (rb.from || '') }}
          </button>
          <button class="ghost" :disabled="rb.busy" @click="onRollbackLater">不用了</button>
        </div>
      </div>
    </transition>

    <!-- 酒馆扩展版本不匹配：更新完第一次打开就要提醒，否则酒馆里跑的旧扩展会静默出错 -->
    <transition name="pop">
      <div v-if="ext.visible" class="card ext">
        <div class="head">
          <b>{{ ext.installed ? '酒馆扩展版本不匹配' : '酒馆里还没装扩展' }}</b>
          <button class="x" title="稍后再说" @click="onLaterExt">✕</button>
        </div>
        <p class="line">
          <template v-if="ext.installed">
            软件内置 <i>v{{ ext.builtin || '?' }}</i>，酒馆里是 <i>v{{ ext.tavern || '未知' }}</i>。重新注入一次才能对上。
          </template>
          <template v-else>酒馆目录里没有 tavernlib-sync，重新注入后酒馆才能读到资料库。</template>
        </p>
        <div class="acts">
          <button class="primary" :disabled="ext.busy" @click="onReInject">
            {{ ext.busy ? '注入中…' : '立即重新注入' }}
          </button>
          <button class="ghost" :disabled="ext.busy" @click="onLaterExt">稍后</button>
        </div>
      </div>
    </transition>

    <!-- 软件更新 -->
    <transition name="pop">
      <div v-if="showUpdate" class="card">
        <div class="head">
          <b>发现新版本 v{{ ap.latest }}</b>
          <button v-if="upd.phase === 'idle'" class="x" title="忽略本次更新" @click="onIgnore">✕</button>
        </div>
        <p class="line dim">当前 v{{ ap.current }} → v{{ ap.latest }}<span v-if="sizeText !== '—'">｜安装包 {{ sizeText }}</span></p>

        <div v-if="upd.phase === 'downloading'" class="prog">
          <div class="bar"><i :style="{ width: (upd.percent || 0) + '%' }"></i></div>
          <p class="line dim">
            {{ upd.percent || 0 }}% · {{ fmtMB(upd.received) }} / {{ fmtMB(upd.total) }}，下载完成后可一键重启安装
          </p>
        </div>
        <p v-else-if="upd.phase === 'ready'" class="line ok">安装包已就绪（{{ sizeText }}），点下面按钮会自动覆盖安装并重启</p>
        <p v-else-if="upd.phase === 'installing'" class="line ok">正在退出并安装，装完会自动打开新版本…</p>
        <p v-if="upd.error" class="line warn">{{ upd.error }}</p>

        <div class="acts">
          <button v-if="upd.phase === 'idle' && ap.downloadUrl" class="primary" @click="onDownload">下载并更新</button>
          <button v-else-if="upd.phase === 'idle'" class="primary" @click="openRelease">去发布页下载</button>
          <button v-else-if="upd.phase === 'ready'" class="primary" @click="onInstall">重启并安装</button>
          <button v-if="upd.phase === 'idle'" class="ghost" @click="openRelease">更新说明</button>
          <button v-if="upd.phase === 'idle'" class="ghost" @click="onIgnore">忽略本次</button>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.upd-stack {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 700;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 322px;
  pointer-events: none;
}
.card {
  pointer-events: auto;
  background: var(--panel-fly);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: var(--shadow);
  padding: 12px 14px;
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.65;
}
.card.ext {
  border-color: var(--accent-dim);
}
.card.rb {
  border-color: var(--danger);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}
.head b {
  font-size: 13px;
  font-weight: 600;
}
.x {
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 4px;
  border-radius: 6px;
}
.x:hover {
  color: var(--text);
  background: var(--panel-3);
}
.line {
  margin: 4px 0 0;
  word-break: break-word;
}
.line i {
  font-style: normal;
  color: var(--accent);
}
.dim {
  color: var(--text-2);
}
.ok {
  color: var(--ok);
}
.warn {
  color: var(--danger);
}
.prog {
  margin-top: 6px;
}
.bar {
  height: 5px;
  border-radius: 999px;
  background: var(--overlay-2);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.18s ease;
}
.acts {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.primary,
.ghost {
  border-radius: 8px;
  cursor: pointer;
  font-size: 12.5px;
  padding: 5px 12px;
  border: 1px solid var(--line);
  transition: all 0.16s ease;
}
.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.primary:disabled {
  opacity: 0.5;
  cursor: default;
}
.ghost {
  background: transparent;
  color: var(--text-2);
}
.ghost:hover {
  color: var(--text);
  background: var(--panel-3);
}
.pop-enter-active,
.pop-leave-active {
  transition: all 0.2s ease;
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
