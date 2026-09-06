/**
 * LLM 提示词捕获 —— 把发送给模型的「原生 prompt」与响应写入 JSONL。
 *
 * 用于自主进化等真实 E2E 测试后的人工评估与提示词优化：光看测试「结果是否正确」
 * 无法判断提示词本身是否合理，落一份原生 prompt + 响应，后续可逐条分析、优化。
 *
 * 启用方式（任一即可，每次调用前动态解析，无需重启应用即可热开关）：
 *   - 环境变量 LUMII_PROMPT_CAPTURE_DIR=<dir>   写入指定目录
 *   - 环境变量 LUMII_PROMPT_CAPTURE=1           写入 ~/.lumii/prompt-capture
 *   - 哨兵文件 ~/.lumii/prompt-capture.enable    写入 ~/.lumii/prompt-capture
 * 默认关闭，零额外 IO 开销。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const defaultDir = (): string => path.join(os.homedir(), '.lumii', 'prompt-capture')
const sentinelPath = (): string => path.join(os.homedir(), '.lumii', 'prompt-capture.enable')

let activeFile: string | null = null

/** 解析捕获目录；null 表示禁用。env 进程内不变，哨兵文件每次调用实时检查（热开关）。 */
function resolveDir(): string | null {
  const envDir = process.env.LUMII_PROMPT_CAPTURE_DIR
  if (envDir) return envDir
  if (process.env.LUMII_PROMPT_CAPTURE === '1') return defaultDir()
  try {
    if (fs.existsSync(sentinelPath())) return defaultDir()
  } catch {
    /* 忽略哨兵文件读取失败 */
  }
  return null
}

function ensureFile(): string | null {
  const dir = resolveDir()
  if (!dir) {
    activeFile = null // 复位：禁用后重新启用会开新文件
    return null
  }
  if (activeFile) return activeFile
  try {
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    activeFile = path.join(dir, `capture-${stamp}.jsonl`)
    return activeFile
  } catch {
    return null
  }
}

/** 脱敏：去掉 API Key / 头里的认证字段，其余 options 保留供评估（purpose/sessionId/temperature/reasoning）。 */
function sanitizeOptions(options: unknown): Record<string, unknown> | undefined {
  if (!options || typeof options !== 'object') return undefined
  const src = options as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) {
    if (k === 'apiKey' || k === 'apiKeyEnc') continue
    if (k === 'headers' && v && typeof v === 'object') {
      const headers = { ...(v as Record<string, unknown>) }
      for (const hk of Object.keys(headers)) {
        if (/authorization|api[-_]?key|token/i.test(hk)) headers[hk] = '[redacted]'
      }
      out.headers = headers
      continue
    }
    out[k] = v
  }
  return out
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (c): c is { text?: string } =>
        !!c && typeof c === 'object' && (c as { type?: string }).type === 'text',
    )
    .map((c) => c.text ?? '')
    .join('')
}

export interface CapturedLlmCall {
  model: unknown
  context: { systemPrompt?: string; messages?: unknown; tools?: unknown }
  options?: unknown
}

/**
 * 记录一次 LLM 调用。立即写 start 行（含原生 prompt），返回 finish 回调写 end 行。
 * 禁用时返回 null，调用方直接跳过。
 */
export function captureLLMCall(input: CapturedLlmCall): {
  finish: (result: {
    text: string
    usage?: unknown
    stopReason?: string
    errorMessage?: string
  }) => void
} | null {
  const file = ensureFile()
  if (!file) return null

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const startedAt = Date.now()
  const model = input.model as { id?: string; api?: string } | undefined
  const opts = sanitizeOptions(input.options)

  const start = {
    kind: 'start',
    id,
    ts: new Date(startedAt).toISOString(),
    model: model?.id,
    api: model?.api,
    purpose: opts?.purpose,
    sessionId: opts?.sessionId,
    systemPrompt: input.context.systemPrompt,
    messages: input.context.messages,
    tools: input.context.tools,
    options: opts,
  }

  try {
    fs.appendFileSync(file, JSON.stringify(start) + '\n', 'utf8')
  } catch {
    return null
  }

  return {
    finish: (result) => {
      const end = {
        kind: 'end',
        id,
        ts: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        text: result.text,
        usage: result.usage,
        stopReason: result.stopReason,
        errorMessage: result.errorMessage,
      }
      try {
        fs.appendFileSync(file, JSON.stringify(end) + '\n', 'utf8')
      } catch {
        /* 捕获失败绝不影响主流程 */
      }
    },
  }
}
