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

      // 3. 导入 Wiki（JSONL 格式，每表一个文件）
      logger.info('[import] 3. 导入 Wiki 知识库...')
      try {
        stats.wikiRows = await this.importWiki()
        importedFiles.push('wiki/*.jsonl')
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

    // 导入场景记忆目录（无目录项目 + 渠道记忆）；整目录覆盖，与 user-memory.md 的覆盖语义一致
    const sceneSrc = path.join(profileDir, 'scene-memory')
    const sceneDst = path.join(this.options.dataDir, 'scene-memory')
    if (fs.existsSync(sceneSrc)) {
      fs.rmSync(sceneDst, { recursive: true, force: true })
      fs.cpSync(sceneSrc, sceneDst, { recursive: true })
    }
  }

  /**
   * 导入 Wiki（从 JSONL，每表一个文件）
   *
   * 设计：docs/superpowers/specs/2026-09-09-lightweight-cloud-sync-design.md
   * - 按时间戳merge规则合并：remote_ts > local_ts 则覆盖
   * - 相同时间戳时，优先传播删除操作（remote.deleted_at 非空且 local.deleted_at 为空）
   * - 在事务中执行，确保一致性
   * - 支持旧格式迁移：自动检测并转换 data.json → jsonl
   */
  private async importWiki(): Promise<number> {
    const wikiDir = path.join(this.options.syncDir, 'wiki')

    // 检测旧格式（data.json）并执行一次性迁移
    const oldJsonFile = path.join(wikiDir, 'data.json')
    if (fs.existsSync(oldJsonFile)) {
      logger.info('[importWiki] 检测到旧格式 data.json，执行迁移...')
      return await this.migrateFromOldFormat(oldJsonFile, wikiDir)
    }

    // 新格式：JSONL 文件
    // Wiki 核心表配置：表名 → (主键字段, 时间戳字段, 删除标记字段)
    const wikiTables: Record<string, { pk: string; ts: string; del?: string }> = {
      wiki_inbox: { pk: 'id', ts: 'created_at' },
      wiki_sources: { pk: 'id', ts: 'created_at' },
      wiki_entities: { pk: 'id', ts: 'updated_at', del: 'deleted_at' },
      wiki_observations: { pk: 'id', ts: 'created_at' },
      wiki_relations: { pk: 'id', ts: 'updated_at', del: 'deleted_at' },
      wiki_syntheses: { pk: 'id', ts: 'created_at', del: 'deleted_at' },
      wiki_organize_runs: { pk: 'id', ts: 'created_at' },
    }

    const db = await openWritableDb(this.options.dbPath)
    let totalRows = 0

    try {
      db.exec('BEGIN IMMEDIATE TRANSACTION')

      try {
        for (const [table, config] of Object.entries(wikiTables)) {
          const jsonlFile = path.join(wikiDir, `${table}.jsonl`)
          if (!fs.existsSync(jsonlFile)) continue

          const content = fs.readFileSync(jsonlFile, 'utf-8')
          const lines = content.split('\n').filter((l) => l.trim())
          if (lines.length === 0) continue

          for (const line of lines) {
            const remoteRow = JSON.parse(line) as Record<string, SQLInputValue>
            const merged = await this.mergeRecord(db, table, remoteRow, config)
            if (merged) totalRows++
          }
        }

        db.exec('COMMIT')
        logger.info(`[importWiki] 导入/合并 ${totalRows} 行`)
        return totalRows
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    } finally {
      db.close()
    }
  }

  /**
   * 从旧格式（data.json）迁移到新格式（JSONL）
   *
   * 流程：
   * 1. 读取 data.json
   * 2. 按新 merge 规则导入到数据库
   * 3. 生成 JSONL 文件
   * 4. 删除 data.json
   */
  private async migrateFromOldFormat(oldJsonFile: string, wikiDir: string): Promise<number> {
    logger.info('[migrateFromOldFormat] 开始迁移旧格式...')

    const content = fs.readFileSync(oldJsonFile, 'utf-8')
    const data = JSON.parse(content) as Record<string, unknown[]>

    // Wiki 表配置（与新格式相同）
    const wikiTables: Record<string, { pk: string; ts: string; del?: string }> = {
      wiki_inbox: { pk: 'id', ts: 'created_at' },
      wiki_sources: { pk: 'id', ts: 'created_at' },
      wiki_entities: { pk: 'id', ts: 'updated_at', del: 'deleted_at' },
      wiki_observations: { pk: 'id', ts: 'created_at' },
      wiki_relations: { pk: 'id', ts: 'updated_at', del: 'deleted_at' },
      wiki_syntheses: { pk: 'id', ts: 'created_at', del: 'deleted_at' },
      wiki_organize_runs: { pk: 'id', ts: 'created_at' },
    }

    const db = await openWritableDb(this.options.dbPath)
    let totalRows = 0

    try {
      db.exec('BEGIN IMMEDIATE TRANSACTION')

      try {
        // 导入数据到数据库（使用 merge 规则）
        for (const [table, config] of Object.entries(wikiTables)) {
          const rows = data[table] as Array<Record<string, SQLInputValue>> | undefined
          if (!rows || rows.length === 0) continue

          for (const row of rows) {
            const merged = await this.mergeRecord(db, table, row, config)
            if (merged) totalRows++
          }
        }

        db.exec('COMMIT')
        logger.info(`[migrateFromOldFormat] 导入 ${totalRows} 行到数据库`)

        // 生成 JSONL 文件
        for (const [table, config] of Object.entries(wikiTables)) {
          const rows = data[table] as Array<Record<string, SQLInputValue>> | undefined
          if (!rows || rows.length === 0) {
            // 写入空文件
            fs.writeFileSync(path.join(wikiDir, `${table}.jsonl`), '')
            continue
          }

          const lines = rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
          fs.writeFileSync(path.join(wikiDir, `${table}.jsonl`), lines)
        }

        // 删除旧文件
        fs.unlinkSync(oldJsonFile)
        logger.info('[migrateFromOldFormat] 已删除旧格式文件 data.json')
        logger.info('[migrateFromOldFormat] 迁移完成')

        return totalRows
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    } finally {
      db.close()
    }
  }

  /**
   * 合并单条记录（时间戳规则）
   *
   * @param db 数据库连接
   * @param table 表名
   * @param remoteRow 远端记录
   * @param config 表配置（主键、时间戳、删除字段）
   * @returns 是否执行了插入/更新
   */
  private async mergeRecord(
    db: InstanceType<typeof DatabaseSync>,
    table: string,
    remoteRow: Record<string, SQLInputValue>,
    config: { pk: string; ts: string; del?: string },
  ): Promise<boolean> {
    const pk = remoteRow[config.pk]
    const remoteTs = remoteRow[config.ts] as string

    // 查询本地记录
    const localRow = db
      .prepare(`SELECT * FROM ${table} WHERE ${config.pk} = ?`)
      .get(pk) as Record<string, SQLInputValue> | undefined

    // 情况 1：本地没有，直接插入
    if (!localRow) {
      this.insertRow(db, table, remoteRow)
      return true
    }

    const localTs = localRow[config.ts] as string

    // 情况 2：远端更新（时间戳更大），覆盖本地
    if (remoteTs > localTs) {
      this.updateRow(db, table, remoteRow, config.pk)
      return true
    }

    // 情况 3：本地更新（时间戳更大），保持本地
    if (remoteTs < localTs) {
      return false
    }

    // 情况 4：时间戳相同，检查删除标记
    if (config.del) {
      const remoteDel = remoteRow[config.del]
      const localDel = localRow[config.del]

      // 优先传播删除操作
      if (remoteDel !== null && remoteDel !== undefined && (localDel === null || localDel === undefined)) {
        this.updateRow(db, table, remoteRow, config.pk)
        return true
      }
    }

    // 情况 5：时间戳相同且没有删除差异，保持本地
    return false
  }

  /**
   * 插入记录
   */
  private insertRow(
    db: InstanceType<typeof DatabaseSync>,
    table: string,
    row: Record<string, SQLInputValue>,
  ): void {
    const columns = Object.keys(row)
    const placeholders = columns.map(() => '?').join(', ')
    const values = columns.map((col) => row[col])

    db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`).run(...values)
  }

  /**
   * 更新记录
   */
  private updateRow(
    db: InstanceType<typeof DatabaseSync>,
    table: string,
    row: Record<string, SQLInputValue>,
    pkField: string,
  ): void {
    const columns = Object.keys(row).filter((col) => col !== pkField)
    const setClause = columns.map((col) => `${col} = ?`).join(', ')
    const values = [...columns.map((col) => row[col]), row[pkField]]

    db.prepare(`UPDATE ${table} SET ${setClause} WHERE ${pkField} = ?`).run(...values)
  }

  /**
   * 导入 Agent 记忆（JSONL 格式）
   *
   * 设计：docs/superpowers/specs/2026-09-09-lightweight-cloud-sync-design.md
   * - 按时间戳merge规则：比较 last_used 字段
   * - remote.last_used > local.last_used 则覆盖整条记录
   * - 时间戳相同时，优先传播删除操作（deleted_at）
   * - 在事务中执行
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

      db.exec('BEGIN IMMEDIATE TRANSACTION')

      try {
        for (const line of lines) {
          const remoteRow = JSON.parse(line) as Record<string, SQLInputValue>
          const merged = await this.mergeMemory(db, remoteRow)
          if (merged) imported++
        }

        db.exec('COMMIT')
        logger.info(`[importMemories] 导入/合并 ${imported} 条记忆`)
        return imported
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    } finally {
      db.close()
    }
  }

  /**
   * 合并单条记忆记录（时间戳规则）
   */
  private async mergeMemory(
    db: InstanceType<typeof DatabaseSync>,
    remoteRow: Record<string, SQLInputValue>,
  ): Promise<boolean> {
    const id = remoteRow.id
    const remoteTs = remoteRow.last_used as string

    // 查询本地记录
    const localRow = db
      .prepare('SELECT * FROM agent_memories WHERE id = ?')
      .get(id) as Record<string, SQLInputValue> | undefined

    // 情况 1：本地没有，直接插入
    if (!localRow) {
      const columns = Object.keys(remoteRow)
      const placeholders = columns.map(() => '?').join(', ')
      const values = columns.map((col) => remoteRow[col])

      db.prepare(`INSERT INTO agent_memories (${columns.join(', ')}) VALUES (${placeholders})`).run(...values)
      return true
    }

    const localTs = localRow.last_used as string

    // 情况 2：远端更新（时间戳更大），覆盖本地
    if (remoteTs > localTs) {
      const columns = Object.keys(remoteRow).filter((col) => col !== 'id')
      const setClause = columns.map((col) => `${col} = ?`).join(', ')
      const values = [...columns.map((col) => remoteRow[col]), id]

      db.prepare(`UPDATE agent_memories SET ${setClause} WHERE id = ?`).run(...values)
      return true
    }

    // 情况 3：本地更新（时间戳更大），保持本地
    if (remoteTs < localTs) {
      return false
    }

    // 情况 4：时间戳相同，检查删除标记
    const remoteDel = remoteRow.deleted_at
    const localDel = localRow.deleted_at

    // 优先传播删除操作
    if (remoteDel !== null && remoteDel !== undefined && (localDel === null || localDel === undefined)) {
      const columns = Object.keys(remoteRow).filter((col) => col !== 'id')
      const setClause = columns.map((col) => `${col} = ?`).join(', ')
      const values = [...columns.map((col) => remoteRow[col]), id]

      db.prepare(`UPDATE agent_memories SET ${setClause} WHERE id = ?`).run(...values)
      return true
    }

    // 情况 5：时间戳相同且没有删除差异，保持本地
    return false
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
