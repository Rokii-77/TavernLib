<script setup>
/* 首次使用初始化指引：三步走完直接进界面，随后用气泡指引导入。 */
import { ref, computed, onMounted } from 'vue'
import { store, showToast, finishFirstRun, applyTavernPath, startOnboardTour } from '../store.js'

const step = ref(0)
const pathBusy = ref(false)
const extBusy = ref(false)
const apiUrl = ref(String(store.settings.tavernUrl || ''))
const apiFromFile = ref(false)
const ext = ref({ checked: false, installed: false, version: '', latest: '', path: '' })

const steps = [
  { title: '酒馆目录', desc: '先告诉洛书匣酒馆装在哪' },
  { title: '装扩展', desc: '往酒馆里放一个小扩展' },
]
const isLast = computed(() => step.value === steps.length - 1)

onMounted(() => {
  if (String(store.settings.tavernPath || '').trim()) loadExt()
})

async function browsePath() {
  const a = window.api
  if (!a?.pickDir) return showToast('请在桌面版里使用')
  const dir = await a.pickDir({ title: '选择酒馆安装目录', defaultPath: store.settings.tavernPath || '' })
  if (dir) store.settings.tavernPath = dir
}

/** 第一步「下一步」：写入路径并在后台读 config.yaml 得到 API 地址，完成后进第二步 */
async function confirmPath() {
  const p = String(store.settings.tavernPath || '').trim()
  if (!p) return showToast('先选酒馆安装目录')
  if (pathBusy.value) return
  pathBusy.value = true
  try {
    const r = await applyTavernPath(p)
    apiUrl.value = r.url || String(store.settings.tavernUrl || '')
    apiFromFile.value = !!r.fromFile
  } catch (_) {
  } finally {
    pathBusy.value = false
  }
  step.value = 1
  await loadExt()
}

async function loadExt() {
  const a = window.api
  const p = String(store.settings.tavernPath || '').trim()
  if (!p || !a?.stExtStatus) return
  try {
    const r = await a.stExtStatus({ tavernPath: store.settings.tavernPath, user: store.settings.stUser })
    if (r && r.ok) {
      ext.value = {
        checked: true,
        installed: !!r.installed,
        version: String(r.version || ''),
        latest: String(r.latest || ''),
        path: String(r.path || '')
      }
    }
  } catch (_) {}
}

async function injectExt() {
  const a = window.api
  if (!a?.stExtInject) return showToast('请在桌面版里使用')
  if (extBusy.value) return
  extBusy.value = true
  try {
    const r = await a.stExtInject({ tavernPath: store.settings.tavernPath, user: store.settings.stUser })
    if (!r || !r.ok) showToast((r && r.error) || '注入失败')
    else showToast('已写入扩展 v' + (r.version || ext.value.latest || '') + '，去酒馆刷新一下界面')
  } catch (e) {
    showToast('注入异常：' + (e && e.message ? e.message : e))
  } finally {
    extBusy.value = false
  }
  await loadExt()
}

function goNext() {
  if (isLast.value) finish(false)
  else if (step.value === 0) confirmPath()
  else step.value += 1
}
function goPrev() {
  if (step.value > 0) step.value -= 1
}

/** silent=true 用于 ×：记住看过但不启动界面指引 */
function finish(silent) {
  finishFirstRun()
  if (silent) return
  startOnboardTour()
}
</script>

