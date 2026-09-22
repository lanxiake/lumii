/**
 * selection-llm.ts - 划词单轮 LLM 服务（主进程）
 *
 * 渲染层 L2 动作（翻译/解释/总结/润色）的执行侧。形态按设计 §八.1 的实测结论定：
 * **不做流式** —— 卡的是端点排队而非生成，首字节之前无字可显示，流式治不了排队；
 * 于是通道就是「一次调用拿完整结果」+「按 requestId 取消」。
 *
 * 日志口径是本模块的一条硬约束：只记长度与耗时，**绝不记 prompt 或输出**。
 * 选中文本是用户内容，落盘就没有下次解释了（既有 callLLM 记全文是为后台任务排错，
 * 划词场景不适用）。
 */

import type { Model, Context } from '@mariozechner/pi-ai'
import type { StreamFn } from '@mariozechner/pi-agent-core'
import { createLogger } from '../logger'
import { buildSelectionPrompt } from './selection-prompts'
import type { SelectionLlmRequest, SelectionLlmResult } from '../../shared/selection-llm-types'

const log = createLogger('selection-llm')

/** 选中文本上限。超了直接拒，不截断 —— 截断后的翻译是错的，比报错更难发现 */
const MAX_TEXT_CHARS = 4000

/**
 * 超时。实测（探针 n=2）同一短 prompt 首字 615ms↔5739ms，9 倍方差来自端点排队；
 * 90s 不是「够快」的判据，只是「别让用户对着气泡干等」的上限。
 */
const TIMEOUT_MS = 90_000

/** 每档输出的上限。翻译/解释这类单轮短输出，比主对话流小一个数量级 */
const MAX_OUTPUT_TOKENS = 1200

export interface SelectionChatStream {
  streamFn: StreamFn
  model: Model<any>
}

export interface SelectionLlmServiceDeps {
  /**
   * 解析要用的 stream + model。每次调用现取：用户在设置里改了模型/凭据应当立即生效。
   * 返回 undefined 表示没有可用配置，由本服务转成可读错误。
   */
  resolveChatStream: () => SelectionChatStream | undefined
}

/** 取消一个在飞的请求。不在飞（已完成/已取消）时返回 false */
export type SelectionAbort = (requestId: string) => boolean

export class SelectionLlmService {
  private readonly active = new Map<string, AbortController>()

  constructor(private readonly deps: SelectionLlmServiceDeps) {}

  /** 在飞请求数（测试与诊断用） */
  get activeCount(): number {
    return this.active.size
  }

  async run(request: SelectionLlmRequest): Promise<SelectionLlmResult> {
    const text = typeof request.text === 'string' ? request.text.trim() : ''
    if (text.length === 0) return { ok: false, error: '没有可处理的文本' }
    if (text.length > MAX_TEXT_CHARS) {
      return { ok: false, error: `选中的文本太长（${text.length} 字，上限 ${MAX_TEXT_CHARS} 字）` }
    }

    // 同一个 requestId 重入（渲染层重试）：先掐掉旧的，避免两个请求抢同一个槽位。
    // 放在解析之前：旧请求不该因为新请求的参数校验没过而继续占着端点
    this.abort(request.requestId)

    const resolved = this.deps.resolveChatStream()
    if (!resolved) {
      return { ok: false, error: '未配置可用的文本模型，请先在设置里启用 chat 能力槽' }
    }

    const controller = new AbortController()
    this.active.set(request.requestId, controller)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, TIMEOUT_MS)
    const startedAt = Date.now()
    log.info(
      `[run] 开始 action=${request.action} textLen=${text.length} requestId=${request.requestId}`,
    )

    try {
      const prompt = buildSelectionPrompt(request.action, text)
      const context: Context = {
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      }
      const options = {
        temperature: 0.1,
        maxTokens: MAX_OUTPUT_TOKENS,
        signal: controller.signal,
        purpose: 'selection',
      } as unknown as Parameters<StreamFn>[2]

      const stream = await resolved.streamFn(resolved.model, context, options)

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
        `[run] 完成 action=${request.action} duration=${Date.now() - startedAt}ms outputLen=${trimmed.length}`,
      )
      return { ok: true, text: trimmed }
    } catch (err) {
      if (controller.signal.aborted) {
        log.info(
          `[run] 已取消 action=${request.action} timedOut=${timedOut} duration=${Date.now() - startedAt}ms`,
        )
        return { ok: false, error: timedOut ? '模型端点长时间没有响应，请稍后重试' : '已取消' }
      }
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`[run] 失败 action=${request.action} duration=${Date.now() - startedAt}ms: ${message}`)
      return { ok: false, error: message }
    } finally {
      clearTimeout(timer)
      // 只有还认这一个 controller 时才删：重入场景下 Map 里可能已经是新的那次
      if (this.active.get(request.requestId) === controller) this.active.delete(request.requestId)
    }
  }

  /** 取消在飞请求。渲染层关闭气泡、换选区、切会话时调用 */
  abort(requestId: string): boolean {
    const controller = this.active.get(requestId)
    if (!controller) return false
    controller.abort()
    this.active.delete(requestId)
    return true
  }
}
