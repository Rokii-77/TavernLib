/**
 * 单击 / 双击共存调度
 *
 * 原生 dblclick 触发前必定先触发一次 click，如果 click 里立刻执行动作，
 * 双击时的第一下就会先把状态改掉，表现为「单击切不动 / 双击被单击抢占」。
 *
 * 这里用一个短延时判定：
 * - 单击：等待 delay 毫秒内没有第二次点击才执行 onSingle
 * - 双击：收到 dblclick 立即取消待执行的单击动作，只执行 onDouble
 *
 * @param {{onSingle?:Function, onDouble?:Function, delay?:number}} opt
 * @returns {{click:Function, dblclick:Function, cancel:Function, pending:()=>boolean}}
 */
export function createTapHandler({ onSingle, onDouble, delay = 220 } = {}) {
  let timer = null
  let lastArg = null

  function clear() {
    if (timer) {
      clearTimeout(timer)
      timer = null
      return true
    }
    return false
  }

  return {
    click(...args) {
      const arg = args.length > 1 ? args : args[0]
      clear()
      lastArg = arg
      timer = setTimeout(() => {
        timer = null
        lastArg = null
        onSingle && onSingle(arg)
      }, delay)
    },
    dblclick(...args) {
      const arg = args.length > 1 ? args : args[0]
      clear()
      lastArg = null
      onDouble && onDouble(arg)
    },
    cancel: clear,
    pending() {
      return timer !== null
    },
    get lastArg() {
      return lastArg
    }
  }
}
