/**
 * 会话级模型偏好与上下文压缩参数（与 GET /api/config/models 目录联动）
 */

/**
 * 管理 UI 同步的模型目录与会话级 ContextCompactor 参数
 */
export class BridgeSessionModelCatalog {
  /** 无目录命中时的默认（与 AgentInstance 历史默认对齐） */
  static readonly DEFAULT_SESSION_COMPACTION = {
    contextWindow: 1_000_000,
    outputReserveTokens: 16_384,
    summaryReserveTokens: 8_192,
  } as const

  /**
   * LiteLLM 元数据缺失时的已知模型窗口（与官方文档对齐）
   * key 为 normalizeModelKey 后的短 id
   */
  private static readonly KNOWN_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
    'deepseek-v4': 1_000_000,
    'deepseek-v4-pro': 1_000_000,
    'deepseek-v4-flash': 1_000_000,
  }

  private readonly modelCatalogByFullId = new Map<
    string,
    { contextWindow: number; maxOutputTokens?: number }
  >()

  private readonly sessionPreferredModelRaw = new Map<string, string>()

  private readonly sessionCompactionBySessionKey = new Map<
    string,
    { contextWindow: number; outputReserveTokens: number; summaryReserveTokens: number }
  >()

  /**
   * 从 API Server 同步的模型目录（扁平 id → 能力），供压缩与用量条解析
   */
  setModelCatalogFromApi(
    entries: readonly { id: string; contextWindow?: number; maxTokens?: number }[],
  ): void {
    this.modelCatalogByFullId.clear()
    for (const e of entries) {
      const id = e.id?.trim()
      if (!id) continue
      const fromApi =
        typeof e.contextWindow === 'number' && Number.isFinite(e.contextWindow) && e.contextWindow > 0
          ? Math.floor(e.contextWindow)
          : undefined
      const fromKnown = BridgeSessionModelCatalog.KNOWN_CONTEXT_WINDOWS[this.normalizeModelKey(id)]
      const cw = fromApi ?? fromKnown
      if (!cw) continue
      const mt =
        typeof e.maxTokens === 'number' && Number.isFinite(e.maxTokens) && e.maxTokens > 0
          ? Math.floor(e.maxTokens)
          : undefined
      this.modelCatalogByFullId.set(id, { contextWindow: cw, maxOutputTokens: mt })
      // 同时注册短 id，便于 UI 选模 id 与 catalog 全名不一致时命中
      const shortId = this.normalizeModelKey(id)
      if (shortId !== id && !this.modelCatalogByFullId.has(shortId)) {
        this.modelCatalogByFullId.set(shortId, { contextWindow: cw, maxOutputTokens: mt })
      }
    }
    for (const [sk, raw] of this.sessionPreferredModelRaw) {
      this.applyCompactionForSession(sk, raw)
    }
  }

  /**
   * 规范化模型 id（去掉 provider 前缀，如 deepseek/deepseek-v4-pro → deepseek-v4-pro）
   */
  private normalizeModelKey(modelRef: string): string {
    const t = modelRef.trim()
    const slash = t.lastIndexOf('/')
    return slash >= 0 ? t.slice(slash + 1) : t
  }

  /**
   * 在目录中查找模型元数据（精确 id → 短 id → 已知窗口表）
   */
  private lookupCatalogEntry(modelRef: string): { contextWindow: number; maxOutputTokens?: number } | undefined {
    const raw = modelRef.trim()
    if (!raw) return undefined
    const direct = this.modelCatalogByFullId.get(raw)
    if (direct) return direct
    const short = this.normalizeModelKey(raw)
    const byShort = this.modelCatalogByFullId.get(short)
    if (byShort) return byShort
    for (const [id, meta] of this.modelCatalogByFullId) {
      if (this.normalizeModelKey(id) === short) return meta
    }
    const known = BridgeSessionModelCatalog.KNOWN_CONTEXT_WINDOWS[short]
    if (known) return { contextWindow: known }
    return undefined
  }

  /**
   * 根据模型引用（与下拉框 id 一致）解析 ContextCompactor 参数
   */
  private resolveCompactionFromModelRef(modelRef: string | undefined): {
    contextWindow: number
    outputReserveTokens: number
    summaryReserveTokens: number
  } {
    const d = BridgeSessionModelCatalog.DEFAULT_SESSION_COMPACTION
    if (!modelRef?.trim()) {
      return {
        contextWindow: d.contextWindow,
        outputReserveTokens: d.outputReserveTokens,
        summaryReserveTokens: d.summaryReserveTokens,
      }
    }
    const hit = this.lookupCatalogEntry(modelRef.trim())
    const cw = Math.max(4096, hit?.contextWindow ?? d.contextWindow)
    // output/summary 预留只用于「压缩到多少」（computeMaxEstimatedHistoryTokens），
    // 不再参与触发判断。因此改用与窗口无关的固定上限：避免大窗口（如 1M）下
    // 旧的 cw×0.25 预留出 250k 的巨量空间、把压缩目标压得过狠。
    const outputReserve = Math.min(hit?.maxOutputTokens ?? d.outputReserveTokens, 32_768)
    const summaryReserve = d.summaryReserveTokens
    return { contextWindow: cw, outputReserveTokens: outputReserve, summaryReserveTokens: summaryReserve }
  }

  /**
   * 将解析后的压缩参数写入会话（与当前选择的模型 id 对应）
   */
  private applyCompactionForSession(sessionKey: string, modelRef: string | undefined): void {
    const k = sessionKey.trim()
    if (!k) return
    const comp = this.resolveCompactionFromModelRef(modelRef)
    this.sessionCompactionBySessionKey.set(k, comp)
  }

  /**
   * 新建对话后、首条消息前：根据 UI 选中模型写入会话偏好与压缩参数
   */
  primeSessionModelCompaction(sessionKey: string, modelRef: string | undefined): void {
    const k = sessionKey.trim()
    if (!k) return
    const v = modelRef?.trim()
    if (v) {
      this.sessionPreferredModelRaw.set(k, v)
    } else {
      this.sessionPreferredModelRaw.delete(k)
    }
    this.applyCompactionForSession(k, v)
  }

  /**
   * 根会话（conversationId）对应的压缩参数，用于 AgentInstance 与 agent:end 用量推送
   */
  getCompactionForRootSession(rootSessionKey: string): {
    contextWindow: number
    outputReserveTokens: number
    summaryReserveTokens: number
  } {
    const k = rootSessionKey.trim()
    const cached = this.sessionCompactionBySessionKey.get(k)
    if (cached) return cached

    // 目录已加载但 session 尚未 prime（首条消息在目录同步前发出）：
    // 用 preferredModel 实时解析，避免 fallback 到 128K 默认值
    const raw = this.sessionPreferredModelRaw.get(k)
    if (raw && this.modelCatalogByFullId.size > 0) {
      const comp = this.resolveCompactionFromModelRef(raw)
      this.sessionCompactionBySessionKey.set(k, comp)
      return comp
    }

    return { ...BridgeSessionModelCatalog.DEFAULT_SESSION_COMPACTION }
  }

  /**
   * 设置当前对话在后续 LLM 调用中应使用的模型（与 UI 模型选择同步）
   */
  setSessionPreferredModel(sessionKey: string, raw: string | undefined): void {
    const k = sessionKey.trim()
    if (!k) return
    const v = raw?.trim()
    if (v) {
      this.sessionPreferredModelRaw.set(k, v)
      this.applyCompactionForSession(k, v)
    } else {
      this.sessionPreferredModelRaw.delete(k)
      this.sessionCompactionBySessionKey.delete(k)
    }
  }

  /**
   * 对话关闭时移除会话级模型偏好，避免泄漏到新会话
   */
  clearSessionPreferredModel(sessionKey: string): void {
    const k = sessionKey.trim()
    this.sessionPreferredModelRaw.delete(k)
    this.sessionCompactionBySessionKey.delete(k)
  }

  /**
   * 解析 streamFn 外包层：按根会话或有效会话键读取 UI 选择的模型原始串
   */
  getPreferredModelRawForStream(rootSessionKey: string, effectiveSessionKey: string): string | undefined {
    return (
      this.sessionPreferredModelRaw.get(rootSessionKey)?.trim() ||
      this.sessionPreferredModelRaw.get(effectiveSessionKey)?.trim()
    )
  }
}
