/**
 * 云同步工具注册：resolve_sync_conflict（冲突落决）+ cloud_sync_read_file（读三方内容）。
 * 与 bridge-tool-registrar-cron 同模式：纯函数式注册，仅依赖注入的 deps。
 */
import { Type } from '@sinclair/typebox'
import { createMtBotTool, type MtBotToolConfig } from '@mtbot/agent-runtime'
import { agentRuntimeLog as log, jsonToolResult } from './bridge-utils'
import { getCloudSyncManager } from '../cloud-sync/sync-accessor'
import type { BridgeToolRegistrarDeps } from './bridge-tool-registrar-types'

export function registerSyncConflictTool(deps: BridgeToolRegistrarDeps): void {
  const ctx = deps.toolContext
  if (!ctx) return

  const readFile: MtBotToolConfig = {
    name: 'cloud_sync_read_file',
    label: 'Read Cloud Sync File',
    category: 'filesystem' as const,
    description:
      '读取云同步冲突中某文件的 local/remote/base 三侧任一版本内容，用于判断如何解决冲突。仅在存在同步冲突时可用。',
    parameters: Type.Object({
      side: Type.String({
        enum: ['local', 'remote', 'base'],
        description: 'local=本地版本 / remote=远端版本 / base=共同祖先版本',
      }),
      filepath: Type.String({ description: '文件相对工作空间根目录的路径' }),
    }),
    isReadOnly: true,
    needsPermission: false,
    execute: async (_id, rawParams) => {
      const p = rawParams as { side: 'local' | 'remote' | 'base'; filepath: string }
      const m = getCloudSyncManager()
      if (!m) return jsonToolResult({ status: 'error', message: '云同步未初始化' })
      const content = await m.readFileAt(p.side, p.filepath)
      if (content === null) {
        return jsonToolResult({
          status: 'error',
          message: `无法读取 ${p.side}/${p.filepath}（无冲突或文件不存在）`,
        })
      }
      return jsonToolResult({ status: 'ok', side: p.side, filepath: p.filepath, content })
    },
  }
  deps.toolRegistry.register(createMtBotTool(readFile, ctx))

  const resolve: MtBotToolConfig = {
    name: 'resolve_sync_conflict',
    label: 'Resolve Cloud Sync Conflict',
    category: 'filesystem' as const,
    description:
      '解决工作空间云同步冲突。仅在收到同步冲突通知时调用。先用 cloud_sync_read_file 读三方内容再决定策略：' +
      'keep-local 全部保留本地 / keep-remote 全部采用远端 / per-file 逐文件指定取侧。',
    parameters: Type.Object({
      strategy: Type.String({
        enum: ['keep-local', 'keep-remote', 'per-file'],
        description: '冲突解决策略',
      }),
      choices: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String({ description: '文件相对路径' }),
            side: Type.String({ enum: ['local', 'remote'], description: '该文件取哪一侧' }),
          }),
          { description: '仅 strategy=per-file 时必填，逐文件指定取侧' },
        ),
      ),
    }),
    isReadOnly: false,
    needsPermission: false,
    execute: async (_id, rawParams) => {
      const p = rawParams as {
        strategy: 'keep-local' | 'keep-remote' | 'per-file'
        choices?: { path: string; side: 'local' | 'remote' }[]
      }
      if (p.strategy === 'per-file' && !p.choices?.length) {
        return {
          ...jsonToolResult({ status: 'error', message: 'strategy=per-file 时必须提供 choices' }),
          isError: true,
        }
      }
      const m = getCloudSyncManager()
      if (!m) {
        return {
          ...jsonToolResult({ status: 'error', message: '云同步未初始化' }),
          isError: true,
        }
      }
      const r = await m.resolveConflict(p.strategy, p.choices)
      if (!r.success) {
        return {
          ...jsonToolResult({
            status: 'error',
            success: false,
            error: r.error ?? '解决冲突失败',
            hint:
              '若返回「冲突信息已刷新」，说明远端在落决期间有新提交：可重新读取三方内容后再处理一次。' +
              '若持续超时，同步仍会在后台完成并自动重试，无需手动清理任何目录。',
          }),
          isError: true,
        }
      }
      return jsonToolResult({ status: 'ok', success: true })
    },
  }
  deps.toolRegistry.register(createMtBotTool(resolve, ctx))
  log.info('[registerSyncConflictTool] cloud_sync_read_file / resolve_sync_conflict registered')
}
