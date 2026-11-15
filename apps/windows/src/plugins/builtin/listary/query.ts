/**
 * 检索 — 预分词 → 转义 → FTS5 MATCH → 最小命中过滤 → 降级。
 *
 * 设计：`docs/design/逆向与复刻/2026-11-14-Listary复刻启动器插件设计.md` §6.3
 *
 * 三个必须照做的点（都有实证依据）：
 *
 * 1. **查询必须逐 token 加引号转义**。用户输入会含 `"` `*` `(` `)` `AND` `NEAR` 等
 *    FTS5 语法字符，不转义轻则报错、重则变成越权 OR 查询。写法对齐
 *    `palace-repo.ts` 的 `searchDrawers`。
 * 2. **OR 语义会带来弱命中**。实测（P0-2）：查「设计文档」（tokens = 设计/计文/文档）
 *    时「我的设计稿.psd」因只命中「设计」而混入。故按 `requiredTokenHits` 做最小命中过滤。
 * 3. **FTS 失败回落 LIKE**，不让索引问题变成"搜不到"。与 `memory-repo.ts` 的降级一致。
 */

import type { SQLInputValue } from 'node:sqlite'
import type { DatabaseSync } from 'node:sqlite'

import { countTokenHits, requiredTokenHits, tokenizeBigram } from '@mtbot/agent-runtime'

import type { ItemKind } from './db.js'
import { buildPinyinQuery, pinyinMatchClause } from './pinyin.js'
import { rankCandidates, rootPriority, type RankCandidate } from './rank.js'

export interface SearchHit {
  id: number
  path: string
  name: string
  ext: string | null
  kind: ItemKind
  root: string
  isStart: boolean
  /** FTS5 的 bm25 排序值（越小越相关）；LIKE 降级时为 null */
  rank: number | null
}

export interface SearchOptions {
  limit?: number
  kind?: ItemKind
  /** 限制在某个根内 */
  root?: string
  /** 是否启用最小命中过滤，默认 true（见文件头说明 2） */
  minHits?: boolean
}

/**
 * 把 token 集合转成 FTS5 查询串：每个 token 单独加引号，内部 `"` 转 `""`。
 *
 * 逐 token 加引号后，token 内部的 `*`/`(`/`AND` 等都被当成普通字符，不再有语法含义。
 */
export function ftsQuery(tokens: Iterable<string>): string {
  return [...tokens].map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
}

/**
 * 检索。
 *
 * `tokens` 为空（如用户只输入标点）直接返回空，不构造空 MATCH —— 空 MATCH 在
 * FTS5 里是语法错误。
 *
 * 流程：FTS5 取候选（bm25 粗排）→ 最小命中过滤 → **取使用历史** → `rank.ts` 精排 → 截断。
 * 精排在截断之前做，故候选池要放大（否则"排第一但没进候选池"的东西永远出不来）。
 *
 * ## 两条检索分支
 *
 * - **bigram 分支**：中文的字面匹配（`设计` → `"设计"`）。走最小命中过滤。
 * - **拼音分支**：`豆包`/`dou`/`doubao`/`db` 都能命中（`pinyin.ts`）。
 *   **不走最小命中过滤** —— 它数的是 bigram token，而拼音命中的条目在 `tokens` 列里
 *   没有对应 token，硬套过滤会把它们全部误杀。
 *
 * 两分支结果按 id 合并去重，取更好的 bm25。
 */
