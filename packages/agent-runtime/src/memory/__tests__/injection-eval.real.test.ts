/**
 * 注入评测（B0）—— 测「该注入什么被注入了」，补上检索评测测不到的那一半。
 *
 * 为什么需要它：`scripts/memory-eval.mjs` 测的是**检索**（Recall@5 = 0.933），
 * 但查得到 ≠ 会注入。实测「TOCC 数据同步到 12345」这条查询：真正相关的
 * `851dc264` 在检索里排第 6，而注入进去的是**另一条**陈旧快照（`060cdafe`，
 * 内容自认"已并入结案档案"）——模型于是照那份过时结论作答。
 *
 * 本脚本直接调 `AgentMemoryRepo.loadTopMemories`（线上同一个函数、同一套打分与
 * 席位逻辑），**不复制任何公式**：抄一份公式跑出来的数字与线上无关，那是自欺。
 *
 * 用法（必须用 vitest 跑，因为它要转译 TS）：
 *   cd packages/agent-runtime
 *   npx vitest run src/memory/__tests__/injection-eval.real.test.ts
 *
 * 环境变量（默认取本机真实库）：
 *   LUMII_DB_PATH      库路径
 *   LUMII_INJECT_SET   评测集路径
 *
 * **零副作用**：`loadTopMemories` 会更新 `last_injected_at` / `exposure_count`
 * （注入记账，属线上行为的一部分，不能在评测里绕开），所以这里先把真实库复制到
 * 临时目录再打开——**读的是同一份数据，改的是副本**。评测跑一百遍也不会污染真实库。
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { AgentMemoryRepo } from "../memory-repo.js";
import type { DatabaseAdapter } from "../../storage/local-database.js";

// Vite 会把裸导入 `node:sqlite` 当成包名去解析而失败（`Failed to load url sqlite`）。
// 用 createRequire 绕开打包器，与 `helpers/sqlite-test-db.ts` 同一手法。
const nodeRequire = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH =
  process.env.LUMII_DB_PATH ?? path.join(os.homedir(), ".lumii", "data", "agent-runtime.db");
const SET_PATH =
  process.env.LUMII_INJECT_SET ??
  path.join(HERE, "..", "..", "..", "..", "..", "docs", "test", "memory-eval", "injection-eval-set.json");

interface InjectCase {
  readonly id: string;
  readonly type: string;
  readonly query: string;
  /** 期望**出现**在注入块里的内容子串（至少命中一个算 ok） */
  readonly expect: readonly string[];
  /** 明确**不该**出现在注入块里的（陈旧快照/已结案/无关条目） */
  readonly reject?: readonly string[];
  /** 这一条锁的是什么 */
  readonly note?: string;
}

describe("注入评测（真实库副本）", () => {
  it("按评测集跑 loadTopMemories 并输出命中情况", () => {
    if (!fs.existsSync(DB_PATH)) {
      console.log(`跳过：库不存在 ${DB_PATH}`);
      return;
    }
    const set: { queries: readonly InjectCase[] } = JSON.parse(fs.readFileSync(SET_PATH, "utf-8"));

    // 副本：连 WAL 一起拷，否则副本可能缺最新已提交数据
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumii-inject-eval-"));
    const copyPath = path.join(tmpDir, "agent-runtime.db");
    fs.copyFileSync(DB_PATH, copyPath);
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(DB_PATH + suffix)) fs.copyFileSync(DB_PATH + suffix, copyPath + suffix);
    }

    const { DatabaseSync } = nodeRequire("node:sqlite") as {
      DatabaseSync: new (p: string) => unknown;
    };
    const raw = new DatabaseSync(copyPath);
    const repo = new AgentMemoryRepo(raw as unknown as DatabaseAdapter);

    const rows: string[] = [];
    let expectHit = 0;
    let rejectClean = 0;
    let rejectTotal = 0;

    try {
      for (const c of set.queries) {
        const injected = repo.loadTopMemories(
          "assistant",
          "local-user",
          undefined,
          c.query,
          "user",
        );
        const text = injected.map((m) => m.content).join("\n");
        const ok = c.expect.some((e) => text.includes(e));
        if (ok) expectHit++;
        const bad = (c.reject ?? []).filter((r) => text.includes(r));
        rejectTotal += (c.reject ?? []).length;
        if (bad.length === 0) rejectClean++;

        rows.push(
          `  [${ok ? " ok " : "MISS"}] ${c.id.padEnd(22)} ${c.type.padEnd(12)} ` +
            `注入 ${injected.length} 条` +
            (c.reject?.length ? ` 误注入 ${bad.length}/${c.reject.length}` : "") +
            (ok && bad.length === 0 ? "" : `\n         期望含: ${c.expect.join(" | ")}`),
        );
        if (!ok || bad.length > 0) {
          rows.push(
            `         实际: ${injected.map((m) => m.content.slice(0, 38).replace(/\n/g, " ")).join(" ¶ ")}`,
          );
        }
      }
    } finally {
      (raw as { close(): void }).close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    const n = set.queries.length;
    console.log(
      `\n═══ 注入评测 ═══\n` +
        `语料: ${DB_PATH}\n` +
        `期望命中: ${expectHit}/${n} (${(expectHit / n).toFixed(3)})\n` +
        `无误注入: ${rejectClean}/${n} 条查询（共 ${rejectTotal} 个拒项）\n\n${rows.join("\n")}\n`,
    );

    // 不作断言：这是**测量工具**，基线数字由人读。硬断言会让它变成回归测试，
    // 而当前基线本就未达标（这正是要修的东西）。
    expect(n).toBeGreaterThan(0);
  });
});
