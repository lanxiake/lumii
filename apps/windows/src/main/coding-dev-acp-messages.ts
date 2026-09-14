/**
 * ACP 失败/中止落到会话里的消息文案与判定。
 *
 * 为什么单独成模块（而不是放在 coding-dev-acp-run.ts）：
 * 转交完成监听（`dev-handoff-executor`）需要判定「这条助手消息是失败还是正常产出」，
 * 但不需要、也不应依赖 run 控制器（它拉入 spawn / 解析器等重量级依赖）。
 * 文案与判定放同一处，避免两处前缀漂移。
 *
 * ⚠️ 前缀即契约：`coding-dev-acp-run.ts` 用它们构造消息，`dev-handoff-executor` 用它们判失败。
 * 改动必须两处同步（本模块就是同步点）。
 */

/** ACP 执行失败（含超时）的消息前缀 */
export const ACP_ERROR_PREFIX = '❌ ACP '

/** ACP 被用户取消的消息前缀 */
export const ACP_CANCELLED_PREFIX = '已取消 ACP 执行'

/** 该文本是否为 ACP 失败/中止消息（转交完成监听据此把「完成」判成「失败」） */
export function isAcpRunFailureText(text: string | undefined): boolean {
  if (!text) return false
  const t = text.trim()
  return t.startsWith(ACP_ERROR_PREFIX) || t.startsWith(ACP_CANCELLED_PREFIX)
}
