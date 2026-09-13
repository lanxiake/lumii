export {
  buildClientSystemPrompt,
  buildClientSystemPromptStructured,
  filterAgentsForCollaborationPrompt,
  CACHE_BOUNDARY_MARKER,
  PROMPT_SECTION_TAGS,
  PROMPT_SECTIONS,
  type PromptSectionTag,
  type PromptSectionId,
  type PromptSectionGroup,
  type PromptSectionMeta,
  type PromptSectionStat,
  type PromptExpandRoute,
  type ClientSystemPromptParams,
  type SystemPromptResult,
  type ActiveTaskInfo,
  type PromptStyle,
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

/** 段完整指南（terse 引导句 prompt_guide 的展开内容） */
export {
  PROMPT_GUIDE_SECTIONS,
  getPromptSectionGuide,
  listPromptGuideSections,
  type PromptSectionGuide,
} from "./section-guides.js";

export { MEMORY_GUIDE_CONTENT } from "./guides/index.js";
export { TASK_GUIDE_CONTENT } from "./guides/index.js";
export { A2UI_GUIDE_CONTENT } from "./guides/index.js";
