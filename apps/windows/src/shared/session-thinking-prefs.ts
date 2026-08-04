/**
 * 会话思考模式偏好 — 渲染进程 localStorage 持久化（与 ChatPage 输入区开关一致）
 */

/** 推理努力程度 */
export type ReasoningEffort = 'high' | 'max'

/** 用户可见的思考控制参数 */
export interface PersistedSessionThinkingPrefs {
  /** 是否开启模型思考（reasoning） */
  readonly thinkingEnabled: boolean
  /** 思考强度（仅 thinkingEnabled=true 时生效） */
  readonly reasoningEffort: ReasoningEffort
}

/** localStorage 键名 */
export const SESSION_THINKING_STORAGE_KEYS = {
  thinkingEnabled: 'mtbot:thinking-enabled',
  reasoningEffort: 'mtbot:reasoning-effort',
} as const

/** 未持久化时的默认值（与 ChatPage 一致：默认开启） */
export const DEFAULT_PERSISTED_SESSION_THINKING_PREFS: PersistedSessionThinkingPrefs = {
  thinkingEnabled: true,
  reasoningEffort: 'high',
}

/**
 * 从 localStorage 读取用户在对话页保存的思考偏好。
 * 宠物模式/主窗口切换会话时应同步到主进程 BridgeSessionThinkingPrefs。
 */
export function readPersistedSessionThinkingPrefs(): PersistedSessionThinkingPrefs {
  try {
    const rawEnabled = localStorage.getItem(SESSION_THINKING_STORAGE_KEYS.thinkingEnabled)
    const thinkingEnabled = rawEnabled === null ? true : rawEnabled === 'true'
    const rawEffort = localStorage.getItem(SESSION_THINKING_STORAGE_KEYS.reasoningEffort)
    const reasoningEffort: ReasoningEffort = rawEffort === 'max' ? 'max' : 'high'
    return { thinkingEnabled, reasoningEffort }
  } catch {
    return { ...DEFAULT_PERSISTED_SESSION_THINKING_PREFS }
  }
}

/**
 * 持久化思考开关
 */
export function writePersistedThinkingEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SESSION_THINKING_STORAGE_KEYS.thinkingEnabled, String(enabled))
  } catch {
    /* ignore */
  }
}

/**
 * 持久化推理强度
 */
export function writePersistedReasoningEffort(effort: ReasoningEffort): void {
  try {
    localStorage.setItem(SESSION_THINKING_STORAGE_KEYS.reasoningEffort, effort)
  } catch {
    /* ignore */
  }
}
