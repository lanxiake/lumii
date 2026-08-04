/**
 * 会话级思考模式与推理强度偏好（Windows 对话页控制）
 */

/** 推理努力程度（low/medium/xhigh 会在网关层映射为 high/max） */
export type ReasoningEffort = "high" | "max";

/** 会话思考控制参数 */
export interface SessionThinkingPrefs {
  /** 是否开启思考模式（默认 true） */
  readonly thinkingEnabled: boolean;
  /** 思考强度（仅 thinkingEnabled=true 时生效，默认 high） */
  readonly reasoningEffort: ReasoningEffort;
}

/** 默认思考偏好：开启思考 + high effort */
export const DEFAULT_SESSION_THINKING_PREFS: SessionThinkingPrefs = {
  thinkingEnabled: true,
  reasoningEffort: "high",
};

/**
 * 管理 UI 同步的会话级思考/推理强度参数
 */
export class BridgeSessionThinkingPrefs {
  private readonly prefsBySessionKey = new Map<string, SessionThinkingPrefs>();

  /**
   * 读取会话思考偏好（未设置时返回默认值）
   */
  getThinkingPrefs(sessionKey: string): SessionThinkingPrefs {
    const k = sessionKey.trim();
    if (!k) return { ...DEFAULT_SESSION_THINKING_PREFS };
    return this.prefsBySessionKey.get(k) ?? { ...DEFAULT_SESSION_THINKING_PREFS };
  }

  /**
   * 更新会话思考偏好（部分字段合并）
   */
  setThinkingPrefs(
    sessionKey: string,
    patch: Partial<SessionThinkingPrefs>,
  ): SessionThinkingPrefs {
    const k = sessionKey.trim();
    if (!k) return { ...DEFAULT_SESSION_THINKING_PREFS };
    const prev = this.getThinkingPrefs(k);
    const next: SessionThinkingPrefs = {
      thinkingEnabled: patch.thinkingEnabled ?? prev.thinkingEnabled,
      reasoningEffort: patch.reasoningEffort ?? prev.reasoningEffort,
    };
    this.prefsBySessionKey.set(k, next);
    return next;
  }

  /**
   * 对话关闭时清理，避免泄漏到新会话
   */
  clearThinkingPrefs(sessionKey: string): void {
    this.prefsBySessionKey.delete(sessionKey.trim());
  }
}
