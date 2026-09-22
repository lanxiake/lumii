/**
 * 划词单轮 LLM 通道 API（翻译/解释/总结/润色）
 */
import { ipcRenderer } from 'electron'
import type { SelectionLlmRequest, SelectionLlmResult } from '../../shared/selection-llm-types'

export const selectionApi = {
  /** 跑一个 L2 动作。一次拿完整结果（不做流式），失败走 result.ok=false 而不是 reject */
  run: (request: SelectionLlmRequest): Promise<SelectionLlmResult> =>
    ipcRenderer.invoke('selection:run', request) as Promise<SelectionLlmResult>,

  /** 按 requestId 取消在飞请求；不在飞（已完成/已取消）时返回 false */
  abort: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke('selection:abort', requestId) as Promise<boolean>,
}
