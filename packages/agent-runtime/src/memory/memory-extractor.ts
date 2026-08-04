/**
 * MemoryExtractor — 从对话中提取候选记忆
 *
 * 两种互补的提取方式：
 * 1. 规则提取（零成本，每轮同步执行）
 * 2. LLM 辅助提取（消耗 token，每 N 轮异步执行）
 */

import type { MemoryCategory, ExtractedCandidate } from "./types.js";
import { buildMemoryArchitectureSection } from "./memory-architecture.js";

// ─── 规则提取 ───

interface RulePattern {
  readonly regex: RegExp;
  readonly category: MemoryCategory;
  readonly importance: number;
  readonly tags: readonly string[];
  readonly extract: (match: RegExpMatchArray, fullText: string) => string;
}

/**
 * 规则模式：仅保留"高置信、低误触发"的少量条目。
 *
 * 设计原则（类 Qoder 的记忆理念）：
 *   - 规则只负责识别极明确的"自我陈述"——用户在主动告知助手一个关于自己的**事实**。
 *   - 凡涉及"任务指令 / 操作意愿 / 避免某事"等，统统交给 LLM 提取（任务结束后），
 *     因为这些语义在对话中高度依赖上下文，正则无法判断是"记忆"还是"一次性指令"。
 *   - 曾经的"我要 / 我需要 / 不要 / 我计划 / 我常用 / 我正在"等宽泛规则已移除——
 *     它们会把 Prompt 里的任务描述（如"不要改变原文结构"）误当成用户的长期偏好。
 */
