/**
 * 本地 Companion 指令处理器（Windows 客户端专用）
 *
 * 与服务端 src/companion/instruction-router.ts 的区别：
 *   - 不依赖 Drizzle DB / Gateway / 外部 infra
 *   - 偏好存储在本地 SQLite runtime_state 表（JSON KV）
 *   - 消息通过 showCronNotification 或渲染侧 IPC 推送，而非 outbound 通道
 *
 * 支持的魔法指令：
 *   __companion_tick__         → 感知→决策→通知
 *   __companion_memory_fast__  → 轻量整理：只在检测出重复/冲突时才叫 LLM
 *   __companion_memory_deep__  → 深度整理：无条件重写一遍个人记忆全文
 */

import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import { consolidateUserMemory, needsPersonalMemoryConsolidation } from '@mtbot/agent-runtime'
import { getVirtualHumanSettings, setVirtualHumanSettings } from '../pet/pet-mode-store'
import { DEFAULT_VH_SETTINGS } from '../../shared/virtual-human'

const log = {
  info: (...args: unknown[]) => console.log('[LocalCompanion]', ...args),
  warn: (...args: unknown[]) => console.warn('[LocalCompanion]', ...args),
  error: (...args: unknown[]) => console.error('[LocalCompanion]', ...args),
}

// ── 偏好配置类型 ──

export interface LocalCompanionPrefs {
  /** 是否启用 Companion（整体开关） */
  enabled: boolean
  /** 模式：off / gentle / active */
  mode: 'off' | 'gentle' | 'active'
  /** 免打扰起始时间（格式 "HH:mm"，如 "22:00"） */
  quietStart: string
  /** 免打扰结束时间（格式 "HH:mm"，如 "08:00"） */
  quietEnd: string
  /** 每日最多触达次数 */
  maxDaily: number
  /** 工作日编号（0=周日 … 6=周六） */
  workDays: number[]
  /** 用户昵称（用于个性化消息） */
  nickname: string
}

const DEFAULT_PREFS: LocalCompanionPrefs = {
  enabled: false,
  mode: 'off',
  quietStart: '22:00',
  quietEnd: '08:00',
  maxDaily: 3,
  workDays: [1, 2, 3, 4, 5],
  nickname: '',
}

const KV_KEY_PREFS = 'local_companion_prefs'
const KV_KEY_DAILY_COUNT = 'local_companion_daily_count'
const KV_KEY_LAST_SENT_AT = 'local_companion_last_sent_at'
const KV_KEY_HISTORY = 'local_companion_history'
const KV_KEY_CRON_SEEDED = 'local_companion_cron_seeded_v1'
/** 旧版 local_companion_prefs → vhSettings 迁移完成标记（幂等） */
const KV_KEY_MIGRATED = 'local_companion_migrated_v1'

// ── 隐藏默认值（不在 UI 暴露，见 09 号设计文档 §3）──

/** 免打扰开始时间 "HH:mm" */
const QUIET_HOURS_START = '22:00'
/** 免打扰结束时间 "HH:mm" */
const QUIET_HOURS_END = '08:00'
/** 每日最多触达次数 */
const MAX_DAILY_COUNT = 3
/** gentle 模式仅在工作日触达（0=周日 … 6=周六） */
const GENTLE_WORK_DAYS = new Set([1, 2, 3, 4, 5])

// ── 历史记录类型 ──

export interface LocalCompanionAction {
  id: string
  content: string
  createdAt: string  // ISO 8601
  feedback: 'accept' | 'ignore' | 'dismiss' | null
}

const MAX_HISTORY = 50  // 最多保留50条

// ── 魔法指令集 ──

const COMPANION_INSTRUCTIONS = new Set([
  '__companion_tick__',
  '__companion_memory_fast__',
  '__companion_memory_deep__',
  '__wiki_ero_extract__',
])

export function isLocalCompanionInstruction(message: string): boolean {
  return COMPANION_INSTRUCTIONS.has(message.trim())
}

// ── 主处理器 ──

