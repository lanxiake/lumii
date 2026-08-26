import { describe, expect, it } from "vitest";
import { diffLines } from "./line-diff.js";

describe("diffLines", () => {
  it("全同：所有行标记为 same", () => {
    const result = diffLines("a\nb\nc", "a\nb\nc");
    expect(result).toEqual([
      { type: "same", text: "a" },
      { type: "same", text: "b" },
      { type: "same", text: "c" },
    ]);
  });

  it("全异：全部删除后全部新增", () => {
    const result = diffLines("a\nb", "x\ny");
    expect(result).toEqual([
      { type: "remove", text: "a" },
      { type: "remove", text: "b" },
      { type: "add", text: "x" },
      { type: "add", text: "y" },
    ]);
  });

  it("单行增删：中间插入一行", () => {
    const result = diffLines("a\nc", "a\nb\nc");
    expect(result).toEqual([
      { type: "same", text: "a" },
      { type: "add", text: "b" },
      { type: "same", text: "c" },
    ]);
  });

  it("单行增删：删除中间一行", () => {
    const result = diffLines("a\nb\nc", "a\nc");
    expect(result).toEqual([
      { type: "same", text: "a" },
      { type: "remove", text: "b" },
      { type: "same", text: "c" },
    ]);
  });

  it("中文行对比", () => {
    const result = diffLines("第一行\n第二行", "第一行\n修改后的第二行");
    expect(result).toEqual([
      { type: "same", text: "第一行" },
      { type: "remove", text: "第二行" },
      { type: "add", text: "修改后的第二行" },
    ]);
  });

  it("空文本对比", () => {
    expect(diffLines("", "")).toEqual([]);
    expect(diffLines("", "a")).toEqual([{ type: "add", text: "a" }]);
    expect(diffLines("a", "")).toEqual([{ type: "remove", text: "a" }]);
  });

  it("降级路径：超过长度积上限时仍能正确还原首尾公共部分", () => {
    // 构造一个会触发降级（product > 400万）的场景：3000 * 3000 = 900 万
    const common = Array.from({ length: 10 }, (_, i) => `common-${i}`);
    const oldMiddle = Array.from({ length: 3000 }, (_, i) => `old-${i}`);
    const newMiddle = Array.from({ length: 3000 }, (_, i) => `new-${i}`);
    const oldText = [...common, ...oldMiddle, ...common].join("\n");
    const newText = [...common, ...newMiddle, ...common].join("\n");

    const result = diffLines(oldText, newText);

    // 首部公共前缀应保留为 same
    for (let i = 0; i < common.length; i++) {
      expect(result[i]).toEqual({ type: "same", text: common[i] });
    }
    // 尾部公共后缀应保留为 same
    const tail = result.slice(-common.length);
    for (let i = 0; i < common.length; i++) {
      expect(tail[i]).toEqual({ type: "same", text: common[i] });
    }
    // 中间部分应为先删后加
    const removed = result.filter((l) => l.type === "remove").map((l) => l.text);
    const added = result.filter((l) => l.type === "add").map((l) => l.text);
    expect(removed).toEqual(oldMiddle);
    expect(added).toEqual(newMiddle);
  });
});
