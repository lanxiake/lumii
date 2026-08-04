/**
 * RouterService — Pre-LLM Router 主入口
 *
 * 流程：
 *   prompt = buildRouterPrompt(input)
 *   raw    = await llmCaller.call(prompt, timeoutMs)
 *   result = parseRouterResult(raw)
 *   result = validateRouterResult(result, input)
 *
 * 任何环节失败都返回 fallback=非 "none" 的安全结果，绝不抛错（上游主流程不受影响）。
 *
 * 详见 .qoder/design/Agent-Skill编排优化/02-技术设计.md §2.2
 */

import { createLogger } from "../../logger"
import type { RouterLlmCaller } from "./llm-caller"
import { tryRouterFastPath } from "./router-fast-path"
import { buildRouterPrompt } from "./prompt-builder"
import { parseRouterResult, validateRouterResult } from "./result-parser"
import type { RouterFallback, RouterInput, RouterResult } from "./types"

const log = createLogger("router-service")

export interface RouterServiceDeps {
  llmCaller: RouterLlmCaller
  /** 超时（ms），默认 8000 */
  timeoutMs?: number
  /** 解析失败时的最大重试次数（仅对 parse_error 生效），默认 1 */
  maxRetries?: number
  /** confidence 阈值，低于该值返回 fallback 结果（仍尝试 needsClarification） */
  minConfidence?: number
  /** 成功结果缓存 TTL（ms），默认 60000；设为 0 关闭缓存 */
  cacheTtlMs?: number
  /** 缓存最大条目数，默认 50 */
  cacheMaxEntries?: number
}

interface CacheEntry {
  readonly result: RouterResult
  readonly expiresAt: number
}

export class RouterService {
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly cacheTtlMs: number
  private readonly cacheMaxEntries: number
  /** key = 规范化输入 + 候选集签名；插入顺序即 LRU 顺序 */
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly deps: RouterServiceDeps) {
    // 默认 8s：技能/Agent 列表较大时 3s 易触发 AbortError（网关显示 "operation was aborted"），
    // 放宽到 8s 让大多数请求能正常完成；超时仍走安全降级，不阻断对话。
    this.timeoutMs = deps.timeoutMs ?? 8000
    this.maxRetries = deps.maxRetries ?? 1
    this.cacheTtlMs = deps.cacheTtlMs ?? 60000
    this.cacheMaxEntries = deps.cacheMaxEntries ?? 50
  }

  /**
   * 计算缓存键：规范化用户输入 + 候选 Agent/Skill 的 id 签名。
   * 候选集变化（安装/卸载技能）会自然让旧缓存失效。
   */
  private cacheKey(input: RouterInput): string {
    const normInput = input.userInput.trim().toLowerCase().replace(/\s+/g, " ")
    const agentSig = input.availableAgents.map((a) => a.id).sort().join(",")
    const skillSig = input.availableSkills.map((s) => s.id).sort().join(",")
    return `${normInput}|a:${agentSig}|s:${skillSig}`
  }

  /** 读取缓存（命中且未过期时返回；过期则清除） */
  private getCached(key: string): RouterResult | undefined {
    if (this.cacheTtlMs <= 0) return undefined
    const entry = this.cache.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return undefined
    }
    // LRU：命中后移到末尾
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.result
  }

  /** 写入缓存并维持容量上限（淘汰最旧条目） */
  private setCached(key: string, result: RouterResult): void {
    if (this.cacheTtlMs <= 0) return
    this.cache.set(key, { result, expiresAt: Date.now() + this.cacheTtlMs })
    while (this.cache.size > this.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  /**
   * 路由主入口。
   * 永不抛错；失败时返回 fallback 标识非 "none" 的 RouterResult。
   */
  async route(input: RouterInput): Promise<RouterResult> {
    const fast = tryRouterFastPath(input)
    if (fast) {
      log.info(`[route] fast-path intent=${fast.intent} confidence=${fast.confidence}`)
      return fast
    }

    // 短期缓存：相同输入 + 相同候选集，60s 内直接复用，避免重复 LLM 调用
    const key = this.cacheKey(input)
    const cached = this.getCached(key)
    if (cached) {
      log.info(`[route] cache-hit intent=${cached.intent} confidence=${cached.confidence.toFixed(2)}`)
      return { ...cached, durationMs: 0, fallback: "none" }
    }

    const start = Date.now()
    let lastErr: unknown
    let attemptedTimes = 0

    // 最多 maxRetries+1 次尝试（首次 + 重试）
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      attemptedTimes++
      try {
        const prompt = buildRouterPrompt(input)
        const raw = await this.deps.llmCaller.call(prompt, this.timeoutMs)
        const parsed = parseRouterResult(raw)
        const validated = validateRouterResult(parsed, input)
        const durationMs = Date.now() - start
        log.info(
          `[route] success intent=${validated.intent} confidence=${validated.confidence.toFixed(2)} ` +
            `agents=${validated.topAgents.length} skills=${validated.topSkills.length} ` +
            `clarify=${validated.needsClarification} duration=${durationMs}ms attempts=${attemptedTimes}`,
        )
        const result: RouterResult = { ...validated, durationMs, fallback: "none" }
        this.setCached(key, result)
        return result
      } catch (err) {
        lastErr = err
        const msg = String(err)
        // timeout / llm_error 不重试（重试也大概率失败）；仅 parse_error 重试
        if (!/parse_error/.test(msg)) {
          break
        }
        log.warn(`[route] parse_error 第 ${attempt + 1} 次失败，重试中: ${msg}`)
      }
    }

    return this.buildFallback(input, Date.now() - start, lastErr)
  }

  /**
   * 失败时的降级结果：
   * - confidence = 0 → 主 prompt 走旧路径（看完整能力清单）
   * - topAgents / topSkills 保留前几个作为占位（避免空数组让主 LLM 完全没参考）
   */
  private buildFallback(input: RouterInput, durationMs: number, err: unknown): RouterResult {
    const fallback = classifyFallback(err)
    log.warn(`[route] fallback=${fallback} duration=${durationMs}ms err=${String(err)}`)
    return {
      intent: "unknown",
      confidence: 0,
      topAgents: input.availableAgents.slice(0, 3).map((a) => ({
        id: a.id,
        score: 0,
        reason: "fallback: router unavailable",
      })),
      topSkills: input.availableSkills.slice(0, 5).map((s) => ({
        id: s.id,
        score: 0,
        reason: "fallback: router unavailable",
      })),
      needsClarification: false,
      durationMs,
      fallback,
    }
  }
}

function classifyFallback(err: unknown): RouterFallback {
  const msg = String(err ?? "")
  if (/timeout/i.test(msg)) return "timeout"
  if (/parse_error/.test(msg)) return "parse_error"
  return "llm_error"
}
