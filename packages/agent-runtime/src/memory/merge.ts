/**
 * 记忆候选去重合并（记忆系统升级阶段① S5）—— 纯函数。
 *
 * 把段落总结产出的候选与已有记忆按「归一化语义键」匹配：命中则合并（tags 并集、
 * importance 取高、不新增），未命中则新增。同时对 incoming 内部去重。
 *
 * **局限（诚实标注）**：阶段①归一化键 = category + 去标点/空格/小写 content，
 * 只能去**完全/近似相同的串**；"我喜欢爬山" vs "用户爱好是爬山" 合并不了。
 * 真语义合并需阶段③向量。
 */

import type { MemoryEntry, ExtractedCandidate, MemoryCategory } from "./types.js";

/** 待更新的已有记忆（合并后的字段） */
export interface MemoryUpdate {
  readonly id: string;
  readonly tags: readonly string[];
  readonly importance: number;
}

export interface MergeResult {
  readonly toInsert: readonly ExtractedCandidate[];
  readonly toUpdate: readonly MemoryUpdate[];
}

/**
 * 归一化语义键：category + 去除空白与标点后的小写 content。
 * 分隔符用 "::"（category 为固定枚举无冒号、归一化后的 content 已剥离标点，故不会冲突）。
 */
export function normalizeKey(category: MemoryCategory, content: string): string {
  const norm = content.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  return `${category}::${norm}`;
}

export function mergeCandidates(
  existing: readonly MemoryEntry[],
  incoming: readonly ExtractedCandidate[],
): MergeResult {
  const existingByKey = new Map<string, MemoryEntry>();
  for (const e of existing) existingByKey.set(normalizeKey(e.category, e.content), e);

  const updates = new Map<string, { id: string; tags: Set<string>; importance: number }>();
  const inserts = new Map<string, ExtractedCandidate>();

  for (const c of incoming) {
    const key = normalizeKey(c.category, c.content);
    const match = existingByKey.get(key);

    if (match) {
      // 合并进已有记忆
      const u =
        updates.get(match.id) ??
        { id: match.id, tags: new Set(match.tags), importance: match.importance };
      for (const t of c.tags) u.tags.add(t);
      u.importance = Math.max(u.importance, c.importance);
      updates.set(match.id, u);
    } else {
      // 不在已有中：与 incoming 内部去重
      const seen = inserts.get(key);
      if (seen) {
        inserts.set(key, {
          ...seen,
          tags: [...new Set([...seen.tags, ...c.tags])],
          importance: Math.max(seen.importance, c.importance),
        });
      } else {
        inserts.set(key, c);
      }
    }
  }

  return {
    toInsert: [...inserts.values()],
    toUpdate: [...updates.values()].map((u) => ({
      id: u.id,
      tags: [...u.tags],
      importance: u.importance,
    })),
  };
}
