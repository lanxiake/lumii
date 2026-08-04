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

export function usePlugins(): UsePluginsResult {
  const [statuses, setStatuses] = useState<Record<PluginId, PluginStatus>>({
    'cloak-browser': DEFAULT_STATUS('cloak-browser'),
    'mempalace': DEFAULT_STATUS('mempalace'),
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

  const fetchMemPalaceStatus = useCallback(async () => {
    const s = await window.electronAPI.mempalace.getStatus()
    patch('mempalace', { installed: s.installed })
  }, [patch])

  // 初始化时查询所有状态
  useEffect(() => {
    fetchCloakStatus()
    fetchMemPalaceStatus()
  }, [fetchCloakStatus, fetchMemPalaceStatus])

  const install = useCallback(async (id: PluginId) => {
    patch(id, { installing: true, error: undefined, progress: undefined })
    try {
      if (id === 'cloak-browser') {
        const result = await window.electronAPI.plugins.cloak_browser.install()
        // cancelled 不算失败，静默处理
        if (!result.success && result.error) throw new Error(result.error)
        await fetchCloakStatus()
      } else if (id === 'mempalace') {
        const result = await window.electronAPI.mempalace.install()
        if (!result.success) throw new Error(result.error ?? '安装失败')
        await fetchMemPalaceStatus()
      }
    } catch (err) {
      patch(id, { error: String(err instanceof Error ? err.message : err) })
    } finally {
      patch(id, { installing: false })
    }
  }, [patch, fetchCloakStatus, fetchMemPalaceStatus])

  const uninstall = useCallback(async (id: PluginId) => {
    patch(id, { uninstalling: true, error: undefined })
    try {
      if (id === 'cloak-browser') {
        const result = await window.electronAPI.plugins.cloak_browser.uninstall()
        if (!result.success) throw new Error(result.error ?? '卸载失败')
        await fetchCloakStatus()
      } else if (id === 'mempalace') {
        const result = await window.electronAPI.mempalace.uninstall()
        if (!result.success) throw new Error(result.error ?? '卸载失败')
        await fetchMemPalaceStatus()
      }
    } catch (err) {
      patch(id, { error: String(err instanceof Error ? err.message : err) })
    } finally {
      patch(id, { uninstalling: false })
    }
  }, [patch, fetchCloakStatus, fetchMemPalaceStatus])

  const cancel = useCallback(async (id: PluginId) => {
    if (id === 'cloak-browser') {
      await window.electronAPI.plugins.cloak_browser.cancel()
      // 状态由 onProgress cancelled 事件回调重置，此处不重复 patch
    }
    // mempalace 暂无取消支持
  }, [])

  const refresh = useCallback(async (id: PluginId) => {
    if (id === 'cloak-browser') await fetchCloakStatus()
    else if (id === 'mempalace') await fetchMemPalaceStatus()
  }, [fetchCloakStatus, fetchMemPalaceStatus])

  return { statuses, install, uninstall, cancel, refresh }
}
