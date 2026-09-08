/**
 * SyncImporter — 从 sync/ 目录导入数据
 *
 * 导入范围：
 * - Wiki 知识库（SQL dump）
 * - 记忆宫殿（JSONL）
 * - Agent 记忆（JSONL）
 * - 自主进化数据（JSON）
 * - 用户文件
 */

import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { SQLITE_BUSY_TIMEOUT_MS } from '@mtbot/agent-runtime'
import { createLogger } from '../logger'
import { copySyncDirectory } from './sync-copy'

const logger = createLogger('cloud-sync/importer')

// 同 exporter：node:sqlite 必须在运行时动态 import（electron-vite 打包产物静态 import 会命中 undici stub）
let dbSyncCtor: typeof DatabaseSync | undefined
async function loadDatabaseSync(): Promise<typeof DatabaseSync> {
  if (!dbSyncCtor) {
    const mod = await import('node:sqlite')
    dbSyncCtor = mod.DatabaseSync
  }
  return dbSyncCtor
}

/**
 * 打开 agent-runtime.db 旁路写连接，并设置 busy_timeout，避免与主连接流式写立刻 SQLITE_BUSY。
 */
async function openWritableDb(dbPath: string): Promise<InstanceType<typeof DatabaseSync>> {
  const DatabaseSync = await loadDatabaseSync()
  const db = new DatabaseSync(dbPath)
  db.exec(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`)
  return db
}

export interface SyncImportOptions {
  dbPath: string
  syncDir: string
  workspaceDir: string
  dataDir: string
}

export interface SyncImportResult {
  success: boolean
  importedFiles: string[]
  errors: string[]
  stats: {
    wikiRows: number
    memoriesImported: number
    autonomousImported: number
    filesImported: number
  }
}

export class SyncImporter {
  private options: SyncImportOptions

  constructor(options: SyncImportOptions) {
    this.options = options
  }

  /**
   * 完整导入流程
   */
  async import(): Promise<SyncImportResult> {
    const startTime = Date.now()
    const importedFiles: string[] = []
    const errors: string[] = []
    const stats = {
      wikiRows: 0,
      memoriesImported: 0,
      autonomousImported: 0,
      filesImported: 0,
    }

    try {
      // 1. 校验同步清单
      logger.info('[import] 1. 校验同步清单...')
      const manifestValid = await this.validateManifest()
      if (!manifestValid) {
        throw new Error('同步清单校验失败')
      }

      // 2. 导入 profile
      logger.info('[import] 2. 导入用户配置...')
      try {
        await this.importProfile()
        importedFiles.push('profile/*')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error('[import] Profile 导入失败:', msg)
        errors.push(`profile: ${msg}`)
      }

      // 3. 导入 Wiki
      logger.info('[import] 3. 导入 Wiki 知识库...')
      try {
        stats.wikiRows = await this.importWiki()
        importedFiles.push('wiki/data.json')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error('[import] Wiki 导入失败:', msg)
        errors.push(`wiki: ${msg}`)
      }

      // 4. 导入记忆
      logger.info('[import] 4. 导入记忆数据...')
      try {
        stats.memoriesImported = await this.importMemories()
        importedFiles.push('memory/agent-memories.jsonl')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error('[import] 记忆导入失败:', msg)
        errors.push(`memory: ${msg}`)
      }

      // 5. 导入自主进化数据
      logger.info('[import] 5. 导入自主进化数据...')
      try {
        stats.autonomousImported = await this.importAutonomous()
        importedFiles.push('autonomous/*')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error('[import] 自主进化导入失败:', msg)
        errors.push(`autonomous: ${msg}`)
      }

      // 6. 导入用户文件
      logger.info('[import] 6. 导入用户文件...')
      try {
        stats.filesImported = await this.importUserFiles()
        importedFiles.push('workspace/*')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error('[import] 用户文件导入失败:', msg)
        errors.push(`workspace: ${msg}`)
      }

      const duration = Date.now() - startTime
      logger.info(`[import] 导入完成，耗时 ${duration}ms`)
      logger.info(`[import] 统计: Wiki=${stats.wikiRows}, 记忆=${stats.memoriesImported}, 自主=${stats.autonomousImported}, 文件=${stats.filesImported}`)

      return {
        success: errors.length === 0,
        importedFiles,
        errors,
        stats,
      }
    } catch (err) {
      logger.error('[import] 导入失败:', err)
      throw err
    }
  }

  /**
   * 校验同步清单
   */
  private async validateManifest(): Promise<boolean> {
    const manifestFile = path.join(this.options.syncDir, '.sync-manifest.json')

    if (!fs.existsSync(manifestFile)) {
      logger.warn('[validateManifest] 同步清单不存在，跳过校验')
      return true
    }

    try {
      const content = fs.readFileSync(manifestFile, 'utf-8')
      const manifest = JSON.parse(content)
      logger.info(`[validateManifest] 清单版本: ${manifest.version}, 时间: ${manifest.timestamp}`)
      return true
    } catch (err) {
      logger.error('[validateManifest] 清单格式错误:', err)
      return false
    }
  }

  /**
   * 导入 profile
   */
  private async importProfile(): Promise<void> {
    const profileDir = path.join(this.options.syncDir, 'profile')

    // 复制 soul.md
    const soulSrc = path.join(profileDir, 'soul.md')
    const soulDst = path.join(this.options.dataDir, 'soul.md')
    if (fs.existsSync(soulSrc)) {
      fs.copyFileSync(soulSrc, soulDst)
    }

    // 复制 user-memory.md
    const memSrc = path.join(profileDir, 'user-memory.md')
    const memDst = path.join(this.options.dataDir, 'user-memory.md')
    if (fs.existsSync(memSrc)) {
      fs.copyFileSync(memSrc, memDst)
    }
  }

  /**
   * 导入 Wiki（从 JSON）
   */
  private async importWiki(): Promise<number> {
    const wikiDir = path.join(this.options.syncDir, 'wiki')
    const jsonFile = path.join(wikiDir, 'data.json')

    if (!fs.existsSync(jsonFile)) {
      logger.warn('[importWiki] 没有 Wiki 数据可导入')
      return 0
    }

    const db = await openWritableDb(this.options.dbPath)
    try {
      const content = fs.readFileSync(jsonFile, 'utf-8')
      const data = JSON.parse(content)

      let totalRows = 0

      for (const [table, rows] of Object.entries(data)) {
        if (!Array.isArray(rows) || rows.length === 0) continue

        try {
          const row = rows[0] as Record<string, unknown>
          const columns = Object.keys(row)
          const placeholders = columns.map(() => '?').join(', ')

          const insertStmt = db.prepare(`
            INSERT OR REPLACE INTO ${table} (${columns.join(', ')})
            VALUES (${placeholders})
          `)

          for (const r of rows) {
            const values = columns.map((col) => (r as Record<string, unknown>)[col]) as SQLInputValue[]
            insertStmt.run(...values)
            totalRows++
          }
        } catch (err) {
          // 单表导入失败不应阻断其余表（例如 BLOB 列 JSON 失真无法绑定）
          logger.warn(`[importWiki] 表 ${table} 导入失败:`, err instanceof Error ? err.message : String(err))
        }
      }

      // 若导出侧排除了 BLOB 向量表，旧数据里可能残留该表，这里从结果里排除它的行数干扰
      logger.info(`[importWiki] 导入 ${totalRows} 行`)
      return totalRows
    } catch (err) {
      throw err
    } finally {
      db.close()
    }
  }

  /**
   * 导入 Agent 记忆
   */
  private async importMemories(): Promise<number> {
    const db = await openWritableDb(this.options.dbPath)

    const jsonlFile = path.join(this.options.syncDir, 'memory/agent-memories.jsonl')

    if (!fs.existsSync(jsonlFile)) {
      logger.warn('[importMemories] 记忆文件不存在')
      db.close()
      return 0
    }

    try {
      const content = fs.readFileSync(jsonlFile, 'utf-8')
      const lines = content.split('\n').filter((l) => l.trim())

      let imported = 0

      const upsertStmt = db.prepare(`
        INSERT INTO agent_memories (
          id, agent_id, user_id, category, content,
          importance, tags, created_at, last_used,
          use_count, is_archived
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          importance = CASE
            WHEN excluded.last_used > agent_memories.last_used
            THEN excluded.importance
            ELSE agent_memories.importance
          END,
          last_used = MAX(excluded.last_used, agent_memories.last_used),
          use_count = agent_memories.use_count + excluded.use_count,
          content = excluded.content
      `)

      for (const line of lines) {
        const memory = JSON.parse(line)
        upsertStmt.run(
          memory.id,
          memory.agent_id,
          memory.user_id,
          memory.category,
          memory.content,
          memory.importance,
          memory.tags,
          memory.created_at,
          memory.last_used,
          memory.use_count,
          memory.is_archived,
        )
        imported++
      }

      logger.info(`[importMemories] 导入 ${imported} 条记忆`)
      return imported
    } catch (err) {
      throw err
    } finally {
      db.close()
    }
  }

  /**
   * 导入自主进化数据
   */
  private async importAutonomous(): Promise<number> {
    const db = await openWritableDb(this.options.dbPath)

    const autoDir = path.join(this.options.syncDir, 'autonomous')
    let imported = 0

    const files = [
      'autonomous_goals.json',
      'autonomous_satisfaction_scores.json',
      'autonomous_approval_settings.json',
      'autonomous_diaries.json',
    ]

    try {
      for (const file of files) {
        const filePath = path.join(autoDir, file)
        if (!fs.existsSync(filePath)) continue

        try {
          const content = fs.readFileSync(filePath, 'utf-8')
          const rows = JSON.parse(content)
          if (!Array.isArray(rows) || rows.length === 0) continue

          const table = file.replace('.json', '')
          const row = rows[0] as Record<string, unknown>
          const columns = Object.keys(row)
          const placeholders = columns.map(() => '?').join(', ')

          const insertStmt = db.prepare(`
            INSERT OR REPLACE INTO ${table} (${columns.join(', ')})
            VALUES (${placeholders})
          `)

          for (const r of rows) {
            const values = columns.map((col) => (r as Record<string, unknown>)[col]) as SQLInputValue[]
            insertStmt.run(...values)
            imported++
          }
        } catch (err) {
          logger.warn(`[importAutonomous] 导入 ${file} 失败:`, err)
        }
      }

      logger.info(`[importAutonomous] 导入 ${imported} 条自主数据`)
      return imported
    } finally {
      db.close()
    }
  }

  /**
   * 导入用户文件（同样跳过 .git 等；单文件失败跳过继续）
   */
  private async importUserFiles(): Promise<number> {
    let imported = 0

    const srcFiles = path.join(this.options.syncDir, 'workspace/files')
    const dstFiles = path.join(this.options.workspaceDir, 'files')
    if (fs.existsSync(srcFiles)) {
      imported += copySyncDirectory(srcFiles, dstFiles).copied
    }

    const srcOutputs = path.join(this.options.syncDir, 'workspace/outputs')
    const dstOutputs = path.join(this.options.workspaceDir, 'outputs')
    if (fs.existsSync(srcOutputs)) {
      imported += copySyncDirectory(srcOutputs, dstOutputs).copied
    }

    return imported
  }
}
