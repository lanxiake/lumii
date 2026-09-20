/**
 * idle-watcher — 系统闲置轮询（主进程）
 *
 * 设计依据：docs/plans/客户端UI/2026-09-21-宠物自制系统P2-c实施计划.md §一 / §3.1
 *
 * ## 为什么是轮询
 *
 * Electron 的 `powerMonitor` 只提供**查询**（`getSystemIdleTime()` → 整数秒，
 * `getSystemIdleState(threshold)` → active/idle/locked/unknown），**没有「用户闲置了」的事件**。
 * 好在它读的是「用户多久没碰键鼠」，不含任何按键内容——与注视同一条安全边界
 * （一个聊天应用不该有能力看到用户输入，见 P2-b §一）。
 *
 * ## 为什么 1Hz
 *
 * 阈值是分钟级的，1Hz 不是为了分辨率，是为了**醒来跟手**：用户一动，最多 1 秒后宠物就该醒。
 * 一次同步调用 + 一次整数比较，成本可忽略。
 *
 * ## 为什么推「阶段」而不是「秒数」
 *
 * 秒数每秒都在变，推它等于每秒一条 IPC。阶段只有三档，**状态没变就不发**
 * （与 `pet-cursor-tracker` 同一约定）——1Hz 轮询全年只在三次状态切换时发消息。
 *
 * 换算（秒数 → 阶段）在 pet-core 的纯函数 `idleStage` 里，可脱开 Electron 单测。
 */

import { idleStage, type PetIdleStage, type IdleStageOptions } from '@mtbot/pet-core'

const log = {
  info: (...args: unknown[]) => console.log('[pet-idle-watcher]', ...args),
  warn: (...args: unknown[]) => console.warn('[pet-idle-watcher]', ...args),
}

/** 轮询间隔（ms）。1Hz：阈值是分钟级的，这个频率只为「醒来跟手」 */
export const IDLE_POLL_INTERVAL_MS = 1000

/**
 * 阈值覆盖（环境变量，给手测/验证脚本用）。
 *
 * 默认 60s/300s 意味着完整手测要干等 6 分钟；`verify/pet-sprite/check-idle-sleep.mjs`
 * 靠这两个变量把阈值压到秒级，跑的是**同一条生产代码路径**。
 * 走环境变量而不是设置项：这是调试开关，不该出现在用户界面上。
 */
export const IDLE_DROWSY_ENV = 'LUMII_PET_IDLE_DROWSY_SEC'
export const IDLE_ASLEEP_ENV = 'LUMII_PET_IDLE_ASLEEP_SEC'

/** 读环境变量里的正整数秒；没设或不是正数就返回 undefined（用默认值） */
function readEnvSeconds(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    log.warn(`${name}=${raw} 不是正数，忽略（用默认阈值）`)
    return undefined
  }
  return n
}

/** 解析本次进程生效的阈值（环境变量优先） */
export function resolveIdleThresholds(): IdleStageOptions {
  const drowsySec = readEnvSeconds(IDLE_DROWSY_ENV)
  const asleepSec = readEnvSeconds(IDLE_ASLEEP_ENV)
  const opts: IdleStageOptions = {}
  if (drowsySec !== undefined) opts.drowsySec = drowsySec
  if (asleepSec !== undefined) opts.asleepSec = asleepSec
  return opts
}

export interface IdleWatcherDeps {
  /** 系统闲置秒数（`powerMonitor.getSystemIdleTime()`） */
  getIdleSeconds: () => number
  /** 把阶段推给宠物窗口。**只在阶段变化时调用** */
  send: (stage: PetIdleStage) => void
  /** 是否启用（设置项）。返回 false 时把宠物拉回醒着，但不拆定时器——开关随时可能被改回来 */
  isEnabled: () => boolean
  /** 阈值（默认 60s/300s，可用环境变量覆盖） */
  thresholds?: IdleStageOptions
}

let timer: ReturnType<typeof setInterval> | null = null
/** 上次推送出去的阶段；null = 本次会话还没定过初值 */
let lastStage: PetIdleStage | null = null

/**
 * 一轮：读闲置秒数 → 算阶段 → 变了才发。
 *
 * **进宠物模式时立刻定一次初值**（`start` 里同步调用一次）：宠物模式可以由 CLI / 智能体
 * 在用户不在的时候拉起（`switchMode` 不需要任何输入），那时该直接就睡着，
 * 而不是等第一次 tick 才被发现。
 */
function tick(deps: IdleWatcherDeps, thresholds: IdleStageOptions): void {
  // 关掉开关时把宠物拉回醒着：否则「关掉设置项 → 无论闲置多久都不睡」这条不成立
  // （宠物会永远停在睡着的那张脸上，因为没人再推新状态了）。
  if (!deps.isEnabled()) {
    if (lastStage !== null && lastStage !== 'awake') {
      lastStage = 'awake'
      log.info('闲置感知已关闭 → 回到醒着')
      deps.send('awake')
    }
    return
  }

  const idleSec = deps.getIdleSeconds()
  const stage = idleStage(idleSec, thresholds)
  if (stage === lastStage) return
  const prev = lastStage
  lastStage = stage
  log.info(
    `闲置 ${idleSec}s → ${stage}` + (prev === null ? '（进宠物模式时的初始状态）' : `（原 ${prev}）`),
  )
  deps.send(stage)
}

/**
 * 启动闲置轮询。重复调用是幂等的（已在跑就不重开）。
 *
 * 启动时把上次阶段清掉并立刻算一次初值——宠物窗口可能刚被重建，它那边的默认是醒着。
 */
export function startIdleWatching(deps: IdleWatcherDeps): void {
  if (timer) return
  const thresholds = deps.thresholds ?? resolveIdleThresholds()
  lastStage = null

  try {
    tick(deps, thresholds)
  } catch (err) {
    // 首个 tick 与后续共用一套 try：读闲置失败不该让宠物窗口出任何问题
    log.warn(`首次闲置检查失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  timer = setInterval(() => {
    try {
      tick(deps, thresholds)
    } catch {
      // 轮询里抛异常会打断整个定时器；吞掉并继续——闲置感知是锦上添花的功能
    }
  }, IDLE_POLL_INTERVAL_MS)

  log.info(
    `已启动闲置轮询（${IDLE_POLL_INTERVAL_MS}ms/次，阶段不变时不发），` +
      `阈值 打盹=${thresholds.drowsySec ?? '(默认)'} 睡着=${thresholds.asleepSec ?? '(默认)'}`,
  )
}

/** 停止轮询（退出宠物模式、应用退出时调用）。 */
export function stopIdleWatching(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
    log.info('已停止闲置轮询')
  }
  lastStage = null
}

/** 供测试/诊断：当前是否在跑 */
export function isIdleWatching(): boolean {
  return timer !== null
}

/**
 * 当前阶段（主进程这边认定的）。
 *
 * 渲染层要在挂载时**主动问一次**：进宠物模式时那条初始阶段是在窗口页面加载完之前
 * 发出去的，`webContents.send` 会直接丢掉——若那一刻用户已经闲置很久（宠物模式被
 * CLI/智能体拉起，没有任何输入），宠物会一直醒着，直到下一次阶段变化才醒过来，
 * 而下一次变化要等用户回来再离开，等于永远不睡。
 *
 * 返回 null 表示没在轮询（桌面模式），调用方按 `awake` 处理。
 */
export function getCurrentIdleStage(): PetIdleStage | null {
  return lastStage
}

/** 供测试：重置模块状态 */
export function _resetIdleWatcherForTest(): void {
  stopIdleWatching()
}
