/**
 * Breeze TTS 2 客户端（HTTP，本地 FastAPI sidecar）。
 *
 * Breeze 是独立仓库（E:\ai\breeze-tts）的 Python 服务，不在本应用内运行。
 * 「安装」= 用户在本机部署好它，然后把仓库路径 / 模型目录 / 端口填进设置；
 * 本插件负责按需拉起服务、健康检查、流式合成。
 *
 * 接口（breeze_infer/api.py）：
 * - `GET  /health`                         未加载完返回 503 `{"status":"loading"}`
 * - `POST /v1/audio/speech`                multipart；响应体是流式 **s16le PCM**，
 *                                          采样率在响应头 `X-Sample-Rate`
 * - 单并发：已有请求在跑时返回 409
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { TtsChunk, TtsProvider } from '../../../shared/tts-engine'

const log = {
  info: (...args: unknown[]) => console.log('[TtsBreeze]', ...args),
  debug: (...args: unknown[]) => console.debug('[TtsBreeze:DEBUG]', ...args),
  warn: (...args: unknown[]) => console.warn('[TtsBreeze]', ...args),
  error: (...args: unknown[]) => console.error('[TtsBreeze]', ...args),
}

/** 模型加载很慢（7.7GB 权重，CPU 上更久），给足时间 */
const READY_TIMEOUT_MS = 300_000
const HEALTH_POLL_MS = 1_000

export interface BreezeConfig {
  /** Breeze 仓库根目录（含 breeze_infer/，用于 `python -m breeze_infer.api`） */
  repoPath?: string
  /** checkpoint 目录；相对路径按 repoPath 解析 */
  modelDir?: string
  /** 服务端口 */
  port?: number
  /** 已运行的服务地址；填了就直接连，不自己拉起 */
  baseUrl?: string
  /** Python 解释器；缺省用 <repoPath>/.venv 里的 */
  python?: string
  cfgScale?: number
  /** 声音设计/风格指令 */
  instruction?: string
  /** 参考音频（克隆）本地路径 */
  refAudioPath?: string
  refText?: string
}

/** 该路径是否是 Breeze 仓库根（能 `python -m breeze_infer.api` 的前提） */
export function looksLikeBreezeRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'breeze_infer', 'api.py'))
}

/** 解析 venv 里的 python 可执行文件 */
export function resolveVenvPython(repoPath: string): string | null {
  const candidates =
    process.platform === 'win32'
      ? [path.join(repoPath, '.venv', 'Scripts', 'python.exe')]
      : [path.join(repoPath, '.venv', 'bin', 'python')]
  return candidates.find((p) => fs.existsSync(p)) ?? null
}

/**
 * 配置是否完整到「可以尝试拉起服务」。
 *
 * 两种情况算就绪：要么用户填了已运行的服务地址（我们只连不管），
 * 要么仓库路径指向真实的 Breeze 仓库且能找到 python。其余一律不可用——
 * 让下拉置灰，比让用户选中后合成时才收到「找不到 Python」更早暴露问题。
 */
export function isBreezeConfigured(cfg: BreezeConfig): boolean {
  if (cfg.baseUrl?.trim()) return true
  const repo = cfg.repoPath?.trim()
  if (!repo || !looksLikeBreezeRepo(repo)) return false
  return Boolean(cfg.python?.trim() || resolveVenvPython(repo))
}

export class BreezeTtsProvider implements TtsProvider {
  readonly name = 'breeze-tts'
  readonly isLocal = true
  sampleRate = 24_000

  private child: ChildProcess | null = null
  /** 我们自己拉起的才在 destroy 时关掉；用户自启的服务不动 */
  private ownsProcess = false
  private baseUrl: string

  constructor(private cfg: BreezeConfig) {
    this.baseUrl = cfg.baseUrl?.trim().replace(/\/+$/, '') || `http://127.0.0.1:${cfg.port ?? 7860}`
  }

  async initialize(): Promise<void> {
    if (await this.healthOk()) {
      log.info(`[initialize] 复用已在运行的服务: ${this.baseUrl}`)
      return
    }
    if (this.cfg.baseUrl?.trim()) {
      // 用户显式给了地址，说明服务该由他自己管；连不上就是配置错了，不要偷偷另起一个
      throw new Error(`连不上 Breeze 服务 ${this.baseUrl}，请确认已启动或检查端口`)
    }
    await this.spawnAndWait()
  }

