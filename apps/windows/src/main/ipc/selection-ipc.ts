/**
 * 划词单轮 LLM 通道 IPC
 *
 * 两条通道，无第三条：
 * - `selection:run`    一次调用拿完整结果（不做流式，见 selection-llm.ts 的说明）
 * - `selection:abort`  按 requestId 取消在飞的请求
 *
 * 服务是单例（在 IPC 注册时用 bridge 的 getter 构造）：取消要能命中同一个在飞请求，
 * 就只能是同一份 active Map。
 */

import { ipcMain } from 'electron'
import type { AgentRuntimeBridge } from '../agent-runtime'
import { SelectionLlmService } from '../selection/selection-llm'
import type { SelectionLlmRequest, SelectionLlmResult } from '../../shared/selection-llm-types'

interface SelectionIpcDeps {
  getAgentRuntimeBridge: () => AgentRuntimeBridge | null
}

export function registerSelectionIpcHandlers(deps: SelectionIpcDeps): void {
  const service = new SelectionLlmService({
    resolveChatStream: () => deps.getAgentRuntimeBridge()?.resolveSelectionChatStream(),
  })

  ipcMain.handle(
    'selection:run',
    async (_event, request: SelectionLlmRequest): Promise<SelectionLlmResult> => {
      if (!request || typeof request.requestId !== 'string' || typeof request.action !== 'string') {
        return { ok: false, error: '请求参数无效' }
      }
      return service.run(request)
    },
  )

  // 取消不存在的请求是常态（气泡先关了、请求已经结束），返回 false 而不是抛
  ipcMain.handle('selection:abort', (_event, requestId: string): boolean => {
    return typeof requestId === 'string' ? service.abort(requestId) : false
  })
}
