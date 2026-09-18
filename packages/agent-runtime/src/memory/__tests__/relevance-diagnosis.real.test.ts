/**
 * 相关性诊断（A2）——回答「相关性到底可不可靠、错配长什么样」。
 *
 * 用户的原话：「相关性不一定可靠，主要是问题和内容关键词很难对应上」。
 * 本文件把这个直觉变成可读的数字：对评测集每条查询，打印相关项与无关项的
 * overlap 分布，让"区分不开"或"能区分"一目了然，而不是靠感觉调参。
 *
 * 特别关注错配的三种形态：
 * 1. **同义不同词**：用户说「连接池」，内容写 HikariCP（bigram 完全无交集）
 * 2. **泛化词占位**：用户说「排查」，满库都是「排查」
 * 3. **长文稀释**：长内容里蹭到几个 bigram，overlap 看起来不低
 *
 *   cd packages/agent-runtime
 *   npx vitest run src/memory/__tests__/relevance-diagnosis.real.test.ts
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { tokenizeForRelevance, overlapCoefficient } from "../segmentation.js";
import type { DatabaseAdapter } from "../../storage/local-database.js";

const nodeRequire = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH =
  process.env.LUMII_DB_PATH ?? path.join(os.homedir(), ".lumii", "data", "agent-runtime.db");
const SET_PATH =
  process.env.LUMII_INJECT_SET ??
  path.join(HERE, "..", "..", "..", "..", "..", "docs", "test", "memory-eval", "injection-eval-set.json");

interface Row {
  id: string;
  content: string;
  category: string;
  importance: number;
  created_at: string;
}

describe("相关性诊断（真实库副本）", () => {
  it("逐条查询打印 相关项 vs 无关项 的 overlap 分布", () => {
    if (!fs.existsSync(DB_PATH)) {
      console.log(`跳过：库不存在 ${DB_PATH}`);
      return;
    }
    const set: {
      queries: readonly { id: string; query: string; expect: readonly string[]; reject?: readonly string[] }[];
    } = JSON.parse(fs.readFileSync(SET_PATH, "utf-8"));

    const { DatabaseSync } = nodeRequire("node:sqlite") as {
      DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => unknown;
    };
    const raw = new DatabaseSync(DB_PATH, { readOnly: true }) as {
      prepare(sql: string): { all(...p: unknown[]): unknown[] };
      close(): void;
    };

    const rows = (
      raw
        .prepare(
          `SELECT id, content, category, importance, created_at FROM agent_memories
            WHERE user_id = 'local-user' AND is_archived = 0
              AND deleted_at IS NULL AND superseded_at IS NULL`,
        )
        .all() as Row[]
    ).filter((r) => r.content.length > 0);

    const lines: string[] = [];
    const quantile = (arr: number[], p: number): number => {
      if (arr.length === 0) return NaN;
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
    };

    let separatedCount = 0;
    let measuredCount = 0;

    try {
      for (const c of set.queries) {
        const qt = tokenizeForRelevance(c.query);
        if (qt.size === 0) continue;
        const scored = rows.map((r) => ({
          r,
          rel: overlapCoefficient(qt, tokenizeForRelevance(r.content)),
        }));
        const isRel = (x: { r: Row }) => c.expect.some((e) => x.r.content.includes(e));
        const isIrrel = (x: { r: Row }) =>
          c.expect.every((e) => !x.r.content.includes(e)) &&
          (c.reject ?? []).some((e) => x.r.content.includes(e));
        const rel = scored.filter(isRel).map((x) => x.rel);
        const irrel = scored.filter(isIrrel).map((x) => x.rel);
        if (rel.length === 0) continue;

        measuredCount++;
        // 分离度：相关项的最小分 是否严格高于 无关项的最大分
        const separated = irrel.length > 0 && Math.min(...rel) > Math.max(...irrel);
        if (separated) separatedCount++;

        const top = scored.sort((a, b) => b.rel - a.rel).slice(0, 3);
        lines.push(
          `  ${c.id.padEnd(22)} 相关项 n=${rel.length} rel=[${rel.map((v) => v.toFixed(2)).join(",")}]` +
            (irrel.length
              ? ` | 无关项 n=${irrel.length} max=${Math.max(...irrel).toFixed(2)} p50=${quantile(irrel, 0.5).toFixed(2)}` +
                ` | ${separated ? "可分离" : "**重叠**"}`
              : " | (无标注的无关项)") +
            `\n       top3: ${top.map((t) => `${t.rel.toFixed(2)} ${t.r.content.slice(0, 34).replace(/\n/g, " ")}`).join(" ¶ ")}`,
        );
      }
    } finally {
      raw.close();
    }

    // 全库相关性分布：有多少条拿到非零 overlap
    const nonzero = set.queries.map((c) => {
      const qt = tokenizeForRelevance(c.query);
      return rows.filter((r) => overlapCoefficient(qt, tokenizeForRelevance(r.content)) > 0).length;
    });

    console.log(
      `\n═══ 相关性诊断（语料 ${rows.length} 条）═══\n` +
        `可测查询: ${measuredCount}\n` +
        `相关/无关**可分离**: ${separatedCount}/${measuredCount}` +
        `  ← 其余的是「同一阈值无法同时保住相关项、挡住无关项」\n` +
        `每条查询能拿到非零相关性的条目数: ${nonzero.join(", ")}\n\n${lines.join("\n")}\n`,
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});
