/**
 * 相关性度量对比（A2）——测「换一种算相关性的方式，能不能把相关项与无关项分开」。
 *
 * 背景（用户原话）：「相关性不一定可靠，主要是问题和内容关键词很难对应上」。
 * 诊断脚本（`relevance-diagnosis.real.test.ts`）用真实数据证实了这一点：
 * 20 条可测查询里**只有 1 条**的相关项分布与无关项分布不重叠——任何单一阈值
 * 都会同时误伤两边。
 *
 * 一个可测的假设：现在的 `overlapCoefficient` 把「排查」「问题」「同步」这类
 * **满库皆是的泛化词**与「TOCC」「12345」这类**有区分度的词**一视同仁，
 * 于是分值被泛化词灌满。若按语料词频把泛化词滤掉，分离度应当改善。
 *
 * 本文件把三种度量并排跑，让"有没有用"由数字回答，而不是由"听起来合理"回答。
 *
 *   cd packages/agent-runtime
 *   npx vitest run src/memory/__tests__/relevance-metric.real.test.ts
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { tokenizeForRelevance, tokenizeBigram } from "../segmentation.js";

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
}

/** 度量 A：现状（去停用词后的 overlap，交集/较小集） */
function overlapA(q: Set<string>, c: Set<string>): number {
  if (q.size === 0 || c.size === 0) return 0;
  let inter = 0;
  for (const t of q) if (c.has(t)) inter++;
  return inter / Math.min(q.size, c.size);
}

/**
 * 度量 B：词频加权（idf）。
 * 每个命中 token 按 `log(N / df)` 加权——满库皆是的词权重趋近 0，
 * 稀有的判别词权重高。分母用查询侧权重和，结果落在 [0,1]，可与 A 横向比较。
 */
function idfOverlap(q: Set<string>, c: Set<string>, df: Map<string, number>, n: number): number {
  let hitW = 0;
  let totalW = 0;
  for (const t of q) {
    const d = df.get(t) ?? 0;
    const w = d === 0 ? 0 : Math.log(n / d);
    totalW += w;
    if (c.has(t)) hitW += w;
  }
  return totalW === 0 ? 0 : hitW / totalW;
}

/**
 * 度量 C：只算判别词（df 低于语料 20% 的 token）的命中比例。
 * 比 B 更激进——直接把泛化词从查询里删掉。
 */
function rareOnly(q: Set<string>, c: Set<string>, df: Map<string, number>, n: number): number {
  const rare = [...q].filter((t) => (df.get(t) ?? 0) <= n * 0.2);
  if (rare.length === 0) return 0;
  let inter = 0;
  for (const t of rare) if (c.has(t)) inter++;
  return inter / rare.length;
}

describe("相关性度量对比（真实库）", () => {
  it("三种度量在同一评测集上的可分离度", () => {
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
    const rows = raw
      .prepare(
        `SELECT id, content FROM agent_memories
          WHERE user_id = 'local-user' AND is_archived = 0
            AND deleted_at IS NULL AND superseded_at IS NULL`,
      )
      .all() as Row[];
    const docs = rows.map((r) => tokenizeForRelevance(r.content));
    const n = docs.length;

    // 词频表：某 token 出现在多少条记忆里
    const df = new Map<string, number>();
    for (const d of docs) for (const t of d) df.set(t, (df.get(t) ?? 0) + 1);

    const metrics = [
      { name: "A 现状（去停用词 overlap）", fn: (q: Set<string>, c: Set<string>) => overlapA(q, c) },
      { name: "B idf 加权", fn: (q: Set<string>, c: Set<string>) => idfOverlap(q, c, df, n) },
      { name: "C 只算判别词(df≤20%)", fn: (q: Set<string>, c: Set<string>) => rareOnly(q, c, df, n) },
    ];

    /**
     * 可用的判据不是「相关项全在无关项之上」（那要求没有一个无关项蹭到分，
     * 对 231 条语料过于苛刻、实测三种度量都只有 1/20），而是**排序质量**：
     * - `top1Rel`：rank-1 是不是相关项（这才是模型实际采纳的）
     * - 相关项的**中位排名**（分位数，越小越好）
     * - 无关项的**中位排名**（越大越好）
     */
    const lines: string[] = [];
    try {
      for (const m of metrics) {
        let top1Rel = 0;
        let measured = 0;
        const relRanks: number[] = [];
        const irreRanks: number[] = [];
        for (const c0 of set.queries) {
          const q = tokenizeForRelevance(c0.query);
          if (q.size === 0) continue;
          const ranked = docs
            .map((d, i) => ({ i, v: m.fn(q, d) }))
            .filter((x) => x.v > 0)
            .sort((a, b) => b.v - a.v);
          if (ranked.length === 0) continue;
          measured++;
          const isRel = (i: number) => c0.expect.some((e) => rows[i]!.content.includes(e));
          if (isRel(ranked[0]!.i)) top1Rel++;
          ranked.forEach((x, idx) => {
            if (isRel(x.i)) relRanks.push(idx + 1);
            else if ((c0.reject ?? []).some((e) => rows[x.i]!.content.includes(e))) {
              irreRanks.push(idx + 1);
            }
          });
        }
        const med = (a: number[]) => {
          if (a.length === 0) return "—";
          const s = [...a].sort((x, y) => x - y);
          return String(s[Math.floor(s.length / 2)]);
        };
        lines.push(
          `  ${m.name.padEnd(26)} top1 是相关项 ${String(top1Rel).padStart(2)}/${measured}` +
            `   相关项中位排名 ${med(relRanks).padStart(3)}（n=${relRanks.length}）` +
            `   无关项中位排名 ${med(irreRanks).padStart(3)}（n=${irreRanks.length}）`,
        );
      }

      // 顺带列出「最不具区分度」的高频 token——它们就是该被压制的泛化词
      const topCommon = [...df.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 18)
        .map(([t, c]) => `${t}(${c})`)
        .join(" ");

      console.log(
        `\n═══ 相关性度量对比（语料 ${n} 条）═══\n${lines.join("\n")}\n\n` +
          `最高频 token（满库皆是的泛化词，df=${n} 中前 18）:\n  ${topCommon}\n` +
          "（对照：tokenizeForRelevance 手工停用词表里已有的——规划/计划/整理/比较/看看/了解/告诉）\n",
      );
    } finally {
      raw.close();
    }
    expect(n).toBeGreaterThan(0);
  });
});
