/**
 * 性能监控的数据模型。
 *
 * 口径（2026-10-29 定）：只记**慢/贵**事件，不记常规运行数据。
 * 改前一天的 perf 日志里 90% 是「每 60 秒一次的内存快照 + IPC 聚合窗口」，
 * 真正的慢调用只占 2.6%，信号被自己埋掉了。
 *
 * 因此这里只有两类事件：
 * - `PerfEvent`：超过阈值才产生（慢 IPC / 慢 SQL / 主线程阻塞 / 长任务 / 内存尖峰）。
 * - `StartupPhaseEvent`：每次启动每个阶段一条，用于对比启动预算。
 *
 * 常规调用（没超阈值的那些）只在主进程内存里累计计数，**不落盘**。
 */

/** 启动阶段耗时（每次启动、每个阶段一条） */
export interface StartupPhaseEvent {
  timestamp: number
  kind: 'startup.phase'
  phase: string
  duration: number
}

export type PerfEventKind =
  | 'ipc.slow'
  | 'ipc.error'
  | 'db.slow'
  | 'main.loop.lag'
  | 'renderer.longtask'
  | 'renderer.interaction'
  | 'memory.spike'

/**
 * 一条慢事件。
 *
 * 所有 kind 共用同一形状，是为了让「落盘 / 页面筛选 / 复制」三处口径一致——
 * 三种事件三种字段的话，页面每加一种就要加一条分支，复制出去的 JSON 也没法统一处理。
 */
export interface PerfEvent {
  timestamp: number
  kind: PerfEventKind
  /** 维度标识：IPC 通道名 / SQL 模板 / 交互名 / 长任务来源 / `main`|`renderer` */
  name: string
  /** 耗时（毫秒）。内存尖峰没有耗时，省略。 */
  duration?: number
  /** 少量补充字段，只放短字符串与数字（不记参数、正文、模型输入输出） */
  detail?: Record<string, string | number>
}

/** 磁盘与页面上的一条记录 */
export type PerfLogEntry = PerfEvent | StartupPhaseEvent

/** 诊断页顶部摘要 */
export interface PerfSummary {
  generatedAt: number
  /** 今日慢事件（按 kind 计数） */
  today: {
    total: number
    byKind: Record<string, number>
    slowestMs: number
    /** 内存里只保留最近 N 条，超出的已丢弃；为 true 时 total 是下限而不是全量 */
    truncated?: boolean
  }
  /** 本进程本次运行的常规调用计数（不落盘，仅用于给出「慢多少次 / 总共多少次」的分母） */
  ipc: {
    totalCalls: number
    slowCalls: number
    errors: number
    byChannel: Record<string, { calls: number; slowCalls: number; errors: number; maxMs: number }>
  }
  startupStats: {
    totalDuration: number
    phases: Record<string, number>
  }
  memory: {
    rss: number
    heapUsed: number
    peakRss: number
  }
  logDir: string
  health: 'good' | 'warning' | 'critical'
}

/** 监控配置 */
export interface PerformanceMonitorConfig {
  enabled: boolean
  logDir?: string
  /** 慢 IPC 阈值（毫秒） */
  ipcSlowThresholdMs: number
  /** 内存尖峰：RSS 绝对值阈值（字节） */
  memoryRssThresholdBytes: number
  /** 内存尖峰：相对上次上报的涨幅阈值（字节） */
  memoryGrowthThresholdBytes: number
  /** 内存事件最小上报间隔（毫秒），防止连续尖峰刷屏 */
  memorySpikeCooldownMs: number
  /** 内存队列上限 */
  maxQueueSize: number
}

/**
 * 核心对性能监控的**最小依赖面**（type-only）。
 *
 * 实现在官方扩展 `plugins/external-src/perf/`；核心只把它当容器里的一个服务用。
 * 类型放在 shared 是为了让核心（含预加载/渲染层的报告类型）不必 import 扩展实现。
 */
export interface PerfMonitorLike {
  recordIpcCall(channel: string, durationMs: number, error: boolean): void
  recordStartupPhase(phase: string, durationMs: number): void
  /** 上报一条慢事件（插件内部 / 渲染层 / SQL 钩子都走这里） */
  recordEvent(event: PerfEvent): void
  flush(): Promise<void>
  cleanOldLogs(): void
  destroy(): void
}

/** 渲染层上报慢事件时递交的部分（时间戳由主进程补，渲染层自填的时间不可信） */
export type RendererPerfEvent = Omit<PerfEvent, 'timestamp'>

/**
 * 渲染进程的原生内存口径（preload 侧读 Electron/Node 接口得到）。
 *
 * 2026-09-15 主窗口渲染进程因 V8 堆撞上 4GB 上限崩溃时，进程私有内存 5.4GB，
 * 但「页面口径」（performance.memory + DOM 节点数 + 图片字节）全加起来不到 10MB，
 * 完全看不出缺口在哪。这组读数就是那一层：V8 堆外 malloc / ArrayBuffer 后备存储、
 * Blink 分配器、Blink 资源缓存（含已从 DOM 摘除但未释放的解码位图）、进程级读数。
 *
 * 只在**内存尖峰**时随事件一起上报（不再每分钟采样落盘）：平时看不看都一样，
 * 真出事那一刻的现场才是要的。
 *
 * 读不到的一律记 0：这些接口在个别平台上可能缺失，采样不能因此整条丢掉。
 */
