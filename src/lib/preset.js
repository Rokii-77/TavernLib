/**
 * 预设（preset）专用解析工具
 *
 * 只在 presets 分类生效，角色卡 / 世界书不走这里。
 *
 * 这里要解决的问题是：酒馆预设的文件名 / 预设名非常随意，作者们各有各的写法：
 *   【Ako】1.9_Polaroid
 *   Ako1.91_SP_SillyAko0801
 *   图灵预设 k3 v4.1 强破甲 K3智力降的不能看了 将就玩吧
 *   砚台预设_GeminiV1.4（巅峰还原版）
 *   神本无相V0.8
 *   YU_V1.3.5
 *   小狗之神·春日来信（间隔号后面的「春日来信」算版本号）
 * 我们想把它拆成「预设名 + 版本号（+ 模型名）」三部分，其中：
 *   - 预设名：同一预设的所有版本必须解析出同一个名字，靠这个名字合并成多版本；
 *   - 版本号：原样保留作者的写法（v 前缀、下划线、中文括号、空格、模型名混在里面都行）；
 *   - 模型名：给卡片打标签用，从文件名 / 帖子标题里识别常见酒馆模型。
 *
 * 设计原则：宁可少拆，不要拆错。找不到可信的版本起点时，整串都当预设名，版本号留空。
 */

/* ============================ 模型识别词典 ============================ */

/**
 * 常见酒馆模型词典。
 * family: 归一化后的族名（也作为识别结果的基名）
 * re: 匹配正则（大小写不敏感），分组里抓「版本号」「档位」这类修饰
 * 顺序即优先级：越具体的写法放前面，避免 "gpt-4o" 被 "gpt" 先吃掉。
 */
const MODEL_RULES = [
  {
    family: 'gemini',
    re: /gemini(?:\s*[-_ ]?\s*(\d+(?:\.\d+)?))?(?:\s*[-_ ]?\s*(pro|flash|ultra|nano|lite))?/i
  },
  {
    family: 'claude',
    // Claude 的写法两种都常见：Claude 3.5 Sonnet / Claude Sonnet 4.5
    re: /(?:claude|克劳德)(?:\s*[-_ ]?\s*(\d+(?:\.\d+)?))?(?:\s*[-_ ]?\s*(opus|sonnet|haiku))?(?:\s*[-_ ]?\s*(\d+(?:\.\d+)?))?/i
  },
  {
    family: 'gpt',
    re: /\bgpt(?:\s*[-_ ]?\s*(\d+(?:\.\d+)?[a-z]?))?(?:\s*[-_ ]?\s*(mini|turbo|nano))?/i
  },
  { family: 'o1', re: /\bo1(?:\s*[-_ ]?(mini|preview))?/i },
  { family: 'o3', re: /\bo3(?:\s*[-_ ]?(mini|preview))?/i },
  { family: 'o4', re: /\bo4(?:\s*[-_ ]?(mini|preview))?/i },
  { family: 'glm', re: /\b(?:chatglm|glm)(?:\s*[-_ ]?(\d+(?:\.\d+)?))?(\s*v)?/i },
  { family: 'deepseek', re: /\bdeepseek(?:\s*[-_ ]?([a-z0-9.]+))?/i },
  {
    family: 'qwen',
    re: /(?:qwen|通义千问|千问)(?:\s*[-_ ]?(\d+(?:\.\d+)?))?(?:\s*[-_ ]?(max|plus|turbo|mini|coder|vl))?/i
  },
  { family: 'kimi', re: /\b(?:kimi|moonshot)(?:\s*[-_ ]?([a-z0-9.]+))?/i },
  { family: 'llama', re: /\bllama(?:\s*[-_ ]?(\d+(?:\.\d+)?))?/i },
  { family: 'grok', re: /\bgrok(?:\s*[-_ ]?(\d+(?:\.\d+)?))?/i },
  { family: 'mistral', re: /\bmistral(?:\s*[-_ ]?([a-z0-9.]+))?/i },
  { family: 'minimax', re: /\bminimax(?:\s*[-_ ]?([a-z0-9.]+))?/i },
  { family: 'abab', re: /\babab(?:\s*[-_ ]?([a-z0-9.]+))?/i },
  { family: 'yi', re: /\b(?:yi|零一)(?:\s*[-_ ]?(\d+(?:\.\d+)?[a-z]?))?/i },
  { family: 'command r', re: /\bcommand[\s-]?r(?:\s*[-_ ]?([a-z0-9.+]+))?/i }
]

