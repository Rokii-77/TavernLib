/**
 * 条目归属判定的纯逻辑（不依赖 vue / store，可直接单测）。
 *
 * 背景：category 曾经用 defineProperty(enumerable:false) 挂在条目上，只为省存档体积，
 * 结果它不落盘；运行期新建 / 导入的条目没有这个字段，详情页 isTheme、导出分支这些
 * 「按类别分叉」的地方就判定成 false，表现为「导入完美化，详情页预览整块不渲染，
 * 重启一次才正常」。现在 category 是可枚举字段，随存档落盘，同时保留按 id 反查的兜底，
 * 让老数据、以及任何漏写字段的路径也能当场判对。
 */

/** 类别顺序固定：同一份判定逻辑在书架、详情、导出、推酒馆各处分叉时保持一致 */
export const CAT_ORDER = Object.freeze(['characters', 'worldbooks', 'presets', 'themes', 'others'])

/**
 * 取条目类别：自带 category 字段优先；没有就在列表里按「引用相同 / id 相同」反查。
 * 判不出来返回空串 —— 调用方自己决定兜底，这里不猜。
 * @param {object} lists 形如 { characters: [], worldbooks: [], ... }
 * @param {object} item 条目
 * @returns {string} 类别 key 或 ''
 */
export function catIndex(lists, item) {
  if (!item || typeof item !== 'object') return ''
  if (item.category) return String(item.category)
  if (!lists || typeof lists !== 'object') return ''
  const id = item.id
  for (const k of CAT_ORDER) {
    const arr = Array.isArray(lists[k]) ? lists[k] : []
    if (arr.includes(item)) return k
    /* 详情页拿到的可能是条目的浅拷贝 / 反序列化副本，引用对不上，只能按 id 找 */
    if (id !== undefined && id !== null && id !== '' && arr.some((x) => x && x.id === id)) return k
  }
  return ''
}
