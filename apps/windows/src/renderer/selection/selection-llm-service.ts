/**
 * 划词单轮 LLM 通道的渲染层包装（组件不直接碰 window.electronAPI）
 */

import type { SelectionLlmAction, SelectionLlmResult } from '../../shared/selection-llm-types'

const SELECTION_LLM_ACTIONS: readonly SelectionLlmAction[] = [
  'translate',
  'explain',
  'summarize',
  'polish',
]

/**
 * 跑一个 L2 动作。**requestId 由调用方给** —— 取消是按 id 的，id 生成在服务内部
 * 的话调用方就无从取消。
 *
 * 主进程不可用（如单测环境）时返回可读失败而不是 reject：所有失败在这里已收敛成
 * `{ ok: false, error }` 的同一形态，调用方只判 ok。
 */
export async function runSelectionAction(
  requestId: string,
  action: SelectionLlmAction,
  text: string,
): Promise<SelectionLlmResult> {
  const api = window.electronAPI?.selection
  if (!api?.run) return { ok: false, error: '划词通道不可用' }
  try {
    return await api.run({ requestId, action, text })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 按 requestId 取消。不在飞（已完成/已取消）时主进程返回 false，这里不区分 */
export async function abortSelectionAction(requestId: string): Promise<void> {
  try {
    await window.electronAPI?.selection?.abort?.(requestId)
  } catch {
    // 取消是尽力而为：窗口正在关闭、主进程已退出时失败不影响用户体验
  }
}
