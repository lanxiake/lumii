/**
 * 索引写入 — upsert / 删除 / 重建。
 *
 * 设计：`docs/design/逆向与复刻/2026-11-14-Listary复刻启动器插件设计.md` §6.2
 *
 * 索引维护在**应用代码**而非 SQL 触发器：分词发生在 JS 侧（`bigramJoin`），触发器做不到。
 * 这与 `MemoryIndexRepo` 的选择一致。
 */

import type { DatabaseSync } from 'node:sqlite'

import type { IndexItem } from './db.js'
import { deleteFts, putFts } from './db.js'
import type { ScanResult } from './scanner.js'

export interface UpsertStats {
  inserted: number
  updated: number
  skipped: number
  durationMs: number
}

/**
 * 批量 upsert。
 *
 * 整批一个事务：逐条开事务在万级条目下会慢到不可接受（每次 fsync）。
 * 单批失败整批回滚，避免留下"主表有、FTS 没有"的半截状态。
 */
export function upsertBatch(db: DatabaseSync, items: readonly IndexItem[]): UpsertStats {
  const started = Date.now()
  let inserted = 0
  let updated = 0
  let skipped = 0

  const findId = db.prepare('SELECT id FROM lz_items WHERE path = ?')
  const insert = db.prepare(
    `INSERT INTO lz_items(path, name, ext, kind, size, mtime, root, is_start)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const update = db.prepare(
    `UPDATE lz_items SET name = ?, ext = ?, kind = ?, size = ?, mtime = ?, root = ?, is_start = ?
     WHERE id = ?`,
  )

  db.exec('BEGIN')
  try {
    for (const item of items) {
      const existing = findId.get(item.path) as { id: number | bigint } | undefined
      if (existing) {
        update.run(
          item.name,
          item.ext,
          item.kind,
          item.size,
          item.mtime,
          item.root,
          item.isStart ? 1 : 0,
          existing.id,
        )
        putFts(db, existing.id, item)
        updated++
      } else {
        const info = insert.run(
          item.path,
          item.name,
          item.ext,
          item.kind,
          item.size,
          item.mtime,
          item.root,
          item.isStart ? 1 : 0,
        )
        const rowid = info.lastInsertRowid
        if (rowid === undefined || rowid === null) {
          skipped++
          continue
        }
        putFts(db, rowid, item)
        inserted++
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }

  return { inserted, updated, skipped, durationMs: Date.now() - started }
}

/** 删掉某个根下的全部条目（重扫前清场，或删根时清理） */
export function deleteByRoot(db: DatabaseSync, root: string): number {
  const rows = db.prepare('SELECT id FROM lz_items WHERE root = ?').all(root) as Array<{ id: number | bigint }>
  if (rows.length === 0) return 0
  db.exec('BEGIN')
  try {
    for (const r of rows) deleteFts(db, r.id)
    db.prepare('DELETE FROM lz_items WHERE root = ?').run(root)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return rows.length
}

export function deleteByPath(db: DatabaseSync, path: string): boolean {
  const row = db.prepare('SELECT id FROM lz_items WHERE path = ?').get(path) as
    | { id: number | bigint }
    | undefined
  if (!row) return false
  deleteFts(db, row.id)
  db.prepare('DELETE FROM lz_items WHERE id = ?').run(row.id)
  return true
}

export function clearAll(db: DatabaseSync): void {
  db.exec('BEGIN')
  try {
    db.exec('DELETE FROM lz_items_fts')
    db.exec('DELETE FROM lz_items')
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export function recordScanState(
  db: DatabaseSync,
  root: string,
  result: ScanResult,
  error?: string,
): void {
  db.prepare(
    `INSERT INTO lz_scan_state(root, last_scan, duration, item_count, error)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(root) DO UPDATE SET
       last_scan = excluded.last_scan,
       duration  = excluded.duration,
       item_count= excluded.item_count,
       error     = excluded.error`,
  ).run(root, Date.now(), result.durationMs, result.indexed, error ?? null)
}