<template>
  <div class="mask">
    <div class="panel">
      <header>
        <div class="head">
          <h2>欢迎使用洛书匣</h2>
          <p class="sub">两步把资料库跑起来</p>
        </div>
        <button class="x" title="关闭（下次不再自动弹出）" @click="finish(true)">✕</button>
      </header>

      <nav class="steps">
        <button
          v-for="(s, i) in steps"
          :key="s.title"
          class="step"
          :class="{ on: i === step, done: i < step }"
          @click="step = i"
        >
          <span class="idx">{{ i + 1 }}</span>
          <span class="label">{{ s.title }}</span>
        </button>
      </nav>

      <div class="body">
        <h3>{{ steps[step].title }}</h3>
        <p class="desc">{{ steps[step].desc }}</p>

        <!-- 1. 酒馆安装目录 -->
        <template v-if="step === 0">
          <div class="field">
            <input v-model="store.settings.tavernPath" placeholder="酒馆安装目录" @keydown.enter="confirmPath" />
            <button class="ghost" @click="browsePath">浏览文件夹</button>
          </div>
        </template>

        <!-- 2. 装扩展 -->
        <template v-else-if="step === 1">
          <div class="row">
            <span class="k">API 地址</span>
            <span class="v">{{ apiUrl || '未识别' }}</span>
          </div>
          <div class="row">
            <span class="k">扩展状态</span>
            <span class="v">
              <b class="dot" :class="{ ok: ext.installed }"></b>
              <em :class="{ ok: ext.installed }">
                <template v-if="!ext.checked">读取中…</template>
                <template v-else-if="ext.installed">
                  已安装<template v-if="ext.version"> v{{ ext.version }}</template>
                  <template v-if="ext.latest && ext.version && ext.version !== ext.latest">（内置 v{{ ext.latest }}）</template>
                </template>
                <template v-else>未安装</template>
              </em>
            </span>
          </div>
          <div class="acts">
            <button class="primary" :disabled="extBusy" @click="injectExt">
              {{ extBusy ? '注入中…' : (ext.installed ? '重新注入' : '一键注入扩展') }}
            </button>
          </div>
          <p class="tip dim">注入后刷新一次酒馆界面生效。</p>
        </template>

        
      </div>

      <footer>
        <span class="state">{{ step + 1 }} / {{ steps.length }}</span>
        <div class="btns">
          <button class="ghost" v-if="step > 0" @click="goPrev">上一步</button>
          <button class="primary" :disabled="pathBusy" @click="goNext">
            {{ pathBusy ? '读取中…' : (isLast ? '开始使用' : '下一步') }}
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 520;
  background: var(--mask);
  backdrop-filter: blur(3px);
  display: grid;
  place-items: center;
}
.panel {
  width: min(600px, 92vw);
  max-height: 86vh;
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
  align-items: flex-start;
  gap: 10px;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--line-soft);
  background: linear-gradient(180deg, var(--overlay-1), transparent);
}
.head h2 { font-size: 15.5px; margin: 0; font-weight: 600; }
.head .sub { margin: 5px 0 0; font-size: 12px; color: var(--muted); }
.x {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--muted);
  font-size: 13px;
  padding: 2px 6px;
}
.x:hover { color: var(--text); background: var(--panel-2); }

.steps {
  display: flex;
  gap: 6px;
  padding: 12px 18px 4px;
}
.step {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: center;
  padding: 7px 4px;
  font-size: 12px;
  color: var(--muted);
  background: var(--panel-2);
  border: 1px solid var(--line-soft);
  border-radius: 9px;
}
.step .idx {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 17px;
  border-radius: 999px;
  font-size: 11px;
  background: var(--panel-3);
  color: var(--muted);
}
.step.on {
  color: var(--text);
  border-color: rgba(212, 162, 76, 0.5);
  background: var(--accent-dim);
}
.step.on .idx { background: linear-gradient(180deg, var(--accent-2), var(--accent)); color: #20180a; font-weight: 600; }
.step.done { color: var(--text-2); }
.step.done .idx { background: var(--ok); color: #08210f; font-weight: 600; }

.body {
  padding: 12px 18px 6px;
  min-height: 118px;
  overflow-y: auto;
}
h3 { font-size: 13.5px; margin: 6px 0 4px; font-weight: 600; }
.desc { margin: 0 0 12px; font-size: 12px; color: var(--muted); }

.field { display: flex; align-items: center; gap: 8px; }
.field input {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  font-size: 12.5px;
  color: var(--text);
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 8px;
}

.row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 7px 0;
  border-bottom: 1px dashed var(--line-soft);
  font-size: 12.5px;
}
.row .k { width: 96px; flex: none; color: var(--muted); }
.row .v { color: var(--text-2); word-break: break-all; display: inline-flex; align-items: center; gap: 6px; }
.row .v em { font-style: normal; color: var(--muted); }
.row .v em.ok { color: var(--ok); }

.dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--danger);
  flex: none;
}
.dot.ok { background: var(--ok); }

.tip { margin: 11px 0 0; font-size: 12px; line-height: 1.65; color: var(--text-2); }
.tip.dim { color: var(--muted); margin-top: 8px; }
.list { margin: 4px 0 0; padding-left: 18px; font-size: 12.5px; line-height: 1.95; color: var(--text-2); }
.list b { color: var(--text); font-weight: 600; }

.acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }

footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid var(--line-soft);
  background: var(--overlay-2);
}
.state { font-size: 12px; color: var(--muted); }
.btns { margin-left: auto; display: flex; gap: 8px; }
</style>
