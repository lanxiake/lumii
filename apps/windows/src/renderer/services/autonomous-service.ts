/**
 * 自主智能体服务 — 封装 window.electronAPI.autonomous 的薄层
 */
import type { AutonomousStatus } from '../../preload/api/autonomous-api'

/** 获取自主智能体状态（满意度 / 待审批目标数 / 能力概览） */
export async function getAutonomousStatus(): Promise<AutonomousStatus> {
  return window.electronAPI.autonomous.getStatus()
}
