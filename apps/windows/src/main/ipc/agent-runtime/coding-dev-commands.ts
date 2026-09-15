/**
 * CodingDev 命令处理器（codingDev:*）
 *
 * ACP 后端管理：设置 / 获取 / 列出后端；会话级开发上下文（项目 + 工具）读写。
 *
 * 语义（见设计 §5.2/§5.3）：
 * - 带 sessionKey 的 setBackend = 桌面会话级覆盖（dev-context），优先于 user-global 与 Agent 绑定；
 * - 不带 sessionKey 的 setBackend = 全局默认（设置面板 / 控制面），与原实现一致。
 */

import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import {
  CODING_DEV_BACKEND_LABELS,
  isCodingDevBackendId,
  type CodingDevBackendId,
} from '../../coding-dev-backends-stub/contracts.js'
import { setDevContext } from '../../coding-dev-dev-context.js'
import {
  computeAgentBackendBindingUpdate,
  getCodingDevConfig,
  resolveDevContext,
  writeCodingDevAgentBindings,
  type ResolvedDevContext,
} from '../../coding-dev-env.js'

const log = {
  info: (...args: unknown[]) => console.info('[AgentRuntime:IPC]', ...args),
  warn: (...args: unknown[]) => console.warn('[AgentRuntime:IPC]', ...args),
}

// 从主文件导入单例访问器（避免循环依赖）
let _getAcpBackendManager: (() => import('../../channel/acp-backend-manager').AcpBackendManager) | null = null

export function setAcpBackendManagerGetter(getter: () => import('../../channel/acp-backend-manager').AcpBackendManager): void {
  _getAcpBackendManager = getter
}

/** 供同目录模块（转交执行器的绑定预检）读取当前后端选择；未注入时抛错 */
export function getAcpBackendManager() {
  if (!_getAcpBackendManager) {
    throw new Error('AcpBackendManager getter not set. Call setAcpBackendManagerGetter first.')
  }
  return _getAcpBackendManager()
}

// Windows 客户端统一用 user-global 范围，accountId 固定为 LOCAL_USER_ID
const LOCAL_USER_ID = 'local-user'

export async function handleCodingDevSetBackend(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'codingDev:setBackend' }>,
): Promise<{ ok: boolean }> {
  // 桌面开发会话级覆盖：写 dev-context（优先于 user-global 与 Agent 绑定）
  if (command.sessionKey) {
    if (!isCodingDevBackendId(command.backendId)) {
      throw new Error(`未知后端: ${command.backendId}`)
    }
    setDevContext(command.sessionKey, { backendId: command.backendId }, LOCAL_USER_ID)
    // 按 Agent 粘住：同一切换同时写为该 Agent 的默认后端（其他 Agent 不受影响）
    await persistAgentBackendDefault(bridge, command.sessionKey, command.backendId)
    return { ok: true }
  }
  const mgr = getAcpBackendManager()
  // Windows 客户端统一用 user-global 范围，accountId 固定为 LOCAL_USER_ID
  await mgr.setBackend(
    command.backendId as CodingDevBackendId,
    'user-global',
    LOCAL_USER_ID,
  )
  return { ok: true }
}

/**
 * 「按 Agent 粘住」：把本次切换写为该会话所属 Agent 的默认后端绑定。
 * - 判定逻辑见 computeAgentBackendBindingUpdate（lumii 停用绑定 / 其余 upsert）；
 * - 写盘失败不阻塞切换本身（会话级 dev-context 已生效）。
 */
async function persistAgentBackendDefault(
  bridge: AgentRuntimeBridge,
  sessionKey: string,
  backendId: string,
): Promise<void> {
  try {
    const agentId = bridge.conversationRepo.getAgentParticipantId(sessionKey)
    if (!agentId) return
    const next = computeAgentBackendBindingUpdate(
      getCodingDevConfig().codingDevAgentBindings,
      agentId,
      backendId,
    )
    if (!next) return
    const written = await writeCodingDevAgentBindings(next)
    if (written) {
      log.info(
        `[codingDev:setBackend] 已按 Agent 粘住后端 agentId=${agentId} backendId=${backendId} sessionKey=${sessionKey}`,
      )
    }
  } catch (err) {
    log.warn('[codingDev:setBackend] 写入 Agent 默认后端失败（仅会话级生效）:', err)
  }
}

export function handleCodingDevGetBackend(): { backendId: CodingDevBackendId } {
  const mgr = getAcpBackendManager()
  const backendId = mgr.getBackend(LOCAL_USER_ID)
  return { backendId }
}

export function handleCodingDevListBackends(): { backends: Array<{ id: CodingDevBackendId; label: string }> } {
  const mgr = getAcpBackendManager()
  return { backends: mgr.listBackends().map((id) => ({ id, label: CODING_DEV_BACKEND_LABELS[id] })) }
}

/** 设置 / 清除会话级开发项目（projectName=null 表示清除，回落 Agent 绑定 / 全局活动项目） */
export function handleCodingDevSetProject(
  command: Extract<AgentRuntimeCommand, { type: 'codingDev:setProject' }>,
): { ok: boolean; projectName?: string } {
  const projectName = command.projectName?.trim() || null
  if (projectName) {
    const exists = (getCodingDevConfig().codingDevProjects ?? []).some((p) => p.name === projectName)
    if (!exists) throw new Error(`项目不存在或未注册: ${projectName}`)
  }
  setDevContext(command.sessionKey, { projectName }, LOCAL_USER_ID)
  return { ok: true, ...(projectName ? { projectName } : {}) }
}

/** 读取会话的最终开发上下文（会话显式 > Agent 绑定 > 全局默认），供模式 chip 展示 */
export function handleCodingDevGetDevContext(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'codingDev:getDevContext' }>,
): ResolvedDevContext {
  const mgr = getAcpBackendManager()
  return resolveDevContext({
    appConfig: getCodingDevConfig(),
    sessionKey: command.sessionKey,
    agentId: bridge.conversationRepo.getAgentParticipantId(command.sessionKey),
    fallbackBackendId: mgr.getBackendWithFallback(LOCAL_USER_ID, command.sessionKey),
  })
}
