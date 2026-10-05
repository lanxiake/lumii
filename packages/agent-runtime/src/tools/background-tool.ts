/**
 * 长耗时工具后台化 —— 通用接口
 *
 * 有些工具（典型是远程视频生成 MCP）一次调用要跑几分钟到几十分钟。同步等待会让
 * 整轮回合被工具超时拖垮，模型随后只能收尾结束。这里把「是否后台化」「怎么后台跑」
 * 抽象成宿主可注入的策略 + 执行器：
 *
 * - 命中的应用在**权限闸门之后、真实执行之前**（见 `ToolRunner.run`）摘出来——
 *   权限已确认，只把真正耗时的执行挪到后台；
 * - 立即返回一个「已在后台执行」的占位结果，让回合继续；
 * - 真实执行结束后由宿主登记完成、唤醒归属 Agent 续跑（见 BackgroundTaskManager）。
 */

import type { HookAgentToolResult } from './tool-hooks.js'

/** 判定某次工具调用是否应转后台 */
export interface BackgroundToolPolicy {
  /** @param params 该次调用的参数（策略可按工具名 / 参数内容决定） */
  shouldBackground(toolName: string, params: Record<string, unknown>): boolean
}

/** 后台执行入参 */
export interface BackgroundToolRunInput {
  /** 完整工具名（如 mcp__comfyui-remote__enqueue_workflow） */
  readonly toolName: string
  /** 人类可读标签（供 UI 显示） */
  readonly label: string
  /** 调用该工具的 Agent 实例（用于把结果路由回去） */
  readonly instanceId?: string
  /**
   * 真实工具执行（权限闸门已放行）。传入的 signal 是**后台任务自己的**中断信号——
   * 刻意不沿用回合的 signal，好让任务活过回合结束，并支持单独取消/看门狗超时。
   * resolve 为结果，reject 视为失败。
   */
  readonly execute: (signal: AbortSignal) => Promise<HookAgentToolResult>
}

/** 后台执行器：登记任务、detached 跑、终态回填并唤醒。返回 taskId */
export interface BackgroundToolRunner {
  run(input: BackgroundToolRunInput): string
}

/** 后台化配置（策略 + 执行器） */
export interface BackgroundToolConfig {
  readonly policy: BackgroundToolPolicy
  readonly runner: BackgroundToolRunner
}

/** 后台化占位结果文案（写给模型读：说明已后台执行、勿重复、完成后会回来） */
export function buildBackgroundNotice(label: string, taskId: string): string {
  return (
    `已在后台开始执行「${label}」（taskId=${taskId}）。该任务耗时较长，` +
    `完成后会自动通知你并带上结果，**请勿重复调用同一任务**；` +
    `期间可继续推进其它不依赖它的工作，或直接结束本轮等待通知。`
  )
}
