/**
 * SyncExporter — 导出数据到 sync/ 目录
 *
 * 导出范围：
 * - Wiki 知识库（SQL dump）
 * - 记忆宫殿（JSONL）
 * - Agent 记忆（JSONL）
 * - 自主进化数据（JSON）
 * - 用户文件
 */

import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { SQLITE_BUSY_TIMEOUT_MS } from '@mtbot/agent-runtime'
import { createLogger } from '../logger'
import { SYNC_OUTPUTS_MAX_BYTES, copySyncDirectory } from './sync-copy'

const logger = createLogger('cloud-sync/exporter')

// node:sqlite 在 electron-vite 打包产物中不可静态 import（会被 undici stub 替换）。
// 与 agent-runtime 的 local-database 同款：运行时动态 import，Electron 36 内建 node:sqlite 提供。
let dbSyncCtor: typeof DatabaseSync | undefined
async function loadDatabaseSync(): Promise<typeof DatabaseSync> {
  if (!dbSyncCtor) {
    const mod = await import('node:sqlite')
    dbSyncCtor = mod.DatabaseSync
  }
  return dbSyncCtor
}

/**
 * 打开 agent-runtime.db 只读旁路连接，并设置 busy_timeout（写锁争用时短暂等待而非立刻失败）。
 */
