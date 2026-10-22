import { useSyncExternalStore } from 'react'

/**
 * 渲染层唯二的插件状态来源：`extensions.list()` 拉一次 + `plugin:state-changed` 推送。
 *
 * 两处消费它：
 * - `PluginRuntime` 按它 setup / teardown 插件注册的槽位；
 * - 页面（如设置页实验功能列表）按它**隐藏**被禁用插件的入口。
 *
 * 只有「运行期能启停」（`hot`）的插件会收到推送；要重启才生效的开关不会推，
 * 所以它们的 UI 保持原样——真正的判据是主进程那份 `pendingRestart`。
 *
 * 为什么是模块级 store 而不是 Context：状态在 App 挂载前就可能被页面读到
 * （设置页首帧），少一层 Provider；读取方都是只读，不需要传写入口。
 */
type Snapshot = ReadonlyMap<string, boolean>

let snapshot: Snapshot = new Map()
const listeners = new Set<() => void>()
let started = false

function replace(next: ReadonlyMap<string, boolean>): void {
  // 换一个新引用，useSyncExternalStore 才认得出变化
  snapshot = next
  for (const listener of listeners) listener()
}

function set(id: string, enabled: boolean): void {
  if (snapshot.get(id) === enabled) return
  const next = new Map(snapshot)
  next.set(id, enabled)
  replace(next)
}

/** 幂等：第一次有人订阅时才订阅 IPC */
function ensureStarted(): void {
  if (started) return
  started = true

  const api = window.electronAPI?.extensions
  if (!api) return

  void api
    .list()
    .then((list) => {
      const next = new Map<string, boolean>()
      for (const item of list) next.set(item.id, item.enabled && item.state !== 'disabled')
      replace(next)
    })
    .catch((error) => {
      console.warn('[plugin] 读取插件状态失败，渲染层插件按未启用处理', error)
    })

  api.onStateChanged(({ id, enabled }) => set(id, enabled))
}

function subscribe(listener: () => void): () => void {
  ensureStarted()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 给 `useSyncExternalStore` 用的整表快照（引用只在变化时换） */
export function getPluginStateSnapshot(): Snapshot {
  return snapshot
}

/** 页面用：某个插件此刻是否启用（未加载完成时按关闭处理） */
export function usePluginEnabled(id: string): boolean {
  return useSyncExternalStore(subscribe, () => snapshot.get(id) === true)
}

export { subscribe as subscribePluginState }

/** 仅供测试：清空快照与订阅标记（模块级状态的常规做法，不参与运行时逻辑） */
export function __resetPluginStateForTests(): void {
  snapshot = new Map()
  listeners.clear()
  started = false
}
