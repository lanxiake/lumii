/**
 * WikiContentExtractor / WikiOrganizeQueue 单测。
 */
import { describe, expect, it } from "vitest";
import { WikiContentExtractor } from "./wiki-content-extractor.js";
import {
  computeBackoffDelayMs,
  MAX_ORGANIZE_ATTEMPTS,
  WikiOrganizeQueue,
} from "./wiki-organize-queue.js";

describe("WikiContentExtractor", () => {
  it("文档类直通调用方传入的正文", async () => {
    const ex = new WikiContentExtractor();
    expect(await ex.extract({ mediaType: "document", text: "正文内容" })).toBe("正文内容");
  });

  it("文档类空正文归一为 null", async () => {
    const ex = new WikiContentExtractor();
    expect(await ex.extract({ mediaType: "document", text: "   " })).toBeNull();
    expect(await ex.extract({ mediaType: "document", text: null })).toBeNull();
    expect(await ex.extract({ mediaType: "document" })).toBeNull();
  });

  it("图片类调用注入的 recognizeImage 拿描述", async () => {
    const ex = new WikiContentExtractor({ recognizeImage: async (p) => `描述:${p}` });
    expect(await ex.extract({ mediaType: "image", sourcePath: "/tmp/a.png" })).toBe("描述:/tmp/a.png");
  });

  it("未注入 recognizeImage 时返回 null（能力未启用，区别于已生成的空串）", async () => {
    const ex = new WikiContentExtractor();
    expect(await ex.extract({ mediaType: "image", sourcePath: "/tmp/a.png" })).toBeNull();
  });

  it("recognizeImage 抛错时降级为 null，不向上传播（摄入不因描述失败中断）", async () => {
    const ex = new WikiContentExtractor({
      recognizeImage: async () => {
        throw new Error("vision 不可用");
      },
    });
    expect(await ex.extract({ mediaType: "image", sourcePath: "/tmp/a.png" })).toBeNull();
  });

  it("已生成的空描述保留为空串，与 null 语义区分", async () => {
    const ex = new WikiContentExtractor({ recognizeImage: async () => "" });
    expect(await ex.extract({ mediaType: "image", sourcePath: "/tmp/a.png" })).toBe("");
  });

  it("音频与视频 P0 不提取正文", async () => {
    const ex = new WikiContentExtractor({ recognizeImage: async () => "不该被调用" });
    expect(await ex.extract({ mediaType: "audio", sourcePath: "/tmp/a.mp3" })).toBeNull();
    expect(await ex.extract({ mediaType: "video", sourcePath: "/tmp/a.mp4" })).toBeNull();
  });
});

describe("computeBackoffDelayMs", () => {
  it("四级阶梯：1分钟 → 5分钟 → 30分钟 → 2小时", () => {
    expect(computeBackoffDelayMs(1)).toBe(60_000);
    expect(computeBackoffDelayMs(2)).toBe(300_000);
    expect(computeBackoffDelayMs(3)).toBe(1_800_000);
    expect(computeBackoffDelayMs(4)).toBe(7_200_000);
  });

  it("超过阶梯返回 null，表示转人工处理态", () => {
    expect(computeBackoffDelayMs(MAX_ORGANIZE_ATTEMPTS + 1)).toBeNull();
    expect(computeBackoffDelayMs(99)).toBeNull();
  });

  it("尚未失败过时无需等待", () => {
    expect(computeBackoffDelayMs(0)).toBe(0);
  });

  it("阶梯长度与 takeInboxBatch 默认 maxAttempts 一致", () => {
    expect(MAX_ORGANIZE_ATTEMPTS).toBe(4);
  });
});

describe("WikiOrganizeQueue", () => {
  it("串行执行：任务按入队顺序完成，不交错", async () => {
    const queue = new WikiOrganizeQueue();
    const order: string[] = [];
    const task = (name: string, delay: number) => async () => {
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, delay));
      order.push(`${name}:end`);
    };
    // 先入队的耗时更久：若并发，b:start 会插在 a:end 之前
    queue.enqueue(task("a", 20));
    queue.enqueue(task("b", 1));
    await queue.drain();
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("单个任务抛错不中断后续任务", async () => {
    const queue = new WikiOrganizeQueue();
    const done: string[] = [];
    queue.enqueue(async () => {
      throw new Error("炸了");
    });
    queue.enqueue(async () => {
      done.push("后续任务");
    });
    await queue.drain();
    expect(done).toEqual(["后续任务"]);
  });

  it("运行期间新入队的任务也被 drain 等到", async () => {
    const queue = new WikiOrganizeQueue();
    const done: string[] = [];
    queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 5));
      done.push("first");
      queue.enqueue(async () => {
        done.push("nested");
      });
    });
    await queue.drain();
    expect(done).toEqual(["first", "nested"]);
  });

  it("空队列 drain 立即返回", async () => {
    await new WikiOrganizeQueue().drain();
  });
});
