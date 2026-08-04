/**
 * stuck-detection 纯函数单测
 *
 * 覆盖 OpenManus is_stuck 思想在 mtbot 的实现：重复 assistant 文本输出检测。
 */

import { describe, it, expect } from "vitest";
import { extractAssistantText, detectDuplicateAssistantContent } from "../agent/stuck-detection.js";

const userMsg = (text: string) => ({ role: "user", content: text });
const asst = (text: string) => ({ role: "assistant", content: text });
const asstBlocks = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const toolCall = () => ({ role: "assistant", content: [{ type: "tool_use", name: "x" }] });

describe("extractAssistantText", () => {
  it("string content 直接返回（trim）", () => {
    expect(extractAssistantText(asst("  hello  "))).toBe("hello");
  });
  it("block 数组拼接 text", () => {
    expect(extractAssistantText(asstBlocks("hi there"))).toBe("hi there");
  });
  it("非 assistant 返回空", () => {
    expect(extractAssistantText(userMsg("hi"))).toBe("");
  });
  it("纯工具调用返回空", () => {
    expect(extractAssistantText(toolCall())).toBe("");
  });
});

describe("detectDuplicateAssistantContent", () => {
  it("无重复时返回 null", () => {
    const msgs = [userMsg("a"), asst("答案一"), userMsg("b"), asst("答案二")];
    expect(detectDuplicateAssistantContent(msgs)).toBeNull();
  });

  it("3 条相同 assistant 文本（2 条历史重复）判定卡死", () => {
    const msgs = [
      asst("重复的同一句回答"),
      userMsg("x"),
      asst("重复的同一句回答"),
      userMsg("y"),
      asst("重复的同一句回答"),
    ];
    expect(detectDuplicateAssistantContent(msgs)).toMatch(/repeated 3x/);
  });

  it("仅 2 条相同（1 条历史重复）未达阈值，返回 null", () => {
    const msgs = [asst("同一句"), userMsg("x"), asst("同一句话内容")];
    // 注意两条内容不同，确保不误判
    expect(detectDuplicateAssistantContent(msgs)).toBeNull();
  });

  it("block 形态内容同样能检测", () => {
    const msgs = [
      asstBlocks("一样的内容啊"),
      userMsg("x"),
      asstBlocks("一样的内容啊"),
      userMsg("y"),
      asstBlocks("一样的内容啊"),
    ];
    expect(detectDuplicateAssistantContent(msgs)).toMatch(/repeated 3x/);
  });

  it("最后一条是纯工具调用时不介入（交给工具指纹检测）", () => {
    const msgs = [asst("xxxx"), userMsg("a"), asst("xxxx"), toolCall()];
    expect(detectDuplicateAssistantContent(msgs)).toBeNull();
  });

  it("过短内容（如'好的'）跳过，避免误判", () => {
    const msgs = [asst("好的"), userMsg("a"), asst("好的"), userMsg("b"), asst("好的")];
    expect(detectDuplicateAssistantContent(msgs)).toBeNull();
  });

  it("自定义阈值生效", () => {
    const msgs = [asst("一样一样一样"), userMsg("a"), asst("一样一样一样")];
    // threshold=1：1 条历史重复即触发
    expect(detectDuplicateAssistantContent(msgs, { threshold: 1 })).toMatch(/repeated 2x/);
  });
});
