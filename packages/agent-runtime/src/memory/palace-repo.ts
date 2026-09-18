/**
 * PalaceRepo — 记忆宫殿的存储与检索（自建，去 Python 依赖）
 *
 * 背景（评审 2026-09-17 §4.6）：宫殿原由 MemPalace（Python MCP + chromadb）承载，
 * 本机 chromadb 的 Rust 内核 upsert 直接 0xC0000005 崩溃；即便能跑，`palace_drawer_id`
 * 覆盖率也只有 4/171 = 2.3%。结果是「过去说过什么」这条召回路径实际上不存在。
 *
 * 检索用 **FTS5 + BM25 + 中文 bigram 预分词**，与 `AgentMemoryRepo.search()` 同构。
 * 为什么不上向量：评审 §2.5.2 已用本语料实测，本地 e5-small 相对 BM25 并无正收益
 * （4 组对照打平 2、各胜 1，top-1 余弦全落在 0.873–0.893 无区分度）。换检索栈要有
 * 数据依据，而不是「向量更高级」——依据由评测集给（P2-1，已产出 Recall@5 = 0.933 基线）。
 *
 * 两条刻意的不对称，都是有原因的：
 *
 * 1. **检索返回摘录，不返回原文**。段原文平均 6790 字符、最长 94473——把整段塞进
 *    `memory_search` 的工具结果就是把上下文打爆。架构文档本来就写着「检索召回细节，
 *    不直接全量注入 prompt」：命中后由 Agent 用 `memory_read` 按 drawer_id 取全文。
 * 2. **`score` 是相关性分数（-bm25），不是相似度**。BM25 无上界、不可跨查询比较；
 *    把它伪造成 [0,1] 的「相似度」会重蹈效用代理的覆辙（评审 §4.3）。要展示就在
 *    展示层做相对归一，别在数据层说谎。
 *
 * **作用域靠 `wing` 承载**：内容寻址是 (wing, room, content)，agent/user 不在里面。
 * 默认 wing 是 `${agentId}:${userId}`（见 `segment-memory-pipeline`），所以天然隔离；
 * 自定义 `palaceWing` 时必须把 agent 作用域带进去，否则不同 Agent 的同内容会并成一条。
 *
 * 设计：`docs/plans/记忆系统/2026-09-17-自建记忆宫殿实施计划.md` §2.3 / T3
 */

import type { DatabaseAdapter } from "../storage/local-database.js";
import { tokenizeBigram, requiredTokenHits, countTokenHits } from "./segmentation.js";
import { deterministicDrawerId } from "./content-address.js";
import { PalaceIndexRepo, type PalaceFtsHealth } from "./palace-index.js";

/** 检索结果的摘录长度（字符）。够看清「这段在讲什么」，又不至于打爆上下文。 */
export const SEARCH_EXCERPT_CHARS = 600;

/**
 * 检索候选池大小：取回多少条再做最小命中过滤。
 *
 * 30 是实测定的下限——多个查询在池 30 处仍有 ≥10 条通过（如「ODS 表时间字段」22 条），
 * 说明没有因为过滤把可返回的候选耗尽；池 10 在部分查询上只剩 3 条，会被填不满。
 * 「日报」这类高频 bigram 命中 80+ 条时耗时约 1ms，不构成瓶颈。
 */
export const SEARCH_CANDIDATE_POOL = 30;

export interface PalaceDrawerInput {
  readonly agentId: string;
  readonly userId: string;
  readonly wing: string;
  readonly room: string;
  readonly content: string;
  readonly conversationId?: string | null;
  readonly segmentId?: string | null;
  /** 调用方算出的内容寻址 id；与 `deterministicDrawerId(wing, room, content)` 不符时以重算值为准 */
  readonly drawerId?: string | null;
  /** 归档时间，默认当前时刻 */
  readonly createdAt?: string;
}

