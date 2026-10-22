import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'

import { rendererApi, type RendererPlugin, type RendererPluginApi } from '../renderer-api'
import { RENDERER_PLUGINS } from './registry'
import { getPluginStateSnapshot, subscribePluginState } from './state'
import { syncRendererPlugins } from './sync'

/**
 * 渲染层插件运行时：把主进程的启停状态变成 setup / teardown。
 *
 * 挂一次就够（`App` 里与 `PetSessionSync` 并列）。状态来源见 `state.ts`——
 * 页面也要读同一份（隐藏被禁用插件的入口），所以不在这里自己拉。
 *
 * `mounted` 放 ref 里跨渲染保留：开关一个插件不该把其他插件的 UI 拆了重建。
 */
export interface PluginRuntimeProps {
  plugins?: readonly RendererPlugin[]
  api?: RendererPluginApi
}

export function PluginRuntime({ plugins = RENDERER_PLUGINS, api = rendererApi }: PluginRuntimeProps) {
  const state = useSyncExternalStore(subscribePluginState, getPluginStateSnapshot)
  const enabledIds = useMemo(
    () => new Set([...state].filter(([, on]) => on).map(([id]) => id)),
    [state],
  )
  const mounted = useRef(new Map<string, () => void>())

  useEffect(() => {
    syncRendererPlugins(plugins, enabledIds, mounted.current, api, (id, error) => {
      console.warn(`[plugin] ${id} 渲染层切换失败`, error)
    })
  }, [plugins, api, enabledIds])

  useEffect(() => {
    const disposers = mounted.current
    return () => {
      for (const dispose of disposers.values()) {
        try {
          dispose()
        } catch (error) {
          console.warn('[plugin] 渲染层插件卸载失败', error)
        }
      }
      disposers.clear()
    }
  }, [])

  return null
}
