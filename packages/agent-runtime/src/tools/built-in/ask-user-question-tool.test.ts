import { describe, it, expect } from "vitest";
import { askUserQuestionToolConfig, AskUserQuestionParams } from "./ask-user-question-tool.js";

/** TypeBox schema 的宽松访问形状（测试专用） */
interface LooseSchema {
  properties?: Record<string, LooseSchema>;
  items?: LooseSchema;
  type?: string;
  required?: string[];
}

function optionSchema(): LooseSchema {
  const root = AskUserQuestionParams as unknown as LooseSchema;
  const questions = root.properties?.questions?.items;
  return questions?.properties?.options?.items ?? {};
}

const BASE_QUESTION = {
  question: "先了解哪类功能？",
  header: "方向",
  options: [
    { label: "资料库", description: "知识资产", recommended: true, recommendReason: "你刚导入过文档" },
    { label: "定时任务", description: "自动化" },
  ],
};

describe("ask-user-question-tool（AI 推荐字段）", () => {
  it("选项 schema 支持 recommended / recommendReason", () => {
    const props = optionSchema().properties ?? {};
    expect(props.recommended?.type).toBe("boolean");
    expect(props.recommendReason?.type).toBe("string");
  });

  it("工具描述要求给出推荐与理由", () => {
    const description = askUserQuestionToolConfig.description ?? "";
    expect(description).toContain("recommended: true");
    expect(description).toContain("recommendReason");
  });

  it("顶层 context 是必填字段，且描述说明它的用途", () => {
    const root = AskUserQuestionParams as unknown as LooseSchema;
    expect(root.properties?.context?.type).toBe("string");
    expect(root.required).toContain("context");
    const desc = root.properties?.context as { description?: string };
    expect(desc.description ?? "").toMatch(/why you are asking/i);
  });

  it("工具描述要求必填 context，并说明关闭弹窗=拒绝=按默认方案继续", () => {
    const description = askUserQuestionToolConfig.description ?? "";
    expect(description).toMatch(/ALWAYS fill the top-level context/i);
    expect(description).toMatch(/dismiss the dialog/i);
  });

  it("context 透传给宿主（弹窗/渠道卡片展示用）", async () => {
    let seen: { context?: string; questions?: unknown } | null = null;
    const result = await askUserQuestionToolConfig.execute(
      "tc-ctx",
      {
        context: "已扫过本地技能库，没有代码审查类；要不要去远程市场找？",
        questions: [BASE_QUESTION],
      },
      {
        askUserQuestion: async (input: { context?: string; questions?: unknown }) => {
          seen = input;
          return { answers: { "先了解哪类功能？": "资料库" } };
        },
      } as never,
    );
    expect(seen?.context).toContain("远程市场");
    expect(JSON.stringify(result.content)).toContain("answered");
  });

  it("拒绝回答的反馈提示按推荐/默认方案继续", async () => {
    const result = await askUserQuestionToolConfig.execute(
      "tc-declined",
      { context: "背景", questions: [BASE_QUESTION] },
      { askUserQuestion: async () => ({ answers: {}, declined: true }) } as never,
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/declined/i);
    expect(text).toMatch(/recommended|default plan/i);
  });

  it("无宿主 controller 时返回结构化 not_implemented（回归）", async () => {
    const result = await askUserQuestionToolConfig.execute(
      "test-call-id",
      {
        context: "想确认方向再动手。",
        questions: [
          {
            question: "先了解哪类功能？",
            header: "方向",
            options: [
              {
                label: "资料库",
                description: "知识资产",
                recommended: true,
                recommendReason: "你刚导入过文档",
              },
              { label: "定时任务", description: "自动化" },
            ],
          },
        ],
      },
      {} as any,
    );
    expect(JSON.stringify(result.content)).toContain("not_implemented");
  });
});
