/**
 * 定时任务来源分类与受管方判定（唯一判定处）。
 *
 * 来源：
 * - system：代码播种的系统任务（seed-*、news-pipeline、wiki-purge-*、companion-*、autonomous-tick、pet-dispatch、pet-sensing）
 * - agent：Agent 自建（agent-self:* 规划器落地 / local-cron-* cron_create 工具）
 * - user：用户在定时任务页手工创建
 *
 * enabled 归属（谁有权改动启停）：
 * - 系统种子与用户任务：用户自管（首启默认开，可在任务页随时关）
 * - companion-tick：跟随「主动联系」开关（vhSettings.proactiveCareEnabled）
 * - autonomous-tick 与 agent-self:*：跟随「自主进化」总开关（runtime_state: autonomous.enabled）
 * - companion-memory-* 与 wiki-purge-broken-refs 不受任何开关覆盖，同用户自管
 * - pet-dispatch：**不跟随自主进化开关**（宠物是独立 Agent，设计 §3.7），用户自管；
 *   第五期 T5.9 有「是否允许宠物主动做事」的开关后再改由它接管
 * - pet-sensing：同上，**而且刻意不跟随「主动联系」开关**——那个开关默认是关的，
 *   跟了就等于整个第四期默认不可见。冒不冒泡由渲染层的 `enableAgentNotice` 再判一道
 */

import { SELF_CRON_ID_PREFIX } from '@mtbot/agent-runtime'

export type CronJobSource = 'system' | 'agent' | 'user'
export type CronJobManagedBy = 'autonomous' | 'companion'

/** 与其它来源前缀不重叠的系统种子精确 id */
const SYSTEM_EXACT_IDS = new Set(['news-pipeline', 'autonomous-tick', 'pet-dispatch', 'pet-sensing'])
const SYSTEM_PREFIXES = ['seed-', 'wiki-purge-', 'companion-']
const AGENT_PREFIXES = [SELF_CRON_ID_PREFIX, 'local-cron-']

export function classifyCronJobSource(id: string): CronJobSource {
  if (SYSTEM_EXACT_IDS.has(id) || SYSTEM_PREFIXES.some((p) => id.startsWith(p))) return 'system'
  if (AGENT_PREFIXES.some((p) => id.startsWith(p))) return 'agent'
  return 'user'
}

/** 启停被外部开关接管的任务；null 表示用户自管 */
export function getCronJobManagedBy(id: string): CronJobManagedBy | null {
  if (id === 'autonomous-tick' || id.startsWith(SELF_CRON_ID_PREFIX)) return 'autonomous'
  if (id === 'companion-tick') return 'companion'
  return null
}

/**
 * 启动时按「存在性播种」重建的任务：删除后下次启动会重新出现。
 * UI 对这些任务隐藏删除入口（暂停才是有效操作）；seed-* 系列有种子哨兵，删掉不会重播，不受此限。
 * 注意 wiki-purge-broken-refs 走 companion 播种（ensureCompanionCronJobsSeeded），
 * 而 wiki-purge-invalid-files 走 seed 哨兵播种——两者前缀相同但重建行为不同。
 */
export function isReseededCronJob(id: string): boolean {
  return (
    id.startsWith('companion-') ||
    id === 'autonomous-tick' ||
    id === 'pet-dispatch' ||
    id === 'pet-sensing' ||
    id === 'wiki-purge-broken-refs'
  )
}
