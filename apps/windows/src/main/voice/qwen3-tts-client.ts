/**
 * Qwen3-TTS Python sidecar 客户端（stdio JSON-RPC）
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  PYPI_MIRROR,
  detectSystemPython,
  ensureBundledPython,
  getBundledPythonExe,
  hasPackage,
} from '../python-env.js'

const log = {
  info: (...a: unknown[]) => console.log('[Qwen3TtsClient]', ...a),
  warn: (...a: unknown[]) => console.warn('[Qwen3TtsClient]', ...a),
  error: (...a: unknown[]) => console.error('[Qwen3TtsClient]', ...a),
}

type RpcResult = { ok: boolean; result?: Record<string, unknown>; error?: string }

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
 * 解析 Python 可执行文件
 */
async function resolvePythonExe(): Promise<string> {
  const sys = detectSystemPython()
  if (sys === 'py') return 'py'
  if (sys) return sys
  return ensureBundledPython((msg) => log.info(msg))
}

/**
 * 确保 qwen-tts 及相关依赖已安装
 */
async function ensureQwenTtsPackage(pythonExe: string): Promise<void> {
  if (pythonExe === getBundledPythonExe() && hasPackage('qwen_tts')) {
    return
  }

  const checkArgs =
    pythonExe === 'py'
      ? ['-3', '-c', 'import qwen_tts, soundfile, numpy']
      : ['-c', 'import qwen_tts, soundfile, numpy']

  const ok = await new Promise<boolean>((resolve) => {
    const p = spawn(pythonExe, checkArgs, { windowsHide: true, stdio: 'ignore' })
    p.on('error', () => resolve(false))
    p.on('exit', (code) => resolve(code === 0))
  })
  if (ok) return

  log.info('正在安装 qwen-tts（体积较大，请耐心等待）...')
  const pkgs = ['qwen-tts', 'soundfile', 'numpy']
  const installArgs =
    pythonExe === 'py'
      ? ['-3', '-m', 'pip', 'install', '-q', ...pkgs, '-i', PYPI_MIRROR]
      : ['-m', 'pip', 'install', '-q', ...pkgs, '-i', PYPI_MIRROR]

  await new Promise<void>((resolve, reject) => {
    const p = spawn(pythonExe, installArgs, {
      windowsHide: true,
      env: { ...process.env, PIP_INDEX_URL: PYPI_MIRROR },
    })
    let err = ''
    p.stderr?.on('data', (b: Buffer) => {
      err += b.toString()
    })
    p.on('error', reject)
    p.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`pip install qwen-tts 失败 (code=${code}): ${err.slice(-600)}`))
    })
  })
  log.info('qwen-tts 安装完成')
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

    const pythonExe = await resolvePythonExe()
    await ensureQwenTtsPackage(pythonExe)
    const script = resolveSidecarScript()
    const args = pythonExe === 'py' ? ['-3', '-u', script] : ['-u', script]

    this.child = spawn(pythonExe, args, {
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
      },
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
    log.info('sidecar 已启动', ping.result)
  }

  /**
   * 加载指定本地模型（同路径则跳过）
   */
  async load(modelDir: string, tokenizerDir: string, device = 'auto'): Promise<void> {
    await this.ensureStarted()
    const key = `${modelDir}||${tokenizerDir}||${device}`
    if (this.loadedKey === key) return
    const res = await this.call('load', { modelDir, tokenizerDir, device }, 600_000)
    if (!res.ok) throw new Error(res.error || 'load 失败')
    this.loadedKey = key
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
