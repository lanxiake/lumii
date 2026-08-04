/**
 * SkillExecutionLogger - 技能执行日志持久化
 *
 * 使用 JSONL 格式存储在本地磁盘，按天分割文件
 * 支持查询、过滤、分页、清理和统计
 *
 * 日志目录结构：
 *   客户端数据根下 logs/skills/（默认 ~/.lumii/logs/skills/）
 *   ├── execution-2026-02-24.jsonl
 *   ├── execution-2026-02-23.jsonl
 *   └── ...
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { createLogger } from './logger'

/** 日志 */
const log = createLogger('SkillExecutionLogger')

/**
 * 执行日志条目
 */
export interface ExecutionLogEntry {
  /** 唯一 ID */
  id: string
  /** 执行请求 ID */
  requestId: string
  /** 技能 ID */
  skillId: string
  /** 技能名称 */
  skillName: string
  /** 运行时类型 */
  runtime: string
  /** 执行参数（脱敏后） */
  params: Record<string, unknown>
  /** 开始时间 ISO 8601 */
  startedAt: string
  /** 执行耗时 ms */
  executionTimeMs: number
  /** 是否成功 */
  success: boolean
  /** 返回结果摘要（截断到 1KB） */
  resultSummary?: string
  /** 错误信息 */
  error?: string
  /** 退出码 */
  exitCode: number | null
  /** stdout 截断到 4KB */
  stdout: string
  /** stderr 截断到 4KB */
  stderr: string
}

/** 日志文件名前缀 */
const LOG_FILE_PREFIX = 'execution-'
/** 日志文件扩展名 */
const LOG_FILE_EXT = '.jsonl'

/**
 * 格式化日期为 YYYY-MM-DD
 */
function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 从日志文件名中提取日期字符串
 *
 * @param fileName - 文件名，如 execution-2026-02-24.jsonl
 * @returns 日期字符串，如 2026-02-24，无效时返回 null
 */
function extractDateFromFileName(fileName: string): string | null {
  if (!fileName.startsWith(LOG_FILE_PREFIX) || !fileName.endsWith(LOG_FILE_EXT)) {
    return null
  }
  const dateStr = fileName.slice(LOG_FILE_PREFIX.length, -LOG_FILE_EXT.length)
  // 简单校验 YYYY-MM-DD 格式
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return null
  }
  return dateStr
}

/**
 * 技能执行日志管理器
 *
 * 提供本地 JSONL 格式的执行日志持久化、查询和清理功能
 */
export class SkillExecutionLogger {
  private readonly logDir: string

  constructor(logDir: string) {
    this.logDir = logDir
  }

  /**
   * 初始化日志目录
   */
  async initialize(): Promise<void> {
    log.info('初始化技能执行日志目录', { logDir: this.logDir })
    await fs.promises.mkdir(this.logDir, { recursive: true })
    log.info('技能执行日志目录就绪')
  }

  /**
   * 记录一次技能执行
   *
   * @param entry - 执行日志条目（不含 id）
   * @returns 生成的日志 ID
   */
  async logExecution(entry: Omit<ExecutionLogEntry, 'id'>): Promise<string> {
    const id = crypto.randomUUID()
    const fullEntry: ExecutionLogEntry = { id, ...entry }

    const dateStr = formatDate(new Date())
    const filePath = path.join(this.logDir, `${LOG_FILE_PREFIX}${dateStr}${LOG_FILE_EXT}`)

    const line = JSON.stringify(fullEntry) + '\n'
    await fs.promises.appendFile(filePath, line, 'utf-8')

    log.debug('执行日志已记录', {
      id,
      skillId: entry.skillId,
      success: entry.success,
      executionTimeMs: entry.executionTimeMs,
    })

    return id
  }

