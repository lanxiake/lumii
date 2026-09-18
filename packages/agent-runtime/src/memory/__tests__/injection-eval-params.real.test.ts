/**
 * 注入参数对比（B1/B2 的实验台）——同一份数据、同一套线上逻辑，只换参数。
 *
 * 为什么要有它：讨论「24h 免门控席位该留几个」「相关性该不该改成乘法」这类问题时，
 * 靠推理是定不下来的——本仓已有的教训（评审 §4.3）就是"看起来合理"的改动实测为负。
 * 有了 `injection-eval-set.json` 这套标好的期望，参数之争就变成一次跑分。
 *
 * 规则与环境变量同 `injection-eval.real.test.ts`（副本打开，零副作用）。
 * 本文件是**实验台不是回归测试**：它不断言哪个方案对，只把数字并排摆出来。
 *
 *   cd packages/agent-runtime
 *   npx vitest run src/memory/__tests__/injection-eval-params.real.test.ts
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { AgentMemoryRepo } from "../memory-repo.js";
import { DEFAULT_HOT_MEMORY_CONFIG, type HotMemoryConfig } from "../types.js";
import type { DatabaseAdapter } from "../../storage/local-database.js";

const nodeRequire = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH =
  process.env.LUMII_DB_PATH ?? path.join(os.homedir(), ".lumii", "data", "agent-runtime.db");
const SET_PATH =
  process.env.LUMII_INJECT_SET ??
  path.join(HERE, "..", "..", "..", "..", "..", "docs", "test", "memory-eval", "injection-eval-set.json");

interface InjectCase {
  readonly id: string;
  readonly query: string;
  readonly expect: readonly string[];
  readonly reject?: readonly string[];
}

/** 待比较的参数组。`DEFAULT_HOT_MEMORY_CONFIG` 是线上现状，作为对照组 */
const VARIANTS: readonly { name: string; config: HotMemoryConfig }[] = [
  { name: "现状（席位5/加法/门槛.15）", config: DEFAULT_HOT_MEMORY_CONFIG },
  {
    name: "B1 席位→2",
    config: { ...DEFAULT_HOT_MEMORY_CONFIG, freshSeats24h: 2 },
  },
  {
    name: "B1 席位→2 + 门槛.30",
    config: { ...DEFAULT_HOT_MEMORY_CONFIG, freshSeats24h: 2, relevanceGateThreshold: 0.3 },
  },
  {
    name: "B1 席位→2 + 门槛.45",
    config: { ...DEFAULT_HOT_MEMORY_CONFIG, freshSeats24h: 2, relevanceGateThreshold: 0.45 },
  },
  {
    name: "B2 乘法打分",
    config: { ...DEFAULT_HOT_MEMORY_CONFIG, relevanceMode: "multiplicative" },
  },
  {
    name: "B2 乘法 + 席位→2",
    config: { ...DEFAULT_HOT_MEMORY_CONFIG, freshSeats24h: 2, relevanceMode: "multiplicative" },
  },
];

describe("注入参数对比（真实库副本）", () => {
  it("各参数组在同一份数据上的期望命中 / 误注入", () => {
    if (!fs.existsSync(DB_PATH)) {
      console.log(`跳过：库不存在 ${DB_PATH}`);
      return;
    }
    const set: { queries: readonly InjectCase[] } = JSON.parse(fs.readFileSync(SET_PATH, "utf-8"));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumii-inject-params-"));
    const copyPath = path.join(tmpDir, "agent-runtime.db");
    fs.copyFileSync(DB_PATH, copyPath);
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(DB_PATH + suffix)) fs.copyFileSync(DB_PATH + suffix, copyPath + suffix);
    }
    const { DatabaseSync } = nodeRequire("node:sqlite") as {
      DatabaseSync: new (p: string) => unknown;
    };

    // 每组用**独立的副本**：loadTopMemories 会写 exposure_count，
    // 共用一份副本会让后跑的组合拿到被前面改过的数据（组间污染）。
    const lines: string[] = [];
    try {
      for (const v of VARIANTS) {
        const dbPath = path.join(tmpDir, `v-${lines.length}.db`);
        fs.copyFileSync(copyPath, dbPath);
        const raw = new DatabaseSync(dbPath);
        const repo = new AgentMemoryRepo(raw as unknown as DatabaseAdapter);

        let hit = 0;
        let clean = 0;
        const misses: string[] = [];
        for (const c of set.queries) {
          const injected = repo.loadTopMemories("assistant", "local-user", v.config, c.query, "user");
          const text = injected.map((m) => m.content).join("\n");
          const ok = c.expect.length === 0 ? true : c.expect.some((e) => text.includes(e));
          const bad = (c.reject ?? []).filter((r) => text.includes(r));
          if (ok) hit++;
          if (bad.length === 0) clean++;
          if (!ok || bad.length > 0) misses.push(`${c.id}${ok ? "" : "(空)"}${bad.length ? "(误)" : ""}`);
        }
        (raw as { close(): void }).close();
        lines.push(
          `  ${v.name.padEnd(28)} 期望命中 ${String(hit).padStart(2)}/${set.queries.length}` +
            `  无误注入 ${String(clean).padStart(2)}/${set.queries.length}` +
            (misses.length ? `  未达标: ${misses.join(" ")}` : ""),
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    console.log(`\n═══ 注入参数对比（语料 ${DB_PATH}）═══\n${lines.join("\n")}\n`);
    expect(VARIANTS.length).toBeGreaterThan(0);
  });
});
