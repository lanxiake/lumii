/**
 * 主进程事件表。
 *
 * 只登记**已有真实发射点**的事件。没有发射方的事件不要写进来——
 * 那会让扩展订阅一个永远不响的频道，且编译器不会阻止。
 */
export interface MainEvents {
  /**
   * 主窗口已创建（`createWindow` 返回后立刻发）。
   *
   * 需要窗口引用的扩展（录屏、桌宠）靠它决定「什么时候真正开始干活」，
   * 而不是让宿主把激活点推迟——那样所有扩展都被拖慢。
   */
  'app:window-ready': { at: number }
  /** 启动完成、窗口可交互 */
  'app:activated': { at: number }
  /** 进程开始退出（performCleanup 入口） */
  'app:shutdown': { reason: 'quit' | 'restart' }

  // ── Agent Runtime ──────────────────────────────────────────────────────

  /** Agent Runtime 已初始化（S7，在所有 IPC 注册之后） */
  'agent:runtime-ready': { at: number }

  /**
   * Agent 回合开始（用户消息已收到，即将调用 LLM）。
   *
   * 扩展可以在此埋点、记录上下文、或注入工具。
   */
  'agent:turn-start': {
    instanceId: string
    conversationId?: string
    at: number
  }

  /**
   * Agent 回合结束（assistant 消息已生成并落库）。
   *
   * 用于后处理、统计、触发同步等。
   */
  'agent:turn-end': {
    instanceId: string
    conversationId?: string
    success: boolean
    at: number
  }

  /**
   * LLM 调用后（响应已返回）。
   *
   * 用于计费统计、缓存命中率记录等。
   */
  'llm:after-response': {
    instanceId: string
    conversationId?: string
    success: boolean
    modelId?: string
    usage?: {
      inputTokens?: number
      outputTokens?: number
      cacheRead?: number
      cacheWrite?: number
    }
    sessionKey?: string
    at: number
  }

  // ── 工作空间 ────────────────────────────────────────────────────────

  /**
   * 工作空间切换（用户在设置中选了新目录）。
   *
   * 云同步、VCS、文件监听等模块据此重新初始化。
   */
  'workspace:changed': {
    oldDir: string | null
    newDir: string
    at: number
  }
}
