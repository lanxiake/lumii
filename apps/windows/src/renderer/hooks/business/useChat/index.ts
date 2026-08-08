/**
 * useChat/index.ts - 对话管理类型统一导出
 *
 * useChat hook 已随独立版移除（聊天走 useAgentRuntimeActions 本地 Runtime），
 * 仅保留组件仍引用的类型定义。
 */

export type {
  ChatMessage,
  ChatSession,
  SessionSource,
  StreamingMessage,
  ChatEventPayload,
  MessageAttachment,
  ToolCall,
  AgentEventPayload,
  AgentEventData,
  AgentWorkflowItem,
  ChildToolItem,
  SubagentRun,
  RunRecord,
  AssistantPart,
  FileChangeEntry,
} from './useChat.types'
