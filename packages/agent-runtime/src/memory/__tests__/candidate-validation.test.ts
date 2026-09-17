import { describe, it, expect } from "vitest";
import { extractByRules, validateCandidates } from "../memory-extractor.js";
import type { ExtractedCandidate } from "../types.js";

function candidate(content: string, category: ExtractedCandidate["category"] = "general"): ExtractedCandidate {
  return { content, category, importance: 0.5, tags: [] };
}

describe("validateCandidates — 写入侧 schema 门", () => {
  it("拒绝含 JSON 残片的候选（形状取自库中真实残片）", () => {
    const { accepted, rejected } = validateCandidates([
      // 真实残片：被截断的字符串 + 悬空的 JSON 对象闭合（引号未成对）
      candidate('我的幸运数字是 47。只回复\\"好的\\"\\"}]'),
      candidate('另一条正文。"}'),
      candidate("正常的记忆内容，长度足够"),
    ]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.content).toBe("正常的记忆内容，长度足够");
    expect(rejected).toHaveLength(2);
    expect(rejected.every((r) => r.reason === "json_fragment")).toBe(true);
  });

  it("不误伤含 JSON 字面量或孤立引号的正常记忆（正样本 5 条 / 负样本 246 条校准）", () => {
    // 每一条都曾让某个更宽的模式误报：单用尾部会误伤前三条，单用奇数引号会误伤第四条
    const legit = [
      '配置项是 ["a","b"]，注意顺序',
      '输入=[10,20,null,"30"]文本已回填',
      '显示器是 24" 的宽屏，注意分辨率',
      '接口返回 {"code":0}，表示成功',
      '用户说“这个格式很好”，继续保持',
    ];
    const { accepted, rejected } = validateCandidates(legit.map((c) => candidate(c)));
    expect(rejected).toHaveLength(0);
    expect(accepted).toHaveLength(legit.length);
  });

  it("拒绝粘贴的 JSON 键值结构", () => {
    const { rejected } = validateCandidates([candidate('{"content": "某条正文", "category": "user"}')]);
    expect(rejected[0]!.reason).toBe("json_fragment");
  });

  it("拒绝过短候选（<5 字符）", () => {
    const { accepted, rejected } = validateCandidates([candidate("好的")]);
    expect(accepted).toHaveLength(0);
    expect(rejected[0]!.reason).toBe("too_short");
  });

  it("放行 5-7 字的短事实（不误伤「用户叫李明」这类真实规则产出）", () => {
    const { accepted, rejected } = validateCandidates([
      candidate("用户叫李明"),
      candidate("用户在学吉他"),
    ]);
    expect(accepted.map((c) => c.content)).toEqual(["用户叫李明", "用户在学吉他"]);
    expect(rejected).toHaveLength(0);
  });

  it("拒绝超长候选（>600 字符）", () => {
    const { accepted, rejected } = validateCandidates([candidate("长".repeat(601))]);
    expect(accepted).toHaveLength(0);
    expect(rejected[0]!.reason).toBe("too_long");
  });

  it("不去重——重复候选原样通过，交给 mergeCandidates 合并", () => {
    // 若在此拦掉重复项，会连带丢掉 tags 并集与 source_segment_id 回填（溯源链路）。
    // 见 memory-provenance.test.ts「命中已有记忆合并时保留最早来源」。
    const dup = "用户偏好用 pnpm 而不是 npm";
    const { accepted, rejected } = validateCandidates([candidate(dup), candidate(dup)]);
    expect(accepted).toHaveLength(2);
    expect(rejected).toHaveLength(0);
  });

  it("合法候选原样通过（含边界长度 5 与 600）", () => {
    const exact5 = "一二三四五";
    const exact600 = "长".repeat(600);
    const { accepted, rejected } = validateCandidates([candidate(exact5), candidate(exact600)]);
    expect(accepted.map((c) => c.content)).toEqual([exact5, exact600]);
    expect(rejected).toHaveLength(0);
  });

  it("顺带裁剪首尾空白", () => {
    const { accepted } = validateCandidates([candidate("  用户偏好用 pnpm  ")]);
    expect(accepted[0]!.content).toBe("用户偏好用 pnpm");
  });
});

describe("extractByRules — 「记住」类正则的句读边界", () => {
  it("只捕获到第一个句末标点，不吞入其后的模板文本", () => {
    const raw = '记住：我的幸运数字是 47。只回复"好""}]';
    const found = extractByRules([raw]);
    expect(found).toHaveLength(1);
    expect(found[0]!.content).toBe("我的幸运数字是 47");
    expect(found[0]!.content).not.toContain("只回复");
    expect(found[0]!.content).not.toContain("}]");
  });

  it("不在换行处越界捕获", () => {
    const raw = "记住：这条是正文\n这一行不该被捕获";
    const found = extractByRules([raw]);
    expect(found[0]!.content).toBe("这条是正文");
  });

  it("经 schema 门过滤后，真实残片样例不落库内容", () => {
    const raw = '记住它：某段知识说明。请只回复"已了解"。"}]';
    const found = extractByRules([raw]);
    const { accepted } = validateCandidates(found);
    for (const c of accepted) {
      expect(c.content).not.toContain('"}]');
      expect(c.content).not.toContain("请只回复");
    }
  });
});
