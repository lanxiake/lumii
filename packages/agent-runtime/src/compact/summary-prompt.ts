/**
 * summary-prompt —— 摘要提示词构建与格式化
 *
 * 平移自原 context-compactor.ts，参考 Claude Code src/services/compact/prompt.ts。
 * 本阶段（A2）保持原有位置参数签名，options 对象化改造在阶段 B3 进行。
 *
 * 提示词工程要点：
 * - 结构化输出：固定 9 节 + XML 标签
 * - CoT 分离：<analysis> 草稿（注入前剥离）+ <summary> 交付
 * - 防工具滥用：前后双重 NO_TOOLS 约束
 * - 防意图漂移：All user messages + Next Step verbatim 引用
 */

import type { PartialDirection, SummaryPromptOptions } from "./types.js";

/**
 * 严格禁止工具调用的前置声明（参考 Claude Code NO_TOOLS_PREAMBLE）
 *
 * 在 maxTurns=1 的摘要轮，若模型发起工具调用会导致该轮无文本输出。
 */
export const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use any tool in your tool list.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;

export const NO_TOOLS_TRAILER =
  "\n\nREMINDER: Do NOT call any tools. Respond with plain text only — " +
  "an <analysis> block followed by a <summary> block. " +
  "Tool calls will be rejected and you will fail the task.";

/**
 * 摘要分析指令（参考 Claude Code DETAILED_ANALYSIS_INSTRUCTION_BASE）
 *
 * <analysis> 块作为 LLM 的草稿空间，最终从注入 context 的摘要中剥离，
 * 只保留 <summary> 部分，从而提升摘要质量而不增加 context 负担。
 */
const DETAILED_ANALYSIS_INSTRUCTION = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key facts, decisions, and the user's stated preferences (style, format, constraints)
   - Specific details like file paths, links, names, dates, and exact values
   - Problems you ran into and how you resolved them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for accuracy and completeness, addressing each required element thoroughly.`;

/**
 * 构建完整摘要提示词（参考 Claude Code BASE_COMPACT_PROMPT）
 *
 * 通用 9-section 结构化摘要，领域无关，覆盖用户诉求、关键事实与偏好、
 * 资料与产出、问题与解决、已完成工作、所有用户消息、待办、当前进展、可选下一步。
 *
 * @param opts.activeTasks 活跃任务列表，注入后必须逐字保留到第 7 段
 * @param opts.domainHint  领域提示；传 "coding" 时追加"完整代码片段/函数签名/文件 diff"要求，
 *                         默认 "general" 不追加代码细节，避免日常任务摘要被代码化。
 * @param opts.customInstructions 自定义指令（B3），追加到模板末尾。
 */
export function buildCompactSummaryPrompt(opts: SummaryPromptOptions = {}): string {
  const { activeTasks, domainHint = "general", customInstructions } = opts;
  let prompt = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing key facts, decisions, the user's preferences, and the state of any work in progress, so the conversation can continue seamlessly without losing context.

${DETAILED_ANALYSIS_INSTRUCTION}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail.
2. Key Facts, Decisions and Preferences: List important facts established, decisions made, and any style/format/constraint preferences the user stated (e.g. "use a table", "reply in Chinese", "keep it short").
3. Materials and Outputs: Enumerate the materials and outputs involved — files, links, generated content, data tables. Preserve file paths and URLs VERBATIM. Note why each one matters.
4. Problems and Resolutions: List problems encountered and how they were resolved. Pay special attention to specific user feedback, especially when the user told you to do something differently.
5. Completed Work: Document what has ACTUALLY been finished and the conclusions reached. Mark something as completed ONLY if it was genuinely executed and confirmed (the tool call succeeded / the output was verified) — NOT merely planned, attempted, or claimed in text. Explicitly distinguish "done and verified" from "in progress" or "attempted but unverified", so the continuation does not falsely assume completion.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the user's feedback and changing intent. Preserve any safety/privacy constraints VERBATIM.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the user's request. Do not start on tangential requests without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Facts, Decisions and Preferences:
   - [Fact / decision / preference 1]
   - [...]

3. Materials and Outputs:
   - [File / link / output 1]
      - [Why it matters]
      - [Path or URL, verbatim]
   - [...]

4. Problems and Resolutions:
    - [Problem 1]:
      - [How it was resolved]
      - [User feedback if any]
    - [...]

5. Completed Work:
   [What has been finished and the conclusions reached]

6. All user messages:
    - [Detailed non tool-use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.`;

  // 代码场景增强（仅 coding 时追加；general 不污染日常任务摘要）
  if (domainHint === "coding") {
    prompt += `\n\nADDITIONAL (coding context): When code is involved, in section 3 include full code snippets, function signatures, and file diffs where applicable, and in section 2 capture architectural and technical decisions in detail.`;
  }

  // 注入活跃任务索引（若有）
  if (activeTasks && activeTasks.length > 0) {
    const taskLines = activeTasks
      .map((t) => {
        const owner = t.owner ? ` (assigned: ${t.owner})` : "";
        return `  - [${t.status}] ${t.subject}${owner} (id: ${t.id})`;
      })
      .join("\n");
    prompt += `\n\nIMPORTANT — Active Task Index (must be preserved in section 7 "Pending Tasks"):
The following tasks are currently tracked in the session task list. You MUST include ALL of them verbatim in section 7 of your summary, preserving their status and IDs so they can be restored after compaction:
${taskLines}`;
  }

  // 自定义指令追加到模板末尾（B3，对齐 claude-code Additional Instructions）
  if (customInstructions && customInstructions.trim() !== "") {
    prompt += `\n\nAdditional Instructions:\n${customInstructions.trim()}`;
  }

  return prompt;
}

