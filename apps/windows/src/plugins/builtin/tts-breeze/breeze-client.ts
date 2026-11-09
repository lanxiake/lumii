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
import type { TtsChunk, TtsProvider, TtsVoiceAnchor } from '../../../shared/tts-engine'
import { normalizeLoudness } from '../../../shared/tts-audio-utils'
import { ensureBundledPython, getBundledPythonExe, PYPI_MIRROR } from '../../../main/python-env.js'
import { ensurePythonVenv, getPythonVenvExe } from '../../../main/python-venv.js'
import { pipInstallIntoManagedPython } from '../../../main/voice/qwen3-tts-client.js'
import { classifyBreezeFailure, describeBreezeFailure } from './breeze-failure.js'
import { freePort, isPortInUse, killPid } from './breeze-port.js'

const log = {
  info: (...args: unknown[]) => console.log('[TtsBreeze]', ...args),
  debug: (...args: unknown[]) => console.debug('[TtsBreeze:DEBUG]', ...args),
  warn: (...args: unknown[]) => console.warn('[TtsBreeze]', ...args),
  error: (...args: unknown[]) => console.error('[TtsBreeze]', ...args),
}

/** 模型加载很慢（7.7GB 权重，CPU 上更久；fast 模式还要录 CUDA Graph），给足时间 */
const READY_TIMEOUT_MS = 600_000
const HEALTH_POLL_MS = 1_000
/** 启动失败后的自动补救次数上限（装依赖 / 退回 eager / 退回 CPU / 清端口） */
const MAX_START_ATTEMPTS = 4
/** 10 分钟内服务崩溃重启超过这么多次就不再自动拉起，避免无限循环吃 GPU */
const MAX_RESTARTS_PER_WINDOW = 3
const RESTART_WINDOW_MS = 600_000
/** 首个音频字节的等待上限；超过视为服务卡死（实测 fast 0.3s、CPU eager 约 5s） */
const FIRST_BYTE_TIMEOUT_MS = 180_000
/** 流式过程中两块数据之间的最长间隔 */
const IDLE_TIMEOUT_MS = 90_000
/** 409（服务端还在跑上一条被取消的请求）最多等这么久 */
const BUSY_WAIT_MS = 120_000

/**
 * 同一端口的服务状态在所有 provider 实例间共享：voice-service 会频繁创建/销毁
 * 临时 provider，但服务进程只有一个。放在实例上会丢掉进程句柄和「fast 已失败」的记忆。
 */
interface ServiceState {
  child: ChildProcess | null
  starting: Promise<void> | null
  fast: boolean
  /** 本次会话里 fast 路径失败过：之后都走 eager，不再反复踩坑 */
  fastBroken: boolean
  /** GPU 上连 eager 都起不来（如显存不足）：退到 CPU */
  cpuOnly: boolean
  restartTimes: number[]
  /** 本会话里服务成功就绪过：之后的启动都算「崩溃重启」，计入频率上限 */
  wasReady: boolean
  /** 已接管一个非本进程拉起的服务（只探测一次 fast 模式） */
  adopted: boolean
}
const services = new Map<number, ServiceState>()
let quitHookInstalled = false

function serviceFor(port: number): ServiceState {
  let s = services.get(port)
  if (!s) {
    s = {
      child: null,
      starting: null,
      fast: false,
      fastBroken: false,
      cpuOnly: false,
      restartTimes: [],
      wasReady: false,
      adopted: false,
    }
    services.set(port, s)
  }
  return s
}

/**
 * 应用退出时结束服务进程。Windows 上子进程**不会**随父进程退出——
 * 之前的僵尸进程占端口不响应，根源就是这里没收尾。
 */
function installQuitHook(): void {
  if (quitHookInstalled) return
  quitHookInstalled = true
  app.once('will-quit', () => {
    for (const s of services.values()) {
      if (s.child?.pid) killPid(s.child.pid)
    }
  })
}

type BreezeErrorKind = 'busy' | 'loading' | 'down' | 'stalled' | 'bad-ref' | 'fatal'

/** 合成请求失败的分类：决定能否自动补救 */
export class BreezeRequestError extends Error {
  constructor(
    readonly kind: BreezeErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'BreezeRequestError'
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(abortError())), { once: true })
  })