export interface LocalCompanionDeps {
  getDb: () => DatabaseAdapter
  /** 发送系统通知（标题 + 内容） */
  showNotification?: (title: string, body: string) => void
  /** 推送消息到渲染侧 Companion 气泡 */
  showCompanionMessage?: (content: string) => void
  /** 当前是否处于宠物模式 */
  isPetMode: () => boolean
  /** 读取虚拟人设置中的主动联系项 */
  getProactiveCare: () => {
    enabled: boolean
    mode: 'gentle' | 'active'
    nickname: string
  }
  /** 读取个人记忆全文（Markdown）；未注入则记忆整理任务直接跳过 */
  getUserMemory?: () => Promise<{ content: string } | undefined>
  /** 覆盖写个人记忆全文 */
  updateUserMemory?: (content: string) => Promise<unknown>
  /** 整理用记忆的 LLM 调用 */
  callLLM?: (prompt: string) => Promise<string>
  /** Wiki ERO 实体关系抽取（cron / 手动触发） */
  runWikiEroExtract?: () => Promise<string>
}

/** Companion 指令执行选项 */
export interface LocalCompanionRunOptions {
  /**
   * 是否来自定时任务列表的「立即执行」。
   * 手动触发视为用户明确意图：绕过宠物模式 / 免打扰 / 日限额 / 最小间隔 / 工作日等软门闩，
   * 与 cron 生效窗口对手动执行的放行策略一致；主动联系总开关仍生效。
   */
  manual?: boolean
}

/**
 * 处理 Companion 魔法指令
 * @returns 执行结果描述（写入 cron_runs）
 */
export async function handleLocalCompanionInstruction(
  instruction: string,
  deps: LocalCompanionDeps,
  options: LocalCompanionRunOptions = {},
): Promise<string> {
  switch (instruction.trim()) {
    case '__companion_tick__':
      return handleTick(deps, options)
    case '__companion_memory_fast__':
      return handleMemoryConsolidation(deps, 'fast')
    case '__companion_memory_deep__':
      return handleMemoryConsolidation(deps, 'deep')
    case '__wiki_ero_extract__': {
      if (!deps.runWikiEroExtract) return 'wiki ero extract unavailable'
      return deps.runWikiEroExtract()
    }
    default:
      return `unknown companion instruction: ${instruction}`
  }
}

// ── Tick：感知→决策→通知 ──

/**
 * 桌宠主动关心：按门闩决策是否发送关怀消息。
 * 自动调度走完整门闩；手动「立即执行」绕过软门闩以便用户自测。
 */
