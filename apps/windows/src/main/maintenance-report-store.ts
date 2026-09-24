/**
 * 维护体检报告存储
 *
 * 「灵栖维护」的巡检产出落这里，而不是只留在会话里的一段 markdown。落库之后才有：
 * - **最新一期**：概览页卡片能显示它上次查了什么、发现了什么；
 * - **跨期差分**：「上期有、这期没了 = 已解决」由 `diffFindings` 直接从两期数据算出来，
 *   不需要用户手工标记，也不会因为用户忘记标记而反复提醒同一件事；
 * - **可追问**：报告带 conversationId，点一下能回到当时的会话看上下文。
 *
 * 与 `dashboard-feed-store` 同构的注入方式（`setMaintenanceReportDb`）：主进程启动时把
 * 本地库塞进来，单测塞内存库，未就绪时读取返回空、写入抛明确错误。
 */

import { randomUUID } from 'node:crypto'
import type { DatabaseAdapter } from '@mtbot/agent-runtime'

/** 体检覆盖的资产类别；'full' 表示一轮走完全部 */
const MAINTENANCE_SCOPES = ['full', 'memory', 'wiki', 'guides', 'settings', 'workspace'] as const
type MaintenanceScope = (typeof MAINTENANCE_SCOPES)[number]

/** 报告的触发来源：用户使唤 / 定时任务 / 自主运行 */
const MAINTENANCE_TRIGGERS = ['manual', 'cron', 'autonomous'] as const
export type MaintenanceTrigger = (typeof MAINTENANCE_TRIGGERS)[number]

export type MaintenanceSeverity = 'high' | 'medium' | 'low'

export interface MaintenanceFinding {
  /**
   * 跨期稳定的问题标识（如 `memory:duplicate`）。
   * **不能用 title 代替**——title 是给用户看的措辞，模型每期都会改写，
   * 拿它做身份会让「已解决」判定彻底失效。
   */
  key: string
  severity: MaintenanceSeverity
  title: string
  /** 判断依据：数据 / 文件 / 行号 */
  evidence?: string
  /** 建议动作 */
  suggestion?: string
}

export interface MaintenanceReport {
  id: string
  agentId: string
  scope: MaintenanceScope
  /** 一句话结论（概览页卡片正面显示这行） */
  summary: string
  findings: MaintenanceFinding[]
  /** 查过且**没有**问题的项；空数组表示没交代 */
  checked: string[]
  trigger: MaintenanceTrigger
  /** 报告出自哪个会话（可跳回追问） */
  conversationId?: string
  createdAt: string
}

/** 写入入参：id / createdAt 由存储生成 */
export interface MaintenanceReportInput {
  agentId: string
  scope?: string
  summary: string
  findings?: readonly Partial<MaintenanceFinding>[]
  checked?: readonly string[]
  trigger?: string
  conversationId?: string
}

const MAX_FINDINGS = 50
const MAX_CHECKED = 30
const MAX_TITLE = 120
const MAX_SUMMARY = 300
const MAX_EVIDENCE = 400
const MAX_SUGGESTION = 300

interface ReportRow {
  id: string
  agent_id: string
  scope: string
  summary: string
  findings: string
  checked: string | null
  trigger: string
  conversation_id: string | null
  created_at: string
}

let reportDb: DatabaseAdapter | null = null

export function setMaintenanceReportDb(db: DatabaseAdapter | null): void {
  reportDb = db
}

function clampText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

function normalizeScope(value: unknown): MaintenanceScope {
  return (MAINTENANCE_SCOPES as readonly string[]).includes(String(value))
    ? (String(value) as MaintenanceScope)
    : 'full'
}

function normalizeTrigger(value: unknown): MaintenanceTrigger {
  return (MAINTENANCE_TRIGGERS as readonly string[]).includes(String(value))
    ? (String(value) as MaintenanceTrigger)
    : 'manual'
}

function normalizeSeverity(value: unknown): MaintenanceSeverity {
  return value === 'high' || value === 'low' ? value : 'medium'
}

/**
 * 归一化一条发现。
 *
 * 缺 key 时用 title 兜底派生一个（`misc:<title>`）：宁可差分的粒度粗一点，
 * 也不能因为模型偶尔漏字段就把整条丢掉——那等于报告缺口。
 */
function normalizeFinding(raw: Partial<MaintenanceFinding>, index: number): MaintenanceFinding | null {
  const title = clampText(raw.title, MAX_TITLE)
  if (!title) return null
  const key = clampText(raw.key, MAX_TITLE) || `misc:${title}`
  const evidence = clampText(raw.evidence, MAX_EVIDENCE)
  const suggestion = clampText(raw.suggestion, MAX_SUGGESTION)
  return {
    key: key || `misc:${index}`,
    severity: normalizeSeverity(raw.severity),
    title,
    ...(evidence ? { evidence } : {}),
    ...(suggestion ? { suggestion } : {}),
  }
}

