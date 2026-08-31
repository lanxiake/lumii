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

/** 让 mock LLM 按收到的 id 顺序生成合法用途分类结果 */
function makeLLM(topicFor: (id: string, i: number) => { category: string; subtopic: string }) {
  return async (prompt: string) => {
    const ids = [...prompt.matchAll(/\[id=([0-9a-f]+)\]/g)].map((m) => m[1]!);
    return JSON.stringify(
      ids.map((id, i) => {
        const { category, subtopic } = topicFor(id, i);
        return { id, category, subtopic, skip: false };
      }),
    );
  };
}

const DOC_TOPIC = { category: "工作", subtopic: "项目" } as const;

describe("WikiOrganizer 端到端", () => {
  it("上传 3 条 → 3 条 sources 带主题、inbox organized、不新建 wiki_pages", async () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/a.md", "a", "text/markdown", "文档 A 的内容");
    hook.ingestUpload("ag", "u", "/tmp/b.md", "b", "text/markdown", "文档 B 的内容");
    hook.ingestUpload("ag", "u", "/tmp/c.md", "c", "text/markdown", "文档 C 的内容");

    const pagesBefore = repo.listPages("ag", "u").length;

    const organizer = new WikiOrganizer(repo, makeLLM(() => DOC_TOPIC), new WikiContentExtractor());
    const run = await organizer.organizeBatch("ag", "u", "upload");

    expect(run).not.toBeNull();
    expect(run!.status).toBe("succeeded");
    const storedRun = repo.listRuns("ag", "u")[0]!;
    expect(storedRun.result_detail).toBeTruthy();
    const detail = JSON.parse(storedRun.result_detail!) as {
      items: { inboxId: string; outcome: string; extract: string }[];
    };
    expect(detail.items).toHaveLength(3);
    for (const item of detail.items) {
      expect(item.outcome).toBe("archived");
      expect(item.extract).toBe("preview");
    }

    // 不新建 wiki_pages
    expect(repo.listPages("ag", "u")).toHaveLength(pagesBefore);
    expect(repo.listInbox("ag", "u", "organized")).toHaveLength(3);
    expect(repo.listInbox("ag", "u", "pending")).toHaveLength(0);

    const sources = repo.listSourcesByTopic("ag", "u", { category: "工作", subtopic: "项目" });
    expect(sources).toHaveLength(3);
    for (const source of sources) {
      expect(source.topic_category).toBe("工作");
      expect(source.topic_subtopic).toBe("项目");
    }

    for (const item of repo.listInbox("ag", "u", "organized")) {
      expect(item.organized_source_id).toBeTruthy();
      expect(repo.findSourceById(item.organized_source_id!)).not.toBeNull();
    }
  });

  it("取件为空时返回 null，不产生空运行记录", async () => {
    const { repo } = setup();
    const organizer = new WikiOrganizer(repo, makeLLM(() => DOC_TOPIC), new WikiContentExtractor());
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
    expect(repo.listSources("ag", "u")).toHaveLength(0);
    const pending = repo.listInbox("ag", "u", "pending");
    expect(pending).toHaveLength(2);
    for (const item of pending) {
      expect(item.attempt_count).toBe(1);
      expect(item.last_error).toContain("failed");
    }
    expect(repo.listRuns("ag", "u")[0]!.status).toBe("failed");
    const failedDetail = JSON.parse(repo.listRuns("ag", "u")[0]!.result_detail!) as {
      items: { outcome: string; reason?: string }[];
    };
    expect(failedDetail.items).toHaveLength(2);
    expect(failedDetail.items.every((d) => d.outcome === "failed")).toBe(true);
  });

  it("skip 条目保持 pending/failed 且不建 source", async () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/a.md", "a", "text/markdown", "像一段聊天记录");

    const organizer = new WikiOrganizer(
      repo,
      async (prompt) => {
        const id = /\[id=([0-9a-f]+)\]/.exec(prompt)![1]!;
        return JSON.stringify([{ id, category: null, subtopic: null, skip: true, reason: "像聊天记录" }]);
      },
      new WikiContentExtractor(),
    );
    const run = await organizer.organizeBatch("ag", "u", "upload");

    expect(run!.status).toBe("degraded");
    expect(run!.result_summary).toContain("无法归类留在待整理");
    expect(repo.listSources("ag", "u")).toHaveLength(0);
    expect(repo.listInbox("ag", "u", "organized")).toHaveLength(0);
    const pending = repo.listInbox("ag", "u", "pending")[0]!;
    expect(pending.last_error).toContain("像聊天记录");
  });

  it("越权分类（不在主题树内）不写主题、条目可重试", async () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/a.md", "a", "text/markdown", "内容 A");

    const organizer = new WikiOrganizer(
      repo,
      async (prompt) => {
        const id = /\[id=([0-9a-f]+)\]/.exec(prompt)![1]!;
        return JSON.stringify([{ id, category: "越权大类", subtopic: "越权小类", skip: false }]);
      },
      new WikiContentExtractor(),
    );
    const run = await organizer.organizeBatch("ag", "u", "upload");

    expect(run!.status).toBe("degraded");
    expect(run!.result_summary).toContain("1 项无法归类留在待整理");
    expect(run!.error).toContain("越权大类");
    expect(repo.listSources("ag", "u")).toHaveLength(0);
    expect(repo.listInbox("ag", "u", "organized")).toHaveLength(0);
  });

  it("单条批次返回裸对象（非数组）时正常分类，不再整批降级", async () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/a.md", "a", "text/markdown", "内容 A");

    // 单条时模型常直接返回对象而非数组——这是线上单条归档 100% 降级的根因
    const organizer = new WikiOrganizer(
      repo,
      async (prompt) => {
        const id = /\[id=([0-9a-f]+)\]/.exec(prompt)![1]!;
        return `{"id":"${id}","category":"工作","subtopic":"项目","skip":false}`;
      },
      new WikiContentExtractor(),
    );
    const run = await organizer.organizeBatch("ag", "u", "upload");

    expect(run!.status).toBe("succeeded");
    const sources = repo.listSources("ag", "u");
    expect(sources).toHaveLength(1);
    expect(sources[0]!.topic_category).toBe("工作");
    expect(sources[0]!.topic_subtopic).toBe("项目");
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
[{"id":"${id}","category":"工作","subtopic":"项目","skip":false}]
\`\`\``;
      },
      new WikiContentExtractor(),
    );
    const run = await organizer.organizeBatch("ag", "u", "upload");

    expect(run!.status).toBe("succeeded");
    expect(repo.listSources("ag", "u")[0]!.topic_category).toBe("工作");
  });

  it("重复整理已归档条目不会再次取件", async () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/a.md", "a", "text/markdown", "内容 A");
    const organizer = new WikiOrganizer(repo, makeLLM(() => DOC_TOPIC), new WikiContentExtractor());
    await organizer.organizeBatch("ag", "u", "upload");
    expect(await organizer.organizeBatch("ag", "u", "upload")).toBeNull();
    expect(repo.listSources("ag", "u")).toHaveLength(1);
  });

  it("整理时为缺失正文的图片补内容提取结果", async () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/pic.png", "pic", "image/png"); // 无 contentPreview

    const organizer = new WikiOrganizer(
      repo,
      makeLLM(() => ({ category: "收藏", subtopic: "可复用" })),
      new WikiContentExtractor({ recognizeImage: async () => "一张架构示意图" }),
    );
    await organizer.organizeBatch("ag", "u", "upload");

    const item = repo.listInbox("ag", "u", "organized")[0]!;
    const source = repo.findSourceById(item.organized_source_id!)!;
    expect(source.extracted_text).toBe("一张架构示意图");
  });
});

