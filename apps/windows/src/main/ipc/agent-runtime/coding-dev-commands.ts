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
import { getCodingDevConfig, resolveDevContext, type ResolvedDevContext } from '../../coding-dev-env.js'

// 从主文件导入单例访问器（避免循环依赖）
let _getAcpBackendManager: (() => import('../../channel/acp-backend-manager').AcpBackendManager) | null = null

export function setAcpBackendManagerGetter(getter: () => import('../../channel/acp-backend-manager').AcpBackendManager): void {
  _getAcpBackendManager = getter
}

function getAcpBackendManager() {
  if (!_getAcpBackendManager) {
    throw new Error('AcpBackendManager getter not set. Call setAcpBackendManagerGetter first.')
  }
  return _getAcpBackendManager()
}

// Windows 客户端统一用 user-global 范围，accountId 固定为 LOCAL_USER_ID
const LOCAL_USER_ID = 'local-user'

export async function handleCodingDevSetBackend(
  command: Extract<AgentRuntimeCommand, { type: 'codingDev:setBackend' }>,
): Promise<{ ok: boolean }> {
  // 桌面开发会话级覆盖：写 dev-context（优先于 user-global 与 Agent 绑定）
  if (command.sessionKey) {
    if (!isCodingDevBackendId(command.backendId)) {
      throw new Error(`未知后端: ${command.backendId}`)
    }
    setDevContext(LOCAL_USER_ID, command.sessionKey, { backendId: command.backendId })
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
  setDevContext(LOCAL_USER_ID, command.sessionKey, { projectName })
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
    accountId: LOCAL_USER_ID,
    sessionKey: command.sessionKey,
    agentId: bridge.conversationRepo.getAgentParticipantId(command.sessionKey),
    fallbackBackendId: mgr.getBackendWithFallback(LOCAL_USER_ID, command.sessionKey),
  })
}
