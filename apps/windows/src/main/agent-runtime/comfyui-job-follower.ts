/**
 * ComfyUI 任务跟进 —— 把「已入队」变成「真正出片」
 *
 * comfyui-mcp 的 `enqueue_workflow`（action:"enqueue"/"rerun"）与 `generate_image`
 * **入队即返回** `{status:"enqueued", prompt_id}`，并不等渲染结束。后台任务若在这一刻
 * 就判「完成」，任务卡上没有任何产出，Agent 也会被过早唤醒——拿到的只是一个 prompt_id。
 *
 * 这里在后台继续跟进同一个 MCP Server：
 *   1. 轮询 `queue`（action:"status"）直到 done / 查无此任务；
 *   2. 读 `get_history`（action:"list"）拿到产出文件清单；
 *   3. 解析出文件名并拼成 ComfyUI `/view` 地址，供任务卡展示、Agent 告知用户。
 *
 * 纯逻辑 + 依赖注入（callTool / sleep），不直接持有 McpManager，便于单测。
 */

import type { BackgroundTaskOutput } from '../../shared/agent-runtime-events'
import { buildRemoteMediaUrl } from '../remote-media-url'

/** 单个产出文件（url 为 ComfyUI `/view` 下载地址，不知道服务地址时缺省） */
export type ComfyJobOutput = BackgroundTaskOutput

/** 跟进结果 */
export interface ComfyJobOutcome {
  readonly ok: boolean
  /** 写给 Agent 与任务卡的结果文本（历史详情或失败原因） */
  readonly text: string
  readonly outputs: readonly ComfyJobOutput[]
}

export interface FollowComfyJobOptions {
  readonly promptId: string
  /** 调同一 MCP Server 的工具（短名），返回文本；isError 时抛错 */
  readonly callTool: (
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<string>
  /** 后台任务自己的中断信号（取消 / 看门狗） */
  readonly signal: AbortSignal
  /** ComfyUI 服务地址（MCP 配置里的 COMFYUI_URL），用于拼 `/view` 链接 */
  readonly baseUrl?: string
  /** 轮询间隔，默认 5s */
  readonly intervalMs?: number
  /** 连续查询失败上限，超过即判失败（默认 6 次） */
  readonly maxConsecutiveErrors?: number
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** 状态变化时回调（排队中 / 渲染中），供任务卡显示进度 */
  readonly onProgress?: (note: string) => void
  /**
   * 每轮轮询前的闸门（暂停时在此挂起）。
   * 远端作业不会因此停下——恢复后接着跟同一个 prompt_id，不重新提交。
   */
  readonly beforePoll?: (signal: AbortSignal) => Promise<void>
}

interface PromptStatus {
  readonly running?: boolean
  readonly pending?: boolean
  readonly done?: boolean
  readonly found?: boolean
  readonly status_str?: string
  readonly error?: unknown
  readonly message?: string
}

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|avi|gif)$/i
const AUDIO_EXT = /\.(mp3|wav|flac|ogg|m4a)$/i
const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|tiff?)$/i

/**
 * 识别「已入队、尚未出片」的回执，返回 prompt_id；其它结果（含 wait:true 已带产出的）返回 null。
 */
export function parseEnqueuedPromptId(text: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const rec = parsed as { status?: unknown; prompt_id?: unknown }
  if (rec.status !== 'enqueued') return null
  return typeof rec.prompt_id === 'string' && rec.prompt_id.length > 0 ? rec.prompt_id : null
}

/**
 * 从 MCP Server 的 env 取 ComfyUI 服务地址（`COMFYUI_URL`）。
 * 只认字面量 http(s) 地址；含 `${VAR}` 占位或缺省时返回 undefined（不猜默认端口）。
 */
