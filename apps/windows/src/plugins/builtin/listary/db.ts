/**
 * 文件索引库 — 表结构、连接与健康检查。
 *
 * 设计：`docs/design/逆向与复刻/2026-11-14-Listary复刻启动器插件设计.md` §3.2 / §5
 *
 * 库独立于 Agent Runtime 主库（`~/.lumii/data/agent-runtime.db`）：索引是可重建的派生物，
 * 且规模可能到几百 MB，并入主库会让备份轮转把索引体积复制一遍，索引损坏也会波及真实数据。
 *
 * SQLite 驱动用 **Electron 内建的 `node:sqlite`**（P0-2 实测：SQLite 3.50.4，带 ENABLE_FTS5；
 * 而 better-sqlite3 未为 Electron 重建，ABI 127 vs 135，`require` 即抛错）。故零新增原生依赖。
 *
 * 中文检索沿用仓库已验证的 **bigram 预分词**方案（`bigramJoin`），FTS5 侧用默认 unicode61。
 * 详见 `@mtbot/agent-runtime` 的 `memory-index.ts` 顶部说明。
 */

import fs from 'node:fs'
import path from 'node:path'
// **只 import 类型**，运行时按需加载。
//
// `node:sqlite` 在 Node 22 里是实验模块，不在 `module.builtinModules` 里，vite 会把它
// 当成裸包 `sqlite` 去解析、报 `Failed to load url sqlite`。而 `registry.ts` → 本插件
// → 本文件是**静态 import 链**，于是任何 import 了注册表的测试都会在加载期炸掉
// （实测 14 个测试文件失败，全量跑掉的 6 个 suite 都是这个原因）。
//
// 与 `agent-runtime/storage/local-database.ts` 同一做法：那边是动态 import，
// 这边因为构造函数是同步的，用 require。类型侧 import type 会被完全擦除。
import type { DatabaseSync } from 'node:sqlite'

import { bigramJoin, tokenizeBigram } from '@mtbot/agent-runtime'

import { buildPinyinTokens } from './pinyin.js'

/** 首次真正建库时才加载驱动 */
function loadSqlite(): typeof import('node:sqlite') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('node:sqlite') as typeof import('node:sqlite')
}

/** 条目类型 */
export type ItemKind = 'file' | 'dir' | 'app' | 'lnk'

export interface IndexItem {
  path: string
  name: string
  ext: string | null
  kind: ItemKind
  size: number | null
  mtime: number | null
  root: string
  isStart: boolean
}

export interface FtsHealth {
  isHealthy: boolean
  reason?: string
  items?: number
  fts?: number
}

/**
 * DDL。分三段便于阅读：主表 / FTS5 / 辅助表。
 *
 * FTS5 表是**独立虚表**（非 external content），转义与最小命中过滤都需要行本体可读。
 * 另存一列 `tokens` 做最小命中计数——`name_tokens`/`path_tokens` 是分词后的，
 * 直接 `includes` 同样能数，但分开存便于将来按列加权。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS lz_items (
  id       INTEGER PRIMARY KEY,
  path     TEXT    NOT NULL UNIQUE,
  name     TEXT    NOT NULL,
  ext      TEXT,
  kind     TEXT    NOT NULL,
  size     INTEGER,
  mtime    INTEGER,
  root     TEXT    NOT NULL,
  is_start INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lz_items_root ON lz_items(root);
CREATE INDEX IF NOT EXISTS idx_lz_items_name ON lz_items(name);

CREATE VIRTUAL TABLE IF NOT EXISTS lz_items_fts USING fts5(
  name_tokens,
  path_tokens,
  tokens,
  pinyin_tokens,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS lz_usage (
  keyword   TEXT    NOT NULL,
  path      TEXT    NOT NULL,
  count     INTEGER NOT NULL DEFAULT 1,
  last_used INTEGER NOT NULL,
  PRIMARY KEY (keyword, path)
);
CREATE INDEX IF NOT EXISTS idx_lz_usage_keyword ON lz_usage(keyword);

CREATE TABLE IF NOT EXISTS lz_roots (
  path     TEXT PRIMARY KEY,
  enabled  INTEGER NOT NULL DEFAULT 1,
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lz_scan_state (
  root       TEXT PRIMARY KEY,
  last_scan  INTEGER,
  duration   INTEGER,
  item_count INTEGER,
  error      TEXT
);

CREATE TABLE IF NOT EXISTS lz_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/**
 * 库的 schema 版本。
 *
 * V2：`lz_items_fts` 加 `pinyin_tokens` 列（拼音检索）。
 * FTS5 虚表**不能 ALTER 加列**，而 `CREATE ... IF NOT EXISTS` 对已存在的表是空操作，
 * 所以老库必须 DROP 重建。这没问题：FTS 是主表的**派生物**，重建后由下次扫描回填
 *（主表 `lz_items` 不动，即使不回填也只是"暂时搜不到"而不是数据丢失）。
 */
