/**
 * Breeze TTS 2 客户端（HTTP，本地 FastAPI sidecar）。
 *
 * 与 MeloTTS/Qwen3 一样是**内置**引擎：推理代码随应用发版（`assets/breeze/`），
 * 用户只要下模型。这里负责用托管 Python 拉起 `python -m breeze_infer.api`，
 * 健康检查，流式合成。
 *
 * 接口（breeze_infer/api.py）：
 * - `GET  /health`               未加载完返回 503 `{"status":"loading"}`
 * - `POST /v1/audio/speech`      multipart；响应体是流式 **s16le PCM**，
 *                                采样率在响应头 `X-Sample-Rate`
 * - 单并发：已有请求在跑时返回 409
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import type { TtsChunk, TtsProvider } from '../../../shared/tts-engine'
import { ensureBundledPython, getBundledPythonExe } from '../../../main/python-env.js'
import { ensurePythonVenv, getPythonVenvExe } from '../../../main/python-venv.js'

const log = {
  info: (...args: unknown[]) => console.log('[TtsBreeze]', ...args),
  debug: (...args: unknown[]) => console.debug('[TtsBreeze:DEBUG]', ...args),
  warn: (...args: unknown[]) => console.warn('[TtsBreeze]', ...args),
  error: (...args: unknown[]) => console.error('[TtsBreeze]', ...args),
}

/** 模型加载很慢（7.7GB 权重，CPU 上更久），给足时间 */
const READY_TIMEOUT_MS = 600_000
const HEALTH_POLL_MS = 1_000

export interface BreezeConfig {
  /** 本地模型目录（由 hostContext.modelDir 给出） */
  modelDir: string
  port?: number
  cfgScale?: number
  /** 声音设计 / 风格指令（自然语言） */
  instruction?: string
  /** 参考音频（克隆）本地路径 */
  refAudioPath?: string
  /** 参考音频对应的转写，必须与 refAudioPath 成对出现 */
  refText?: string
}

/**
 * 内置推理代码的根目录（含 `breeze_infer/` 与 `configs/`）。
 *
 * 开发态用源码树，打包态从 `resources/assets/breeze` 取（见 electron-builder 的
 * extraResources：整个 assets 目录会原样拷贝）。
 */
export function resolveBundledBreezeRoot(): string {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'assets', 'breeze')]
    : [
        path.join(app.getAppPath(), 'assets', 'breeze'),
        path.join(process.cwd(), 'apps/windows/assets/breeze'),
      ]
  const hit = candidates.find((p) => fs.existsSync(path.join(p, 'breeze_infer', 'api.py')))
  if (!hit) throw new Error(`找不到内置的 Breeze 推理代码（查找过：${candidates.join(', ')}）`)
  return hit
}

/** 与 Qwen3 共用同一个托管 Python（两者都钉 torch 2.9.1） */
async function resolvePythonExe(): Promise<string> {
  if (process.platform !== 'win32') return ensurePythonVenv(() => undefined)
  return ensureBundledPython(() => undefined)
}

function isAppManagedPython(pythonExe: string): boolean {
  return process.platform === 'win32'
    ? pythonExe === getBundledPythonExe()
    : pythonExe === getPythonVenvExe()
}

/** 清掉 conda/PYTHONPATH，避免加载到系统站点包 */
function buildIsolatedPythonEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  delete env.PYTHONPATH
  delete env.PYTHONHOME
  delete env.CONDA_PREFIX
  delete env.CONDA_DEFAULT_ENV
  delete env.CONDA_PYTHON_EXE
  env.PYTHONNOUSERSITE = '1'
  env.PYTHONIOENCODING = 'utf-8'
  return env
}

export class BreezeTtsProvider implements TtsProvider {
  readonly name = 'breeze-tts'
  readonly isLocal = true
  sampleRate = 24_000

  private child: ChildProcess | null = null
  private baseUrl: string

  constructor(private cfg: BreezeConfig) {
    this.baseUrl = `http://127.0.0.1:${cfg.port ?? 7860}`
  }

  async initialize(): Promise<void> {
    if (await this.healthOk()) {
      log.info(`[initialize] 复用已在运行的服务: ${this.baseUrl}`)
      return
    }
    await this.spawnAndWait()
  }

  /**
   * 热更新「自然语言音色描述」。
   *
   * Breeze 没有固定音色表：想要什么声音就描述什么（如「一位温柔自信的年轻女声，
   * 语速偏快，像体育播报」）。传 null 清除，回到模型默认音色。不用重建引擎。
   */
  setInstruction(instruction: string | null): void {
    this.cfg.instruction = instruction?.trim() || undefined
  }

  /** 托管 Python 里 torch 能否用 CUDA（决定是否走 fast 路径） */
  private async hasCuda(): Promise<boolean> {
    try {
      const python = await resolvePythonExe()
      return await new Promise<boolean>((resolve) => {
        const p = spawn(python, ['-c', 'import torch;print(torch.cuda.is_available())'], {
          windowsHide: true,
          env: buildIsolatedPythonEnv(),
        })
        let out = ''
        p.stdout?.on('data', (b: Buffer) => (out += b.toString()))
        p.on('error', () => resolve(false))
        p.on('exit', () => resolve(out.trim() === 'True'))
      })
    } catch {
      return false
    }
  }

  /**
   * CPU 推理的线程数。
   *
   * 实测 i5-14400（10 核 16 线程）：8 线程 RTF 13.6，16 线程 RTF 20.0——
   * 超线程在这个模型上是负收益（GEMM 已经吃满物理核，多出来的线程只抢 L3）。
   * 没有可靠跨平台 API 拿物理核数，这里用逻辑核数的一半做近似，至少 1。
   */
  private get cpuThreads(): number {
    return Math.max(1, Math.floor(os.cpus().length / 2))
  }