export function search(
  db: DatabaseSync,
  query: string,
  options: SearchOptions = {},
  now: number = Date.now(),
): SearchHit[] {
  const limit = options.limit ?? 50
  const tokens = tokenizeBigram(query)
  const pinyinWords = buildPinyinQuery(query)
  if (tokens.size === 0 && pinyinWords.length === 0) return []

  const wantMinHits = options.minHits ?? true
  // 最小命中过滤需要读 tokens 列做计数，故候选集要放大后再截断
  const candidateLimit = wantMinHits ? Math.max(limit * 8, 200) : limit * 4

  type Row = { id: number | bigint; tokens: string | null; rank: number }
  const merged = new Map<number, Row>()
  /** 字面命中（bigram 分支）的 id 集合 —— 排序时它们要被硬性排在纯拼音命中之前 */
  const literalIds = new Set<number>()

  const kind = kindClause(options, 'i')
  const kparams = kindParams(options)

  // 两个分支共用的查询体；limit 传入以控制各自候选池
  const runBranch = (match: string, limitN: number): Row[] | null => {
    try {
      return db
        .prepare(
          `SELECT i.id, f.tokens, bm25(lz_items_fts) AS rank
           FROM lz_items_fts f
           JOIN lz_items i ON i.id = f.rowid
           WHERE lz_items_fts MATCH ?` + kind + ` ORDER BY rank LIMIT ?`,
        )
        .all(match, ...kparams, limitN) as Row[]
    } catch {
      return null // FTS 不可用/损坏，由外层回落 LIKE
    }
  }

  // ── 分支 A：bigram 字面匹配 ──
  const tokenList = [...tokens]
  if (tokenList.length > 0) {
    const rows = runBranch(ftsQuery(tokens), candidateLimit)
    if (rows === null) return searchLike(db, query, { ...options, limit }, now)
    const need = requiredTokenHits(tokenList.length)
    for (const r of rows) {
      if (wantMinHits && countTokenHits(tokenList, r.tokens ?? '') < need) continue
      const id = Number(r.id)
      merged.set(id, r)
      literalIds.add(id)
    }
  }

  // ── 分支 B：拼音前缀匹配（不做最小命中过滤，见函数头注释） ──
  if (pinyinWords.length > 0) {
    const clause = pinyinMatchClause(pinyinWords)
    if (clause) {
      const rows = runBranch(`${clause}`, candidateLimit)
      if (rows === null) return searchLike(db, query, { ...options, limit }, now)
      for (const r of rows) {
        const id = Number(r.id)
        const prev = merged.get(id)
        // 两条路都命中时保留更好的 bm25（更负 = 更相关）
        if (!prev || r.rank < prev.rank) merged.set(id, r)
      }
    }
  }

  if (merged.size === 0) return []

  const filtered = [...merged.values()]
  const ids = filtered.map((r) => Number(r.id))
  const bm25ById = new Map(filtered.map((r) => [Number(r.id), r.rank]))

  const placeholders = ids.map(() => '?').join(',')
  const details = db
    .prepare(`SELECT id, path, name, ext, kind, root, is_start FROM lz_items WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{
    id: number | bigint
    path: string
    name: string
    ext: string | null
    kind: ItemKind
    root: string
    is_start: number
  }>

  // 取该查询词下的使用历史（"越用越准"的输入侧；写入侧只在用户真的打开时发生）
  const usage = usageByPath(db, query)

  const candidates: RankCandidate[] = details.map((d) => {
    const id = Number(d.id)
    const u = usage.get(d.path)
    return {
      id,
      name: d.name,
      path: d.path,
      isStart: !!d.is_start,
      root: d.root,
      bm25: bm25ById.get(id) ?? null,
      usageCount: u?.count ?? 0,
      usageLastUsed: u?.lastUsed ?? 0,
      rootPriority: rootPriority(d.path),
      literalMatch: literalIds.has(id),
    }
  })

  const ranked = rankCandidates(candidates, query, now)
  const detailById = new Map(details.map((d) => [Number(d.id), d]))

  return ranked.slice(0, limit).map((c) => {
    const d = detailById.get(c.id)!
    return {
      id: c.id,
      path: c.path,
      name: c.name,
      ext: d.ext,
      kind: d.kind,
      root: c.root,
      isStart: c.isStart,
      rank: c.bm25,
    }
  })
}

/** 取某查询词下的全部使用历史，按 path 索引 */
function usageByPath(db: DatabaseSync, query: string): Map<string, { count: number; lastUsed: number }> {
  const out = new Map<string, { count: number; lastUsed: number }>()
  try {
    const rows = db
      .prepare('SELECT path, count, last_used FROM lz_usage WHERE keyword = ?')
      .all(query.trim().toLowerCase()) as Array<{
      path: string
      count: number | bigint
      last_used: number | bigint
    }>
    for (const r of rows) out.set(r.path, { count: Number(r.count), lastUsed: Number(r.last_used) })
  } catch {
    /* 使用历史读不到不该让检索失败 */
  }
  return out
}

/** LIKE 降级路径。大小写不敏感，故两边都转小写比较。 */
function searchLike(
  db: DatabaseSync,
  query: string,
  options: SearchOptions,
  now: number = Date.now(),
): SearchHit[] {
  const limit = options.limit ?? 50
  const needle = `%${query.toLowerCase()}%`
  try {
    // 候选池放大后再排序截断（同 FTS 路径的理由：精排在截断之前）
    const pool = Math.max(limit * 8, 200)
    const rows = db
      .prepare(
        `SELECT id, path, name, ext, kind, root, is_start
         FROM lz_items i
         WHERE (lower(i.name) LIKE ? OR lower(i.path) LIKE ?)` +
          kindClause(options, 'i') +
          ` LIMIT ?`,
      )
      .all(needle, needle, ...kindParams(options), pool) as Array<{
      id: number | bigint
      path: string
      name: string
      ext: string | null
      kind: ItemKind
      root: string
      is_start: number
    }>

    // 降级路径也过同一个排序器，保证两条件排序行为一致（bm25 全为 null → 该项不参与）
    const usage = usageByPath(db, query)
    const candidates: RankCandidate[] = rows.map((r) => {
      const u = usage.get(r.path)
      return {
        id: Number(r.id),
        name: r.name,
        path: r.path,
        isStart: !!r.is_start,
        root: r.root,
        bm25: null,
        usageCount: u?.count ?? 0,
        usageLastUsed: u?.lastUsed ?? 0,
        rootPriority: rootPriority(r.path),
        // 降级路径走的是 LIKE 字面包含，全部算字面命中
        literalMatch: true,
      }
    })
    const ranked = rankCandidates(candidates, query, now)
    const detailById = new Map(rows.map((r) => [Number(r.id), r]))

    return ranked.slice(0, limit).map((c) => {
      const d = detailById.get(c.id)!
      return {
        id: c.id,
        path: c.path,
        name: c.name,
        ext: d.ext,
        kind: d.kind,
        root: c.root,
        isStart: c.isStart,
        rank: null,
      }
    })
  } catch {
    return []
  }
}

/** `kind` / `root` 过滤条件。参数顺序与 `kindParams` 一致。`alias` 是该查询里 lz_items 的别名。 */
function kindClause(options: SearchOptions, alias: string): string {
  let sql = ''
  if (options.kind) sql += ` AND ${alias}.kind = ?`
  if (options.root) sql += ` AND ${alias}.root = ?`
  return sql
}

function kindParams(options: SearchOptions): SQLInputValue[] {
  const params: SQLInputValue[] = []
  if (options.kind) params.push(options.kind)
  if (options.root) params.push(options.root)
  return params
}

// ────────────────────────────────────────────────────────────
// 使用历史（"越用越准"的闭环，P2 会用它做排序加权）
// ────────────────────────────────────────────────────────────

export function recordUsage(db: DatabaseSync, keyword: string, path: string): void {
  const kw = keyword.trim().toLowerCase()
  if (!kw) return
  db.prepare(
    `INSERT INTO lz_usage(keyword, path, count, last_used) VALUES (?, ?, 1, ?)
     ON CONFLICT(keyword, path) DO UPDATE SET count = count + 1, last_used = excluded.last_used`,
  ).run(kw, path, Date.now())
}

export interface UsageEntry {
  path: string
  count: number
  lastUsed: number
}

export function lookupUsage(db: DatabaseSync, keyword: string, limit = 20): UsageEntry[] {
  const kw = keyword.trim().toLowerCase()
  if (!kw) return []
  const rows = db
    .prepare('SELECT path, count, last_used FROM lz_usage WHERE keyword = ? ORDER BY count DESC, last_used DESC LIMIT ?')
    .all(kw, limit) as Array<{ path: string; count: number | bigint; last_used: number | bigint }>
  return rows.map((r) => ({ path: r.path, count: Number(r.count), lastUsed: Number(r.last_used) }))
}
