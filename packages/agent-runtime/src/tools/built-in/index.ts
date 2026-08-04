/**
 * 内建工具集 — 导出所有工具配置
 */

export { bashToolConfig } from "./bash-tool.js";
export { fileReadToolConfig } from "./file-read-tool.js";
export { fileWriteToolConfig } from "./file-write-tool.js";
export { fileEditToolConfig } from "./file-edit-tool.js";
export { globToolConfig } from "./glob-tool.js";
export { grepToolConfig } from "./grep-tool.js";
export { webFetchToolConfig } from "./web-fetch-tool.js";
export { webSearchToolConfig } from "./web-search-tool.js";
export { spawnAgentToolConfig } from "./spawn-agent-tool.js";
export { sendMessageToolConfig } from "./send-message-tool.js";
export { todoWriteToolConfig } from "./task-tools.js";
export { cronCreateToolConfig, cronListToolConfig, cronDeleteToolConfig } from "./cron-tools.js";
export {
  messageToolConfig,
  nodesToolConfig,
  memorySearchToolConfig,
  memoryReadToolConfig,
  profileMemoryToolConfig,
  systemPromptToolConfig,
  ttsGenerateToolConfig,
} from "./integration-tools.js";
export {
  askUserQuestionToolConfig,
  formatAskUserQuestionResult,
  type AskUserQuestionInput,
  type AskUserQuestionQuestion,
  type AskUserQuestionOption,
  type AskUserQuestionAnswer,
} from "./ask-user-question-tool.js";
export {
  skillListToolConfig,
  skillSearchToolConfig,
  skillInvokeToolConfig,
} from "./skill-tools.js";
export {
  sessionCreateToolConfig,
  sessionClearToolConfig,
  sessionCompactToolConfig,
  sessionResumeToolConfig,
  settingsThinkToolConfig,
  settingsBackendToolConfig,
  infoStatusToolConfig,
  memoryManageToolConfig,
} from "./client-command-tools.js";
export {
  agentTeamGenerateToolConfig,
  agentTeamOptimizeToolConfig,
  agentRemoveToolConfig,
} from "./agent-management-tools.js";
export { taskCompleteToolConfig } from "./task-complete-tool.js";
export { imageGenerateToolConfig, type ImageGenerateResult } from "./image-generate-tool.js";
export {
  DEFAULT_IMAGE_MODEL_ID,
  IMAGE_GENERATION_MODEL_OPTIONS,
  IMAGE_MODEL_GUIDE,
  buildImageModelSelectionGuideForAgent,
  isKnownImageGenerationModel,
  normalizeImageModelId,
  type ImageGenerationModelOption,
} from "./image-models.js";
export * as ToolNames from "./tool-names.js";

import type { MtBotToolConfig } from "../tool-adapter.js";
import { bashToolConfig } from "./bash-tool.js";
import { fileReadToolConfig } from "./file-read-tool.js";
import { fileWriteToolConfig } from "./file-write-tool.js";
import { fileEditToolConfig } from "./file-edit-tool.js";
import { globToolConfig } from "./glob-tool.js";
import { grepToolConfig } from "./grep-tool.js";
import { webFetchToolConfig } from "./web-fetch-tool.js";
import { webSearchToolConfig } from "./web-search-tool.js";
import { spawnAgentToolConfig } from "./spawn-agent-tool.js";
import { sendMessageToolConfig } from "./send-message-tool.js";
import { todoWriteToolConfig } from "./task-tools.js";
import { cronCreateToolConfig, cronListToolConfig, cronDeleteToolConfig } from "./cron-tools.js";
import {
  messageToolConfig,
  nodesToolConfig,
  memorySearchToolConfig,
  memoryReadToolConfig,
  profileMemoryToolConfig,
  systemPromptToolConfig,
  ttsGenerateToolConfig,
} from "./integration-tools.js";
import { askUserQuestionToolConfig } from "./ask-user-question-tool.js";
import {
  skillListToolConfig,
  skillSearchToolConfig,
  skillInvokeToolConfig,
} from "./skill-tools.js";
import {
  sessionCreateToolConfig,
  sessionClearToolConfig,
  sessionCompactToolConfig,
  sessionResumeToolConfig,
  settingsThinkToolConfig,
  settingsBackendToolConfig,
  infoStatusToolConfig,
  memoryManageToolConfig,
} from "./client-command-tools.js";
import {
  agentTeamGenerateToolConfig,
  agentTeamOptimizeToolConfig,
  agentRemoveToolConfig,
} from "./agent-management-tools.js";
import { taskCompleteToolConfig } from "./task-complete-tool.js";
import { imageGenerateToolConfig } from "./image-generate-tool.js";

/** 所有内建工具配置（使用 any 擦除泛型，具体类型由各工具单独导出保留） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALL_BUILT_IN_TOOL_CONFIGS: readonly MtBotToolConfig<any, any>[] = [
  bashToolConfig,
  fileReadToolConfig,
  fileWriteToolConfig,
  fileEditToolConfig,
  globToolConfig,
  grepToolConfig,
  webFetchToolConfig,
  webSearchToolConfig,
  spawnAgentToolConfig,
  sendMessageToolConfig,
  todoWriteToolConfig,
  cronCreateToolConfig,
  cronListToolConfig,
  cronDeleteToolConfig,
  messageToolConfig,
  nodesToolConfig,
  memorySearchToolConfig,
  memoryReadToolConfig,
  profileMemoryToolConfig,
  systemPromptToolConfig,
  ttsGenerateToolConfig,
  askUserQuestionToolConfig,
  skillListToolConfig,
  skillSearchToolConfig,
  skillInvokeToolConfig,
  sessionCreateToolConfig,
  sessionClearToolConfig,
  sessionCompactToolConfig,
  sessionResumeToolConfig,
  settingsThinkToolConfig,
  settingsBackendToolConfig,
  infoStatusToolConfig,
  memoryManageToolConfig,
  agentTeamGenerateToolConfig,
  agentTeamOptimizeToolConfig,
  agentRemoveToolConfig,
  taskCompleteToolConfig,
  imageGenerateToolConfig,
];