const RULE_PATTERNS: readonly RulePattern[] = [
  // ① 显式记忆指令：用户明确要求存一条记忆（最高优先）
  {
    regex:
      /(?:请?记住|请?帮我记住?|请?记下|存一下(?:这个|这条)?|保存(?:到|为)?记忆|remember\s+this|save\s+to\s+memory)\s*[:：]?\s*(.{2,200})/i,
    category: "general",
    importance: 0.95,
    tags: ["explicit"],
    extract: (match) => match[1]!.trim(),
  },

  // ② 姓名（短名词，误触发概率极低）
  {
    regex: /(?:^|[。.！!？?，,\s])(?:我(?:的名字)?叫|my\s+name\s+is)\s*([^\s,，。.!！?？]{1,10})/i,
    category: "user",
    importance: 0.8,
    tags: ["identity", "name"],
    extract: (match) => `用户自称: ${match[1]}`,
  },

  // ③ 年龄（纯数字 + 岁，几乎不会误触发）
  {
    regex: /我(?:今年)?\s*(\d{1,3})\s*岁/,
    category: "user",
    importance: 0.6,
    tags: ["age"],
    extract: (match) => `用户年龄: ${match[1]}岁`,
  },

  // ④ 位置（我住在/我来自/我现居/坐标 + 短地名）
  //    注意：故意不匹配裸 "我在"——中文里 "我在X" 绝大多数是 "我在[做某事]"
  //    （如"我在说话/我在开会"），而非 "我位于X"，会制造大量脏数据。
  //    地点类自我陈述若句式不明确，交给任务结束后的 LLM 提取做语义判断。
  {
    regex:
      /(?:^|[。.！!？?，,\s])(?:我(?:住在|来自|现居|定居|坐标(?:在|于)?)|i(?:'m|\s+am)\s+(?:in|from|based\s+in))\s*([^\s,，。.!！?？]{2,15})/i,
    category: "user",
    importance: 0.7,
    tags: ["location"],
    extract: (match) => `用户位置: ${match[1]!.trim()}`,
  },

  // ⑤ 饮食/过敏（健康类高价值，且句式明确）
  {
    regex:
      /我\s*(?:对\s*([^\s,，。.!！?？]{2,15})\s*过敏|乳糖不耐受?|(?:是|属于)\s*(?:素食者?|纯素(?:食)?|清真)|吃素)/,
    category: "user",
    importance: 0.75,
    tags: ["health", "diet"],
    extract: (match, fullText) =>
      match[1] ? `饮食/过敏: 对${match[1]}过敏` : `饮食/过敏: ${fullText.trim().slice(0, 60)}`,
  },

  // ⑥ 职业（带明确职业词结尾，避免泛化匹配）
  {
    regex:
      /我(?:是|做|从事|担任)(?:一[名位个])?\s*([^\s,，。.!！?？]{2,12}?(?:工程师|开发者|程序员|设计师|产品经理|项目经理|分析师|科学家|研究员|老师|教师|医生|律师|会计|学生|作家|艺术家))/,
    category: "user",
    importance: 0.7,
    tags: ["role", "profession"],
    extract: (match) => `用户职业: ${match[1]}`,
  },
];

/**
 * 规则提取器：从用户消息中按模式匹配提取候选记忆。
 * 零 LLM 成本，每轮对话结束后同步调用。
 */
export function extractByRules(userMessages: readonly string[]): readonly ExtractedCandidate[] {
  const candidates: ExtractedCandidate[] = [];

  for (const text of userMessages) {
    for (const pattern of RULE_PATTERNS) {
      const match = text.match(pattern.regex);
      if (match) {
        const content = pattern.extract(match, text);
        if (content.length >= 4 && content.length <= 500) {
          candidates.push({
            content,
            category: pattern.category,
            importance: pattern.importance,
            tags: pattern.tags,
          });
        }
      }
    }
  }

  return candidates;
}

// ─── 关键词触发 ───

/**
 * 记忆触发关键词：用户明确要求把某件事记下。
 *
 * 命中任意一个 → AgentInstance 应**立即**调用 LLM 提取（不等 extractEvery 轮次），
 * 因为用户已经明确表达了"记住"意图。相比过去的正则贪婪匹配，这只用来判断
 * 是否触发 LLM 流程，由 LLM 自己做语义理解和结构化。
 */
const MEMORY_TRIGGER_PATTERNS: readonly RegExp[] = [
  /请?记住/,
  /请?帮我记/,
  /请?记下/,
  /存一下(?:这个|这条)?/,
  /保存(?:到|为)?记忆/,
  /remember\s+this/i,
  /save\s+to\s+memory/i,
  /memo(?:rize)?\s+this/i,
];

/**
 * 检测用户文本中是否含"保存记忆"的显式触发词。
 * 调用方：AgentInstance 每收到一条新用户消息时快速判断，
 *        命中则跳过 extractEvery 节流，立即异步 LLM 提取。
 */
export function hasMemoryTrigger(userText: string): boolean {
  for (const re of MEMORY_TRIGGER_PATTERNS) {
    if (re.test(userText)) return true;
  }
  return false;
}

// ─── LLM 辅助提取 ───

/** 已有记忆上下文（提取时一并提供给 LLM 做去重与冲突判断） */
export interface ExistingMemoryContext {
  /** 个人记忆 Markdown 全文（user_memory） */
  readonly personalMemory?: string;
  /** 工作记忆条目（SQLite agent_memories） */
  readonly workMemories?: readonly { readonly content: string; readonly category: string }[];
}

/**
 * 构建 LLM 提取提示词
 *
 * 增强点（记忆系统升级）：
 * - 三层架构说明（个人 / 工作 / 记忆宫殿）
 * - 个人 vs 工作写入边界
 * - 历史记忆全量上下文（个人 + 工作分开列出）
 * - 去重与冲突消解规则
 */
export function buildExtractionPrompt(
  recentMessages: readonly { readonly role: string; readonly content: string }[],
  existingContext: ExistingMemoryContext = {},
): string {
  const messagesText = recentMessages.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");

  const personalRaw = existingContext.personalMemory?.trim() ?? "";
  const personalText = personalRaw
    ? truncateForPrompt(personalRaw, 6000, "个人记忆")
    : "(暂无个人记忆)";

  const workMemories = existingContext.workMemories ?? [];
  const workSlice = workMemories.length > 25 ? workMemories.slice(-25) : workMemories;
  const workText =
    workSlice.length > 0
      ? workSlice.map((m) => `- [${m.category}] ${m.content}`).join("\n") +
        (workMemories.length > workSlice.length
          ? `\n- …(另有 ${workMemories.length - workSlice.length} 条较早工作记忆未列出)`
          : "")
      : "(暂无工作记忆)";

  return [
    "你是记忆提取子代理。分析以下最近的对话内容，提取值得长期记住的信息。",
    "",
    buildMemoryArchitectureSection(),
    "",
    "## 个人记忆 vs 工作记忆（写入路由）",
    "",
    "| 类别 | 归属层 | 存储 | 典型内容 |",
    "|------|--------|------|----------|",
    "| user | 个人记忆 | user_memory Markdown | 身份、兴趣、健康、地区 |",
    "| feedback | 个人记忆 | user_memory Markdown | 交互风格纠正与确认 |",
    "| project | 工作记忆 | SQLite agent_memories | 进行中项目、计划、约束 |",
    "| reference | 工作记忆 | SQLite agent_memories | 工具、网站、联系人 |",
    "| general | 工作记忆 | SQLite agent_memories | 其他跨会话知识 |",
    "",
    "**关键区分**：",
    "- 个人记忆 = 「你是谁、你喜欢怎样被对待」→ 全局适用、变化慢",
    "- 工作记忆 = 「你在做什么、用什么资源」→ 与具体项目/Agent 绑定、变化快",
    "- 任务级规则（如「K8s 系列每篇 5-6 张图」）→ project 或 feedback（须标注适用范围）",
    "- 全局偏好（如「回复要简洁」「用 image_generate 生图」）→ feedback",
    "",
    "## 记忆类型与保存时机",
    "",
    "### user（用户画像）→ 个人记忆",
    "保存时机：用户分享个人身份、角色、家庭成员、兴趣爱好、生活习惯、健康状况、地区等信息时",
    '示例：{"content": "用户叫李明，是一名高中数学老师，坐标成都", "category": "user", "importance": 0.8, "tags": ["identity", "role", "location"]}',
    "",
    "### feedback（交互偏好）→ 个人记忆",
    '保存时机：用户明确纠正你的做法（"不要..."、"以后别..."）；或用户明确认可你的做法（"这样很好"、"就是这个格式"）',
    "内容结构：规则 + 原因 + 应用（任务级规则须加适用范围）",
    '示例：{"content": "规则：生成图片必须调用 image_generate，禁止编造链接。原因：用户多次纠正。应用：任何生图任务都走工具。适用范围：全局", "category": "feedback", "importance": 0.9, "tags": ["correction", "tool"]}',
    "",
    "### project（进行中的事）→ 工作记忆",
    "保存时机：用户提到持续性活动、有截止日期的事项、长期计划",
    "内容结构：[项目/计划名] + [当前状态] + [关键约束/截止时间]",
    '示例：{"content": "K8s 小红书系列：从序篇开始，深度长文 1200-1500 字，配图两种风格试水。状态：进行中。约束：每篇封面+5-6 张图", "category": "project", "importance": 0.8, "tags": ["k8s", "content"]}',
    "",
    "### reference（外部资源）→ 工作记忆",
    "保存时机：用户分享常用工具、网站、联系人、文件位置等外部资源",
    '示例：{"content": "用户的 K8s 系列文章存放在 outputs/k8s-xhs-series/ 目录", "category": "reference", "importance": 0.6, "tags": ["path"]}',
    "",
    "## 去重与冲突消解（提取时必须遵守）",
    "",
    "1. **检查已有记忆**：下方列出了个人记忆和工作记忆全文，语义相同的内容不要重复提取",
    "2. **冲突时以最新为准**：若对话中用户明确推翻旧规则（如从 generate_image.py 改为 image_generate），只提取新规则，不要同时提取矛盾条目",
    "3. **标注适用范围**：任务级约束必须写明适用项目/系列，避免写成无范围全局规则",
    "4. **合并而非追加**：若新信息与已有记忆是同一主题的更新，提取合并后的完整表述，而非碎片追加",
    "5. **工具方法变更**：用户明确切换工具/方法时，提取新方法的 feedback，不要保留旧方法",
    "",
    "## 不要保存的内容",
    "- 一次性问答的具体细节（如计算结果、翻译结果、临时查询）",
    "- 闲聊中的临时话题（天气、新闻八卦等无持续价值的内容）",
    "- 密码、银行卡号、身份证号、API Key 等敏感信息",
    "- 已在已有记忆中存在的内容（语义重复）",
    "- 可从当前对话上下文直接获取、无跨会话价值的信息",
    "- 对话中 assistant 的幻觉输出（如编造的图片路径），除非用户明确纠正并要求记住",
    "",
    "## 已有个人记忆（user_memory，避免重复与冲突）",
    personalText,
    "",
    "## 已有工作记忆（agent_memories，避免重复与冲突）",
    workText,
    "",
    "## 最近对话",
    messagesText,
    "",
    "## 任务边界（重要）",
    "- 本任务是**从最近对话提取新记忆**，不是整理/重写已有记忆全文",
    "- 已有记忆的去重、合并、冲突消解由**独立的整理流程**处理，不要在本任务输出整理后的 Markdown",
    "- 闲聊/寒暄（如「你好」「在吗」）若无新的跨会话信息，**必须返回 []**",
    "- 不要因为已有记忆重复或冲突，就尝试输出「整理建议」或非 JSON 内容",
    "",
    "## 输出格式",
    "返回 JSON 数组，每条记忆包含 content, category, importance (0-1), tags (字符串数组)。",
    'feedback 类型请使用结构化格式："规则：... 原因：... 应用：... 适用范围：..."',
    "如果没有值得保存的内容，返回空数组 []。",
    "",
    "仅输出 JSON，不要包含其他文字。",
  ].join("\n");
}

function validateCategory(raw: string): MemoryCategory {
  const valid: MemoryCategory[] = ["user", "feedback", "project", "reference", "general"];
  return valid.includes(raw as MemoryCategory) ? (raw as MemoryCategory) : "general";
}

/**
 * 解析 LLM 返回的记忆候选 JSON 数组。
 * 容忍前后说明文字与 markdown code fence；非法/无数组时返回空。
 * 由 extractByLLM 与段落总结管线（SegmentMemoryPipeline）共用。
 */
export function parseCandidatesJson(response: string): ExtractedCandidate[] {
  try {
    const arrayStart = response.indexOf("[");
    const arrayEnd = response.lastIndexOf("]");
    if (arrayStart === -1 || arrayEnd === -1 || arrayEnd <= arrayStart) return [];
    const parsed: unknown = JSON.parse(response.slice(arrayStart, arrayEnd + 1));
    if (!Array.isArray(parsed)) return [];

    const candidates: ExtractedCandidate[] = [];
    for (const item of parsed) {
      if (
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).content === "string" &&
        typeof (item as Record<string, unknown>).category === "string"
      ) {
        const record = item as Record<string, unknown>;
        candidates.push({
          content: record.content as string,
          category: validateCategory(record.category as string),
          importance:
            typeof record.importance === "number"
              ? Math.max(0, Math.min(1, record.importance))
              : 0.5,
          tags: Array.isArray(record.tags)
            ? (record.tags as unknown[]).filter((t): t is string => typeof t === "string")
            : [],
        });
      }
    }
    return candidates;
  } catch {
    return [];
  }
}

/**
 * LLM 辅助记忆提取。每 N 轮对话后调用一次。
 */
export async function extractByLLM(params: {
  readonly recentMessages: readonly { readonly role: string; readonly content: string }[];
  /** @deprecated 使用 existingContext 代替 */
  readonly existingMemories?: readonly { readonly content: string; readonly category: string }[];
  readonly existingContext?: ExistingMemoryContext;
  readonly callLLM: (prompt: string) => Promise<string>;
}): Promise<readonly ExtractedCandidate[]> {
  const { recentMessages, callLLM } = params;

  if (recentMessages.length === 0) return [];

  // 兼容旧调用方：existingMemories → workMemories
  const existingContext: ExistingMemoryContext = params.existingContext ?? {
    workMemories: params.existingMemories,
  };

  const prompt = buildExtractionPrompt(recentMessages, existingContext);

  try {
    const response = await callLLM(prompt);
    return parseCandidatesJson(response);
  } catch {
    return [];
  }
}

/**
 * 构建段落总结提示词（SegmentMemoryPipeline 用）。
 * 输入为整段对话原文，强调合并同段重复信息、输出最精炼结构化候选。
 * 复用 buildExtractionPrompt 的四类定义与不保存清单，仅替换"最近对话"为整段。
 */
export function buildSegmentSummaryPrompt(
  segmentText: string,
  existingContext: ExistingMemoryContext = {},
): string {
  return buildExtractionPrompt([{ role: "user", content: segmentText }], existingContext);
}

/**
 * 截断过长记忆文本，避免提取 prompt 膨胀
 */
function truncateForPrompt(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars) +
    `\n…(已有${label}过长，已截断；提取时仍需避免与上文语义重复，冲突时以最近对话为准)`
  );
}
