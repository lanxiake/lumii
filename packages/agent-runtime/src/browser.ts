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

// Wiki 页面 diff 是纯计算（不碰数据库），放渲染进程算，避免每次对比多一次 IPC 往返
// （见 docs/plans/记忆重构/2026-08-26-wiki-p1-implementation.md §11.1）
export { diffLines } from "./wiki/line-diff.js";
export type { DiffLine, DiffLineType } from "./wiki/line-diff.js";

// 附件引用语法的序列化是纯字符串拼接，渲染进程拖拽上传后直接生成插入正文
export { serializeAttachmentReference } from "./wiki/wiki-attachments.js";

// 临时存放常量是纯字符串，渲染进程用于选择器排除项与文件列表操作按钮判断
export { PARKING_CATEGORY } from "./wiki/wiki-topic-tree.js";