async function openReadonlyDb(dbPath: string): Promise<InstanceType<typeof DatabaseSync>> {
  const DatabaseSync = await loadDatabaseSync()
  const db = new DatabaseSync(dbPath, { readOnly: true })
  db.exec(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`)
  return db
}

export interface SyncExportOptions {
  dbPath: string
  syncDir: string
  workspaceDir: string
  dataDir: string
}

export interface SyncExportResult {
  success: boolean
  exportedFiles: string[]
  errors: string[]
  timestamp: string
}

export class SyncExporter {
  private options: SyncExportOptions

  constructor(options: SyncExportOptions) {
    this.options = options
  }

  /**
   * 完整导出流程
   */
  async export(): Promise<SyncExportResult> {
    const startTime = Date.now()
    const timestamp = new Date().toISOString()
    const exportedFiles: string[] = []
    const errors: string[] = []

    try {
      // 确保 sync 目录存在
      this.ensureSyncDirectories()

      // 1. 导出 profile（soul.md, user-memory.md）
      logger.info('[export] 1. 导出用户配置...')
      try {
        await this.exportProfile()
        exportedFiles.push('profile/soul.md', 'profile/user-memory.md')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error('[export] Profile 导出失败:', msg)
        errors.push(`profile: ${msg}`)
      }

      // 2. 导出 Wiki（JSONL 格式，每表一个文件）
      logger.info('[export] 2. 导出 Wiki 知识库...')
      try {
        await this.exportWiki()
        exportedFiles.push(
          'wiki/wiki_inbox.jsonl',
          'wiki/wiki_sources.jsonl',
          'wiki/wiki_entities.jsonl',
          'wiki/wiki_observations.jsonl',
          'wiki/wiki_relations.jsonl',
          'wiki/wiki_syntheses.jsonl',
          'wiki/wiki_organize_runs.jsonl'
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error('[export] Wiki 导出失败:', msg)
        errors.push(`wiki: ${msg}`)
      }

      // 3. 导出记忆数据
      logger.info('[export] 3. 导出记忆数据...')
      try {
        await this.exportMemories()
        exportedFiles.push('memory/agent-memories.jsonl')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error('[export] 记忆导出失败:', msg)
        errors.push(`memory: ${msg}`)
      }

      // 4. 导出自主进化数据
      logger.info('[export] 4. 导出自主进化数据...')
      try {
        await this.exportAutonomous()
        exportedFiles.push('autonomous/*.json')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error('[export] 自主进化导出失败:', msg)
        errors.push(`autonomous: ${msg}`)
      }

      // 5. 导出用户文件
      logger.info('[export] 5. 导出用户文件...')
      try {
        await this.exportUserFiles()
        exportedFiles.push('workspace/files/**')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error('[export] 用户文件导出失败:', msg)
        errors.push(`workspace: ${msg}`)
      }

      // 6. 生成同步清单
      await this.generateManifest(timestamp, exportedFiles)

      const duration = Date.now() - startTime
      logger.info(`[export] 导出完成，耗时 ${duration}ms，文件数 ${exportedFiles.length}，错误 ${errors.length}`)

      return {
        success: errors.length === 0,
        exportedFiles,
        errors,
        timestamp,
      }
    } catch (err) {
      logger.error('[export] 导出失败:', err)
      throw err
    }
  }

  /**
   * 确保 sync 目录结构
   */
  private ensureSyncDirectories(): void {
    const dirs = [
      path.join(this.options.syncDir, 'profile'),
      path.join(this.options.syncDir, 'wiki'),
      path.join(this.options.syncDir, 'memory'),
      path.join(this.options.syncDir, 'autonomous'),
      path.join(this.options.syncDir, 'workspace/files'),
      path.join(this.options.syncDir, 'workspace/outputs'),
    ]

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    }
  }

  /**
   * 导出 profile（soul.md, user-memory.md）
   */
  private async exportProfile(): Promise<void> {
    const profileDir = path.join(this.options.syncDir, 'profile')

    // 复制 soul.md
    const soulSrc = path.join(this.options.dataDir, 'soul.md')
    const soulDst = path.join(profileDir, 'soul.md')
    if (fs.existsSync(soulSrc)) {
      fs.copyFileSync(soulSrc, soulDst)
    } else {
      // 创建默认 soul.md
      fs.writeFileSync(soulDst, '# SOUL Who You Are\n\n(待定义)')
    }

    // 复制 user-memory.md
    const memSrc = path.join(this.options.dataDir, 'user-memory.md')
    const memDst = path.join(profileDir, 'user-memory.md')
    if (fs.existsSync(memSrc)) {
      fs.copyFileSync(memSrc, memDst)
    } else {
      fs.writeFileSync(memDst, '# User Memory\n\n(待记录)')
    }
  }

  /**
   * 导出 Wiki 知识库（JSONL 格式，每表一个文件，每行一条记录）
   *
   * 设计：docs/superpowers/specs/2026-09-09-lightweight-cloud-sync-design.md
   * - 每表独立 .jsonl 文件，避免单文件过大导致 git merge 冲突扩散
   * - 在事务中读取，防止导出期间数据被修改（窗口期保护）
   * - 软删除记录也导出（deleted_at 字段），确保删除操作能传播到其他设备
   */
  private async exportWiki(): Promise<void> {
    const wikiDir = path.join(this.options.syncDir, 'wiki')

    // Wiki 核心表（排除派生数据：wiki_source_embeddings, wiki_sources_fts, wiki_index_meta）
    const wikiTables = [
      'wiki_inbox',
      'wiki_sources',
      'wiki_entities',
      'wiki_observations',
      'wiki_relations',
      'wiki_syntheses',
      'wiki_organize_runs',
    ]

    const db = await openReadonlyDb(this.options.dbPath)
    try {
      // 开启事务，确保所有表的导出是一致性快照
      db.exec('BEGIN IMMEDIATE TRANSACTION')

      try {
        for (const table of wikiTables) {
          await this.exportTableToJsonl(db, table, wikiDir)
        }

        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    } finally {
      db.close()
    }
  }

  /**
   * 导出单个表为 JSONL 格式
   * @param db 数据库连接
   * @param tableName 表名
   * @param outputDir 输出目录
   */
  private async exportTableToJsonl(
    db: InstanceType<typeof DatabaseSync>,
    tableName: string,
    outputDir: string,
  ): Promise<void> {
    try {
      const rows = db.prepare(`SELECT * FROM ${tableName}`).all() as unknown[]
      const jsonlFile = path.join(outputDir, `${tableName}.jsonl`)

      if (rows.length === 0) {
        // 空表写入空文件
        fs.writeFileSync(jsonlFile, '')
        return
      }

      // 每行一条记录
      const lines = rows.map((row) => JSON.stringify(row)).join('\n')
      fs.writeFileSync(jsonlFile, lines + '\n') // 末尾加换行符，符合 JSONL 规范
    } catch (err) {
      // 表不存在，写入空文件
      logger.warn(`[exportTableToJsonl] 表 ${tableName} 不存在或查询失败`)
      const jsonlFile = path.join(outputDir, `${tableName}.jsonl`)
      fs.writeFileSync(jsonlFile, '')
    }
  }

  /**
   * 导出 Agent 记忆（JSONL 格式）
   *
   * 设计：docs/superpowers/specs/2026-09-09-lightweight-cloud-sync-design.md
   * - 在事务中读取，防止导出期间数据被修改
   * - 包含软删除记录（deleted_at IS NOT NULL），确保删除传播
   * - 不再过滤 is_archived，软删除字段已取代归档标记
   */
  private async exportMemories(): Promise<void> {
    const db = await openReadonlyDb(this.options.dbPath)

    const memoryDir = path.join(this.options.syncDir, 'memory')
    const jsonlFile = path.join(memoryDir, 'agent-memories.jsonl')

    try {
      // 开启事务，确保导出是一致性快照
      db.exec('BEGIN IMMEDIATE TRANSACTION')

      try {
        // 导出所有记忆，包括软删除的（deleted_at 字段会随记录导出）
        const memories = db.prepare(`
          SELECT id, agent_id, user_id, category, content,
                 importance, tags, created_at, last_used,
                 use_count, is_archived, deleted_at
          FROM agent_memories
          ORDER BY created_at ASC
        `).all()

        if (memories.length === 0) {
          fs.writeFileSync(jsonlFile, '')
        } else {
          const lines = memories.map((m) => JSON.stringify(m)).join('\n')
          fs.writeFileSync(jsonlFile, lines + '\n')
        }

        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    } catch (err) {
      logger.warn('[exportMemories] agent_memories 表不存在或为空')
      fs.writeFileSync(jsonlFile, '')
    } finally {
      db.close()
    }
  }

  /**
   * 导出自主进化数据（JSON）
   */
  private async exportAutonomous(): Promise<void> {
    const db = await openReadonlyDb(this.options.dbPath)

    const autoDir = path.join(this.options.syncDir, 'autonomous')

    const tables = {
      'autonomous_goals': "WHERE status != 'completed' AND status != 'failed'",
      'autonomous_satisfaction_scores': 'ORDER BY created_at DESC LIMIT 100',
      'autonomous_approval_settings': '',
      'autonomous_diaries': 'ORDER BY created_at DESC LIMIT 50',
    }

    try {
      for (const [table, filter] of Object.entries(tables)) {
        try {
          const rows = db.prepare(`SELECT * FROM ${table} ${filter}`).all()
          const jsonFile = path.join(autoDir, `${table}.json`)
          fs.writeFileSync(jsonFile, JSON.stringify(rows, null, 2))
        } catch (err) {
          logger.warn(`[exportAutonomous] 表 ${table} 不存在或为空`)
          const jsonFile = path.join(autoDir, `${table}.json`)
          fs.writeFileSync(jsonFile, '[]')
        }
      }
    } finally {
      db.close()
    }
  }

  /**
   * 导出用户文件（跳过 .git 等重目录；outputs 单文件 >5MB 跳过；单文件失败不阻断）
   */
  private async exportUserFiles(): Promise<void> {
    const errors: string[] = []

    const srcFiles = path.join(this.options.workspaceDir, 'files')
    const dstFiles = path.join(this.options.syncDir, 'workspace/files')
    if (fs.existsSync(srcFiles)) {
      const r = copySyncDirectory(srcFiles, dstFiles)
      errors.push(...r.errors)
    }

    const srcOutputs = path.join(this.options.workspaceDir, 'outputs')
    const dstOutputs = path.join(this.options.syncDir, 'workspace/outputs')
    if (fs.existsSync(srcOutputs)) {
      const r = copySyncDirectory(srcOutputs, dstOutputs, { maxSize: SYNC_OUTPUTS_MAX_BYTES })
      errors.push(...r.errors)
      if (r.skippedLarge > 0) {
        logger.info(`[exportUserFiles] outputs 跳过大文件 ${r.skippedLarge} 个（阈值 ${SYNC_OUTPUTS_MAX_BYTES} bytes）`)
      }
      if (r.skippedDirs > 0) {
        logger.info(`[exportUserFiles] 跳过目录 ${r.skippedDirs} 个（含 .git/node_modules 等）`)
      }
    }

    // 单文件失败已在 copy 内跳过；仅告警，不阻断整次导出（避免偶发 EPERM 拖垮同步）
    if (errors.length > 0) {
      logger.warn(
        `[exportUserFiles] ${errors.length} 个文件复制失败已跳过: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? ' …' : ''}`,
      )
    }
  }

  /**
   * 生成同步清单
   */
  private async generateManifest(timestamp: string, files: string[]): Promise<void> {
    const manifest = {
      version: '1.0',
      timestamp,
      files,
      generator: 'SyncExporter',
    }

    const manifestFile = path.join(this.options.syncDir, '.sync-manifest.json')
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
  }
}
