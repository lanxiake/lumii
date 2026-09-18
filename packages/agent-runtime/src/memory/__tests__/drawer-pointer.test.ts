/**
 * 原文指针（`[d:xxxx]`）—— 注入→回溯链路的写入侧不变量。
 *
 * 起因（2026-09-18）：工作记忆注入到提示词时**不带**能回溯原文的 id，Agent 看得到
 * 结论、摸不到原文；而 `agent_memories.palace_drawer_id` 覆盖率只有 41%，且从没进过
 * 提示词。修法是把指针在**写入时**钉进 content：这样去重、合并、FTS 索引、注入
 * 全都自然带上它，注入侧不必知道 `palace_drawer_id` 这回事。
 *
 * 代价是 `content` 多了一个会变的机器前缀，于是**每个按内容比对的地方都必须先剥它**
 * ——本文件守住的正是这条。漏一处的后果是静默的：去重失效 → 每次提取都新增一条。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { withDrawerPointer, stripDrawerPointer } from "../content-address.js";
import { normalizeKey, mergeCandidates } from "../merge.js";
import { AgentMemoryRepo } from "../memory-repo.js";
import { createMigratedTestDb } from "../../__tests__/helpers/sqlite-test-db.js";
import type { DatabaseAdapter } from "../../storage/local-database.js";

const AGENT = "assistant";
const USER = "local-user";

describe("withDrawerPointer / stripDrawerPointer", () => {
  it("加指针后能原样剥回来", () => {
    const bare = "用户在做记忆系统整改。";
    const withPtr = withDrawerPointer(bare, "9e87df013c4e671a");
    expect(withPtr).toBe("[d:9e87df013c4e671a] 用户在做记忆系统整改。");
    expect(stripDrawerPointer(withPtr)).toBe(bare);
  });

  it("没有 drawerId 时不加前缀", () => {
    expect(withDrawerPointer("普通内容", null)).toBe("普通内容");
    expect(withDrawerPointer("普通内容", undefined)).toBe("普通内容");
  });

  it("重复加指针不叠加，且换 id 时替换而非追加", () => {
    const once = withDrawerPointer("内容", "aaaaaaaaaaaaaaaa");
    const twice = withDrawerPointer(once, "bbbbbbbbbbbbbbbb");
    expect(twice).toBe("[d:bbbbbbbbbbbbbbbb] 内容");
    expect((twice.match(/\[d:/g) ?? []).length).toBe(1);
  });

  it("无 id 时有指针也要剥掉（避免降级写入把机器前缀当正文）", () => {
    expect(withDrawerPointer("[d:aaaaaaaaaaaaaaaa] 内容", null)).toBe("内容");
  });
});

describe("normalizeKey 剥指针（去重键）", () => {
  it("同一事实带不带指针算同一个键", () => {
    const bare = "用户在做记忆系统整改";
    const withPtr = withDrawerPointer(bare, "9e87df013c4e671a");
    expect(normalizeKey("project", withPtr)).toBe(normalizeKey("project", bare));
  });

  it("换了 drawer id 仍是同一个键（指针不该影响身份）", () => {
    const a = withDrawerPointer("同一条记忆", "1111111111111111");
    const b = withDrawerPointer("同一条记忆", "2222222222222222");
    expect(normalizeKey("reference", a)).toBe(normalizeKey("reference", b));
  });

  it("内容不同仍然是不同的键（剥指针没把语义一起剥掉）", () => {
    expect(normalizeKey("project", "[d:aaaaaaaaaaaaaaaa] 甲")).not.toBe(
      normalizeKey("project", "[d:aaaaaaaaaaaaaaaa] 乙"),
    );
  });
});

describe("mergeCandidates 对带指针的既有条目仍能合并", () => {
  const candidate = (content: string) => ({
    content,
    category: "project" as const,
    importance: 0.6,
    tags: ["t1"],
  });

  it("既有条目带指针、候选不带 → 合并而不是新增（这正是修复前的回归）", () => {
    const existing = [
      {
        id: "mem-1",
        agent_id: AGENT,
        user_id: USER,
        category: "project" as const,
        content: "[d:9e87df013c4e671a] 用户在做记忆系统整改",
        importance: 0.5,
        tags: ["old"],
        source_message_id: null,
        source_segment_id: null,
        palace_drawer_id: "9e87df013c4e671a",
        created_at: "2026-09-17T00:00:00.000Z",
        last_injected_at: "2026-09-17T00:00:00.000Z",
        exposure_count: 0,
        utility_count: 0,
        last_used: "2026-09-17T00:00:00.000Z",
        use_count: 0,
        project_key: null,
        superseded_at: null,
        superseded_by: null,
        archive_reason: null,
        is_archived: false,
      },
    ];
    const { toInsert, toUpdate } = mergeCandidates(existing, [
      candidate("用户在做记忆系统整改"),
    ]);
    expect(toInsert).toHaveLength(0);
    expect(toUpdate).toHaveLength(1);
    expect(toUpdate[0]!.id).toBe("mem-1");
  });
});

describe("AgentMemoryRepo 写入侧的指针与去重", () => {
  let db: DatabaseAdapter;
  let repo: AgentMemoryRepo;

  beforeEach(() => {
    db = createMigratedTestDb();
    repo = new AgentMemoryRepo(db);
  });

  it("带 palaceDrawerId 写入时，内容与 FTS 都带指针", () => {
    const saved = repo.saveCandidate({
      agentId: AGENT,
      userId: USER,
      category: "project",
      content: "用户在做记忆系统整改",
      palaceDrawerId: "9e87df013c4e671a",
    });
    expect(saved.content).toBe("[d:9e87df013c4e671a] 用户在做记忆系统整改");

    // FTS 同步：带指针的内容必须可检索（否则回填进来的指针搜不到）
    const hit = repo.search(AGENT, USER, "记忆系统整改");
    expect(hit).toHaveLength(1);
    expect(hit[0]!.content).toContain("[d:9e87df013c4e671a]");
  });

  it("同一内容重复写入是幂等的——即使一次带指针一次不带", () => {
    const first = repo.saveCandidate({
      agentId: AGENT,
      userId: USER,
      category: "project",
      content: "用户在做记忆系统整改",
      palaceDrawerId: "9e87df013c4e671a",
    });
    const second = repo.saveCandidate({
      agentId: AGENT,
      userId: USER,
      category: "project",
      content: "用户在做记忆系统整改",
    });
    expect(second.id).toBe(first.id);
    expect(repo.listActive(AGENT, USER)).toHaveLength(1);
  });

  it("setPalaceDrawerId 把指针补进内容并同步 FTS（段归档回填路径）", () => {
    const saved = repo.saveCandidate({
      agentId: AGENT,
      userId: USER,
      category: "reference",
      content: "用户常用 Notion 管理任务",
    });
    expect(saved.content).not.toContain("[d:");

    repo.setPalaceDrawerId(saved.id, "7c2e91f0a4b3d6e5");

    const after = repo.findById(saved.id)!;
    expect(after.content).toBe("[d:7c2e91f0a4b3d6e5] 用户常用 Notion 管理任务");
    expect(after.palace_drawer_id).toBe("7c2e91f0a4b3d6e5");
    expect(repo.search(AGENT, USER, "Notion")).toHaveLength(1);
  });

  it("setPalaceDrawerIdBySegment 批量回填同一段产出的多条记忆", () => {
    for (const c of ["甲条记忆", "乙条记忆"]) {
      repo.saveCandidate({
        agentId: AGENT,
        userId: USER,
        category: "general",
        content: c,
        sourceSegmentId: "seg-1",
      });
    }
    repo.setPalaceDrawerIdBySegment("seg-1", "aaaaaaaaaaaaaaaa");

    const all = repo.listActive(AGENT, USER);
    expect(all).toHaveLength(2);
    for (const m of all) expect(m.content.startsWith("[d:aaaaaaaaaaaaaaaa] ")).toBe(true);
  });

  it("回填不产生第二次指针（幂等）", () => {
    const saved = repo.saveCandidate({
      agentId: AGENT,
      userId: USER,
      category: "general",
      content: "幂等检查",
    });
    repo.setPalaceDrawerId(saved.id, "aaaaaaaaaaaaaaaa");
    repo.setPalaceDrawerId(saved.id, "aaaaaaaaaaaaaaaa");
    const after = repo.findById(saved.id)!;
    expect((after.content.match(/\[d:/g) ?? []).length).toBe(1);
  });
});

describe("PalaceRepo.existsByIds（注入前的存在性校验）", () => {
  it("只返回真的存在的 id（死链要能识别出来）", async () => {
    const { PalaceRepo } = await import("../palace-repo.js");
    const db = createMigratedTestDb();
    const palace = new PalaceRepo(db);
    const { drawerId } = palace.upsertDrawer({
      agentId: AGENT,
      userId: USER,
      wing: "conversations",
      room: "conv-1",
      content: "一段已归档的原文",
    });

    const found = palace.existsByIds([drawerId, "dead0000dead0000", null, undefined]);
    expect(found.has(drawerId)).toBe(true);
    expect(found.has("dead0000dead0000")).toBe(false);
    expect(found.size).toBe(1);
  });

  it("墓碑行不算存在（删掉的抽屉不该给指针）", () => {
    const db = createMigratedTestDb();
    // 动态导入避免与上面的用例重复初始化
    return import("../palace-repo.js").then(({ PalaceRepo }) => {
      const palace = new PalaceRepo(db);
      const { drawerId } = palace.upsertDrawer({
        agentId: AGENT,
        userId: USER,
        wing: "conversations",
        room: "conv-2",
        content: "将被删除的原文",
      });
      palace.deleteById(drawerId);
      expect(palace.existsByIds([drawerId]).size).toBe(0);
    });
  });
});
