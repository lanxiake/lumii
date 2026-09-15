// 启动阶段事件
export interface StartupPhaseEvent {
  timestamp: number
  kind: 'startup.phase'
  phase: 'preload' | 'window' | 'agent-runtime' | 'voice-service' | 'screen-record'
  duration: number
}

// 启动完成事件
export interface StartupCompleteEvent {
  timestamp: number
  kind: 'startup.complete'
  totalDuration: number
  phases: Record<string, number>
}

// IPC 慢调用事件（>200ms）
export interface IpcSlowEvent {
  timestamp: number
  kind: 'ipc.slow'
  channel: string
  duration: number
  args?: string[]
}

// IPC 错误事件
export interface IpcErrorEvent {
  timestamp: number
  kind: 'ipc.error'
  channel: string
  error: string
  args?: string[]
}

// IPC 聚合事件（60s 窗口）
export interface IpcAggregateEvent {
  timestamp: number
  kind: 'ipc.aggregate'
  windowStart: number
  windowEnd: number
  channel: string
  totalCalls: number
  totalDuration: number
  errors: number
  minDuration: number
  maxDuration: number
}

// 内存快照事件
export interface MainProcessMemory {
  heapUsed: number
  /**
   * V8 已提交的堆容量。与 heapUsed 的差值即「已向系统要来但当前没用上」的部分——
   * 主进程 RSS 远大于 heapUsed 时，先看这里是不是堆只涨不退。
   */
  heapTotal: number
  external: number
  /**
   * ArrayBuffer / Buffer 的后备存储字节数（Node 16 起从 external 中单列）。
   * 这类内存不进 V8 堆，只看 heapUsed 会整块漏掉，是排查「RSS 大而堆小」的关键口径。
   */
  arrayBuffers: number
  rss: number
}

export interface ChildProcessMemory {
  pid: number
  type: string
  workingSetSize: number
  privateBytes: number
}

export interface MemorySnapshotEvent {
  timestamp: number
  kind: 'memory.snapshot'
  mainProcess: MainProcessMemory
  childProcesses: ChildProcessMemory[]
}

/**
 * 渲染进程的原生内存口径（preload 侧读 Electron/Node 接口得到）
 *
 * 起因：2026-09-15 的实测里，主窗口渲染进程私有内存 2.6GB，而 performance.memory
 * 报的 JS 堆只有 112MB，DOM 7k 节点、页面图片 1.7MB、canvas 0——上面那组「页面口径」
 * 全部加起来也解释不了缺口。缺口只可能落在四处，这里逐一给数：
 *
 * - V8 堆之外的 malloc（v8Malloced）与 ArrayBuffer 后备存储（arrayBuffers）
 * - Blink 分配器自己的账（blinkAllocated / blinkTotal）
 * - Blink 资源缓存（res*）：只数 document.images 会漏掉「已从 DOM 摘掉但仍被缓存」
 *   的解码位图，这是「DOM 很小但内存很大」的经典成因，故额外记 liveSize
 * - 进程级读数（rss / selfPrivate），让单条采样自带总量，不必再去 join memory.snapshot
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
  /** 本进程私有提交内存（KB），与 memory.snapshot 的 privateBytes 同口径 */
  selfPrivate: number
  /** 本进程工作集（KB） */
  selfWorkingSet: number
}

/**
 * 渲染进程内存采样（由渲染层每分钟上报）
 *
 * memory.snapshot 只拿得到渲染进程的进程级读数（workingSetSize / privateBytes），
 * 看不出这些内存落在 V8 堆里还是 Blink 侧。2026-09-15 主窗口渲染进程因 V8 堆
 * 撞上 4GB 上限而崩溃时，正是缺这一层口径：进程私有内存 5.4GB，
 * 但完全不知道其中多少是 JS 对象、多少是 DOM/解码位图/合成器。
 * 这里把两边并排记进同一份 perf 日志，下次再涨就能直接定位。
 */
export interface RendererMemoryEvent {
  timestamp: number
  kind: 'renderer.memory'
  /** 上报窗口所在的渲染进程 pid，可与 memory.snapshot.childProcesses[].pid 对照 */
  pid: number
  /** V8 已用堆字节数 */
  jsHeapUsed: number
  /** V8 堆上限（本机 4GB），逼近即濒临 OOM 崩溃 */
  jsHeapLimit: number
  /** 文档元素总数 */
  domNodes: number
  /** 图片元素数量 */
  imgs: number
  /** 已解码图片位图字节数估算（naturalWidth × naturalHeight × 4） */
  imageBytes: number
  /** canvas 元素数量 */
  canvases: number
  /** canvas 后备存储字节数估算（width × height × 4） */
  canvasBytes: number
  /** iframe 数量 */
  iframes: number
  /** 运行时 store 内的会话数（只增不减的 Map，持续上涨需警惕） */
  sessions: number
  /** 各会话消息数之和 */
  messages: number
  /** 消息正文字符数之和（数据结构本身的体量） */
  contentChars: number
  /** 会话内文件事件累计条数 */
  fileEvents: number
  /** 上下文压缩卡片累计条数 */
  compactionEvents: number
  /** 消息数最多的前 3 个会话，形如 "394c9ea33cee:122,..." */
  topSessions: string
  /** 原生口径（V8 堆外 / Blink / 资源缓存 / 进程级），见 RendererNativeMemory */
  native: RendererNativeMemory
}

/**
 * 渲染层上报的采样字段。时间戳与来源 pid 由主进程补齐——
 * 渲染层自填的 pid 没有可信度，而进程崩溃后要靠它认领是哪个进程。
 */
export type RendererMemorySample = Omit<RendererMemoryEvent, 'timestamp' | 'kind' | 'pid'>

/**
 * 渲染层自己采得到的那部分：页面口径 + store 体量。
 * native 那几个数要走 Electron 接口，只有 preload 够得着，由那边另读后并入。
 */
export type RendererPageSample = Omit<RendererMemorySample, 'native'>

// 性能事件联合类型
export type PerformanceEvent =
  | StartupPhaseEvent
  | StartupCompleteEvent
  | IpcSlowEvent
  | IpcErrorEvent
  | IpcAggregateEvent
  | MemorySnapshotEvent
  | RendererMemoryEvent

// 性能统计报告
export interface StartupStats {
  totalDuration: number
  phases: Record<string, number>
  completed: boolean
}

export interface IpcCallStats {
  channel: string
  totalCalls: number
  successCalls: number
  errorCalls: number
  totalDuration: number
  minDuration: number
  maxDuration: number
  averageDuration: number
}

export interface IpcStats {
  totalCalls: number
  slowCalls: number
  errors: number
  channelBreakdown: Record<string, IpcCallStats>
  averageLatency: number
}

export interface MemoryStats {
  current: {
    mainProcess: MainProcessMemory
    childProcesses: ChildProcessMemory[]
  }
  peak: {
    mainProcess: MainProcessMemory
    childProcesses: ChildProcessMemory[]
  }
}

export type HealthStatus = 'good' | 'warning' | 'critical'

export interface PerformanceReport {
  generatedAt: number
  startupStats: StartupStats
  ipcStats: IpcStats
  memoryStats: MemoryStats
  health: HealthStatus
}

// 监控配置
export interface PerformanceMonitorConfig {
  enabled: boolean
  ipcSlowThresholdMs: number
  memorySnapshotIntervalMs: number
  maxQueueSize: number
  logDir?: string
}
