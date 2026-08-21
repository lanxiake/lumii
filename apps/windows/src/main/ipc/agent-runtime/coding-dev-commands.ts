/**
 * CodingDev 命令处理器（codingDev:*）
 *
 * ACP 后端管理：设置后端、获取后端、列出后端
 */

import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'
import type { CodingDevBackendId } from '../../coding-dev-backends-stub/contracts.js'
import { CODING_DEV_BACKEND_LABELS, DEFAULT_CODING_DEV_BACKEND_ID } from '../../coding-dev-backends-stub/contracts.js'

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
