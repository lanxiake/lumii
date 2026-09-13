import { describe, it, expect } from "vitest";
import { askUserQuestionToolConfig, AskUserQuestionParams } from "./ask-user-question-tool.js";

/** TypeBox schema 的宽松访问形状（测试专用） */
interface LooseSchema {
  properties?: Record<string, LooseSchema>;
  items?: LooseSchema;
  type?: string;
}

function optionSchema(): LooseSchema {
  const root = AskUserQuestionParams as unknown as LooseSchema;
  const questions = root.properties?.questions?.items;
  return questions?.properties?.options?.items ?? {};
}

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

  it("无宿主 controller 时返回结构化 not_implemented（回归）", async () => {
    const result = await askUserQuestionToolConfig.execute(
      "test-call-id",
      {
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