export function resolveComfyBaseUrl(env: Readonly<Record<string, string>> | undefined): string | undefined {
  const raw = env?.COMFYUI_URL?.trim()
  if (!raw || raw.includes('${') || !/^https?:\/\//i.test(raw)) return undefined
  return raw.replace(/\/+$/, '')
}

/** 按输出键与扩展名判定产出类型（images 键下也可能是 webm/gif 动图） */
function classifyOutput(key: string, fileName: string): ComfyJobOutput['kind'] {
  if (VIDEO_EXT.test(fileName)) return 'video'
  if (AUDIO_EXT.test(fileName)) return 'audio'
  if (IMAGE_EXT.test(fileName)) return 'image'
  if (key === 'videos' || key === 'video' || key === 'gifs') return 'video'
  if (key === 'audio') return 'audio'
  if (key === 'images') return 'image'
  return 'file'
}

/** 拼 ComfyUI `/view` 地址（与 ComfyUI 前端取图同一接口） */
function buildViewUrl(baseUrl: string, fileName: string, subfolder: string, type: string): string {
  const params = new URLSearchParams({ filename: fileName, subfolder, type })
  return `${baseUrl.replace(/\/+$/, '')}/view?${params.toString()}`
}

/**
 * 从 `get_history`（action:"list"）的文本里解析产出文件。
 *
 * 该工具把媒体产出渲染成 `videos → **sub/a.mp4 (type=output), b.mp4 (type=output)**`，
 * 这里按同一形状反解；认不出的行一律忽略（不编造文件）。
 */
export function parseHistoryOutputs(historyText: string, baseUrl?: string): ComfyJobOutput[] {
  const outputs: ComfyJobOutput[] = []
  const seen = new Set<string>()
  const linePattern = /(images|videos|video|gifs|audio)\s*→\s*\*\*(.+?)\*\*/g
  for (const match of historyText.matchAll(linePattern)) {
    const key = match[1]!
    for (const entry of match[2]!.split(/,\s+/)) {
      const fileMatch = /^(.+?)\s+\(type=([\w-]+)\)$/.exec(entry.trim())
      if (!fileMatch) continue
      const path = fileMatch[1]!
      const type = fileMatch[2]!
      const slash = path.lastIndexOf('/')
      const name = slash >= 0 ? path.slice(slash + 1) : path
      const subfolder = slash >= 0 ? path.slice(0, slash) : ''
      const dedupeKey = `${type}:${path}`
      if (!name || seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      outputs.push({
        name,
        path,
        kind: classifyOutput(key, name),
        ...(baseUrl
          ? {
              // url：给人「在新窗口打开 / 下载」，保持 ComfyUI 原始地址
              url: buildViewUrl(baseUrl, name, subfolder, type),
              // previewUrl：给 <img>/<video>/灯箱直接加载，走本地代理补鉴权头
              previewUrl: buildRemoteMediaUrl(buildViewUrl(baseUrl, name, subfolder, type)),
            }
          : {}),
      })
    }
  }
  return outputs
}

/** 可被 signal 打断的等待 */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('ComfyUI 任务跟进已中断')
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/**
 * 轮询直到 ComfyUI 任务结束，返回结果文本与产出文件。
 *
 * 失败分三类，都以 `ok:false` 返回（由调用方标记任务失败）：执行报错、查无此任务、
 * 连续查询失败超限。中断信号触发时**抛错**——取消已由调用方登记，不该再被当成失败。
 */
export async function followComfyJob(options: FollowComfyJobOptions): Promise<ComfyJobOutcome> {
  const {
    promptId,
    callTool,
    signal,
    baseUrl,
    intervalMs = 5000,
    maxConsecutiveErrors = 6,
    sleep = defaultSleep,
    onProgress,
    beforePoll,
  } = options
  let consecutiveErrors = 0
  let lastNote = ''

  const report = (note: string): void => {
    if (note === lastNote) return
    lastNote = note
    onProgress?.(note)
  }

  for (;;) {
    throwIfAborted(signal)
    if (beforePoll) {
      await beforePoll(signal)
      throwIfAborted(signal)
    }
    let status: PromptStatus
    try {
      status = JSON.parse(await callTool('queue', { action: 'status', prompt_id: promptId })) as PromptStatus
      consecutiveErrors = 0
    } catch (err) {
      throwIfAborted(signal)
      consecutiveErrors += 1
      if (consecutiveErrors >= maxConsecutiveErrors) {
        return {
          ok: false,
          text: `连续 ${consecutiveErrors} 次查询 ComfyUI 任务状态失败（prompt_id=${promptId}）：${describeError(err)}`,
          outputs: [],
        }
      }
      await sleep(intervalMs, signal)
      continue
    }
    throwIfAborted(signal)

    if (status.found === false) {
      return {
        ok: false,
        text: `ComfyUI 查无此任务（prompt_id=${promptId}）：${status.message ?? '可能因服务重启而丢失'}`,
        outputs: [],
      }
    }

    if (status.done) {
      let historyText = ''
      try {
        historyText = await callTool('get_history', { action: 'list', prompt_id: promptId })
      } catch (err) {
        historyText = `（读取执行历史失败：${describeError(err)}）`
      }
      const failed = status.status_str === 'error' || status.error !== undefined && status.error !== null
      if (failed) {
        const reason = status.error !== undefined && status.error !== null ? describeError(status.error) : '执行出错'
        return { ok: false, text: `${reason}\n\n${historyText}`.trim(), outputs: [] }
      }
      return { ok: true, text: historyText, outputs: parseHistoryOutputs(historyText, baseUrl) }
    }

    report(status.running ? 'ComfyUI 渲染中' : 'ComfyUI 排队中')
    await sleep(intervalMs, signal)
  }
}
