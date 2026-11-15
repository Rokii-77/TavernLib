/**
 * 富文本预览：默认渲染态，右上角可切到源码。
 * 只负责「怎么显示」，不碰数据本身，也不参与导出。
 */
<script setup>
import { computed, ref, watch } from 'vue'
import { renderRichText, hasRichMarkup } from '../lib/richtext'

const props = defineProps({
  text: { type: String, default: '' },
  /** 正文最大高度（px）；传 0 / 不传表示不限高，由外层容器滚动 */
  maxHeight: { type: Number, default: 0 },
  /** 是否给「源码」切换入口；默认给，纯文本会自动隐藏 */
  toggle: { type: Boolean, default: true },
  /** 源码态的字号，跟随不同界面（详情页 11.5，弹层 12.5） */
  srcFontSize: { type: String, default: '12px' }
})

const mode = ref('render')
const raw = computed(() => String(props.text == null ? '' : props.text))
const html = computed(() => renderRichText(raw.value))
const canToggle = computed(() => props.toggle && hasRichMarkup(raw.value))
const bodyStyle = computed(() => (props.maxHeight > 0 ? { maxHeight: props.maxHeight + 'px' } : null))

/* 切换开场白 / 关闭重开时回到渲染态，别让上一页停在源码上 */
watch(() => props.text, () => { mode.value = 'render' })
</script>

<template>
  <div class="rt-wrap">
    <div v-if="canToggle" class="rt-bar">
      <button
        class="rt-toggle"
        :title="mode === 'render' ? '看原始源码' : '回到渲染效果'"
        @click.stop="mode = mode === 'render' ? 'source' : 'render'"
      >
        {{ mode === 'render' ? '源码' : '渲染' }}
      </button>
    </div>
    <pre v-if="mode === 'source'" class="rt-src" :style="{ fontSize: srcFontSize }">{{ raw }}</pre>
    <div
      v-else
      class="rt"
      :class="{ 'rt-limit': maxHeight > 0 }"
      :style="bodyStyle"
      v-html="html"
    ></div>
  </div>
</template>

<style scoped>
.rt-wrap { min-width: 0; }

/* 切换条放在正文上方、右对齐：绝不用绝对定位，免得压住长行文字 */
.rt-bar { display: flex; justify-content: flex-end; margin-bottom: 2px; }

.rt-toggle {
  padding: 1px 6px;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--muted);
  background: var(--panel-2);
  border: 1px solid var(--line-soft);
  border-radius: 5px;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.15s, color 0.15s, border-color 0.15s;
}
.rt-toggle:hover { opacity: 1; color: var(--accent-2); border-color: var(--accent); }

.rt {
  min-width: 0;
  word-break: break-word;
  overflow-wrap: anywhere;
  color: inherit;
  font-size: inherit;
  line-height: inherit;
}
.rt.rt-limit { overflow-y: auto; padding-right: 4px; }

/* 段落与换行 */
.rt :deep(p) { margin: 0 0 0.66em; }
.rt :deep(p:last-child) { margin-bottom: 0; }
.rt :deep(br) { line-height: inherit; }

/* 标题：酒馆卡里偶尔用，缩到正文尺度，避免把详情页撑爆 */
.rt :deep(h1),
.rt :deep(h2),
.rt :deep(h3),
.rt :deep(h4),
.rt :deep(h5),
.rt :deep(h6) {
  margin: 0.6em 0 0.4em;
  font-size: 1.06em;
  font-weight: 600;
  color: var(--text);
  line-height: 1.5;
}
.rt :deep(h1:first-child),
.rt :deep(h2:first-child),
.rt :deep(h3:first-child) { margin-top: 0; }

.rt :deep(strong), .rt :deep(b) { font-weight: 600; color: var(--text); }
.rt :deep(em), .rt :deep(i) { font-style: italic; }
.rt :deep(del), .rt :deep(s) { opacity: 0.7; }

/* 列表 */
.rt :deep(ul), .rt :deep(ol) { margin: 0 0 0.66em; padding-left: 1.5em; }
.rt :deep(ul:last-child), .rt :deep(ol:last-child) { margin-bottom: 0; }
.rt :deep(li) { margin: 0.16em 0; }
.rt :deep(ul) { list-style: disc; }
.rt :deep(ol) { list-style: decimal; }

/* 引用 / 分隔线 / 代码 */
.rt :deep(blockquote) {
  margin: 0 0 0.66em;
  padding: 2px 0 2px 10px;
  border-left: 2px solid var(--accent-dim);
  color: var(--muted);
}
.rt :deep(hr) { margin: 0.9em 0; border: 0; border-top: 1px solid var(--line-soft); }
.rt :deep(code) {
  padding: 1px 4px;
  font-family: Consolas, 'Cascadia Mono', monospace;
  font-size: 0.94em;
  background: var(--panel-3);
  border-radius: 4px;
}
.rt :deep(pre) {
  margin: 0 0 0.66em;
  padding: 8px 10px;
  overflow-x: auto;
  background: var(--panel-3);
  border-radius: 7px;
  white-space: pre;
}
.rt :deep(pre code) { padding: 0; background: transparent; }

/* 媒体：图片限宽，不溢出容器；坏图不留白框 */
.rt :deep(img) {
  display: block;
  max-width: 100%;
  max-height: 360px;
  height: auto;
  margin: 0.4em 0;
  border-radius: 7px;
  object-fit: contain;
}
.rt :deep(img:not([src])) { display: none; }

/* 链接无 href（已净化），只做视觉区分 */
.rt :deep(a) { color: var(--accent-2); text-decoration: underline dotted; cursor: default; }

/* 表格 */
.rt :deep(table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  margin: 0 0 0.66em;
  border-collapse: collapse;
  font-size: 0.96em;
}
.rt :deep(th), .rt :deep(td) {
  padding: 4px 8px;
  border: 1px solid var(--line-soft);
  text-align: left;
}
.rt :deep(th) { background: var(--panel-3); font-weight: 600; color: var(--text); }

/* 源码态 */
.rt-src {
  margin: 0;
  padding: 0;
  color: var(--muted);
  font-family: Consolas, 'Cascadia Mono', monospace;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}
</style>
