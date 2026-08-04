/**
 * Verification Tracker（主题5 P0-3）
 *
 * 按 instanceId 记录"本会话是否发生过验证"（spawn builtin:verify 或运行 test/build 命令），
 * 以及 task_complete 的软门禁尝试次数。供 verification-gate-hook 消费。
 *
 * 与 file-state-cache 同隔离粒度（按 instanceId 的全局注册表 + 实例数封顶）。
 */

interface VerificationState {
  /** 本会话是否观测到验证行为（spawn verify / 跑 test/build） */
  verified: boolean;
  /** task_complete 软门禁已尝试次数 */
  completeAttempts: number;
}

const _registry = new Map<string, VerificationState>();
const MAX_INSTANCES = 100;

function getState(instanceId: string): VerificationState {
  let st = _registry.get(instanceId);
  if (!st) {
    if (_registry.size >= MAX_INSTANCES) {
      const keys = Array.from(_registry.keys());
      for (let i = 0; i < 20 && i < keys.length; i++) {
        _registry.delete(keys[i]!);
      }
    }
    st = { verified: false, completeAttempts: 0 };
    _registry.set(instanceId, st);
  }
  return st;
}

/** 标记本会话已发生验证 */
export function markVerified(instanceId: string): void {
  getState(instanceId).verified = true;
}

/** 是否已验证 */
export function isVerified(instanceId: string): boolean {
  return getState(instanceId).verified;
}

/** 记录一次 task_complete 软门禁尝试，返回累计次数 */
export function recordCompleteAttempt(instanceId: string): number {
  const st = getState(instanceId);
  st.completeAttempts += 1;
  return st.completeAttempts;
}

/** 重置 task_complete 尝试计数（放行后） */
export function resetCompleteAttempts(instanceId: string): void {
  getState(instanceId).completeAttempts = 0;
}

/** 测试用：清空注册表 */
export function _clearVerificationRegistry(): void {
  _registry.clear();
}