/** 把匹配结果整理成「gemini 2.5 pro」这种人类可读标签 */
function labelOf(family, m) {
  const parts = [family]
  for (let i = 1; i < m.length; i++) {
    const g = m[i]
    if (!g) continue
    const v = String(g).trim().toLowerCase()
    if (!v) continue
    if (parts.includes(v)) continue
    parts.push(v)
  }
  return parts.join(' ')
}

/**
 * 从任意文本里识别第一个命中的模型名
 * @param {string} text
 * @returns {string} 识别不到返回 ''
 */
export function detectModel(text) {
  const s = String(text == null ? '' : text)
  if (!s) return ''
  let best = null
  for (const rule of MODEL_RULES) {
    const m = s.match(rule.re)
    if (!m) continue
    if (!best || m.index < best.index) best = { index: m.index, label: labelOf(rule.family, m), text: m[0] }
  }
  return best ? best.label : ''
}

/** 词典里出现的族名（用于判断「这个片段是不是一个模型名」） */
const FAMILY_WORDS = new Set(
  MODEL_RULES.map((r) => r.family).concat(['chatglm', 'moonshot', '通义千问', '千问', '克劳德', '零一', 'yi'])
)

/** 单独一段是不是纯模型名（如 "Gemini"、"V1.4" 不算、"k3" 不算） */
function looksLikeModelWord(seg) {
  const v = String(seg || '').trim()
  if (!v) return false
  if (FAMILY_WORDS.has(v.toLowerCase())) return true
  return !!detectModel(v)
}

/* ============================ 预设名 / 版本号拆分 ============================ */

