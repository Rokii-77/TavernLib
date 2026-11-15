/* 酒馆扩展版本判定：纯函数，只算不改。
 * 内置扩展（随软件打包的那份）与酒馆目录里已装的那份，按语义化版本比较：
 *   missing  酒馆里没装
 *   upgrade  内置比酒馆里的新 → 可以提示升级
 *   same     两边一致
 *   newer    酒馆里的比内置新（软件回滚过 / 用户手装过更新的）→ 不打扰
 *   unknown  版本号读不出来（缺 manifest 字段等）→ 不打扰
 * 这里不做任何 IO，调用方自己决定要不要提示。 */
import { compareVersion } from './update.js'

export const EXT_STATE = {
  missing: 'missing',
  upgrade: 'upgrade',
  same: 'same',
  newer: 'newer',
  unknown: 'unknown'
}

export function judgeExtVersion({ installed, builtin, tavern } = {}) {
  if (!installed) return EXT_STATE.missing
  const b = String(builtin == null ? '' : builtin).trim()
  const t = String(tavern == null ? '' : tavern).trim()
  if (!b || !t) return EXT_STATE.unknown
  const c = compareVersion(b, t)
  if (c > 0) return EXT_STATE.upgrade
  if (c < 0) return EXT_STATE.newer
  return EXT_STATE.same
}