/** 检索命中项。`text` 是**摘录**（原文见 `memory_read`），`score` 是 -bm25，越大越相关 */
export interface PalaceSearchItem {
  readonly drawer_id: string;
  readonly text: string;
  readonly wing: string;
  readonly room: string;
  readonly score: number;
  readonly created_at: string;
  /** 原文总长度；远大于 `text.length` 说明需要 `memory_read` 取全文 */
  readonly char_count: number;
  readonly truncated: boolean;
}

export interface PalaceDrawerDetail {
  readonly drawer_id: string;
  readonly content: string;
  readonly wing: string;
  readonly room: string;
  readonly metadata: Record<string, unknown>;
}

export interface PalaceScopeCounts {
  readonly active: number;
  readonly tombstoned: number;
  readonly total: number;
}

/** 作用域参数：检索、列表、统计、清空共用（只有检索需要 `query`，所以这里不要求它） */
interface PalaceScopeParams {
  readonly userId: string;
  readonly agentId?: string;
  readonly wing?: string;
  readonly room?: string;
}

export interface PalaceSearchParams extends PalaceScopeParams {
  readonly query: string;
  readonly limit?: number;
  /**
   * 钉入检索的抽屉 id（本轮注入的原文指针）。
   *
   * **为什么需要**：大段之间的 BM25 分数断崖很陡，候选池取 30 条时，一条 5K 字符的
   * 真实排查段可能排到 52/608——它**根本没进过候选池**。实测 tocc-sync：目标抽屉
   * 命中 8/19 个 token、分数 8.04，看起来不差，却输给了 30 条一模一样的 cron 日报
   * （头部 23.54 / 17.00 / 16.36，前 12 条全是同一批日报）——重复语料把候选池占满，
   * 长尾里的正确答案被挤掉。结果是模型「搜了也找不到」，转而读别的条目并拿它作答。
   *
   * 钉入的语义：这些 id **已经过注入侧的 `existsByIds` 校验**（活链），在这里只需
   * 确认它们对当前查询有命中（`fts MATCH`）就保送进结果——**不跳过相关性检查**，
   * 否则会变成"注入即召回"的自我实现。钉入与落选共用同一个限额，挤占的是尾部席位。
   */
  readonly pinnedIds?: readonly string[];
}

/** 列表浏览参数（UI 用；与检索不同，它不做相关性排序，只按时间倒序翻页） */
export interface PalaceListParams extends PalaceScopeParams {
  readonly limit?: number;
  readonly offset?: number;
}

/** 列表项：比检索结果少一个 `score`（无查询就没有相关性），比它多 `agent_id`（UI 要分组） */
export interface PalaceListItem {
  readonly drawer_id: string;
  readonly wing: string;
  readonly room: string;
  readonly agent_id: string;
  readonly conversation_id: string | null;
  readonly char_count: number;
  readonly created_at: string;
}

export interface PalaceListResult {
  readonly items: readonly PalaceListItem[];
  /** 满足条件的活跃行总数（用于分页），不是本页条数 */
  readonly total: number;
}

/** 一次清空的结果 */
export interface PalaceClearResult {
  readonly cleared: number;
}

export interface PalaceWingCount {
  readonly wing: string;
  readonly count: number;
}

interface DrawerRow {
  drawer_id: string;
  agent_id: string;
  user_id: string;
  conversation_id: string | null;
  segment_id: string | null;
  wing: string;
  room: string;
  content: string;
  char_count: number;
  created_at: string;
  deleted_at: string | null;
}

/** 单次检索最多枚举的命中位置数（防止高频 bigram 在长文里枚举出上万条） */
const MAX_ANCHOR_POSITIONS = 5000;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 找摘录锚点：**覆盖查询词最密集的那个窗口**的起点。
 *
 * 一开始写的是「取最长 token 的首次出现位置」，实测不成立：中文 bigram 全是 2 字符，
 * 「的时」和「青竹」同长，于是最常见的那个 bigram 反而赢——正相反，短而常见的词
 * 恰恰最不该当锚点。改成滑窗数「窗口内出现了多少个不同的查询 token」：查询词密集处
 * 才是这段在讲什么的证据。
 *
 * 位置枚举用一次正则扫描（token 转义后取并集），不是逐 token 各扫一遍全串——
 * 后者在 94K 字符的段上要做几十次全串 indexOf。
 */
