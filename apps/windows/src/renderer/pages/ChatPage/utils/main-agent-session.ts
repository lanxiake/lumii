/**
 * 「系统默认」Agent 会话判定。
 *
 * 会话的 Agent 归属有三种等价存法：
 * - `undefined`：更早的会话没写参与者
 * - `'default'`：会话创建时未指定 Agent（conversation:create 的兜底值）
 * - `'assistant'`：内置默认 Agent 的 id（会话列表出口已把 'main' 归一成这个值）
 * - `'main'`：`ensureConversationExists` 建的会话（渠道 / 定时任务 / 自主进化）写的是
 *   主 Agent 实例的内部标记，不是用户可见的 Agent id
 *
 * 判定分散在多处时容易只认其中一两种，导致同一批会话在侧栏被拆成「默认」和「main」
 * 两个重复分组 —— 统一从这里取。
 */
export function isMainAgentSession(agentId: string | undefined | null): boolean {
  return !agentId || agentId === 'default' || agentId === 'assistant' || agentId === 'main'
}
