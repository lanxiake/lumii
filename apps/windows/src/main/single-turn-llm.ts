/**
 * 单轮 LLM 调用（P2 就地修改）
 *
 * 与划词 selection-llm 同一口径：
 * - 非流式（对 UI 只返回完整结果）；
 * - 按 requestId 取消；
 * - **日志只记长度与耗时，绝不记 prompt / 输出**——输入是用户正文。
 *
 * stream/model 由调用方注入（`bridge.resolveSelectionChatStream()`），
 * 每次现取，设置里换模型/凭据立即生效。
 */

import type { Model, Context } from '@earendil-works/pi-ai/compat'
import { normalizeContext } from '@earendil-works/pi-ai/compat'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { createLogger } from './logger'

const log = createLogger('single-turn-llm')

const DEFAULT_TIMEOUT_MS = 90_000
const DEFAULT_MAX_TOKENS = 2000

export interface SingleTurnStream {
  streamFn: StreamFn
  model: Model<any>
}

export interface SingleTurnLlmDeps {
  resolveStream: () => SingleTurnStream | undefined
}

export interface SingleTurnRunInput {
  requestId: string
  prompt: string
  /** 日志用；不落正文 */
  purpose: string
  maxTokens?: number
  timeoutMs?: number
  temperature?: number
}

export type SingleTurnRunResult =
  | { ok: true; text: string }
  | { ok: false; error: string; cancelled?: boolean }

export class SingleTurnLlmService {
  private readonly active = new Map<string, AbortController>()
  /** 取消可能先于 run 到达（读文件/拼提示词期间）：先记下来，run 开始即返回 */
  private readonly earlyAborts = new Map<string, number>()

  constructor(private readonly deps: SingleTurnLlmDeps) {}

  get activeCount(): number {
    return this.active.size
  }

  private pruneEarlyAborts(now: number): void {
    for (const [requestId, at] of this.earlyAborts) {
      if (now - at > 60_000) this.earlyAborts.delete(requestId)
    }
  }

  async run(input: SingleTurnRunInput): Promise<SingleTurnRunResult> {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    if (!prompt) return { ok: false, error: '没有可处理的文本' }

    const now = Date.now()
    this.pruneEarlyAborts(now)
    if (this.earlyAborts.delete(input.requestId)) {
      log.info(`[run] 已在开始前取消 purpose=${input.purpose} requestId=${input.requestId}`)
      return { ok: false, error: '已取消', cancelled: true }
    }

    // 同一 requestId 重入：先掐掉旧的，避免两个请求抢同一个槽位
    this.abortActive(input.requestId)

    const resolved = this.deps.resolveStream()
    if (!resolved) {
      return { ok: false, error: '未配置可用的文本模型，请先在设置里启用 chat 能力槽' }
    }

    const controller = new AbortController()
    this.active.set(input.requestId, controller)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const startedAt = Date.now()
    log.info(
      `[run] 开始 purpose=${input.purpose} requestId=${input.requestId} promptLen=${prompt.length}`,
    )

    try {
      const context: Context = {
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      }
      const options = {
        temperature: input.temperature ?? 0.2,
        maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
        signal: controller.signal,
        purpose: input.purpose,
      } as unknown as Parameters<StreamFn>[2]

      const stream = await resolved.streamFn(resolved.model, normalizeContext(context), options)

      let output = ''
      for await (const event of stream) {
        if (event.type === 'text_delta') {
          output += event.delta
        } else if (event.type === 'error') {
          throw new Error(
            `模型返回错误：${(event as { message?: string }).message ?? '未知原因'}`,
          )
        }
      }

      const trimmed = output.trim()
      if (trimmed.length === 0) return { ok: false, error: '模型没有返回内容' }

      log.info(
        `[run] 完成 purpose=${input.purpose} duration=${Date.now() - startedAt}ms outputLen=${trimmed.length}`,
      )
      return { ok: true, text: trimmed }
    } catch (err) {
      if (controller.signal.aborted) {
        log.info(
          `[run] 已取消 purpose=${input.purpose} timedOut=${timedOut} duration=${Date.now() - startedAt}ms`,
        )
        return {
          ok: false,
          error: timedOut ? '模型端点长时间没有响应，请稍后重试' : '已取消',
          cancelled: true,
        }
      }
      const message = err instanceof Error ? err.message : String(err)
      log.warn(
        `[run] 失败 purpose=${input.purpose} duration=${Date.now() - startedAt}ms: ${message}`,
      )
      return { ok: false, error: message }
    } finally {
      clearTimeout(timer)
      if (this.active.get(input.requestId) === controller) this.active.delete(input.requestId)
    }
  }

  private abortActive(requestId: string): boolean {
    const controller = this.active.get(requestId)
    if (!controller) return false
    controller.abort()
    this.active.delete(requestId)
    return true
  }

  /** 取消在飞请求（换产物 / 用户点取消）；未开始的请求也记下来 */
  abort(requestId: string): boolean {
    if (this.abortActive(requestId)) return true
    const now = Date.now()
    this.pruneEarlyAborts(now)
    this.earlyAborts.set(requestId, now)
    return true
  }
}
