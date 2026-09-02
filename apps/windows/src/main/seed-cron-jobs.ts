/**
 * 预置定时任务播种
 *
 * 这些任务是「直接可用、入库的真实任务」，不是表单预填模版：首启写入 local_cron_jobs，
 * 用户在定时任务页看到即可开关、编辑、删除。
 *
 * 默认全部开启：装完即用，用户不必逐条打开才发现能干什么。不想要的自己关掉或删掉。
 *
 * 幂等策略沿用 news-store 的 ensureNewsCronJobSeeded：
 * 每条任务一个 runtime_state 哨兵键，用户删掉后不会被下次启动重新种回来。
 */

import type { DatabaseAdapter } from '@mtbot/agent-runtime'

const log = {
  info: (...a: unknown[]) => console.log('[SeedCronJobs]', ...a),
  error: (...a: unknown[]) => console.error('[SeedCronJobs]', ...a),
}

/** 默认执行 Agent：内置 assistant，ID 稳定 */
export const DEFAULT_AGENT_ID = 'assistant'

interface SeedJob {
  id: string
  name: string
  /** 每次触发发给 Agent 的自然语言任务指令 */
  taskText: string
  /** 完整系统提示词，执行时拼在任务指令之前 */
  systemPrompt?: string
  /** 执行 Agent。null 表示不驱动 Agent —— 走 companion 拦截通道（如桌宠主动关心/记忆整理） */
  agentId?: string | null
  /** 默认开启。个别任务想默认关闭时显式写 false */
  enabled?: boolean
  /** 旧版本用过的 runtime_state 哨兵键，迁移进来的任务要一并识别 */
  legacySeededKey?: string
  scheduleType: 'cron' | 'every'
  scheduleExpr: string
  intervalMs?: number
  /** 生效星期 "0,1,..,6"（0=周日）；空表示每天 */
  activeDays?: string
  activeHourStart?: number
  activeHourEnd?: number
  notifyTargets: string
}

/**
 * 资讯抓取任务的指令文案，同时供预置 cron 任务和概览页「立即抓取」手动按钮复用，
 * 保证两条触发路径（定时 / 手动）驱动 Agent 的方式完全一致。
 */
export const NEWS_PIPELINE_TASK_TEXT =
  '搜索今天值得关注的热门资讯（优先 IT之家、少数派等中文科技媒体），整理 10-15 条，' +
  '每条包含标题、2-3 句话的正文摘要（交代清楚事件是什么、有什么值得关注的点）、来源、链接，' +
  '并写一段不超过 120 字的整体综述，调用 dashboard_feed_write 工具写入概览页资讯卡片（标题「最近资讯」）。'

export const NEWS_PIPELINE_SYSTEM_PROMPT = [
  '你在为概览页生成「最近资讯」卡片，这是结构化数据源，不是普通对话回复：',
  '1. 用 web_search 搜索今天的科技资讯，优先中文科技媒体（IT之家、少数派等）；',
  '2. 挑选 10-15 条有实质信息量的条目，逐条给出：标题、2-3 句话的正文摘要、来源站点、原文链接。',
  '   正文摘要要像新闻导语一样交代清楚事件本身与看点，不要只写一个短语；',
  '3. 最后写一段不超过 120 字的整体综述，点出这批资讯里最值得关注的 1-2 个趋势；',
  '4. 必须调用 dashboard_feed_write 工具把结果写入卡片（每条的 summary 字段放正文摘要）—— 只在对话里回复文本不会显示在概览页上。',
  '搜索失败或没有找到有效资讯时，不要编造条目，也不要调用 dashboard_feed_write。',
].join('\n')

