/**
 * 本地工作流指令路由。
 *
 * CronScheduler 只负责计时和运行记录，具体业务通过注册 handler 接入。
 * 这样 Dashboard 的默认资讯工作流、未来的飞书进度/工作日报工作流共享
 * 同一条执行通道，而不需要继续向 CronScheduler 添加业务分支。
 */

import {
  readActiveDashboardFeedId,
  readDashboardFeedSnapshot,
  writeDashboardFeedSnapshot,
  type DashboardFeedSnapshot,
} from './dashboard-feed-store'
import {
  LEGACY_NEWS_PIPELINE_INSTRUCTION,
  NEWS_PIPELINE_INSTRUCTION,
  runNewsPipeline,
} from './news-store'

export const WORKFLOW_INSTRUCTION_PREFIX = '__lumii_workflow__:'

export interface WorkflowRuntimeDeps {
  callLLM?: (prompt: string, purpose: string) => Promise<string>
}

export interface WorkflowRunResult {
  summary: string
  /** 有展示内容的工作流可以直接返回规范化 feed，运行时负责落盘。 */
  snapshot?: DashboardFeedSnapshot
}

export type WorkflowHandler = (deps: WorkflowRuntimeDeps) => Promise<WorkflowRunResult>

const workflowHandlers = new Map<string, WorkflowHandler>()

function normalizeWorkflowId(workflowId: string): string {
  const normalized = workflowId.trim()
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(normalized)) {
    throw new Error(`非法工作流 id: ${workflowId}`)
  }
  return normalized
}

export function workflowInstruction(workflowId: string): string {
  return `${WORKFLOW_INSTRUCTION_PREFIX}${normalizeWorkflowId(workflowId)}`
}

export function registerWorkflow(workflowId: string, handler: WorkflowHandler): void {
  workflowHandlers.set(normalizeWorkflowId(workflowId), handler)
}

export function hasWorkflow(workflowId: string): boolean {
  return workflowHandlers.has(normalizeWorkflowId(workflowId))
}

export async function runWorkflow(
  workflowId: string,
  deps: WorkflowRuntimeDeps = {},
): Promise<WorkflowRunResult> {
  const normalizedId = normalizeWorkflowId(workflowId)
  const handler = workflowHandlers.get(normalizedId)
  if (!handler) throw new Error(`未注册的本地工作流: ${normalizedId}`)

  const result = await handler(deps)
  if (result.snapshot) await writeDashboardFeedSnapshot(result.snapshot)
  return result
}

/**
 * 将 Cron 的 task_text 转成工作流执行。
 * 旧版资讯指令保留兼容，否则升级后已有数据库任务会退化成普通提醒。
 */
export async function handleWorkflowInstruction(
  instruction: string,
  deps: WorkflowRuntimeDeps = {},
): Promise<string | null> {
  const trimmed = instruction.trim()
  let workflowId: string | null = null
  if (trimmed === NEWS_PIPELINE_INSTRUCTION || trimmed === LEGACY_NEWS_PIPELINE_INSTRUCTION) {
    workflowId = 'news'
  } else if (trimmed.startsWith(WORKFLOW_INSTRUCTION_PREFIX)) {
    workflowId = trimmed.slice(WORKFLOW_INSTRUCTION_PREFIX.length)
  }
  if (!workflowId) return null

  return (await runWorkflow(workflowId, deps)).summary
}

export async function runActiveDashboardFeedWorkflow(
  deps: WorkflowRuntimeDeps = {},
): Promise<WorkflowRunResult> {
  return runWorkflow(await readActiveDashboardFeedId(), deps)
}

// 内置默认工作流。其他工作流只需在启动阶段调用 registerWorkflow()。
registerWorkflow('news', async (deps) => ({
  summary: await runNewsPipeline(deps),
  snapshot: await readDashboardFeedSnapshot('news') ?? undefined,
}))