export const LZ_SCHEMA_VERSION = 2

export class ListaryDb {
  readonly db: DatabaseSync
  readonly filePath: string

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    this.filePath = filePath
    const { DatabaseSync: Sync } = loadSqlite()
    this.db = new Sync(filePath)
    applyPragmas(this.db)
    this.migrate()
    this.db.exec(SCHEMA)
    this.db
      .prepare('INSERT INTO lz_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('schema_version', String(LZ_SCHEMA_VERSION))
  }

  /** V1 → V2：重建 FTS 表以补上 pinyin_tokens 列 */
  private migrate(): void {
    let current = 0
    try {
      const row = this.db.prepare('SELECT value FROM lz_meta WHERE key = ?').get('schema_version') as
        | { value: string }
        | undefined
      current = row ? Number(row.value) : 0
    } catch {
      return // 全新库：lz_meta 还不存在，SCHEMA 会建
    }
    if (current > 0 && current < 2) {
      try {
        this.db.exec('DROP TABLE IF EXISTS lz_items_fts')
      } catch {
        /* 建表语句随后会重建 */
      }
    }
  }

  /** 打开内存库（测试用） */
  static memory(): ListaryDb {
    return new ListaryDb(':memory:')
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* 已关闭 */
    }
  }

  /**
   * 健康检查：比对活跃主表条数与 FTS 行数。
   *
   * FTS 表缺失（被手动 DROP 等）视为不健康，不抛异常 —— 调用方据此决定是否 rebuild。
   * 与 `MemoryIndexRepo.checkFtsHealth` 同构。
   */
  checkHealth(): FtsHealth {
    let items: number
    try {
      items = count(this.db, 'lz_items')
    } catch {
      return { isHealthy: false, reason: 'lz_items 不可读' }
    }
    let fts: number
    try {
      fts = count(this.db, 'lz_items_fts')
    } catch {
      return { isHealthy: false, reason: 'lz_items_fts 虚表不存在或不可读', items }
    }
    if (items !== fts) {
      return { isHealthy: false, reason: `条数不一致：主表 ${items}，索引 ${fts}`, items, fts }
    }
    return { isHealthy: true, items, fts }
  }
}

function count(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number | bigint }
  return Number(row.c)
}

/**
 * 连接 pragma。
 *
 * 与 `applySqliteConnectionPragmas`（agent-runtime 的 local-database）同源思路，但那边
 * 接受的是它自己的连接抽象，这里直接作用于 DatabaseSync —— 不去为了复用而造适配层。
 */
export function applyPragmas(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA temp_store = MEMORY')
}

// ────────────────────────────────────────────────────────────
// 写入
// ────────────────────────────────────────────────────────────

/**
 * FTS5 的写入辅助——**先删后插**。
 *
 * FTS5 不支持原地覆盖，且索引维护必须由应用代码做（分词在 JS 侧，SQL 触发器做不到）。
 * 与 `MemoryIndexRepo.upsertRow` 同一做法。
 */
export function putFts(db: DatabaseSync, rowid: number | bigint, item: { name: string; path: string }): void {
  const nameTokens = bigramJoin(item.name)
  const pathTokens = bigramJoin(item.path)
  // 合并去重后的一整份 token 文本，供最小命中过滤按绝对命中的 token 个数判定
  const all = [...new Set([...tokenizeBigram(item.name), ...tokenizeBigram(item.path)])].join(' ')
  // 拼音只索引**文件名**（用户是按名字记事的，不按完整路径的拼音去记）
  const pyTokens = buildPinyinTokens(item.name)
  db.prepare('DELETE FROM lz_items_fts WHERE rowid = ?').run(rowid)
  db.prepare(
    'INSERT INTO lz_items_fts(rowid, name_tokens, path_tokens, tokens, pinyin_tokens) VALUES (?, ?, ?, ?, ?)',
  ).run(rowid, nameTokens, pathTokens, all, pyTokens)
}

export function deleteFts(db: DatabaseSync, rowid: number | bigint): void {
  db.prepare('DELETE FROM lz_items_fts WHERE rowid = ?').run(rowid)
}

/** 建库文件的默认位置：`<userData>/listary/index.db` */
export function defaultIndexPath(userDataDir: string): string {
  return path.join(userDataDir, 'listary', 'index.db')
}
