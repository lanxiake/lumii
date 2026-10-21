/**
 * 渲染层客户端插件的加载状态上报。
 *
 * 客户端插件跑在渲染层，**加载结果只有那里知道**：语法错误、注册契约写错、
 * 槽位 id 与别的插件撞车——这些都不会在主进程留下痕迹。设置页直接读渲染层，
 * 但 Agent 工具跑在主进程，所以这里留一份「渲染层最近一次上报」的快照。
 *
 * 渲染层只在快照签名变化时上报，频率与插件增删/失败一致，不是每秒一次。
 */

export type ClientPluginLoadState = 'loaded' | 'failed' | 'disabled' | 'incompatible' | 'unknown'

export interface ClientPluginStateReport {
  id: string
  name: string
  version: string
  dir: string
  enabled: boolean
  origin: 'agent' | 'user'
  state: ClientPluginLoadState
  error?: string
}

export interface ClientPluginStateSnapshot {
  states: ClientPluginStateReport[]
  /** 最近一次上报时间（0 = 本次进程还没收到过） */
  reportedAt: number
}

/** 插件数量是个位数；设上限只是防止异常载荷把内存撑大。 */
const MAX_ENTRIES = 200
const VALID_STATES: ReadonlySet<string> = new Set([
  'loaded',
  'failed',
  'disabled',
  'incompatible',
  'unknown',
])

let states: ClientPluginStateReport[] = []
let reportedAt = 0

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 接收 IPC 载荷。**不信任渲染层传进来的形状**——类型只是编译期约定，
 * 这里的清洗是为了让坏载荷退化成「没有这条」而不是让工具输出变形。
 */
export function setClientPluginStateReport(raw: unknown): void {
  if (!Array.isArray(raw)) return
  const next: ClientPluginStateReport[] = []
  for (const item of raw.slice(0, MAX_ENTRIES)) {
    if (typeof item !== 'object' || item === null) continue
    const r = item as Record<string, unknown>
    const id = str(r.id)
    if (!id) continue
    const state = str(r.state)
    next.push({
      id,
      name: str(r.name) || id,
      version: str(r.version),
      dir: str(r.dir),
      enabled: r.enabled === true,
      origin: r.origin === 'agent' ? 'agent' : 'user',
      state: (VALID_STATES.has(state) ? state : 'unknown') as ClientPluginLoadState,
      ...(typeof r.error === 'string' && r.error ? { error: r.error } : {}),
    })
  }
  states = next
  reportedAt = Date.now()
}

export function getClientPluginStateReport(): ClientPluginStateSnapshot {
  return { states, reportedAt }
}

/** 仅测试用 */
export function __resetClientPluginStateReportForTest(): void {
  states = []
  reportedAt = 0
}
