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
import { stripPersonalMemoryMeta } from "./personal-memory-entries.js";

/** 工作记忆注入占位符（Task 3 P0：取代 indexOf 字符串手术） */
export const MEMORY_PLACEHOLDER = "{{LUMII_MEMORY_BLOCK}}";

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
  // 注入前剥掉条目元数据注释（`<!--m:id date-->`）——那是 harness 的记账字段，
  // 模型既不该看见也不需要看见，留着纯属浪费 token（P1-2 条目化）
  const cleanContent = stripPersonalMemoryMeta(userMemoryContent);
  if (!cleanContent.trim()) return "";

  return [
    "",
    "## 关于用户（个人记忆）",
    "",
    "以下为用户画像与交互偏好，全局适用。与工作记忆（当前任务）冲突时，任务级规则优先于全局偏好；与用户当前陈述冲突时，以当前陈述为准。",
    "",
    cleanContent.trim(),
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

/** 原文指针 `[d:xxxx]`。只匹配行首 32 字符内——大文本上跑全量正则没有意义 */
const DRAWER_TAG_RE = /\[d:[0-9a-fA-F]{4,64}\]/;

/**
 * 指针图例：注入块与 memory_search 的**分工**，不是"什么时候该读"。
 *
 * 第一版把结论压在"记得的结论多数够用"上，实测模型照做了——用户问细节时它也只
 * 拿摘要凑答案。第二版写明触发条件后，`logs-12328`（原文 85033 字）从 0/1 变成 3/3。
 *
 * **第三版试过、已回退**：加了一句"搜索结果里那些'差不多'的内容不保证更贴题，
 * 这条原文之所以在场正是因为系统判定它相关"，想治「搜到替代品就不回去读注入那条」。
 * 实测整体命中率 67% → 56%（`tocc-sync` 0/3→2/3 但 `logs-12328` 3/3→0/3），
 * 每轮多 120 字符却拿不出收益——按本仓「换检索栈要有数据依据」同一条纪律，回退。
 * 那一版还顺带暴露了 `memory_read` 的 drawerId 格式 bug（见该工具的参数描述）。
 *
 * **第四版（当前）**：「搜到替代品就不回去读」的根因不在措辞，在检索本身——实测
 * `tocc-sync` 那条原文在 bigram 检索里排 52/608，候选池只取 30 条，它**从没进过结果**，
 * 模型搜完当然找不到它，于是读了别的抽屉。检索侧已修（`PalaceRepo` 的 `pinnedIds`：
 * 注入层给过指针的原文保送进候选池）。所以这里不再重申"该读就读"，改为讲清三者分工，
 * 并明确禁止「搜了一遍、拿搜到的东西当答案」这条路。
 */
const POINTER_LEGEND = [
  "- 行首 `[d:xxxx]` 是这条记忆的**原文指针**，可直接交给 `memory_read` 读全文（只传 16 位 hex，不带 `[d:` 和 `]`），**不需要先 memory_search**。",
  "- 摘要只够答结论性的问题。用户问**细节、原话、完整过程、当时的取舍**时，摘要必定答不全——先读原文再答。只是复述结论、或这条与本轮无关时，不必读。",
  "- 要查的东西**上面没提到**时才走 `memory_search`；搜到的内容与上面某条讲的是同一件事时，**以注入层这条为准**——它经过相关性筛选取舍，而搜索只按词命中排序（同一个问题扫过 5000 字日志、反复出现的报错模式这类，搜索往往只命中它的只言片语）。",
] as const;

/**
 * 统一记忆注入块 — 单一 `## 记忆` 分层块。
 *
 * 收敛现有分散的「关于用户 / 你的记忆 / 记忆召回」为一块：
 * - `### 关于用户` ← 个人记忆（user_memory Markdown）
 * - `### 工作记忆` ← SQLite 热记忆（project/reference/general）
 * - 记忆宫殿通过 memory_search 按需召回，不直接全量注入
 *
 * **原文指针**：条目前缀 `[d:xxxx]` 由调用方事先写进 `content`（且须经
 * `PalaceRepo.existsByIds` 校验存在性——死链比没有指针更糟，模型点开报错会开始
 * 怀疑整块记忆）。这里只负责"发现有没有指针、有就补图例"。校验留在调用方是因为
 * 本模块是纯格式化、不持有 DB 句柄。
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

  let hasPointer = false;
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
      for (const e of entries) {
        if (DRAWER_TAG_RE.test(e.content.slice(0, 32))) hasPointer = true;
        lines.push(`- ${e.content}`);
      }
    }
    lines.push("");
  }

  lines.push("### 使用原则");
  for (const rule of MEMORY_LAYER_RULES) {
    lines.push(`- ${rule}`);
  }
  if (hasPointer) {
    for (const line of POINTER_LEGEND) lines.push(line);
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
 * 将热记忆注入到 system prompt 的 {@link MEMORY_PLACEHOLDER} 占位符处。
 *
 * 占位符缺失时：开发期抛错（暴露模板缺失问题），生产期告警降级并返回原串
 * （模板问题不能让用户完全用不了）。空记忆列表时占位符替换为空串，
 * 不能把 `{{...}}` 字面量泄漏到模型输入。
 */
export function injectMemories(systemPrompt: string, memories: readonly MemoryEntry[]): string {
  const block = memories.length > 0 ? formatMemoriesForPrompt(memories) : "";

  if (systemPrompt.includes(MEMORY_PLACEHOLDER)) {
    return systemPrompt.replace(MEMORY_PLACEHOLDER, block);
  }
  if (process.env.NODE_ENV !== "production") {
    throw new Error(`system prompt 缺少 ${MEMORY_PLACEHOLDER}`);
  }
  console.warn(`[injectMemories] 缺少占位符，记忆未注入`);
  return systemPrompt;
}

/**
 * 宽容清除占位符（不抛错，无占位符时原样返回）。
 *
 * 用于"本轮不注入"的分支（开关关闭 / 无管理器 / 无命中记忆）：
 * 占位符必须出清，不能让 `{{LUMII_MEMORY_BLOCK}}` 字面量进入模型输入。
 */
export function stripMemoryPlaceholder(systemPrompt: string): string {
  return systemPrompt.includes(MEMORY_PLACEHOLDER)
    ? systemPrompt.replaceAll(MEMORY_PLACEHOLDER, "")
    : systemPrompt;
}
