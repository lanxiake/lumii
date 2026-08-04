/**
 * Messaging 模块入口
 */

export { MessageBus } from "./message-bus.js";
export type { AgentBusMessage } from "./message-bus.js";

export {
  isStructuredMessage,
  normalizeMessage,
  serializeMessage,
  parseStructuredMessage,
} from "./message-types.js";
export type {
  TextMessage,
  ShutdownRequest,
  ShutdownResponse,
  TaskNotification,
  PlanApprovalRequest,
  PlanApprovalResponse,
  StructuredMessage,
} from "./message-types.js";
