/**
 * Wiki 分类 LLM 上下文构造：目录树、已有分类占用、UI 分区映射。
 * 供文件夹导入后的批量 AI 归档使用，提高自动化准确率。
 */

import type { WikiInboxItem } from "./types.js";
import type { WikiRepo } from "./wiki-repo.js";
import { navIdFromLegacyCategory, navLabel, WIKI_NAV_SECTIONS } from "./wiki-nav-map.js";
import { topicCountKey } from "./wiki-topic-mutate.js";
import type { WikiTopicTree } from "./wiki-topic-tree.js";

/** 传给 buildClassifyPrompt 的额外上下文 */
export interface WikiClassifyContext {
  /** 本次导入的根目录（绝对或工作区相对） */
  readonly importRoot?: string;
  /** 源目录树文本（ASCII） */
  readonly directoryTree?: string;
  /** 库内已有分类占用与示例 */
  readonly topicOccupancy?: string;
  /** UI 分区 ↔ 旧大类映射说明 */
  readonly navSectionGuide?: string;
  /** 同批导入时的归类提示 */
  readonly batchHint?: string;
}

/** 构造 classify 上下文的输入 */
export interface BuildFolderImportContextParams {
  readonly importRoot: string;
  readonly workspaceRoot?: string;
  readonly inboxItems: readonly WikiInboxItem[];
  readonly repo: WikiRepo;
  readonly agentId: string;
  readonly userId: string;
  readonly topicTree: WikiTopicTree;
}

/**
 * 从文件夹导入的一批 inbox 条目构造完整分类上下文。
 */
export function buildFolderImportClassifyContext(
  params: BuildFolderImportContextParams,
): WikiClassifyContext {
  const { importRoot, workspaceRoot, inboxItems, repo, agentId, userId, topicTree } = params;
  const importRootNorm = normalizePosix(importRoot);
  const paths = inboxItems.map((item) => item.source_path ?? item.title);

  return {
    importRoot: importRootNorm,
    directoryTree: buildDirectoryTreeText(paths, importRootNorm, workspaceRoot),
    topicOccupancy: buildTopicOccupancySummary(repo, agentId, userId, topicTree),
    navSectionGuide: buildNavSectionGuide(),
    batchHint:
      inboxItems.length > 1
        ? `本批 ${inboxItems.length} 个文件来自同一目录导入；同一子文件夹下的文件通常应归入相同或相近的小类，除非内容用途明显不同。`
        : undefined,
  };
}

/**
 * 生成 UI 分区与旧大类对照（CLI/DB 仍写旧大类名）。
 */
export function buildNavSectionGuide(): string {
  const lines = WIKI_NAV_SECTIONS.filter(
    (s) => s.id !== "inbox" && s.id !== "archived" && s.legacyCategories.length > 0,
  ).map((s) => {
    const cats = s.legacyCategories.join("、");
    return `- ${s.label}（${s.hint}）→ 旧大类：${cats}`;
  });
  return lines.join("\n");
}

/**
 * 统计各小类已有资料数量，并附 1–2 条示例标题。
 */
export function buildTopicOccupancySummary(
  repo: WikiRepo,
  agentId: string,
  userId: string,
  topicTree: WikiTopicTree,
  opts?: { readonly maxSamplesPerSubtopic?: number },
): string {
  const maxSamples = opts?.maxSamplesPerSubtopic ?? 2;
  const counts = repo.countSourcesByTopic();
  const lines: string[] = [];

  for (const cat of topicTree.categories) {
    for (const sub of cat.subtopics) {
      const key = topicCountKey(cat.name, sub);
      const n = counts.get(key) ?? 0;
      if (n === 0) continue;
      const nav = navLabel(navIdFromLegacyCategory(cat.name));
      const samples = repo
        .listSourcesByTopic(agentId, userId, { category: cat.name, subtopic: sub })
        .slice(0, maxSamples)
        .map((s) => s.title)
        .join("、");
      lines.push(
        `- ${nav} / ${sub}（${cat.name}）已有 ${n} 个${samples ? `，例：${samples}` : ""}`,
      );
    }
  }

  if (lines.length === 0) {
    return "（资料库中尚无已分类文件，按用途口诀选择即可）";
  }
  return lines.slice(0, 40).join("\n");
}

/**
 * 由文件路径列表生成 ASCII 目录树（相对 importRoot）。
 */
export function buildDirectoryTreeText(
  paths: readonly string[],
  importRoot: string,
  workspaceRoot?: string,
): string {
  const root = normalizePosix(importRoot).replace(/\/+$/, "");
  const relPaths = paths
    .map((p) => toRelativeUnderRoot(p, root, workspaceRoot))
    .filter((p): p is string => p !== null)
    .sort();

  if (relPaths.length === 0) {
    return paths.map((p) => `- ${normalizePosix(p)}`).join("\n");
  }

  /** path segment → children set */
  const rootNode: TreeNode = { name: "", children: new Map(), files: [] };

  for (const rel of relPaths) {
    const parts = rel.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let node = rootNode;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      if (!node.children.has(seg)) {
        node.children.set(seg, { name: seg, children: new Map(), files: [] });
      }
      node = node.children.get(seg)!;
    }
    const fileName = parts[parts.length - 1]!;
    node.files.push(fileName);
  }

  const lines: string[] = [`${basename(root) || root}/`];
  renderTree(rootNode, "  ", lines, true);
  return lines.join("\n");
}

interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  files: string[];
}

/**
 * 递归渲染目录树节点。
 */
function renderTree(node: TreeNode, indent: string, lines: string[], isRoot: boolean): void {
  const childDirs = [...node.children.keys()].sort();
  for (const dir of childDirs) {
    lines.push(`${indent}${dir}/`);
    renderTree(node.children.get(dir)!, indent + "  ", lines, false);
  }
  for (const file of [...node.files].sort()) {
    if (!isRoot || childDirs.length > 0 || node.files.length > 1) {
      lines.push(`${indent}${file}`);
    } else {
      lines.push(`${indent}${file}`);
    }
  }
}

/**
 * 计算文件路径相对 importRoot 的路径。
 */
function toRelativeUnderRoot(
  filePath: string,
  importRoot: string,
  workspaceRoot?: string,
): string | null {
  const norm = normalizePosix(filePath);
  const root = normalizePosix(importRoot).replace(/\/+$/, "");

  if (norm.toLowerCase().startsWith(root.toLowerCase() + "/")) {
    return norm.slice(root.length + 1);
  }
  if (norm.toLowerCase() === root.toLowerCase()) return basename(norm);

  if (workspaceRoot) {
    const ws = normalizePosix(workspaceRoot).replace(/\/+$/, "");
    const absFile = norm.startsWith("/") || /^[a-zA-Z]:/.test(norm)
      ? norm
      : `${ws}/${norm}`.replace(/\/+/g, "/");
    const absRoot = root.startsWith("/") || /^[a-zA-Z]:/.test(root) ? root : `${ws}/${root}`.replace(/\/+/g, "/");
    if (absFile.toLowerCase().startsWith(absRoot.toLowerCase() + "/")) {
      return absFile.slice(absRoot.length + 1);
    }
  }

  return norm;
}

function normalizePosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function basename(p: string): string {
  const norm = normalizePosix(p);
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}
