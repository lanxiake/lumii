import { describe, expect, it } from "vitest";
import { resolveWikilinkTarget, type WikilinkCandidatePage } from "./wiki-link-resolver.js";

const pages: WikilinkCandidatePage[] = [
  { id: "p1", path: "concepts/微信语音", title: "微信语音" },
  { id: "p2", path: "sources/微信语音笔记", title: "微信语音" },
  { id: "p3", path: "sources/唯一标题", title: "唯一标题" },
  { id: "p4", path: "sources/同名A", title: "同名" },
  { id: "p5", path: "media/同名B", title: "同名" },
];

describe("resolveWikilinkTarget", () => {
  it("规则1：带路径按规范化路径精确匹配", () => {
    const result = resolveWikilinkTarget("concepts/微信语音", "sources/x", pages);
    expect(result).toEqual({ targetPageId: "p1", isResolved: true, ambiguous: [] });
  });

  it("规则1：带路径但目标不存在则未解析", () => {
    const result = resolveWikilinkTarget("concepts/不存在", "sources/x", pages);
    expect(result.isResolved).toBe(false);
    expect(result.targetPageId).toBeNull();
  });

  it("规则2：不带路径先匹配当前目录下同标题", () => {
    const result = resolveWikilinkTarget("微信语音", "concepts/其他页", pages);
    expect(result).toEqual({ targetPageId: "p1", isResolved: true, ambiguous: [] });
  });

  it("规则2：不带路径全库唯一标题匹配", () => {
    const result = resolveWikilinkTarget("唯一标题", "media/其他页", pages);
    expect(result).toEqual({ targetPageId: "p3", isResolved: true, ambiguous: [] });
  });

  it("规则3：多重匹配不写边，返回歧义候选", () => {
    const result = resolveWikilinkTarget("同名", "concepts/其他页", pages);
    expect(result.isResolved).toBe(false);
    expect(result.targetPageId).toBeNull();
    expect(result.ambiguous.map((p) => p.id).sort()).toEqual(["p4", "p5"]);
  });

  it("规则4：未匹配不写边但不抛异常（先链接后建页）", () => {
    const result = resolveWikilinkTarget("尚不存在的页面", "sources/x", pages);
    expect(result).toEqual({ targetPageId: null, isResolved: false, ambiguous: [] });
  });

  it("路径含 .. 视为无效，未解析", () => {
    const result = resolveWikilinkTarget("concepts/../etc", "sources/x", pages);
    expect(result.isResolved).toBe(false);
  });

  it("空字符串输入未解析且不抛异常", () => {
    const result = resolveWikilinkTarget("   ", "sources/x", pages);
    expect(result).toEqual({ targetPageId: null, isResolved: false, ambiguous: [] });
  });
});