  private async healthOk(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3_000) })
      if (!res.ok) return false
      const body = (await res.json()) as { status?: string }
      return body.status === 'ok'
    } catch {
      return false
    }
  }

  private async spawnAndWait(): Promise<void> {
    const repoPath = this.cfg.repoPath?.trim()
    if (!repoPath) throw new Error('未配置 Breeze 仓库路径')
    if (!looksLikeBreezeRepo(repoPath)) {
      throw new Error(`「${repoPath}」不是 Breeze 仓库根目录（缺 breeze_infer/api.py）`)
    }

    const modelDir = this.resolveModelDir(repoPath)
    const python = this.cfg.python?.trim() || resolveVenvPython(repoPath)
    if (!python) {
      throw new Error(
        '找不到 Python 解释器。请先在 Breeze 仓库里建好 .venv 并安装依赖，或在设置里指定 python 路径',
      )
    }

    const port = this.cfg.port ?? 7860
    log.info(`[spawn] ${python} -m breeze_infer.api ${modelDir} --port ${port}`)
    this.child = spawn(
      python,
      ['-m', 'breeze_infer.api', modelDir, '--host', '127.0.0.1', '--port', String(port)],
      { cwd: repoPath, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    this.ownsProcess = true

    // 子进程日志转进主日志，模型加载失败时能直接看到原因
    this.child.stdout?.on('data', (b: Buffer) => log.debug(String(b).trimEnd()))
    this.child.stderr?.on('data', (b: Buffer) => log.warn(String(b).trimEnd()))
    this.child.on('exit', (code) => {
      log.info(`[spawn] 进程退出 code=${code}`)
      this.child = null
    })

    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await this.healthOk()) {
        log.info('[spawn] 服务就绪')
        return
      }
      if (!this.child) {
        throw new Error('Breeze 进程已退出，请查看日志（多半是依赖未装或模型目录不对）')
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS))
    }
    throw new Error(`Breeze 服务在 ${READY_TIMEOUT_MS / 1000}s 内未就绪（模型加载较慢）`)
  }

  private resolveModelDir(repoPath: string): string {
    const raw = this.cfg.modelDir?.trim()
    if (!raw) return path.resolve(repoPath, '..', 'breeze-tts-2')
    return path.isAbsolute(raw) ? raw : path.resolve(repoPath, raw)
  }

  async synthesize(
    text: string,
    onChunk: (chunk: TtsChunk) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!text.trim() || signal?.aborted) return

    const form = new FormData()
    form.set('text', text)
    // 0.6B/1.7B 的指令跟随在 cfg_scale=4 时明显更强（README 的推荐值）
    form.set('cfg_scale', String(this.cfg.cfgScale ?? 1.0))
    if (this.cfg.instruction?.trim()) form.set('instruction', this.cfg.instruction.trim())

    // 克隆需要参考音频 + 与音频内容一致的文稿，且必须成对出现
    if (this.cfg.refAudioPath && this.cfg.refText) {
      try {
        const buf = await fs.promises.readFile(this.cfg.refAudioPath)
        form.set('ref_audio', new Blob([buf], { type: 'audio/wav' }), path.basename(this.cfg.refAudioPath))
        form.set('ref_text', this.cfg.refText)
      } catch (e) {
        log.warn(`[synthesize] 读取参考音频失败，改用无参考模式: ${(e as Error).message}`)
      }
    }

    const res = await fetch(`${this.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      body: form,
      signal,
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      if (res.status === 409) throw new Error('Breeze 正在合成上一段，请稍后重试')
      if (res.status === 503) throw new Error('Breeze 服务正在加载模型，请稍候')
      throw new Error(`Breeze 合成失败 (${res.status}): ${detail.slice(0, 200)}`)
    }

    const sampleRate = Number(res.headers.get('x-sample-rate')) || this.sampleRate
    this.sampleRate = sampleRate
    log.debug(`[synthesize] 流式开始 sampleRate=${sampleRate} text="${text.slice(0, 40)}"`)

    if (!res.body) {
      onChunk({ samples: [], sampleRate, isFinal: true })
      return
    }

    // s16le 是双字节对齐的，但 fetch 的分块边界不保证对齐。
    // 每块末尾如果剩 1 个字节，要留到下一块拼，否则整段音频会错位成噪声。
    const reader = res.body.getReader()
    let carry: Uint8Array | null = null

    while (true) {
      if (signal?.aborted) {
        void reader.cancel().catch(() => undefined)
        return
      }
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.length) continue

      let bytes = value
      if (carry) {
        bytes = new Uint8Array(carry.length + value.length)
        bytes.set(carry, 0)
        bytes.set(value, carry.length)
        carry = null
      }
      if (bytes.length % 2 === 1) {
        carry = bytes.slice(bytes.length - 1)
        bytes = bytes.slice(0, bytes.length - 1)
      }
      if (!bytes.length) continue

      onChunk({
        samples: s16leToFloat32(bytes),
        sampleRate,
        isFinal: false,
      })
    }

    if (!signal?.aborted) onChunk({ samples: [], sampleRate, isFinal: true })
  }

  destroy(): void {
    // 用户自启的服务不归我们管
    if (this.ownsProcess && this.child) {
      try {
        this.child.kill()
        log.info('[destroy] 已停止自己拉起的 Breeze 进程')
      } catch (e) {
        log.warn(`[destroy] 停止进程失败: ${(e as Error).message}`)
      }
    }
    this.child = null
    this.ownsProcess = false
  }
}

/** s16le 小端 PCM → [-1, 1] 的 Float32 */
export function s16leToFloat32(bytes: Uint8Array): number[] {
  const n = bytes.length >> 1
  const out = new Array<number>(n)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < n; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768
  }
  return out
}
