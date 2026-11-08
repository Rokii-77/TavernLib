/**
 * 酒馆预览文档构建器
 *
 * 目标：不再是「骨架图」，而是按酒馆真实渲染链路还原一整个酒馆界面：
 *   1. 酒馆自己的 public/style.css + css/toggle-dependent.css 打底（选择器 / 布局完全对齐）
 *   2. 主题 JSON 的外观字段映射成 --SmartTheme* 变量（照 power-user.js 的映射）
 *   3. 主题 JSON 的开关字段映射成 body class（bubblechat / square-avatars / noShadows …）
 *   4. 主题自带的 customCSS 原样注入（美化的主要来源）
 *   5. DOM 对齐酒馆真实结构：#top-bar / #top-settings-holder(.drawer>.drawer-toggle+.drawer-content)
 *      / #sheld / #chat>.mes(.mesAvatarWrapper>.avatar, .mes_block>.ch_name+.mes_text) / #form_sheld>#send_form
 *
 * 消息正文用 tavernFormat() 渲染（和酒馆 messageFormatting 同一套规则），
 * 所以引号包裹、*斜体*、~~删除线~~ 这些在预览里的表现和酒馆里一致。
 */
import { tavernFormat, WRAP_CASES, fontFacesOf, cssFontFamiliesOf, splitFamilies } from './tavernFormat.js'

/* 酒馆把主题字段写进这些 CSS 变量（power-user.js 的映射，改一个都还原不准） */
export const THEME_COLOR_VARS = [
  ['main_text_color', '--SmartThemeBodyColor'],
  ['italics_text_color', '--SmartThemeEmColor'],
  ['underline_text_color', '--SmartThemeUnderlineColor'],
  ['quote_text_color', '--SmartThemeQuoteColor'],
  ['blur_tint_color', '--SmartThemeBlurTintColor'],
  ['chat_tint_color', '--SmartThemeChatTintColor'],
  ['user_mes_blur_tint_color', '--SmartThemeUserMesBlurTintColor'],
  ['bot_mes_blur_tint_color', '--SmartThemeBotMesBlurTintColor'],
  ['shadow_color', '--SmartThemeShadowColor'],
  ['border_color', '--SmartThemeBorderColor']
]

/** 主题字段 → CSS 变量（颜色 + 模糊 + 阴影 + 字号缩放 + 聊天列宽度） */
export function themeVarCss(th) {
  if (!th) return ''
  const out = []
  for (const [k, v] of THEME_COLOR_VARS) {
    if (th[k] != null && String(th[k]).trim()) out.push(`${v}: ${th[k]};`)
  }
  if (th.blur_strength != null) out.push(`--blurStrength: ${Number(th.blur_strength) || 0};`)
  if (th.shadow_width != null) out.push(`--shadowWidth: ${Number(th.shadow_width) || 0};`)
  if (th.font_scale != null) out.push(`--fontScale: ${Number(th.font_scale) || 1};`)
  if (th.chat_width != null) out.push(`--sheldWidth: ${Number(th.chat_width) || 50}vw;`)
  if (!out.length) return ''
  return `:root, body { ${out.join(' ')} }`
}

/** 主题字段 → body 上的开关类（气泡 / 文档样式 / 头像形状 / 无阴影等） */
export function themeBodyClass(th) {
  const cls = []
  if (!th) return cls
  if (Number(th.chat_display) === 1) cls.push('bubblechat')
  if (Number(th.chat_display) === 2) cls.push('documentstyle')
  const av = Number(th.avatar_style)
  if (av === 1) cls.push('big-avatars')
  else if (av === 2) cls.push('square-avatars')
  else cls.push('rounded-avatars')
  if (th.noShadows) cls.push('noShadows')
  if (th.waifuMode) cls.push('waifuMode')
  if (th.reduced_motion) cls.push('reduced-motion')
  if (th.compact_input_area) cls.push('compact_input_area')
  if (th.hideChatAvatars_enabled) cls.push('hideChatAvatars')
  if (th.expand_message_actions) cls.push('expandMessageActions')
  if (th.fast_ui_mode) cls.push('fast_ui_mode')
  return cls
}

/* 预览头像用内联 SVG：不依赖酒馆目录里的图片文件，换机器也能看。
   画成简笔人像而不是纯色块——有些美化（如《藏书》）会把人像放大到几百像素当立绘，
   纯色块放大后就是一块死色，看不出这套美化到底长什么样。 */
