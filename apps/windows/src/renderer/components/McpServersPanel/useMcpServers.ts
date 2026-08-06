/**
 * MCP Server 配置读写
 *
 * 全部经 agentRuntime.sendCommand 走主进程，写操作成功后自动刷新状态。
 */

import { useCallback, useEffect, useState } from 'react'
import type { McpServerConfigInput, McpServerStatusResult } from '@shared/agent-runtime-commands'

export type McpServer = McpServerStatusResult

/** 写操作统一返回体 */
type MutationResult = { success: boolean; error?: string }

/** preload 的 sendCommand 声明成 unknown，这里统一收口断言 */
type McpCommand =
  | { type: 'mcp:status' }
  | { type: 'mcp:upsert'; entry: McpServerConfigInput; originalName?: string }
  | { type: 'mcp:import'; entries: readonly McpServerConfigInput[] }
  | { type: 'mcp:remove'; name: string }
  | { type: 'mcp:setEnabled'; name: string; enabled: boolean }
  | { type: 'mcp:reconnect'; name: string }

function send<T>(command: McpCommand): Promise<T> {
  return window.electronAPI.agentRuntime.sendCommand(command) as Promise<T>
}

export function useMcpServers() {
  const [servers, setServers] = useState<readonly McpServer[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** 正在执行写操作的 server 名，用于禁用对应行的控件 */
  const [busyName, setBusyName] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const result = await send<readonly McpServer[]>({ type: 'mcp:status' })
      setServers(result ?? [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** 执行一次写操作：置忙 → 发命令 → 刷新 → 返回结果 */
  const mutate = useCallback(
    async (name: string, run: () => Promise<MutationResult>): Promise<MutationResult> => {
      setBusyName(name)
      try {
        const result = await run()
        if (!result.success) setError(result.error ?? '操作失败')
        else setError(null)
        await refresh()
        return result
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        setError(message)
        return { success: false, error: message }
      } finally {
        setBusyName(null)
      }
    },
    [refresh],
  )

  const upsert = useCallback(
    (entry: McpServerConfigInput, originalName?: string) =>
      mutate(entry.name, () => send<MutationResult>({ type: 'mcp:upsert', entry, originalName })),
    [mutate],
  )

  const importServers = useCallback(
    (entries: readonly McpServerConfigInput[]) =>
      mutate('', () => send<MutationResult>({ type: 'mcp:import', entries })),
    [mutate],
  )

  const remove = useCallback(
    (name: string) => mutate(name, () => send<MutationResult>({ type: 'mcp:remove', name })),
    [mutate],
  )

  const setEnabled = useCallback(
    (name: string, enabled: boolean) =>
      mutate(name, () => send<MutationResult>({ type: 'mcp:setEnabled', name, enabled })),
    [mutate],
  )

  const reconnect = useCallback(
    (name: string) => mutate(name, () => send<MutationResult>({ type: 'mcp:reconnect', name })),
    [mutate],
  )

  return {
    servers,
    isLoading,
    error,
    busyName,
    clearError: () => setError(null),
    refresh,
    upsert,
    importServers,
    remove,
    setEnabled,
    reconnect,
  }
}
