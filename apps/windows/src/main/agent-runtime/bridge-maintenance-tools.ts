/**
 * 维护体检报告 Agent 工具接线
 *
 * maintenance_report_write / maintenance_report_read —— 「灵栖维护」的巡检产出载体。
 * 报告落 `maintenance_reports` 表，概览页「资产体检」卡片读它。
 *
 * 写工具的两处兜底都在这里做，而不是交给模型：
 * - `agentId` 由当前执行实例反查（`getDefinitionIdByInstanceId`），不采信模型自填；
 * - `conversationId` 由实例反查会话，报告才能点回当时的对话追问；
 * - `trigger` 按实例来源判定：`cron:` 前缀的会话算定时任务，自主会话算 autonomous。
 *
 * 这样一份报告无论由谁、经由哪条路径写出，归属与出处都是准的。
 */

import {
  createMtBotTool,
  maintenanceReportWriteToolConfig,
  maintenanceReportReadToolConfig,
  assetCheckupToolConfig,
  newsPreferenceToolConfig,
  type MtBotToolConfig,
} from '@mtbot/agent-runtime'
import { jsonToolResult } from './bridge-utils'
import { readUserMemoryFile, writeUserMemoryFile } from '../ipc/plugin-ipc'
import {
  NEWS_PREF_FIELDS,
  applyNewsPreference,
  describeNewsPreferences,
  readNewsPreferences,
  type NewsPrefField,
} from '../news-preferences'
import { runMemoryCheckup } from '../asset-checkup'
import type { BridgeToolRegistrarDeps } from './bridge-tool-registrar-types'
import {
  listMaintenanceReports,
  readLatestMaintenanceReport,
  writeMaintenanceReport,
  type MaintenanceFinding,
  type MaintenanceTrigger,
} from '../maintenance-report-store'

/** 按会话前缀判定报告来源（与定时任务/自主会话的 id 约定一致） */
function resolveTrigger(conversationId: string | undefined): MaintenanceTrigger {
  if (!conversationId) return 'manual'
  if (conversationId.startsWith('cron:')) return 'cron'
  if (conversationId.startsWith('evolution:')) return 'autonomous'
  return 'manual'
}