function avatarSvg(a, b, skin) {
  const hair = a === '#7b6cc4' ? '#1b1826' : a === '#3f6f8f' ? '#1a2430' : '#241a12'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 160" width="120" height="160">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>
<radialGradient id="glow" cx="0.5" cy="0.3" r="0.75"><stop offset="0" stop-color="#ffffff" stop-opacity="0.20"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
<radialGradient id="vig" cx="0.5" cy="0.45" r="0.8"><stop offset="0.55" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.42"/></radialGradient>
</defs>
<rect width="120" height="160" fill="url(#bg)"/>
<rect width="120" height="160" fill="url(#glow)"/>
<ellipse cx="60" cy="150" rx="52" ry="42" fill="${skin}" opacity="0.72"/>
<path d="M34 150 q4 -30 26 -30 q22 0 26 30z" fill="${skin}" opacity="0.9"/>
<ellipse cx="60" cy="82" rx="20" ry="24" fill="${skin}"/>
<path d="M39 78 q3 -26 21 -26 q18 0 21 26 q-8 -14 -21 -14 q-13 0 -21 14z" fill="${hair}" opacity="0.92"/>
<ellipse cx="52" cy="84" rx="2.4" ry="3" fill="${hair}" opacity="0.85"/>
<ellipse cx="68" cy="84" rx="2.4" ry="3" fill="${hair}" opacity="0.85"/>
<path d="M55 96 q5 3 10 0" stroke="${hair}" stroke-width="1.6" fill="none" opacity="0.55" stroke-linecap="round"/>
<rect width="120" height="160" fill="url(#vig)"/>
</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/* 三个演示角色：头像 + 开场消息（消息正文都带包裹写法，方便一眼看出这套美化的文字效果） */
export const DEMO_CHARS = [
  {
    name: '阿德勒',
    title: '旅店老板',
    avatar: avatarSvg('#7b6cc4', '#2b2d3a', '#0e0f14'),
    greeting: [
      '欢迎光临，冒险者。\n\n今晚想听点什么故事？麦酒刚开桶，*还带着凉气*。',
      '> 有人说，夜里能听见旧朝的钟声。\n\n**这座城**建在旧河床上，地底下还埋着上一个王朝的城墙。',
      '他敲了敲杯沿，「要续一杯吗？」——*不过得先把这杯的价钱听完*。'
    ],
    replies: [
      '阿德勒擦着杯子抬头："别在午夜过后往北墙走。"\n\n`# 传闻` 墙上刻着一句话，字迹被人用刀刮掉了。',
      '「这杯算我的。」他把杯子推过来，`~~三枚银币~~` 划掉，改成了两枚。',
      '# 酒馆规矩\n\n- 不许在店里动刀\n- 赊账记在墙上\n- 打烊前把杯子放回架子上\n\n---\n\n*违反的人，下次就得站着喝了。*'
    ]
  },
  {
    name: '莉娅',
    title: '银月法师',
    avatar: avatarSvg('#3f6f8f', '#1f2831', '#0b0d11'),
    greeting: [
      '_星图_不是画出来的，是**记**下来的。\n\n她把手指按在纸面上，蓝色墨水顺着指缝爬开。',
      '“别碰那个符文。”她没回头，`~~语气倒是很平静~~`，手已经按在了法杖上。'
    ],
    replies: [
      '莉娅翻开书，声音压低：「这一页讲的是 **逆向召唤**，`代价` 写在页脚，字很小。」',
      '> 月亮只有一个，但你看见的那个不一定是同一个月亮。\n\n她合上书，*没再解释*。'
    ]
  },
  {
    name: '卡兰',
    title: '佣兵',
    avatar: avatarSvg('#8f6b3f', '#2a2118', '#120d09'),
    greeting: [
      '**任务简报**：`哥布林营地` 在北坡，三个人守夜，两个人睡觉。\n\n---\n\n1. 别点火\n2. 别说话\n3. 别回头',
      '他把刀往桌上一放，"先说好，`~~五十枚~~` **八十枚**，少一个铜板我都不去。"'
    ],
    replies: [
      '卡兰咧嘴笑了笑：「放心，我数得比你清楚。」\n\n*他从来没数错过。*',
      '> 死人不会讨价还价。\n\n「所以我还活着的时候，价钱得谈明白。」'
    ]
  }
]

/* ---------------- 模板片段 ---------------- */

function glyph(ch, extra = '') {
  return `<span class="tp-glyph"${extra}>${ch}</span>`
}

/* 角色卡条目：完全照 #character_template 的结构克隆（avatar / character_select_container /
   character_name_block / ch_fav_icon / ch_description / tags），
   这样 st-tailwind 的 flex 类和 style.css 里 .character_select 那套规则才有落点。 */
function characterItem(c, i) {
  return `<div class="character_select entity_block flex-container wide100p alignitemsflexstart" data-idx="${i}" chid="${i}" title="${escapeAttr(c.title)}">
      <div class="avatar" title="${escapeAttr(c.name)}"><img src="${c.avatar}" alt="${escapeAttr(c.name)}"></div>
      <div class="flex-container wide100pLess70px character_select_container">
        <div class="wide100p character_name_block">
          <span class="ch_name">${escapeHtml(c.name)}</span>
          <small class="ch_additional_info character_version">1.0</small>
        </div>
        <i class="ch_fav_icon fa-solid fa-star"></i>
        <div class="ch_description">${escapeHtml(c.title)}</div>
        <div class="tags tags_inline"><span class="tag"><span class="tag_name">${escapeHtml((c.tags || ['角色卡'])[0])}</span></span></div>
      </div>
    </div>`
}

/* 角色管理面板（#right-nav-panel）：按酒馆真实 DOM 逐层重建，
   外壳、按钮栏、搜索、标签、分页、列表容器一个不少，只把数据换成演示角色。
   以前这里只塞了一个 tp-panel-head + 一个搜索框，CSS 里的高度/滚动/flex 规则全落空，所以看起来「变形」。 */
function rightNavHtml(chars) {
  return `<div id="CharListButtonAndHotSwaps" class="flex-container flexnowrap">
        <div class="flexFlowColumn flex-container">
          <div id="rm_button_panel_pin_div" class="alignitemsflexstart" title="Locked = Character Management panel will stay open">
            <input type="checkbox" id="rm_button_panel_pin">
            <label for="rm_button_panel_pin">
              <div class="fa-solid unchecked fa-unlock right_menu_button" alt=""></div>
              <div class="fa-solid checked fa-lock right_menu_button" alt=""></div>
            </label>
          </div>
          <div class="right_menu_button fa-solid fa-list-ul" id="rm_button_characters" title="Select/Create Characters"></div>
        </div>
        <div id="HotSwapWrapper" class="alignitemscenter flex-container margin0auto wide100p">
          <div class="hotswap avatars_inline scroll-reset-container expander" no_favs="Favorite characters to add them to HotSwaps"></div>
        </div>
      </div>
      <div id="rm_PinAndTabs">
        <div id="right-nav-panel-tabs">
          <div id="rm_button_selected_ch"><h2 class="interactable">角色管理</h2></div>
          <div id="result_info" class="flex-container" style="display:none;"></div>
        </div>
        <div name="Character List Panel" id="rm_characters_block" class="right_menu">
          <div id="charListFixedTop">
            <div id="rm_button_bar">
              <div id="rm_button_create" title="Create New Character" class="menu_button fa-solid fa-user-plus"></div>
              <div id="character_import_button" title="Import Character from File" class="menu_button fa-solid fa-file-import"></div>
              <div id="external_import_button" title="Import content from external URL" class="menu_button fa-solid fa-cloud-arrow-down"></div>
              <div id="rm_button_group_chats" title="Create New Chat Group" class="menu_button fa-solid fa-users-gear"></div>
              <div id="rm_buttons_container"></div>
              <select id="character_sort_order" class="flex1 text_pole textarea_compact" title="Characters sorting order">
                <option>A-Z</option><option>Z-A</option><option>Newest</option><option>Recent</option>
              </select>
              <div id="rm_button_search" class="right_menu_button fa-fw fa-solid fa-search" title="Toggle search bar"></div>
            </div>
            <div id="form_character_search_form">
              <input id="character_search_bar" class="text_pole textarea_compact width100p" type="search" placeholder="搜索角色…">
            </div>
            <div class="rm_tag_controls">
              <div class="tags rm_tag_filter"></div>
              <div class="tags rm_tag_bogus_drilldown"></div>
            </div>
          </div>
          <div id="rm_print_characters_pagination">
            <i id="charListGridToggle" class="fa-solid fa-table-cells-large menu_button" title="Toggle character grid view"></i>
            <i id="bulkEditButton" class="fa-solid fa-edit menu_button bulkEditButton" title="Bulk edit characters"></i>
            <div id="bulkSelectedCount" class="bulkEditOptionElement paginationjs-nav"></div>
          </div>
          <div id="rm_print_characters_block" class="flexFlowColumn">${chars}</div>
        </div>
      </div>`
}

function mesHtml({ user, name, avatar, text, id }) {
  const body = tavernFormat(text)
  if (user) {
    return `<div class="mes" is_user="true" is_system="false" is_name="true" name="${escapeAttr(name)}" ch_name="${escapeAttr(name)}" mesid="${id}">
      <div class="mesAvatarWrapper"><div class="avatar"><img src="${avatar}" alt="${escapeAttr(name)}"></div><div class="mesIDDisplay">#${id}</div></div>
      <div class="mes_block"><div class="ch_name flex-container alignitemscenter"><span class="name_text">${escapeHtml(name)}</span>
        <div class="mes_buttons"><div class="mes_button" title="编辑">✎</div><div class="mes_button" title="删除">✕</div></div></div>
        <div class="mes_text">${body}</div>
      </div>
    </div>`
  }
  return `<div class="mes" is_user="false" is_system="false" is_name="true" name="${escapeAttr(name)}" ch_name="${escapeAttr(name)}" mesid="${id}">
    <div class="mesAvatarWrapper"><div class="avatar"><img src="${avatar}" alt="${escapeAttr(name)}"></div><div class="mesIDDisplay">#${id}</div></div>
    <div class="mes_block"><div class="ch_name flex-container alignitemscenter"><span class="name_text">${escapeHtml(name)}</span>
      <div class="mes_buttons"><div class="mes_button" title="滑动">⇄</div><div class="mes_button" title="编辑">✎</div><div class="mes_button" title="删除">✕</div></div></div>
      <div class="mes_text">${body}</div>
    </div>
  </div>`
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
export function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

/* 预览里的「用户台词」：与角色开场白交替出现，凑成多轮对话 */
const USER_LINES = [
  '*把斗篷上的雪抖掉* "一杯热的，随便什么都行。"',
  '"你刚才说的旧朝钟声，**具体是几点**？"我把椅子往前挪了挪。',
  '"要是我偏要往北墙走呢？"',
  '「那就再续一杯。」我把杯子推过去，`叮` 的一声磕在桌沿。'
]

export function buildChatSeed(avatars = {}) {
  const meAvatar = (avatars && avatars.user) || AVATAR_ME
  return DEMO_CHARS.map((c, ci) => {
    // 上传的角色头像只作用于当前展示的首个角色，其余角色保持默认头像
    const charAvatar = ci === 0 && avatars && avatars.char ? avatars.char : c.avatar
    const script = [
      { user: false, text: c.greeting[0] },
      { user: true, text: USER_LINES[0] },
      { user: false, text: c.greeting[1] || c.greeting[0] },
      { user: true, text: USER_LINES[1] },
      { user: false, text: c.replies[0] },
      { user: true, text: USER_LINES[2] },
      { user: false, text: c.replies[1] || c.replies[0] },
      { user: true, text: USER_LINES[3] }
    ]
    const list = script.map((m, id) =>
      mesHtml({
        user: m.user,
        name: m.user ? '你' : c.name,
        avatar: m.user ? meAvatar : charAvatar,
        text: m.text,
        id
      })
    )
    return { ...c, avatar: charAvatar, messages: list, html: list.join('') }
  })
}

const AVATAR_ME = avatarSvg('#4a4f5e', '#22242c', '#0a0b0e')

/* ---------------- 文档骨架 ---------------- */

const FALLBACK_UI_CSS = `:root{--bg:#15161a;--fg:#e9e9ee;--panel:#1f2128}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px/1.6 "Segoe UI",system-ui,sans-serif;overflow:hidden}
#top-bar{height:44px;width:100%;background:#1b1d23}
#top-settings-holder{position:absolute;top:0;left:0;right:0;display:flex;gap:4px;padding:4px 8px;z-index:3005}
.drawer-header{width:36px;height:36px}
.drawer-icon{display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:8px;background:#262932;color:#cfd2dd;cursor:pointer}
.drawer-content{position:absolute;top:44px;background:#1e2027;border:1px solid #2c3039;border-radius:10px;padding:10px;min-width:220px}
.fillLeft{left:8px}.fillRight{right:8px}
.closedDrawer{display:none}.openDrawer{display:block}
#sheld{position:absolute;left:calc((100vw - var(--sheldWidth,50vw))/2);top:44px;width:var(--sheldWidth,50vw);height:calc(100vh - 45px);display:flex;flex-direction:column}
#chat{flex:1 1 auto;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:10px}
.mes{display:flex;gap:8px;background:#1f2128;border-radius:10px;padding:8px 10px}
.avatar img{width:44px;height:58px;border-radius:8px;object-fit:cover}
.mes_text{line-height:1.6}
#send_form{display:flex;border-top:1px solid #2a2c34;padding:6px}
#send_textarea{flex:1;resize:none;height:36px;background:#24262d;color:inherit;border:1px solid #32353f;border-radius:8px;padding:6px 8px}`

/** 酒馆界面缺失时的兜底布局（没有 FA 图标字体，用文字符号顶上） */
const GLYPH_CSS = `
/* 预览里没有字体图标文件，用文字符号代替 fa- 图标，尺寸跟着酒馆变量走 */
.tp-glyph { display:inline-block; line-height:1; font-size: calc(var(--mainFontSize, 15px) * 0.95); }
.drawer-icon { display:flex; align-items:center; justify-content:center; }
.character_select { cursor:pointer; }
.character_select.sel { outline: 1px solid var(--SmartThemeQuoteColor, #e2892e); }
#send_but, #options_button { display:flex; align-items:center; justify-content:center; cursor:pointer; }
.mes_button { cursor:pointer; }
/* 消息头像：尺寸完全交给酒馆与主题自己定（有的美化就是大图人像卡片），这里只兜一个不溢出 */
#chat .mes > .mesAvatarWrapper { max-width: 100%; }
#chat .mes > .mesAvatarWrapper .avatar img { max-width: 100%; object-fit: cover; }
/* 预览专用：让整个酒馆在 iframe 里刚好铺满，不出现外层的双重滚动条 */
html.tp-root, html.tp-root body { height:100%; }
html.tp-root body { overflow:hidden; }
/* 手机端：酒馆在窄屏就是整列铺满，聊天列宽度不再受 chat_width 限制 */
@media (max-width: 1000px) {
  :root, body { --sheldWidth: 100vw !important; }
  #sheld { left: 0 !important; width: 100vw !important; }
  #top-bar { width: 100vw !important; }
}
`

function shell({ uiCss, themeCss, fields, baseHref, bodyClass, extraCss, body, fontAwesomeHref, faFontCss }) {
  const vars = themeVarCss(fields)
  const cls = ['tp-root', ...(bodyClass || [])].join(' ')
  return `<!doctype html>
<html class="tp-root">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${baseHref ? `<base href="${escapeAttr(baseHref)}">` : ''}
${fontAwesomeHref ? `<link rel="stylesheet" href="${escapeAttr(fontAwesomeHref)}">` : ''}
${fontAwesomeHref ? `<link rel="stylesheet" href="${escapeAttr(fontAwesomeHref.replace(/fontawesome\.min\.css$/, 'solid.min.css'))}">` : ''}
${faFontCss ? `<style>${faFontCss}</style>` : ''}
<style>${uiCss && uiCss.trim() ? uiCss : FALLBACK_UI_CSS}</style>
<style>${vars}</style>
<style>${themeCss || ''}</style>
<style>${GLYPH_CSS}</style>
<style>${extraCss || ''}</style>
</head>
<body class="${cls}">
${body}
</body>
</html>`
}

/* ---------------- 1. 整体酒馆界面（可交互） ---------------- */

/* 酒馆顶栏一级菜单：id / 图标 / 面板 id 全部照抄酒馆真实 DOM，
   这样美化里针对 .drawer-icon、#leftNavDrawerIcon、#right-nav-panel 之类的规则都能命中。 */
const TOP_DRAWERS = [
  {
    drawer: 'ai-config-button', iconId: 'leftNavDrawerIcon', icon: 'fa-sliders', glyph: '≡',
    title: 'AI 响应配置', label: 'AI Response Configuration',
    panel: 'left-nav-panel', panelClass: 'drawer-content fillLeft closedDrawer', headId: 'left-nav-panelheader', lines: 3,
    groups: ['预设', '生成参数', '提示词']
  },
  {
    drawer: 'settings-button', iconId: 'API-status-top', icon: 'fa-plug-circle-exclamation', glyph: '⏻',
    title: 'API 连接', label: 'API Connections',
    panel: 'rm_api_block', panelClass: 'drawer-content closedDrawer', lines: 3,
    groups: ['连接配置', '模型列表']
  },
  {
    drawer: 'advanced-formatting-button', iconId: '', icon: 'fa-font', glyph: 'A',
    title: 'AI 回复格式化', label: 'AI Response Formatting',
    panel: 'AdvancedFormatting', panelClass: 'drawer-content closedDrawer', lines: 3,
    groups: ['上下文模板', 'Macros 宏替换']
  },
  {
    drawer: 'WI-SP-button', iconId: 'WIDrawerIcon', icon: 'fa-book-atlas', glyph: '❖',
    title: '世界书', label: 'World Info',
    panel: 'WorldInfo', panelClass: 'drawer-content closedDrawer', lines: 3,
    groups: ['世界书选择', '条目列表']
  },
  {
    drawer: 'user-settings-button', iconId: '', icon: 'fa-user-cog', glyph: '⚙',
    title: '用户设置', label: 'User Settings',
    panel: 'user-settings-block', panelClass: 'drawer-content closedDrawer', lines: 3,
    groups: ['主题与外观', '界面语言', '账号']
  },
  {
    drawer: 'backgrounds-button', iconId: '', toggleId: 'backgrounds-drawer-toggle', icon: 'fa-panorama', glyph: '▣',
    title: '背景', label: 'Backgrounds',
    panel: 'Backgrounds', panelClass: 'drawer-content closedDrawer bg-drawer-layout', lines: 2,
    groups: ['背景图库']
  },
  {
    drawer: 'extensions-settings-button', iconId: '', icon: 'fa-cubes', glyph: '⬢',
    title: '扩展', label: 'Extensions',
    panel: 'rm_extensions_block', panelClass: 'drawer-content closedDrawer', lines: 3,
    groups: ['已安装扩展', '安装扩展']
  },
  {
    drawer: 'persona-management-button', iconId: '', icon: 'fa-face-smile', glyph: '☺',
    title: 'Persona 管理', label: 'Persona Management',
    panel: 'PersonaManagement', panelClass: 'drawer-content closedDrawer', lines: 3,
    groups: ['我的 Persona', '描述']
  },
  {
    drawer: 'rightNavHolder', iconId: 'rightNavDrawerIcon', toggleId: 'unimportantYes', icon: 'fa-address-card', glyph: '▤',
    title: '角色管理', label: 'Character Management',
    panel: 'right-nav-panel', panelTag: 'nav', panelClass: 'drawer-content closedDrawer fillRight', headId: 'right-nav-panelheader', lines: 0
  }
]

/* 面板外壳：标题 + 酒馆式的分组标题（.inline-drawer-header）+ 空内容骨架。
   只放外壳不放真实功能，目的是让美化对面板、分组标题、输入框的样式都能作用到。 */
function panelShellHtml(d) {
  const groups = (d.groups && d.groups.length ? d.groups : ['基础设置'])
  const body = groups.map((g, gi) => {
    const n = gi === 0 ? (d.lines || 3) + 3 : 3
    const rows = Array.from({ length: n }, (_, i) => {
      const a = 32 + ((i * 17 + gi * 9) % 32)
      const b = 20 + ((i * 11 + gi * 7) % 24)
      return `<div class="tp-skel-row"><span class="tp-skel" style="width:${a}%"></span><span class="tp-skel" style="width:${b}%"></span></div>`
    }).join('')
    const first = gi === 0
    return `<div class="inline-drawer${first ? ' openIcon' : ''}">
      <div class="inline-drawer-toggle inline-drawer-header"><b>${escapeHtml(g)}</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-${first ? 'up' : 'down'} ${first ? 'up' : 'down'}"></div></div>
      <div class="inline-drawer-content"${first ? ' style="display:block"' : ''}>${rows}</div>
    </div>`
  }).join('')
  return `<div class="tp-panel-head"><b class="tp-panel-title">${escapeHtml(d.title)}</b><span class="tp-panel-label">${escapeHtml(d.label)}</span></div>
      ${body}`
}

/* 整体界面预览专用样式：
   1) 顶栏抽屉一律按酒馆默认位置渲染，屏蔽掉任何自定义 left/right/transform 造成的偏移
   2) 图标字体缺失时退回文字符号，保证顶栏图标齐全 */
const UI_FORCE_CSS = `
/* ---- 布局基准：一律用酒馆默认值 ----
   面板「打开后跑到最右面」的根因是 --sheldWidth 被用户设置/主题字段改得极小，
   .fillLeft/.fillRight 的宽度算出来是 calc((100vw - sheldWidth)/2)，sheldWidth≈0 时就把面板推到边界外。
   预览里不看这个设置，直接按酒馆默认的 50vw 渲染，位置即默认位置。 */
:root, body { --sheldWidth: 50vw !important; }
@media (max-width: 1000px) { :root, body { --sheldWidth: 100vw !important; } }
/* 贴左 / 贴右面板：明确定位，杜绝任何 left 计算式把人推出屏幕 */
.drawer-content { transform: none !important; }
.fillLeft { left: 0 !important; right: auto !important; transform: none !important; }
.fillRight { left: auto !important; right: 0 !important; transform: none !important; }
@media (max-width: 1000px) {
  .drawer-content, .drawer-content.fillLeft, .drawer-content.fillRight {
    left: 0 !important; right: 0 !important; margin-left: 0 !important; margin-right: 0 !important; }
}
/* ---- 面板外壳骨架（只在预览里用） ---- */
.tp-panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  padding: 6px 2px 8px; border-bottom: 1px solid var(--SmartThemeBorderColor, #3b3e47); margin-bottom: 8px; }
.tp-panel-title { font-weight: 600; }
.tp-panel-label { font-size: calc(var(--mainFontSize, 15px) * 0.76); opacity: .5; letter-spacing: .02em; }
.tp-skel-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 7px 0; }
.tp-skel { display: block; height: calc(var(--mainFontSize, 15px) * 0.82); border-radius: 6px;
  background: currentColor; opacity: .13; }
.tp-search { margin: 0 0 8px; }
.tp-search .text_pole { width: 100%; }
/* ---- 顶栏图标兜底：字体图标不可用时用文字符号顶上，保证图标齐全 ---- */
.drawer-icon .tp-glyph { display: none; }
body.no-fa .drawer-icon .tp-glyph { display: inline-block; }
body.no-fa .drawer-icon::before { content: none !important; }
/* ---- 角色管理面板：不再强行改高度/滚动 ----
   酒馆自身规则就是 #rm_PinAndTabs 为 flex-wrap 行、#rm_characters_block 高 100%（父高 auto 时按内容撑开）、
   面板 .drawer-content.openDrawer 自己 overflow-y:auto 滚动。之前的预览塞的是骨架 div，这层关系全落空才显得变形。
   现在 DOM 已与酒馆一致，这里只保留一条密度微调，其余交给酒馆样式。 */
#right-nav-panel .character_select { margin-bottom: 2px; }
/* 输入框只是外观展示，接受不了输入 */
#send_textarea { cursor: default; }
`

export function buildUiDoc({ uiCss, themeCss, fields, baseHref, avatars, faCssHref, faFontCss, background }) {
  const seed = buildChatSeed(avatars || {})
  const chars = seed.map(characterItem).join('')
  const firstChat = seed[0].html
  const fv = (k, d) => (fields && fields[k] != null && fields[k] !== '' ? fields[k] : d)

  const drawers = TOP_DRAWERS.map((d) => {
    const tag = d.panelTag || 'div'
    const toggleId = d.toggleId ? ` id="${d.toggleId}"` : ''
    const iconId = d.iconId ? ` id="${d.iconId}"` : ''
    const inner = d.panel === 'right-nav-panel'
      ? rightNavHtml(chars)
      : panelShellHtml(d)
    return `  <div id="${d.drawer}" class="drawer">
    <div${toggleId} class="drawer-toggle drawer-header">
      <div${iconId} class="drawer-icon fa-solid ${d.icon} fa-fw closedIcon" title="${escapeAttr(d.title)}" data-i18n="[title]${escapeAttr(d.label)}">${glyph(d.glyph)}</div>
    </div>
    <${tag} id="${d.panel}" class="${d.panelClass}">
      ${d.headId ? `<div id="${d.headId}" class="fa-solid fa-grip drag-grabber"></div>` : ''}
      ${inner}
    </${tag}>
  </div>`
  }).join('\n')

  const bgUrl = String(background || '').trim()
  const bgStyle = bgUrl ? ` style="background-image:url('${bgUrl.replace(/'/g, "%27")}')"` : ''
  const body = `
<!-- 背景层：和酒馆一样是 #bg1（position:absolute; z-index:-1; background-size:cover），
     聊天列 #chat / 顶栏 #top-bar 上的 backdrop-filter + --SmartThemeBlurTintColor / ChatTintColor
     就是叠在它上面的 tint 与模糊，所以换成自己的图也还是美化原本的观感 -->
<div id="bg1" class="cover"${bgStyle}></div>
<div id="top-bar"></div>
<div id="top-settings-holder">
${drawers}
</div>

<div id="sheld">
  <div id="sheldheader" class="drag-grabber"></div>
  <div id="chat">${firstChat}</div>
  <div id="form_sheld">
    <div id="send_form" class="no-connection">
      <div id="nonQRFormItems">
        <div id="leftSendForm" class="alignContentCenter">
          <div id="options_button" class="interactable" title="选项">${glyph('☰')}</div>
        </div>
        <textarea id="send_textarea" name="text" readonly placeholder="界面预览：输入框仅作外观展示，不发送消息"></textarea>
        <div id="rightSendForm" class="alignContentCenter">
          <div id="send_but" class="interactable" title="发送">${glyph('➤')}</div>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
(function(){
  var DATA = __DATA__;
  var chat = document.getElementById('chat');

  function closeAll(){
    document.querySelectorAll('.drawer-content').forEach(function(x){ x.classList.add('closedDrawer'); x.classList.remove('openDrawer'); });
    document.querySelectorAll('.drawer-icon').forEach(function(x){ x.classList.add('closedIcon'); x.classList.remove('openIcon'); });
  }

  /* 图标字体判定：先显式 load 一次再问 check()。
     之前的问题是 document.fonts.check() 在字体尚未被使用过时也会返回 false，
     会被误判成「没有图标」，进而给 body 加 .no-fa 把美化自己替换的图标一起压掉。
     现在的策略：
       - 字体可用 → 一律走真图标（美化自行替换字形/图片也能正常显示）；
       - 字体不可用 → 只有美化完全没给 ::before 内容（content 为 none/normal）时，
         才退回内置文字符号，避免出现空白按钮。 */
  function refreshFa(){
    function judge(){
      try {
        var fonts = document.fonts;
        var faOk = true;
        try { faOk = fonts ? fonts.check('900 16px "Font Awesome 6 Free"') : true; } catch (_) { faOk = true; }
        if (faOk) { document.body.classList.remove('no-fa'); return; }
        var probe = document.querySelector('#top-settings-holder .drawer-icon');
        var c = probe ? getComputedStyle(probe, '::before').content : 'none';
        var noThemeGlyph = !c || c === 'none' || c === 'normal';
        document.body.classList.toggle('no-fa', noThemeGlyph);
      } catch (e) { /* 判定失败就保持默认（不显示文字符号，避免和美化图标重叠） */ }
    }
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('900 16px "Font Awesome 6 Free"').then(judge, judge);
        return;
      }
    } catch (_) {}
    judge();
  }
  refreshFa();

  function toBottom(){
    if (chat) chat.scrollTop = chat.scrollHeight;
  }

  /* 顶栏抽屉：点图标开合，一次只开一个，点面板外关闭（和酒馆一致） */
  document.querySelectorAll('#top-settings-holder .drawer').forEach(function(d){
    var t = d.querySelector('.drawer-toggle');
    var c = d.querySelector('.drawer-content');
    if (!t || !c) return;
    t.addEventListener('click', function(ev){
      ev.stopPropagation();
      var willOpen = c.classList.contains('closedDrawer');
      closeAll();
      if (willOpen) {
        c.classList.remove('closedDrawer');
        c.classList.add('openDrawer');
        var ic = t.querySelector('.drawer-icon');
        if (ic) { ic.classList.remove('closedIcon'); ic.classList.add('openIcon'); }
        var sc = c.querySelector('#chat');
        if (sc) sc.scrollTop = sc.scrollHeight;
      }
    });
    c.addEventListener('click', function(ev){ ev.stopPropagation(); });
  });
  document.addEventListener('click', function(ev){
    if (ev.target && ev.target.closest && ev.target.closest('#top-settings-holder')) return;
    closeAll();
  });

  /* 面板内分组标题：点击展开 / 收起，仅是外观演示 */
  document.querySelectorAll('.inline-drawer-toggle').forEach(function(h){
    h.addEventListener('click', function(ev){
      ev.stopPropagation();
      var box = h.parentNode.querySelector('.inline-drawer-content');
      if (!box) return;
      var open = box.style.display !== 'block';
      box.style.display = open ? 'block' : 'none';
      var ic = h.querySelector('.inline-drawer-icon');
      if (ic) {
        ic.classList.toggle('fa-circle-chevron-up', open);
        ic.classList.toggle('fa-circle-chevron-down', !open);
        ic.classList.toggle('up', open);
        ic.classList.toggle('down', !open);
      }
    });
  });

  /* 角色切换：只换已有对话，不发送任何消息 */
  document.querySelectorAll('.character_select').forEach(function(el){
    el.addEventListener('click', function(ev){
      ev.stopPropagation();
      var idx = Number(el.getAttribute('data-idx') || 0);
      var c = DATA.chars[idx];
      if (!c) return;
      document.querySelectorAll('.character_select').forEach(function(x){ x.classList.remove('sel'); });
      el.classList.add('sel');
      if (chat) chat.innerHTML = c.html;
      toBottom();
    });
  });

  /* 点顶栏图标时先把当前角色标出来 */
  var sel0 = document.querySelector('.character_select');
  if (sel0) sel0.classList.add('sel');

  window.addEventListener('load', function(){ refreshFa(); toBottom(); });
  if (document.fonts && document.fonts.ready) { document.fonts.ready.then(refreshFa); }

  /* 字体探针：把真实计算出的字体回传给外层（字体面板用） */
  function report(){
    try {
      var b = getComputedStyle(document.body);
      var n = document.querySelector('#chat .mes .name_text') || document.body;
      var ns = getComputedStyle(n);
      var t = document.querySelector('#chat .mes .mes_text') || document.body;
      var ts = getComputedStyle(t);
      parent.postMessage({ type: 'tavern-font', body: { family: b.fontFamily, size: b.fontSize, lineHeight: b.lineHeight },
        name: { family: ns.fontFamily, size: ns.fontSize, weight: ns.fontWeight },
        text: { family: ts.fontFamily, size: ts.fontSize, lineHeight: ts.lineHeight } }, '*');
    } catch (e) {}
  }
  report();
  setTimeout(report, 400);
})();
<\/script>`

  const data = JSON.stringify({
    chars: seed.map((c) => ({ name: c.name, avatar: c.avatar, html: c.messages.join('') }))
  }).replace(/</g, '\\u003c')

  return shell({
    uiCss, themeCss, fields, baseHref,
    fontAwesomeHref: faCssHref,
    faFontCss,
    bodyClass: themeBodyClass(fields),
    extraCss: UI_FORCE_CSS,
    body: body.replace('__DATA__', data)
  })
}

/* ---------------- 2. 文本包裹对照表 ---------------- */

export function buildWrapDoc({ uiCss, themeCss, fields, baseHref }) {
  const rows = WRAP_CASES.map((c) => {
    const html = tavernFormat(c.syntax)
    const tags = (html.match(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi) || [])
      .map((x) => x.replace(/[<>\/]/g, '').split(/\s/)[0].toLowerCase())
      .filter((t) => t && t !== 'p' && t !== 'br')
    const uniq = [...new Set(tags)]
    return `<div class="wr">
      <div class="wr-l">
        <div class="wr-name">${escapeHtml(c.label)}</div>
        <div class="wr-syntax">${escapeHtml(c.syntax.replace(/\n/g, '⏎'))}</div>
        <div class="wr-note">${escapeHtml(c.note)}</div>
      </div>
      <div class="wr-r"><div class="mes_text">${html}</div></div>
      <div class="wr-tag">${uniq.length ? uniq.map((t) => `<code>${t}</code>`).join('') : '<code>纯文本</code>'}</div>
    </div>`
  }).join('')

  const groups = []
  for (const c of WRAP_CASES) if (!groups.includes(c.group)) groups.push(c.group)

  const body = `<div class="wr-wrap">
    <div class="wr-head">
      <b>同一句话，酒馆支持的每一种包裹方式</b>
      <span>左列是写法，右列是渲染结果，最后一列是实际生成的标签</span>
    </div>
    ${rows}
    <div class="wr-foot">分组：${groups.map((g) => escapeHtml(g)).join(' · ')}｜酒馆默认 encode_tags 开启，直写的 HTML 标签会被转义成文字</div>
  </div>`

  return shell({
    uiCss,
    themeCss,
    fields,
    baseHref,
    bodyClass: themeBodyClass(fields),
    extraCss: `html.tp-root body{overflow:auto !important}
.wr-wrap{padding:14px 16px;max-width:1100px;margin:0 auto}
.wr-head{display:flex;flex-direction:column;gap:2px;margin-bottom:12px}
.wr-head b{font-size:1.05em}
.wr-head span{font-size:.82em;opacity:.62}
.wr{display:grid;grid-template-columns:minmax(180px,240px) minmax(0,1fr) 110px;gap:12px;align-items:center;
  padding:9px 0;border-top:1px solid rgba(127,127,127,.18)}
.wr-name{font-size:.9em;font-weight:600}
.wr-syntax{font-family:ui-monospace,Consolas,monospace;font-size:.8em;opacity:.72;word-break:break-all;margin-top:2px}
.wr-note{font-size:.76em;opacity:.55;margin-top:2px}
.wr-r{min-width:0}
.wr-r .mes_text{padding:2px 0;overflow-wrap:anywhere}
.wr-tag{text-align:right}
.wr-tag code{font-size:.74em;opacity:.75;background:rgba(127,127,127,.16);border-radius:4px;padding:1px 5px;margin-left:3px}
.wr-foot{margin-top:14px;font-size:.78em;opacity:.55}
@media (max-width: 720px){
  .wr{grid-template-columns:minmax(0,1fr);gap:6px}
  .wr-tag{text-align:left}
}`,
    body
  })
}

/* ---------------- 3. 字体面板 ---------------- */

export function buildFontDoc({ uiCss, themeCss, fields, baseHref, live }) {
  const faces = fontFacesOf(themeCss)
  const decls = cssFontFamiliesOf(themeCss)
  const stacks = []
  const add = (label, value) => {
    if (value && !stacks.some((s) => s.value === value)) stacks.push({ label, value })
  }
  add('正文（.mes_text）', live && live.mesFamily)
  add('页面基础（body）', live && live.bodyFamily)
  add('角色名（.ch_name）', live && live.nameFamily)
  decls.forEach((d) => add('主题声明', d))

  const sample = 'AaBbCc 0123 今晚的麦酒还带着凉气。'

  const faceRows = stacks
    .map((s) => {
      const fams = splitFamilies(s.value)
      return `<div class="fz">
        <div class="fz-info">
          <div class="fz-label">${escapeHtml(s.label)}</div>
          <div class="fz-stack">${fams.map((f) => `<code>${escapeHtml(f)}</code>`).join(' ')}</div>
        </div>
        <div class="fz-sample" style="font-family:${escapeAttr(s.value)}">${escapeHtml(sample)}</div>
      </div>`
    })
    .join('')

  const faceList = faces.length
    ? faces
        .map(
          (f) => `<div class="fz-face">
        <b>${escapeHtml(f.family || '（未命名字体）')}</b>
        <span>${escapeHtml(f.weight || 'normal')} / ${escapeHtml(f.style || 'normal')}</span>
        <code>${escapeHtml((f.src || '').slice(0, 120))}</code>
      </div>`
        )
        .join('')
    : '<div class="fz-empty">这套美化没有引入自定义字体文件（@font-face），用的就是系统已有字体</div>'

  const num = (v) => (v ? String(v) : '—')
  const body = `<div class="fz-wrap">
    <div class="fz-head"><b>这套美化实际跑出来的字体</b><span>数值取自预览 iframe 的 getComputedStyle，不是照 CSS 猜的</span></div>
    <table class="fz-table">
      <tr><th></th><th>字体族</th><th>字号</th><th>行高</th><th>字重</th><th>字距</th></tr>
      <tr><td>正文 .mes_text</td><td>${escapeHtml(num(live && live.mesFamily))}</td><td>${escapeHtml(num(live && live.mesSize))}</td><td>${escapeHtml(num(live && live.mesLine))}</td><td>${escapeHtml(num(live && live.mesWeight))}</td><td>${escapeHtml(num(live && live.mesSpacing))}</td></tr>
      <tr><td>页面 body</td><td>${escapeHtml(num(live && live.bodyFamily))}</td><td>${escapeHtml(num(live && live.bodySize))}</td><td>${escapeHtml(num(live && live.bodyLine))}</td><td>${escapeHtml(num(live && live.bodyWeight))}</td><td>—</td></tr>
      <tr><td>角色名</td><td>${escapeHtml(num(live && live.nameFamily))}</td><td>${escapeHtml(num(live && live.nameSize))}</td><td>—</td><td>—</td><td>—</td></tr>
    </table>
    <div class="fz-head" style="margin-top:16px"><b>字体样张</b><span>每个字体族单独用该字体渲染同一句话，能看出的差异才是真实差异</span></div>
    ${faceRows || '<div class="fz-empty">还没取到预览里的字体信息</div>'}
    <div class="fz-head" style="margin-top:16px"><b>@font-face 自定义字体</b><span>主题 CSS 里自带字体的部分</span></div>
    ${faceList}
    <div class="fz-head" style="margin-top:16px"><b>主题字段</b><span>酒馆「用户设置 → 外观」里存的值</span></div>
    <table class="fz-table">
      <tr><th>字段</th><th>值</th></tr>
      <tr><td>font_scale（字号缩放）</td><td>${escapeHtml(fields && fields.font_scale != null ? String(fields.font_scale) : '默认 1')}</td></tr>
      <tr><td>main_text_color</td><td>${escapeHtml((fields && fields.main_text_color) || '默认')}</td></tr>
      <tr><td>italics_text_color</td><td>${escapeHtml((fields && fields.italics_text_color) || '默认')}</td></tr>
      <tr><td>quote_text_color</td><td>${escapeHtml((fields && fields.quote_text_color) || '默认')}</td></tr>
      <tr><td>underline_text_color</td><td>${escapeHtml((fields && fields.underline_text_color) || '默认')}</td></tr>
    </table>
  </div>`

  return shell({
    uiCss,
    themeCss,
    fields,
    baseHref,
    bodyClass: themeBodyClass(fields),
    extraCss: `html.tp-root body{overflow:auto !important}
.fz-wrap{padding:14px 16px;max-width:1000px;margin:0 auto;font-size:13px}
.fz-head{display:flex;flex-direction:column;gap:2px;margin-bottom:8px}
.fz-head b{font-size:1.02em}
.fz-head span{font-size:.8em;opacity:.6}
.fz-table{width:100%;border-collapse:collapse;margin-bottom:6px}
.fz-table th,.fz-table td{border-top:1px solid rgba(127,127,127,.2);padding:6px 8px;text-align:left;font-size:.86em;vertical-align:top}
.fz-table th{opacity:.6;font-weight:500}
.fz{border-top:1px solid rgba(127,127,127,.2);padding:10px 0}
.fz-info{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.fz-label{font-size:.8em;opacity:.6}
.fz-stack code{font-size:.76em;background:rgba(127,127,127,.16);border-radius:4px;padding:1px 5px;margin-right:4px}
.fz-sample{margin-top:6px;font-size:1.35em;line-height:1.5;overflow-wrap:anywhere}
.fz-face{border-top:1px solid rgba(127,127,127,.2);padding:8px 0;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.fz-face span{font-size:.78em;opacity:.6}
.fz-face code{font-size:.72em;opacity:.6;word-break:break-all}
.fz-empty{opacity:.6;font-size:.85em;padding:8px 0}`,
    body
  })
}
