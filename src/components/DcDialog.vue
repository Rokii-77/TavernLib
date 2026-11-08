<script setup>
import { store, closeDcDialog, dcDialogSave } from '../store.js'
import { cleanUrl } from '../lib/urlsafe.js'

function close() {
  if (store.dcDialog.busy) return
  closeDcDialog()
}

/** 粘贴时顺手洗一遍：去掉从网页复制带上的不可见字符 / 全角符号 */
function onPaste(ev) {
  const t = ev.clipboardData?.getData('text')
  if (!t) return
  ev.preventDefault()
  store.dcDialog.url = cleanUrl(t)
}

/** 保存：标题空着的话会自动去抓（见 store.dcDialogSave） */
function save() {
  dcDialogSave()
}
</script>

<template>
  <div class="mask" @click.self="close">
    <div class="panel">
      <header>
        <h2>DC 帖子链接</h2>
        <button class="x" :disabled="store.dcDialog.busy" @click="close">✕</button>
      </header>

      <div class="body">
        <label class="row">
          <span>帖子链接</span>
          <div class="field">
            <input
              v-model="store.dcDialog.url"
              placeholder="https://discord.com/channels/服务器ID/频道ID/消息ID"
              @paste="onPaste"
              @keyup.enter="save"
            />
          </div>
        </label>

        <label class="row">
          <span>帖子标题</span>
          <div class="field">
            <input
              v-model="store.dcDialog.title"
              placeholder="留空即可，保存时自动抓取；也可手动填写"
              @keyup.enter="save"
            />
          </div>
        </label>

        <p v-if="store.dcDialog.hint" class="tip">{{ store.dcDialog.hint }}</p>
      </div>

      <footer>
        <button :disabled="store.dcDialog.busy" @click="close">取消</button>
        <button class="primary" :disabled="store.dcDialog.busy" @click="save">
          {{ store.dcDialog.busy ? '正在抓取标题…' : '保存' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: var(--mask);
  backdrop-filter: blur(3px);
  display: grid;
  place-items: center;
  z-index: 500;
}
.panel {
  width: min(600px, 92vw);
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

.body { padding: 14px 18px 6px; }
.hint {
  margin: 0 0 14px;
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.7;
}
.row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.row > span { width: 74px; flex-shrink: 0; font-size: 12.5px; color: var(--text-2); }
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
.tip {
  margin: 2px 0 10px;
  font-size: 11.5px;
  color: #8f7c56;
  line-height: 1.6;
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px 15px;
  border-top: 1px solid var(--line-soft);
}
</style>
