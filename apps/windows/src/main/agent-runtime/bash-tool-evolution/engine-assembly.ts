/**
 * ToolEvolutionAssembly — 工具进化引擎宿主装配
 *
 * 在 bridge 初始化完成后调用一次（index.ts）：
 * 1. 创建 ToolEvolutionEngine（注入 repo / LLM / 注册动作 / 审批提问通道）
 * 2. 启动时注册已批准工具（workspace/tools/<name>/tool.json）
 * 3. 挂定时条件检查（默认每 6h；启动时立即检查一次；有候选且不在冷却期才挖）
 *
 * 开关：runtime_state 键 tool-evolution.enabled，缺省开启；
 * 设 "false" 可整体关闭（实验性功能，保留逃生通道）。
 */

import type { BrowserWindow } from 'electron'
import { EVOLUTION_CONVERSATION_ID } from '@mtbot/agent-runtime'
import {
  ToolEvolutionEngine,
  DEFAULT_CHECK_INTERVAL_MS,
  LAST_MINING_AT_KEY,
} from './tool-evolution-engine'
import type { AgentRuntimeBridge } from '../bridge'
import { agentRuntimeLog as log } from '../bridge-utils'
import { showDesktopTaskNotification } from '../../desktop-notify'

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
  /** 条件检查间隔（默认 6h；单测可缩短） */
  checkIntervalMs?: number
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
      unregisterTool: (name) => bridge.unregisterEvolvedTool(name),
      getRegisteredToolNames: () => bridge.getRegisteredToolNames(),
      emitApprovalPrompt: buildApprovalPromptEmitter(bridge, deps.getMainWindow),
      getLastMiningAt: () => {
        try {
          const raw = bridge.runtimeStateRepo.get(LAST_MINING_AT_KEY)
          return raw && raw.length > 0 ? raw : null
        } catch {
          return null
        }
      },
      setLastMiningAt: (iso) => {
        try {
          bridge.runtimeStateRepo.set(LAST_MINING_AT_KEY, iso)
        } catch (err) {
          log.warn('[ToolEvolution] 持久化 lastMiningAt 失败:', err)
        }
      },
    })

    bridge.setToolEvolutionEngine(engine)
    engine.loadApprovedTools()
    log.info('[ToolEvolution] 引擎已装配（周窗口 Top5 / count>100 / 单次 LLM）')

    const intervalMs = deps.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS
    const runCheck = () => {
      void engine.runConditionalCheck()
    }
    // 启动时立即检查一次：条件满足即可产出，不依赖定点时刻
    runCheck()
    setInterval(runCheck, intervalMs)
    log.info(`[ToolEvolution] 条件检查已排定（每 ${Math.round(intervalMs / 3600000)} 小时）`)

    return engine
  } catch (err) {
    log.warn('[ToolEvolution] 装配失败，工具进化不启用:', err)
    return null
  }
}
