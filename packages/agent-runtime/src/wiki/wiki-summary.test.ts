/**
 * wiki-summary.ts：heuristic / extractive 两层零成本摘要
 */
import { describe, expect, it } from "vitest";
import { buildExtractiveSummary, buildHeuristicSummary, SUMMARY_MAX_CHARS } from "./wiki-summary.js";

describe("buildHeuristicSummary", () => {
  it("短正文直接作摘要", () => {
    const r = buildHeuristicSummary("周报", "本周完成了登录改造。");
    expect(r).toEqual({ summary: "本周完成了登录改造。", level: "heuristic" });
  });

  it("Markdown 标题 + 首段", () => {
    const longFiller = "正".repeat(150);
    const text = `# 项目周报\n\n${longFiller}`;
    const r = buildHeuristicSummary("t", text);
    expect(r?.level).toBe("heuristic");
    expect(r?.summary.startsWith("项目周报：")).toBe(true);
  });

  it("去掉页码行与分隔线", () => {
    const longFiller = "内容行。".repeat(40);
    const text = `---\n\n1\n\n${longFiller}\n\n2\n\n---`;
    const r = buildHeuristicSummary("t", text);
    expect(r).not.toBeNull();
    expect(r?.summary).not.toContain("---");
  });

  it("去样板后为空返回 null", () => {
    expect(buildHeuristicSummary("x", "---\n\n1\n\n2\n")).toBeNull();
  });

  it("截断到 120 字", () => {
    const longFiller = "字".repeat(300);
    const r = buildHeuristicSummary("t", longFiller);
    expect(r?.summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  });

  it("空白正文返回 null", () => {
    expect(buildHeuristicSummary("t", "   \n\n  ")).toBeNull();
  });
});

describe("buildExtractiveSummary", () => {
  it("选出含标题关键词的句子", () => {
    const text = [
      "登录改造本周正式上线。",
      "今天天气不错适合散步。",
      "团队完成了登录改造相关的性能优化。",
      "午饭吃了食堂的红烧肉。",
      "登录改造上线后错误率明显下降。",
    ].join("");
    const r = buildExtractiveSummary("登录改造总结", text);
    expect(r?.level).toBe("extractive");
    expect(r?.summary).toContain("登录改造");
  });

  it("过滤 < 8 字碎句", () => {
    const text = "短句。这是一句足够长的正常句子用来测试过滤逻辑。也是一句足够长的正常句子占位用。再来一句足够长的占位句子占位用。";
    const r = buildExtractiveSummary("t", text);
    expect(r?.summary).not.toContain("短句");
  });

  it("句子数不足 3 时降级 heuristic", () => {
    const r = buildExtractiveSummary("t", "短句一。短句二。");
    expect(r?.level).toBe("heuristic");
  });

  it("输出保持原文顺序", () => {
    const text = "第一句内容足够长用于占位测试排序。第二句内容足够长用于占位测试排序。第三句内容足够长用于占位测试排序。";
    const r = buildExtractiveSummary("t", text);
    expect(r).not.toBeNull();
    const idx1 = r!.summary.indexOf("第一句");
    const idx2 = r!.summary.indexOf("第二句");
    const idx3 = r!.summary.indexOf("第三句");
    const present = [idx1, idx2, idx3].filter((i) => i >= 0);
    expect(present).toEqual([...present].sort((a, b) => a - b));
  });

  it("空正文返回 null", () => {
    expect(buildExtractiveSummary("t", "")).toBeNull();
  });
});
