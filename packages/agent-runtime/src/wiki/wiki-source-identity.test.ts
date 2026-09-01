import { describe, expect, it } from "vitest";
import { wikiRecordsShareFileIdentity } from "./wiki-source-identity.js";

describe("wikiRecordsShareFileIdentity", () => {
  it("content_hash 相同即同一文件", () => {
    expect(
      wikiRecordsShareFileIdentity(
        { title: "a", contentHash: "h1" },
        { title: "b", contentHash: "h1" },
      ),
    ).toBe(true);
  });

  it("vault 侧车与原路径按去掉后缀的文件名对齐", () => {
    expect(
      wikiRecordsShareFileIdentity(
        { title: "拍照姿势21", sourcePath: "C:/教材/拍照姿势21.mp4" },
        { title: "拍照姿势21", sourcePath: "wiki/收藏/可复用/拍照姿势21.lumii-ref" },
      ),
    ).toBe(true);
  });

  it("标题相同也视为同一文件（队列条目与已分类资料）", () => {
    expect(
      wikiRecordsShareFileIdentity(
        { title: "范文.docx" },
        { title: "范文.docx", sourcePath: "wiki/收藏/范例/范文.lumii-ref" },
      ),
    ).toBe(true);
  });

  it("无关文件不相等", () => {
    expect(
      wikiRecordsShareFileIdentity(
        { title: "合同.pdf", sourcePath: "a/合同.pdf" },
        { title: "发票.pdf", sourcePath: "b/发票.pdf" },
      ),
    ).toBe(false);
  });
});
