/**
 * 本机微信 Python 侧车客户端（JSONL over stdin/stdout）。
 *
 * **为什么有这一层**：本机微信的能力（读库解密 / 密钥扫描 / GUI 自动化发送）只有
 * Python 实现，绕不开解释器。但 Agent 这一侧不需要 MCP——工具是原生注册进
 * ToolRegistry 的（`bridge.installWechatTools()`），协议层只负责送「调用+参数」
 * 回来、把「内容块」送出去。少一层 MCP 就少一处能漂移的形态。
 *
 * **与 `voice/qwen3-tts-client.ts` 的关系**：进程管理（spawn / 分帧 / 四处 error 监听 /
 * resetChild）是同一套骨架，照抄而不是抽公共基类——两边的协议与语义差得远
 * （那边是 load/synthesize 的流式 partial，这边是 initialize/call 的内容块），
 * 抽出来只会得到一个两边都要打洞的抽象。
 *
 * 协议定义见 `assets/wechat/sidecar.py` 文件头。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { ensureBundledPython, getBundledPythonExe } from '../python-env.js'
import { ensurePythonVenv, getPythonVenvExe } from '../python-venv.js'
import { ensureManagedPythonPackages, type PythonPackageRequirement } from '../mcp-python.js'

const log = {
  info: (...a: unknown[]) => console.log('[WechatSidecar]', ...a),
  warn: (...a: unknown[]) => console.warn('[WechatSidecar]', ...a),
}

/** 侧车 `initialize` 交出的工具描述（`inputSchema` 是 JSON Schema 原文） */
export interface WechatSidecarTool {
  name: string
  description: string
  inputSchema: unknown
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

/** pi-agent-core 的 content 块形状，TS 侧原样透传 */
export type WechatContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface WechatCallResult {
  /** 业务上是否成功（`ok:false` 时 `content` 里是 ERROR 文本） */
  ok: boolean
  /** 是否要在工具结果顶层置 `isError`（ToolRunner 唯一认的失败信号） */
  isError: boolean
  content: WechatContentBlock[]
}

export interface WechatCallOptions {
  timeoutMs?: number
  signal?: AbortSignal
  /** 侧车上报的阶段进度（只有发送类工具会报）；接到工具的 `onUpdate` */
  onProgress?: (p: { message: string; progress: number; total?: number }) => void
}

interface InitFrame {
  tools: WechatSidecarTool[]
  instructions: string
  version: string
}

/** 侧车一帧应答的原始形状（`data` 只有 initialize 有，`content` 只有 call 有） */
interface RpcFrame<T> {
  ok: boolean
  data?: T
  content?: WechatContentBlock[]
  error?: string
}

interface Pending {
  resolve: (v: RpcFrame<unknown>) => void
  reject: (e: Error) => void
  onProgress?: WechatCallOptions['onProgress']
  timer: NodeJS.Timeout
  detach?: () => void
}

/**
 * 默认超时。发送路径实测可到 36s（切会话 + 输入 + 等落库），读历史撞上大库更久；
 * 工具调用期间有进度帧刷新，所以给得宽一点。真正卡死时子进程退出会立刻 reject 全部
 * 挂起调用，不必靠这个超时兜底。
 */
const DEFAULT_TIMEOUT_MS = 300_000

/** 解析侧车脚本（开发态优先仓库里的源码，避免旧副本） */
function resolveSidecarScript(): string {
  const candidates = [
    path.join(app.getAppPath(), 'assets/wechat/sidecar.py'),
    path.join(__dirname, '../../assets/wechat/sidecar.py'),
    path.join(process.resourcesPath, 'assets/wechat/sidecar.py'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  throw new Error(`找不到微信侧车脚本（试过：${candidates.join(' / ')}）`)
}

/** 应用管理的隔离 Python，不碰系统 conda */
async function resolvePythonExe(): Promise<string> {
  if (process.platform !== 'win32') return ensurePythonVenv()
  return ensureBundledPython()
}

/**
 * 侧车跑起来所需的第三方依赖（`assets/wechat` 那套的 import 需求）。
 *
 * **必须显式声明**：侧车在隔离环境里跑（下面 `PYTHONNOUSERSITE=1`），装到用户
 * site-packages 里的包一律看不见。实测过这条坑——用户全局装过 `pycryptodome`，
 * 于是直连 `python sidecar.py` 一切正常，而从 App 起来就报「缺少依赖 pycryptodome」。
 *
 * `openpyxl` 是 `tag_plan` / `tag_start` 收 `.xlsx` 时才 import 的（`wechat_tags.read_excel`），
 * 属于**用到才炸**的那类——不预先装，用户在设置页挑个 Excel 就会收到裸
 * `ModuleNotFoundError`。CSV 不走它，但也一并装齐，别让"支持的格式"取决于机器上恰好装过什么。
 *
 * 不含 `pilk` / `sherpa-onnx`：它们只被语音转写用，而那个工具已在侧车里摘掉
 * （依赖没随包发，见 `sidecar.py` 的 `_UNAVAILABLE_TOOLS`）。
 */
const SIDECAR_PACKAGES: readonly PythonPackageRequirement[] = [
  { spec: 'pycryptodome>=3.20', module: 'Crypto' },
  { spec: 'zstandard>=0.22', module: 'zstandard' },
  { spec: 'openpyxl>=3.1', module: 'openpyxl' },
]

function isAppManagedPython(exe: string): boolean {
  return process.platform === 'win32' ? exe === getBundledPythonExe() : exe === getPythonVenvExe()
}

/**
 * 内置 Python 子进程环境：清掉 conda/PYTHONPATH，避免加载到系统站点包。
 * 与 voice 侧车同一口径——两处不一致时会出现「语音能跑、微信 import 不到 Crypto」。
 */
function buildIsolatedPythonEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.PYTHONPATH
  delete env.PYTHONHOME
  delete env.CONDA_PREFIX
  delete env.CONDA_DEFAULT_ENV
  delete env.CONDA_PYTHON_EXE
  env.PYTHONNOUSERSITE = '1'
  env.PYTHONIOENCODING = 'utf-8'
  return env
}

/**
 * 启动所需的外部动作，**只为测试可注入**（生产一律走默认实现）。
 *
 * 为什么开这个口：协议层最容易错的地方（超时、abort、子进程中途退出、`ok:false` 的
 * 抛出语义）全在异常路径上，而真机只跑得到 happy path。不注入就只能靠起一个真 Python，
 * 那在 CI/无托管运行时的机器上跑不了。
 */
export interface WechatSidecarHooks {
  /** 起子进程（默认 `node:child_process.spawn`） */
  spawn?: typeof spawn
  /** 解析解释器绝对路径（默认为应用托管的 Python） */
  resolvePythonExe?: () => Promise<string>
  /** 补齐 Python 依赖（默认走 `ensureManagedPythonPackages`） */
  ensurePackages?: (
    exe: string,
    pkgs: readonly PythonPackageRequirement[],
  ) => Promise<string | undefined>
  /** 解析侧车脚本路径（默认按 `app.getAppPath()` 等三处候选找） */
  resolveScript?: () => string
}

export class WechatSidecarClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private starting: Promise<void> | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private stdoutBuf = ''
  private initFrame: InitFrame | null = null

  constructor(private readonly hooks: WechatSidecarHooks = {}) {}

  /** 启动（幂等）。并发调用共享同一次启动。 */
  async ensureStarted(): Promise<InitFrame> {
    if (this.initFrame && this.child && !this.child.killed) return this.initFrame
    if (this.starting) {
      await this.starting
      if (this.initFrame) return this.initFrame
      throw new Error('微信侧车启动失败')
    }
    this.starting = this.start().finally(() => {
      this.starting = null
    })
    await this.starting
    if (!this.initFrame) throw new Error('微信侧车没有返回工具清单')
    return this.initFrame
  }

  private async start(): Promise<void> {
    const pythonExe = await (this.hooks.resolvePythonExe ?? resolvePythonExe)()
    const script = (this.hooks.resolveScript ?? resolveSidecarScript)()
    log.info(`启动侧车：${pythonExe} ${script}`)

    // 依赖先补齐再 spawn：缺 pycryptodome 时进程能起来，但第一个读库的工具就会炸，
    // 那时错误已经跑到 Agent 那边去了（「工具报错」比「启动失败」难查得多）。
    const warn = await (this.hooks.ensurePackages ?? ensureManagedPythonPackages)(
      pythonExe,
      [...SIDECAR_PACKAGES],
    )
    if (warn) log.warn(warn)

    const spawnChild = this.hooks.spawn ?? spawn
    const child = spawnChild(pythonExe, ['-u', script], {
      windowsHide: true,
      env: buildIsolatedPythonEnv(),
    }) as ChildProcessWithoutNullStreams
    this.child = child
    this.attachChildHandlers(child)

    const res = await this.rpc<InitFrame>('initialize', {}, DEFAULT_TIMEOUT_MS)
    if (!res.ok || !res.data) throw new Error(res.error || '微信侧车 initialize 失败')
    this.initFrame = res.data
    // 依赖是否齐只有真跑起来才知道：缺 pycryptodome 时 initialize 会直接炸，
    // 这里的 info 是「能力真的在位」的证据，不是启动日志的复读。
    log.info(
      `侧车就绪 v${res.data.version}，${res.data.tools.length} 个工具${isAppManagedPython(pythonExe) ? '（应用托管 Python）' : ''}`,
    )
  }

  /** 工具清单（未启动则先启动） */
  async listTools(): Promise<WechatSidecarTool[]> {
    return (await this.ensureStarted()).tools
  }

  /**
   * 调一个工具。
   *
   * **失败语义**：侧车的 `isError` 原样透传到结果顶层——那是「工具内部真的炸了」；
   * 业务性失败（`env_not_ready` / `target_not_found`）在侧车侧是 `ok:false`，
   * 由调用方按载荷决定（与 MCP 时代的约定一致，见 `MtBotToolResult` 契约）。
   */
  async call(
    tool: string,
    args: Record<string, unknown>,
    opts: WechatCallOptions = {},
  ): Promise<WechatCallResult> {
    await this.ensureStarted()
    const res = await this.rpc<unknown>('call', { tool, args }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts)
    if (!res.ok) {
      return {
        ok: false,
        isError: true,
        content: res.content ?? [{ type: 'text', text: res.error ?? `微信工具 ${tool} 失败` }],
      }
    }
    return { ok: true, isError: false, content: res.content ?? [] }
  }

  /**
   * 调工具并把结果拼成**一段文本**（`call` 的薄适配层）。
   *
   * 存在的理由：从 MCP 迁过来的调用点全部假设 `Promise<string>` + 自己 `JSON.parse`，
   * 而侧车交的是 `content[]` 块数组（`read_image` 还会混进位图块）。没有这层，每个调用点
   * 都要重造一遍「取 text 块、拼起来、判失败」，改一处就多一份漂移。
   *
   * **失败语义与 MCP 时代一致**：
   * - 工具内部炸了 → 侧车帧 `ok:false` → 这里**抛**（与 MCP client 的 reject 同构）。
   * - **业务失败**（`env_not_ready` / `target_not_found` / `send_not_confirmed`…）→ 侧车帧
   *   仍是 `ok:true`，正文就是那段 `{ok:false, error_code, detail, suggestion}` JSON，
   *   **原样返回**，由调用方 `JSON.parse` 后按 `error_code` 处置——这正是老代码的写法。
   *   所以发送路径的「先看 error_code、别一律重试」不需要额外适配。
   */
  async callText(
    tool: string,
    args: Record<string, unknown> = {},
    opts: WechatCallOptions = {},
  ): Promise<string> {
    const res = await this.call(tool, args, opts)
    const text = res.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
    if (!res.ok) throw new Error(text || `微信工具 ${tool} 调用失败`)
    return text
  }

  /** 侧车是否可用（不拉起进程；`ensureStarted` 成功后为 true，子进程挂了会归 false） */
  isReady(): boolean {
    return !!this.initFrame && !!this.child && !this.child.killed
  }

  /** 主动重启侧车（盯梢撞上「空错误」时的自愈口；下次 `call` 会自动拉起） */
  reset(reason = '手动重置'): void {
    const child = this.child
    this.resetChild(reason)
    try {
      child?.kill()
    } catch {
      /* 已退出 */
    }
  }

  /** 发一条 RPC，返回原始帧（`ok` + `data`/`content`/`error`） */
  private rpc<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    opts: WechatCallOptions = {},
  ): Promise<RpcFrame<T>> {
    return new Promise((resolve, reject) => {
      const child = this.child
      if (!child || !child.stdin.writable) {
        reject(new Error('微信侧车未运行'))
        return
      }
      // 一条请求一个 id；`progressToken` 让侧车知道要往哪个 id 上报进度
      const id = this.nextId++
      const timer = setTimeout(() => {
        // 与 abort / 正常应答一样要解绑：不然 signal 上每超时一次就多挂一个监听器
        this.pending.get(id)?.detach?.()
        this.pending.delete(id)
        reject(new Error(`微信侧车 RPC 超时（${Math.round(timeoutMs / 1000)}s）：${String(params.tool ?? method)}`))
      }, timeoutMs)

      const onAbort = (): void => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error('已取消'))
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })

      this.pending.set(id, {
        // 帧形状共享，只有 `data` 的类型随调用方而变（initialize 是 InitFrame，call 不带 data）
        resolve: (v) => resolve(v as RpcFrame<T>),
        reject,
        onProgress: opts.onProgress,
        timer,
        detach: () => opts.signal?.removeEventListener('abort', onAbort),
      })
      child.stdin.write(`${JSON.stringify({ id, method, ...params, ...(opts.onProgress ? { progressToken: String(id) } : {}) })}\n`)
    })
  }

  /**
   * 子进程事件与分帧。
   *
   * **四处 `'error'` 都要挂**：EventEmitter 的 `'error'` 没有监听者会抛成
   * uncaughtException，主进程全局兜底会判定致命并 `process.exit(1)`——子进程因为
   * 一句写不进去的 stdout 就把整个 App 带走。这一条在 voice 侧车踩过，注释照抄。
   */
  private attachChildHandlers(startedChild: ChildProcessWithoutNullStreams): void {
    startedChild.stdout.setEncoding('utf8')
    startedChild.stderr.setEncoding('utf8')
    startedChild.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    startedChild.stderr.on('data', (chunk: string) => {
      const t = chunk.trim()
      // 侧车的 stderr 是业务日志（含 traceback），保留尾部便于排查
      if (t) log.warn('[sidecar]', t.slice(-800))
    })

    const onChildGone = (err: Error) => {
      if (this.child !== startedChild) return
      log.warn('侧车通信中断:', err.message)
      this.resetChild(`微信侧车通信中断: ${err.message}`)
      try {
        startedChild.kill()
      } catch {
        /* 已退出 */
      }
    }
    startedChild.on('error', onChildGone)
    startedChild.stdin.on('error', onChildGone)
    startedChild.stdout.on('error', onChildGone)
    startedChild.stderr.on('error', onChildGone)

    startedChild.on('exit', (code) => {
      if (this.child !== startedChild) return
      log.warn(`侧车退出 code=${code}`)
      this.resetChild(`微信侧车已退出 (code=${code})`)
    })
  }

  /** 子进程不可用：拒绝所有挂起调用并清空状态（下次调用会重新拉起） */
  private resetChild(reason: string): void {
    this.initFrame = null
    this.stdoutBuf = ''
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.detach?.()
      p.reject(new Error(reason))
    }
    this.pending.clear()
    this.child = null
  }

  /** 销毁侧车（应用退出时调）。先礼后兵：shutdown 帧 → kill */
  async destroy(): Promise<void> {
    const child = this.child
    if (!child) return
    try {
      await this.rpc('shutdown', {}, 10_000)
    } catch {
      /* 侧车可能已经死了，无所谓 */
    }
    try {
      child.kill()
    } catch {
      /* 同上 */
    }
    this.resetChild('微信侧车已销毁')
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    const lines = this.stdoutBuf.split('\n')
    // 最后一段可能不完整，留到下次
    this.stdoutBuf = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let msg: {
        id?: number
        type?: string
        ok?: boolean
        data?: unknown
        content?: WechatContentBlock[]
        error?: string
        message?: string
        progress?: number
        total?: number
      }
      try {
        msg = JSON.parse(trimmed)
      } catch {
        log.warn('[sidecar stdout] 非 JSON 行（已忽略）:', trimmed.slice(0, 200))
        continue
      }
      const id = msg.id
      if (typeof id !== 'number') continue
      const p = this.pending.get(id)
      if (!p) continue

      // 进度帧：不结账
      if (msg.type === 'progress') {
        try {
          p.onProgress?.({ message: msg.message ?? '', progress: msg.progress ?? 0, ...(msg.total !== undefined ? { total: msg.total } : {}) })
        } catch (e) {
          log.warn('进度回调抛错（已忽略）:', (e as Error).message)
        }
        continue
      }

      this.pending.delete(id)
      clearTimeout(p.timer)
      p.detach?.()
      p.resolve({
        ok: Boolean(msg.ok),
        ...(msg.data !== undefined ? { data: msg.data } : {}),
        ...(msg.content ? { content: msg.content } : {}),
        ...(msg.error ? { error: msg.error } : {}),
      })
    }
  }
}

let shared: WechatSidecarClient | null = null

/** 进程内单例：侧车持密钥扫描缓存与自检线程，每次调用重起是浪费 */
export function getWechatSidecar(): WechatSidecarClient {
  if (!shared) shared = new WechatSidecarClient()
  return shared
}

/** 应用退出时调用 */
export async function destroyWechatSidecar(): Promise<void> {
  const client = shared
  shared = null
  if (client) await client.destroy()
}
