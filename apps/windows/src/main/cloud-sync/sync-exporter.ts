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
import type { CopySyncDirectoryResult } from './sync-copy'
import { appendSyncLog } from './sync-log'
import { isExcluded, isForceIncluded, type SyncScopeRules } from './sync-scope'

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
  /**
   * 已确认放行的待删集合指纹（来自用户在设置页的显式确认）。
   * 只有本次实际待删集合的指纹与之完全一致时才跳过安全阀；
   * 自动触发的同步永远拿不到匹配值，因此不会自行放行批量删除。
   */
  confirmedMassDeleteFingerprint?: string
  /**
   * outputs 单文件同步上限（字节）。缺省用 SYNC_OUTPUTS_MAX_BYTES。
   *
   * 分级传输（T4.3）后由 `CloudSyncConfig.smallFileThresholdBytes` 驱动 ——
   * 超过此值的文件不进 sync 工作区、改由阶段二队列分批传（T4.4）。
   */
  outputsMaxBytes?: number
  /** 同步范围规则（排除 / 强制包含），缺省视为空规则 */
  scopeRules?: SyncScopeRules
}

export interface SyncExportResult {
  success: boolean
  exportedFiles: string[]
  errors: string[]
  timestamp: string
  /** 本次镜像删除被安全阀挡下（源目录可能异常，删除未传播） */
  deleteAborted: boolean
  /** 挡下时的待删集合指纹（用户确认时需原样回传；集合变化则指纹变化，确认自动失效） */
  abortedFingerprint?: string
  /** 挡下时的待删条目数（供 UI 展示） */
  abortedCount?: number
  /**
   * 因超 maxSize 未导出的文件（**仓库相对路径**，如 `workspace/outputs/x.mp4`）。
   *
   * 供 stageAllChanges 排除：这些文件不在工作区却可能存在于 HEAD，
   * 不排除的话会被判成「已删除」—— 分级传输下阶段一每跑一次就删一次阶段二的大文件。
   */
  skippedLargePaths: string[]
}