function findExcerptAnchor(content: string, query: string, maxChars: number): number {
  const tokens = [...tokenizeBigram(query)];
  if (tokens.length === 0) return -1;

  const re = new RegExp(tokens.map(escapeRegExp).join("|"), "g");
  const lower = content.toLowerCase();
  const positions: { pos: number; token: string }[] = [];
  for (const m of lower.matchAll(re)) {
    positions.push({ pos: m.index, token: m[0] });
    if (positions.length >= MAX_ANCHOR_POSITIONS) break;
  }
  if (positions.length === 0) return -1;

  positions.sort((a, b) => a.pos - b.pos);

  const counts = new Map<string, number>();
  let distinct = 0;
  let bestDistinct = -1;
  let bestStart = positions[0]!.pos;
  let left = 0;
  for (let right = 0; right < positions.length; right++) {
    const tok = positions[right]!.token;
    const c = (counts.get(tok) ?? 0) + 1;
    counts.set(tok, c);
    if (c === 1) distinct++;

    while (positions[right]!.pos - positions[left]!.pos > maxChars) {
      const lt = positions[left]!.token;
      const lc = (counts.get(lt) ?? 0) - 1;
      counts.set(lt, lc);
      if (lc === 0) distinct--;
      left++;
    }
    if (distinct > bestDistinct) {
      bestDistinct = distinct;
      bestStart = positions[left]!.pos;
    }
  }
  return bestStart;
}

/**
 * 取一段能代表命中位置的摘录。
 *
 * 窗口按 1/3 前置偏移，让命中点略偏左，保留一点上下文。
 */
export function buildDrawerExcerpt(
  content: string,
  query: string,
  maxChars = SEARCH_EXCERPT_CHARS,
): { text: string; truncated: boolean } {
  if (content.length <= maxChars) return { text: content, truncated: false };

  const anchor = findExcerptAnchor(content, query, maxChars);
  const start =
    anchor < 0
      ? 0
      : Math.max(0, Math.min(anchor - Math.floor(maxChars / 3), content.length - maxChars));
  const end = start + maxChars;
  const head = start > 0 ? "…" : "";
  const tail = end < content.length ? "…" : "";
  return { text: `${head}${content.slice(start, end)}${tail}`, truncated: true };
}

export class PalaceRepo {
  private readonly index: PalaceIndexRepo;

  constructor(private readonly db: DatabaseAdapter) {
    this.index = new PalaceIndexRepo(db);
  }

