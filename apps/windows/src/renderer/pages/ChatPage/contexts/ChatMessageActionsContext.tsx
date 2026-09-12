import React, { createContext, useContext } from 'react'

/**
 * 消息级交互动作：由 ChatPage 注入，ChatMessage 直接消费。
 * 这些是消息行「只用不产」的回调，原先要穿过 ChatContainer / ChatMessageRow
 * 两层（onReviewFileChanges 合计 4 层）转发。
 *
 * 稳定性契约：value 在流式 / 打字 / 回放期间必须保持不变，否则 Context 传播会
 * 绕过 React.memo 的浅比较，导致全部历史消息行重渲染（打字卡顿的根源之一）。
 * 因此这里只放引用稳定的回调：唯一允许换新的时机是会话切换（edit/delete 闭包）
 * 与 workspace 初始化（review 闭包），此时消息行本来就要整体重建。
 */
export interface ChatMessageActions {
  formatTime(date: Date): string
  copyMessage(content: string): void
  editMessage(messageId: string, newContent: string): void
  deleteMessage(messageId: string): void
  regenerateMessage(messageId: string): void
  replayFromMessage(messageId: string): void
  reviewFileChanges(path: string, status: 'added' | 'modified' | 'deleted'): void
}

const ChatMessageActionsContext = createContext<ChatMessageActions | null>(null)

export const ChatMessageActionsProvider: React.FC<{
  value: ChatMessageActions
  children: React.ReactNode
}> = ({ value, children }) => (
  <ChatMessageActionsContext.Provider value={value}>{children}</ChatMessageActionsContext.Provider>
)

/** 获取消息级交互动作；必须在 ChatMessageActionsProvider 内使用 */
export function useChatMessageActions(): ChatMessageActions {
  const ctx = useContext(ChatMessageActionsContext)
  if (!ctx) {
    throw new Error('useChatMessageActions must be used within a ChatMessageActionsProvider')
  }
  return ctx
}
