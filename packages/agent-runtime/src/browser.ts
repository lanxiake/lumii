/**
 * @mtbot/agent-runtime/browser — 渲染进程可用的纯函数与类型入口
 *
 * 禁止再从主入口 `@mtbot/agent-runtime` 做值导入：主入口会拉入 tools/shell/sqlite 等 Node 代码，
 * 在 Electron renderer（无 process / nodeIntegration）中会直接崩溃。
 */

export {
  applyAssistantPartEvent,
  finalizeAssistantParts,
  diffTurnSnapshots,
} from "./storage/assistant-parts.js";
export type {
  AssistantPart,
  AssistantPartEvent,
  AssistantPartsContent,
  FileChangeEntry,
  TurnFileSnapshot,
  ApplyAssistantPartEventOptions,
  ToolAssistantPart,
} from "./storage/assistant-parts.js";

export {
  parseMessageContentJson,
} from "./storage/message-content-json.js";
export type {
  MessageContentJson,
  TextMessageContent,
  ToolResultContent,
  ToolCallRecord,
} from "./storage/message-content-json.js";

export {
  describeLlmError,
  normalizeLlmError,
} from "./llm/llm-error.js";
export type { LlmErrorDetail } from "./llm/llm-error.js";