const SEED_JOBS: readonly SeedJob[] = [
  {
    // 概览页「最近资讯」的数据来源。沿用旧 id，老库里已有这条就不会重复种。
    id: 'news-pipeline',
    name: '资讯抓取与综述',
    taskText: NEWS_PIPELINE_TASK_TEXT,
    systemPrompt: NEWS_PIPELINE_SYSTEM_PROMPT,
    agentId: DEFAULT_AGENT_ID,
    scheduleType: 'cron',
    /** 每 2 小时整点抓一次：资讯源本身更新频率有限，再密只是白跑 */
    scheduleExpr: '0 */2 * * *',
    // silent：Agent 已通过 dashboard_feed_write 直接写好资讯卡片，
    // 不能再用 'news' 让派发器把 Agent 原始回复当成一条资讯重复塞进卡片顶部
    notifyTargets: 'silent',
    // 旧的 ensureNewsCronJobSeeded 用的哨兵键。用户在老版本删过这条任务，升级后不该复活。
    legacySeededKey: 'workflow:news:seeded',
  },
  {
    id: 'seed-morning-briefing',
    name: '早间简报',
    taskText: '汇总我今天需要关注的事项，生成一份早间简报。',
    systemPrompt: [
      '你在为用户生成每日早间简报。请按下面的顺序组织内容，全文控制在 300 字内：',
      '1. 今天的日期与星期；',
      '2. 从记忆中取出用户近期在推进的事项，挑出今天最该动手的 2-3 件，各一句话；',
      '3. 若有明确的截止时间或约定时间，单独列出；',
      '4. 结尾一句简短的开场提示，不要说教、不要客套。',
      '没有可用信息的段落直接省略，不要编造事项，也不要输出「暂无数据」这类占位内容。',
    ].join('\n'),
    scheduleType: 'cron',
    scheduleExpr: '30 8 * * 1,2,3,4,5',
    activeDays: '1,2,3,4,5',
    notifyTargets: 'system,focus',
  },
  {
    id: 'seed-daily-report',
    name: '工作日报整理',
    taskText: '整理我今天的工作进度，生成一份简短日报。',
    systemPrompt: [
      '你在帮用户整理当天工作日报。请输出三段，全文不超过 400 字：',
      '「今天完成」——具体做完的事，一条一行，动词开头；',
      '「进行中」——已开始但没收尾的事，各标注卡在哪一步；',
      '「明天优先」——最多 3 条，按重要性排序。',
      '只依据记忆与会话里真实出现过的信息，宁可少写也不要推测。',
      '不要加标题、寒暄和总结性评价。',
    ].join('\n'),
    scheduleType: 'cron',
    scheduleExpr: '0 18 * * 1,2,3,4,5',
    activeDays: '1,2,3,4,5',
    notifyTargets: 'system,focus',
  },
  {
    id: 'seed-weekly-review',
    name: '每周复盘',
    taskText: '汇总本周完成的事项、遗留问题和下周计划，生成一份复盘。',
    systemPrompt: [
      '你在帮用户做每周复盘。请输出四段，全文不超过 600 字：',
      '「本周产出」——按主题归并，不要逐日罗列；',
      '「卡住的地方」——写清阻塞原因，而不只是现象；',
      '「值得留下的判断」——本周做过的关键取舍，各一句；',
      '「下周计划」——最多 5 条，可执行、有明确产出。',
      '基于记忆中本周的真实记录来写，信息不足的段落如实说明缺什么，不要凑数。',
    ].join('\n'),
    scheduleType: 'cron',
    scheduleExpr: '0 17 * * 5',
    activeDays: '5',
    notifyTargets: 'system,focus',
  },
  {
    id: 'seed-focus-check',
    name: '专注提醒',
    taskText: '提醒我确认当前最重要的一件事。',
    systemPrompt: [
      '你在做一次轻量的专注提醒。只输出一到两句话，不超过 50 字：',
      '结合用户近期在推进的事项，提示他确认此刻手上的事是否就是最该做的那件。',
      '语气平和、不催促、不说教，不要提问式追问，不要列清单。',
    ].join('\n'),
    scheduleType: 'every',
    scheduleExpr: String(2 * 60 * 60 * 1000),
    intervalMs: 2 * 60 * 60 * 1000,
    activeDays: '1,2,3,4,5',
    activeHourStart: 10,
    activeHourEnd: 18,
    notifyTargets: 'system',
    // 默认关闭：与其它预置任务不同，这条每 2 小时就触发一次，
    // 容易让用户觉得「这应用怎么老弹东西」，装好后由用户自己按需打开。
    enabled: true,
  },
  {
    id: 'seed-workspace-tidy',
    name: '工作区文件整理',
    taskText: '检查工作区里新增的文件，按类型归类并指出可以清理的内容。',
    systemPrompt: [
      '你在帮用户整理本地工作区。请：',
      '1. 列出最近新增或修改的文件，按用途归类（文档 / 代码 / 数据 / 临时产物）；',
      '2. 指出明显可以清理的内容（重复文件、空文件、过期临时产物），说明判断依据；',
      '3. 给出建议的归档位置。',
      '只做检查和建议，不要实际移动或删除任何文件 —— 清理由用户确认后自己执行。',
      '全文不超过 400 字，没有发现可整理的内容就直接说明。',
    ].join('\n'),
    scheduleType: 'cron',
    scheduleExpr: '0 20 * * 0',
    activeDays: '0',
    notifyTargets: 'system',
  },
]

function seededKey(jobId: string): string {
  return `cron:seeded:${jobId}`
}

/** 计算首次 next_run_at。cron 类由 croner 按表达式接管，这里给个合理初值即可 */
function initialNextRunAt(job: SeedJob, now: number): number {
  return job.scheduleType === 'every' ? now + (job.intervalMs ?? 0) : now
}

/**
 * 确保预置定时任务已入库（幂等，每次启动检查）。
 *
 * 已存在同 ID 记录 → 跳过（用户可能改过配置，不覆盖）；
 * 哨兵键已置位 → 跳过（用户删过这条任务，不再种回）。
 */
