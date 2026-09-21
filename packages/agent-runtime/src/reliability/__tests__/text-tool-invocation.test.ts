import { describe, expect, it } from "vitest";
import {
  TEXT_TOOL_INVOCATION_HINT,
  isTextOnlyToolInvocation,
} from "../text-tool-invocation.js";

/** 实测里模型写出来的那种块（取自 2026-09-21 的真实会话记录，已截短） */
const HALLUCINATED_INVOKE = [
  "我写一个完整能跑的 demo1。",
  "",
  "写文件。单独 file_write。",
  '<invoke name="file_write">',
  '<parameter name="content"><!DOCTYPE html>…',
  '</parameter>',
  '<parameter name="filePath">C:\\ws\\outputs\\demo1.html</parameter>',
  "</invoke>",
  "",
  "File written: C:\\ws\\outputs\\demo1.html",
].join("\n");

describe("isTextOnlyToolInvocation —— 识别「工具调用只写进了推理文本」", () => {
  it("实测形态：thinking 里有 <invoke> 且整条消息零结构化调用 → 命中", () => {
    expect(
      isTextOnlyToolInvocation({
        content: [
          { type: "thinking", text: HALLUCINATED_INVOKE },
          { type: "text", text: "生成脚本已写好。" },
        ],
      }),
    ).toBe(true);
  });

  it("同一条消息里已有结构化 toolCall → 不命中（调用发出去了，无需纠正）", () => {
    expect(
      isTextOnlyToolInvocation({
        content: [
          { type: "thinking", text: HALLUCINATED_INVOKE },
          { type: "toolCall", text: "" },
        ],
      }),
    ).toBe(false);
  });

  it("块顺序不影响判定：toolCall 在前、含签名的 thinking 在后，同样不命中", () => {
    expect(
      isTextOnlyToolInvocation({
        content: [
          { type: "toolCall", text: "" },
          { type: "thinking", text: HALLUCINATED_INVOKE },
        ],
      }),
    ).toBe(false);
  });

  it("只有 <invoke> 没有 <parameter> → 不命中（可能只是讨论中的片段）", () => {
    expect(
      isTextOnlyToolInvocation({
        content: [{ type: "thinking", text: "文档里要写 <invoke name=\"x\" 这个标签" }],
      }),
    ).toBe(false);
  });

  it("签名出现在正文通道而非推理通道 → 不命中（本故障只在推理通道出现过）", () => {
    expect(
      isTextOnlyToolInvocation({
        content: [{ type: "text", text: HALLUCINATED_INVOKE }],
      }),
    ).toBe(false);
  });

  it("普通回合（纯推理 + 正文，无签名）→ 不命中", () => {
    expect(
      isTextOnlyToolInvocation({
        content: [
          { type: "thinking", text: "让我先看看目录结构。" },
          { type: "text", text: "这就去查。" },
        ],
      }),
    ).toBe(false);
  });

  it("空消息 / 无 content / 非数组 → 不命中，且不抛", () => {
    expect(isTextOnlyToolInvocation({})).toBe(false);
    expect(isTextOnlyToolInvocation({ content: [] })).toBe(false);
    expect(isTextOnlyToolInvocation({ content: undefined })).toBe(false);
  });

  it("thinking 块 text 非字符串 → 不命中，且不抛", () => {
    expect(
      isTextOnlyToolInvocation({
        content: [{ type: "thinking", text: undefined }],
      }),
    ).toBe(false);
  });
});

describe("TEXT_TOOL_INVOCATION_HINT —— 纠正提示要说到点上", () => {
  it("点明两个事实：没执行、没结果", () => {
    expect(TEXT_TOOL_INVOCATION_HINT).toContain("没有被执行");
    expect(TEXT_TOOL_INVOCATION_HINT).toContain("没有收到任何结果");
  });

  it("点明根因：写在文本里的 <invoke> 不会被识别", () => {
    expect(TEXT_TOOL_INVOCATION_HINT).toContain("<invoke>");
  });

  it("明确要求「不要顺手编返回」——这是本故障的次生伤害", () => {
    expect(TEXT_TOOL_INVOCATION_HINT).toContain("不要");
    expect(TEXT_TOOL_INVOCATION_HINT).toContain("返回");
  });
});
