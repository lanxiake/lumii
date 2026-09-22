/**
 * 划词单轮 LLM 通道的契约（渲染层 ↔ 主进程）。
 *
 * 只服务于划词的 L2 动作：单轮、短输出、不进对话历史。
 * 通道形态按设计 §八.1 的实测结论定：**不做流式** —— 卡的是端点排队而不是生成，
 * 首字节之前无字可显示，流式治不了排队。所以一次 invoke 拿完整结果 + 一个 abort。
 */

/** L2 动作。提示词在主进程按此拼装，渲染层不碰提示词 */
export type SelectionLlmAction = 'translate' | 'explain' | 'summarize' | 'polish'

export interface SelectionLlmRequest {
  requestId: string
  action: SelectionLlmAction
  text: string
}

export interface SelectionLlmResult {
  ok: boolean
  /** ok=false 时的可读原因 */
  error?: string
  text?: string
}
