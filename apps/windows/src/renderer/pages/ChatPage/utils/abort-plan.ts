/**
 * 停止按钮的两条收尾策略（纯函数，便于单测）：
 *
 * 1. 还没被模型回答的插话：中断后要把它转成新一轮真正发出。
 *    - 仍「等待注入」（steerPending）→ 模型根本没看到，必须补发；
 *    - 已注入但此后没有任何助手产出 → 那一轮被停了，同样需要补发。
 *    已经有助手产出的插话视为已答，留在历史里即可。
 * 2. 刚发出、Agent 还一个字都没产出：把用户那条消息收回输入框，方便改完重发。
 *    已经产出（正文/工具）时不收回——那是在改写已完成的工作。
 */
import type { RuntimeMessage } from '../../../hooks/business/useAgentRuntime/agent-runtime-store'

export interface AbortPlan {
  /** 还没被回答的插话（按时间序） */
  readonly unansweredSteers: readonly RuntimeMessage[]
  /** 需要收回输入框的用户消息；不需要时为 null */
  readonly restoreUserMessage: RuntimeMessage | null
}

/** 助手是否已经产出过任何可见内容（正文或工具；纯思考不算「回复」） */
function hasAssistantOutput(msg: RuntimeMessage): boolean {
  if (msg.toolCalls.length > 0) return true
  return (
    msg.parts.some(
      (part) => part.type === 'tool' || (part.type === 'text' && part.text.trim().length > 0),
    ) || msg.content.some((block) => block.text.trim().length > 0)
  )
}

export function planAbort(messages: readonly RuntimeMessage[]): AbortPlan {
  const unansweredSteers = messages.filter((m, idx) => {
    if (m.role !== 'user' || m.isSteer !== true) return false
    // 未注入：模型一定没看到它（此时后面即便有产出，也是注入前的旧段）
    if (m.steerPending === true) return true
    // 已注入：此后有助手产出才算被回答
    return !messages
      .slice(idx + 1)
      .some((next) => next.role === 'assistant' && hasAssistantOutput(next))
  })

  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      lastUserIdx = i
      break
    }
  }
  const lastUser = lastUserIdx >= 0 ? messages[lastUserIdx]! : null
  const repliedAfter = messages
    .slice(lastUserIdx + 1)
    .some((m) => m.role === 'assistant' && hasAssistantOutput(m))

  // 插话自己就是最后一条用户消息时不走回填：它属于「正在跑的回合」，
  // 交给上面的 unansweredSteers 分支。
  const restoreUserMessage =
    unansweredSteers.length === 0 &&
    lastUser !== null &&
    lastUser.isSteer !== true &&
    lastUser.content.some((block) => block.text.trim().length > 0) &&
    !repliedAfter
      ? lastUser
      : null

  return { unansweredSteers, restoreUserMessage }
}
