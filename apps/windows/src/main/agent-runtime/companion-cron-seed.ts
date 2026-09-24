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

/**
 * 按一个设置值同步某条 companion job 的 `enabled`。
 *
 * ---------------------------------------------------------------------------
 * 为什么**两处都要判**（入口判据 + 这里的 enabled）
 * ---------------------------------------------------------------------------
 * 这里管的是"调度器还要不要每 N 分钟唤醒一次"（省电），
 * 调用方入口那道管的是"此刻用户的意愿"（用户手点任务页也能暂停它）。
 * 只留一道都不够：
 * - 只留 enabled：用户手点暂停后，设置页那个开关就成了摆设（反过来也一样）；
 * - 只留代码判据：这条 job 会永远在任务页显示"运行中"，而它其实什么都不做。
 *
 * ⚠ **启动时也要同步一次**。不同步的话有个真实的坑：设置在关的状态下，
 * 用户手动在任务页把 job 打开 → 被代码判据挡下，而设置里那个开关看着是开的
 * ——两个开关互相打架，谁也说不清哪个算数。代价是任务页那个暂停不再是持久的
 * （与自主进化那几个 job 同一条约定）。
 *
 * 2026-09-24（七期 T7.4）从 `pet-dispatch` 提上来：宠物现在有**两条** job 跟同一个
 * 开关（派发与反思），而它们的同步逻辑一字不差。抄一份的下场是"加第三条时
 * 只改了一处"，症状是那条 job 永远不跟设置走。
 */
export function setCompanionCronJobEnabled(
  db: DatabaseAdapter,
  id: string,
  enabled: boolean,
): void {
  try {
    db.prepare(`UPDATE local_cron_jobs SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id)
    log.info(`[setCompanionCronJobEnabled] id=${id} enabled=${enabled}`)
  } catch (err) {
    log.error(`[setCompanionCronJobEnabled] 失败 id=${id}:`, err)
  }
}