  /**
   * CPU 推理慢，先在启动日志里说清楚，避免用户对着长时间无响应猜原因。
   *
   * 阈值来自实测（i5-14400 / 32GB）：8 线程 RTF 13.6、首帧 ~4s、7.7GB 权重加载约 40s。
   * 核数更少或内存不足时只会更慢，这两种机器直接提示「别指望实时」。
   */
  private warnIfTooSlow(useFast: boolean): void {
    if (useFast) return
    const cores = os.cpus().length
    const memGb = os.totalmem() / 1024 ** 3
    if (cores < 8 || memGb < 12) {
      log.warn(
        `[spawn] CPU 推理且本机只有 ${cores} 线程 / ${Math.round(memGb)}GB 内存：` +
          'Breeze 会明显慢于实时（可能数十倍），语音通话场景基本不可用',
      )
      return
    }
    log.info(`[spawn] 无 CUDA，走 CPU eager 推理：约 5s 首帧、15～20 倍实时`)
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
    const root = resolveBundledBreezeRoot()
    const python = await resolvePythonExe()
    if (!isAppManagedPython(python)) {
      throw new Error(`Breeze 需要应用托管的 Python，当前解释器不受管：${python}`)
    }
    if (!fs.existsSync(this.cfg.modelDir)) {
      throw new Error(`Breeze 模型目录不存在：${this.cfg.modelDir}`)
    }

    const port = this.cfg.port ?? 7860
    // fast 路径（CUDA Graph / torch.compile）只在有 GPU 时开。CPU 上内置代码会
    // 自动退回全 eager（见 fast_streaming.py 的 _is_cuda 分支），但那只是能跑，
    // 仍是秒级 RTF —— 实测 5 秒级首帧 / 15～20 倍实时，只适合非实时场景。
    const useFast = await this.hasCuda()
    this.warnIfTooSlow(useFast)
    log.info(
      `[spawn] root=${root} model=${this.cfg.modelDir} port=${port} fast=${useFast} threads=${this.cpuThreads}`,
    )

    // 不能用 `-m breeze_infer.api` + PYTHONPATH：内置 embed Python 会忽略 PYTHONPATH
    // （实测 ModuleNotFoundError），而 `-m` 要求模块在 sys.path 里。
    // 用 `-c` 显式把代码根目录插进去最稳，也顺便固定了 argv。
    //
    // `--fast-all` 还需要 flash-attn；我们没装（Windows 上要编译 CUDA 扩展），
    // 所以只开不依赖它的三项：text-encoder / depth-decoder / codec。
    const fastArgs = useFast
      ? ['--fast-text-encoder', '--fast-depth-decoder', '--fast-codec']
      : []
    const bootScript = [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(root)})`,
      // 线程数必须在模型加载前设，否则会按默认逻辑核数（本机 16）跑，实测反而更慢。
      // `set_num_threads(0)` 非法，所以只在 CPU 分支注入这一行。
      ...(useFast ? [] : ['import torch', `torch.set_num_threads(${this.cpuThreads})`]),
      `sys.argv = ${JSON.stringify([
        'breeze_infer.api',
        this.cfg.modelDir,
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        ...fastArgs,
      ])}`,
      'from breeze_infer.api import main',
      'main()',
    ].join('\n')

    this.child = spawn(python, ['-c', bootScript], {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildIsolatedPythonEnv(),
    })

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
        throw new Error('Breeze 进程已退出，请查看日志（多半是依赖未装完或模型不完整）')
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS))
    }
    throw new Error(`Breeze 服务在 ${READY_TIMEOUT_MS / 1000}s 内未就绪（模型加载较慢）`)
  }

  async synthesize(
    text: string,
    onChunk: (chunk: TtsChunk) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!text.trim() || signal?.aborted) return

    const form = new FormData()
    form.set('text', text)
    // README 推荐 4 能明显增强指令跟随，代价是更慢
    form.set('cfg_scale', String(this.cfg.cfgScale ?? 1.0))
    if (this.cfg.instruction?.trim()) form.set('instruction', this.cfg.instruction.trim())

    // 克隆需要参考音频 + 与音频内容一致的文稿，且必须成对出现
    if (this.cfg.refAudioPath && this.cfg.refText) {
      try {
        const buf = await fs.promises.readFile(this.cfg.refAudioPath)
        form.set(
          'ref_audio',
          new Blob([buf], { type: 'audio/wav' }),
          path.basename(this.cfg.refAudioPath),
        )
        form.set('ref_text', this.cfg.refText)
        // 克隆是否真的生效只能从这里看出来：服务端把 ref 当额外段编码，
        // 不带它时返回的波形和默认音色一样，不会报错。
        log.info(
          `[synthesize] 克隆模式 ref=${buf.length}B text="${this.cfg.refText.slice(0, 20)}"`,
        )
      } catch (e) {
        log.warn(`[synthesize] 读取参考音频失败，改用无参考模式: ${(e as Error).message}`)
      }
    } else if (this.cfg.instruction?.trim()) {
      log.info(`[synthesize] 指令模式 "${this.cfg.instruction.trim().slice(0, 30)}"`)
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

      onChunk({ samples: s16leToFloat32(bytes), sampleRate, isFinal: false })
    }

    if (!signal?.aborted) onChunk({ samples: [], sampleRate, isFinal: true })
  }

  destroy(): void {
    if (this.child) {
      try {
        this.child.kill()
        log.info('[destroy] 已停止 Breeze 进程')
      } catch (e) {
        log.warn(`[destroy] 停止进程失败: ${(e as Error).message}`)
      }
    }
    this.child = null
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
