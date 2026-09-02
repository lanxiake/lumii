/**
 * 自动审批偏好 — 渲染进程 localStorage 与主进程镜像共用同一键名与默认策略。
 * 无存储值时默认开启，避免纯渠道场景下主进程误判为「人工审批」而推送 IM 审批消息。
 */

/** localStorage 键名（ChatPage 与 bridge-init 同步时使用） */
export const AUTO_APPROVE_STORAGE_KEY = 'mtbot-auto-approve'

/**
 * 读取是否启用自动审批。
 * localStorage 未设置时返回 true（程序默认开启）。
 */
export function readAutoApproveEnabled(): boolean {
  try {
    const raw = localStorage.getItem(AUTO_APPROVE_STORAGE_KEY)
    if (raw === null) return true
    return raw === 'true'
  } catch {
    return true
  }
}

/**
 * 将自动审批偏好同步到主进程（渠道据此判断是否推送审批消息）。
 */
export function syncAutoApproveToMainProcess(
  sendCommand: ((command: { type: 'user:auto-approve:set'; enabled: boolean }) => Promise<unknown>) | undefined,
): void {
  if (!sendCommand) return
  const enabled = readAutoApproveEnabled()
  void sendCommand({ type: 'user:auto-approve:set', enabled }).catch(() => undefined)
}
