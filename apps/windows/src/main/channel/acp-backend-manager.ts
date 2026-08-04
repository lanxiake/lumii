/**
 * AcpBackendManager — ACP 多后端管理器
 *
 * 薄封装层，复用 src/coding-dev-backends/ 的持久化与路由逻辑。
 * 主进程统一通过此类读写后端选择，避免直接散落调用。
 */

import {
  setBackendSelection,
  clearBackendSelection,
  getSelectedBackendId,
  getBackendSelection,
  CODING_DEV_USER_GLOBAL_ACCOUNT,
} from '../coding-dev-backends-stub/backend-selection.js'
import {
  CODING_DEV_BACKEND_IDS,
  CODING_DEV_BACKEND_LABELS,
  type CodingDevBackendId,
} from '../coding-dev-backends-stub/contracts.js'

const log = {
  info: (...args: unknown[]) => console.log('[AcpBackendManager]', ...args),
  warn: (...args: unknown[]) => console.warn('[AcpBackendManager]', ...args),
  error: (...args: unknown[]) => console.error('[AcpBackendManager]', ...args),
}

export type BackendScope = 'peer' | 'user-global'

export class AcpBackendManager {
  /**
   * 设置后端选择。
   * @param backendId  目标后端 ID
   * @param scope      'peer'（per-peer 优先）或 'user-global'（用户全局默认）
   * @param accountId  账号 ID（微信 channelUserId 或 Windows 用户 ID）
   * @param peerId     会话 sessionKey（scope='peer' 时必填）
   */
  async setBackend(
    backendId: CodingDevBackendId,
    scope: BackendScope,
    accountId: string,
    peerId?: string,
  ): Promise<void> {
    if (scope === 'peer') {
      if (!peerId) throw new Error('setBackend: scope=peer 时 peerId 必填')
      setBackendSelection(accountId, peerId, backendId)
      log.info(`[setBackend] peer 后端已设置: accountId=${accountId} peerId=${peerId} backendId=${backendId}`)
    } else {
      setBackendSelection(CODING_DEV_USER_GLOBAL_ACCOUNT, accountId, backendId)
      log.info(`[setBackend] user-global 后端已设置: accountId=${accountId} backendId=${backendId}`)
    }
  }

  /**
   * 获取当前后端 ID（per-peer 优先，回退到 user-global，再回退到默认）。
   */
  getBackend(accountId: string, peerId?: string): CodingDevBackendId {
    if (peerId) {
      return getSelectedBackendId(accountId, peerId)
    }
    return getSelectedBackendId(CODING_DEV_USER_GLOBAL_ACCOUNT, accountId)
  }

  /**
   * 获取后端 ID，支持 per-peer → user-global → 默认 的三级回退。
   * 与 getBackend(accountId, peerId) 不同：后者找不到 per-peer 时直接返回默认值，
   * 此方法会继续查 user-global。
   */
  getBackendWithFallback(accountId: string, peerId: string): CodingDevBackendId {
    const perPeer = getBackendSelection(accountId, peerId)
    if (perPeer) return perPeer.backendId
    return getSelectedBackendId(CODING_DEV_USER_GLOBAL_ACCOUNT, accountId)
  }

  /** 列出所有已注册的后端 ID */
  listBackends(): CodingDevBackendId[] {
    return [...CODING_DEV_BACKEND_IDS]
  }

  /** 获取后端显示名称 */
  getBackendLabel(backendId: CodingDevBackendId): string {
    return CODING_DEV_BACKEND_LABELS[backendId] ?? backendId
  }

  /**
   * 清除后端选择（恢复为默认）。
   */
  async clearBackend(scope: BackendScope, accountId: string, peerId?: string): Promise<void> {
    if (scope === 'peer') {
      if (!peerId) throw new Error('clearBackend: scope=peer 时 peerId 必填')
      clearBackendSelection(accountId, peerId)
      log.info(`[clearBackend] peer 后端已清除: accountId=${accountId} peerId=${peerId}`)
    } else {
      clearBackendSelection(CODING_DEV_USER_GLOBAL_ACCOUNT, accountId)
      log.info(`[clearBackend] user-global 后端已清除: accountId=${accountId}`)
    }
  }
}
