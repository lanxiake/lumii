/**
 * PermissionController — 工具调用权限请求与响应管理
 *
 * 职责：维护挂起的权限请求 Map，提供 wait/resolve 机制，管理进程内权限记忆
 * 从 bridge.ts 提取，完全自洽，无外部状态依赖
 */

import { PermissionMemory } from '@mtbot/agent-runtime'

const log = {
  info: (...args: unknown[]) => console.log('[PermissionController]', ...args),
}

type PermissionDecision = 'allow-once' | 'allow-always' | 'deny'

interface PendingPermissionResolver {
  resolve: (decision: PermissionDecision) => void
  timeoutHandle: ReturnType<typeof setTimeout>
}

export class PermissionController {
  private readonly pendingPermissions = new Map<string, PendingPermissionResolver>()
  readonly memory: PermissionMemory

  constructor() {
    this.memory = new PermissionMemory()
  }

  /**
   * 等待用户对权限请求的响应；超时后默认 deny
   *
   * @param requestId - 权限请求 ID
   * @param timeoutMs - 超时时间，0 表示永不超时
   */
  waitForPermission(requestId: string, timeoutMs: number): Promise<PermissionDecision> {
    return new Promise((resolve) => {
      const timeoutHandle = timeoutMs > 0
        ? setTimeout(() => {
            if (this.pendingPermissions.has(requestId)) {
              log.info(`[waitForPermission] requestId=${requestId} timed out, defaulting to deny`)
              this.pendingPermissions.delete(requestId)
              resolve('deny')
            }
          }, timeoutMs)
        : setTimeout(() => {}, 0) // 占位，不超时

      this.pendingPermissions.set(requestId, { resolve, timeoutHandle })
    })
  }

  /**
   * 处理来自渲染进程的权限响应
   */
  resolvePermission(requestId: string, decision: PermissionDecision): void {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) {
      log.info(`[resolvePermission] requestId=${requestId} not found (already resolved or timed out)`)
      return
    }
    clearTimeout(pending.timeoutHandle)
    this.pendingPermissions.delete(requestId)
    log.info(`[resolvePermission] requestId=${requestId} → ${decision}`)
    pending.resolve(decision)
  }

  /**
   * 以 deny 拒绝所有挂起的权限请求，并清空记忆（destroyAll 时调用）
   */
  clearAll(): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      clearTimeout(pending.timeoutHandle)
      pending.resolve('deny')
      log.info(`[clearAll] rejected pending permission: ${requestId}`)
    }
    this.pendingPermissions.clear()
    this.memory.clear()
  }
}
