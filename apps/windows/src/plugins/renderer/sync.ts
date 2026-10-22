import type { RendererPlugin, RendererPluginApi } from '../renderer-api'

/**
 * 把「哪些插件是启用的」同步成「哪些插件已经 setup」。
 *
 * 抽成纯函数是为了能测：真正的坑都在这里——重复 setup（槽位 id 冲突会抛）、
 * 忘了 teardown（禁用后按钮还在）、以及 setup 抛错后把整轮同步带崩。
 *
 * 规则：
 * - 启用且未挂 → setup，记住清理函数；
 * - 已挂但不该启用 → 调清理函数并摘下；
 * - setup 抛错只记日志，**不影响其他插件**（与主进程宿主同一取舍）。
 */
export function syncRendererPlugins(
  plugins: readonly RendererPlugin[],
  enabledIds: ReadonlySet<string>,
  mounted: Map<string, () => void>,
  api: RendererPluginApi,
  onError: (id: string, error: unknown) => void = () => {},
): void {
  for (const plugin of plugins) {
    const shouldRun = enabledIds.has(plugin.id)
    const running = mounted.has(plugin.id)

    if (shouldRun && !running) {
      try {
        mounted.set(plugin.id, plugin.setup(api))
      } catch (error) {
        mounted.delete(plugin.id)
        onError(plugin.id, error)
      }
    } else if (!shouldRun && running) {
      const dispose = mounted.get(plugin.id)
      mounted.delete(plugin.id)
      try {
        dispose?.()
      } catch (error) {
        onError(plugin.id, error)
      }
    }
  }
}