export class SyncExporter {
  private options: SyncExportOptions
  /** 本次导出中任一子树的镜像删除被安全阀挡下 */
  private deleteAborted = false
  /** 挡下时的待删集合指纹与条目数（多子树被挡时取首个） */
  private abortedFingerprint: string | undefined
  private abortedCount: number | undefined
  /** 本次导出中因超 maxSize 跳过的文件（仓库相对路径，`/` 分隔） */
  private skippedLargePaths: string[] = []

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
        exportedFiles.push('profile/soul.md', 'profile/user-memory.md', 'profile/scene-memory/')
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
        const fileErrors = await this.exportUserFiles()
        exportedFiles.push('workspace/files/**')
        errors.push(...fileErrors)
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
        deleteAborted: this.deleteAborted,
        abortedFingerprint: this.abortedFingerprint,
        abortedCount: this.abortedCount,
        skippedLargePaths: this.skippedLargePaths,
      }
    } catch (err) {
      logger.error('[export] 导出失败:', err)
      throw err
    }
  }

  /**
   * 轻量导出：只导出「用户文件类」内容（profile + workspace/files + workspace/outputs），
   * 跳过数据库全量 dump。
   *
   * 用途有二，都需要「本地改动立刻进 git 成为一次 commit」而不重写整份 jsonl：
   *  1. 同步流程第 0 步 —— 把本地改动固定成三方合并的 ours（等价于 Unison 的 archive）
   *  2. 文件监听触发的自动 commit —— 避免每次编辑都重扫全表
   */
  async exportLocalEdits(): Promise<SyncExportResult> {
    const timestamp = new Date().toISOString()
    const exportedFiles: string[] = []
    const errors: string[] = []

    this.ensureSyncDirectories()

    try {
      await this.exportProfile()
      exportedFiles.push('profile/soul.md', 'profile/user-memory.md', 'profile/scene-memory/')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('[exportLocalEdits] Profile 导出失败:', msg)
      errors.push(`profile: ${msg}`)
    }

    try {
      const fileErrors = await this.exportUserFiles()
      exportedFiles.push('workspace/files/**', 'workspace/outputs/**')
      errors.push(...fileErrors)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('[exportLocalEdits] 用户文件导出失败:', msg)
      errors.push(`workspace: ${msg}`)
    }

    logger.info(`[exportLocalEdits] 完成，错误 ${errors.length}`)
    return {
      success: errors.length === 0,
      exportedFiles,
      errors,
      timestamp,
      deleteAborted: this.deleteAborted,
      abortedFingerprint: this.abortedFingerprint,
      abortedCount: this.abortedCount,
      skippedLargePaths: this.skippedLargePaths,
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
   *
   * 源文件不存在时**跳过而非写默认值**：写默认内容会把「本机尚未创建」当成
   * 「内容就是默认值」，push 后覆盖掉其他设备上的真实配置。
   * 同理也不做镜像删除 —— 新设备首次同步时 data/ 本就可能是空的，
   * 那不是「用户删了 soul.md」的信号。
   */
  private async exportProfile(): Promise<void> {
    const profileDir = path.join(this.options.syncDir, 'profile')

    // 复制 soul.md
    const soulSrc = path.join(this.options.dataDir, 'soul.md')
    const soulDst = path.join(profileDir, 'soul.md')
    if (fs.existsSync(soulSrc)) {
      fs.copyFileSync(soulSrc, soulDst)
    } else {
      logger.info('[exportProfile] soul.md 不存在，跳过（不写默认值）')
    }

    // 复制 user-memory.md
    const memSrc = path.join(this.options.dataDir, 'user-memory.md')
    const memDst = path.join(profileDir, 'user-memory.md')
    if (fs.existsSync(memSrc)) {
      fs.copyFileSync(memSrc, memDst)
    } else {
      logger.info('[exportProfile] user-memory.md 不存在，跳过（不写默认值）')
    }

    // 复制场景记忆目录（无目录项目 + 渠道记忆）
    // 有目录项目的记忆在 <项目>/.lumii/memory.md，随项目自身管理（git 等），不纳入同步
    const sceneSrc = path.join(this.options.dataDir, 'scene-memory')
    const sceneDst = path.join(profileDir, 'scene-memory')
    if (fs.existsSync(sceneSrc)) {
      fs.rmSync(sceneDst, { recursive: true, force: true })
      fs.cpSync(sceneSrc, sceneDst, { recursive: true })
    }
  }

  /**
   * 导出 Wiki 知识库（JSONL 格式，每表一个文件，每行一条记录）
   *
   * 设计：docs/design/数据同步功能/2026-09-09-轻量云同步设计.md
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
      // 表不存在或查询失败：保持 sync 侧现有文件不动。
      // 绝不写空文件 —— 空 jsonl 与「整表已删」无法区分，会把导出故障放大成数据事故。
      logger.warn(`[exportTableToJsonl] 表 ${tableName} 不存在或查询失败，保持现有导出文件不变`)
    }
  }

  /**
   * 导出 Agent 记忆（JSONL 格式）
   *
   * 设计：docs/design/数据同步功能/2026-09-09-轻量云同步设计.md
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
        // V47 起的三个新列一并导出，否则跨设备同步后对端拿不到活动时间与曝光计数
        const memories = db.prepare(`
          SELECT id, agent_id, user_id, category, content,
                 importance, tags, created_at, last_used,
                 use_count, is_archived, deleted_at,
                 last_injected_at, exposure_count, utility_count
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
      // 表不存在或导出失败：保持 sync 侧现有文件不动（同 exportTableToJsonl，不写空文件）
      logger.warn('[exportMemories] agent_memories 表不存在或导出失败，保持现有导出文件不变')
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
          // 同 exportTableToJsonl：不写 '[]'，避免把导出故障伪装成「表已清空」
          logger.warn(`[exportAutonomous] 表 ${table} 不存在或导出失败，保持现有导出文件不变`)
        }
      }
    } finally {
      db.close()
    }
  }

  /**
   * 导出用户文件（跳过 .git 等重目录；outputs 单文件 >5MB 跳过；单文件失败不阻断）
   *
   * 开启镜像：本地删掉的文件要从 sync 侧一并删除，否则 git 看不到变更，
   * 删除既进不了 commit，下次 import 还会把残留文件复制回本地（「删了又回来」）。
   * 镜像删除自带安全阀（见 sync-copy），源目录异常时整批放弃而非误删。
   */
  private async exportUserFiles(): Promise<string[]> {
    const errors: string[] = []
    const copyOpts = this.options.confirmedMassDeleteFingerprint
      ? { confirmedFingerprint: this.options.confirmedMassDeleteFingerprint }
      : {}

    const srcFiles = path.join(this.options.workspaceDir, 'files')
    const dstFiles = path.join(this.options.syncDir, 'workspace/files')
    if (fs.existsSync(srcFiles)) {
      const rules = this.options.scopeRules
      const r = copySyncDirectory(srcFiles, dstFiles, {
        mirror: true,
        skipUnchanged: true,
        ...copyOpts,
        // 排除规则在 files/ 同样生效（设计 §4.5：排除者「永不参与同步」，未限定目录）。
        // files/ 没有阈值，故不传 shouldForceInclude —— 强制包含的语义是「无视阈值」，
        // 在没有阈值的地方无意义。被排除的项不复制、也不计入镜像待删集合。
        ...(rules ? { shouldSkipFile: (rel: string) => isExcluded(rel, rules) } : {}),
      })
      errors.push(...r.errors)
      if (r.skippedExcluded > 0) {
        logger.info(`[exportUserFiles] files 因范围规则跳过 ${r.skippedExcluded} 个`)
      }
      this.logMirrorResult('workspace/files', r)
    }

    const srcOutputs = path.join(this.options.workspaceDir, 'outputs')
    const dstOutputs = path.join(this.options.syncDir, 'workspace/outputs')
    if (fs.existsSync(srcOutputs)) {
      const maxBytes = this.options.outputsMaxBytes ?? SYNC_OUTPUTS_MAX_BYTES
      const rules = this.options.scopeRules
      const r = copySyncDirectory(srcOutputs, dstOutputs, {
        maxSize: maxBytes,
        mirror: true,
        skipUnchanged: true,
        ...copyOpts,
        // 同步范围规则：排除者永不参与；强制包含者无视阈值（排除优先）
        ...(rules
          ? {
              shouldSkipFile: (rel: string) => isExcluded(rel, rules),
              shouldForceInclude: (rel: string) => isForceIncluded(rel, rules),
            }
          : {}),
      })
      errors.push(...r.errors)
      if (r.skippedExcluded > 0) {
        logger.info(`[exportUserFiles] outputs 因范围规则跳过 ${r.skippedExcluded} 个`)
      }
      if (r.skippedUnchanged > 0) {
        logger.info(`[exportUserFiles] outputs 未变更跳过 ${r.skippedUnchanged} 个`)
      }
      if (r.skippedLarge > 0) {
        logger.info(`[exportUserFiles] outputs 跳过大文件 ${r.skippedLarge} 个（阈值 ${maxBytes} bytes）`)
      }
      // 记下跳过的文件（转成仓库相对路径）：stageAllChanges 必须排除它们，
      // 否则「不在工作区但存在于 HEAD」会被判成删除 —— 分级传输下这是致命的
      for (const abs of r.skippedLargePaths) {
        this.skippedLargePaths.push(
          'workspace/outputs/' + path.relative(srcOutputs, abs).split(path.sep).join('/'),
        )
      }
      if (r.skippedDirs > 0) {
        logger.info(`[exportUserFiles] 跳过目录 ${r.skippedDirs} 个（含 .git/node_modules 等）`)
      }
      this.logMirrorResult('workspace/outputs', r)
    }

    // 单文件失败已在 copy 内跳过；仅告警，不阻断整次导出（避免偶发 EPERM 拖垮同步）
    if (errors.length > 0) {
      logger.warn(
        `[exportUserFiles] ${errors.length} 个文件复制失败已跳过: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? ' …' : ''}`,
      )
    }
    return errors
  }

  /** 记录镜像删除结果；阈值熔断时明确告警，让用户知道删除没传播出去 */
  private logMirrorResult(label: string, r: CopySyncDirectoryResult): void {
    if (r.deleted > 0) {
      logger.info(`[exportUserFiles] ${label} 镜像删除 ${r.deleted} 项`)
    }
    if (r.deleteAborted) {
      this.deleteAborted = true
      // 取首个被挡下子树的指纹：多子树同时被挡时以先到者为准
      if (!this.abortedFingerprint) {
        this.abortedFingerprint = r.abortedFingerprint
        this.abortedCount = r.abortedCount
      }
      const msg =
        `${label} 本次删除未同步出去：待删条目超安全阈值（源目录可能异常，或一次删得太多）。` +
        `已挡下，需在设置页显式确认后才会执行。`
      logger.warn(`[exportUserFiles] ${msg}`)
      // 写进同步日志（设置页「同步日志」可见），否则用户会以为删除已生效
      appendSyncLog('error', msg)
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
