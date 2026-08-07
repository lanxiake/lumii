/**
 * Qwen3-TTS Python sidecar 客户端（stdio JSON-RPC）
 */
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  PYPI_MIRROR,
  ensureBundledPython,
  getBundledPythonExe,
} from '../python-env.js'
import type { VoiceRuntimePhase } from '../../shared/voice-events.js'

const log = {
  info: (...a: unknown[]) => console.log('[Qwen3TtsClient]', ...a),
  warn: (...a: unknown[]) => console.warn('[Qwen3TtsClient]', ...a),
  error: (...a: unknown[]) => console.error('[Qwen3TtsClient]', ...a),
}

type RpcResult = { ok: boolean; result?: Record<string, unknown>; error?: string }

/** 运行时状态回调（安装依赖 / 加载模型等） */
export type Qwen3TtsStatusCallback = (
  phase: VoiceRuntimePhase,
  message: string,
  detail?: string,
) => void

let statusCallback: Qwen3TtsStatusCallback | null = null

/**
 * 注册 Qwen3 TTS 运行时状态监听（由 VoiceService 桥接到 UI）
 */
export function setQwen3TtsStatusCallback(cb: Qwen3TtsStatusCallback | null): void {
  statusCallback = cb
}

/**
 * 向 UI/日志推送运行时状态
 */
function emitStatus(phase: VoiceRuntimePhase, message: string, detail?: string): void {
  log.info(`[status] ${phase}: ${message}${detail ? ` (${detail})` : ''}`)
  try {
    statusCallback?.(phase, message, detail)
  } catch (e) {
    log.warn(`status 回调失败: ${(e as Error).message}`)
  }
}

/**
 * 解析 sidecar 脚本路径
 */
function resolveSidecarScript(): string {
  const packaged = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'scripts', 'qwen3_tts_sidecar.py')
    : path.join(__dirname, '../../assets/scripts/qwen3_tts_sidecar.py')
  const candidates = [
    packaged,
    path.join(__dirname, 'qwen3_tts_sidecar.py'),
    path.join(app.getAppPath(), 'src/main/voice/qwen3_tts_sidecar.py'),
    path.join(process.cwd(), 'apps/windows/src/main/voice/qwen3_tts_sidecar.py'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  throw new Error('找不到 qwen3_tts_sidecar.py')
}

/**
 * Qwen3 TTS 固定使用 ~/.lumii 内置 Python，避免系统 conda 里 torch/torchaudio 版本错乱（WinError 127）。
 */
async function resolvePythonExe(): Promise<string> {
  emitStatus('checking_python', '正在准备隔离的语音合成 Python（不使用系统 conda）…')
  const exe = await ensureBundledPython((msg) => {
    emitStatus('checking_python', msg || '正在准备内置 Python…')
  })
  log.info(`[resolvePythonExe] 使用内置运行时: ${exe}`)
  return exe
}

/**
 * 内置 Python 子进程环境：清掉 conda/PYTHONPATH，避免加载到系统站点包
 */
function buildIsolatedPythonEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  delete env.PYTHONPATH
  delete env.PYTHONHOME
  // 防止 activate 过的 conda 抢 DLL
  delete env.CONDA_PREFIX
  delete env.CONDA_DEFAULT_ENV
  delete env.CONDA_PYTHON_EXE
  env.PYTHONNOUSERSITE = '1'
  env.PYTHONIOENCODING = 'utf-8'
  return env
}

/**
 * 探测 qwen-tts + torch/torchaudio 是否可真实 import（比只看 site-packages 目录更可靠）
 */
type TorchHealth = {
  ok: boolean
  cuda: boolean
  detail: string
}

/**
 * 探测本机是否有可用 NVIDIA GPU（驱动级，不依赖 Python）
 */
