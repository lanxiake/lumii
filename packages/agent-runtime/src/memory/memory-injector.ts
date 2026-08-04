/**
 * MemoryInjector — 将热记忆格式化为 systemPrompt section
 *
 * 在 Agent 每轮调用前，将 L1 热记忆注入到 system prompt 中。
 *
 * 参考 Claude Code memdir.ts 的记忆注入方式：
 * - 按类别分组展示（而非平铺列表）
 * - 增强使用原则（自然运用、过期验证、feedback 遵守）
 * - 三层架构说明（个人 / 工作 / 记忆宫殿）
 */

import type { MemoryEntry, MemoryCategory } from "./types.js";
import { MEMORY_LAYER_RULES } from "./memory-architecture.js";

/** 类别显示名称映射 */
const CATEGORY_LABELS: Readonly<Record<MemoryCategory, string>> = {
  user: "用户画像",
  feedback: "交互偏好",
  project: "进行中的事",
  reference: "外部资源",
  general: "其他",
};

/** 类别显示顺序（user 最前，general 最后） */
const CATEGORY_ORDER: readonly MemoryCategory[] = [
  "user",
  "feedback",
  "project",
  "reference",
  "general",
];

/**
 * 将用户个人记忆 Markdown 文档格式化为 system prompt 段落
 *
 * 个人记忆层：跨会话稳定的用户画像与交互偏好。
 */
export function formatUserMemoryForPrompt(userMemoryContent: string): string {
  if (!userMemoryContent.trim()) return "";

  return [
    "",
    "## 关于用户（个人记忆）",
    "",
    "以下为用户画像与交互偏好，全局适用。与工作记忆（当前任务）冲突时，任务级规则优先于全局偏好；与用户当前陈述冲突时，以当前陈述为准。",
    "",
    userMemoryContent.trim(),
    "",
    "**硬约束**：",
    "- 同一规则只执行最新版本，禁止同时遵循互相矛盾的旧规则",
    "- 标注了适用范围（如某系列/某项目）的规则仅在该范围内生效",
    "- 工具/方法类规则：用户明确要求的方式 > 历史默认方式",
  ].join("\n");
}

/** 统一记忆块的分层条数上限 */
export interface UnifiedMemoryLimits {
  /** 相关记忆（SQLite project/reference/general）层上限，默认 8 */
  readonly related?: number;
}

/**
 * 统一记忆注入块 — 单一 `## 记忆` 分层块。
 *
 * 收敛现有分散的「关于用户 / 你的记忆 / 记忆召回」为一块：
 * - `### 关于用户` ← 个人记忆（user_memory Markdown）
 * - `### 工作记忆` ← SQLite 热记忆（project/reference/general）
 * - 记忆宫殿通过 memory_search 按需召回，不直接全量注入
 */
export function formatUnifiedMemoryBlock(
  userProfile: string | undefined,
  memories: readonly MemoryEntry[],
  limits: UnifiedMemoryLimits = {},
): string {
  const profile = userProfile?.trim();
  const relatedLimit = limits.related ?? 8;
  const related = memories.slice(0, relatedLimit);

  if (!profile && related.length === 0) return "";

  const lines: string[] = ["", "## 记忆", ""];

  // 三层架构摘要
  lines.push(
    "**记忆分层**：个人记忆（你是谁/偏好）→ 工作记忆（当前任务/资源）→ 记忆宫殿（历史细节，memory_search 召回）",
    "",
  );

  if (profile) {
    lines.push(
      "### 关于用户（个人记忆）",
      "",
      profile,
      "",
    );
  }

  if (related.length > 0) {
    lines.push("### 工作记忆（当前任务与资源）");
    const groups = new Map<MemoryCategory, MemoryEntry[]>();
    for (const m of related) {
      const list = groups.get(m.category) ?? [];
      list.push(m);
      groups.set(m.category, list);
    }
    for (const cat of CATEGORY_ORDER) {
      const entries = groups.get(cat);
      if (!entries || entries.length === 0) continue;
      lines.push(`**${CATEGORY_LABELS[cat]}**`);
      for (const e of entries) lines.push(`- ${e.content}`);
    }
    lines.push("");
  }

  lines.push("### 使用原则");
  for (const rule of MEMORY_LAYER_RULES) {
    lines.push(`- ${rule}`);
  }

  return lines.join("\n");
}

/**
 * 将热记忆列表按类别分组格式化为 system prompt 段落
 *
 * 工作记忆层：与当前 Agent/项目绑定的动态任务与资源。
 */
export function formatMemoriesForPrompt(memories: readonly MemoryEntry[]): string {
  if (memories.length === 0) return "";

  const groups = new Map<MemoryCategory, MemoryEntry[]>();
  for (const m of memories) {
    const list = groups.get(m.category) ?? [];
    list.push(m);
    groups.set(m.category, list);
  }

  const sections: string[] = [];
  for (const cat of CATEGORY_ORDER) {
    const entries = groups.get(cat);
    if (!entries || entries.length === 0) continue;
    const label = CATEGORY_LABELS[cat];
    sections.push(`**${label}**`);
    for (const e of entries) {
      sections.push(`- ${e.content}`);
    }
    sections.push("");
  }

  return [
    "",
    "## 工作记忆",
    "",
    "以下是与当前 Agent 绑定的工作记忆（项目、资源、知识），变化较快。需要历史细节时用 `memory_search` 查记忆宫殿。",
    "",
    ...sections,
    "### 使用原则",
    '- 自然地运用记忆，像老朋友一样，不要提及"记忆系统"的技术细节',
    "- 工作记忆是时间点快照，可能已过时——与用户当前陈述冲突时，以当前为准",
    "- 任务级规则（标注了项目/系列范围）仅在该范围内生效，不得外推到其他任务",
    "- 同一主题多条规则时，执行最新版本，忽略已被取代的旧规则",
    '- 用户说"记住"时，按类别写入对应层（偏好→个人记忆，项目→工作记忆）',
    '- 用户说"忘记"时，从对应记忆中移除相关条目',
  ].join("\n");
}

/**
 * 将热记忆注入到 system prompt 末尾
 */
export function injectMemories(systemPrompt: string, memories: readonly MemoryEntry[]): string {
  if (memories.length === 0) return systemPrompt;

  const memoriesSection = formatMemoriesForPrompt(memories);

  // 兼容旧标题 "## 你的记忆" 和新标题 "## 工作记忆"
  const sectionStart = systemPrompt.indexOf("## 工作记忆");
  const legacyStart = systemPrompt.indexOf("## 你的记忆");
  const start = sectionStart !== -1 ? sectionStart : legacyStart;

  if (start !== -1) {
    const nextSection = systemPrompt.indexOf("\n## ", start + 1);
    const sectionEnd = nextSection !== -1 ? nextSection : systemPrompt.length;
    return (
      systemPrompt.slice(0, start).trimEnd() +
      memoriesSection +
      systemPrompt.slice(sectionEnd)
    );
  }

  return systemPrompt.trimEnd() + "\n" + memoriesSection;
}
