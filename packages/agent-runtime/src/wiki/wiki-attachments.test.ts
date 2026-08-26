import { describe, expect, it } from "vitest";
import { isAttachmentReferenceLine, serializeAttachmentReference } from "./wiki-attachments.js";

describe("serializeAttachmentReference", () => {
  it("生成标准引用语法", () => {
    expect(serializeAttachmentReference("/tmp/a.png", "a.png")).toBe(
      "[media attached: /tmp/a.png (a.png)]",
    );
  });
});

describe("isAttachmentReferenceLine", () => {
  it("识别附件引用行", () => {
    expect(isAttachmentReferenceLine("[media attached: /tmp/a.png (a.png)]")).toBe(true);
    expect(isAttachmentReferenceLine("  [media attached: /tmp/a.png (a.png)]  ")).toBe(true);
  });

  it("非附件行返回 false", () => {
    expect(isAttachmentReferenceLine("普通正文")).toBe(false);
    expect(isAttachmentReferenceLine("[media attached: 缺少收尾")).toBe(false);
  });
});
