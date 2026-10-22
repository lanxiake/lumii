import { useEffect } from 'react'

import { rendererApi, type RendererPlugin, type RendererPluginApi } from '../renderer-api'
import { RENDERER_PLUGINS } from './registry'
import { syncRendererPlugins } from './sync'

/**
 * 渲染层插件运行时：把主进程的启停状态变成 setup / teardown。
 *
 * 挂一次就够（`App` 里与 `PetSessionSync` 并列）。两路输入：
 * - 挂载时拉一次 `extensions.list()`（主进程宿主未就绪时返回空 ⇒ 全部按关闭处理）；
 * - 之后由 `plugin:state-changed` 推送增量——内置插件的开关只有设置页一个入口，
 *   推送比轮询准，也没有 1 秒的窗口期。
 */
export interface PluginRuntimeProps {
  plugins?: readonly RendererPlugin[]
  api?: RendererPluginApi
}

export function PluginRuntime({ plugins = RENDERER_PLUGINS, api = rendererApi }: PluginRuntimeProps) {
  useEffect(() => {
    const mounted = new Map<string, () => void>()
    const enabled = new Map<string, boolean>()
    let disposed = false

    const reportError = (id: string, error: unknown) => {
      console.warn(`[plugin] ${id} 渲染层切换失败`, error)
    }

    const apply = () => {
      if (disposed) return
      const enabledIds = new Set(
        [...enabled].filter(([, on]) => on).map(([id]) => id),
      )
      syncRendererPlugins(plugins, enabledIds, mounted, api, reportError)
    }

    void window.electronAPI.extensions
      .list()
      .then((list) => {
        for (const item of list) enabled.set(item.id, item.enabled && item.state !== 'disabled')
        apply()
      })
      .catch((error) => {
        console.warn('[plugin] 读取插件状态失败，渲染层插件按未启用处理', error)
      })

    const off = window.electronAPI.extensions.onStateChanged(({ id, enabled: on }) => {
      enabled.set(id, on)
      apply()
    })

    return () => {
      disposed = true
      off()
      for (const dispose of mounted.values()) {
        try {
          dispose()
        } catch (error) {
          console.warn('[plugin] 渲染层插件卸载失败', error)
        }
      }
      mounted.clear()
    }
  }, [plugins, api])

  return null
}
