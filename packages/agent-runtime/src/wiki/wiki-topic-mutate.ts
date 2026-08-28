/**
 * Wiki 主题树 mutation — 纯函数：校验规则 + 文件级联计划
 *
 * 设计：docs/design/记忆设计/2026-08-27-wiki-topic-hierarchy-redesign.md §8.1 / §8.2
 * 只由用户 UI 触发（AI 永不改主题树）。删除带文件的节点必须给去向 disposition。
 * 主题一律两列，key 用 topicCountKey（JSON.stringify），禁止 `大类/小类` 拼接串。
 */

import {
  PARKING_CATEGORY,
  validateTopicAssignment,
  validateTopicTree,
  type WikiTopicTree,
} from "./wiki-topic-tree.js";

/** 新建大类时自带的默认小类，避免出现空大类（树校验允许空，但 UI 上无处可放文件） */
export const DEFAULT_NEW_SUBTOPIC = "待归类";

export type FileDisposition =
  | { readonly type: "parking" }
  | { readonly type: "move"; readonly category: string; readonly subtopic: string };

export type WikiTopicMutation =
  | { readonly op: "addCategory"; readonly name: string; readonly index?: number }
  | { readonly op: "renameCategory"; readonly from: string; readonly to: string }
  | { readonly op: "deleteCategory"; readonly name: string; readonly disposition?: FileDisposition }
  | { readonly op: "reorderCategories"; readonly names: readonly string[] }
  | { readonly op: "addSubtopic"; readonly category: string; readonly name: string; readonly index?: number }
  | { readonly op: "renameSubtopic"; readonly category: string; readonly from: string; readonly to: string }
  | {
      readonly op: "deleteSubtopic";
      readonly category: string;
      readonly name: string;
      readonly disposition?: FileDisposition;
    }
  | {
      readonly op: "moveSubtopic";
      readonly fromCategory: string;
      readonly name: string;
      readonly toCategory: string;
      readonly index?: number;
    }
  | {
      readonly op: "mergeSubtopic";
      readonly fromCategory: string;
      readonly fromName: string;
      readonly toCategory: string;
      readonly toName: string;
    };

/** 一条文件级级联：把命中 from 的资料改写成 to；to.subtopic 为 null 表示进临时存放 */
export interface TopicCascade {
  readonly from: { readonly category: string; readonly subtopic: string | null };
  readonly to: { readonly category: string; readonly subtopic: string | null };
}

export type TopicMutationPlan =
  | { readonly ok: true; readonly tree: WikiTopicTree; readonly cascades: readonly TopicCascade[] }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly needsDisposition?: true;
      readonly fileCount?: number;
    };

/**
 * 分组计数 key。语义必须与 renderer 侧 `WikiLeftNav.tsx` 的同名函数完全一致
 * （`JSON.stringify` 两列数组），否则编辑器传进来的 counts 会对不上号。
 * 两处独立实现（agent-runtime 不依赖 renderer），改动时同步改并各自留断言测试。
 */
export function topicCountKey(category: string, subtopic?: string | null): string {
  return subtopic ? JSON.stringify([category, subtopic]) : JSON.stringify([category]);
}

type MutableCategory = { name: string; subtopics: string[] };

function cloneCategories(tree: WikiTopicTree): MutableCategory[] {
  return tree.categories.map((c) => ({ name: c.name, subtopics: [...c.subtopics] }));
}

function fail(reason: string): TopicMutationPlan {
  return { ok: false, reason };
}

/** 名称基本合法性：大类 1-20 字、小类 1-32 字、无控制字符、不得为临时存放 */
function checkName(name: string, kind: "category" | "subtopic"): string | null {
  if (typeof name !== "string") return "名称必须是文本";
  const trimmed = name.trim();
  if (trimmed.length === 0) return "名称不能为空";
  if (trimmed !== name) return "名称首尾不能有空格";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) return "名称含非法字符";
  const max = kind === "category" ? 20 : 32;
  if (name.length > max) return `名称最长 ${max} 个字`;
  if (name === PARKING_CATEGORY) return `不能使用保留名称「${PARKING_CATEGORY}」`;
  return null;
}

/** 插入位置归一：undefined 或越界都落到末尾 */
function insertAt<T>(list: T[], item: T, index?: number): void {
  if (index === undefined || index < 0 || index >= list.length) {
    list.push(item);
    return;
  }
  list.splice(index, 0, item);
}

/** 统计一个节点（或整个大类）下的文件数 */
function countFor(counts: ReadonlyMap<string, number>, category: string, subtopic?: string): number {
  return counts.get(topicCountKey(category, subtopic)) ?? 0;
}

/**
 * 把被删节点的文件按 disposition 折算成级联。
 * 目标节点必须存在于**变更后**的树里；parking 一律落到 (临时存放, null)。
 */