function abortError(): Error {
  const e = new Error('已取消')
  e.name = 'AbortError'
  return e
}

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

  private readonly port: number
  private baseUrl: string
  /**
   * 音色锚点：第一段合成出来的音频 + 对应文本。
   *
   * 自回归 TTS 逐段独立采样，同一句 instruction 每段的音色/语速都会漂——
   * 长文听起来像换了个人。固定 seed 只能保证同一句输入结果确定，管不住不同文本。
   * 唯一可靠的锁是服务端的克隆模式：把第一段当成参考音，后续都用 `ref_audio` 锚定。
   * 只活在本实例（一次预览 / 一次通话）里，不跨会话复用。
   */
  private anchor: TtsVoiceAnchor | null = null
  /** 锚点文件是本实例 saveAnchor 写的（destroy 时才删）；外部注入的锚点不归本实例管 */
  private ownsAnchorFile = false
  private readonly anchorId = Math.random().toString(36).slice(2, 10)
  /**
   * 单次请求的文本上限。服务端一次最多生成 1500 token（12.5 帧/秒 ≈ 120 秒音频），
   * 克隆模式还要给参考音（≤30 秒）留位置；中文约 4 字/秒，200 字约 50 秒，余量充足。
   * 超长文本由调用方按句切开逐段合成，不然尾部会被静默截掉。
   */
  readonly maxCharsPerRequest = 200

  constructor(private cfg: BreezeConfig) {
    this.port = cfg.port ?? 7860
    this.baseUrl = `http://127.0.0.1:${this.port}`
    installQuitHook()
  }

  private get svc(): ServiceState {
    return serviceFor(this.port)
  }

  async initialize(): Promise<void> {
    await this.ensureReady()
  }

  /**
   * 保证服务可用：健康就直接用；别人正在拉起就等同一个 Promise；否则（重新）拉起。
   * 运行中崩溃后的自动重启有频率上限，坏环境下不会无限重启。
   */
  private async ensureReady(): Promise<void> {
    const s = this.svc
    if (s.starting) return s.starting

    let st = await this.healthStatus()
    if (st === 'down' && (await isPortInUse(this.port))) {
      // 端口有人占着但没答：可能正忙于长推理（批量合成能跑一两分钟），多给几次机会再判死，
      // 否则会把正在干活的服务当僵尸杀掉
      for (let i = 0; i < 2 && st === 'down'; i++) st = await this.healthStatus(10_000)
    }
    if (st === 'loading') {
      log.info('[ensureReady] 服务正在加载模型，等待就绪')
      if ((await this.waitUntilReady(null)) !== 'ready') {
        throw new Error(`Breeze 服务在 ${READY_TIMEOUT_MS / 1000}s 内未加载完成，请重启应用后重试`)
      }
      st = 'ok'
    }
    if (st === 'ok') {
      if (!s.child && !s.adopted) {
        // 不是本进程拉起的（上次会话遗留 / 用户自己起的）：按 CUDA 是否可用推断模式
        s.fast = !s.cpuOnly && !s.fastBroken && (await this.canUseFast())
        s.adopted = true
        log.info(`[ensureReady] 复用已在运行的服务: ${this.baseUrl} fast=${s.fast}`)
      }
      return
    }

    if (s.wasReady) {
      const now = Date.now()
      s.restartTimes = s.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS)
      if (s.restartTimes.length >= MAX_RESTARTS_PER_WINDOW) {
        throw new Error(
          `Breeze 服务 10 分钟内已崩溃 ${s.restartTimes.length} 次，已暂停自动重启。请稍后再试，或重启应用`,
        )
      }
      s.restartTimes.push(now)
      log.warn(`[ensureReady] 服务不可用，自动重启（10 分钟内第 ${s.restartTimes.length} 次）`)
    }
    s.adopted = false
    s.starting = this.startWithRecovery().finally(() => {
      s.starting = null
    })
    return s.starting
  }

  /** 结束卡死/出错的服务进程，下一次 ensureReady 会重新拉起 */
  private async recycle(reason: string): Promise<void> {
    const s = this.svc
    log.warn(`[recycle] ${reason}，结束服务进程以便重启`)
    if (s.child?.pid) killPid(s.child.pid)
    else await freePort(this.port).catch((e) => log.warn(`[recycle] 清理端口失败: ${(e as Error).message}`))
    s.child = null
    s.adopted = false
  }

  /**
   * 拉起服务，失败时按原因自动补救后重试：
   * - 缺依赖 → pip 补装（白名单内的包）
   * - fast 路径（CUDA Graph）初始化失败 → 本会话改走 eager
   * - 显存不足 → 先退 eager（不录 Graph 省显存），再不行退 CPU
   * - 端口被占 → 清理残留的 Python 进程
   * 同一种补救只做一次；补救不了就给出可操作的报错。
   */
  private async startWithRecovery(): Promise<void> {
    const s = this.svc
    const tried = new Set<string>()
    let lastTail = ''
    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
      const fast = !s.cpuOnly && !s.fastBroken && (await this.canUseFast())
      const result = await this.spawnOnce(fast, s.cpuOnly)
      if (result.ok) {
        s.fast = fast
        s.wasReady = true
        return
      }
      lastTail = result.tail
      const failure = classifyBreezeFailure(result.tail)
      log.warn(`[startWithRecovery] 第 ${attempt} 次启动失败（${failure.kind}，fast=${fast}）`)

      let fix: string | null = null
      if (failure.kind === 'missing-module' && failure.pipSpec && !tried.has(failure.pipSpec)) {
        fix = failure.pipSpec
        log.info(`[startWithRecovery] 补装缺失依赖 ${failure.pipSpec}`)
        await pipInstallIntoManagedPython(
          [failure.pipSpec, '-i', PYPI_MIRROR],
          `正在补装 Breeze 依赖 ${failure.module}…`,
        )
      } else if ((failure.kind === 'fast-path' || failure.kind === 'cuda-oom' || failure.kind === 'unknown') && fast) {
        // 未知错误也先退 eager：fast 路径的失败形态五花八门，eager 是上游的保底路径
        fix = 'no-fast'
        s.fastBroken = true
        log.warn('[startWithRecovery] GPU 加速路径失败，本次会话改用普通 GPU 推理')
      } else if (failure.kind === 'cuda-oom' && !s.cpuOnly) {
        fix = 'cpu'
        s.cpuOnly = true
        log.warn('[startWithRecovery] 显存不足，改用 CPU 推理（会明显变慢）')
      } else if (failure.kind === 'port-in-use' && !tried.has('port')) {
        fix = 'port'
        await freePort(this.port)
      }
      if (!fix || tried.has(fix)) {
        throw new Error(describeBreezeFailure(failure, lastTail))
      }
      tried.add(fix)
    }
    throw new Error(describeBreezeFailure(classifyBreezeFailure(lastTail), lastTail))
  }

  /**
   * 热更新「自然语言音色描述」。
   *
   * Breeze 没有固定音色表：想要什么声音就描述什么（如「一位温柔自信的年轻女声，
   * 语速偏快，像体育播报」）。传 null 清除，回到模型默认音色。不用重建引擎。
   */
  setInstruction(instruction: string | null): void {
    const next = instruction?.trim() || undefined
    // 自动锚点是按旧描述生成的，换描述后还用它克隆会一直是旧声音。
    // 外部注入的锚点（命名音色）保留：attachVoice 会在它的基础上按新描述调整。
    if (next !== this.cfg.instruction && this.ownsAnchorFile) this.dropAnchor()
    this.cfg.instruction = next
  }

  getVoiceAnchor(): TtsVoiceAnchor | null {
    return this.hasUserRef ? null : this.anchor
  }

  /**
   * 注入外部保存的锚点（跨次调用复用同一个声音）。注入的文件归调用方管，本实例不删。
   * 用户在设置里选了克隆档案时，档案优先，注入的锚点不生效。
   */
  setVoiceAnchor(anchor: TtsVoiceAnchor | null): void {
    this.dropAnchor()
    this.anchor = anchor
  }

  /** 作废当前锚点；是本实例写的文件就顺手删掉 */
  private dropAnchor(): void {
    if (this.anchor && this.ownsAnchorFile) {
      void fs.promises.rm(this.anchor.audioPath, { force: true }).catch(() => undefined)
    }
    this.anchor = null
    this.ownsAnchorFile = false
  }

  /**
   * 能否走 fast（CUDA Graph）路径：只看 CUDA。
   *
   * fast 路径里只有 depth decoder 和 qwen_tts 编解码器调了 `torch.compile`（要 triton，
   * Windows 没有）；提速主要来自 CUDA Graph，不依赖 triton。缺 triton 时启动脚本把
   * `torch.compile` 换成原样返回，实测 4060 Ti 单句 35.7s → 8.8s、首帧 4.4s → 0.26s。
   */
  private async canUseFast(): Promise<boolean> {
    try {
      const python = await resolvePythonExe()
      const code = ['import torch', 'print(torch.cuda.is_available())'].join('\n')
      return await new Promise<boolean>((resolve) => {
        const p = spawn(python, ['-c', code], {
          windowsHide: true,
          env: buildIsolatedPythonEnv(),
        })
        let out = ''
        p.stdout?.on('data', (b: Buffer) => (out += b.toString()))
        p.on('error', () => resolve(false))
        p.on('exit', () => resolve(out.trim().split(/\r?\n/).pop() === 'True'))
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
    log.info('[spawn] 未检测到 CUDA，走 CPU eager 推理：约 5s 首帧、15～20 倍实时')
  }

  /** ok=可合成；loading=进程在、模型还在加载（503）；down=没响应 */
  private async healthStatus(timeoutMs = 3_000): Promise<'ok' | 'loading' | 'down'> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) })
      if (res.status === 503) return 'loading'
      if (!res.ok) return 'down'
      const body = (await res.json()) as { status?: string }
      return body.status === 'ok' ? 'ok' : 'loading'
    } catch {
      return 'down'
    }
  }

  /**
   * 轮询直到就绪。传入 child 时，进程退出立即返回 'exited'（不必干等到超时）。
   */
  private async waitUntilReady(child: ChildProcess | null): Promise<'ready' | 'exited' | 'timeout'> {
    let exited = false
    child?.once('exit', () => (exited = true))
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if ((await this.healthStatus()) === 'ok') return 'ready'
      if (exited || (child && child.exitCode !== null)) return 'exited'
      await sleep(HEALTH_POLL_MS)
    }
    return 'timeout'
  }

  /** 拉起一次服务；失败时返回 stderr 尾部供分类补救 */
  private async spawnOnce(useFast: boolean, cpuOnly: boolean): Promise<{ ok: true } | { ok: false; tail: string }> {
    const s = this.svc
    const root = resolveBundledBreezeRoot()
    const python = await resolvePythonExe()
    if (!isAppManagedPython(python)) {
      throw new Error(`Breeze 需要应用托管的 Python，当前解释器不受管：${python}`)
    }
    if (!fs.existsSync(path.join(this.cfg.modelDir, 'config.json'))) {
      throw new Error(
        `Breeze 模型不完整（缺 config.json）：${this.cfg.modelDir}。请在「设置 → 语音」重新下载 Breeze 模型`,
      )
    }

    // 端口上不健康的残留 Python 进程（上次没退干净）会让新进程 bind 失败：先清掉
    const freed = await freePort(this.port)
    if (freed.length) log.warn(`[spawn] 已清理占用端口 ${this.port} 的残留进程 PID ${freed.join(',')}`)

    this.warnIfTooSlow(useFast)
    log.info(
      `[spawn] root=${root} model=${this.cfg.modelDir} port=${this.port} fast=${useFast} cpuOnly=${cpuOnly} threads=${this.cpuThreads}`,
    )

    // 不能用 `-m breeze_infer.api` + PYTHONPATH：内置 embed Python 会忽略 PYTHONPATH
    // （实测 ModuleNotFoundError），而 `-m` 要求模块在 sys.path 里。
    // 用 `-c` 显式把代码根目录插进去最稳，也顺便固定了 argv。
    //
    // 不用 `--fast-all`：它会要求 flash-attn（Windows 上要编译 CUDA 扩展）。
    // 五个阶段逐项开，attention 走 PyTorch 手写实现，CUDA Graph 照样能录。
    const fastArgs = useFast
      ? [
          '--fast-text-encoder',
          '--fast-backbone-prefill',
          '--fast-backbone-decode',
          '--fast-depth-decoder',
          '--fast-codec',
        ]
      : []
    // 没有 triton 时 torch.compile 会在 warmup 里 TritonMissing 退出；换成原样返回，
    // 只丢掉算子融合那一小截收益，CUDA Graph 不受影响。有 triton（Linux）就照常编译。
    const noCompileShim = [
      'try:',
      '    import triton',
      'except Exception:',
      '    torch.compile = lambda m=None, **k: m if m is not None else (lambda f: f)',
    ]
    const bootScript = [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(root)})`,
      'import torch',
      // 线程数必须在模型加载前设，否则会按默认逻辑核数（本机 16）跑，实测反而更慢。
      // `set_num_threads(0)` 非法，所以只在 CPU 推理时注入这一行。
      ...(useFast ? noCompileShim : []),
      ...(cpuOnly || !useFast ? [`torch.set_num_threads(${this.cpuThreads})`] : []),
      `sys.argv = ${JSON.stringify([
        'breeze_infer.api',
        this.cfg.modelDir,
        '--host',
        '127.0.0.1',
        '--port',
        String(this.port),
        ...fastArgs,
      ])}`,
      'from breeze_infer.api import main',
      'main()',
    ].join('\n')

    // 显存不足退 CPU：隐藏显卡，resolve_device() 就会选 cpu
    const child = spawn(python, ['-c', bootScript], {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildIsolatedPythonEnv(cpuOnly ? { CUDA_VISIBLE_DEVICES: '' } : undefined),
    })
    s.child = child

    // 子进程日志转进主日志。保留最后一段 stderr：进程异常退出时，
    // 真正的原因（缺依赖 / 端口冲突 / OOM）往往就在最后几行。
    let tailErr = ''
    child.stdout?.on('data', (b: Buffer) => log.debug(String(b).trimEnd()))
    child.stderr?.on('data', (b: Buffer) => {
      const t = String(b)
      tailErr = (tailErr + t).slice(-6000)
      log.warn(t.trimEnd())
    })
    child.on('error', (e) => {
      tailErr += `\n${e.message}`
      log.error(`[spawn] 进程启动失败: ${e.message}`)
    })
    child.on('exit', (code) => {
      if (s.child === child) s.child = null
      if (code === 0) log.info('[spawn] 进程正常退出')
      else log.error(`[spawn] 进程退出 code=${code}，最后的 stderr：\n${tailErr.slice(-1500)}`)
    })

    const r = await this.waitUntilReady(child)
    if (r === 'ready') {
      log.info('[spawn] 服务就绪')
      return { ok: true }
    }
    if (r === 'timeout') {
      if (child.pid) killPid(child.pid)
      // 超时多半是 fast 模式录 Graph 卡住或机器太慢：按未知错误处理（fast 时会先退 eager）
      return { ok: false, tail: `${tailErr}\n[lumii] 启动超时（${READY_TIMEOUT_MS / 1000}s 内未就绪）` }
    }
    return { ok: false, tail: tailErr }
  }

  /** 选本次合成用的参考音：用户样本优先，其次是本次会话的锚点 */
  private pickReference(): TtsVoiceAnchor | null {
    if (this.cfg.refAudioPath && this.cfg.refText) {
      return { audioPath: this.cfg.refAudioPath, text: this.cfg.refText }
    }
    return this.anchor
  }

  private get hasUserRef(): boolean {
    return Boolean(this.cfg.refAudioPath && this.cfg.refText)
  }

  /**
   * 填音色相关字段：参考音 + instruction。
   *
   * 有参考音时，instruction 会让服务端走「按描述改写参考音」模板（ref_edit），每段都
   * 重新套一遍描述，音色反而会漂。所以：
   * - 锚点就是按当前描述生成的 → 纯克隆，不再带 instruction
   * - 描述变了（如「同一个声音，更激动一些」）或用户的克隆样本 → 克隆 + 描述
   * 读不到参考音：自动锚点作废，退回纯描述模式。
   */
  private async attachVoice(form: FormData, tag: string): Promise<void> {
    const instruction = this.cfg.instruction?.trim() || undefined
    const ref = this.pickReference()
    if (ref) {
      try {
        const buf = await fs.promises.readFile(ref.audioPath)
        form.set('ref_audio', new Blob([buf], { type: 'audio/wav' }), path.basename(ref.audioPath))
        form.set('ref_text', ref.text)
        const editing = Boolean(instruction) && (this.hasUserRef || instruction !== ref.instruction?.trim())
        if (editing) form.set('instruction', instruction!)
        // 克隆是否真的生效只能从这里看出来：不带 ref 时返回默认音色，不会报错
        log.info(
          `[${tag}] 克隆模式 ref=${buf.length}B text="${ref.text.slice(0, 20)}"${editing ? ` 叠加描述="${instruction!.slice(0, 20)}"` : ''}`,
        )
        return
      } catch (e) {
        if (!this.hasUserRef) this.dropAnchor()
        log.warn(`[${tag}] 读取参考音频失败，改用无参考模式: ${(e as Error).message}`)
      }
    }
    if (instruction) {
      form.set('instruction', instruction)
      log.info(`[${tag}] 指令模式 "${instruction.slice(0, 30)}"`)
    }
  }

  /**
   * 发合成请求并就地补救，返回 2xx 响应和本次请求的 AbortSignal（读响应体要用）：
   * - 409：服务端还在跑上一条——被取消的请求不会中断推理，等它跑完
   * - 503：模型加载中，等就绪
   * - 连不上 / 超时无响应：服务挂了或卡死，重启后重试
   * - 5xx：推理出错（CUDA 上下文可能已坏），重启后重试；fast 模式下再错就降级 eager
   * - 400 且带的是自动锚点：锚点坏了，丢掉重试
   */
  private async request(
    pathname: string,
    makeForm: () => Promise<FormData>,
    signal: AbortSignal | undefined,
    headerTimeoutMs: number,
  ): Promise<{ res: Response; signal: AbortSignal }> {
    let restarts = 0
    const busyDeadline = Date.now() + BUSY_WAIT_MS
    for (;;) {
      if (signal?.aborted) throw abortError()
      await this.ensureReady()

      // 超时只管「等响应头」；拿到响应后清掉计时器，否则长音频读到一半会被掐断
      const ctl = new AbortController()
      const onAbort = () => ctl.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      let timedOut = false
      const timer = setTimeout(() => ((timedOut = true), ctl.abort()), headerTimeoutMs)
      let res: Response
      try {
        res = await fetch(`${this.baseUrl}${pathname}`, {
          method: 'POST',
          body: await makeForm(),
          signal: ctl.signal,
        })
      } catch (e) {
        signal?.removeEventListener('abort', onAbort)
        if (signal?.aborted) throw abortError()
        const why = timedOut
          ? `请求 ${headerTimeoutMs / 1000}s 无响应`
          : `连接失败（${(e as Error).message}）`
        await this.recoverOrThrow(restarts++, timedOut ? 'stalled' : 'down', why)
        continue
      } finally {
        clearTimeout(timer)
      }
      if (res.ok) return { res, signal: ctl.signal }
      signal?.removeEventListener('abort', onAbort)

      const detail = await res.text().catch(() => '')
      if (res.status === 409) {
        if (Date.now() > busyDeadline) {
          throw new BreezeRequestError('busy', 'Breeze 仍在处理上一段合成，请稍后重试')
        }
        await sleep(1_000, signal)
        continue
      }
      if (res.status === 503) {
        await sleep(1_000, signal)
        continue
      }
      if (res.status === 400 && this.anchor && !this.hasUserRef) {
        log.warn(`[request] 带锚点的请求被拒（${detail.slice(0, 120)}），作废锚点后重试`)
        this.dropAnchor()
        continue
      }
      if (res.status >= 500) {
        await this.recoverOrThrow(restarts++, 'down', `服务内部错误 ${res.status}: ${detail.slice(0, 160)}`)
        continue
      }
      throw new BreezeRequestError('fatal', `Breeze 合成失败 (${res.status})：${detail.slice(0, 200)}`)
    }
  }

  /**
   * 运行期故障的补救阶梯：第一次重启服务；fast 模式下再出错就降级 eager 再重启；
   * 还不行就抛出可读错误。
   */
  private async recoverOrThrow(restarts: number, kind: BreezeErrorKind, why: string): Promise<void> {
    const s = this.svc
    if (restarts === 0) {
      await this.recycle(why)
      return
    }
    if (restarts === 1 && s.fast && !s.fastBroken) {
      s.fastBroken = true
      await this.recycle(`${why}；GPU 加速模式反复出错，降级为普通 GPU 推理`)
      return
    }
    throw new BreezeRequestError(
      kind,
      kind === 'stalled'
        ? `Breeze 合成无响应（${why}），重启服务后仍未恢复。请重启应用后重试`
        : `Breeze 服务异常（${why}），重启后仍未恢复。请重启应用；仍不行可在「设置 → 语音」重新安装语音运行时`,
    )
  }

  /** 读一块响应体；超过 IDLE_TIMEOUT_MS 没数据视为服务卡死 */
  private async readChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    let timer: NodeJS.Timeout | undefined
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new BreezeRequestError('stalled', `Breeze 合成中途 ${IDLE_TIMEOUT_MS / 1000}s 无数据`)),
        IDLE_TIMEOUT_MS,
      )
    })
    try {
      return await Promise.race([reader.read(), idle])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 一次合成多段。
   *
   * 服务端 `/v1/audio/speech/batch` 把所有段放进同一次 eager forward：共用同一份
   * 参考音与 seed，所以段间音色天然一致。音频按段返回，用响应头 `X-Segment-Bytes` 切分。
   */
  async synthesizeBatch(
    texts: string[],
    signal?: AbortSignal,
  ): Promise<Array<{ samples: number[]; sampleRate: number }> | null> {
    // fast 模式下单句走 CUDA Graph 已比批量 eager 快（实测 3 段：逐句约 30s / 批量 100s），
    // 且批量后显存不回落会拖慢后续单句；音色靠首段锚点克隆锁住。批量只留给 eager 场景。
    await this.ensureReady()
    if (this.svc.fast) return null
    const list = texts.filter((t) => t.trim())
    if (list.length === 0 || signal?.aborted) return []

    const makeForm = async () => {
      const form = new FormData()
      form.set('texts', JSON.stringify(list))
      form.set('cfg_scale', String(this.cfg.cfgScale ?? 1.0))
      await this.attachVoice(form, 'synthesizeBatch')
      return form
    }
    // 批量接口算完才回响应头：超时按段数放宽（CPU 上一段约 1 分钟）
    const { res } = await this.request(
      '/v1/audio/speech/batch',
      makeForm,
      signal,
      Math.max(FIRST_BYTE_TIMEOUT_MS, list.length * 120_000),
    )

    const sampleRate = Number(res.headers.get('x-sample-rate')) || this.sampleRate
    this.sampleRate = sampleRate
    const sizes = (res.headers.get('x-segment-bytes') ?? '')
      .split(',')
      .filter((s) => s.trim() !== '')
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n >= 0)
    const body = Buffer.from(await res.arrayBuffer())

    // 按响应头切分；长度对不上（服务端版本差异）就整体当一段，至少不丢音频
    if (sizes.reduce((a, b) => a + b, 0) !== body.length) {
      log.warn(
        `[synthesizeBatch] 分段字节数与响应体不符（${sizes.length} 段 / ${body.length}B），按单段处理`,
      )
      return [{ samples: s16leToFloat32(body), sampleRate }]
    }

    const raw: number[][] = []
    let offset = 0
    for (const size of sizes) {
      raw.push(s16leToFloat32(body.subarray(offset, offset + size)))
      offset += size
    }
    // 同一批里各段响度差可达 2 倍（实测 RMS 0.09 / 0.20 / 0.10），统一到中位响度
    const out = normalizeLoudness(raw).map((samples) => ({ samples, sampleRate }))
    log.info(`[synthesizeBatch] 一次合成 ${out.length} 段，共 ${(body.length / 1024).toFixed(0)}KB`)
    return out
  }

  async synthesize(
    text: string,
    onChunk: (chunk: TtsChunk) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!text.trim() || signal?.aborted) return

    const makeForm = async () => {
      const form = new FormData()
      form.set('text', text)
      // README 推荐 4 能明显增强指令跟随，代价是更慢
      form.set('cfg_scale', String(this.cfg.cfgScale ?? 1.0))
      // 参考音优先级：用户指定的克隆样本 > 锚点（自动生成或外部注入）> 无（纯指令模式）
      await this.attachVoice(form, 'synthesize')
      return form
    }
    const { res, signal: reqSignal } = await this.request('/v1/audio/speech', makeForm, signal, FIRST_BYTE_TIMEOUT_MS)

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

    // 只在本段是「立锚点」的候选时收集波形：用户已给克隆样本，或已经有锚点，都不用再存
    const needAnchor = !this.pickReference()
    const pcmParts: Buffer[] = []
    let pcmBytes = 0
    /**
     * 锚点音频最长 30 秒——再长会让后面每次合成都变慢。超过就不用这段当锚点
     * （而不是截断）：锚点的文本必须和音频逐字对应，截掉一半音频文本就对不上了。
     */
    const ANCHOR_MAX_BYTES = 30 * sampleRate * 2

    while (true) {
      if (signal?.aborted || reqSignal.aborted) {
        void reader.cancel().catch(() => undefined)
        return
      }
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await this.readChunk(reader)
      } catch (e) {
        void reader.cancel().catch(() => undefined)
        if (signal?.aborted) return
        // 已经推出去的音频收不回来，这一句不重试；把服务收拾好，下一句会自动重启
        if (e instanceof BreezeRequestError && e.kind === 'stalled') {
          await this.recycle(e.message)
          throw new BreezeRequestError('stalled', `${e.message}，已重启 Breeze 服务，下一句会自动恢复`)
        }
        throw new BreezeRequestError('down', `Breeze 服务在合成中途断开（${(e as Error).message}），下一句会自动重启`)
      }
      const { done, value } = chunk
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

      if (needAnchor && pcmBytes <= ANCHOR_MAX_BYTES) {
        pcmParts.push(Buffer.from(bytes))
        pcmBytes += bytes.length
      }
      onChunk({ samples: s16leToFloat32(bytes), sampleRate, isFinal: false })
    }

    if (!signal?.aborted) {
      // 太短（< 1s）克隆不稳，太长（> 30s）不收：都不立锚点，等下一段
      if (needAnchor && pcmBytes > sampleRate * 2 && pcmBytes <= ANCHOR_MAX_BYTES) {
        await this.saveAnchor(Buffer.concat(pcmParts), text, sampleRate)
      }
      onChunk({ samples: [], sampleRate, isFinal: true })
    }
  }

  /**
   * 把首段合成结果写成 WAV 存下来，作为后续分段的音色锚点。
   *
   * 写文件而不是留内存：克隆接口只收上传的音频文件。
   * 失败不影响本次出声，只是后面仍会有轻微音色漂移。
   */
  private async saveAnchor(pcm: Buffer, text: string, sampleRate: number): Promise<void> {
    try {
      const dir = path.join(app.getPath('userData'), 'breeze-anchor')
      await fs.promises.mkdir(dir, { recursive: true })
      // 每个实例单独一个文件：预览和通话可能同时在用各自的锚点，共用会互相覆盖
      const file = path.join(dir, `anchor-${process.pid}-${this.anchorId}.wav`)
      await fs.promises.writeFile(file, pcm16ToWav(pcm, sampleRate))
      this.anchor = { audioPath: file, text, instruction: this.cfg.instruction }
      this.ownsAnchorFile = true
      log.info(`[saveAnchor] 已固化音色锚点（${(pcm.length / 1024).toFixed(0)}KB）供后续分段复用`)
    } catch (e) {
      log.warn(`[saveAnchor] 锚点保存失败，后续分段可能有音色漂移: ${(e as Error).message}`)
    }
  }

  destroy(): void {
    // **不杀服务进程**。7.7GB 权重加载要几分钟，而试听结束后 voice-service 会立刻
    // destroy 临时 provider —— 杀进程意味着每一句试听都要重载一次模型。
    // 服务留着复用，应用退出时由 will-quit 钩子结束。
    this.dropAnchor()
    log.info('[destroy] 保留 Breeze 服务进程以便复用')
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

/** 给 s16le PCM 加上 44 字节 WAV 头（克隆接口要的是音频文件，不是裸 PCM） */
export function pcm16ToWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44)
  const byteRate = sampleRate * channels * 2
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // fmt 块长度
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(channels * 2, 32) // 块对齐
  header.writeUInt16LE(16, 34) // 位深
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
