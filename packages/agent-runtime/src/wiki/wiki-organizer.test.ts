/**
 * WikiOrganizer / WikiIngestHook 集成测试（真实 SQLite 内存库 + mock callLLM）。
 */
import { describe, expect, it } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { WikiContentExtractor } from "./wiki-content-extractor.js";
import { WikiIngestHook } from "./wiki-ingest-hook.js";
import { WikiOrganizer } from "./wiki-organizer.js";
import { WikiRepo } from "./wiki-repo.js";

function setup() {
  const repo = new WikiRepo(createMigratedTestDb());
  const hook = new WikiIngestHook(repo);
  return { repo, hook };
}

/** 让 mock LLM 按收到的 id 顺序生成合法分类结果 */
function makeLLM(pathFor: (id: string, i: number) => string) {
  return async (prompt: string) => {
    const ids = [...prompt.matchAll(/\[id=([0-9a-f]+)\]/g)].map((m) => m[1]!);
    return JSON.stringify(
      ids.map((id, i) => ({ id, path: pathFor(id, i), title: `标题${i}`, summaryMd: `摘要${i}` })),
    );
  };
}

describe("WikiOrganizer 端到端", () => {
  it("上传 3 条 → 整理 → 3 个页面、inbox 全 organized、run succeeded", async () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/a.md", "a", "text/markdown", "文档 A 的内容");
    hook.ingestUpload("ag", "u", "/tmp/b.md", "b", "text/markdown", "文档 B 的内容");
    hook.ingestUpload("ag", "u", "/tmp/c.md", "c", "text/markdown", "文档 C 的内容");

    const organizer = new WikiOrganizer(
      repo,
      makeLLM((_id, i) => `sources/doc-${i}`),
      new WikiContentExtractor(),
    );
    const run = await organizer.organizeBatch("ag", "u", "upload");

    expect(run).not.toBeNull();
    expect(run!.status).toBe("succeeded");
    expect(repo.listPages("ag", "u")).toHaveLength(3);
    expect(repo.listInbox("ag", "u", "organized")).toHaveLength(3);
    expect(repo.listInbox("ag", "u", "pending")).toHaveLength(0);

    // 归档后的页面可被中文检索命中
    expect(repo.search("ag", "u", "摘要0").length).toBeGreaterThan(0);
    // 每条 inbox 都绑定了资料层记录
    for (const item of repo.listInbox("ag", "u", "organized")) {
      expect(item.organized_source_id).toBeTruthy();
      expect(repo.findSourceById(item.organized_source_id!)).not.toBeNull();
    }
  });

  it("取件为空时返回 null，不产生空运行记录", async () => {
    const { repo } = setup();
    const organizer = new WikiOrganizer(repo, makeLLM(() => "sources/x"), new WikiContentExtractor());
    expect(await organizer.organizeBatch("ag", "u", "upload")).toBeNull();
    expect(repo.listRuns("ag", "u")).toHaveLength(0);
  });

  it("LLM 抛错时 run 为 failed，条目仍 pending 且记 attempt_count（不丢数据）", async () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/a.md", "a", "text/markdown", "内容 A");
    hook.ingestUpload("ag", "u", "/tmp/b.md", "b", "text/markdown", "内容 B");

    const organizer = new WikiOrganizer(
      repo,
      async () => {
        throw new Error("模型不可用");
      },
      new WikiContentExtractor(),
    );
    const run = await organizer.organizeBatch("ag", "u", "upload");

    expect(run!.status).toBe("failed");
    expect(repo.listPages("ag", "u")).toHaveLength(0);
    const pending = repo.listInbox("ag", "u", "pending");
    expect(pending).toHaveLength(2);
    for (const item of pending) {
      expect(item.attempt_count).toBe(1);
      expect(item.last_error).toContain("failed");
    }
    expect(repo.listRuns("ag", "u")[0]!.status).toBe("failed");
  });

  it("越权分类降级到 inbox/：条目仍归档，但 run 记 degraded 且写明原因", async () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/a.md", "a", "text/markdown", "内容 A");

    const organizer = new WikiOrganizer(
      repo,
      makeLLM(() => "syntheses/越权"), // P2 分类，AI 不可自动写
      new WikiContentExtractor(),
    );
    const run = await organizer.organizeBatch("ag", "u", "upload");

    // 资料没丢（已归档），但落点是兜底的——不能报成 succeeded，否则用户无从发现
    expect(run!.status).toBe("degraded");
    expect(run!.result_summary).toContain("1 项分类降级");
    expect(run!.error).toContain("syntheses/越权");
    const pages = repo.listPages("ag", "u");
    expect(pages).toHaveLength(1);
    expect(pages[0]!.category).toBe("inbox");
    // 降级仍要落库成 organized，不能卡在 pending
    expect(repo.listInbox("ag", "u", "organized")).toHaveLength(1);
  });

  it("单条批次返回裸对象（非数组）时正常分类，不再整批降级", async () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/a.md", "a", "text/markdown", "内容 A");

    // 单条时模型常直接返回对象而非数组——这是线上单条归档 100% 降级的根因
    const organizer = new WikiOrganizer(
      repo,
      async (prompt) => {
        const id = /\[id=([0-9a-f]+)\]/.exec(prompt)![1]!;
        return `{"id":"${id}","path":"sources/solo","title":"单条","summaryMd":"真摘要"}`;
      },
      new WikiContentExtractor(),
    );
    const run = await organizer.organizeBatch("ag", "u", "upload");

    expect(run!.status).toBe("succeeded");
    const pages = repo.listPages("ag", "u");
    expect(pages[0]!.path).toBe("sources/solo");
    expect(pages[0]!.content_md).toBe("真摘要");
  });

  it("思考块与散文里的方括号不再带偏 JSON 边界", async () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/a.md", "a", "text/markdown", "内容 A");

    const organizer = new WikiOrganizer(
      repo,
      async (prompt) => {
        const id = /\[id=([0-9a-f]+)\]/.exec(prompt)![1]!;
        return `<think>先看 items[0] 的类型，再决定落点 [重要]</think>
好的，结果如下：
\`\`\`json
[{"id":"${id}","path":"sources/from-think","title":"T","summaryMd":"S"}]
\`\`\``;
      },
      new WikiContentExtractor(),
    );
    const run = await organizer.organizeBatch("ag", "u", "upload");

    expect(run!.status).toBe("succeeded");
    expect(repo.listPages("ag", "u")[0]!.path).toBe("sources/from-think");
  });

  it("重复整理已归档条目不会再次取件", async () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/a.md", "a", "text/markdown", "内容 A");
    const organizer = new WikiOrganizer(
      repo,
      makeLLM(() => "sources/a"),
      new WikiContentExtractor(),
    );
    await organizer.organizeBatch("ag", "u", "upload");
    expect(await organizer.organizeBatch("ag", "u", "upload")).toBeNull();
    expect(repo.listPages("ag", "u")).toHaveLength(1);
  });

  it("整理时为缺失正文的图片补内容提取结果", async () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/pic.png", "pic", "image/png"); // 无 contentPreview

    const organizer = new WikiOrganizer(
      repo,
      makeLLM(() => "media/pic"),
      new WikiContentExtractor({ recognizeImage: async () => "一张架构示意图" }),
    );
    await organizer.organizeBatch("ag", "u", "upload");

    const item = repo.listInbox("ag", "u", "organized")[0]!;
    const source = repo.findSourceById(item.organized_source_id!)!;
    expect(source.extracted_text).toBe("一张架构示意图");
  });
});

