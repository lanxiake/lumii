import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'

export interface MemPalaceDrawer {
  drawer_id: string
  wing: string
  room: string
  content_preview: string
  /** ISO 8601 时间戳，如 "2026-05-01T10:30:00.123456"，旧数据可能为空字符串 */
  filed_at?: string
}

export interface MemPalaceListResult {
  drawers: MemPalaceDrawer[]
  total: number
  offset: number
  limit: number
}

export interface MemPalaceSearchItem {
  text: string
  wing: string
  room: string
  similarity: number
  drawer_id: string
  created_at?: string
}

export interface MemPalaceStatusResult {
  total_drawers: number
  wings: Record<string, number>
  palace_path: string
}

export interface MemPalaceDrawerDetail {
  drawer_id: string
  content: string
  wing: string
  room: string
  metadata: Record<string, unknown>
}

export interface MemPalaceAddResult {
  drawer_id: string
  wing: string
  room: string
  /** 超长内容被切成的分块数；命中幂等（内容已存在）时可能缺省 */
  chunks?: number
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

// Lone surrogates (\uD800-\uDFFF) in JS strings cause JSON.stringify to emit \udc80-style
// Lone surrogates cause Python's str.encode('utf-8') to fail with UnicodeEncodeError.
// String.toWellFormed() (Node 20+) replaces lone surrogates with U+FFFD — the canonical fix.
function toWellFormedStr(s: string): string {
  return s.toWellFormed()
}

/** 递归将对象中所有字符串值转为 well-formed Unicode，防止 lone surrogate 传入 Python */
function sanitizeForUtf8(value: unknown): unknown {
  if (typeof value === 'string') return toWellFormedStr(value)
  if (Array.isArray(value)) return value.map(sanitizeForUtf8)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeForUtf8(v)])
    )
  }
  return value
}

const MAX_RESTARTS = 3
const CALL_TIMEOUT_MS = 30000

export class MemPalaceMcpBridge {
  private proc: ChildProcess | null = null
  private pendingCalls = new Map<number, {
    resolve: (v: unknown) => void
    reject: (e: Error) => void
    timer: NodeJS.Timeout
  }>()
  private nextId = 1
  private restartCount = 0
  private starting: Promise<void> | null = null
  private statusCache: { result: MemPalaceStatusResult; ts: number } | null = null

  constructor(
    private readonly pythonExe: string,
    private readonly palaceDir?: string,
  ) {}

  async ensureRunning(): Promise<void> {
    if (this.proc && !this.proc.killed) return
    if (this.starting) return this.starting
    this.starting = this._start().finally(() => { this.starting = null })
    return this.starting
  }

  private async _start(): Promise<void> {
    const args = ['-m', 'mempalace.mcp_server']
    if (this.palaceDir) args.push('--palace', this.palaceDir)

    // Force Python to decode stdin as UTF-8 (Windows default is GBK with surrogateescape,
    // which turns non-GBK bytes into \uDCXX lone surrogates and breaks downstream encode()).
    this.proc = spawn(this.pythonExe, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    })

    this.attachChildHandlers(this.proc)

