/**
 * 后台任务进度上报。
 *
 * 把 ComfyUI 跟进文案和通用 MCP 后台工具的阶段，翻译成
 * BackgroundTaskManager 的进度、日志和里程碑调用。
 * 不持有 MCP，便于单测。终态方法必须在 complete / fail 之前调用。
 */

import type { Milestone } from '../../shared/agent-runtime-events'
import type { BackgroundTaskManager } from './background-task-manager'

/** ComfyUI 跟进的四个阶段 */
export const COMFY_STEPS = ['入队', '排队', '渲染', '保存结果'] as const

/** 未区分阶段的后台工具 */
export const GENERIC_STEPS = ['执行', '完成'] as const

/** ComfyUI 跟进文案对应的进度与里程碑 */
export interface ComfyProgressMapping {
  readonly progress: number
  readonly completed: readonly string[]
  readonly active?: string
}

/** 生成全部为 pending 的里程碑 */
export function pendingMilestones(steps: readonly string[]): Milestone[] {
  return steps.map((step) => ({ step, status: 'pending' as const }))
}

/** 把 ComfyUI 跟进文案映射到进度和里程碑步骤 */
export function interpretComfyNote(note: string): ComfyProgressMapping {
  if (note.includes('渲染')) {
    return { progress: 70, completed: ['入队', '排队'], active: '渲染' }
  }
  if (note.includes('排队')) {
    return { progress: 35, completed: ['入队'], active: '排队' }
  }
  return { progress: 15, completed: ['入队'] }
}

/** 当前任务是否已经切到 ComfyUI 四段里程碑 */
function isComfyTask(manager: BackgroundTaskManager, taskId: string): boolean {
  const steps = new Set<string>(COMFY_STEPS)
  return manager.get(taskId)?.milestones?.some((milestone) => steps.has(milestone.step)) ?? false
}

/** 通用后台工具开始：两段里程碑、10% 进度和一条 info 日志 */
export function reportBackgroundToolStart(
  manager: BackgroundTaskManager,
  taskId: string,
  toolName: string,
): void {
  manager.setMilestones(taskId, pendingMilestones(GENERIC_STEPS))
  manager.updateMilestone(taskId, '执行', 'in-progress')
  manager.updateProgress(taskId, 10, '执行中')
  manager.addLog(taskId, 'info', `开始执行 ${toolName}`)
}

/** 通用后台工具结束。必须在 complete / fail 之前调用 */
export function reportBackgroundToolEnd(
  manager: BackgroundTaskManager,
  taskId: string,
  ok: boolean,
  message?: string,
): void {
  if (ok) {
    manager.updateMilestone(taskId, '执行', 'completed')
    manager.updateMilestone(taskId, '完成', 'completed')
    manager.updateProgress(taskId, 100, '完成')
    manager.addLog(taskId, 'info', '工具执行完成')
    return
  }
  manager.updateMilestone(taskId, '执行', 'failed', undefined, message)
  manager.addLog(taskId, 'error', message || '工具执行失败')
}

/** ComfyUI 已入队：换成四段里程碑，并记下 prompt id */
export function reportComfyEnqueued(
  manager: BackgroundTaskManager,
  taskId: string,
  promptId: string,
): void {
  manager.setMilestones(taskId, pendingMilestones(COMFY_STEPS))
  manager.updateMilestone(taskId, '入队', 'completed')
  manager.updateProgress(taskId, 15, `ComfyUI 已入队（prompt_id=${promptId}）`)
  manager.addLog(taskId, 'info', `ComfyUI 已入队 prompt_id=${promptId}`, { promptId })
}

/** ComfyUI 轮询到排队或渲染时更新进度、里程碑和日志 */
export function reportComfyNote(
  manager: BackgroundTaskManager,
  taskId: string,
  note: string,
): void {
  const mapped = interpretComfyNote(note)
  for (const step of mapped.completed) {
    manager.updateMilestone(taskId, step, 'completed')
  }
  if (mapped.active) manager.updateMilestone(taskId, mapped.active, 'in-progress')
  manager.updateProgress(taskId, mapped.progress, note)
  manager.addLog(taskId, 'info', note)
}

/** ComfyUI 跟进结束。必须在 complete / fail 之前调用 */
export function reportComfyFinished(
  manager: BackgroundTaskManager,
  taskId: string,
  ok: boolean,
  message?: string,
): void {
  if (ok) {
    for (const step of COMFY_STEPS) manager.updateMilestone(taskId, step, 'completed')
    manager.updateProgress(taskId, 100, '完成')
    manager.addLog(taskId, 'info', 'ComfyUI 任务完成')
    return
  }
  const active = manager.get(taskId)?.milestones?.find((milestone) => milestone.status === 'in-progress')
  manager.updateMilestone(taskId, active?.step ?? '渲染', 'failed', undefined, message)
  manager.addLog(taskId, 'error', message || 'ComfyUI 任务失败')
}

/** 按当前里程碑选择 ComfyUI 或通用结束上报 */
export function reportTaskSuccess(manager: BackgroundTaskManager, taskId: string): void {
  if (isComfyTask(manager, taskId)) reportComfyFinished(manager, taskId, true)
  else reportBackgroundToolEnd(manager, taskId, true)
}

/** 按当前里程碑选择 ComfyUI 或通用失败上报 */
export function reportTaskFailure(
  manager: BackgroundTaskManager,
  taskId: string,
  message: string,
): void {
  if (isComfyTask(manager, taskId)) reportComfyFinished(manager, taskId, false, message)
  else reportBackgroundToolEnd(manager, taskId, false, message)
}