function planDisposition(
  nextTree: WikiTopicTree,
  disposition: FileDisposition,
  affected: ReadonlyArray<{ category: string; subtopic: string }>,
): { ok: true; cascades: TopicCascade[] } | { ok: false; reason: string } {
  const to =
    disposition.type === "parking"
      ? { category: PARKING_CATEGORY, subtopic: null }
      : { category: disposition.category, subtopic: disposition.subtopic };

  if (disposition.type === "move") {
    const check = validateTopicAssignment(nextTree, disposition.category, disposition.subtopic);
    if (!check.ok) return { ok: false, reason: `去向无效：${check.reason}` };
  }

  const cascades: TopicCascade[] = [];
  for (const node of affected) {
    if (node.category === to.category && node.subtopic === to.subtopic) continue;
    cascades.push({ from: { category: node.category, subtopic: node.subtopic }, to });
  }
  return { ok: true, cascades };
}

/** 收尾自检：任何分支产出的树都必须合法 */
function finish(categories: MutableCategory[], cascades: TopicCascade[]): TopicMutationPlan {
  const tree: WikiTopicTree = { version: 1, categories };
  if (!validateTopicTree(tree)) {
    return fail("变更后的主题树不合法");
  }
  return { ok: true, tree, cascades };
}

/**
 * 纯函数：给定当前树 + 每个 (category, subtopic) 的文件条数，算出新树与级联计划。
 * 不碰数据库，便于穷举规则测试。
 *
 * @param counts key = topicCountKey(category, subtopic)
 */
