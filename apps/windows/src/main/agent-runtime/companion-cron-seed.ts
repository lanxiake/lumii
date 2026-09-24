/**
 * companion 魔法指令形态的 cron job：播种与自愈（两个调用点共用）
 *
 * ---------------------------------------------------------------------------
 * 为什么值得单独一个模块
 * ---------------------------------------------------------------------------
 * `autonomous-tick`（自主进化心跳）与 `pet-dispatch`（桌宠派发）各有一条这样的 job，
 * 两边的 SQL 原本是**逐行复制**的：一条 `SELECT id`、一条七字段的形态自愈 `UPDATE`、
 * 一条 `INSERT`。复制出来的东西不会一起改——将来给 `local_cron_jobs` 加一列、
 * 或者把 `schedule_type` 的取值改掉，改了一处忘了另一处**不报错**，
 * 只表现为"那条任务在跑，但什么都没发生"。
 *
 * 差异部分（谁决定 `enabled`、间隔从哪来、日志怎么写）留在各自的调用点，
 * 那些是**语义**差异；这里只收口**形态**：魔法指令的 job 必须是
 * `agent_id = NULL` + `schedule_type = 'every'`。
 *
 * ---------------------------------------------------------------------------
 * 形态为什么必须自愈
 * ---------------------------------------------------------------------------
 * `__evolution_tick__` / `__pet_dispatch__` 是 companion 层的魔法指令，只能由
 * `local-companion-handler.ts` 拦截。若这个 job 被改成 agent 驱动（`agent_id` 非空），
 * cron 会把那串指令当**真实 prompt** 喂给某个 Agent —— 用户会看到模型在认真回答
 * 一句 `__pet_dispatch__`。所以每次启动都把形态拉回来。
 */

import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import { agentRuntimeLog as log } from './bridge-utils'

export interface CompanionCronJobSpec {
  /** job id（也是 companion 拦截名单的键） */
  id: string
  /** 用户可见的任务名 */
  name: string
  /** 魔法指令原文 */
  instruction: string
  /** 派发间隔（毫秒） */
  intervalMs: number
  /** 新建时的 `enabled` */
  enabledOnCreate: number
  /**
   * 已存在时是否**覆盖** `enabled`。省略即不覆盖（尊重用户在任务页的暂停）。
   *
   * 两者的差别是刻意的：自主进化心跳跟随总开关，`enabled` 每次启动强拉回开关值；
   * 宠物还没有那个开关（T5.9 才有），提前替用户决定"关掉"是错的。
   */
  enabledOnReseed?: number
}

/**
 * 播种（不存在时新建）/ 自愈（存在时把形态拉回来）一条 companion cron job。
 *
 * 幂等；失败只记日志不抛——它跑在启动路径上，一条任务建不出来不该让客户端起不来。
 */
export function seedCompanionCronJob(db: DatabaseAdapter, spec: CompanionCronJobSpec): void {
  try {
    const existing = db
      .prepare<{ id: string; enabled: number }>(`SELECT id, enabled FROM local_cron_jobs WHERE id = ?`)
      .get(spec.id)

    if (existing) {
      // 形态强制复位；enabled 按 spec 决定跟不跟（见 enabledOnReseed 的注释）
      db.prepare(
        `UPDATE local_cron_jobs SET enabled = ?, interval_ms = ?, agent_id = NULL,
         schedule_type = 'every', schedule_expr = '',
         active_hour_start = NULL, active_hour_end = NULL, notify_targets = NULL
         WHERE id = ?`,
      ).run(
        spec.enabledOnReseed ?? existing.enabled ?? 1,
        spec.intervalMs,
        spec.id,
      )
      return
    }

    const now = Date.now()
    db.prepare(
      `INSERT INTO local_cron_jobs
       (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at)
       VALUES (?, ?, ?, NULL, 'every', '', ?, ?, ?, ?)`,
    ).run(spec.id, spec.name, spec.instruction, now, spec.intervalMs, spec.enabledOnCreate, now)
    log.info(
      `[seedCompanionCronJob] 新建 job id=${spec.id} intervalMs=${spec.intervalMs} enabled=${spec.enabledOnCreate}`,
    )
  } catch (err) {
    log.error(`[seedCompanionCronJob] 失败 id=${spec.id}:`, err)
  }
}
