/**
 * 个人记忆条目化（V48 之后 · 评审 §3.2 方案 B）
 *
 * 问题：`user-memory.md` 是一个纯 Markdown 文档，每次整理都由 LLM **全量重写**。
 * 于是每条记忆没有身份、没有时间、无法被单独引用或失效——文档级重写正是评审
 * 反模式 #2「用递归摘要替代原始记录」在个人记忆上的形态。
 *
 * 本模块把每一条变成**带身份与时间戳的条目**，且结构字段由 harness 独占：
 *
 * ```markdown
 * ## 交互偏好
 * - 规则：生图必须调用 image_generate <!--m:9f2a1c 2026-09-17-->
 * ```
 *
 * - `id` / `created_at` 写在 HTML 注释里：Markdown 渲染看不见、不干扰人读，
 *   模型照抄整行时元数据自然保留。
 * - **模型改不动结构字段**：改写后的文本若与某条旧条目一致，harness 会把旧的
 *   id/时间戳**还原回去**（模型写错的值被覆盖，而不是抛错——整理流程不该因为
 *   模型多写了几个字符就整体失败）。
 * - 新增的文本获得新 id 与当天时间；消失的文本视为删除（整理允许删除，
 *   但会被计数，供观察整理是否在吞内容）。
 *
 * 设计取舍：为什么不用 sidecar JSON——sidecar 与正文会在每次 LLM 重写后失配
 * （行的哈希变了），而内联元数据随行移动，重写后还能对上。
 */

/** 单条个人记忆 */
export interface PersonalMemoryEntry {
  /** harness 分配，16 位 hex（内容无关，随条目生命周期稳定） */
  readonly id: string;
  /** ISO 日期（YYYY-MM-DD），条目首次写入的日期 */
  readonly createdAt: string;
  /** 该条目所属的 `## ` 章节标题（无章节时为空串） */
  readonly heading: string;
  /** 正文（不含行首 `- ` 与元数据注释） */
  readonly text: string;
}

/** 元数据注释：`<!--m:<id> <YYYY-MM-DD>-->` */
const META_RE = /\s*<!--m:([0-9a-f]{4,32})\s+(\d{4}-\d{2}-\d{2})-->\s*$/;
const META_STRIP_RE = /\s*<!--m:[0-9a-f]{4,32}\s+\d{4}-\d{2}-\d{2}-->\s*$/;
const BULLET_RE = /^\s*[-*]\s+(.*)$/;
const HEADING_RE = /^\s*##\s+(.+?)\s*$/;

/** 生成条目 id（与记忆 id 同风格的随机 hex，不依赖 DB） */
function newEntryId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 今天（本地日，与用户视角一致） */
function today(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 解析个人记忆文档为条目列表。
 * 非条目的行（标题、空行、正文段落）原样保留在 `passthrough` 中，由 `render` 还原。
 */
export function parsePersonalMemory(content: string): {
  readonly entries: readonly PersonalMemoryEntry[];
  readonly headings: readonly string[];
} {
  const entries: PersonalMemoryEntry[] = [];
  const headings: string[] = [];
  let heading = "";
  for (const line of content.split(/\r?\n/)) {
    const h = line.match(HEADING_RE);
    if (h) {
      heading = h[1]!;
      headings.push(heading);
      continue;
    }
    const b = line.match(BULLET_RE);
    if (!b) continue;
    const raw = b[1]!;
    const meta = raw.match(META_RE);
    entries.push({
      id: meta?.[1] ?? "",
      createdAt: meta?.[2] ?? "",
      heading,
      text: raw.replace(META_STRIP_RE, "").trim(),
    });
  }
  return { entries, headings };
}

/** 给一条正文渲染出带元数据的行 */
function renderEntryLine(entry: PersonalMemoryEntry): string {
  return `- ${entry.text} <!--m:${entry.id} ${entry.createdAt}-->`;
}

/**
 * 把（可能被模型重写过的）新文档与旧条目对账，产出**结构字段由 harness 独占**的最终文档。
 *
 * 规则：
 * - 新文档里某条正文与旧条目一致 → 沿用旧的 id 与 createdAt（模型写错的值被覆盖）；
 *   旧条目本就没有元数据（迁移前的存量）时**补发**一个新身份
 * - 新文档里某条正文是新的 → 分配新 id 与 `now` 日期
 * - 旧条目在新文档里消失 → 视为删除，计入 `removed`
 *
 * 计数语义：`kept` 是「正文被保留下来的条数」（无论之前有没有身份），`added` 是
 * 「模型新引入的正文条数」——调用方关心的是**整理是否在吞内容**，而不是身份发放。
 *
 * @returns 最终 Markdown 与变动统计（供日志观察「整理是否在吞内容」）
 */
export function reconcilePersonalMemory(
  nextMarkdown: string,
  previousContent: string,
  now: Date = new Date(),
): {
  readonly content: string;
  readonly added: number;
  readonly removed: number;
  readonly kept: number;
} {
  const prevByText = new Map<string, PersonalMemoryEntry>();
  for (const e of parsePersonalMemory(previousContent).entries) {
    // 旧文档没有元数据的条目（迁移前的存量）也进对账表，首次对账时补上身份
    if (!prevByText.has(e.text)) prevByText.set(e.text, e);
  }

  const date = today(now);
  const out: string[] = [];
  const seen = new Set<string>();
  let added = 0;
  let kept = 0;

  for (const line of nextMarkdown.split(/\r?\n/)) {
    const b = line.match(BULLET_RE);
    if (!b) {
      out.push(line);
      continue;
    }
    const text = b[1]!.replace(META_STRIP_RE, "").trim();
    const prev = prevByText.get(text);
    seen.add(text);
    if (prev) {
      kept++;
      // 有身份就沿用；没有（存量条目）就补发——同一次对账里补发的身份也是稳定的
      out.push(
        renderEntryLine({
          id: prev.id || newEntryId(),
          createdAt: prev.createdAt || date,
          heading: prev.heading,
          text,
        }),
      );
    } else {
      added++;
      out.push(renderEntryLine({ id: newEntryId(), createdAt: date, heading: "", text }));
    }
  }

  let removed = 0;
  for (const [text] of prevByText) {
    if (!seen.has(text)) removed++;
  }

  return { content: out.join("\n"), added, removed, kept };
}

/**
 * 剥掉元数据注释，得到注入 prompt 用的干净文本。
 * 模型不需要看到 id 与时间戳——它们只服务于 harness 的记账。
 */
export function stripPersonalMemoryMeta(content: string): string {
  return content
    .split(/\r?\n/)
    .map((l) => l.replace(META_STRIP_RE, ""))
    .join("\n");
}
