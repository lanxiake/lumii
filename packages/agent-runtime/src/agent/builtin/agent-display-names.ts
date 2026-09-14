/**
 * 内置 Agent 显示名单一事实源（主进程与渲染进程共用）
 *
 * 背景（2026-09-14，见 docs/plans/专项Agent/08-委托可见性.md）：
 * 委托卡片曾在渲染层硬编码一份 id → 显示名表，与 `BUILTIN_AGENT_DEFINITIONS` 手工同步，
 * 模型传入表外 id（实测出现 `default` / `worker` / `builtin:explore`）时查表落空，
 * 卡片便回退显示模型自填的 `args.name`（如 `24shi-b12-fix` 这类编码串）。
 *
 * 本模块**零依赖**（不 import definitions.js，避免把 tools/shell 等 Node 代码带进渲染进程），
 * 因此可从 `@mtbot/agent-runtime/browser` 导出。
 * 与 `BUILTIN_AGENT_DEFINITIONS` 的一致性由单测强制 `agent-display-names.test.ts` 守住——
 * 两边漂移即测试失败，这是本表唯一被允许的存在方式。
 */

/** 内置 Agent id → 显示名（与 definitions.ts 的 BUILTIN_AGENT_DEFINITIONS 一一对应） */
export const BUILTIN_AGENT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  assistant: "系统默认",
  "builtin:explore": "Explore (代码探索)",
  "builtin:plan": "Plan (架构规划)",
  "builtin:verify": "Verify (对抗性验证)",
  "code-dev": "灵栖开发",
  "system-keeper": "灵栖维护",
  chronicler: "灵栖记事",
  "info-curator": "灵栖情报",
};

/**
 * 历史别名归一（与 `findBuiltInAgent` 的兼容规则保持一致）
 *
 * `main` / `default` 是旧代码里「通用入口」的写法，语义等同 `assistant`。
 */
export const BUILTIN_AGENT_ID_ALIASES: Readonly<Record<string, string>> = {
  main: "assistant",
  default: "assistant",
};

/**
 * 把 agentType 归一为规范 id：命中历史别名则转换，其余（含用户自建 Agent id）原样返回。
 */
export function normalizeAgentTypeId(id: string): string {
  const key = id.trim();
  return BUILTIN_AGENT_ID_ALIASES[key] ?? key;
}

/**
 * 解析内置 Agent 显示名。
 *
 * 非内置 id（用户自建 Agent、模型编造的类型）返回 `undefined`，由调用方决定回退策略。
 */
export function resolveBuiltinDisplayName(id: string): string | undefined {
  return BUILTIN_AGENT_DISPLAY_NAMES[normalizeAgentTypeId(id)];
}
