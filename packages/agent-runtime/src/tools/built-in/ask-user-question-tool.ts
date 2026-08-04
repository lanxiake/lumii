/**
 * ask_user_question — Agent 向用户发起结构化提问的工具
 *
 * 对齐 claude-code-rev:
 * - src/tools/AskUserQuestionTool/prompt.ts
 * - src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx
 *
 * 设计要点（对照设计文档 §八 ask_user_question）：
 * 1. 入参：1-4 个问题；每个问题 2-4 个选项；支持 multiSelect 与 option.preview
 * 2. 出参：answers（按 question 文本 keyed）+ 可选 annotations（notes/preview）
 * 3. tool_result 文本格式：
 *    `User has answered your questions: "<q>"="<a>" [...]`
 * 4. 本层仅提供 **stub execute**，实际的 Modal/IPC 往返由 Windows bridge 层
 *    通过 config 注入的 `AskUserQuestionController.resolve` 完成。
 * 5. 子 Agent（Explore/Plan/Verify）通过 disallowedTools 默认禁用此工具
 *    （参见 packages/agent-runtime/src/agent/builtin/definitions.ts）。
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { MtBotToolConfig } from "../tool-adapter.js";
import { ASK_USER_QUESTION_TOOL_NAME } from "./tool-names.js";
import type { ToolExecutionContext } from "../../types/tool.js";

const QuestionOption = Type.Object({
  label: Type.String({
    description:
      "The display text for this option (1-5 words). Concise and clearly describes the choice.",
  }),
  description: Type.String({
    description: "Explanation of what this option means or what will happen if chosen.",
  }),
  preview: Type.Optional(
    Type.String({
      description:
        "Optional preview content rendered when this option is focused. Use for mockups, " +
        "code snippets, or visual comparisons. Only supported for single-select questions.",
    }),
  ),
});

const Question = Type.Object({
  question: Type.String({
    description:
      "The complete question to ask the user. Must end with a question mark. " +
      'Example: "Which library should we use for date formatting?". ' +
      'If multiSelect is true, phrase it accordingly (e.g., "Which features do you want to enable?").',
  }),
  header: Type.String({
    description:
      'Very short label displayed as a chip/tag (≤12 chars). Examples: "Auth method", "Library", "Approach".',
    maxLength: 12,
  }),
  options: Type.Array(QuestionOption, {
    minItems: 2,
    maxItems: 4,
    description:
      "The available choices (2-4 options). Each option should be distinct and " +
      "mutually exclusive (unless multiSelect). Do NOT include an 'Other' option — " +
      "the host will provide it automatically.",
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      description: "Set to true to allow the user to select multiple options instead of just one.",
      default: false,
    }),
  ),
});

export const AskUserQuestionParams = Type.Object({
  questions: Type.Array(Question, {
    minItems: 1,
    maxItems: 4,
    description: "Questions to ask the user (1-4 questions).",
  }),
});

export type AskUserQuestionInput = Static<typeof AskUserQuestionParams>;
export type AskUserQuestionQuestion = Static<typeof Question>;
export type AskUserQuestionOption = Static<typeof QuestionOption>;

/**
 * 用户回答返回格式
 *
 * - `answers`: key = 问题文本，value = 答案字符串（multiSelect 时以逗号拼接）
 * - `annotations`: 可选的用户备注/preview 选择
 * - `declined`: 用户选择"拒绝回答"时为 true
 */
export interface AskUserQuestionAnswer {
  readonly answers: Record<string, string>;
  readonly annotations?: Record<string, { preview?: string; notes?: string }>;
  readonly declined?: boolean;
}

const ASK_DESCRIPTION =
  "Ask the user 1-4 structured multiple-choice questions to gather preferences, clarify " +
  "ambiguity, or offer implementation choices. Each question has 2-4 options. Users can " +
  "always select an automatically-provided 'Other' option to write free-form text. " +
  "IMPORTANT: do NOT use this tool for plan approval — for plan approval use plan mode completion.";

/**
 * 统一的 stub 实现：在未注入 controller 时返回 not_implemented 错误，
 * 保证 LLM 能得到结构化反馈，而不是无响应挂起。
 */
export const askUserQuestionToolConfig: MtBotToolConfig<typeof AskUserQuestionParams> = {
  name: ASK_USER_QUESTION_TOOL_NAME,
  label: "Ask User",
  description: ASK_DESCRIPTION,
  parameters: AskUserQuestionParams,
  category: "agent",
  // 严格说 "询问" 不写任何文件；但它需要用户 UI 交互，业务上视为需要 consent
  isReadOnly: true,
  needsPermission: false,

  async execute(
    toolCallId: string,
    params: AskUserQuestionInput,
    context: ToolExecutionContext,
  ): Promise<AgentToolResult<unknown>> {
    // 1) 平台层未注入能力：返回结构化 not_implemented，避免挂起
    if (!context.askUserQuestion) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "not_implemented",
              message:
                "ask_user_question requires host-side controller (AskUserQuestionController). " +
                "Platform integration layer should override this stub with IPC-backed implementation.",
              requestedQuestions: params.questions.map((q) => q.question),
            }),
          },
        ],
        details: undefined,
      };
    }

    // 2) 委派给平台层 RPC，再格式化为 tool_result 文本
    try {
      const answer = await context.askUserQuestion({
        requestId: toolCallId,
        instanceId: context.instanceId,
        questions: params.questions,
      });

      if (answer.cancelled) {
        return {
          content: [
            {
              type: "text",
              text:
                "User did not respond to the questions (cancelled or timed out). " +
                "Proceed with your best judgement or rephrase the question.",
            },
          ],
          details: { requestId: toolCallId, outcome: "cancelled" },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: formatAskUserQuestionResult({
              answers: answer.answers,
              annotations: answer.annotations,
              declined: answer.declined,
            }),
          },
        ],
        details: {
          requestId: toolCallId,
          outcome: answer.declined ? "declined" : "answered",
          answers: answer.answers,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text",
            text: `ask_user_question failed: ${message}`,
          },
        ],
        details: { requestId: toolCallId, outcome: "error", error: message },
      };
    }
  },
};

/**
 * 将用户答案格式化为 tool_result 文本（与 CCR `mapToolResultToToolResultBlockParam` 对齐）
 *
 * 由宿主 controller 在用户回答后调用，生成 LLM 可继续推理的反馈。
 */
export function formatAskUserQuestionResult(answer: AskUserQuestionAnswer): string {
  if (answer.declined) {
    return "User declined to answer the questions. Proceed with your best judgement or ask differently.";
  }

  const parts: string[] = [];
  for (const [questionText, answerValue] of Object.entries(answer.answers)) {
    const annotation = answer.annotations?.[questionText];
    const chunks: string[] = [`"${questionText}"="${answerValue}"`];
    if (annotation?.preview) {
      chunks.push(`selected preview:\n${annotation.preview}`);
    }
    if (annotation?.notes) {
      chunks.push(`user notes: ${annotation.notes}`);
    }
    parts.push(chunks.join(" "));
  }

  return `User has answered your questions: ${parts.join(", ")}. You can now continue with the user's answers in mind.`;
}
