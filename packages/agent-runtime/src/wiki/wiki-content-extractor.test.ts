/**
 * WikiContentExtractor 单测：正文来源优先级与读文件回落。
 * 核心不变量——读取失败绝不抛错（摄入是旁路），只让正文留空。
 */
import { describe, expect, it, vi } from "vitest";
import {
  WikiContentExtractor,
  isTextReadablePath,
  MAX_EXTRACT_BYTES,
} from "./wiki-content-extractor.js";

describe("isTextReadablePath", () => {
  it("放行常见纯文本与代码扩展名", () => {
    for (const p of ["a.txt", "a.md", "dir/b.json", "c.YAML", "e.ts", "f.py", "g.log"]) {
      expect(isTextReadablePath(p), p).toBe(true);
    }
  });

  it("拒绝二进制文档与无扩展名路径（读出来是乱码，会污染索引）", () => {
    for (const p of ["a.pdf", "a.docx", "a.xlsx", "a.png", "a.zip", "README", "dir.md/file"]) {
      expect(isTextReadablePath(p), p).toBe(false);
    }
  });
});

describe("WikiContentExtractor 文档类", () => {
  it("调用方传入正文时直接用，不读文件", async () => {
    const readTextFile = vi.fn();
    const ex = new WikiContentExtractor({ readTextFile });
    const text = await ex.extract({ mediaType: "document", sourcePath: "a.md", text: "已有正文" });
    expect(text).toBe("已有正文");
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it("无正文时读文件补齐（产物/上传摄入的关键路径）", async () => {
    const readTextFile = vi.fn(async () => "从文件读到的正文");
    const ex = new WikiContentExtractor({ readTextFile });
    const text = await ex.extract({ mediaType: "document", sourcePath: "outputs/a.md", text: null });
    expect(text).toBe("从文件读到的正文");
    expect(readTextFile).toHaveBeenCalledWith("outputs/a.md", MAX_EXTRACT_BYTES);
  });

  it("空白正文视为无正文，回落读文件", async () => {
    const ex = new WikiContentExtractor({ readTextFile: async () => "真正文" });
    expect(await ex.extract({ mediaType: "document", sourcePath: "a.md", text: "   " })).toBe("真正文");
  });

  it("非文本扩展名不读文件，返回 null", async () => {
    const readTextFile = vi.fn();
    const ex = new WikiContentExtractor({ readTextFile });
    expect(await ex.extract({ mediaType: "document", sourcePath: "a.pdf" })).toBeNull();
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it("未注入读取能力时返回 null（保持原有行为）", async () => {
    const ex = new WikiContentExtractor();
    expect(await ex.extract({ mediaType: "document", sourcePath: "a.md" })).toBeNull();
  });

  it("读取抛错时吞掉异常返回 null，不中断摄入", async () => {
    const ex = new WikiContentExtractor({
      readTextFile: async () => {
        throw new Error("权限不足");
      },
    });
    expect(await ex.extract({ mediaType: "document", sourcePath: "a.md" })).toBeNull();
  });

  it("读到空内容按 null 归一", async () => {
    const ex = new WikiContentExtractor({ readTextFile: async () => "  \n " });
    expect(await ex.extract({ mediaType: "document", sourcePath: "a.md" })).toBeNull();
  });
});

describe("WikiContentExtractor 其他类型", () => {
  it("图片走 recognizeImage，失败返回 null", async () => {
    const ok = new WikiContentExtractor({ recognizeImage: async () => "一张架构图" });
    expect(await ok.extract({ mediaType: "image", sourcePath: "a.png" })).toBe("一张架构图");

    const bad = new WikiContentExtractor({
      recognizeImage: async () => {
        throw new Error("vision 不可用");
      },
    });
    expect(await bad.extract({ mediaType: "image", sourcePath: "a.png" })).toBeNull();
  });

  it("音视频 P0 不提取正文", async () => {
    const ex = new WikiContentExtractor({ readTextFile: async () => "不该被调用" });
    expect(await ex.extract({ mediaType: "audio", sourcePath: "a.mp3" })).toBeNull();
    expect(await ex.extract({ mediaType: "video", sourcePath: "a.mp4" })).toBeNull();
  });
});
