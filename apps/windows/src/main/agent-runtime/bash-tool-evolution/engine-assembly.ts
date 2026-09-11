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
import { EVOLUTION_CONVERSATION_ID } from '@mtbot/agent-runtime'
import {
  ToolEvolutionEngine,
  DEFAULT_TRIGGER_THRESHOLD,
  TRIGGER_THRESHOLD_KEY,
  clampTriggerThreshold,
} from './tool-evolution-engine'
import type { AgentRuntimeBridge } from '../bridge'
import { agentRuntimeLog as log } from '../bridge-utils'
import { showDesktopTaskNotification } from '../../desktop-notify'

const ENABLED_KEY = 'tool-evolution.enabled'
/** 每日挖掘时间（本地时间小时，默认凌晨 3 点） */
const DAILY_HOUR = 3
const DAY_MS = 24 * 60 * 60 * 1000

/** 工具进化审批通知标题 */
const TOOL_EVO_NOTIFY_TITLE = 'Lumii · 工具进化'

/**
 * 审批提问落库 + 推送到自主进化独白会话（不干扰用户当前对话）+ 系统桌面通知。
 *
 * 工具进化审批消息写入「自主进化 · 内心独白」会话（evolution:main），
 * 不再注入用户当前活跃会话，避免打断正常对话上下文。
 * 同时发送系统桌面通知，点击可跳转到进化会话查看详情。
 */
export function buildApprovalPromptEmitter(
  bridge: AgentRuntimeBridge,
  getMainWindow: () => BrowserWindow | null,
): (text: string) => void {
  return (text: string) => {
    const sessionKey = EVOLUTION_CONVERSATION_ID

    // 确保自主进化独白会话存在
    bridge.ensureConversationExists(sessionKey, '自主进化 · 内心独白')

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

    // IPC 推送到进化会话（若用户正在查看该会话则可实时看到）
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

    // 系统桌面通知：提醒用户有待审批的工具候选
    showDesktopTaskNotification(
      TOOL_EVO_NOTIFY_TITLE,
      text.slice(0, 120),
      sessionKey,
      { getMainWindow },
    )
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

    const triggerThreshold = (() => {
      try {
        const raw = bridge.runtimeStateRepo.get(TRIGGER_THRESHOLD_KEY)
        if (raw == null || raw === '') return DEFAULT_TRIGGER_THRESHOLD
        return clampTriggerThreshold(Number(raw))
      } catch {
        return DEFAULT_TRIGGER_THRESHOLD
      }
    })()

    const engine = new ToolEvolutionEngine({
      bashCommandRepo: repo,
      callLLM: (prompt) => bridge.callLLM(prompt, undefined, 'tool_evolution'),
      registerEvolvedTool: (def) => bridge.registerEvolvedTool(def),
      unregisterTool: (name) => bridge.unregisterEvolvedTool(name),
      getRegisteredToolNames: () => bridge.getRegisteredToolNames(),
      emitApprovalPrompt: buildApprovalPromptEmitter(bridge, deps.getMainWindow),
      triggerThreshold,
    })

    bridge.setToolEvolutionEngine(engine)
    engine.loadApprovedTools()
    log.info(`[ToolEvolution] 引擎已装配（triggerThreshold=${triggerThreshold}）`)

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