/** 写入一期体检报告；summary 为空时抛错（报告没有结论等于没写） */
export async function writeMaintenanceReport(input: MaintenanceReportInput): Promise<MaintenanceReport> {
  if (!reportDb) throw new Error('维护报告存储未就绪')
  const summary = clampText(input.summary, MAX_SUMMARY)
  if (!summary) throw new Error('summary 不能为空')

  const findings = (input.findings ?? [])
    .slice(0, MAX_FINDINGS)
    .map((f, i) => normalizeFinding(f, i))
    .filter((f): f is MaintenanceFinding => f !== null)
  const checked = (input.checked ?? [])
    .map((c) => clampText(c, MAX_TITLE))
    .filter(Boolean)
    .slice(0, MAX_CHECKED)

  const report: MaintenanceReport = {
    id: randomUUID(),
    agentId: clampText(input.agentId, 80) || 'system-keeper',
    scope: normalizeScope(input.scope),
    summary,
    findings,
    checked,
    trigger: normalizeTrigger(input.trigger),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    createdAt: new Date().toISOString(),
  }

  reportDb
    .prepare(
      `INSERT INTO maintenance_reports
         (id, agent_id, scope, summary, findings, checked, trigger, conversation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      report.id,
      report.agentId,
      report.scope,
      report.summary,
      JSON.stringify(report.findings),
      JSON.stringify(report.checked),
      report.trigger,
      report.conversationId ?? null,
      report.createdAt,
    )

  return report
}

function rowToReport(row: ReportRow): MaintenanceReport {
  let findings: MaintenanceFinding[] = []
  let checked: string[] = []
  try {
    const parsed = JSON.parse(row.findings)
    if (Array.isArray(parsed)) findings = parsed as MaintenanceFinding[]
  } catch {
    /* 坏数据当作没有发现，不让一行脏数据打挂整张卡片 */
  }
  try {
    const parsed = row.checked ? JSON.parse(row.checked) : []
    if (Array.isArray(parsed)) checked = parsed.filter((c): c is string => typeof c === 'string')
  } catch {
    /* 同上 */
  }
  return {
    id: row.id,
    agentId: row.agent_id,
    scope: normalizeScope(row.scope),
    summary: row.summary,
    findings,
    checked,
    trigger: normalizeTrigger(row.trigger),
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    createdAt: row.created_at,
  }
}

/**
 * 按时间倒序列出报告（最新在前）。
 *
 * 平局用 `rowid` 而不是 `id`：`created_at` 只有毫秒精度，同一毫秒内写入的两期
 * （重试、脚本连跑）会撞在一起，而 id 是随机 UUID——用它兜底等于随机排序。
 * rowid 是插入序，正好就是「谁更晚」。
 */
export function listMaintenanceReports(opts: { limit?: number; agentId?: string } = {}): MaintenanceReport[] {
  if (!reportDb) return []
  const limit = Math.max(1, Math.min(50, Math.trunc(opts.limit ?? 10)))
  const rows = opts.agentId
    ? reportDb
        .prepare<ReportRow>(
          `SELECT * FROM maintenance_reports WHERE agent_id = ?
           ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(opts.agentId, limit)
    : reportDb
        .prepare<ReportRow>(`SELECT * FROM maintenance_reports ORDER BY created_at DESC, rowid DESC LIMIT ?`)
        .all(limit)
  return rows.map(rowToReport)
}

/** 最新一期（卡片正面用它）；没有报告时返回 null */
export function readLatestMaintenanceReport(agentId?: string): MaintenanceReport | null {
  return listMaintenanceReports({ limit: 1, ...(agentId ? { agentId } : {}) })[0] ?? null
}

export interface FindingDiff {
  /** 本期新出现的问题 */
  added: MaintenanceFinding[]
  /** 上期有、本期仍存在的问题（标题取本期的措辞） */
  persisting: MaintenanceFinding[]
  /** 上期有、本期没再报的问题——视为已解决（不需要用户手工标记） */
  resolved: MaintenanceFinding[]
}

/**
 * 两期报告的发现差分。
 *
 * 身份用 finding.key，不逐字比对 title：模型每期措辞都会变，
 * 用 title 会导致「同一个问题每期都被当成新增」，差分随即失去意义。
 */
export function diffFindings(
  previous: readonly MaintenanceFinding[],
  current: readonly MaintenanceFinding[],
): FindingDiff {
  const prevKeys = new Set(previous.map((f) => f.key))
  const currKeys = new Set(current.map((f) => f.key))
  return {
    added: current.filter((f) => !prevKeys.has(f.key)),
    persisting: current.filter((f) => prevKeys.has(f.key)),
    resolved: previous.filter((f) => !currKeys.has(f.key)),
  }
}

export const __testables = { clampText, normalizeFinding, rowToReport }