export interface RendererNativeMemory {
  /** 本进程 RSS（字节） */
  rss: number
  /** V8 已提交堆容量（字节） */
  heapTotal: number
  /** V8 已用堆（字节），与 performance.memory 交叉验证 */
  heapUsed: number
  /** Node 口径的 external（字节） */
  external: number
  /** ArrayBuffer / Buffer 后备存储（字节）——不进 V8 堆的大块内存 */
  arrayBuffers: number
  /** V8 视角已用堆（字节） */
  v8UsedHeap: number
  /** V8 堆的物理占用（字节） */
  v8TotalPhysical: number
  /** V8 经 malloc 分配的内存（字节） */
  v8Malloced: number
  /** 上述 malloc 的峰值（字节） */
  v8PeakMalloced: number
  /** Blink 分配器已分配对象（KB） */
  blinkAllocated: number
  /** Blink 分配器总占用（KB） */
  blinkTotal: number
  /** Blink 资源缓存·图片总字节 */
  resImages: number
  /** Blink 资源缓存·图片仍存活字节（含已从 DOM 摘除但未释放的） */
  resImagesLive: number
  /** Blink 资源缓存·脚本总字节 */
  resScripts: number
  /** Blink 资源缓存·样式表总字节 */
  resCss: number
  /** Blink 资源缓存·字体总字节 */
  resFonts: number
  /** Blink 资源缓存·其它总字节 */
  resOther: number
  /** 本进程私有提交内存（KB），与主进程子进程口径的 privateBytes 同源可对照 */
  selfPrivate: number
  /** 本进程工作集（KB） */
  selfWorkingSet: number
}

/**
 * 正在执行的打点函数（栈）。
 *
 * 存在的唯一目的：事件循环延迟探针触发时，把「当时在跑什么」一起记下来 ——
 * 只知道主线程卡了 300ms、不知道卡在哪，这条事件就没有可分析性。
 *
 * 放在 shared 而不是插件里，是因为打点在核心（`kernel/measured-handler`），
 * 探针在插件；两边不能互相 import（守卫 ⑪/⑫）。
 *
 * **状态挂 globalThis**：perf 扩展是独立 esbuild bundle，模块级变量会有第二份拷贝，
 * 探针读到的永远是空栈（静默失能）。同 `cloud-sync-contract` 的访问器做法。
 */
const INFLIGHT_KEY = Symbol.for('lumii.perf.inflight-spans')
const inflight: string[] = ((globalThis as Record<symbol, unknown>)[INFLIGHT_KEY] ??= []) as string[]

export function beginPerfSpan(name: string): void {
  inflight.push(name)
  // 防御：异常路径漏了 end 时不能让栈无限长
  if (inflight.length > 32) inflight.shift()
}

export function endPerfSpan(name: string): void {
  const idx = inflight.lastIndexOf(name)
  if (idx >= 0) inflight.splice(idx, 1)
}

/** 当时的打点栈快照（最内层在末尾） */
export function getInflightSpans(): string[] {
  return [...inflight]
}

/**
 * 最近发生的**同步阻塞嫌疑**（已结束）。
 *
 * 打点栈只能覆盖「阻塞期间仍压在栈上」的调用；异步回调里的同步代码、以及
 * 已经返回但刚刚卡过主线程的操作都抓不到（2026-10-29 实测：156 条事件循环阻塞里
 * 只有 1 条带得出 inflight）。慢 SQL / 慢 IPC 本身是同步地跑在主线程上的，
 * 把它们结束时的耗时记下来，探针触发时按时间窗回看，就能说清「这几百毫秒是谁占的」。
 */
export interface BlockingSuspect {
  name: string
  /** 结束时刻 */
  endedAt: number
  durationMs: number
}

const SUSPECTS_KEY = Symbol.for('lumii.perf.blocking-suspects')
const suspects: BlockingSuspect[] = ((globalThis as Record<symbol, unknown>)[SUSPECTS_KEY] ??= []) as BlockingSuspect[]

/**
 * 记录一次刚刚结束的同步阻塞嫌疑（慢 SQL / 慢 IPC 都在这里登记）。
 *
 * **只收 ≥50ms 的**：IPC 每秒几十次，全都记的话窗口里全是 0ms 噪音，
 * 真凶反而被挤出去（实测第一次跑出来的是 `ipc agent-runtime:command:0ms`）。
 * 50ms 与慢查询阈值同档，低于它的耗时本来也解释不了一次肉眼可见的卡顿。
 */
export function recordBlockingSuspect(name: string, durationMs: number, endedAt = Date.now()): void {
  if (!(durationMs >= 50)) return
  suspects.push({ name, endedAt, durationMs })
  // 只留最近 16 条：探针最多回看 2 秒，再多没意义
  if (suspects.length > 16) suspects.shift()
}

/**
 * 取在 `[since, until]` 窗口内**与阻塞重叠**的嫌疑，按耗时降序。
 *
 * 重叠判据：嫌疑的 [endedAt - duration, endedAt] 与窗口有交集。
 * 只用「刚好在这一秒结束」会漏掉跨窗口的长查询。
 */
export function findBlockingSuspects(since: number, until: number): BlockingSuspect[] {
  return suspects
    .filter((s) => s.endedAt >= since && s.endedAt - s.durationMs <= until)
    .sort((a, b) => b.durationMs - a.durationMs)
}
