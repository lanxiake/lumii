import { spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
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

/** wing/room 长度上限（对齐 mempalace.config.MAX_NAME_LENGTH） */
const PALACE_NAME_MAX = 128
/** 超长截断后拼接的哈希长度：截断位不同的长名不会撞成同一个 */
const PALACE_NAME_HASH_LEN = 16

/**
 * mempalace 认的名字：首尾为字母/数字，中间可含字母数字与 `_ . ' -` 空格。
 * 等价于 Python 侧 `mempalace.config._SAFE_NAME_RE`（那边 `\w` 即 isalnum + `_`）。
 */
const PALACE_NAME_OK_RE = /^(?:[\p{L}\p{N}]|[\p{L}\p{N}][\p{L}\p{N}_ .'-]{0,126}[\p{L}\p{N}])$/u

/** 归一化时视为合法的字符（比 Python 窄：只留 `_` 和 `-`，避免造出 `..` 这类路径形态） */
const PALACE_NAME_BAD_RE = /[^\p{L}\p{N}_-]+/gu

/** 名字里至少要有字母或数字——首尾都得是它，全是符号的名字得换 fallback */
const PALACE_ALNUM_RE = /[\p{L}\p{N}]/u

/** drawer 正文上限（对齐 mempalace.config.sanitize_content 的 max_length） */
const MAX_DRAWER_CONTENT = 100_000
/** 截断说明：附在正文末尾，免得以后有人以为宫殿里存的原文本来就到这儿为止 */
const TRUNCATION_NOTE = '\n\n[原文过长，此处截断；完整原文在本机会话库]'

/**
 * 正文归一：mempalace 的 sanitize_content 会拒收含 NUL 字节或超过 10 万字符的正文
 * （同样是「返回值报错」，不处理就整条内容进不了宫殿，段与记忆都只剩空 drawer_id）。
 *
 * - NUL 一律换成 U+FFFD，与 mempalace 自己的 strip_nul_bytes 同款（#1235：NUL 会让
 *   后端 SQLite/FTS5 的倒排索引损坏，殃及整个 collection，不只是这一条存不进去）。
 *   会话原文里带 NUL 很正常——工具输出、文件内容、命令 stdout 都可能夹带。
 * - 超长则截断并留说明。分片不做：宫殿里的段原文是「回查原文」的兜底，完整原文在
 *   本机会话库（getMemoryProvenance 直接从那儿读），截断不影响回溯，还能保住
 *   drawer_id 与内容的一一对应（分片会变成一对多，回填哪个 id 就说不清了）。
 *
 * 长度用 JS 的 `.length`（UTF-16 码元）比 Python 的 `len`（码点）只多不少，
 * 所以按它判上限不会越界。
 */
function clampDrawerContent(content: string): string {
  const safe = content.replace(/\u0000/g, '\uFFFD')
  if (safe.length <= MAX_DRAWER_CONTENT) return safe
  return safe.slice(0, MAX_DRAWER_CONTENT - TRUNCATION_NOTE.length) + TRUNCATION_NOTE
}

/**
 * 把应用内的标识归一成 mempalace 收得下的 wing/room 名字。
 *
 * Python 侧 `sanitize_name` 只收上面那条正则允许的名字，否则 ValueError
 * （`wing/room contains invalid characters`）；写工具把它当**返回值**报错，
 * 于是内容一条都进不了宫殿。而应用里的标识偏偏带 `:`——段归档的 wing 默认是
 * `${agentId}:${userId}`，会话 id 又是渠道前缀制（`cron:news-pipeline`、
 * `feishu:ou_…`、`weixin:…@im.wechat`）。2026-09-16 错误日志里 4 条 MemPalace
 * 写入失败全出于此，宫殿里也因此只有 `conversations` 一个 wing、room 全是纯 hex。
 *
 * 规则：已是合法名字的原样返回（宫殿里别的客户端写的名字不能被改写，否则按它
 * 过滤会查不到）；否则非法字符统一换成 `_`、去掉首尾的 `_`/`-`，空则退回 fallback，
 * 超长则截断接哈希。同一输入恒得同一名字，读写两端因此对得上。
 *
 * 注意这是有损映射（`cron:news` 与 `cron_news` 撞同一名字），可读性优先于唯一性：
 * 调用方传的都是应用内的 id，形态固定，实际不会撞。
 */
export function toPalaceName(value: string, fallback = 'unnamed'): string {
  const trimmed = value.trim()
  if (PALACE_NAME_OK_RE.test(trimmed)) return trimmed
  const cleaned = trimmed.replace(PALACE_NAME_BAD_RE, '_').replace(/^[_-]+|[_-]+$/g, '')
  // 首尾的 `_` 去掉后还得剩下字母/数字（`:::`、`_-_` 这类只剩符号的退回 fallback）
  if (!PALACE_ALNUM_RE.test(cleaned)) return fallback
  if (cleaned.length <= PALACE_NAME_MAX) return cleaned
  const hash = createHash('sha256').update(trimmed, 'utf8').digest('hex').slice(0, PALACE_NAME_HASH_LEN)
  return `${cleaned.slice(0, PALACE_NAME_MAX - PALACE_NAME_HASH_LEN - 1)}_${hash}`
}

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
      ...(params.wing ? { wing: toPalaceName(params.wing) } : {}),
      ...(params.room ? { room: toPalaceName(params.room) } : {}),
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
      ...(params.wing ? { wing: toPalaceName(params.wing) } : {}),
      ...(params.room ? { room: toPalaceName(params.room) } : {}),
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
      // 调用方给的是应用内的标识（会话 id 带渠道前缀、wing 带 `:`），
      // 必须归一后才过得了 Python 侧校验（见 toPalaceName）
      wing: toPalaceName(params.wing),
      room: toPalaceName(params.room),
      // 正文同理：NUL 与超长都会让 sanitize_content 整条拒收（见 clampDrawerContent）
      content: clampDrawerContent(params.content),
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
