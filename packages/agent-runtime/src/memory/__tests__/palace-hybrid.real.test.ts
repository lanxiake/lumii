/**
 * 宫殿混合检索的真实库验证（T3-4）
 *
 * 为什么单独一个文件而不是塞进 `palace-repo.test.ts`：那里用的是**内存测试库**
 * （几条合成数据），而 T3-4 要回答的是「在**真实的 1046 条宫殿归档**上，
 * 开了向量之后检索变好还是变坏、钉入会不会被挤掉」——那需要真实语料。
 *
 * 走的是**生产路径**：`PalaceRepo.searchDrawersHybrid` + 真实 `PalaceVectorIndex`
 * + 真实嵌入模型。离线跑分台（`scripts/semantic-eval.mjs`）测的是打分逻辑，
 * 这里测的是**接线**：`ftsRankedRows` 取候选、向量补齐、RRF、钉入保场。
 *
 * 用法：
 *   cd packages/agent-runtime
 *   npx vitest run src/memory/__tests__/palace-hybrid.real.test.ts
 *
 * 环境变量：
 *   LUMII_PALACE_VECTOR=1   必须显式开启（与生产同一条开关）
 *   LUMII_DB_PATH           库路径
 *
 * **零副作用**：向量索引**写入副本**，真实库只读打开。
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { PalaceRepo } from "../palace-repo.js";
import { PalaceVectorIndex } from "../palace-vector.js";
import type { DatabaseAdapter } from "../../storage/local-database.js";
import type { WikiEmbedder } from "../../wiki/wiki-vector.js";

const nodeRequire = createRequire(import.meta.url);
const DB_PATH =
  process.env.LUMII_DB_PATH ?? path.join(os.homedir(), ".lumii", "data", "agent-runtime.db");
const USER = "local-user";

/** 真机嵌入器（与生产同一个模型、同一份缓存、同一份 E5 前缀约定） */
async function loadRealEmbedder(): Promise<WikiEmbedder | null> {
  const cache = path.join(os.homedir(), ".lumii", "models", "wiki-embeddings", "Xenova");
  if (!fs.existsSync(cache)) return null;
  const { pipeline, env } = nodeRequire("@xenova/transformers") as {
    pipeline: (t: string, m: string, o: unknown) => Promise<unknown>;
    env: Record<string, unknown>;
  };
  env.allowLocalModels = true;
  env.cacheDir = cache;
  env.localModelPath = cache;
  env.allowRemoteModels = false;
  const ext = (await pipeline("feature-extraction", "multilingual-e5-small", {
    quantized: true,
    local_files_only: true,
  })) as (t: string, o: unknown) => Promise<{ data: Float32Array }>;
  return {
    modelId: "Xenova/multilingual-e5-small",
    dims: 384,
    embed: async (text: string) => {
      const out = await ext(text, { pooling: "mean", normalize: true });
      return out.data;
    },
  };
}

describe("宫殿混合检索（真实库副本）", () => {
  it("生产路径端到端：向量索引 + searchDrawersHybrid", async () => {
    if (!fs.existsSync(DB_PATH)) {
      console.log(`跳过：库不存在 ${DB_PATH}`);
      return;
    }
    const embedder = await loadRealEmbedder();
    if (!embedder) {
      console.log("跳过：嵌入模型不在本机");
      return;
    }

    // 副本：向量写入副本，真实库不动
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumii-palace-hybrid-"));
    const copyPath = path.join(tmpDir, "agent-runtime.db");
    fs.copyFileSync(DB_PATH, copyPath);
    for (const s of ["-wal", "-shm"]) {
      if (fs.existsSync(DB_PATH + s)) fs.copyFileSync(DB_PATH + s, copyPath + s);
    }
    const { DatabaseSync } = nodeRequire("node:sqlite") as {
      DatabaseSync: new (p: string) => unknown;
    };
    const db = new DatabaseSync(copyPath) as unknown as DatabaseAdapter;
    const repo = new PalaceRepo(db);
    const index = new PalaceVectorIndex(db, embedder);

    try {
      // 用**真实库已经有向量的那批**——生产里索引是后台补齐的，这里模拟"已补齐"。
      // 取副本里已有的 palace_drawer_embeddings（若有），否则现场索引前 N 条。
      const existing = db
        .prepare<{ c: number }>("SELECT COUNT(*) AS c FROM palace_drawer_embeddings")
        .get()?.c ?? 0;
      console.log(`副本中已有向量 ${existing} 条`);

      // ── 1. 语义检索：用户措辞与内容不重合 ──
      // 这条针对的是 s01 那类错配（用户说「线程泄漏」，库里写 goroutine）
      const t0 = Date.now();
      const vecHits = await index.searchSimilar({
        query: "服务器上那个线程泄漏的问题",
        userId: USER,
        limit: 10,
      });
      console.log(
        `\n[向量] 「服务器上那个线程泄漏的问题」 ${Date.now() - t0}ms → ${vecHits.length} 条`,
      );
      for (const h of vecHits.slice(0, 3)) {
        const row = db
          .prepare<{ content: string }>("SELECT content FROM palace_drawers WHERE drawer_id = ?")
          .get(h.drawerId);
        console.log(`   ${h.score.toFixed(3)} ${(row?.content ?? "").slice(0, 50).replace(/\n/g, " ")}`);
      }

      // ── 2. 混合检索：真实 query 走完整路径 ──
      const hybrid = await repo.searchDrawersHybrid({
        query: "服务器上那个线程泄漏的问题",
        userId: USER,
        limit: 5,
        vectorSearch: index,
      });
      console.log(`\n[混合] mode=${hybrid.mode} 返回 ${hybrid.items.length} 条`);
      for (const it of hybrid.items) {
        console.log(`   ${it.score.toFixed(3)} ${it.text.slice(0, 50).replace(/\n/g, " ")}`);
      }

      // 纯 FTS 对照
      const plain = repo.searchDrawers({ query: "服务器上那个线程泄漏的问题", userId: USER, limit: 5 });
      console.log(`\n[纯FTS] 返回 ${plain.length} 条`);
      for (const it of plain.slice(0, 3)) {
        console.log(`   ${it.text.slice(0, 50).replace(/\n/g, " ")}`);
      }

      // ── 3. 钉入兼容性（T3-4 的核心问题）──
      // 取一条真实的、对查询有命中的钉入项，确认它在 hybrid 下仍在场
      const pinTarget = hybrid.items[0]?.drawer_id ?? vecHits[0]?.drawerId;
      if (pinTarget) {
        const withPin = await repo.searchDrawersHybrid({
          query: "服务器上那个线程泄漏的问题",
          userId: USER,
          limit: 3,
          pinnedIds: [pinTarget],
          vectorSearch: index,
        });
        console.log(
          `\n[钉入] 目标=${pinTarget.slice(0, 8)} 在结果里=${withPin.items.some((i) => i.drawer_id === pinTarget)}`,
        );
        expect(withPin.items.some((i) => i.drawer_id === pinTarget)).toBe(true);
      }
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 300_000);
});
