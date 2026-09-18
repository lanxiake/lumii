import { useState, useEffect, useCallback, useRef } from 'react'
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
  statuses: Record<PluginId, PluginStatus>
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
 * 插件中心的安装状态。
 *
 * 目前只剩 CloakBrowser 一个真·插件。记忆宫殿曾以 MemPalace 插件形式存在，
 * 2026-09-18 换成本地 SQLite 自研实现后**没有安装态**了（数据就在应用自己的库里），
 * 因此从这里移除——它的状态由 `usePalace` 自己管。
 */
export function usePlugins(): UsePluginsResult {
  const [statuses, setStatuses] = useState<Record<PluginId, PluginStatus>>({
    'cloak-browser': DEFAULT_STATUS('cloak-browser'),
  })

  const unsubRef = useRef<(() => void) | null>(null)

  const patch = useCallback((id: PluginId, delta: Partial<PluginStatus>) => {
    setStatuses((prev) => ({ ...prev, [id]: { ...prev[id], ...delta } }))
  }, [])

  // 订阅 CloakBrowser 进度
  useEffect(() => {
    const unsub = window.electronAPI.plugins.cloak_browser.onProgress((p) => {
      if (p.phase === 'cancelled') {
        patch('cloak-browser', { installing: false, progress: undefined, error: undefined })
        return
      }
      patch('cloak-browser', {
        progress: { phase: p.phase, percent: p.percent, downloadedBytes: p.downloadedBytes, totalBytes: p.totalBytes, mirror: p.mirror },
        error: p.phase === 'error' ? p.error : undefined,
      })
    })
    unsubRef.current = unsub
    return () => unsub()
  }, [patch])

  const fetchCloakStatus = useCallback(async () => {
    const s = await window.electronAPI.plugins.cloak_browser.getStatus()
    patch('cloak-browser', { installed: s.installed, version: s.version, exePath: s.exePath })
  }, [patch])

  // 初始化时查询状态
  useEffect(() => {
    fetchCloakStatus()
  }, [fetchCloakStatus])

  const install = useCallback(async (id: PluginId) => {
    patch(id, { installing: true, error: undefined, progress: undefined })
    try {
      if (id === 'cloak-browser') {
        const result = await window.electronAPI.plugins.cloak_browser.install()
        // cancelled 不算失败，静默处理
        if (!result.success && result.error) throw new Error(result.error)
        await fetchCloakStatus()
      }
    } catch (err) {
      patch(id, { error: String(err instanceof Error ? err.message : err) })
    } finally {
      patch(id, { installing: false })
    }
  }, [patch, fetchCloakStatus])

  const uninstall = useCallback(async (id: PluginId) => {
    patch(id, { uninstalling: true, error: undefined })
    try {
      if (id === 'cloak-browser') {
        const result = await window.electronAPI.plugins.cloak_browser.uninstall()
        if (!result.success) throw new Error(result.error ?? '卸载失败')
        await fetchCloakStatus()
      }
    } catch (err) {
      patch(id, { error: String(err instanceof Error ? err.message : err) })
    } finally {
      patch(id, { uninstalling: false })
    }
  }, [patch, fetchCloakStatus])

  const cancel = useCallback(async (id: PluginId) => {
    if (id === 'cloak-browser') {
      await window.electronAPI.plugins.cloak_browser.cancel()
      // 状态由 onProgress cancelled 事件回调重置，此处不重复 patch
    }
  }, [])

  const refresh = useCallback(async (id: PluginId) => {
    if (id === 'cloak-browser') await fetchCloakStatus()
  }, [fetchCloakStatus])

  return { statuses, install, uninstall, cancel, refresh }
}
