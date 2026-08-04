/**
 * 记忆系统三层架构定义
 *
 * 统一描述个人记忆、工作记忆、记忆宫殿的职责边界与协作关系，
 * 供提取提示词、注入格式化、记忆指南等模块复用。
 */

/** 记忆层级标识 */
export type MemoryLayer = "personal" | "work" | "palace";

/** 记忆层级元信息 */
export interface MemoryLayerInfo {
  readonly id: MemoryLayer;
  readonly label: string;
  readonly storage: string;
  readonly categories: readonly string[];
  readonly purpose: string;
  readonly writeTools: readonly string[];
  readonly readTools: readonly string[];
}

/** 三层记忆架构定义 */
export const MEMORY_LAYERS: readonly MemoryLayerInfo[] = [
  {
    id: "personal",
    label: "个人记忆",
    storage: "PostgreSQL user_memory（Markdown 全文）",
    categories: ["user", "feedback"],
    purpose:
      "跨会话稳定的用户画像与交互偏好：身份、风格、长期习惯、纠正与确认。变化慢、全局适用。",
    writeTools: ["profile_memory"],
    readTools: ["profile_memory", "memory_search"],
  },
  {
    id: "work",
    label: "工作记忆",
    storage: "SQLite agent_memories（按 Agent 隔离）",
    categories: ["project", "reference", "general"],
    purpose:
      "当前进行中的任务、项目约束、外部资源引用。变化快、与具体 Agent/项目绑定，会话结束后可归档。",
    writeTools: ["自动提取", "段落总结"],
    readTools: ["memory_search", "热记忆注入"],
  },
  {
    id: "palace",
    label: "记忆宫殿",
    storage: "MemPalace 本地（Wing→Room→Drawer + 向量检索）",
    categories: ["对话原文", "知识片段"],
    purpose:
      "海量历史对话与知识的语义存档。按主题/时间结构化存储，通过语义搜索召回细节，不直接全量注入 prompt。",
    writeTools: ["memory_store", "agent_end 自动归档"],
    readTools: ["memory_search", "memory_read"],
  },
] as const;

/** 个人记忆类别 */
export const PERSONAL_MEMORY_CATEGORIES = ["user", "feedback"] as const;

/** 工作记忆类别 */
export const WORK_MEMORY_CATEGORIES = ["project", "reference", "general"] as const;

/**
 * 记忆分层协作规则（注入 prompt 的硬约束摘要）
 */
export const MEMORY_LAYER_RULES = [
  "**分层职责**：个人记忆管「你是谁、你怎么喜欢被对待」；工作记忆管「你在做什么、用什么资源」；记忆宫殿管「过去说过什么、搜得到的细节」。",
  "**写入路由**：user/feedback → 个人记忆（profile_memory）；project/reference/general → 工作记忆（自动提取）；大量对话原文 → 记忆宫殿（memory_search 召回）。",
  "**冲突消解**：同一主题多条规则时，以「最近用户明确陈述」为准；任务级规则（如某系列配图数量）不得覆盖全局偏好（如回复风格）；不同项目/系列的规则须标注适用范围。",
  "**去重原则**：语义相同只保留一条，合并为「规则 + 原因 + 应用 + 适用范围」；禁止重复罗列同一约束。",
  "**召回顺序**：先查工作记忆（当前任务）→ 再查个人记忆（偏好画像）→ 需要历史细节时用 memory_search 搜记忆宫殿，命中后用 memory_read 按 drawer_id 读归档原文。",
] as const;

/**
 * 判断记忆类别属于哪一层
 */
export function memoryCategoryToLayer(category: string): MemoryLayer {
  if (category === "user" || category === "feedback") return "personal";
  if (category === "project" || category === "reference" || category === "general") return "work";
  return "palace";
}

/**
 * 构建记忆分层架构说明（用于提取/整理 prompt）
 */
export function buildMemoryArchitectureSection(): string {
  const lines: string[] = ["## 记忆系统三层架构", ""];

  for (const layer of MEMORY_LAYERS) {
    lines.push(
      `### ${layer.label}（${layer.storage}）`,
      `- 类别：${layer.categories.join("、")}`,
      `- 用途：${layer.purpose}`,
      `- 写入：${layer.writeTools.join("、")}`,
      `- 召回：${layer.readTools.join("、")}`,
      "",
    );
  }

  lines.push("## 分层协作与冲突消解", "");
  for (const rule of MEMORY_LAYER_RULES) {
    lines.push(`- ${rule}`);
  }

  return lines.join("\n");
}