describe("WikiIngestHook", () => {
  it("三路摄入各写入对应 item_type", () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/a.md", "a");
    hook.ingestOutput("ag", "u", "/tmp/out.md", "产物", "任务上下文");
    hook.ingestWebSearch("ag", "u", "https://example.com/x", "网页", "摘要片段");

    const types = repo
      .listInbox("ag", "u")
      .map((i) => i.item_type)
      .sort();
    expect(types).toEqual(["output", "search", "upload"]);
  });

  it("ingestChat 始终返回 null，不写入 inbox", () => {
    const { repo, hook } = setup();
    expect(hook.ingestChat("ag", "u", "对话内容", "对话")).toBeNull();
    expect(repo.listInbox("ag", "u")).toHaveLength(0);
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

describe("WikiOrganizer 与重新编目互斥", () => {
  /** 造一个只有 status 有意义的批次；organizer 只看 status */
  const runWithStatus = (status: string) =>
    ({
      runId: "r1",
      status,
      scope: { kind: "all" },
      total: 0,
      processed: 0,
      droppedInvalid: 0,
      unchanged: 0,
      candidates: [],
      error: null,
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    }) as never;

  it("reclassify running 时不取件，条目仍 pending", async () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/a.md", "会议纪要", "text/markdown", "纪要正文");
    repo.setReclassifyRun("ag", "u", runWithStatus("running"));

    const organizer = new WikiOrganizer(repo, makeLLM(() => DOC_TOPIC), new WikiContentExtractor());
    expect(await organizer.organizeBatch("ag", "u", "upload")).toBeNull();

    const pending = repo.listInbox("ag", "u").filter((i) => !i.organized_at);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.attempt_count).toBe(0);
  });

  it("review 状态不阻塞自动归档", async () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/a.md", "会议纪要", "text/markdown", "纪要正文");
    repo.setReclassifyRun("ag", "u", runWithStatus("review"));

    const organizer = new WikiOrganizer(repo, makeLLM(() => DOC_TOPIC), new WikiContentExtractor());
    const run = await organizer.organizeBatch("ag", "u", "upload");
    expect(run).not.toBeNull();
    expect(run!.status).toBe("succeeded");
  });

  it("编目结束（批次清空）后自动归档恢复", async () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/a.md", "会议纪要", "text/markdown", "纪要正文");
    repo.setReclassifyRun("ag", "u", runWithStatus("running"));

    const organizer = new WikiOrganizer(repo, makeLLM(() => DOC_TOPIC), new WikiContentExtractor());
    expect(await organizer.organizeBatch("ag", "u", "upload")).toBeNull();

    repo.setReclassifyRun("ag", "u", null);
    const run = await organizer.organizeBatch("ag", "u", "upload");
    expect(run!.status).toBe("succeeded");
  });
});