export function planTopicMutation(
  tree: WikiTopicTree,
  mutation: WikiTopicMutation,
  counts: ReadonlyMap<string, number>,
): TopicMutationPlan {
  const cats = cloneCategories(tree);
  const findIndex = (name: string): number => cats.findIndex((c) => c.name === name);

  switch (mutation.op) {
    case "addCategory": {
      const nameError = checkName(mutation.name, "category");
      if (nameError) return fail(nameError);
      if (findIndex(mutation.name) >= 0) return fail(`大类「${mutation.name}」已存在`);
      insertAt(cats, { name: mutation.name, subtopics: [DEFAULT_NEW_SUBTOPIC] }, mutation.index);
      return finish(cats, []);
    }

    case "renameCategory": {
      const nameError = checkName(mutation.to, "category");
      if (nameError) return fail(nameError);
      const idx = findIndex(mutation.from);
      if (idx < 0) return fail(`大类「${mutation.from}」不存在`);
      if (mutation.from === mutation.to) return fail("新旧名称相同");
      if (findIndex(mutation.to) >= 0) return fail(`大类「${mutation.to}」已存在`);
      const target = cats[idx]!;
      const cascades: TopicCascade[] = target.subtopics.map((s) => ({
        from: { category: mutation.from, subtopic: s },
        to: { category: mutation.to, subtopic: s },
      }));
      target.name = mutation.to;
      return finish(cats, cascades);
    }

    case "reorderCategories": {
      if (mutation.names.length !== cats.length) return fail("排序列表与现有大类数量不一致");
      const seen = new Set<string>();
      const reordered: MutableCategory[] = [];
      for (const name of mutation.names) {
        if (seen.has(name)) return fail(`排序列表中出现重复大类：${name}`);
        seen.add(name);
        const idx = findIndex(name);
        if (idx < 0) return fail(`排序列表中的大类不存在：${name}`);
        reordered.push(cats[idx]!);
      }
      return finish(reordered, []);
    }

    case "deleteCategory": {
      const idx = findIndex(mutation.name);
      if (idx < 0) return fail(`大类「${mutation.name}」不存在`);
      if (cats.length <= 1) return fail("至少要保留一个大类");
      const doomed = cats[idx]!;
      const affected = doomed.subtopics
        .map((s) => ({ category: mutation.name, subtopic: s, n: countFor(counts, mutation.name, s) }))
        .filter((x) => x.n > 0);
      const fileCount = affected.reduce((sum, x) => sum + x.n, 0);
      if (fileCount > 0 && !mutation.disposition) {
        return { ok: false, reason: "删除前需要选择文件去向", needsDisposition: true, fileCount };
      }
      cats.splice(idx, 1);
      if (fileCount === 0) return finish(cats, []);
      const disp = planDisposition({ version: 1, categories: cats }, mutation.disposition!, affected);
      if (!disp.ok) return fail(disp.reason);
      return finish(cats, disp.cascades);
    }

    case "addSubtopic": {
      const nameError = checkName(mutation.name, "subtopic");
      if (nameError) return fail(nameError);
      const idx = findIndex(mutation.category);
      if (idx < 0) return fail(`大类「${mutation.category}」不存在`);
      const target = cats[idx]!;
      if (target.subtopics.includes(mutation.name)) {
        return fail(`「${mutation.category}」下已有小类「${mutation.name}」`);
      }
      insertAt(target.subtopics, mutation.name, mutation.index);
      return finish(cats, []);
    }

    case "renameSubtopic": {
      const nameError = checkName(mutation.to, "subtopic");
      if (nameError) return fail(nameError);
      const idx = findIndex(mutation.category);
      if (idx < 0) return fail(`大类「${mutation.category}」不存在`);
      const target = cats[idx]!;
      const subIdx = target.subtopics.indexOf(mutation.from);
      if (subIdx < 0) return fail(`小类「${mutation.from}」不存在`);
      if (mutation.from === mutation.to) return fail("新旧名称相同");
      if (target.subtopics.includes(mutation.to)) {
        return fail(`「${mutation.category}」下已有小类「${mutation.to}」`);
      }
      target.subtopics[subIdx] = mutation.to;
      return finish(cats, [
        {
          from: { category: mutation.category, subtopic: mutation.from },
          to: { category: mutation.category, subtopic: mutation.to },
        },
      ]);
    }

    case "deleteSubtopic": {
      const idx = findIndex(mutation.category);
      if (idx < 0) return fail(`大类「${mutation.category}」不存在`);
      const target = cats[idx]!;
      const subIdx = target.subtopics.indexOf(mutation.name);
      if (subIdx < 0) return fail(`小类「${mutation.name}」不存在`);
      if (target.subtopics.length <= 1) {
        return fail(`「${mutation.category}」至少要保留一个小类`);
      }
      const fileCount = countFor(counts, mutation.category, mutation.name);
      if (fileCount > 0 && !mutation.disposition) {
        return { ok: false, reason: "删除前需要选择文件去向", needsDisposition: true, fileCount };
      }
      target.subtopics.splice(subIdx, 1);
      if (fileCount === 0) return finish(cats, []);
      const disp = planDisposition({ version: 1, categories: cats }, mutation.disposition!, [
        { category: mutation.category, subtopic: mutation.name },
      ]);
      if (!disp.ok) return fail(disp.reason);
      return finish(cats, disp.cascades);
    }

    case "moveSubtopic": {
      const fromIdx = findIndex(mutation.fromCategory);
      if (fromIdx < 0) return fail(`大类「${mutation.fromCategory}」不存在`);
      const toIdx = findIndex(mutation.toCategory);
      if (toIdx < 0) return fail(`大类「${mutation.toCategory}」不存在`);
      if (fromIdx === toIdx) return fail("来源与目标大类相同");
      const src = cats[fromIdx]!;
      const subIdx = src.subtopics.indexOf(mutation.name);
      if (subIdx < 0) return fail(`小类「${mutation.name}」不存在`);
      if (src.subtopics.length <= 1) {
        return fail(`「${mutation.fromCategory}」至少要保留一个小类`);
      }
      const dst = cats[toIdx]!;
      if (dst.subtopics.includes(mutation.name)) {
        return fail(`「${mutation.toCategory}」下已有小类「${mutation.name}」`);
      }
      src.subtopics.splice(subIdx, 1);
      insertAt(dst.subtopics, mutation.name, mutation.index);
      return finish(cats, [
        {
          from: { category: mutation.fromCategory, subtopic: mutation.name },
          to: { category: mutation.toCategory, subtopic: mutation.name },
        },
      ]);
    }

    case "mergeSubtopic": {
      const fromIdx = findIndex(mutation.fromCategory);
      if (fromIdx < 0) return fail(`大类「${mutation.fromCategory}」不存在`);
      const toIdx = findIndex(mutation.toCategory);
      if (toIdx < 0) return fail(`大类「${mutation.toCategory}」不存在`);
      if (mutation.fromCategory === mutation.toCategory && mutation.fromName === mutation.toName) {
        return fail("不能合并到自己");
      }
      const src = cats[fromIdx]!;
      const subIdx = src.subtopics.indexOf(mutation.fromName);
      if (subIdx < 0) return fail(`小类「${mutation.fromName}」不存在`);
      if (!cats[toIdx]!.subtopics.includes(mutation.toName)) {
        return fail(`目标小类不存在：${mutation.toCategory} / ${mutation.toName}`);
      }
      if (src.subtopics.length <= 1) {
        return fail(`「${mutation.fromCategory}」至少要保留一个小类`);
      }
      src.subtopics.splice(subIdx, 1);
      return finish(cats, [
        {
          from: { category: mutation.fromCategory, subtopic: mutation.fromName },
          to: { category: mutation.toCategory, subtopic: mutation.toName },
        },
      ]);
    }

    default: {
      const exhaustive: never = mutation;
      return fail(`未知操作：${JSON.stringify(exhaustive)}`);
    }
  }
}
