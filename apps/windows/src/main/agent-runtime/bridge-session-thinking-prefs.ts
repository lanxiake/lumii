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
 *
 * 未显式设置过的会话（渠道会话、心跳/cron、后台维护等）跟随「全局默认」——
 * 即用户在对话页的那个开关，而不是恒定的编译期默认值。
 */
export class BridgeSessionThinkingPrefs {
  private readonly prefsBySessionKey = new Map<string, SessionThinkingPrefs>();
  /** 全局默认（对话页开关），落盘后重启仍生效 */
  private globalPrefs: SessionThinkingPrefs;

  constructor(globalPrefs?: Partial<SessionThinkingPrefs>) {
    this.globalPrefs = {
      thinkingEnabled: globalPrefs?.thinkingEnabled ?? DEFAULT_SESSION_THINKING_PREFS.thinkingEnabled,
      reasoningEffort: globalPrefs?.reasoningEffort ?? DEFAULT_SESSION_THINKING_PREFS.reasoningEffort,
    };
  }

  /** 读取全局默认（对话页开关） */
  getGlobalPrefs(): SessionThinkingPrefs {
    return { ...this.globalPrefs };
  }

  /** 更新全局默认（部分字段合并），返回更新后的值 */
  setGlobalPrefs(patch: Partial<SessionThinkingPrefs>): SessionThinkingPrefs {
    this.globalPrefs = {
      thinkingEnabled: patch.thinkingEnabled ?? this.globalPrefs.thinkingEnabled,
      reasoningEffort: patch.reasoningEffort ?? this.globalPrefs.reasoningEffort,
    };
    return this.getGlobalPrefs();
  }

  /**
   * 读取会话思考偏好：显式设置过用会话值，否则跟随全局默认
   */
  getThinkingPrefs(sessionKey: string): SessionThinkingPrefs {
    const k = sessionKey.trim();
    if (!k) return this.getGlobalPrefs();
    return this.prefsBySessionKey.get(k) ?? this.getGlobalPrefs();
  }

  /**
   * 更新会话思考偏好（部分字段合并）；空 sessionKey 视作只读全局默认，不写入
   */
  setThinkingPrefs(
    sessionKey: string,
    patch: Partial<SessionThinkingPrefs>,
  ): SessionThinkingPrefs {
    const k = sessionKey.trim();
    if (!k) return this.getGlobalPrefs();
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