describe("WikiOrganizer intakeBatch（不调 LLM）", () => {
  /** 调用即失败的 LLM：intakeBatch 一旦碰它就说明走错了路径 */
  const forbiddenLLM = async () => {
    throw new Error("intakeBatch 不该调用 LLM");
  };

  it("归档为未分类资料，完全不调用 LLM", async () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/a.md", "a", "text/markdown", "文档 A 的内容");
    hook.ingestUpload("ag", "u", "/tmp/b.md", "b", "text/markdown", "文档 B 的内容");

    const organizer = new WikiOrganizer(repo, forbiddenLLM, new WikiContentExtractor());
    const run = await organizer.intakeBatch("ag", "u", "upload");

    expect(run).not.toBeNull();
    expect(run!.status).toBe("succeeded");
    expect(repo.listInbox("ag", "u", "pending")).toHaveLength(0);
    expect(repo.listInbox("ag", "u", "organized")).toHaveLength(2);

    const unfiled = repo.listSourcesByTopic("ag", "u", { unfiled: true });
    expect(unfiled).toHaveLength(2);
    for (const source of unfiled) {
      expect(source.topic_category).toBeNull();
    }
  });

  it("取件为空时返回 null，不写运行日志", async () => {
    const { repo } = setup();
    const organizer = new WikiOrganizer(repo, forbiddenLLM, new WikiContentExtractor());
    expect(await organizer.intakeBatch("ag", "u", "upload")).toBeNull();
    expect(repo.listRuns("ag", "u")).toHaveLength(0);
  });

  it("重新编目进行中时不取件", async () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/a.md", "a", "text/markdown", "内容");
    repo.setReclassifyRun("ag", "u", {
      runId: "r1",
      status: "running",
      scope: { kind: "all" },
      total: 0,
      processed: 0,
      droppedInvalid: 0,
      unchanged: 0,
      candidates: [],
      error: null,
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    });

    const organizer = new WikiOrganizer(repo, forbiddenLLM, new WikiContentExtractor());
    expect(await organizer.intakeBatch("ag", "u", "upload")).toBeNull();
    expect(repo.listInbox("ag", "u", "pending")).toHaveLength(1);
  });

  it("运行明细记 archived，路径为空（未分类没有归属路径）", async () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/a.md", "纪要", "text/markdown", "纪要正文");

    const organizer = new WikiOrganizer(repo, forbiddenLLM, new WikiContentExtractor());
    await organizer.intakeBatch("ag", "u", "upload");

    const detail = JSON.parse(repo.listRuns("ag", "u")[0]!.result_detail!) as {
      items: { outcome: string; path: string; extract: string }[];
    };
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]!.outcome).toBe("archived");
    expect(detail.items[0]!.path).toBe("");
    expect(detail.items[0]!.extract).toBe("preview");
  });

  it("单条落库失败时其余条目照常归档，run 记 partial", async () => {
    const { repo, hook } = setup();
    hook.ingestUpload("ag", "u", "/tmp/a.md", "好的", "text/markdown", "正文 A");
    hook.ingestUpload("ag", "u", "/tmp/b.md", "坏的", "text/markdown", "正文 B");

    const organizer = new WikiOrganizer(repo, forbiddenLLM, new WikiContentExtractor());
    const original = repo.fileInboxItemUnclassified.bind(repo);
    let calls = 0;
    repo.fileInboxItemUnclassified = ((item, title) => {
      calls += 1;
      if (calls === 1) throw new Error("磁盘写失败");
      return original(item, title);
    }) as typeof repo.fileInboxItemUnclassified;

    const run = await organizer.intakeBatch("ag", "u", "upload");
    expect(run!.status).toBe("partial");
    expect(repo.listSourcesByTopic("ag", "u", { unfiled: true })).toHaveLength(1);
    expect(repo.listInbox("ag", "u", "pending")).toHaveLength(1);
  });

  it("intakeInboxIds 对指定条目落未分类资料", async () => {
    const { repo, hook } = setup();
    const id1 = hook.ingestUpload("ag", "u", "/tmp/a.md", "a", "text/markdown", "A")!;
    hook.ingestUpload("ag", "u", "/tmp/b.md", "b", "text/markdown", "B");

    const organizer = new WikiOrganizer(repo, forbiddenLLM, new WikiContentExtractor());
    const run = await organizer.intakeInboxIds("ag", "u", [id1]);
    expect(run).not.toBeNull();
    expect(run!.status).toBe("succeeded");
    expect(repo.listSourcesByTopic("ag", "u", { unfiled: true })).toHaveLength(1);
    expect(repo.listInbox("ag", "u", "pending")).toHaveLength(1);
  });
});
