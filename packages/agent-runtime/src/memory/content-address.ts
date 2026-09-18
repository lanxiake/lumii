/**
 * 内容寻址 ID（记忆系统升级阶段一 · P2）
 *
 * 由 TS 侧确定性生成 drawer_id，交给宫殿后端做幂等 upsert：
 * 同一 (wing, room, content) 重复归档 → 同一 ID → 不产生重复。
 * 后端自 2026-09-17 起是本机 SQLite（`palace_drawers`），此前是 MemPalace（Python）。
 *
 * 与阶段二 OpenHuman 的内容寻址 chunk ID 体系一致（sha256 截断 hex），
 * 现在一次到位，避免后续返工。
 *
 * 参考 OpenHuman `chunks/types.rs`：id = sha256(parts join "\0")，截断 hex。
 */

import { createHash } from "node:crypto";

/** 内容寻址 ID 默认截断长度（hex 字符数）。阶段一 drawer 用 16，阶段二 chunk 用 32。 */
export const DRAWER_ID_HEX_LEN = 16;

/**
 * 用 NUL 分隔的多段拼接做 sha256，截断为 hex 前缀。
 * NUL 分隔避免 ("ab","c") 与 ("a","bc") 碰撞。
 */
export function contentAddressId(parts: readonly string[], hexLen = DRAWER_ID_HEX_LEN): string {
  const hash = createHash("sha256");
  hash.update(parts.join("\0"), "utf8");
  return hash.digest("hex").slice(0, hexLen);
}

/**
 * 段原文归档进记忆宫殿的确定性 drawer_id。
 * 以 (wing, room, content) 寻址：同一段原文重复归档得稳定 ID，天然防重。
 *
 * **注意作用域**：agent/user 不在寻址里，靠 wing 带（默认 wing = `${agentId}:${userId}`）。
 * 自定义 wing 时必须把 agent 作用域带进去，否则不同 Agent 的同内容会并成一条。
 */
export function deterministicDrawerId(wing: string, room: string, content: string): string {
  return contentAddressId([wing, room, content]);
}

/** 注入块里的原文指针前缀，形如 `[d:9e87df013c4e671a] ` */
const POINTER_RE = /^\[d:[0-9a-f]{1,64}\]\s/;

/** 去掉内容开头的原文指针（去重、展示等"只看内容本身"的场景用） */
export function stripDrawerPointer(content: string): string {
  return content.replace(POINTER_RE, "");
}

/** 内容开头是否带原文指针 */
export function hasDrawerPointer(content: string): boolean {
  return POINTER_RE.test(content);
}

/**
 * 取出内容开头的原文指针里的 drawer_id；没有则 null。
 *
 * 与 `stripDrawerPointer` 是同一件事的两面：写侧存、读侧用。`POINTER_RE` 是模块内
 * 私有的，所以取 id 必须走这里——两处各写一份正则，改格式时会漏改一处。
 */
export function drawerPointerId(content: string): string | null {
  const m = POINTER_RE.exec(content);
  return m ? m[0].slice(3, -2) : null;
}

/**
 * 给记忆条目加原文指针前缀。
 *
 * **为什么在写入时钉进 content、而不是注入时拼**：
 * 1. 指针随之成为内容的一部分，`mergeCandidates` 的去重与 `updateMergedFields` 的
 *    来源补填都会自然带上它——注入侧不需要知道 `palace_drawer_id` 这回事。
 * 2. 记忆的 `content` 本就是**给模型看的展现**，不是解析对象（要机器可读的字段有
 *    `id`/`category`/`agent_id` 那些）。
 *
 * 合并（`writeCandidatesMerged`）会把既有条目的摘要内容并进新候选，于是前缀可能
 * 出现两次——本函数按**最左**那个保留，右侧残留的当场清掉。生成侧收紧（提示词
 * 要求保留行首指针）减少发生频率，这里是兜底。
 *
 * **去重键必须先 strip**（见 `merge.ts` 的 `normalizeKey`）：指针里是机器生成的
 * hex，它会随着原文归档与否而变。不剥掉的话，同一件事「有指针」与「无指针」两个
 * 版本会算出不同的键，去重整体失效——每次提取都新增一条。
 */
export function withDrawerPointer(content: string, drawerId: string | null | undefined): string {
  if (!drawerId) return stripDrawerPointer(content);
  const trimmed = stripDrawerPointer(content).trimStart();
  return `[d:${drawerId}] ${trimmed}`;
}