async function handleTick(
  deps: LocalCompanionDeps,
  options: LocalCompanionRunOptions = {},
): Promise<string> {
  const manual = options.manual === true
  log.info(`[handleTick] 开始 manual=${manual}`)

  // 1. 宠物模式门闩：自动调度仅当前处于宠物模式才触达；手动执行可在主窗口自测
  if (!manual && !deps.isPetMode()) {
    log.info('[handleTick] 非宠物模式, skip')
    return 'skipped: not in pet mode'
  }

  // 2. 主动联系总开关（读虚拟人设置；手动/自动均生效）
  const care = deps.getProactiveCare()
  if (!care.enabled) {
    log.info('[handleTick] 主动联系已关闭, skip')
    return 'skipped: disabled'
  }

  const db = deps.getDb()
  const now = new Date()

  if (!manual) {
    // 3. 免打扰时段（隐藏默认值，不暴露 UI）
    const hour = now.getHours()
    const quietStartHour = parseHour(QUIET_HOURS_START)
    const quietEndHour = parseHour(QUIET_HOURS_END)
    if (isInQuietHours(hour, quietStartHour, quietEndHour)) {
      log.info(`[handleTick] 免打扰时段 hour=${hour}, skip`)
      return 'skipped: quiet hours'
    }

    // 4. 日限额
    const todayCount = readTodayCount(db)
    if (todayCount >= MAX_DAILY_COUNT) {
      log.info(`[handleTick] 日限额已满 count=${todayCount}/${MAX_DAILY_COUNT}, skip`)
      return 'skipped: daily limit'
    }

    // 5. 最小间隔（gentle=4h, active=2h）
    const minIntervalMs = care.mode === 'active' ? 2 * 60 * 60 * 1000 : 4 * 60 * 60 * 1000
    const lastSentAt = readLastSentAt(db)
    if (lastSentAt && Date.now() - lastSentAt < minIntervalMs) {
      log.info(`[handleTick] 间隔未到 minInterval=${minIntervalMs}ms, skip`)
      return 'skipped: too soon'
    }

    // 6. 工作日模式判断（gentle 模式仅工作日触发，active 模式全周期）
    const dayOfWeek = now.getDay()
    if (care.mode === 'gentle' && !GENTLE_WORK_DAYS.has(dayOfWeek)) {
      log.info(`[handleTick] gentle 模式非工作日 day=${dayOfWeek}, skip`)
      return 'skipped: not workday in gentle mode'
    }
  }

  // 7. 生成并发送消息（标题避免使用「AI 伙伴」旧品牌文案）
  const message = generateCareMessage(care.nickname, now)
  try {
    if (deps.showCompanionMessage) {
      deps.showCompanionMessage(message)
    } else if (deps.showNotification) {
      deps.showNotification('宠物消息', message)
    }

    // 记录
    incrementTodayCount(db)
    writeLastSentAt(db, Date.now())
    appendHistory(db, message)

    log.info(`[handleTick] 已发送消息: "${message.slice(0, 60)}"`)
    return `executed: ${message.slice(0, 60)}`
  } catch (err) {
    log.error('[handleTick] 发送消息失败:', err)
    return `error: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ── 记忆整理：fast 按需、deep 强制 ──

/**
 * 整理个人记忆（Markdown 全文）。
 *
 * fast：先用 needsPersonalMemoryConsolidation 做本地体检，只有查出重复/冲突/超长才叫 LLM。
 *       半小时一次的任务不该每次都烧一次模型调用。
 * deep：无条件重写一遍，捞 fast 那套启发式查不出来的陈旧表述。
 */
async function handleMemoryConsolidation(
  deps: LocalCompanionDeps,
  depth: 'fast' | 'deep',
): Promise<string> {
  const { getUserMemory, updateUserMemory, callLLM } = deps
  if (!getUserMemory || !updateUserMemory || !callLLM) {
    return 'skipped: 记忆读写未注入'
  }

  try {
    const existing = (await getUserMemory())?.content ?? ''
    if (!existing.trim()) return 'skipped: 个人记忆为空，无需整理'

    if (depth === 'fast' && !needsPersonalMemoryConsolidation(existing).needed) {
      return 'skipped: 记忆无重复或冲突，跳过整理'
    }

    // consolidateUserMemory 会吞掉 LLM 异常并回退成「无变化」。自己记一笔，
    // 否则模型故障在定时任务页面上会显示成「跳过」，看不出是失败。
    let llmError: unknown
    const result = await consolidateUserMemory({
      existingContent: existing,
      newCandidates: [],
      callLLM: async (prompt) => {
        try {
          return await callLLM(prompt)
        } catch (err) {
          llmError = err
          throw err
        }
      },
      forceConsolidate: true,
    })
    if (llmError) {
      throw llmError
    }
    if (result.rejectionReason === 'shrinkage') {
      return 'skipped: 整理结果缩水过半，已拒绝写入'
    }
    if (!result.merged || result.content.trim() === existing.trim()) {
      return 'skipped: 整理后无变化'
    }

    await updateUserMemory(result.content)
    const delta = existing.length - result.content.length
    log.info(`[handleMemoryConsolidation] ${depth} 完成，字数变化 ${-delta}`)
    return `executed: ${depth === 'fast' ? '轻量' : '深度'}整理完成，${
      delta > 0 ? `精简 ${delta} 字` : `补充 ${-delta} 字`
    }`
  } catch (err) {
    log.error(`[handleMemoryConsolidation] ${depth} 失败:`, err)
    return `error: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ── 辅助函数：时段 ──

/** 解析 "HH:mm" 格式的时间字符串，返回小时数（整数） */
function parseHour(timeStr: string): number {
  const parts = timeStr.split(':')
  const h = parseInt(parts[0] ?? '0', 10)
  return isNaN(h) ? 0 : Math.max(0, Math.min(23, h))
}

function isInQuietHours(hour: number, start: number, end: number): boolean {
  if (start > end) {
    // 跨午夜：例 start=22, end=8 → 22:00 到 08:00 之间（含22点后到次日8点前）
    return hour >= start || hour < end
  }
  // 日间段：例 start=8, end=22 → 08:00 到 22:00 之间
  return hour >= start && hour < end
}

// ── 辅助函数：消息生成 ──

const CARE_MESSAGES: readonly string[] = [
  '嘿，在吗？忙了一会儿，记得喝水休息一下哦~',
  '已经好一会儿没见你了，最近一切都好吗？',
  '有什么我能帮到你的吗？随时叫我 :)',
  '注意休息，长时间盯着屏幕对眼睛不好哦~',
  '你好！有什么新的想法或者任务想和我聊聊吗？',
  '嗨～ 我在这里，有需要随时找我！',
  '提醒一下：该活动活动了，久坐伤身～',
]

/** 根据称呼与当前时间生成主动联系消息文案 */
function generateCareMessage(nickname: string, now: Date): string {
  const hour = now.getHours()
  const greeting = nickname ? `${nickname}，` : ''

  // 基于时段定制问候
  if (hour >= 6 && hour < 10) {
    return `${greeting}早上好！新的一天开始了，今天有什么计划？`
  }
  if (hour >= 11 && hour < 14) {
    return `${greeting}到了午饭时间，记得好好休息吃饭哦~`
  }
  if (hour >= 17 && hour < 19) {
    return `${greeting}快下班了，今天辛苦了！有没有收获或者想聊的？`
  }
  if (hour >= 21) {
    return `${greeting}该休息啦，好好睡一觉明天继续加油！`
  }

  // 随机通用消息
  const index = Math.floor(Math.random() * CARE_MESSAGES.length)
  return `${greeting}${CARE_MESSAGES[index]}`
}

// ── KV 读写：偏好 ──

export function readPrefs(db: DatabaseAdapter): LocalCompanionPrefs {
  try {
    const row = db.prepare<{ value: string }>(
      `SELECT value FROM runtime_state WHERE key = ?`
    ).get(KV_KEY_PREFS) as { value: string } | undefined
    if (!row) return { ...DEFAULT_PREFS }
    return { ...DEFAULT_PREFS, ...JSON.parse(row.value) }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function writePrefs(db: DatabaseAdapter, prefs: Partial<LocalCompanionPrefs>): void {
  const current = readPrefs(db)
  const merged = { ...current, ...prefs }
  const now = new Date().toISOString()
  db.prepare(
    `INSERT OR REPLACE INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)`
  ).run(KV_KEY_PREFS, JSON.stringify(merged), now)
}

// ── KV 读写：日计数 ──

function readTodayCount(db: DatabaseAdapter): number {
  try {
    const row = db.prepare<{ value: string }>(
      `SELECT value FROM runtime_state WHERE key = ?`
    ).get(KV_KEY_DAILY_COUNT) as { value: string } | undefined
    if (!row) return 0
    const parsed = JSON.parse(row.value) as { date: string; count: number }
    const today = new Date().toISOString().slice(0, 10)
    if (parsed.date !== today) return 0
    return parsed.count
  } catch {
    return 0
  }
}

function incrementTodayCount(db: DatabaseAdapter): void {
  const count = readTodayCount(db)
  const today = new Date().toISOString().slice(0, 10)
  const now = new Date().toISOString()
  db.prepare(
    `INSERT OR REPLACE INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)`
  ).run(KV_KEY_DAILY_COUNT, JSON.stringify({ date: today, count: count + 1 }), now)
}

// ── KV 读写：上次发送时间 ──

function readLastSentAt(db: DatabaseAdapter): number | null {
  try {
    const row = db.prepare<{ value: string }>(
      `SELECT value FROM runtime_state WHERE key = ?`
    ).get(KV_KEY_LAST_SENT_AT) as { value: string } | undefined
    if (!row) return null
    return Number(row.value)
  } catch {
    return null
  }
}

function writeLastSentAt(db: DatabaseAdapter, ts: number): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT OR REPLACE INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)`
  ).run(KV_KEY_LAST_SENT_AT, String(ts), now)
}

// ── Cron Job 种子 ──

const COMPANION_CRON_JOBS = [
  {
    id: 'companion-tick',
    name: '桌宠主动关心',
    taskText: '__companion_tick__',
    scheduleExpr: '*/15 * * * *',
  },
  {
    id: 'companion-memory-fast',
    name: '记忆轻量整理',
    taskText: '__companion_memory_fast__',
    scheduleExpr: '*/30 * * * *',
  },
  {
    id: 'companion-memory-deep',
    name: '记忆深度整理',
    taskText: '__companion_memory_deep__',
    scheduleExpr: '0 */6 * * *',
  },
] as const

/**
 * 确保 companion cron jobs 存在于 local_cron_jobs 表中（幂等，每次启动检查）
 *
 * 三条都默认开启。只有 companion-tick 的 enabled 跟随虚拟人设置
 * vhSettings.proactiveCareEnabled —— 那个开关管的是「主动联系」这件事本身；
 * 两条记忆整理任务与它无关，enabled 交给用户在定时任务页自己控制，
 * 启动时不覆盖，否则用户关掉了下次启动又被打开。
 */
export function ensureCompanionCronJobsSeeded(db: DatabaseAdapter): void {
  try {
    const careEnabled = getVirtualHumanSettings().proactiveCareEnabled
    const now = Date.now()
    for (const job of COMPANION_CRON_JOBS) {
      const isTick = job.id === 'companion-tick'
      const existing = db.prepare<{ id: string }>(
        `SELECT id FROM local_cron_jobs WHERE id = ?`
      ).get(job.id) as { id: string } | undefined

      if (!existing) {
        db.prepare(
          `INSERT INTO local_cron_jobs
           (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at)
           VALUES (?, ?, ?, NULL, 'cron', ?, ?, NULL, ?, ?)`
        ).run(
          job.id,
          job.name,
          job.taskText,
          job.scheduleExpr,
          now,
          isTick && !careEnabled ? 0 : 1,
          now,
        )
        log.info(`[ensureCompanionCronJobsSeeded] 新建 job id=${job.id}`)
      } else if (isTick) {
        db.prepare(
          `UPDATE local_cron_jobs SET name = ?, enabled = ? WHERE id = ?`
        ).run(job.name, careEnabled ? 1 : 0, job.id)
      } else {
        // 老库里存的是 companion:memory_fast 这类英文名，补一次中文名；enabled 不动
        db.prepare(`UPDATE local_cron_jobs SET name = ? WHERE id = ?`).run(job.name, job.id)
      }
    }
    log.info(`[ensureCompanionCronJobsSeeded] companion cron jobs 已就绪`)
  } catch (err) {
    log.error('[ensureCompanionCronJobsSeeded] 失败:', err)
  }
}

/**
 * 仅同步主动联系 tick job（companion-tick）的 enabled 状态。
 * memory_fast/memory_deep 不受主动联系开关影响（本地未实现，恒定跳过）。
 */
export function syncCompanionTickJobEnabled(db: DatabaseAdapter, enabled: boolean): void {
  try {
    db.prepare(
      `UPDATE local_cron_jobs SET enabled = ? WHERE id = ?`
    ).run(enabled ? 1 : 0, 'companion-tick')
    log.info(`[syncCompanionTickJobEnabled] enabled=${enabled}`)
  } catch (err) {
    log.error('[syncCompanionTickJobEnabled] 失败:', err)
  }
}

/**
 * 迁移旧版本地 Companion 偏好（local_companion_prefs）到虚拟人设置 vhSettings（幂等，一次性）
 *
 * 规则（见 09 号设计文档 §3 迁移）：
 *   - vhSettings 三项仍为默认值 且 旧偏好存在时才迁移，避免覆盖用户已通过新设置页做出的选择
 *   - enabled = 旧 enabled && mode !== 'off'
 *   - mode：'off' 时用 'gentle' 占位（因 enabled 已为 false，不影响触达）
 *   - nickname 原样迁移
 * 迁移后写入 KV_KEY_MIGRATED 标记，之后不再重复执行。
 */
export function migrateLocalCompanionPrefsToVhSettings(db: DatabaseAdapter): void {
  try {
    const migratedRow = db.prepare<{ value: string }>(
      `SELECT value FROM runtime_state WHERE key = ?`
    ).get(KV_KEY_MIGRATED) as { value: string } | undefined
    if (migratedRow) { return }

    const markMigrated = (): void => {
      const now = new Date().toISOString()
      db.prepare(
        `INSERT OR REPLACE INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)`
      ).run(KV_KEY_MIGRATED, '1', now)
    }

    const currentVh = getVirtualHumanSettings()
    const isStillDefault =
      currentVh.proactiveCareEnabled === DEFAULT_VH_SETTINGS.proactiveCareEnabled
      && currentVh.proactiveCareMode === DEFAULT_VH_SETTINGS.proactiveCareMode
      && currentVh.proactiveCareNickname === DEFAULT_VH_SETTINGS.proactiveCareNickname
    if (!isStillDefault) {
      // 用户已在新设置页配置过，跳过迁移，仅标记
      markMigrated()
      return
    }

    const prefsRow = db.prepare<{ value: string }>(
      `SELECT value FROM runtime_state WHERE key = ?`
    ).get(KV_KEY_PREFS) as { value: string } | undefined
    if (prefsRow) {
      const oldPrefs = { ...DEFAULT_PREFS, ...JSON.parse(prefsRow.value) } as LocalCompanionPrefs
      const enabled = oldPrefs.enabled && oldPrefs.mode !== 'off'
      const mode: 'gentle' | 'active' = oldPrefs.mode === 'active' ? 'active' : 'gentle'
      setVirtualHumanSettings({
        proactiveCareEnabled: enabled,
        proactiveCareMode: mode,
        proactiveCareNickname: oldPrefs.nickname,
      })
      log.info(`[migrateLocalCompanionPrefsToVhSettings] 已迁移: enabled=${enabled} mode=${mode}`)
    }
    markMigrated()
  } catch (err) {
    log.error('[migrateLocalCompanionPrefsToVhSettings] 失败:', err)
  }
}

export { KV_KEY_CRON_SEEDED }

// ── 历史记录读写 ──

function appendHistory(db: DatabaseAdapter, content: string): void {
  try {
    const history = readHistory(db)
    const newEntry: LocalCompanionAction = {
      id: `lc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      content,
      createdAt: new Date().toISOString(),
      feedback: null,
    }
    const updated = [newEntry, ...history].slice(0, MAX_HISTORY)
    const now = new Date().toISOString()
    db.prepare(
      `INSERT OR REPLACE INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)`
    ).run(KV_KEY_HISTORY, JSON.stringify(updated), now)
  } catch (err) {
    log.error('[appendHistory] 写入失败:', err)
  }
}

export function readHistory(db: DatabaseAdapter): LocalCompanionAction[] {
  try {
    const row = db.prepare<{ value: string }>(
      `SELECT value FROM runtime_state WHERE key = ?`
    ).get(KV_KEY_HISTORY) as { value: string } | undefined
    if (!row) return []
    return JSON.parse(row.value) as LocalCompanionAction[]
  } catch {
    return []
  }
}

export function updateHistoryFeedback(
  db: DatabaseAdapter,
  id: string,
  feedback: 'accept' | 'ignore' | 'dismiss',
): void {
  try {
    const history = readHistory(db)
    const updated = history.map(item =>
      item.id === id ? { ...item, feedback } : item
    )
    const now = new Date().toISOString()
    db.prepare(
      `INSERT OR REPLACE INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)`
    ).run(KV_KEY_HISTORY, JSON.stringify(updated), now)
  } catch (err) {
    log.error('[updateHistoryFeedback] 写入失败:', err)
  }
}
