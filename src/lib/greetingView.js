/**
 * 开场白的「显示三态」判定（详情页开场白区块 + 全部开场白弹层共用）。
 *
 * 背景：版本 raw 落盘时会被剥成侧车文件（version.rawFile），重启后 version.raw 是
 * undefined。旧实现在两种情况下都当成「没有默认开场白」：
 *   ① raw 还没读回来（异步预载中）—— 属于「还不知道」
 *   ② raw 读回来了、first_mes 真的为空 —— 才是「确实没有」
 * 于是 159 张数据完好的卡被误判成空卡。
 *
 * 这里把判定抽成纯函数：调用方只管把「raw 就绪状态」和「取到的开场白」喂进来，
 * 由本模块给出 state / 文案 / 计数，界面按 state 渲染，不自己拍脑袋判空。
 */

/** raw 侧车的就绪状态 */
export const GREET_RAW = {
  READY: 'ready', // raw 已就绪（可能是内存里就有，也可能刚从侧车读回）
  LOADING: 'loading', // 正在读侧车
  UNREADABLE: 'unreadable' // 读完了仍拿不到 raw（侧车缺失/损坏/没有读盘能力）
}

/** 界面要渲染的开场白状态 */
export const GREET_STATE = {
  LOADING: 'loading',
  OK: 'ok',
  ALTERNATES: 'alternates', // 无默认、但有备选
  EMPTY: 'empty', // 确实一条都没有
  UNREADABLE: 'unreadable' // 数据不可用，不能断言「没有」
}

const EMPTY_GREETS = { first: '', alternates: [], total: 0 }

/**
 * 打开某个版本时，raw 需不需要读盘。
 * @param {object|null|undefined} version
 * @returns {'ready'|'read'|'unreadable'}
 */
export function greetRawNeedOf(version) {
  if (!version) return GREET_RAW.READY // 没有版本，没什么可读
  if (version.raw !== undefined && version.raw !== null) return GREET_RAW.READY
  if (!version.rawFile) return GREET_RAW.UNREADABLE // 侧车名都没有 → raw 从未落盘
  return 'read'
}

/**
 * 预载结束后的 raw 状态。
 * @param {*} raw ensureVersionRaw 的返回值
 * @returns {'ready'|'unreadable'}
 */
export function greetRawResultOf(raw) {
  return raw === undefined || raw === null ? GREET_RAW.UNREADABLE : GREET_RAW.READY
}

/**
 * 预载某个版本的开场白 raw，返回预载后的 raw 状态。
 * 这是详情页开场白区块 / 全部开场白弹层共用的取数步骤：先把「不用读」的情况短路掉
 * （raw 已在内存），再调调用方给的 ensureRaw 读侧车，读不到就判 unreadable 而不是空卡。
 * @param {{version:object, ensureRaw:(version:object)=>Promise<*>}} p
 * @returns {Promise<'ready'|'unreadable'>}
 */
export async function preloadGreetRaw({ version, ensureRaw } = {}) {
  const need = greetRawNeedOf(version)
  if (need !== 'read') return need
  let raw
  try {
    raw = ensureRaw ? await ensureRaw(version) : undefined
  } catch (_) {
    raw = undefined
  }
  return greetRawResultOf(raw)
}

/**
 * 开场白显示态。
 * @param {{greets?:{first:string,alternates:string[],total:number}, rawState?:string}} p
 *   rawState: GREET_RAW 之一，默认按 ready 处理（调用方已经自己读好了 raw 的场景）
 */
export function greetingViewOf({ greets, rawState } = {}) {
  const g = greets && typeof greets === 'object' ? greets : EMPTY_GREETS
  /* 首尾空白不算开场白：口径与 store 的 greetingsOf 一致，避免纯空白被判成“有开场白” */
  const first = String(g.first || '').trim()
  const alternates = Array.isArray(g.alternates)
    ? g.alternates.map((t) => String(t || '').trim()).filter(Boolean)
    : []
  const total = (first ? 1 : 0) + alternates.length
  const state0 = rawState || GREET_RAW.READY

  const view = {
    first,
    alternates,
    total,
    /* 标题右侧的计数说明：默认 1 条｜其他 N 条 */
    subText: first || alternates.length
      ? (first ? '默认 1 条' : '') +
        (first && alternates.length ? '｜' : '') +
        (alternates.length ? `其他 ${alternates.length} 条` : '')
      : '',
    canOpenAll: alternates.length > 0
  }

  /* ① 还在读侧车：给加载态，绝不能说「没有」 */
  if (state0 === GREET_RAW.LOADING && !first && !alternates.length) {
    return { ...view, state: GREET_STATE.LOADING, loading: true, message: '正在读取这一版的开场白…' }
  }
  /* ② raw 拿不到：数据不可用，也不能断言没有 */
  if (state0 === GREET_RAW.UNREADABLE && !first && !alternates.length) {
    return {
      ...view,
      state: GREET_STATE.UNREADABLE,
      loading: false,
      message: '读不到这一版的原始卡片数据，无法确认开场白'
    }
  }
  /* ③ 正常有默认开场白 */
  if (first) return { ...view, state: GREET_STATE.OK, loading: false, message: '' }
  /* ④ 没有默认、但有备选：文案要说清「有几条备选」，而不是笼统空提示 */
  if (alternates.length) {
    return {
      ...view,
      state: GREET_STATE.ALTERNATES,
      loading: false,
      message: `本卡无默认开场白，有 ${alternates.length} 条备选`
    }
  }
  /* ⑤ 确实一条都没有 */
  return { ...view, state: GREET_STATE.EMPTY, loading: false, message: '这一版没有默认开场白' }
}
