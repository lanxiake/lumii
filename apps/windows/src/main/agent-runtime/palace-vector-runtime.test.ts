/**
 * 宫殿向量宿主侧接线（T3）—— 开关、装配、后台补齐
 *
 * 这一层的三个决定都由**实测**驱动，用例逐条锁住：
 * 1. **默认关**：不设环境变量时不加载模型（没开就不付代价）
 * 2. **不降级到哈希向量**：wiki 侧模型失败会回退 `createBigramHashEmbedder`，
 *    但哈希向量本质是词面匹配，对语义改写毫无价值——回退等于"看着像启用了"
 * 3. **补齐要能续跑**：实测补齐到 160/1046 时应用崩溃（silero_vad.onnx 版本不兼容），
 *    补齐静默停住、无任何信号。续跑靠 `e.drawer_id IS NULL` 天然成立，用例锁住它
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_LUMII_PALACE_VECTOR,
  isPalaceVectorEnabled,
  setupPalaceVector,
  backfillPalaceVectors,
} from "./palace-vector-runtime";
import { PalaceVectorIndex, createBigramHashEmbedder, type LocalDatabase } from "@mtbot/agent-runtime";
import {
  createMigratedTestDb,
} from "../../../../../packages/agent-runtime/src/__tests__/helpers/sqlite-test-db";

function fakeLocalDb(adapter: unknown): LocalDatabase {
  return { isOpen: true, db: adapter } as unknown as LocalDatabase;
}

describe("palace-vector 开关", () => {
  const orig = process.env.LUMII_PALACE_VECTOR;
  afterEach(() => {
    if (orig === undefined) delete process.env.LUMII_PALACE_VECTOR;
    else process.env.LUMII_PALACE_VECTOR = orig;
  });

  it("默认常量是关（与 wiki 的默认开故意不同：宫殿是新账）", () => {
    expect(DEFAULT_LUMII_PALACE_VECTOR).toBe("0");
  });

  it("未设置时关闭", () => {
    delete process.env.LUMII_PALACE_VECTOR;
    expect(isPalaceVectorEnabled()).toBe(false);
  });

  it("空串按关闭处理（不是设置了就算开）", () => {
    process.env.LUMII_PALACE_VECTOR = "";
    expect(isPalaceVectorEnabled()).toBe(false);
  });

  it("只有 '1' 才算开", () => {
    process.env.LUMII_PALACE_VECTOR = "1";
    expect(isPalaceVectorEnabled()).toBe(true);
    process.env.LUMII_PALACE_VECTOR = "true";
    expect(isPalaceVectorEnabled()).toBe(false);
  });
});

describe("setupPalaceVector", () => {
  beforeEach(() => {
    process.env.LUMII_PALACE_VECTOR = "1";
  });
  afterEach(() => {
    delete process.env.LUMII_PALACE_VECTOR;
  });

  it("关闭时**不加载嵌入器**（没开就不该付 912ms 的模型加载）", async () => {
    delete process.env.LUMII_PALACE_VECTOR;
    const loader = vi.fn();
    const rt = await setupPalaceVector({
      localDb: fakeLocalDb(createMigratedTestDb()),
      embedderLoader: loader,
    });
    expect(rt.index).toBeNull();
    expect(rt.disabledReason).toContain("未开启");
    expect(loader).not.toHaveBeenCalled();
  });

  it("嵌入器加载失败时**不降级到哈希向量**（那只是词面匹配，看着像启用）", async () => {
    const rt = await setupPalaceVector({
      localDb: fakeLocalDb(createMigratedTestDb()),
      embedderLoader: async () => {
        throw new Error("模型文件缺失");
      },
    });
    expect(rt.index).toBeNull();
    expect(rt.disabledReason).toContain("模型文件缺失");
  });

  it("库未打开时如实报原因，不抛错", async () => {
    const rt = await setupPalaceVector({
      localDb: { isOpen: false } as unknown as LocalDatabase,
      embedderLoader: async () => createBigramHashEmbedder(),
    });
    expect(rt.index).toBeNull();
    expect(rt.disabledReason).toContain("未打开");
  });

  it("启用且模型可用时装配成功", async () => {
    const rt = await setupPalaceVector({
      localDb: fakeLocalDb(createMigratedTestDb()),
      embedderLoader: async () => createBigramHashEmbedder(64),
    });
    expect(rt.index).toBeInstanceOf(PalaceVectorIndex);
    expect(rt.disabledReason).toBeNull();
  });
});

describe("backfillPalaceVectors", () => {
  function seed(adapter: unknown, n: number): string[] {
    const db = adapter as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } };
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `d${String(i).padStart(15, "0")}`;
      ids.push(id);
      db.prepare(
        `INSERT INTO palace_drawers
           (drawer_id, agent_id, user_id, conversation_id, segment_id, wing, room, content, char_count, created_at, deleted_at)
         VALUES (?, 'assistant', 'local-user', NULL, NULL, 'w', 'r', ?, 10, '2026-09-18T00:00:00.000Z', NULL)`,
      ).run(id, `内容 ${i} 工单同步排查`);
    }
    return ids;
  }

  it("补齐全部缺失向量并返回条数", async () => {
    const db = createMigratedTestDb();
    seed(db, 5);
    const index = new PalaceVectorIndex(db, createBigramHashEmbedder(64));

    const done = await backfillPalaceVectors({ localDb: fakeLocalDb(db), index });

    expect(done).toBe(5);
    expect(index.stats("local-user")).toEqual({ indexed: 5, pending: 0 });
    db.close();
  });

  it("**续跑**：第二次调用不重算已索引的（模拟崩溃后重启）", async () => {
    const db = createMigratedTestDb();
    const ids = seed(db, 4);
    const index = new PalaceVectorIndex(db, createBigramHashEmbedder(64));

    // 模拟"上次只跑了第一条就崩了"
    await index.upsertDrawer({
      drawerId: ids[0]!,
      agentId: "assistant",
      userId: "local-user",
      content: "内容 0 工单同步排查",
    });
    expect(index.stats("local-user")).toEqual({ indexed: 1, pending: 3 });

    const done = await backfillPalaceVectors({ localDb: fakeLocalDb(db), index });

    expect(done).toBe(3); // 只补剩下的
    expect(index.stats("local-user")).toEqual({ indexed: 4, pending: 0 });
    db.close();
  });

  it("无事可做时返回 0，不空跑", async () => {
    const db = createMigratedTestDb();
    const index = new PalaceVectorIndex(db, createBigramHashEmbedder(64));
    expect(await backfillPalaceVectors({ localDb: fakeLocalDb(db), index })).toBe(0);
    db.close();
  });

  it("墓碑抽屉不参与补齐（否则 pending 永远补不完）", async () => {
    const db = createMigratedTestDb();
    const ids = seed(db, 2);
    db.prepare("UPDATE palace_drawers SET deleted_at = '2026-09-18T01:00:00.000Z' WHERE drawer_id = ?").run(
      ids[0],
    );
    const index = new PalaceVectorIndex(db, createBigramHashEmbedder(64));

    expect(await backfillPalaceVectors({ localDb: fakeLocalDb(db), index })).toBe(1);
    db.close();
  });

  it("maxBatch 限制单次运行量（超大库不一次跑太久）", async () => {
    const db = createMigratedTestDb();
    seed(db, 10);
    const index = new PalaceVectorIndex(db, createBigramHashEmbedder(64));

    const done = await backfillPalaceVectors({ localDb: fakeLocalDb(db), index, maxBatch: 4 });

    expect(done).toBe(4);
    expect(index.stats("local-user").pending).toBe(6); // 剩下的等下次
    db.close();
  });
});
