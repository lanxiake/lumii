/**
 * WikiClassifier — 批量分类决策与提示词构造
 *
 * 范式同 memory-extractor.ts：callLLM 依赖注入，纯函数提示词构造与 JSON 解析，
 * 分类结果必须落在 AI_WRITABLE_CATEGORIES 内且路径合法，越权/非法路径降级到 inbox/。
 */

import { AI_WRITABLE_CATEGORIES, validateWikiPath, type WikiInboxItem } from "./types.js";

/** 单条分类结果（解析并校验后，路径始终合法——非法时已降级为 inbox/） */
export interface ClassifiedItem {
  readonly inboxId: string;
  readonly path: string;
  readonly title: string;
  readonly summaryMd: string;
}

/**
 * 构造批量分类提示词：一批收件箱条目的标题 + 内容预览，要求模型返回结构化数组。
 * 批大小由调用方（WikiOrganizer）按内容长度动态收缩，此处只负责构造单批的提示词。
 */
export function buildClassifyPrompt(items: readonly WikiInboxItem[]): string {
  const list = items
    .map(
      (item, i) =>
        `${i + 1}. [id=${item.id}] 标题: ${item.title}\n内容预览: ${(item.content_preview ?? "").slice(0, 300)}`,
    )
    .join("\n\n");

  return [
    "你是资料归档助手。为下面这批待整理资料各生成一条归档结果：分类落点、标题、摘要正文。",
    "",
    "## 允许的顶层分类（不得使用其他分类）",
    "- sources/：文档类资料，默认落点",
    "- media/：图片/音频/视频资料索引",
    "- inbox/：无法判定归属时的兜底落点",
    "",
    "## 输出要求",
    "- path 格式：`<顶层分类>/<短英文或拼音 slug>`，如 `sources/architecture-doc`",
    "- summaryMd 为该资料的摘要正文（Markdown），不超过 500 字",
    "- 不确定分类时，path 用 `inbox/<slug>`，不要臆造分类",
    "",
    "## 待整理资料",
    list,
    "",
    "## 输出格式",
    '返回 JSON 数组，每条: {"id": "<收件箱id>", "path": "...", "title": "...", "summaryMd": "..."}',
    "仅输出 JSON，不要包含其他文字。",
  ].join("\n");
}

/**
 * 解析并校验 LLM 返回的分类结果。
 * 越权顶层分类、非法路径（空段/../绝对路径/分隔符逃逸）的条目降级为 `inbox/<原id>`，
 * 而非丢弃——校验失败不等于资料丢失。
 */
export function parseClassifyResponse(
  response: string,
  items: readonly WikiInboxItem[],
): readonly ClassifiedItem[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  let parsed: unknown;
  try {
    const start = response.indexOf("[");
    const end = response.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) return fallbackAll(items);
    parsed = JSON.parse(response.slice(start, end + 1));
  } catch {
    return fallbackAll(items);
  }
  if (!Array.isArray(parsed)) return fallbackAll(items);

  const results: ClassifiedItem[] = [];
  const seen = new Set<string>();
  for (const raw of parsed) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    const item = id ? byId.get(id) : null;
    if (!item) continue;
    seen.add(item.id);

    const rawPath = typeof record.path === "string" ? record.path : "";
    const { valid, category } = validateWikiPath(rawPath);
    const path = valid && category && AI_WRITABLE_CATEGORIES.has(category) ? rawPath : `inbox/${item.id}`;

    results.push({
      inboxId: item.id,
      path,
      title: typeof record.title === "string" && record.title ? record.title : item.title,
      summaryMd: typeof record.summaryMd === "string" ? record.summaryMd : (item.content_preview ?? ""),
    });
  }

  // 模型漏答的条目同样不能丢：降级落 inbox/
  for (const item of items) {
    if (!seen.has(item.id)) {
      results.push({ inboxId: item.id, path: `inbox/${item.id}`, title: item.title, summaryMd: item.content_preview ?? "" });
    }
  }
  return results;
}

function fallbackAll(items: readonly WikiInboxItem[]): readonly ClassifiedItem[] {
  return items.map((item) => ({
    inboxId: item.id,
    path: `inbox/${item.id}`,
    title: item.title,
    summaryMd: item.content_preview ?? "",
  }));
}

/**
 * 批量分类：调用一次 LLM 处理一批条目。失败时整批降级到 inbox/（调用方仍应
 * 记录 attempt_count，交由退避重试；这里保证分类阶段本身失败不丢数据）。
 */
export async function classifyBatch(
  items: readonly WikiInboxItem[],
  callLLM: (prompt: string) => Promise<string>,
): Promise<readonly ClassifiedItem[]> {
  if (items.length === 0) return [];
  try {
    const response = await callLLM(buildClassifyPrompt(items));
    return parseClassifyResponse(response, items);
  } catch (err) {
    // 保留原始原因，否则退避重试时无从判断是模型不可用还是网络问题
    throw new Error(`wiki classify batch failed: ${(err as Error).message}`);
  }
}