describe("WikiIngestHook", () => {
  it("四路摄入各写入对应 item_type", () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/a.md", "a");
    hook.ingestOutput("ag", "u", "/tmp/out.md", "产物", "任务上下文");
    hook.ingestWebSearch("ag", "u", "https://example.com/x", "网页", "摘要片段");
    hook.ingestChat("ag", "u", "对话内容", "对话");

    const types = repo
      .listInbox("ag", "u")
      .map((i) => i.item_type)
      .sort();
    expect(types).toEqual(["chat", "output", "search", "upload"]);
  });

  it("相同内容重复摄入返回同一条目，不产生重复", () => {
    const { repo, hook } = setup();
    const a = hook.ingestUpload("ag", "u", "/tmp/a.md", "a", "text/markdown", "同样的内容");
    const b = hook.ingestUpload("ag", "u", "/tmp/a.md", "a", "text/markdown", "同样的内容");
    expect(b).toBe(a);
    expect(repo.listInbox("ag", "u")).toHaveLength(1);
  });

  it("同路径内容变化时作为新条目摄入（哈希变化）", () => {
    const { repo, hook } = setup();
    const a = hook.ingestUpload("ag", "u", "/tmp/a.md", "a", "text/markdown", "第一版");
    const b = hook.ingestUpload("ag", "u", "/tmp/a.md", "a", "text/markdown", "第二版");
    expect(b).not.toBe(a);
    expect(repo.listInbox("ag", "u")).toHaveLength(2);
  });

  it("按扩展名与 mime 推断媒体类型", () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/a.png", "图");
    hook.ingestUpload("ag", "u", "/tmp/b.mp3", "音");
    hook.ingestUpload("ag", "u", "/tmp/c.mp4", "视");
    hook.ingestUpload("ag", "u", "/tmp/d.unknown", "未知");
    hook.ingestUpload("ag", "u", "/tmp/e.bin", "按mime", "image/jpeg");

    const byTitle = new Map(repo.listInbox("ag", "u").map((i) => [i.title, i.media_type]));
    expect(byTitle.get("图")).toBe("image");
    expect(byTitle.get("音")).toBe("audio");
    expect(byTitle.get("视")).toBe("video");
    expect(byTitle.get("未知")).toBe("document");
    expect(byTitle.get("按mime")).toBe("image");
  });

  it("底层写入抛错时吞掉异常返回 null，不影响主流程", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    // 模拟数据库层故障
    repo.ingestToInbox = () => {
      throw new Error("磁盘满");
    };
    const hook = new WikiIngestHook(repo);
    expect(() => hook.ingestUpload("ag", "u", "/tmp/a.md", "a")).not.toThrow();
    expect(hook.ingestUpload("ag", "u", "/tmp/a.md", "a")).toBeNull();
  });

  it("网页检索以 url 为去重维度，同 url 同摘要只摄入一次", () => {
    const { repo, hook } = setup();
    hook.ingestWebSearch("ag", "u", "https://example.com/x", "标题", "摘要");
    hook.ingestWebSearch("ag", "u", "https://example.com/x", "标题", "摘要");
    expect(repo.listInbox("ag", "u")).toHaveLength(1);
    expect(repo.listInbox("ag", "u")[0]!.source_url).toBe("https://example.com/x");
  });
});
