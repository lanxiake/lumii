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
  /**
   * 该条是否走了降级落点（inbox/<id>）而非模型给出的分类。
   * 仅降级时出现，正常结果不带此字段——调用方据此把「分类失败但没丢数据」
   * 与「真正分类成功」区分开，写进运行日志供用户看见。
   */
  readonly degraded?: true;
  /** 降级原因（仅 degraded 时出现），用于运行日志与排查 */
  readonly degradeReason?: string;
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
 * 从模型回复中抽出 JSON 载荷（数组或单个对象）。
 *
 * 不能简单用 indexOf("[") / lastIndexOf("]") 切片：推理模型的思考块或前置散文里
 * 只要出现一个方括号（如「先看 items[0]」），切片就被带偏成非法 JSON，整批静默降级。
 * 逐层收窄：剥思考块 → 优先取代码围栏内容 → 扫描括号平衡的完整 JSON 片段。
 * @returns 解析后的值；抽不出返回 null
 */
function extractJsonPayload(response: string): unknown {
  // 1. 剥掉推理模型的思考块（含只有闭合标签的半截形态）
  let text = response.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const orphanClose = text.lastIndexOf("</think>");
  if (orphanClose !== -1) text = text.slice(orphanClose + "</think>".length);

  // 2. 代码围栏内的内容最可信，优先逐个尝试
  const candidates: string[] = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (m[1]) candidates.push(m[1]);
  }
  candidates.push(text);

  for (const candidate of candidates) {
    // 3. 先按整体解析（最常见的干净输出）
    const trimmed = candidate.trim();
    if (trimmed) {
      try {
        return JSON.parse(trimmed);
      } catch {
        // 落到括号扫描
      }
    }
    const scanned = scanBalancedJson(candidate);
    if (scanned !== null) return scanned;
  }
  return null;
}

/**
 * 扫描出第一个括号平衡且能解析的 JSON 片段（数组优先于对象）。
 * 逐字符跟踪深度并跳过字符串字面量，因此散文或字符串内的括号不会干扰边界判定。
 */
function scanBalancedJson(text: string): unknown {
  for (const open of ["[", "{"] as const) {
    const close = open === "[" ? "]" : "}";
    let start = text.indexOf(open);
    while (start !== -1) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i]!;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          if (inString) escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (ch === open) depth++;
        else if (ch === close) {
          depth--;
          if (depth === 0) {
            try {
              return JSON.parse(text.slice(start, i + 1));
            } catch {
              // 这个起点不成立，从下一个同类括号重试
            }
            break;
          }
        }
      }
      start = text.indexOf(open, start + 1);
    }
  }
  return null;
}

/**
 * 解析并校验 LLM 返回的分类结果。
 * 越权顶层分类、非法路径（空段/../绝对路径/分隔符逃逸）的条目降级为 `inbox/<原id>`，
 * 而非丢弃——校验失败不等于资料丢失。
 *
 * 单条批次时模型常返回裸对象 `{...}` 而非数组 `[{...}]`，这里统一裹成数组处理，
 * 否则单条归档会 100% 降级（实测 3/3）。
 */
export function parseClassifyResponse(
  response: string,
  items: readonly WikiInboxItem[],
): readonly ClassifiedItem[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const payload = extractJsonPayload(response);
  if (payload === null) return fallbackAll(items, "模型回复中未找到可解析的 JSON");

  // 裸对象裹成单元素数组；带 id 字段才算一条结果，空对象 {} 仍走整批降级
  let parsed: unknown[];
  if (Array.isArray(payload)) {
    parsed = payload;
  } else if (typeof payload === "object" && "id" in (payload as Record<string, unknown>)) {
    parsed = [payload];
  } else {
    return fallbackAll(items, "模型回复的 JSON 不是分类结果数组");
  }

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
    const allowed = valid && category && AI_WRITABLE_CATEGORIES.has(category);

    results.push({
      inboxId: item.id,
      path: allowed ? rawPath : `inbox/${item.id}`,
      title: typeof record.title === "string" && record.title ? record.title : item.title,
      summaryMd: typeof record.summaryMd === "string" ? record.summaryMd : (item.content_preview ?? ""),
      ...(allowed
        ? {}
        : { degraded: true as const, degradeReason: `分类落点不可用: ${rawPath || "(空)"}` }),
    });
  }

  // 模型漏答的条目同样不能丢：降级落 inbox/
  for (const item of items) {
    if (!seen.has(item.id)) {
      results.push({
        inboxId: item.id,
        path: `inbox/${item.id}`,
        title: item.title,
        summaryMd: item.content_preview ?? "",
        degraded: true,
        degradeReason: "模型未返回该条目的分类结果",
      });
    }
  }
  return results;
}

function fallbackAll(items: readonly WikiInboxItem[], reason: string): readonly ClassifiedItem[] {
  return items.map((item) => ({
    inboxId: item.id,
    path: `inbox/${item.id}`,
    title: item.title,
    summaryMd: item.content_preview ?? "",
    degraded: true as const,
    degradeReason: reason,
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