/**
 * 格式化 LLM 摘要：剥离 <analysis> 草稿，提取 <summary> 内容
 *
 * 参考 Claude Code formatCompactSummary：
 * - <analysis> 块是 LLM 思考草稿，提升摘要质量但无需注入 context
 * - <summary> 块提取后作为实际 context 注入内容
 */
export function formatCompactSummary(rawSummary: string): string {
  let formatted = rawSummary;

  // 剥离 <analysis> 草稿块
  formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/, "");

  // 提取 <summary> 内容并去掉 XML 标签
  const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    const content = summaryMatch[1] ?? "";
    formatted = formatted.replace(/<summary>[\s\S]*?<\/summary>/, `Summary:\n${content.trim()}`);
  }

  // 清理多余空白
  formatted = formatted.replace(/\n\n+/g, "\n\n");
  return formatted.trim();
}

// ==================== 部分压缩模板（B3，预留，暂不接管线） ====================

/**
 * 部分压缩第 9 节标题与说明（from vs up_to）。
 *
 * 摘要在消息序列中的位置决定第 9 节语义（02 篇 §1.2）：
 * - from：摘要=最近发生的事 → 第 9 节 "Optional Next Step"
 * - up_to：摘要=开场背景，后接真实新消息 → 第 9 节 "Context for Continuing Work"
 *   （不该越俎代庖猜测下一步，下一步在后面的真实消息里）
 */
const PARTIAL_SECTION_9: Record<PartialDirection, string> = {
  from: `9. Optional Next Step: List the next step directly in line with the most recent work. Include verbatim quotes from the most recent conversation to avoid drift.`,
  up_to: `9. Context for Continuing Work: Summarize any context, decisions, or state needed to understand and continue the work in the messages that will follow this summary. Do NOT guess a "next step" — newer messages you cannot see here will follow.`,
};

/**
 * 构建部分压缩摘要提示词（B3，预留）。
 *
 * 与全量模板共享 NO_TOOLS 约束与 CoT 分离结构，但作用域限定为"最近一段消息"，
 * 并按 direction 切换第 9 节语义。本期不接管线（无部分压缩入口），作为标准化储备。
 *
 * @param opts.direction "from"（保前缀）/ "up_to"（摘要在前）
 */
export function buildPartialSummaryPrompt(
  opts: SummaryPromptOptions & { direction: PartialDirection },
): string {
  const { direction, customInstructions } = opts;
  const scope =
    direction === "up_to"
      ? "This summary will be placed at the START of a continuing session; newer messages that build on it will follow after your summary (you do not see them here)."
      : "Summarize the RECENT portion of the conversation — earlier messages are kept intact and do NOT need summarizing.";

  let prompt = `Your task is to create a detailed summary of part of the conversation. ${scope}

${DETAILED_ANALYSIS_INSTRUCTION}

Your summary should include the following sections:

1. Primary Request and Intent
2. Key Facts, Decisions and Preferences
3. Materials and Outputs (preserve file paths and URLs VERBATIM)
4. Problems and Resolutions
5. Completed Work (distinguish done-and-verified from attempted-but-unverified)
6. All user messages (preserve safety/privacy constraints VERBATIM)
7. Pending Tasks
8. Current Work
${PARTIAL_SECTION_9[direction]}

Wrap your reasoning in <analysis> tags and the deliverable in <summary> tags.`;

  if (customInstructions && customInstructions.trim() !== "") {
    prompt += `\n\nAdditional Instructions:\n${customInstructions.trim()}`;
  }

  return NO_TOOLS_PREAMBLE + prompt + NO_TOOLS_TRAILER;
}
