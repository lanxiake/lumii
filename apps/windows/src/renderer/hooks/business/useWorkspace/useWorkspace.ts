/**
 * useWorkspace.ts - 工作空间管理 Hook
 *
 * 管理工作空间目录的初始化和快捷导航
 * 与 Gateway 工作空间对齐：SOUL.md、IDENTITY.md、AGENTS.md 等配置文件 + skills/、sandbox/ 等子目录
 */

import { useState, useEffect, useCallback } from 'react'
import type { WorkspaceLocation, UseWorkspaceReturn } from './useWorkspace.types'

/**
 * 工作空间快捷位置配置
 */
const WORKSPACE_LOCATIONS: WorkspaceLocation[] = [
  // 根目录
  { id: 'root', label: '工作空间', icon: '🏠', relativePath: '', group: 'root' },
  // 配置文件组（与 Gateway 工作空间一致）
  { id: 'soul', label: 'SOUL.md', icon: '📝', relativePath: 'SOUL.md', group: 'config' },
  { id: 'identity', label: 'IDENTITY.md', icon: '🪪', relativePath: 'IDENTITY.md', group: 'config' },
  { id: 'agents', label: 'AGENTS.md', icon: '', relativePath: 'AGENTS.md', group: 'config' },
  { id: 'tools', label: 'TOOLS.md', icon: '🔧', relativePath: 'TOOLS.md', group: 'config' },
  { id: 'heartbeat', label: 'HEARTBEAT.md', icon: '💓', relativePath: 'HEARTBEAT.md', group: 'config' },
  { id: 'bootstrap', label: 'BOOTSTRAP.md', icon: '🚀', relativePath: 'BOOTSTRAP.md', group: 'config' },
  // 子目录组
  { id: 'skills', label: 'skills', icon: '⚡', relativePath: 'skills', group: 'directories' },
  { id: 'hooks', label: 'hooks', icon: '🪝', relativePath: '.lumii/hooks', group: 'directories' },
  { id: 'sandbox', label: 'sandbox', icon: '📦', relativePath: 'sandbox', group: 'directories' },
]

/**
 * 工作空间管理 Hook
 *
 * 负责获取工作空间路径、确保目录存在、提供快捷导航结构。
 */
export function useWorkspace(): UseWorkspaceReturn {
  const [workspaceDir, setWorkspaceDir] = useState('')
  const [isInitializing, setIsInitializing] = useState(true)
  const [initError, setInitError] = useState<string | null>(null)

  /**
   * 初始化：获取工作空间路径并确保目录存在
   */
  useEffect(() => {
    let cancelled = false

    async function init() {
      try {
        // 1. 获取工作空间路径
        const dir = await window.electronAPI.workspace.getDir()
        if (cancelled) return

        // 2. 确保目录及子结构存在
        await window.electronAPI.workspace.ensureDir(dir)
        if (cancelled) return

        setWorkspaceDir(dir)
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : '工作空间初始化失败'
          console.error('[useWorkspace] 初始化失败:', msg)
          setInitError(msg)
        }
      } finally {
        if (!cancelled) {
          setIsInitializing(false)
        }
      }
    }

    init()

    return () => {
      cancelled = true
    }
  }, [])

  /**
   * 绝对路径 -> 相对显示路径
   */
  const toRelativePath = useCallback(
    (absolutePath: string): string => {
      if (!workspaceDir) return absolutePath
      const normalized = absolutePath.replace(/\\/g, '/')
      const normalizedRoot = workspaceDir.replace(/\\/g, '/')
      if (normalized.startsWith(normalizedRoot)) {
        const relative = normalized.slice(normalizedRoot.length)
        return relative.startsWith('/') ? relative.slice(1) : relative || '/'
      }
      return absolutePath
    },
    [workspaceDir]
  )

  /**
   * 相对路径 -> 绝对路径（统一正斜杠，与 FileTree 路径规范化一致）
   */
  const toAbsolutePath = useCallback(
    (relativePath: string): string => {
      if (!workspaceDir) return relativePath
      if (!relativePath || relativePath === '/') return workspaceDir.replace(/\\/g, '/')
      const root = workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '')
      const rel = relativePath.replace(/^[\\/]+/, '').replace(/\\/g, '/')
      return `${root}/${rel}`
    },
    [workspaceDir]
  )

  return {
    workspaceDir,
    isInitializing,
    initError,
    locations: WORKSPACE_LOCATIONS,
    toRelativePath,
    toAbsolutePath,
  }
}