/** 名称归一化：忽略大小写、空白、全角半角差异、常见分隔符 */
export function normPresetName(name) {
  return String(name == null ? '' : name)
    .replace(/[\u3000\u00A0\ufffd\u200b-\u200d\ufeff]/g, ' ')
    .replace(/[【】\[\]（）()《》<>「」"'’‘`]/g, '')
    .replace(/[\s_\-·・.,，。:：;；/\\|]+/g, '')
    .toLowerCase()
}

/** 版本段起点的候选正则：先看带 v 前缀的，再看点分数字（1.9 / 0.8） */
const V_PREFIX = /[vV]\s*\d+(?:[._]\d+)*/
const DOTTED = /\d+(?:[._]\d+)+/
/** 分隔符后紧跟的裸整数（"预设 3"这类），只在前两者都没命中时才用 */
const BARE_INT = /(?:^|[\s_\-·])(\d{1,3})(?=$|[\s_\-·（(])/

/** 去掉首尾的分隔符 */
function trimSep(s) {
  return String(s == null ? '' : s).replace(/^[\s_\-·・.、]+|[\s_\-·・.、]+$/g, '').trim()
}

/**
 * 解析预设名 / 版本号 / 模型名
 * @param {string} raw 预设名或文件名（不要带扩展名）
 * @param {object} [opt] { model?: 已知模型（比如从 DC 标题抓到的） }
 * @returns {{name:string, version:string, model:string, subtitle:string, bracketed:boolean, raw:string}}
 */
export function parsePresetName(raw, opt = {}) {
  const src = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim()
  const out = { name: src, version: '', model: '', subtitle: '', bracketed: false, raw: src }
  if (!src) return out

  // 归一化后完全没有数字、也没有分隔符时，直接整串当名字
  let working = src
  let prefix = ''

  // ① 【Ako】1.9_Polaroid：方括号里是名字本体
  const br = working.match(/^[【\[]([^】\]]{1,24})[】\]]\s*/)
  if (br) {
    prefix = br[1].trim()
    working = working.slice(br[0].length)
    out.bracketed = true
  }

  let namePart = ''
  let verPart = ''

  if (prefix) {
    // 方括号已经把名字定死了，后面剩下的整体（去掉开头分隔符）就是版本号
    namePart = prefix
    verPart = trimSep(working)
  } else {
    // ② 找最左的版本起点：v 前缀 > 点分数字 > 分隔符后的裸整数
    let idx = -1
    const mV = src.match(V_PREFIX)
    const mD = src.match(DOTTED)
    const cands = []
    if (mV) cands.push(mV.index)
    if (mD) cands.push(mD.index)
    if (cands.length) idx = Math.min(...cands)
    else {
      const mI = src.match(BARE_INT)
      // 裸整数要求前面非空且不是纯数字名字（如 "1.9"），否则宁可整串当名字
      if (mI && mI.index + (mI[0].length - mI[1].length) > 0) idx = mI.index + (mI[0].length - mI[1].length)
    }
    if (idx > 0) {
      namePart = src.slice(0, idx)
      verPart = src.slice(idx)
      // 「图灵预设 k3 v4.1 …」：紧挨版本号前面的短代号（k3 / S4 / v2）其实是版本段的一部分
      const tail = namePart.match(/^(.*?)[\s_\-·]+([A-Za-z]{1,4}\d{0,3})[\s_\-·]*$/)
      if (tail && tail[2] && !looksLikeModelWord(tail[2]) && /[A-Za-z]/.test(tail[2])) {
        namePart = tail[1]
        verPart = tail[2] + ' ' + verPart
      }
    } else if (idx === 0) {
      // 整串以版本号开头（如 1.9_Polaroid），没有可信名字，整串当名字
      namePart = src
      verPart = ''
    } else {
      namePart = src
      verPart = ''
    }
  }

  namePart = trimSep(namePart)
  verPart = trimSep(verPart)

  // ③ 名字尾巴上粘着的模型名要摘出来（砚台预设_Gemini → 砚台预设 + gemini）
  let model = String(opt.model || '').trim()
  if (namePart) {
    const segs = namePart.split(/[\s_\-·・]+/).filter(Boolean)
    if (segs.length > 1 && looksLikeModelWord(segs[segs.length - 1])) {
      if (!model) model = detectModel(segs[segs.length - 1])
      namePart = trimSep(segs.slice(0, -1).join(' '))
    }
  }
  // 版本号里混着的模型名：同样摘掉，但只在「摘掉后还留着版本特征」时才摘
  if (verPart) {
    const dm = detectModel(verPart)
    if (dm) {
      const rest = trimSep(verPart.replace(new RegExp(escapeRe(dm.split(' ')[0]), 'i'), ''))
      if (rest && /[vV]?\d/.test(rest)) {
        if (!model) model = dm
        verPart = rest
      }
    }
  }
  if (!model) model = detectModel(src)

  // ④ 「小狗之神·春日来信」：间隔号 · 后面的整段是版本名（作者写的版本标记），名字只留前半
  if (!verPart && /[·・]/.test(namePart)) {
    const segs = namePart.split(/[·・]/)
    const head = trimSep(segs.shift() || '')
    const tail = trimSep(segs.join('·'))
    if (head && tail) {
      namePart = head
      verPart = tail
    }
  }

  if (!namePart) namePart = src
  out.name = namePart
  out.version = verPart
  out.model = model
  out.subtitle = ''
  return out
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 预设归组 key：同一预设（名称归一化后相同）的不同版本用同一个 key。
 * 带【】的原名在用户没手动去掉括号前，单独算一组，不跟去括号的同名条目合并。
 */
export function presetGroupKey(name, opt = {}) {
  const info = parsePresetName(name)
  const base = normPresetName(info.name) || normPresetName(name)
  if (!base) return ''
  const bracketed = opt.bracketed === true || info.bracketed === true || isBracketedPreset(name)
  return 'preset:' + base + (bracketed ? '#br' : '')
}

/**
 * 判断一个条目名是不是「带方括号写法」（导入时用来决定要不要并组）
 */
export function isBracketedPreset(name) {
  return /^[【\[]/.test(String(name == null ? '' : name).trim())
}
