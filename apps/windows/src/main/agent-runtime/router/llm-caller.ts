/**
 * Router LLM 调用封装
 *
 * 复用外部传入的 StreamFn 做单次调用（当前用 chat 槎位的 direct stream）。
 * 参考 apps/windows/src/main/agent-runtime/bridge-context-compactor.ts::callLLM 的实现。
 */

import type { StreamFn } from "@mariozechner/pi-agent-core"
import type { Model, Context } from "@mariozechner/pi-ai"
import type { ModelRouter } from "@mtbot/agent-runtime"
import { createLogger } from "../../logger"

const log = createLogger("router-llm-caller")

export interface RouterLlmCaller {
  /**
   * 单次 LLM 调用。
   * @param prompt 完整 prompt 文本
   * @param timeoutMs 超时（ms），超时抛出含 "timeout" 关键字的错误
   */
  call(prompt: string, timeoutMs: number): Promise<string>
}

export interface RouterLlmCallerDeps {
  /** 复用 bridge 中已构造的 StreamFn（chat 槎位 direct stream） */
  streamFn: StreamFn
  /** 模型路由器，用于解析 chat tier */
  modelRouter: ModelRouter
}

export class RouterLlmCallerImpl implements RouterLlmCaller {
  constructor(private readonly deps: RouterLlmCallerDeps) {}

  async call(prompt: string, timeoutMs: number): Promise<string> {
    const model: Model<string> = this.deps.modelRouter.resolve("chat")
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const start = Date.now()

    log.info(`[call] model=${model.id} api=${model.api} promptLen=${prompt.length} timeoutMs=${timeoutMs} purpose=skill_route`)

    try {
      const context: Context = {
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      }
      const stream = await this.deps.streamFn(model, context, {
        temperature: 0.1,
        maxTokens: 800,
        signal: controller.signal,
        purpose: "skill_route",
      } as unknown as Parameters<StreamFn>[2])

      let text = ""
      for await (const event of stream) {
        if (event.type === "text_delta") {
          text += event.delta
        } else if (event.type === "error") {
          throw new Error(`Router LLM error: ${(event as { message?: string }).message ?? "unknown"}`)
        }
      }

      const trimmed = text.trim()
      log.info(`[call] success duration=${Date.now() - start}ms outputLen=${trimmed.length}`)
      return trimmed
    } catch (err) {
      const isAbort =
        controller.signal.aborted ||
        (err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message)))
      if (isAbort) {
        throw new Error(`Router call timeout after ${timeoutMs}ms`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
}
