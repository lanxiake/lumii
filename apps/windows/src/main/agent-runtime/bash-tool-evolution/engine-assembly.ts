/**
 * ToolEvolutionAssembly — 工具进化引擎宿主装配（M2/M3 接线）
 *
 * 在 bridge 初始化完成后调用一次（index.ts）：
 * 1. 创建 ToolEvolutionEngine（注入 repo / LLM / 注册动作 / 审批提问通道）
 * 2. 启动时注册已批准工具（workspace/tools/<name>/tool.json）
 * 3. 挂每日挖掘定时器（M3：每天一次，产出候选走对话内审批）
 *
 * 开关：runtime_state 键 tool-evolution.enabled，缺省开启；
 * 设 "false" 可整体关闭（实验性功能，保留逃生通道）。
 */

import type { BrowserWindow } from 'electron'
import { ToolEvolutionEngine } from './tool-evolution-engine'
import type { AgentRuntimeBridge } from '../bridge'
import { agentRuntimeLog as log } from '../bridge-utils'

const ENABLED_KEY = 'tool-evolution.enabled'
/** 每日挖掘时间（本地时间小时，默认凌晨 3 点） */
const DAILY_HOUR = 3
const DAY_MS = 24 * 60 * 60 * 1000

/** 审批提问落库 + 推送到最近活跃会话（对话内审批） */
export function buildApprovalPromptEmitter(
  bridge: AgentRuntimeBridge,
  getMainWindow: () => BrowserWindow | null,
): (text: string) => void {
  return (text: string) => {
    const sessionKey = bridge.getLastActiveConversationId()
    if (!sessionKey) {
      log.info(`[ToolEvolution] 无活跃会话，审批提问仅记日志: ${text.slice(0, 80)}`)
      return
    }
    const msgId = `tool-evo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    try {
      bridge.conversationRepo?.saveMessage?.({
        id: msgId,
        conversationId: sessionKey,
        role: 'assistant',
        contentJson: { type: 'text', text },
      })
    } catch (err) {
      log.warn(`[ToolEvolution] 审批提问持久化失败: ${err instanceof Error ? err.message : String(err)}`)
    }
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('agent-runtime:event', {
        type: 'conversation:message:new',
        sessionKey,
        message: {
          id: msgId,
          role: 'assistant',
          content: [{ type: 'text', text }],
          timestamp: Date.now(),
        },
      })
    }
  }
}

/**
 * 装配工具进化运行时。装配失败降级为不启用，不影响启动。
 * 返回 engine（供外部触发挖掘/CLI 用）或 null。
 */
export function initToolEvolutionRuntime(deps: {
  bridge: AgentRuntimeBridge
  getMainWindow: () => BrowserWindow | null
  /** 读开关（缺省开启） */
  isEnabled?: () => boolean
}): ToolEvolutionEngine | null {
  const { bridge } = deps
  const isEnabled = deps.isEnabled ?? (() => true)
  if (!isEnabled()) {
    log.info('[ToolEvolution] 已关闭（tool-evolution.enabled=false）')
    return null
  }

  try {
    const repo = bridge.bashCommandRepo
    if (!repo) {
      log.warn('[ToolEvolution] bash 命令仓库未就绪，装配跳过')
      return null
    }

    const engine = new ToolEvolutionEngine({
      bashCommandRepo: repo,
      callLLM: (prompt) => bridge.callLLM(prompt, undefined, 'tool_evolution'),
      registerEvolvedTool: (def) => bridge.registerEvolvedTool(def),
      getRegisteredToolNames: () => bridge.getRegisteredToolNames(),
      emitApprovalPrompt: buildApprovalPromptEmitter(bridge, deps.getMainWindow),
    })

    bridge.setToolEvolutionEngine(engine)
    engine.loadApprovedTools()
    log.info('[ToolEvolution] 引擎已装配')

    // M3：每日挖掘定时器（进程内，非持久 cron——重启后重新计时，可接受）
    const scheduleDaily = () => {
      const now = new Date()
      const next = new Date(now)
      next.setHours(DAILY_HOUR, 0, 0, 0)
      if (next.getTime() <= now.getTime()) next.setTime(next.getTime() + DAY_MS)
      setTimeout(() => {
        void engine.runMiningCycle()
        scheduleDaily()
      }, next.getTime() - now.getTime())
    }
    scheduleDaily()
    log.info('[ToolEvolution] 每日挖掘任务已排定（本地时间 3:00）')

    return engine
  } catch (err) {
    log.warn('[ToolEvolution] 装配失败，工具进化不启用:', err)
    return null
  }
}