export function registerMaintenanceReportTools(deps: BridgeToolRegistrarDeps): void {
  const ctx = deps.toolContext
  if (!ctx) return

  /** 当前执行实例的 agentId 与所在会话（模型自填不可信，一律反查） */
  const currentIdentity = (): { agentId: string; conversationId?: string } => {
    const instanceId = deps.getCurrentToolExecutorInstanceId()
    if (!instanceId) return { agentId: 'system-keeper' }
    const agentId = deps.getDefinitionIdByInstanceId(instanceId) || 'system-keeper'
    const conversationId = deps.instanceToConversation.get(instanceId)
    return conversationId ? { agentId, conversationId } : { agentId }
  }

  const writeTool: MtBotToolConfig = {
    ...maintenanceReportWriteToolConfig,
    execute: async (_id, rawParams) => {
      const p = rawParams as {
        scope?: string
        summary?: string
        findings?: MaintenanceFinding[]
        checked?: string[]
      }
      if (!p.summary?.trim()) {
        return jsonToolResult({ status: 'error', message: 'summary is required' })
      }
      const { agentId, conversationId } = currentIdentity()
      try {
        const report = await writeMaintenanceReport({
          agentId,
          scope: p.scope,
          summary: p.summary,
          findings: Array.isArray(p.findings) ? p.findings : [],
          checked: Array.isArray(p.checked) ? p.checked : [],
          trigger: resolveTrigger(conversationId),
          ...(conversationId ? { conversationId } : {}),
        })
        return jsonToolResult({
          status: 'ok',
          reportId: report.id,
          findingCount: report.findings.length,
          checkedCount: report.checked.length,
        })
      } catch (err) {
        return jsonToolResult({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
  deps.toolRegistry.register(createMtBotTool(writeTool, ctx))

  const readTool: MtBotToolConfig = {
    ...maintenanceReportReadToolConfig,
    execute: async (_id, rawParams) => {
      const p = rawParams as { limit?: number }
      const limit = Math.max(1, Math.min(10, Math.trunc(Number(p.limit) || 2)))
      try {
        const reports = listMaintenanceReports({ limit })
        return jsonToolResult({
          status: 'ok',
          count: reports.length,
          latest: readLatestMaintenanceReport(),
          reports: reports.map((r) => ({
            id: r.id,
            scope: r.scope,
            summary: r.summary,
            createdAt: r.createdAt,
            trigger: r.trigger,
            findings: r.findings,
            checked: r.checked,
          })),
        })
      } catch (err) {
        return jsonToolResult({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
  deps.toolRegistry.register(createMtBotTool(readTool, ctx))

  /**
   * 机械检查项：预算 / 完全重复 / 序列化残迹 / 指令式话术 / 长期未用 / 过短条目。
   * 由代码判定，结果稳定且不花 token；模型只在此基础上补判断类结论。
   */
  const checkupTool: MtBotToolConfig = {
    ...assetCheckupToolConfig,
    execute: async (_id, rawParams) => {
      const p = rawParams as { scope?: string }
      if (p.scope && p.scope !== 'memory') {
        return jsonToolResult({ status: 'error', message: `unsupported scope: ${p.scope}` })
      }
      try {
        const result = await runMemoryCheckup({
          db: deps.localDb.db,
          readUserMemory: async () => {
            const file = await readUserMemoryFile()
            return file?.content ?? null
          },
          ...(deps.getSegmentStats ? { getSegmentStats: deps.getSegmentStats } : {}),
          ...(deps.getPalaceStats ? { getPalaceStats: deps.getPalaceStats } : {}),
        })
        return jsonToolResult({ status: 'ok', ...result })
      } catch (err) {
        return jsonToolResult({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
  deps.toolRegistry.register(createMtBotTool(checkupTool, ctx))

  /**
   * 资讯偏好的结构化读写。
   *
   * 落在 user-memory.md 的 `## 资讯偏好` 章节：它本来就是用户偏好，用户在记忆页能直接看到、
   * 直接改，`.bak` 备份与注入预算一并继承。读写只碰这一个章节，章节外的内容原样保留。
   */
  const prefTool: MtBotToolConfig = {
    ...newsPreferenceToolConfig,
    execute: async (_id, rawParams) => {
      const p = rawParams as { action?: string; field?: string; value?: string }
      try {
        const file = await readUserMemoryFile()
        const markdown = file?.content ?? ''
        if (p.action === 'read' || !p.action) {
          const prefs = readNewsPreferences(markdown)
          return jsonToolResult({
            status: 'ok',
            preferences: prefs,
            description: describeNewsPreferences(prefs),
          })
        }
        if (p.action !== 'add' && p.action !== 'remove') {
          return jsonToolResult({ status: 'error', message: `unsupported action: ${p.action}` })
        }
        if (!p.field || !NEWS_PREF_FIELDS.includes(p.field as NewsPrefField)) {
          return jsonToolResult({
            status: 'error',
            message: `field 必须是以下之一：${NEWS_PREF_FIELDS.join(' / ')}`,
          })
        }
        if (!p.value?.trim()) {
          return jsonToolResult({ status: 'error', message: 'value is required' })
        }
        const next = applyNewsPreference(markdown, {
          field: p.field as NewsPrefField,
          op: p.action,
          value: p.value,
        })
        const written = await writeUserMemoryFile(next)
        if (!written) return jsonToolResult({ status: 'error', message: '写入个人记忆失败' })
        const prefs = readNewsPreferences(next)
        return jsonToolResult({
          status: 'ok',
          action: p.action,
          preferences: prefs,
          description: describeNewsPreferences(prefs),
        })
      } catch (err) {
        return jsonToolResult({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
  deps.toolRegistry.register(createMtBotTool(prefTool, ctx))

  console.log(
    '[registerMaintenanceReportTools] maintenance_report_write / maintenance_report_read / asset_checkup / news_preference registered',
  )
}
