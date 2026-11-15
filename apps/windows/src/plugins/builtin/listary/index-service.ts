/**
 * 索引管理 — 索引库的单例持有、根管理、扫描编排。
 *
 * 把"库放哪、什么时候扫、扫完存什么"收在一处，IPC 与渲染层都不碰这些细节。
 * 库路径：`<userData>/listary/index.db`。
 */

import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

import { ListaryDb, defaultIndexPath } from './db.js'
import { normalizePath, scanSync, type ScanResult } from './scanner.js'
import { recordScanState, upsertBatch } from './writer.js'

export interface IndexStatus {
  dbPath: string
  healthy: boolean
  reason?: string
  items: number
  fts: number
  roots: Array<{ path: string; enabled: boolean; itemCount?: number; lastScan?: number; durationMs?: number }>
  scanning: boolean
}

export interface DefaultRootsOptions {
  /** 额外加入的目录（如项目目录） */
  extra?: string[]
}

/**
 * 默认索引根。
 *
 * 只含高价值目录 —— **不做全盘默认**：P1 实测 36 739 条要 19.7 秒，
 * 用户全盘（几十万条）首扫会到分钟级，装完就卡几分钟是不可接受的体验。
 * 用户可以自己在设置里加。
 */
export function defaultRoots(options: DefaultRootsOptions = {}): string[] {
  const home = app.getPath('home')
  const out: string[] = []
  const add = (p: string): void => {
    if (p && fs.existsSync(p)) out.push(normalizePath(p))
  }

  add(app.getPath('desktop'))
  add(app.getPath('documents'))
  add(app.getPath('downloads'))
  // 桌面上的快捷方式、开始菜单的程序 —— 启动器最主要的"应用来源"
  add(path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu'))
  add(path.join('C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu'))
  for (const e of options.extra ?? []) add(e)

  return [...new Set(out)]
}

export class IndexService {
  private ldb: ListaryDb | null = null
  private scanning = false

  constructor(private readonly dbPathOverride?: string) {}

  get dbPath(): string {
    return this.dbPathOverride ?? defaultIndexPath(app.getPath('userData'))
  }

  /** 懒开库。扫描/检索都走这里，避免启动时无条件建文件。 */
  open(): ListaryDb {
    if (this.ldb) return this.ldb
    this.ldb = new ListaryDb(this.dbPath)
    const health = this.ldb.checkHealth()
    if (!health.isHealthy) {
      console.warn(`[listary/index] 索引健康检查未通过：${health.reason}`)
    }
    return this.ldb
  }

  close(): void {
    this.ldb?.close()
    this.ldb = null
  }

  /** 确保默认根已登记（首次运行时） */
  ensureRoots(extra?: string[]): void {
    const db = this.open().db
    const existing = db.prepare('SELECT COUNT(*) c FROM lz_roots').get() as { c: number | bigint }
    if (Number(existing.c) > 0) return
    const now = Date.now()
    const ins = db.prepare('INSERT OR IGNORE INTO lz_roots(path, enabled, added_at) VALUES (?, 1, ?)')
    for (const r of defaultRoots({ extra })) ins.run(r, now)
  }

  addRoot(rootPath: string): void {
    const db = this.open().db
    db.prepare('INSERT OR IGNORE INTO lz_roots(path, enabled, added_at) VALUES (?, 1, ?)').run(
      normalizePath(rootPath),
      Date.now(),
    )
  }

  removeRoot(rootPath: string): number {
    const db = this.open().db
    const norm = normalizePath(rootPath)
    const rows = db.prepare('SELECT id FROM lz_items WHERE root = ?').all(norm) as Array<{ id: number | bigint }>
    db.exec('BEGIN')
    try {
      const delFts = db.prepare('DELETE FROM lz_items_fts WHERE rowid = ?')
      for (const r of rows) delFts.run(r.id)
      db.prepare('DELETE FROM lz_items WHERE root = ?').run(norm)
      db.prepare('DELETE FROM lz_roots WHERE path = ?').run(norm)
      db.prepare('DELETE FROM lz_scan_state WHERE root = ?').run(norm)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    return rows.length
  }

  listRoots(): Array<{ path: string; enabled: boolean }> {
    const db = this.open().db
    const rows = db.prepare('SELECT path, enabled FROM lz_roots ORDER BY added_at').all() as Array<{
      path: string
      enabled: number | bigint
    }>
    return rows.map((r) => ({ path: r.path, enabled: Number(r.enabled) === 1 }))
  }

  status(): IndexStatus {
    const db = this.open().db
    const health = this.ldb!.checkHealth()
    const stateRows = db
      .prepare('SELECT root, last_scan, duration, item_count FROM lz_scan_state')
      .all() as Array<{
      root: string
      last_scan: number | bigint | null
      duration: number | bigint | null
      item_count: number | bigint | null
    }>
    const stateByRoot = new Map(stateRows.map((r) => [r.root, r]))
    const roots = this.listRoots().map((r) => {
      const s = stateByRoot.get(r.path)
      return {
        path: r.path,
        enabled: r.enabled,
        itemCount: s?.item_count != null ? Number(s.item_count) : undefined,
        lastScan: s?.last_scan != null ? Number(s.last_scan) : undefined,
        durationMs: s?.duration != null ? Number(s.duration) : undefined,
      }
    })
    return {
      dbPath: this.dbPath,
      healthy: health.isHealthy,
      reason: health.reason,
      items: health.items ?? 0,
      fts: health.fts ?? 0,
      roots,
      scanning: this.scanning,
    }
  }

  isScanning(): boolean {
    return this.scanning
  }

  /**
   * 扫描全部已启用的根。
   *
   * 同步实现（`scanSync`）—— 它会阻塞主进程。P1 实测 36 739 条 19.7 秒，
   * 期间 UI 会卡。**这是已知的、要有意接受的取舍**：正确的做法是 worker 线程，
   * 但那要求把 db/scanner 也搬进去（node:sqlite 连接不能跨线程共享）。
   * 当前先做对功能，卡顿在 P9 用 worker 或分片解决 —— 已记在遗留项。
   */
  async scanAll(extraRoots?: string[]): Promise<ScanResult & { perRoot: Array<{ root: string; result: ScanResult }> }> {
    if (this.scanning) {
      return { indexed: 0, skippedDirs: 0, failedDirs: 0, durationMs: 0, aborted: true, perRoot: [] }
    }
    this.scanning = true
    const ldb = this.open()
    const db = ldb.db
    this.ensureRoots(extraRoots)

    const roots = this.listRoots().filter((r) => r.enabled).map((r) => r.path)
    const perRoot: Array<{ root: string; result: ScanResult }> = []
    let total = 0

    try {
      for (const root of roots) {
        if (!fs.existsSync(root)) {
          recordScanState(db, root, { indexed: 0, skippedDirs: 0, failedDirs: 1, durationMs: 0, aborted: false }, '根目录不存在')
          continue
        }
        const result = scanSync({
          roots: [root],
          batchSize: 2000,
          onBatch: (items) => upsertBatch(db, items),
        })
        recordScanState(db, root, result)
        perRoot.push({ root, result })
        total += result.indexed
      }
    } finally {
      this.scanning = false
    }

    const agg: ScanResult = {
      indexed: total,
      skippedDirs: perRoot.reduce((s, p) => s + p.result.skippedDirs, 0),
      failedDirs: perRoot.reduce((s, p) => s + p.result.failedDirs, 0),
      durationMs: perRoot.reduce((s, p) => s + p.result.durationMs, 0),
      aborted: false,
    }
    return { ...agg, perRoot }
  }
}
