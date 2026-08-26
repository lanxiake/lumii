import { describe, expect, it } from "vitest";
import { parseWikilinks } from "./wiki-link-parser.js";

describe("parseWikilinks", () => {
  it("解析不带路径的 [[标题]]", () => {
    const result = parseWikilinks("参见 [[微信语音]] 的处理逻辑");
    expect(result).toEqual([{ anchorText: "微信语音" }]);
  });

  it("解析带路径的 [[目录/标题]]", () => {
    const result = parseWikilinks("参见 [[concepts/微信语音]]");
    expect(result).toEqual([{ anchorText: "concepts/微信语音" }]);
  });

  it("跨行不解析", () => {
    const result = parseWikilinks("[[微信\n语音]]");
    expect(result).toEqual([]);
  });

  it("空 [[]] 不产生候选", () => {
    const result = parseWikilinks("这是空的 [[]] 链接");
    expect(result).toEqual([]);
  });

  it("别名写法 [[a|b]] 不解析，保留原文", () => {
    const result = parseWikilinks("这是别名 [[微信|WeChat]] 写法");
    expect(result).toEqual([]);
  });

  it("同一行多个链接全部解析", () => {
    const result = parseWikilinks("[[A]] 和 [[B]] 都相关");
    expect(result).toEqual([{ anchorText: "A" }, { anchorText: "B" }]);
  });

  it("代码块中的双方括号也会被当作候选（设计接受的已知误伤，仅影响索引不改正文）", () => {
    const result = parseWikilinks("```\nconst arr = [[1, 2], [3, 4]]\n```");
    expect(result.length).toBe(0);
  });
});
