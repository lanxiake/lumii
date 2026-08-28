export {
  buildClientSystemPrompt,
  buildClientSystemPromptStructured,
  filterAgentsForCollaborationPrompt,
  CACHE_BOUNDARY_MARKER,
  PROMPT_SECTION_TAGS,
  type PromptSectionTag,
  type ClientSystemPromptParams,
  type SystemPromptResult,
  type ActiveTaskInfo,
  type PromptDetail,
  type SkillInfo,
  type SkillActivationHint,
  type CustomAgentInfo,
  type RouterResultLite,
  type WorkspaceLayout,
  type ContextFile,
  type UserDeviceInfo,
  type McpServerHint,
} from "./system-prompt-builder.js";

/** 工具分组渲染 + 分组注册表（供宿主侧漂移守卫测试内省） */
export {
  categorizeTools,
  PROMPT_TOOL_GROUPS,
  TOOL_SUMMARIES,
} from "./sections/tooling-section.js";

export { MEMORY_GUIDE_CONTENT } from "./guides/index.js";
export { TASK_GUIDE_CONTENT } from "./guides/index.js";
export { A2UI_GUIDE_CONTENT } from "./guides/index.js";
