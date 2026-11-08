<template>
  <div class="tpv" :class="[device, kind]">
    <!-- 字体面板要拿 iframe 里真实的 getComputedStyle，所以先挂一个不可见的酒馆界面做探针 -->
    <iframe
      v-if="kind === 'font'"
      class="tpv-probe"
      :srcdoc="uiDoc"
      sandbox="allow-same-origin allow-scripts"
      title="字体探针"
    ></iframe>
    <iframe
      class="tpv-frame"
      :srcdoc="frameDoc"
      :sandbox="sandbox"
      :title="title"
    ></iframe>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { buildUiDoc, buildWrapDoc, buildFontDoc } from '../lib/tavernPreview.js'

const props = defineProps({
  /** ui = 可交互酒馆整体界面；wrap = 文本包裹对照表；font = 字体面板 */
  kind: { type: String, default: 'ui' },
  uiCss: { type: String, default: '' },
  themeCss: { type: String, default: '' },
  fields: { type: Object, default: null },
  /** desktop / mobile：手机端用窄屏宽度，媒体查询自然触发酒馆的窄屏表现 */
  device: { type: String, default: 'desktop' },
  baseHref: { type: String, default: '' },
  /** 预览头像：{ user, char } 为 dataURL，未上传用内置默认简笔人像 */
  avatars: { type: Object, default: null },
  /** 酒馆自带的字体图标样式表地址（顶栏图标要靠它） */
  faCssHref: { type: String, default: '' },
  /** 图标字体的 @font-face 内联 css（woff2 已转 data URL，不依赖 file:// 加载） */
  faFontCss: { type: String, default: '' },
  /** 自定义聊天背景图（dataURL）；空字符串 = 用美化自带背景 / 默认背景 */
  background: { type: String, default: '' }
})

const live = ref(null)

const sandbox = computed(() =>
  props.kind === 'ui' ? 'allow-same-origin allow-scripts' : 'allow-same-origin'
)

const title = computed(
  () => ({ ui: '酒馆整体预览', wrap: '文本包裹对照', font: '字体预览' }[props.kind] || '预览')
)

const baseArgs = computed(() => ({
  uiCss: props.uiCss,
  themeCss: props.themeCss,
  fields: props.fields,
  baseHref: props.baseHref
}))

const uiArgs = computed(() => ({
  ...baseArgs.value,
  avatars: props.avatars || {},
  faCssHref: props.faCssHref || '',
  faFontCss: props.faFontCss || '',
  background: props.background || ''
}))

const uiDoc = computed(() => buildUiDoc(uiArgs.value))

const frameDoc = computed(() => {
  if (props.kind === 'wrap') return buildWrapDoc(baseArgs.value)
  if (props.kind === 'font') return buildFontDoc({ ...baseArgs.value, live: live.value })
  return uiDoc.value
})

function onMessage(e) {
  const d = e.data
  if (d && d.__tavernPreview && d.fonts) live.value = d.fonts
}

onMounted(() => window.addEventListener('message', onMessage))
onBeforeUnmount(() => window.removeEventListener('message', onMessage))
</script>

<style scoped>
.tpv {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: stretch;
}
.tpv-frame {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
  background: #15161a;
}
/* 手机端：真实窄屏宽度，媒体查询才会命中酒馆自己的窄屏规则 */
.tpv.mobile {
  align-items: flex-start;
  padding: 0;
}
.tpv.mobile .tpv-frame {
  width: 390px;
  max-width: 100%;
  height: 100%;
  border: 1px solid rgba(127, 127, 127, 0.35);
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
}
.tpv-probe {
  position: absolute;
  width: 0;
  height: 0;
  border: 0;
  opacity: 0;
  pointer-events: none;
  left: -9999px;
}
</style>