  /**
   * 查询执行日志
   *
   * @param filter - 查询过滤条件
   * @returns 匹配的日志条目和总数
   */
  async queryLogs(filter: {
    skillId?: string
    dateFrom?: string
    dateTo?: string
    success?: boolean
    limit?: number
    offset?: number
  }): Promise<{ entries: ExecutionLogEntry[]; total: number }> {
    log.debug('查询执行日志', filter)

    // 1. 列出所有日志文件
    const logFiles = await this.listLogFiles()

    // 2. 按日期范围筛选文件
    const filteredFiles = logFiles.filter((f) => {
      const dateStr = extractDateFromFileName(f)
      if (!dateStr) {return false}
      if (filter.dateFrom && dateStr < filter.dateFrom) {return false}
      if (filter.dateTo && dateStr > filter.dateTo) {return false}
      return true
    })

    // 3. 读取所有匹配文件中的条目
    const allEntries: ExecutionLogEntry[] = []
    for (const fileName of filteredFiles.toSorted()) {
      const filePath = path.join(this.logDir, fileName)
      const entries = await this.readLogFile(filePath)
      allEntries.push(...entries)
    }

    // 4. 应用字段过滤
    const filtered = allEntries.filter((entry) => {
      if (filter.skillId && entry.skillId !== filter.skillId) {return false}
      if (filter.success !== undefined && entry.success !== filter.success) {return false}
      return true
    })

    const total = filtered.length

    // 5. 分页
    const offset = filter.offset ?? 0
    const limit = filter.limit ?? filtered.length
    const paged = filtered.slice(offset, offset + limit)

    return { entries: paged, total }
  }

  /**
   * 清理指定天数之前的日志
   *
   * @param daysBefore - 删除多少天之前的日志
   * @returns 删除的文件数
   */
  async clearOldLogs(daysBefore: number): Promise<number> {
    log.info('清理旧日志', { daysBefore })

    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - daysBefore)
    const cutoffStr = formatDate(cutoffDate)

    const logFiles = await this.listLogFiles()
    let deletedCount = 0

    for (const fileName of logFiles) {
      const dateStr = extractDateFromFileName(fileName)
      if (!dateStr) {continue}

      // 严格小于截止日期才删除
      if (dateStr < cutoffStr) {
        const filePath = path.join(this.logDir, fileName)
        await fs.promises.unlink(filePath)
        deletedCount++
        log.info('已删除旧日志文件', { fileName })
      }
    }

    log.info('日志清理完成', { deletedCount })
    return deletedCount
  }

  /**
   * 获取日志统计信息
   *
   * @returns 统计数据
   */
  async getStats(): Promise<{
    totalExecutions: number
    successCount: number
    failureCount: number
    totalLogFiles: number
    totalLogSizeBytes: number
  }> {
    const logFiles = await this.listLogFiles()

    let totalExecutions = 0
    let successCount = 0
    let failureCount = 0
    let totalLogSizeBytes = 0

    for (const fileName of logFiles) {
      const filePath = path.join(this.logDir, fileName)

      // 计算文件大小
      const stat = await fs.promises.stat(filePath)
      totalLogSizeBytes += stat.size

      // 读取并统计条目
      const entries = await this.readLogFile(filePath)
      totalExecutions += entries.length
      for (const entry of entries) {
        if (entry.success) {
          successCount++
        } else {
          failureCount++
        }
      }
    }

    return {
      totalExecutions,
      successCount,
      failureCount,
      totalLogFiles: logFiles.length,
      totalLogSizeBytes,
    }
  }

  // ============================================================================
  // 私有方法
  // ============================================================================

  /**
   * 列出日志目录中所有 .jsonl 文件
   */
  private async listLogFiles(): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(this.logDir)
      return entries.filter(
        (f) => f.startsWith(LOG_FILE_PREFIX) && f.endsWith(LOG_FILE_EXT),
      )
    } catch {
      return []
    }
  }

  /**
   * 读取单个 JSONL 日志文件
   *
   * @param filePath - 文件绝对路径
   * @returns 解析出的日志条目数组
   */
  private async readLogFile(filePath: string): Promise<ExecutionLogEntry[]> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8')
      const lines = content.trim().split('\n').filter(Boolean)
      const entries: ExecutionLogEntry[] = []

      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as ExecutionLogEntry)
        } catch {
          log.warn('跳过无法解析的日志行', { filePath })
        }
      }

      return entries
    } catch {
      log.warn('读取日志文件失败', { filePath })
      return []
    }
  }
}