export function ensureSeedCronJobsSeeded(db: DatabaseAdapter): void {
  const now = Date.now()
  migrateLegacyNewsPipeline(db)
  migrateRemovedWikiEroExtractCron(db)
  for (const job of SEED_JOBS) {
    try {
      const existing = db
        .prepare<{ id: string }>(`SELECT id FROM local_cron_jobs WHERE id = ?`)
        .get(job.id)
      if (existing) {
        markSeeded(db, job.id)
        continue
      }
      // 命中任一哨兵键都算种过。legacySeededKey 用于接管旧版本自己那套键，
      // 否则用户当年删掉的资讯任务会在升级后被重新种回来。
      const sentinels = [seededKey(job.id), ...(job.legacySeededKey ? [job.legacySeededKey] : [])]
      const seeded = sentinels.some((key) =>
        db.prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`).get(key),
      )
      if (seeded) continue

      db.prepare(
        `INSERT INTO local_cron_jobs
         (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at,
          active_days, active_hour_start, active_hour_end, system_prompt, notify_targets)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        job.id,
        job.name,
        job.taskText,
        job.agentId === null ? null : (job.agentId ?? DEFAULT_AGENT_ID),
        job.scheduleType,
        job.scheduleExpr,
        initialNextRunAt(job, now),
        job.intervalMs ?? null,
        job.enabled === false ? 0 : 1,
        now,
        job.activeDays ?? null,
        job.activeHourStart ?? null,
        job.activeHourEnd ?? null,
        job.systemPrompt ?? null,
        job.notifyTargets,
      )
      markSeeded(db, job.id)
      log.info(`已种入预置定时任务 id=${job.id}（${job.enabled === false ? '默认关闭' : '默认开启'}）`)
    } catch (err) {
      log.error(`种入预置定时任务失败 id=${job.id}:`, err)
    }
  }
}

function markSeeded(db: DatabaseAdapter, jobId: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO runtime_state (key, value, updated_at) VALUES (?, '1', ?)`,
  ).run(seededKey(jobId), new Date().toISOString())
}

/**
 * 就地修正老库里的资讯任务，覆盖两种历史状态（不新建/不删除，保留用户改过的调度/开关）：
 * 1) 最早版本：agent_id=null + 魔法指令 `__lumii_workflow__:news`，去魔法指令后会走空指令降级 →
 *    改写成 Agent 驱动新定义。
 * 2) 中间版本：已是 Agent 驱动但 notify_targets 仍是 'news'，导致派发器把 Agent 原始回复
 *    当成一条资讯重复塞进卡片顶部（概览页出现「资讯抓取与综述/来源:定时任务」的脏卡片）→
 *    把 notify_targets 改为 'silent'。
 * 只在命中这两种「系统预置特征」时才动，用户手改成别的 taskText 的不碰。
 */
/**
 * 移除已下线的 Wiki 实体关系抽取定时任务（老用户升级后自动清理）。
 */
function migrateRemovedWikiEroExtractCron(db: DatabaseAdapter): void {
  try {
    const result = db.prepare(`DELETE FROM local_cron_jobs WHERE id = 'wiki-ero-extract'`).run()
    if (result.changes > 0) {
      log.info('[migrateRemovedWikiEroExtractCron] 已移除 Wiki 实体关系抽取定时任务')
    }
  } catch (err) {
    log.error('[migrateRemovedWikiEroExtractCron] 迁移失败:', err)
  }
}

function migrateLegacyNewsPipeline(db: DatabaseAdapter): void {
  try {
    const row = db
      .prepare<{ task_text: string; agent_id: string | null; notify_targets: string | null }>(
        `SELECT task_text, agent_id, notify_targets FROM local_cron_jobs WHERE id = 'news-pipeline'`,
      )
      .get()
    if (!row) return

    // 状态 1：魔法指令老数据 → 整体改写成 Agent 驱动 + silent
    if (row.agent_id === null && row.task_text.startsWith('__lumii_workflow__:')) {
      db.prepare(
        `UPDATE local_cron_jobs SET task_text = ?, system_prompt = ?, agent_id = ?, notify_targets = 'silent' WHERE id = 'news-pipeline'`,
      ).run(NEWS_PIPELINE_TASK_TEXT, NEWS_PIPELINE_SYSTEM_PROMPT, DEFAULT_AGENT_ID)
      log.info('[migrateLegacyNewsPipeline] 已将旧资讯任务从魔法指令升级为 Agent 驱动')
      return
    }

    // 状态 2：中间版本 notify_targets 还是 'news'，会重复塞脏卡片 → 收敛为 silent
    if (row.notify_targets === 'news') {
      db.prepare(`UPDATE local_cron_jobs SET notify_targets = 'silent' WHERE id = 'news-pipeline'`).run()
      log.info('[migrateLegacyNewsPipeline] 已将资讯任务 notify_targets 从 news 收敛为 silent')
    }
  } catch (err) {
    log.error('[migrateLegacyNewsPipeline] 迁移失败:', err)
  }
}

/** 仅供单测：断言「入库条数 == 定义条数」需要拿到定义本身 */
export const __testables = { SEED_JOBS, seededKey }
