/**
 * 自主智能体服务 — 封装 window.electronAPI.autonomous 的薄层
 */
import type { AutonomousStatus } from '../../preload/api/autonomous-api'

/** 获取自主智能体状态（满意度 / 待审批目标数 / 能力概览） */
export async function getAutonomousStatus(): Promise<AutonomousStatus> {
  return window.electronAPI.autonomous.getStatus()
}

/** 获取最近目标（全状态，附关联反思，最多 limit 条） */
export async function getGoals(limit?: number) {
  return window.electronAPI.autonomous.getGoals(limit)
}

/** 获取规划器产出的目标（附计划执行时间） */
export async function getPlannedGoals(limit?: number) {
  return window.electronAPI.autonomous.getPlannedGoals(limit)
}

/** 获取能力详情 */
export async function getCapabilities() {
  return window.electronAPI.autonomous.getCapabilities()
}

/** 获取能力测试记录（可选按维度过滤，时间倒序） */
export async function getCapabilityTests(dimension?: string, limit?: number) {
  return window.electronAPI.autonomous.getCapabilityTests(dimension, limit)
}

/** 获取反思记录 */
export async function getReflections(limit?: number) {
  return window.electronAPI.autonomous.getReflections(limit)
}

/** 获取满意度历史 */
export async function getSatisfactionHistory(range?: string) {
  return window.electronAPI.autonomous.getSatisfactionHistory(range)
}

/** 获取 Prompt 统计 */
export async function getPromptStats() {
  return window.electronAPI.autonomous.getPromptStats()
}

/** 获取自主进化可配置参数 */
export async function getAutonomousSettings() {
  return window.electronAPI.autonomous.getSettings()
}

/** 更新自主进化可配置参数（部分覆盖，非法值回落默认） */
export async function updateAutonomousSettings(settings: Parameters<
  typeof window.electronAPI.autonomous.updateSettings
>[0]) {
  return window.electronAPI.autonomous.updateSettings(settings)
}

/** 获取当前情绪状态（energy/valence/arousal 三维） */
export async function getMood() {
  return window.electronAPI.autonomous.getMood()
}

/** 获取牵挂列表（在意但还没结论的事） */
export async function getConcerns() {
  return window.electronAPI.autonomous.getConcerns()
}

/** 获取内心日记流（时间倒序，游标分页） */
export async function getDiary(
  limit?: number,
  before?: { timestamp: number; id: string } | null,
) {
  return window.electronAPI.autonomous.getDiary(limit, before ?? undefined)
}

/** 批准目标 */
export async function approveGoal(goalId: string, note?: string) {
  return window.electronAPI.autonomous.approveGoal(goalId, note)
}

/** 拒绝目标 */
export async function rejectGoal(
  goalId: string,
  options?: { reason?: string; neverAskAgain?: boolean },
) {
  return window.electronAPI.autonomous.rejectGoal(goalId, options)
}

/** 删除规划目标（硬删） */
export async function deleteGoal(goalId: string) {
  return window.electronAPI.autonomous.deleteGoal(goalId)
}

/** 手动触发 Agent 重新规划（重置规划任务） */
export async function replan() {
  return window.electronAPI.autonomous.replan()
}

/** 设置自主进化开关 */
export async function setAutonomousEnabled(enabled: boolean) {
  return window.electronAPI.autonomous.setEnabled(enabled)
}
