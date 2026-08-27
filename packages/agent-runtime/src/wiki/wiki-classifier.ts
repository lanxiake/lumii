/**
 * WikiClassifier — 批量分类决策与提示词构造
 *
 * 范式同 memory-extractor.ts：callLLM 依赖注入，纯函数提示词构造与 JSON 解析。
 * 分类轴是「用途」（做事记录/学习资料/…），只能从当前主题树里选节点；
 * 拿不准、越权、模型漏答统一 skip/degraded，条目留待整理，不臆造分类、不写「临时存放」。
 *
 * 设计：docs/design/记忆设计/2026-08-27-wiki-topic-hierarchy-redesign.md §3
 */

import type { WikiInboxItem } from "./types.js";
import { validateTopicAssignment, type WikiTopicTree } from "./wiki-topic-tree.js";

/** 单条分类结果：category/subtopic 为 null 表示未归类（skip 或校验失败） */
export interface ClassifiedItem {
  readonly inboxId: string;
  readonly category: string | null;
  readonly subtopic: string | null;
  /** 模型主动判定无法归类 */
  readonly skip?: boolean;
  /** skip 原因（模型给出） */
  readonly reason?: string;
  /**
   * 该条最终是否未能归类（skip / 越权 / 模型漏答 / 调用失败）。
   * degraded 时 category/subtopic 均为 null，调用方不得写入 wiki_sources 主题。
   */
  readonly degraded?: true;
  /** 降级原因，用于运行日志与排查 */
  readonly degradeReason?: string;
}

/**
 * 构造批量分类提示词：口诀 + 易混 + 当前主题树可选目录 + 待整理资料 + 输出格式。
 * 批大小由调用方（WikiOrganizer）按内容长度动态收缩，此处只负责构造单批的提示词。
 */
export function buildClassifyPrompt(items: readonly WikiInboxItem[], topicTree: WikiTopicTree): string {
  const list = items
    .map(
      (item, i) =>
        `${i + 1}. [id=${item.id}] 标题: ${item.title}\n内容预览: ${(item.content_preview ?? "").slice(0, 300)}`,
    )
    .join("\n\n");

  const treeLines = topicTree.categories
    .map((c) => `- ${c.name}：${c.subtopics.join("、")}`)
    .join("\n");

  return [
    "你是个人资料归档助手。按「文件拿来干什么」分类，不要按学科领域分类。",
    "",
    "## 口诀",
    "- 事情做完留下的结果 → 做事记录",
    "- 用来学习吸收知识 → 学习资料",
    "- 打算做什么、做完反思 → 计划与复盘",
    "- 可以当证据凭证 → 证件凭据",
    "- 拿来复制修改参考 → 模板参考",
    "- 自己随心写的爱好作品 → 随笔创作",
    "",
    "## 易混",
    "- 填好的计划/预算 → 计划与复盘；空白模板 → 模板参考",
    "- 项目交付与会议纪要文件 → 做事记录；教材/摘抄/调研 → 学习资料",
    "- 合同/证件/发票/保单 → 证件凭据",
    "- 用户上传的会议纪要、聊天导出 → 做事记录 / 会议聊天记录",
    "- 对话消息本身不要归档（本批若像聊天记录而无文件用途，输出 skip）",
    "",
    "## 可选目录（只能从这里选，禁止自造大类或小类）",
    treeLines,
    "",
    "## 规则",
    "- 一份资料只归一个大类+小类",
    "- 没有合适项时 category、subtopic 留空，skip=true，reason 说明",
    "- 只能使用上方目录列出的名称，不要发明新目录或使用「其他」「未分类」等占位词",
    "",
    "## 待整理资料",
    list,
    "",
    "## 输出",
    '仅 JSON 数组: {"id":"<inboxId>","category":"<大类或空>","subtopic":"<小类或空>","skip":false,"reason":""}',
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
export function extractJsonPayload(response: string): unknown {
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
 * category/subtopic 必须精确匹配当前主题树（不含临时存放），否则连同 skip=true
 * 一起判定为 degraded：不写 wiki_sources 主题，条目留待整理，而非臆造/降级到某个兜底目录。
 *
 * 单条批次时模型常返回裸对象 `{...}` 而非数组 `[{...}]`，这里统一裹成数组处理，
 * 否则单条归档会 100% 降级（实测 3/3）。
 */
export function parseClassifyResponse(
  response: string,
  items: readonly WikiInboxItem[],
  topicTree: WikiTopicTree,
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

    if (record.skip === true) {
      results.push({
        inboxId: item.id,
        category: null,
        subtopic: null,
        skip: true,
        ...(typeof record.reason === "string" && record.reason ? { reason: record.reason } : {}),
        degraded: true,
        degradeReason: typeof record.reason === "string" && record.reason ? record.reason : "模型判定无法归类",
      });
      continue;
    }

    const category = typeof record.category === "string" && record.category ? record.category : null;
    const subtopic = typeof record.subtopic === "string" && record.subtopic ? record.subtopic : null;
    const valid = category !== null && validateTopicAssignment(topicTree, category, subtopic).ok;

    if (!valid) {
      results.push({
        inboxId: item.id,
        category: null,
        subtopic: null,
        degraded: true,
        degradeReason: `分类不在当前主题树内: ${category ?? "(空)"} / ${subtopic ?? "(空)"}`,
      });
      continue;
    }

    results.push({ inboxId: item.id, category, subtopic });
  }

  // 模型漏答的条目同样不能丢：标记待整理，不臆造分类
  for (const item of items) {
    if (!seen.has(item.id)) {
      results.push({
        inboxId: item.id,
        category: null,
        subtopic: null,
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
    category: null,
    subtopic: null,
    degraded: true as const,
    degradeReason: reason,
  }));
}

/**
 * 批量分类：调用一次 LLM 处理一批条目。LLM 调用失败向上抛错（调用方记 attempt_count，
 * 交由退避重试），分类阶段本身的解析/校验失败则走 degraded，不丢数据也不臆造分类。
 */
export async function classifyBatch(
  items: readonly WikiInboxItem[],
  callLLM: (prompt: string) => Promise<string>,
  topicTree: WikiTopicTree,
): Promise<readonly ClassifiedItem[]> {
  if (items.length === 0) return [];
  try {
    const response = await callLLM(buildClassifyPrompt(items, topicTree));
    return parseClassifyResponse(response, items, topicTree);
  } catch (err) {
    // 保留原始原因，否则退避重试时无从判断是模型不可用还是网络问题
    throw new Error(`wiki classify batch failed: ${(err as Error).message}`);
  }
}
