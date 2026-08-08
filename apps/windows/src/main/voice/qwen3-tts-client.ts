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
import { resolveWindowsClientDataRoot } from '../client-data-root.js'
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
 * 解析 sidecar 脚本路径（优先主源码，避免 assets 副本过期仍用 float16）
 */
function resolveSidecarScript(): string {
  const packaged = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'scripts', 'qwen3_tts_sidecar.py')
    : path.join(__dirname, '../../assets/scripts/qwen3_tts_sidecar.py')
  const candidates = [
    // 开发态：优先 src 主文件，防止 assets 副本未同步
    path.join(process.cwd(), 'apps/windows/src/main/voice/qwen3_tts_sidecar.py'),
    path.join(app.getAppPath(), 'src/main/voice/qwen3_tts_sidecar.py'),
    path.join(__dirname, 'qwen3_tts_sidecar.py'),
    packaged,
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      log.info(`[resolveSidecarScript] ${c}`)
      return c
    }
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
  signal?: AbortSignal,
): Promise<void> {
  const envExtra: Record<string, string> = {}
  if (indexUrl) {
    envExtra.PIP_INDEX_URL = indexUrl
  } else {
    envExtra.PIP_INDEX_URL = PYPI_MIRROR
  }
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('已取消'))
      return
    }
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
    const onAbort = () => {
      try {
        p.kill()
      } catch {
        /* ignore */
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
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
    p.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    p.on('exit', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) {
        reject(new Error('已取消'))
        return
      }
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
 * CUDA：仅从本地已下载的 wheel 安装（与模型下载同 UI）；失败时按策略回退 CPU。
 */
async function installTorchStack(
  pythonExe: string,
  wantCuda: boolean,
  allowCpuFallback: boolean,
  wheelDir?: string | null,
): Promise<'cuda' | 'cpu'> {
  if (wantCuda) {
    if (!wheelDir || !fs.existsSync(wheelDir)) {
      const msg =
        '尚未下载 PyTorch CUDA 运行时。请在设置 → 语音合成 → 模型列表下载「PyTorch CUDA 运行时」'
      log.warn(`[installTorch] ${msg}`)
      if (!allowCpuFallback) throw new Error(msg)
      emitStatus('installing_deps', `${msg}；暂用 CPU…`)
    } else {
      emitStatus('installing_deps', '正在从已下载的 wheel 安装 PyTorch CUDA…')
      try {
        await installPytorchCudaFromWheelDir(wheelDir)
        const torchCuda = await probeTorchCudaOnly(pythonExe)
        if (torchCuda) {
          log.info('[installTorch] 本地 CUDA 轮安装成功')
          return 'cuda'
        }
        const msg = '本地 CUDA 轮安装后 torch.cuda 仍不可用'
        log.warn(`[installTorch] ${msg}`)
        if (!allowCpuFallback) throw new Error(msg)
        emitStatus('installing_deps', `${msg}，回退安装 CPU 版…`)
      } catch (e) {
        log.warn(`[installTorch] CUDA 安装失败: ${(e as Error).message}`)
        if (!allowCpuFallback) throw e
        emitStatus('installing_deps', 'CUDA 版安装失败，改为安装 CPU 版 PyTorch…')
      }
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
 * 从本地 wheel 目录安装 PyTorch CUDA（供模型下载完成后 / prepare 复用）
 */
export async function installPytorchCudaFromWheelDir(
  wheelDir: string,
  signal?: AbortSignal,
): Promise<void> {
  const pythonExe = await resolvePythonExe()
  if (pythonExe !== getBundledPythonExe()) {
    throw new Error(`Qwen3 TTS 仅支持内置 Python，当前: ${pythonExe}`)
  }
  const wheels = fs
    .readdirSync(wheelDir)
    .filter((n) => n.endsWith('.whl') && n.includes('torch'))
    .map((n) => path.join(wheelDir, n))
  if (wheels.length < 2) {
    throw new Error(`wheel 目录不完整: ${wheelDir}`)
  }
  if (signal?.aborted) throw new Error('已取消')

  emitStatus('installing_deps', '正在卸载旧版 PyTorch，准备安装 GPU 轮…')
  await pipUninstallTorch(pythonExe)
  if (signal?.aborted) throw new Error('已取消')

  emitStatus('installing_deps', '正在安装本地 PyTorch CUDA wheel（无需再下载）…')
  await pipInstall(
    pythonExe,
    ['--no-cache-dir', '--force-reinstall', '--no-deps', ...wheels],
    '正在安装本地 PyTorch CUDA…',
    undefined,
    signal,
  )
  await pipInstall(
    pythonExe,
    [
      'filelock',
      'typing-extensions',
      'networkx',
      'jinja2',
      'fsspec',
      'sympy',
      'mpmath',
      'MarkupSafe',
    ],
    '正在补齐 PyTorch 依赖…',
    undefined,
    signal,
  )

  const ok = await probeTorchCudaOnly(pythonExe)
  if (!ok) {
    throw new Error('本地 wheel 已安装但 torch.cuda 不可用，请检查 NVIDIA 驱动')
  }
  await resetSharedQwen3TtsClient()
  emitStatus('ready', 'PyTorch CUDA 已安装到内置 Python')
  log.info('[installPytorchCudaFromWheelDir] 完成')
}

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
 * 安装 qwen-tts + faster-qwen3-tts（CUDA Graph 加速）推理依赖
 */
async function installQwenDeps(pythonExe: string): Promise<void> {
  await pipInstall(
    pythonExe,
    [
      'qwen-tts',
      'faster-qwen3-tts>=0.3.2',
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
    '正在安装 qwen-tts / faster-qwen3-tts 及相关依赖…',
  )
}

/**
 * 确保已安装 faster-qwen3-tts（已有 CUDA 运行时时补装）
 */
async function ensureFasterQwen3Tts(pythonExe: string): Promise<boolean> {
  const code =
    'import importlib.util; print("1" if importlib.util.find_spec("faster_qwen3_tts") else "0")'
  const has = await new Promise<boolean>((resolve) => {
    const p = spawn(pythonExe, ['-c', code], {
      windowsHide: true,
      env: buildIsolatedPythonEnv(),
    })
    let out = ''
    p.stdout?.on('data', (b: Buffer) => {
      out += b.toString()
    })
    p.on('error', () => resolve(false))
    p.on('exit', (c) => resolve(c === 0 && out.trim() === '1'))
  })
  if (has) return true
  try {
    await pipInstall(
      pythonExe,
      ['faster-qwen3-tts>=0.3.2', '-i', PYPI_MIRROR],
      '正在安装 faster-qwen3-tts（CUDA Graph 加速）…',
    )
    return true
  } catch (e) {
    log.warn(`[ensureFasterQwen3Tts] 安装失败，将回退官方路径: ${(e as Error).message}`)
    return false
  }
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
  const wheelDir = path.join(
    resolveWindowsClientDataRoot(),
    'models',
    'voice',
    'runtime',
    'pytorch-cu121',
  )
  log.info(`[ensureQwenTtsPackage] pref=${devicePref} wantCuda=${wantCuda} nvidia=${hasNvidiaGpu()} wheelDir=${wheelDir}`)

  const health = await probeTorchHealth(pythonExe)
  const cudaReady = health.ok && health.cuda && !health.detail.includes('+cpu')
  const cpuReady = health.ok && !health.cuda

  if (wantCuda && cudaReady) {
    await ensureFasterQwen3Tts(pythonExe)
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
    const kind = await installTorchStack(pythonExe, true, allowCpuFallback, wheelDir)
    await resetSharedQwen3TtsClient()
    const after = await probeTorchHealth(pythonExe)
    if (!after.ok) throw new Error('更换 CUDA 后依赖校验失败：' + after.detail)
    if (kind === 'cuda' && after.cuda) {
      await ensureFasterQwen3Tts(pythonExe)
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
      ? '正在安装 qwen-tts 依赖（使用已下载的 CUDA wheel）…'
      : '正在安装 qwen-tts 依赖（CPU PyTorch）…',
  )
  const kind = await installTorchStack(pythonExe, wantCuda, allowCpuFallback, wheelDir)
  await installQwenDeps(pythonExe)
  if (kind === 'cuda') {
    await ensureFasterQwen3Tts(pythonExe)
  }
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
    {
      resolve: (v: RpcResult) => void
      reject: (e: Error) => void
      /** 流式 partial 回调（同 id 多段） */
      onPartial?: (result: Record<string, unknown>) => void
    }
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
    // 含精度/后端标记，避免旧进程被误判为已加载
    const key = `${modelDir}||${tokenizerDir}||${device}||faster-v1`
    if (this.loadedKey === key) {
      emitStatus('ready', '语音模型已就绪')
      return
    }
    emitStatus(
      'loading_model',
      '正在加载本地语音模型（含 CUDA Graph 预热，首次较慢）…',
      path.basename(modelDir),
    )
    const res = await this.call('load', { modelDir, tokenizerDir, device, preferFaster: true }, 600_000)
    if (!res.ok) throw new Error(res.error || 'load 失败')
    this.loadedKey = key
    const deviceLabel = String(res.result?.device || device)
    const dtypeLabel = res.result?.dtype ? String(res.result.dtype) : ''
    const backendLabel = res.result?.backend ? String(res.result.backend) : ''
    const backendHint =
      backendLabel === 'faster' ? ' / CUDA Graph' : backendLabel ? ` / ${backendLabel}` : ''
    emitStatus(
      'ready',
      deviceLabel.startsWith('cuda')
        ? `语音模型已加载（GPU ${deviceLabel}${dtypeLabel ? ` / ${dtypeLabel}` : ''}${backendHint}）`
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
    if (!res.ok) {
      const err = res.error || 'synthesize 失败'
      if (/device-side assert|GPU 合成失败|CUDA error/i.test(err)) {
        log.warn('[synthesize] 检测到 CUDA 损坏，重启 sidecar')
        this.loadedKey = null
        try {
          await this.destroy()
        } catch {
          /* ignore */
        }
      }
      throw new Error(err)
    }
    const wavPath = String(res.result?.wavPath || '')
    const sampleRate = Number(res.result?.sampleRate || 24000)
    if (!wavPath || !fs.existsSync(wavPath)) {
      throw new Error('sidecar 未返回有效 wav')
    }
    return { wavPath, sampleRate }
  }

  /**
   * 句级流式合成：每段 PCM 通过 onChunk 回调立即返回，缩短首包延迟
   */
  async synthesizeStream(
    params: {
      text: string
      language: string
      mode?: 'custom' | 'clone'
      speaker?: string
      instruct?: string
      refAudio?: string
      refText?: string
      xVectorOnly?: boolean
    },
    onChunk: (chunk: { samples: number[]; sampleRate: number; text?: string }) => void,
  ): Promise<{ sampleRate: number; chunks: number }> {
    await this.ensureStarted()
    emitStatus('synthesizing', '正在流式合成语音…')

    let sampleRate = 24000
    let chunks = 0

    const res = await this.call(
      'synthesize_stream',
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
      (partial) => {
        const b64 = String(partial.pcmInt16Base64 || '')
        const sr = Number(partial.sampleRate || 24000)
        sampleRate = sr
        if (!b64) return
        const buf = Buffer.from(b64, 'base64')
        const samples: number[] = []
        for (let i = 0; i + 1 < buf.length; i += 2) {
          samples.push(buf.readInt16LE(i) / 32768)
        }
        chunks += 1
        if (chunks === 1) {
          emitStatus('playing', '首段已合成，边播边继续…')
        }
        onChunk({
          samples,
          sampleRate: sr,
          text: typeof partial.text === 'string' ? partial.text : undefined,
        })
      },
    )

    if (!res.ok) {
      const err = res.error || 'synthesize_stream 失败'
      if (/device-side assert|GPU 合成失败|CUDA error/i.test(err)) {
        log.warn('[synthesizeStream] 检测到 CUDA 损坏，重启 sidecar')
        this.loadedKey = null
        try {
          await this.destroy()
        } catch {
          /* ignore */
        }
      }
      throw new Error(err)
    }

    const doneChunks = Number(res.result?.chunks ?? chunks)
    return { sampleRate: Number(res.result?.sampleRate || sampleRate), chunks: doneChunks }
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
   * 发送 RPC（可选 onPartial 支持同 id 多段流式响应）
   */
  private call(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 120_000,
    onPartial?: (result: Record<string, unknown>) => void,
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
        onPartial,
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
        const msg = JSON.parse(trimmed) as {
          id?: number
          ok?: boolean
          partial?: boolean
          result?: Record<string, unknown>
          error?: string
        }
        const id = msg.id
        if (typeof id !== 'number') continue
        const pending = this.pending.get(id)
        if (!pending) continue

        // 流式中间段：不 resolve，继续等 final
        if (msg.partial === true && msg.ok) {
          if (msg.result) pending.onPartial?.(msg.result)
          continue
        }

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