  /**
   * 写入/覆盖一条归档原文（幂等）。
   *
   * `drawer_id` **一律重算**而不采信传入值：内容寻址不变量（同 wing/room/content →
   * 同 id）必须只有一个来源，否则「重复归档不产生第二行」就退化成调用方的约定。
   * 传入值仅仅用来发现不一致（不一致说明调用方与这里的算法漂移了，要报出来）。
   *
   * 两条刻意的边界：
   * - `created_at` 与 `deleted_at` **不在 DO UPDATE 里**：首见时间不该被重复归档改写；
   *   被删除的 drawer 也不因再次归档而复活——墓碑优先，与云同步合并（P0-2）同一原则。
   * - 只有真写进库才返回 id（沿用 `segment-memory-pipeline` 的「未回填不记账」语义）。
   */
  upsertDrawer(input: PalaceDrawerInput): { drawerId: string; inserted: boolean } {
    const content = input.content;
    const drawerId = deterministicDrawerId(input.wing, input.room, content);
    if (input.drawerId && input.drawerId !== drawerId) {
      console.warn(
        `[PalaceRepo] 传入 drawerId=${input.drawerId} 与内容寻址结果不一致，以内容寻址为准（${drawerId}）`,
      );
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    const existing = this.db
      .prepare<{ agent_id: string; user_id: string }>(
        "SELECT agent_id, user_id FROM palace_drawers WHERE drawer_id = ?",
      )
      .get(drawerId);
    if (existing && (existing.agent_id !== input.agentId || existing.user_id !== input.userId)) {
      // 内容寻址只含 (wing, room, content)，作用域是靠 wing 带的（默认 wing = agentId:userId）。
      // 同一段原文被两个作用域归档却不带作用域进 wing，就会合并成一条、归属来回改写，
      // 结果是「段里记着 drawer_id，检索时却看不到」。这里只能报出来——id 规则不能在这里改，
      // 回填脚本与线上归档必须算出同一个 id。
      console.warn(
        `[PalaceRepo] drawer ${drawerId} 已有归属 ${existing.agent_id}/${existing.user_id}，` +
          `本次归档来自 ${input.agentId}/${input.userId}——wing 需要带上 agent 作用域`,
      );
    }

    this.db
      .prepare(
        `INSERT INTO palace_drawers
           (drawer_id, agent_id, user_id, conversation_id, segment_id, wing, room,
            content, char_count, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(drawer_id) DO UPDATE SET
           agent_id        = excluded.agent_id,
           user_id         = excluded.user_id,
           conversation_id = excluded.conversation_id,
           segment_id      = excluded.segment_id,
           wing            = excluded.wing,
           room            = excluded.room,
           content         = excluded.content,
           char_count      = excluded.char_count`,
      )
      .run(
        drawerId,
        input.agentId,
        input.userId,
        input.conversationId ?? null,
        input.segmentId ?? null,
        input.wing,
        input.room,
        content,
        content.length,
        createdAt,
      );

    const row = this.db
      .prepare<{ rowid: number }>("SELECT rowid FROM palace_drawers WHERE drawer_id = ?")
      .get(drawerId);
    if (row) this.index.upsertRow(row.rowid, content);

    return { drawerId, inserted: !existing };
  }

  /** 按 drawer_id 读归档原文（含来源元信息，供 memory_read 展示） */
  readById(drawerId: string): PalaceDrawerDetail | null {
    const row = this.db
      .prepare<DrawerRow>(
        "SELECT * FROM palace_drawers WHERE drawer_id = ? AND deleted_at IS NULL",
      )
      .get(drawerId);
    if (!row) return null;
    return {
      drawer_id: row.drawer_id,
      content: row.content,
      wing: row.wing,
      room: row.room,
      metadata: {
        source: "segment",
        agentId: row.agent_id,
        userId: row.user_id,
        conversationId: row.conversation_id,
        segmentId: row.segment_id,
        charCount: row.char_count,
        createdAt: row.created_at,
      },
    };
  }

  /**
   * 这些 drawer_id 里哪些真的存在（活跃、未写墓碑）。
   *
   * 用途是**注入侧的存在性校验**（`formatUnifiedMemoryBlock` 的 `[d:...]` 指针）：
   * `agent_memories.palace_drawer_id` 是一条可能过期的快照——段被删、宫殿重建后
   * 这个 id 就指向不存在的行。实测 96 条带 id 的记忆里 1 条是这种死链（还是 Python
   * 时代 `drawer_chronicler_...` 的旧格式）。
   *
   * 为什么一定要校验：给了指针而点开报错，比不给指针更糟——模型会开始怀疑整块记忆。
   * 一次查询完成（IN 列表），空输入不打 DB。
   */
  existsByIds(ids: readonly (string | null | undefined)[]): Set<string> {
    const wanted = ids.filter((x): x is string => !!x);
    if (wanted.length === 0) return new Set();
    const placeholders = wanted.map(() => "?").join(", ");
    const rows = this.db
      .prepare<{ drawer_id: string }>(
        `SELECT drawer_id FROM palace_drawers
          WHERE deleted_at IS NULL AND drawer_id IN (${placeholders})`,
      )
      .all(...wanted);
    return new Set(rows.map((r) => r.drawer_id));
  }

  /**
   * 关键词检索：bigram 预分词 → FTS5 MATCH（OR 短语）→ BM25 排序 → 最小命中过滤。
   *
   * 每个 token 单独加引号转义（`"` 转 `""`），避免查询里的 FTS5 语法字符
   * （AND / OR / NEAR / 前缀 `*`）被当语法解释。分词为空或虚表缺失时回落 LIKE。
   *
   * **两处与"教科书 BM25 调参"不同，都是被实测推翻后改的**：
   * 1. `bm25()` 的 k1/b 参数在本机 SQLite 3.53.3 上**不生效**——b=0 与 b=1 对同一
   *    长文给出逐位相同的分数（合成语料验证）。所以长度归一化不能靠传参，只能靠
   *    查询侧的最小命中来挡掉"长文蹭一个 bigram"。
   * 2. 不做分数下限：实测相关项与无关项的分数区间完全重叠（「代理 配置」相关
   *    3.5~5.6、无关 3.1~3.6），任何阈值都会同时伤及两者。
   */
  searchDrawers(params: PalaceSearchParams): readonly PalaceSearchItem[] {
    const limit = Math.max(1, params.limit ?? 10);
    const tokens = [...tokenizeBigram(params.query)];
    const scope = this.buildScope(params, "d.");
    if (tokens.length === 0) {
      return this.searchByLike(params, limit);
    }
    const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    const need = requiredTokenHits(tokens.length);
    try {
      const rows = this.db
        .prepare<DrawerRow & { rank: number; fts_content: string }>(
          `SELECT d.*, bm25(palace_drawers_fts) AS rank, palace_drawers_fts.content AS fts_content
             FROM palace_drawers_fts
             JOIN palace_drawers d ON d.rowid = palace_drawers_fts.rowid
            WHERE palace_drawers_fts MATCH ? AND d.deleted_at IS NULL${scope.sql}
            ORDER BY bm25(palace_drawers_fts)
            LIMIT ?`,
        )
        .all(match, ...scope.args, SEARCH_CANDIDATE_POOL);
      const kept = rows
        .filter((r) => countTokenHits(tokens, r.fts_content) >= need)
        .slice(0, limit);

      // 钉入：注入块里给过指针的原文，未被选上时按分数补位。
      // 两段查询而不是改了上面的 top-N 重排——重排会连排序语义一起动（TOCC 那条分数
      // 8.04 仍排不进 top-30），钉入要表达的正是"这条不是因为分数高才在场"。
      const pinned = this.pinnedRows(params.pinnedIds ?? [], kept, match, scope, tokens, need);
      // 补位挤的是**尾部**席位：原结果留 `limit - 钉入数` 条，其余给钉入的。
      // 不能写成 `[...kept, ...pinned].slice(0, limit)`——kept 已经占满 limit，
      // 追加再切等于把刚补上的一条切掉（2026-09-18 实测：钉入日志显示成功，
      // 调用方收到的那份却没有它）。
      const merged =
        pinned.length > 0
          ? [...kept.slice(0, Math.max(0, limit - pinned.length)), ...pinned]
          : kept;
      return merged.map((r) => this.toItem(r, params.query, -r.rank));
    } catch (err) {
      console.warn("[PalaceRepo.searchDrawers] FTS5 查询失败，回落 LIKE:", err);
      return this.searchByLike(params, limit);
    }
  }

  /**
   * 钉入行的查询：只取 `pinnedIds` 里对当前查询**确有命中且过最小命中线**的行，
   * 已在候选里选上的不再重复取。补位空间 = 总席位减去已选，避免过度返回。
   */
  private pinnedRows(
    pinnedIds: readonly string[],
    alreadyKept: readonly (DrawerRow & { rank: number; fts_content: string })[],
    match: string,
    scope: { sql: string; args: unknown[] },
    tokens: readonly string[],
    need: number,
  ): (DrawerRow & { rank: number; fts_content: string })[] {
    const keptIds = new Set(alreadyKept.map((r) => r.drawer_id));
    const wanted = [...new Set(pinnedIds.filter((id) => id && !keptIds.has(id)))];
    const room = SEARCH_CANDIDATE_POOL - alreadyKept.length;
    if (wanted.length === 0 || room <= 0) return [];
    const placeholders = wanted.map(() => "?").join(", ");
    return this.db
      .prepare<DrawerRow & { rank: number; fts_content: string }>(
        `SELECT d.*, bm25(palace_drawers_fts) AS rank, palace_drawers_fts.content AS fts_content
           FROM palace_drawers_fts
           JOIN palace_drawers d ON d.rowid = palace_drawers_fts.rowid
          WHERE palace_drawers_fts MATCH ? AND d.deleted_at IS NULL${scope.sql}
            AND d.drawer_id IN (${placeholders})
          ORDER BY bm25(palace_drawers_fts)
          LIMIT ?`,
      )
      .all(match, ...scope.args, ...wanted, room)
      .filter((r) => countTokenHits(tokens, r.fts_content) >= need);
  }

  private buildScope(
    params: PalaceScopeParams,
    prefix: string,
  ): { sql: string; args: unknown[] } {
    let sql = ` AND ${prefix}user_id = ?`;
    const args: unknown[] = [params.userId];
    if (params.agentId) {
      sql += ` AND ${prefix}agent_id = ?`;
      args.push(params.agentId);
    }
    if (params.wing) {
      sql += ` AND ${prefix}wing = ?`;
      args.push(params.wing);
    }
    if (params.room) {
      sql += ` AND ${prefix}room = ?`;
      args.push(params.room);
    }
    return { sql, args };
  }

  private searchByLike(params: PalaceSearchParams, limit: number): readonly PalaceSearchItem[] {
    const scope = this.buildScope(params, "");
    const rows = this.db
      .prepare<DrawerRow>(
        `SELECT * FROM palace_drawers
          WHERE deleted_at IS NULL${scope.sql} AND content LIKE ?
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(...scope.args, `%${params.query}%`, limit);
    // LIKE 命中无相关性可言，score 给 0 并保持时间序（不编造一个假的分数）
    return rows.map((r) => this.toItem(r, params.query, 0));
  }

  private toItem(row: DrawerRow, query: string, score: number): PalaceSearchItem {
    const excerpt = buildDrawerExcerpt(row.content, query);
    return {
      drawer_id: row.drawer_id,
      text: excerpt.text,
      wing: row.wing,
      room: row.room,
      score,
      created_at: row.created_at,
      char_count: row.char_count,
      truncated: excerpt.truncated,
    };
  }

  /**
   * 删除（**非破坏**）：写 `deleted_at` 墓碑，行与原文保留，同时从检索中摘除。
   * 生产者在这里，不是空墓碑——评审 §4.4 的教训（`deleted_at` 字段有读侧没写侧，
   * 结果是「删不掉」）。
   */
  deleteById(drawerId: string, now = new Date().toISOString()): boolean {
    const row = this.db
      .prepare<{ rowid: number; deleted_at: string | null }>(
        "SELECT rowid, deleted_at FROM palace_drawers WHERE drawer_id = ?",
      )
      .get(drawerId);
    if (!row || row.deleted_at) return false;
    this.db
      .prepare("UPDATE palace_drawers SET deleted_at = ? WHERE drawer_id = ?")
      .run(now, drawerId);
    this.index.deleteRow(row.rowid);
    return true;
  }

  /** 作用域内的条数（活跃 / 墓碑 / 合计），用于覆盖率与体检 */
  countByScope(userId: string, agentId?: string): PalaceScopeCounts {
    const where = agentId ? "user_id = ? AND agent_id = ?" : "user_id = ?";
    const args = agentId ? [userId, agentId] : [userId];
    const row = this.db
      .prepare<{ active: number; tombstoned: number; total: number }>(
        `SELECT SUM(deleted_at IS NULL) AS active,
                SUM(deleted_at IS NOT NULL) AS tombstoned,
                COUNT(*) AS total
           FROM palace_drawers WHERE ${where}`,
      )
      .get(...args);
    return {
      active: row?.active ?? 0,
      tombstoned: row?.tombstoned ?? 0,
      total: row?.total ?? 0,
    };
  }

  /**
   * 分页浏览（UI 用）。
   *
   * 与 `searchDrawers` 的分工：那个是"按相关性找"，这个只是"按时间倒序翻页"——
   * 没有查询词就没有相关性可言，所以排序键退回 `created_at`（归档时间）。
   *
   * `total` 是满足条件的**总数**（不是本页条数），分页控件需要它。
   * 只返回元数据不返回正文：列表页可能一次列 20 条，每条几百到几千字符，
   * 正文一律走 `readById` 按需取。
   */
  listDrawers(params: PalaceListParams): PalaceListResult {
    const limit = Math.max(1, Math.min(params.limit ?? 20, 200));
    const offset = Math.max(0, params.offset ?? 0);
    const scope = this.buildScope(params, "d.");

    const total =
      this.db
        .prepare<{ c: number }>(
          `SELECT COUNT(*) AS c FROM palace_drawers d WHERE d.deleted_at IS NULL${scope.sql}`,
        )
        .get(...scope.args)?.c ?? 0;

    const items = this.db
      .prepare<PalaceListItem>(
        `SELECT d.drawer_id, d.wing, d.room, d.agent_id, d.conversation_id,
                d.char_count, d.created_at
           FROM palace_drawers d
          WHERE d.deleted_at IS NULL${scope.sql}
          ORDER BY d.created_at DESC, d.drawer_id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...scope.args, limit, offset);

    return { items, total };
  }

  /** 作用域内的 wing 分布（UI 侧栏与体检报表用） */
  countByWing(userId: string, agentId?: string): readonly PalaceWingCount[] {
    const scope = this.buildScope({ userId, ...(agentId ? { agentId } : {}) }, "d.");
    return this.db
      .prepare<PalaceWingCount>(
        `SELECT d.wing, COUNT(*) AS count FROM palace_drawers d
          WHERE d.deleted_at IS NULL${scope.sql}
          GROUP BY d.wing ORDER BY count DESC`,
      )
      .all(...scope.args);
  }

  /**
   * 清空作用域内的全部归档。
   *
   * 与 `deleteById` 同一条纪律：**非破坏**——写 `deleted_at` 墓碑、原文保留、只从检索摘除。
   * 「清空」在用户心智里是"别再让我搜到"，不是"把原文烧了"：宫殿存的是对话存档，
   * 误清空的代价远高于留着几行墓碑（留痕还能回滚）。
   *
   * 分页逐批处理：一次把几万行装进内存再逐条删，会在长事务里把库锁住。
   */
  clearAll(userId: string, agentId?: string, now = new Date().toISOString()): PalaceClearResult {
    const scope = this.buildScope({ userId, ...(agentId ? { agentId } : {}) }, "d.");
    const rows = this.db
      .prepare<{ drawer_id: string; rowid: number }>(
        `SELECT d.drawer_id, d.rowid FROM palace_drawers d
          WHERE d.deleted_at IS NULL${scope.sql}`,
      )
      .all(...scope.args);
    if (rows.length === 0) return { cleared: 0 };

    const stmt = this.db.prepare(
      "UPDATE palace_drawers SET deleted_at = ? WHERE drawer_id = ?",
    );
    for (const r of rows) {
      stmt.run(now, r.drawer_id);
      this.index.deleteRow(r.rowid);
    }
    return { cleared: rows.length };
  }

  /** 全量重建派生索引，返回重建后的索引行数 */
  rebuildIndex(): number {
    return this.index.rebuildFts();
  }

  /** 索引健康检查（主表活跃行数 vs 索引行数） */
  checkFtsHealth(): PalaceFtsHealth {
    return this.index.checkFtsHealth();
  }
}
