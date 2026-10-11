import { useState, useEffect, useCallback } from 'react'
import { PLUGIN_REGISTRY } from '../../../pages/PluginCenterPage/plugins-registry'
import type { PluginId } from '../../../pages/PluginCenterPage/plugins-registry'

export type PluginStatus = {
  id: PluginId
  installed: boolean
  version?: string
  exePath?: string
  installing: boolean
  uninstalling: boolean
  progress?: {
    phase: string
    percent?: number
    downloadedBytes?: number
    totalBytes?: number
    mirror?: string
  }
  error?: string
}

export type UsePluginsResult = {
  statuses: Record<string, PluginStatus>
  install: (id: PluginId) => Promise<void>
  uninstall: (id: PluginId) => Promise<void>
  cancel: (id: PluginId) => Promise<void>
  refresh: (id: PluginId) => Promise<void>
}

const DEFAULT_STATUS = (id: PluginId): PluginStatus => ({
  id,
  installed: false,
  installing: false,
  uninstalling: false,
})

/**
 * 插件中心的安装状态（**通用**：状态与进度都按插件 id 分发）。
 *
 * 判据：**有下载、有运行时、可卸载 = 插件**。自研记忆宫殿没有安装态（数据就在应用自己的库里），
 * 不算插件，因此不在这里——它的状态由 `usePalace` 自己管。
 */
export function usePlugins(): UsePluginsResult {
  const [statuses, setStatuses] = useState<Record<string, PluginStatus>>(() => {
    const init: Record<string, PluginStatus> = {}
    for (const def of PLUGIN_REGISTRY) init[def.id] = DEFAULT_STATUS(def.id)
    return init
  })

  const patch = useCallback((id: PluginId, delta: Partial<PluginStatus>) => {
    setStatuses((prev) => ({ ...prev, [id]: { ...(prev[id] ?? DEFAULT_STATUS(id)), ...delta } }))
  }, [])

  // 统一进度通道：载荷带 id，据此分发到对应插件
  useEffect(() => {
    const unsub = window.electronAPI.plugins.onProgress((p) => {
      const id = p.id as PluginId
      if (p.phase === 'cancelled') {
        patch(id, { installing: false, progress: undefined, error: undefined })
        return
      }
      patch(id, {
        progress: {
          phase: p.phase,
          percent: p.percent,
          downloadedBytes: p.downloadedBytes,
          totalBytes: p.totalBytes,
          mirror: p.mirror,
        },
        error: p.phase === 'error' ? p.error : undefined,
      })
    })
    return () => unsub()
  }, [patch])

  const refreshAll = useCallback(async () => {
    const list = await window.electronAPI.plugins.list()
    setStatuses((prev) => {
      const next: Record<string, PluginStatus> = { ...prev }
      for (const def of PLUGIN_REGISTRY) {
        const s = list[def.id] ?? { installed: false }
        next[def.id] = {
          ...(prev[def.id] ?? DEFAULT_STATUS(def.id)),
          installed: s.installed,
          version: s.version,
          exePath: s.exePath,
        }
      }
      return next
    })
  }, [])

  useEffect(() => {
    refreshAll()
  }, [refreshAll])

  const install = useCallback(
    async (id: PluginId) => {
      patch(id, { installing: true, error: undefined, progress: undefined })
      try {
        const result = await window.electronAPI.plugins.install(id)
        // cancelled 不算失败，静默处理
        if (!result.success && !result.cancelled && result.error) throw new Error(result.error)
        await refreshAll()
      } catch (err) {
        patch(id, { error: String(err instanceof Error ? err.message : err) })
      } finally {
        patch(id, { installing: false })
      }
    },
    [patch, refreshAll],
  )

  const uninstall = useCallback(
    async (id: PluginId) => {
      patch(id, { uninstalling: true, error: undefined })
      try {
        const result = await window.electronAPI.plugins.uninstall(id)
        if (!result.success) throw new Error(result.error ?? '卸载失败')
        await refreshAll()
      } catch (err) {
        patch(id, { error: String(err instanceof Error ? err.message : err) })
      } finally {
        patch(id, { uninstalling: false })
      }
    },
    [patch, refreshAll],
  )

  const cancel = useCallback(async (id: PluginId) => {
    // 状态由 progress cancelled 事件回调复位，此处不重复 patch
    await window.electronAPI.plugins.cancel(id)
  }, [])

  const refresh = useCallback(
    async (_id: PluginId) => {
      await refreshAll()
    },
    [refreshAll],
  )

  return { statuses, install, uninstall, cancel, refresh }
}