function hasNvidiaGpu(): boolean {
  try {
    execFileSync('nvidia-smi', ['-L'], {
      windowsHide: true,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

/**
 * 探测 qwen-tts + torch/torchaudio 是否可 import，以及 torch 是否启用 CUDA
 */
async function probeTorchHealth(pythonExe: string): Promise<TorchHealth> {
  const code = [
    'import torch,torchaudio,qwen_tts,soundfile,numpy',
    'print(torch.__version__+"|"+torchaudio.__version__+"|cuda="+str(torch.cuda.is_available())+"|dev="+ (torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu"))',
  ].join(';')
  return new Promise((resolve) => {
    const p = spawn(pythonExe, ['-c', code], {
      windowsHide: true,
      env: buildIsolatedPythonEnv(),
    })
    let out = ''
    let err = ''
    p.stdout?.on('data', (b: Buffer) => {
      out += b.toString()
    })
    p.stderr?.on('data', (b: Buffer) => {
      err += b.toString()
    })
    p.on('error', () => resolve({ ok: false, cuda: false, detail: 'spawn failed' }))
    p.on('exit', (code) => {
      const detail = (out || err).trim().slice(-400)
      if (code === 0) {
        const cuda = /\|cuda=True\|/i.test(out)
        log.info(`[health] import 正常: ${detail}`)
        resolve({ ok: true, cuda, detail })
      } else {
        log.warn(`[health] import 失败: ${detail}`)
        resolve({ ok: false, cuda: false, detail })
      }
    })
  })
}

/**
 * 在内置 Python 中执行 pip install
 * @param indexUrl 若传入则作为唯一 index（避免 PIP_INDEX_URL 镜像把 CUDA 轮解析成 CPU）
 */
async function pipInstall(
  pythonExe: string,
  args: string[],
  label: string,
  indexUrl?: string,
): Promise<void> {
  const envExtra: Record<string, string> = {}
  if (indexUrl) {
    envExtra.PIP_INDEX_URL = indexUrl
  } else {
    envExtra.PIP_INDEX_URL = PYPI_MIRROR
  }
  await new Promise<void>((resolve, reject) => {
    const env = buildIsolatedPythonEnv(envExtra)
    // 强制单一 index：清空镜像/额外源，否则 cu121 会和 ustc 混用导致仍命中 +cpu
    if (indexUrl) {
      delete env.PIP_EXTRA_INDEX_URL
      delete env.PIP_TRUSTED_HOST
    }
    const p = spawn(pythonExe, ['-m', 'pip', 'install', ...args], {
      windowsHide: true,
      env,
    })
    let err = ''
    let out = ''
    const onChunk = (b: Buffer, isErr: boolean) => {
      const t = b.toString()
      if (isErr) err += t
      else out += t
      const line = t.trim().split(/\r?\n/).filter(Boolean).pop()
      if (line) {
        emitStatus('installing_deps', label, line.slice(0, 160))
      }
    }
    p.stdout?.on('data', (b: Buffer) => onChunk(b, false))
    p.stderr?.on('data', (b: Buffer) => onChunk(b, true))
    p.on('error', reject)
    p.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${label} 失败 (code=${code}): ${(err || out).slice(-600)}`))
    })
  })
}

/**
 * 卸载旧 torch 栈，避免 “Requirement already satisfied” 卡住 CPU 轮
 */
async function pipUninstallTorch(pythonExe: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const p = spawn(
      pythonExe,
      ['-m', 'pip', 'uninstall', '-y', 'torch', 'torchaudio', 'torchvision'],
      { windowsHide: true, env: buildIsolatedPythonEnv() },
    )
    p.on('error', () => resolve())
    p.on('exit', () => resolve())
  })
}

export type Qwen3DevicePref = 'auto' | 'cpu' | 'cuda'

/**
 * 根据用户偏好决定是否要装/用 CUDA
 */
function resolveWantCuda(pref: Qwen3DevicePref): boolean {
  if (pref === 'cpu') return false
  if (pref === 'cuda') return true
  return hasNvidiaGpu()
}

/**
 * 安装配对的 torch + torchaudio。
 * 关键 CUDA：先卸载再强制装 cu121；失败时仅在允许回退时改装 CPU。
 */
async function installTorchStack(
  pythonExe: string,
  wantCuda: boolean,
  allowCpuFallback: boolean,
): Promise<'cuda' | 'cpu'> {
  if (wantCuda) {
    emitStatus(
      'installing_deps',
      '正在安装 PyTorch CUDA 12.1（约 2GB+，会先卸载旧的 CPU 版，请勿关闭应用）…',
    )
    try {
      await pipUninstallTorch(pythonExe)
      await pipInstall(
        pythonExe,
        [
          '--no-cache-dir',
          '--force-reinstall',
          'torch==2.5.1',
          'torchaudio==2.5.1',
          '--index-url',
          'https://download.pytorch.org/whl/cu121',
        ],
        '正在安装 PyTorch CUDA 12.1…',
        'https://download.pytorch.org/whl/cu121',
      )
      const torchCuda = await probeTorchCudaOnly(pythonExe)
      if (torchCuda) {
        log.info('[installTorch] CUDA 轮安装成功')
        return 'cuda'
      }
      const msg = 'CUDA 轮安装后 torch.cuda 仍不可用（可能驱动/ wheel 不匹配）'
      log.warn(`[installTorch] ${msg}`)
      if (!allowCpuFallback) throw new Error(msg)
      emitStatus('installing_deps', `${msg}，回退安装 CPU 版…`)
    } catch (e) {
      log.warn(`[installTorch] CUDA 安装失败: ${(e as Error).message}`)
      if (!allowCpuFallback) throw e
      emitStatus('installing_deps', 'CUDA 版安装失败，改为安装 CPU 版 PyTorch…')
    }
  }

  emitStatus('installing_deps', '正在安装 PyTorch CPU…')
  await pipUninstallTorch(pythonExe)
  await pipInstall(
    pythonExe,
    [
      '--no-cache-dir',
      '--force-reinstall',
      'torch==2.5.1',
      'torchaudio==2.5.1',
      '--index-url',
      'https://download.pytorch.org/whl/cpu',
    ],
    '正在安装 PyTorch CPU…',
    'https://download.pytorch.org/whl/cpu',
  )
  return 'cpu'
}

/**
 * 仅检查 torch.cuda（升级 GPU 轮时 qwen_tts 可能已在）
 */
async function probeTorchCudaOnly(pythonExe: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(
      pythonExe,
      [
        '-c',
        'import torch; print(("1" if torch.cuda.is_available() else "0")+"|"+torch.__version__)',
      ],
      { windowsHide: true, env: buildIsolatedPythonEnv() },
    )
    let out = ''
    p.stdout?.on('data', (b: Buffer) => {
      out += b.toString()
    })
    p.on('error', () => resolve(false))
    p.on('exit', (code) => {
      const line = out.trim()
      log.info(`[probeCuda] ${line || '(empty)'}`)
      resolve(code === 0 && line.startsWith('1') && !line.includes('+cpu'))
    })
  })
}

/**
 * 安装 qwen-tts 推理依赖（不含 gradio）
 */
async function installQwenDeps(pythonExe: string): Promise<void> {
  await pipInstall(
    pythonExe,
    [
      'qwen-tts',
      'transformers==4.57.3',
      'accelerate==1.12.0',
      'soundfile',
      'numpy',
      'librosa',
      'onnxruntime',
      'einops',
      '-i',
      PYPI_MIRROR,
    ],
    '正在安装 qwen-tts 及相关依赖…',
  )
}

/**
 * 确保内置 Python 中 qwen-tts 已安装，并按用户设备偏好对齐 CPU/CUDA 轮
 */
async function ensureQwenTtsPackage(
  pythonExe: string,
  devicePref: Qwen3DevicePref = 'auto',
): Promise<void> {
  if (pythonExe !== getBundledPythonExe()) {
    throw new Error(`Qwen3 TTS 仅支持内置 Python，当前: ${pythonExe}`)
  }

  if (devicePref === 'cuda' && !hasNvidiaGpu()) {
    throw new Error('已选择 GPU，但未检测到 NVIDIA 显卡/驱动（nvidia-smi 不可用）')
  }

  const wantCuda = resolveWantCuda(devicePref)
  const allowCpuFallback = devicePref !== 'cuda'
  log.info(`[ensureQwenTtsPackage] pref=${devicePref} wantCuda=${wantCuda} nvidia=${hasNvidiaGpu()}`)

  const health = await probeTorchHealth(pythonExe)
  const cudaReady = health.ok && health.cuda && !health.detail.includes('+cpu')
  const cpuReady = health.ok && !health.cuda

  if (wantCuda && cudaReady) {
    emitStatus(
      'ready',
      `语音合成运行时已就绪（GPU：${health.detail.split('|dev=').pop() || 'CUDA'}）`,
    )
    return
  }
  if (!wantCuda && cpuReady) {
    emitStatus('ready', '语音合成运行时已就绪（CPU）')
    return
  }
  // 用户要 CPU，但当前是 CUDA 轮：可直接用（CUDA 轮也能跑 CPU），不必重装
  if (!wantCuda && cudaReady) {
    emitStatus('ready', '语音合成运行时已就绪（已装 CUDA 轮，将按设置使用 CPU 推理）')
    return
  }

  if (wantCuda && cpuReady) {
    emitStatus('installing_deps', '检测到 CPU 版 PyTorch，正在强制更换为 CUDA 版…')
    const kind = await installTorchStack(pythonExe, true, allowCpuFallback)
    await resetSharedQwen3TtsClient()
    const after = await probeTorchHealth(pythonExe)
    if (!after.ok) throw new Error('更换 CUDA 后依赖校验失败：' + after.detail)
    if (kind === 'cuda' && after.cuda) {
      emitStatus('ready', `已切换为 GPU 加速（${after.detail.split('|dev=').pop() || 'CUDA'}）`)
      return
    }
    if (!allowCpuFallback) {
      throw new Error('无法启用 GPU：CUDA 版 PyTorch 安装后仍不可用')
    }
    emitStatus('ready', '仍在使用 CPU（CUDA 不可用）')
    return
  }

  // 全新安装
  emitStatus(
    'installing_deps',
    wantCuda
      ? '正在安装 qwen-tts 依赖（含 CUDA PyTorch，首次约 2GB+）…'
      : '正在安装 qwen-tts 依赖（CPU PyTorch）…',
  )
  const kind = await installTorchStack(pythonExe, wantCuda, allowCpuFallback)
  await installQwenDeps(pythonExe)
  const after = await probeTorchHealth(pythonExe)
  if (!after.ok) {
    throw new Error(
      '依赖已安装但仍无法加载。请删除目录后重试：' +
        path.dirname(pythonExe) +
        ' | ' +
        after.detail,
    )
  }
  if (wantCuda && !after.cuda && !allowCpuFallback) {
    throw new Error('已选择 GPU，但安装后 torch.cuda 仍不可用')
  }
  emitStatus(
    'installing_deps',
    kind === 'cuda' && after.cuda
      ? `依赖安装完成（GPU：${after.detail.split('|dev=').pop() || 'CUDA'}）`
      : '依赖安装完成（CPU）',
  )
}

/** 预装进行中的 Promise（并发调用复用同一次安装） */
let prepareRuntimePromise: Promise<void> | null = null
let preparedForDevice: Qwen3DevicePref | null = null
/** 最近一次请求的设备偏好（ensureStarted 无参时复用） */
let lastDevicePref: Qwen3DevicePref = 'auto'

/**
 * 使预装缓存失效（切换 CPU/GPU 偏好后调用）
 */
export function invalidateQwen3TtsPrepare(): void {
  prepareRuntimePromise = null
  preparedForDevice = null
}

/**
 * 提前准备 Qwen3 TTS 运行时（Python + qwen-tts），可在模型下载完成后后台调用。
 */
export function prepareQwen3TtsRuntime(devicePref: Qwen3DevicePref = 'auto'): Promise<void> {
  lastDevicePref = devicePref
  if (prepareRuntimePromise && preparedForDevice === devicePref) {
    return prepareRuntimePromise
  }
  const previous = prepareRuntimePromise
  prepareRuntimePromise = (async () => {
    if (previous) {
      await previous.catch(() => undefined)
    }
    preparedForDevice = devicePref
    emitStatus('checking_python', `正在预装语音合成运行时（设备：${devicePref}）…`)
    const pythonExe = await resolvePythonExe()
    await ensureQwenTtsPackage(pythonExe, devicePref)
    emitStatus('ready', '语音合成运行时检查完成')
  })().catch((e) => {
    prepareRuntimePromise = null
    preparedForDevice = null
    emitStatus('error', `语音合成运行时准备失败：${(e as Error).message}`)
    throw e
  })
  return prepareRuntimePromise
}

/**
 * 当前是否已有成功的预装结果（内存态；进程重启后需再检查）
 */
export function isQwen3TtsRuntimePrepareInFlight(): boolean {
  return prepareRuntimePromise !== null
}

/**
 * 将用户偏好解析为 sidecar load 的 device 参数
 */
export function resolveQwen3LoadDevice(pref: Qwen3DevicePref = 'auto'): 'auto' | 'cpu' | 'cuda:0' {
  if (pref === 'cpu') return 'cpu'
  if (pref === 'cuda') return 'cuda:0'
  return 'auto'
}

/**
 * 管理长驻 sidecar 进程与 RPC 调用
 */
export class Qwen3TtsClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (v: RpcResult) => void; reject: (e: Error) => void }
  >()
  private stdoutBuf = ''
  private loadedKey: string | null = null

  /**
   * 启动 sidecar（若尚未运行）
   */
  async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed) return

    emitStatus('starting_engine', '正在启动语音合成引擎…')
    // 复用预装 Promise：模型下载后若已后台装好，此处几乎立即返回
    await prepareQwen3TtsRuntime(lastDevicePref)
    const pythonExe = await resolvePythonExe()
    const script = resolveSidecarScript()
    const args = ['-u', script]

    this.child = spawn(pythonExe, args, {
      windowsHide: true,
      env: buildIsolatedPythonEnv({
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
      }),
    }) as ChildProcessWithoutNullStreams

    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    this.child.stderr.on('data', (chunk: string) => {
      const t = chunk.trim()
      if (t) log.warn('[sidecar]', t.slice(-500))
    })
    this.child.on('exit', (code) => {
      log.warn(`sidecar 退出 code=${code}`)
      for (const [, p] of this.pending) {
        p.reject(new Error(`sidecar 已退出 (code=${code})`))
      }
      this.pending.clear()
      this.child = null
      this.loadedKey = null
    })

    const ping = await this.call('ping', {})
    if (!ping.ok) throw new Error(ping.error || 'sidecar ping 失败')
    emitStatus('starting_engine', '语音合成引擎已启动')
    log.info('sidecar 已启动', ping.result)
  }

  /**
   * 加载指定本地模型（同路径则跳过）
   */
  async load(modelDir: string, tokenizerDir: string, device = 'auto'): Promise<void> {
    await this.ensureStarted()
    const key = `${modelDir}||${tokenizerDir}||${device}`
    if (this.loadedKey === key) {
      emitStatus('ready', '语音模型已就绪')
      return
    }
    emitStatus('loading_model', '正在加载本地语音模型到内存（首次较慢，请稍候）…', path.basename(modelDir))
    const res = await this.call('load', { modelDir, tokenizerDir, device }, 600_000)
    if (!res.ok) throw new Error(res.error || 'load 失败')
    this.loadedKey = key
    const deviceLabel = String(res.result?.device || device)
    emitStatus(
      'ready',
      deviceLabel.startsWith('cuda')
        ? `语音模型已加载（GPU ${deviceLabel}）`
        : `语音模型已加载（CPU，合成较慢）`,
    )
    log.info('模型已加载', res.result)
  }

  /**
   * 合成并返回临时 wav 路径（custom 内置音色 或 clone 克隆）
   */
  async synthesize(params: {
    text: string
    language: string
    mode?: 'custom' | 'clone'
    speaker?: string
    instruct?: string
    refAudio?: string
    refText?: string
    xVectorOnly?: boolean
  }): Promise<{ wavPath: string; sampleRate: number }> {
    await this.ensureStarted()
    emitStatus('synthesizing', '正在合成语音…')
    const res = await this.call(
      'synthesize',
      {
        mode: params.mode ?? 'clone',
        text: params.text,
        language: params.language,
        speaker: params.speaker,
        instruct: params.instruct,
        refAudio: params.refAudio,
        refText: params.refText,
        xVectorOnly: params.xVectorOnly,
      },
      600_000,
    )
    if (!res.ok) throw new Error(res.error || 'synthesize 失败')
    const wavPath = String(res.result?.wavPath || '')
    const sampleRate = Number(res.result?.sampleRate || 24000)
    if (!wavPath || !fs.existsSync(wavPath)) {
      throw new Error('sidecar 未返回有效 wav')
    }
    return { wavPath, sampleRate }
  }

  /**
   * 销毁 sidecar
   */
  async destroy(): Promise<void> {
    if (!this.child) return
    try {
      await this.call('shutdown', {}, 10_000)
    } catch {
      /* ignore */
    }
    try {
      this.child.kill()
    } catch {
      /* ignore */
    }
    this.child = null
    this.loadedKey = null
  }

  /**
   * 发送 RPC
   */
  private call(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 120_000,
  ): Promise<RpcResult> {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.child.stdin.writable) {
        reject(new Error('sidecar 未运行'))
        return
      }
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`sidecar RPC 超时: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  /**
   * 解析 stdout JSON 行
   */
  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    const lines = this.stdoutBuf.split('\n')
    this.stdoutBuf = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const msg = JSON.parse(trimmed) as { id?: number; ok?: boolean; result?: Record<string, unknown>; error?: string }
        const id = msg.id
        if (typeof id !== 'number') continue
        const pending = this.pending.get(id)
        if (!pending) continue
        this.pending.delete(id)
        pending.resolve({ ok: Boolean(msg.ok), result: msg.result, error: msg.error })
      } catch {
        log.info('[sidecar stdout]', trimmed.slice(0, 200))
      }
    }
  }
}

/** 进程内单例，避免重复加载大模型 */
let sharedClient: Qwen3TtsClient | null = null

/**
 * 获取共享 Qwen3 sidecar 客户端
 */
export function getSharedQwen3TtsClient(): Qwen3TtsClient {
  if (!sharedClient) sharedClient = new Qwen3TtsClient()
  return sharedClient
}

/**
 * 销毁共享 sidecar（升级 CUDA / 重装依赖后需重启进程）
 */
export async function resetSharedQwen3TtsClient(): Promise<void> {
  if (!sharedClient) return
  try {
    await sharedClient.destroy()
  } catch {
    /* ignore */
  }
  sharedClient = null
}