    // 注册行解析器——mcp_server 每行一条 JSON-RPC 响应
    const rl = createInterface({ input: this.proc.stdout! })
    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse
        if (typeof msg.id !== 'number') return // 通知没有 id，忽略
        const pending = this.pendingCalls.get(msg.id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pendingCalls.delete(msg.id)
        if (msg.error) {
          pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`))
        } else {
          pending.resolve(msg.result)
        }
      } catch {
        // 非 JSON 行（如 startup banner）忽略
      }
    })

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) console.debug('[MemPalace MCP]', text)
    })

    // 等待进程实际启动（给它 200ms 预热），然后发送 initialize 握手
    await new Promise<void>((resolve, reject) => {
      // 如果进程立即退出（如找不到 python 或模块）
      const earlyExit = (code: number | null) => {
        reject(new Error(`MemPalace MCP 进程启动失败，退出码 ${code}`))
      }
      this.proc!.once('exit', earlyExit)
      setTimeout(() => {
        this.proc?.removeListener('exit', earlyExit)
        resolve()
      }, 300)
    })

    // 发送 MCP initialize 握手（一次，无重试）
    await this._rpcCall('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mtbot-windows', version: '1.0' },
    }, 10000)

    // 发送 initialized 通知（无需响应）
    const notifMsg = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n'
    this.proc?.stdin?.write(notifMsg)

    this.restartCount = 0
    console.debug('[MemPalace MCP] 握手完成，服务就绪')

    // 空 chroma.sqlite3（有库无 mempalace_drawers）时，list/search 走 create=False 会打 NotFound 堆栈。
    // mempalace_status 在 db 已存在时用 create=True 引导创建 collection，必须在首次读工具前完成。
    await this._bootstrapCollectionIfNeeded()
  }

  /**
   * 握手后调用 mempalace_status，引导创建缺失的 drawers collection（幂等）。
   * 失败仅记日志：后续 add_drawer(create=True) 仍可自愈。
   */
  private async _bootstrapCollectionIfNeeded(): Promise<void> {
    try {
      const result = await this.callTool('mempalace_status', {}) as MemPalaceStatusResult & { error?: string }
      if (!result?.error) {
        this.statusCache = { result, ts: Date.now() }
      }
    } catch (err) {
      console.warn(
        '[MemPalace MCP] 宫殿集合引导失败（可稍后由写入修复）:',
        err instanceof Error ? err.message : err,
      )
    }
  }

  private _rpcCall(method: string, params: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pendingCalls.delete(id)
        reject(new Error(`MCP 调用超时: ${method} (${timeoutMs}ms)`))
      }, timeoutMs)

      this.pendingCalls.set(id, { resolve, reject, timer })

      // Sanitize all string values in params before serialization so Python utf-8 encode never sees lone surrogates
      const safeParams = sanitizeForUtf8(params)
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params: safeParams }) + '\n'
      this.proc?.stdin?.write(msg, (err) => {
        if (err) {
          clearTimeout(timer)
          this.pendingCalls.delete(id)
          reject(err)
        }
      })
    })
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureRunning()
    const result = await this._rpcCall('tools/call', { name, arguments: args }) as {
      content?: Array<{ type: string; text: string }>
    }
    const text = result?.content?.[0]?.text
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  async getStatus(forceRefresh = false): Promise<MemPalaceStatusResult> {
    if (!forceRefresh && this.statusCache && Date.now() - this.statusCache.ts < 5000) {
      return this.statusCache.result
    }
    const result = await this.callTool('mempalace_status', {}) as MemPalaceStatusResult & { error?: string }
    if (result?.error) {
      // palace 目录还未初始化，返回空状态
      return { total_drawers: 0, wings: {}, palace_path: '' }
    }
    this.statusCache = { result, ts: Date.now() }
    return result
  }

  async listDrawers(params: { wing?: string; room?: string; limit?: number; offset?: number }): Promise<MemPalaceListResult> {
    // 先 status（可 create collection），再 list（create=False），避免空库缺集合时刷 NotFound 堆栈
    let total = 0
    try {
      const status = await this.getStatus()
      total = status.total_drawers ?? 0
    } catch {
      total = 0
    }

    const raw = await this.callTool('mempalace_list_drawers', {
      limit: params.limit ?? 20,
      offset: params.offset ?? 0,
      ...(params.wing ? { wing: params.wing } : {}),
      ...(params.room ? { room: params.room } : {}),
    }) as { drawers?: MemPalaceDrawer[]; count?: number; offset?: number; limit?: number; error?: string }

    if (raw?.error) {
      // palace 未初始化
      return { drawers: [], total: 0, offset: 0, limit: params.limit ?? 20 }
    }

    return {
      drawers: raw.drawers ?? [],
      total: total || (raw.drawers?.length ?? 0),
      offset: raw.offset ?? 0,
      limit: raw.limit ?? 20,
    }
  }

  async searchDrawers(params: { query: string; limit?: number; wing?: string; room?: string }): Promise<MemPalaceSearchItem[]> {
    const raw = await this.callTool('mempalace_search', {
      query: params.query,
      limit: params.limit ?? 20,
      ...(params.wing ? { wing: params.wing } : {}),
      ...(params.room ? { room: params.room } : {}),
    }) as { results?: MemPalaceSearchItem[]; error?: string } | MemPalaceSearchItem[]

    if (Array.isArray(raw)) return raw
    if ((raw as { error?: string }).error) return []
    return (raw as { results?: MemPalaceSearchItem[] }).results ?? []
  }

  /**
   * 写入一个 drawer（对话原文 / 段原文归档）。
   *
   * mempalace 的写工具用「返回值」而非异常报错：写入失败返回 `{"success": false, "error": …}`，
   * collection 打不开时（后端不匹配、库缺失等）更是直接返回 `{"error": …}`——两者在 JSON-RPC
   * 层都算成功响应。不校验 `success` 就会把失败静默记成写入成功：2026-09-15 排查发现，
   * 子进程整天在 chroma upsert 上崩溃（access violation）的同期，日志仍报出 100 次
   * 「记忆已写入」而宫殿里 0 条新数据，故障因此被掩盖。
   * 这里统一把失败收敛成抛异常，让调用方的 catch 如实记账。
   */
  async addDrawer(params: {
    wing: string
    room: string
    content: string
    addedBy: string
    sourceFile?: string
  }): Promise<MemPalaceAddResult> {
    const raw = (await this.callTool('mempalace_add_drawer', {
      wing: params.wing,
      room: params.room,
      content: params.content,
      added_by: params.addedBy,
      ...(params.sourceFile != null ? { source_file: params.sourceFile } : {}),
    })) as { success?: boolean; drawer_id?: string; error?: string } | null

    // 内容已存在时 Python 侧返回 {success: true, reason: 'already_exists', drawer_id}，同属成功
    if (raw?.success === true && raw.drawer_id) {
      this.statusCache = null
      return raw as MemPalaceAddResult
    }
    throw new Error(raw?.error ?? (raw ? '未返回 success 标记' : '未返回结果'))
  }

  async deleteDrawer(drawerId: string): Promise<void> {
    await this.callTool('mempalace_delete_drawer', { drawer_id: drawerId })
    this.statusCache = null
  }

  async getDrawer(drawerId: string): Promise<MemPalaceDrawerDetail> {
    return await this.callTool('mempalace_get_drawer', { drawer_id: drawerId }) as MemPalaceDrawerDetail
  }

  /**
   * 挂起子进程的生命周期处理：stdio 管道 'error' 与进程 'exit'。
   *
   * 为什么必须挂 'error'：EventEmitter 的 'error' 没有监听者时会直接抛成
   * uncaughtException，被主进程全局兜底（只放行 EPIPE/EOF/ERR_STREAM_DESTROYED）
   * 判定为致命错误并 process.exit(1)——子进程的死会连带整个客户端退出。
   * 这里统一降级为「本次调用失败 + 走 exit 分支的自动重启」。
   *
   * 独立成方法是为了能在单测里注入假子进程（见 mempalace-mcp-client.test.ts）。
   */
  private attachChildHandlers(proc: ChildProcess): void {
    const onChildGone = (err: Error) => {
      console.warn('[MemPalace MCP] 子进程通信中断:', err.message)
      this._cleanup()
      try {
        proc.kill()
      } catch {
        // 进程已退出，kill 无事可做
      }
    }
    proc.on('error', onChildGone)
    proc.stdin?.on('error', onChildGone)
    proc.stdout?.on('error', onChildGone)
    proc.stderr?.on('error', onChildGone)

    // 进程退出时清理挂起调用，并在未超过重试上限时自动重启
    proc.on('exit', (code) => {
      console.warn(`[MemPalace MCP] 进程退出，code=${code}`)
      this._cleanup()
      if (this.restartCount < MAX_RESTARTS) {
        this.restartCount++
        const delay = Math.min(2000 * this.restartCount, 8000)
        console.warn(`[MemPalace MCP] ${delay}ms 后重启（第 ${this.restartCount} 次）`)
        setTimeout(() => { this.ensureRunning().catch(() => {}) }, delay)
      } else {
        console.error('[MemPalace MCP] 达到最大重启次数，停止重试')
      }
    })
  }

  private _cleanup(): void {
    for (const [, pending] of this.pendingCalls) {
      clearTimeout(pending.timer)
      pending.reject(new Error('MCP 进程已退出'))
    }
    this.pendingCalls.clear()
    this.proc = null
  }

  stop(): void {
    if (!this.proc) return
    const proc = this.proc
    this._cleanup() // 先清理，避免 exit 事件触发重启
    try {
      const shutdownMsg = JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'shutdown', params: {} }) + '\n'
      proc.stdin?.write(shutdownMsg)
      setTimeout(() => { proc.kill() }, 2000)
    } catch {
      proc.kill()
    }
  }
}
