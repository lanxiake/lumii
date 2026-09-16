/**
 * 资产体检：机器可判的检查项
 *
 * 「灵栖维护」的巡检此前全靠提示词自觉——每次查哪几项、查到什么程度都由模型现场决定。
 * 这里把**能机械判定**的部分固化成代码：预算、完全重复、序列化残迹、指令式话术残留、
 * 长期未用、空条目、指南漂移。模型只负责它真正擅长的那部分（矛盾、层级错放、措辞归并）
 * 以及把结果讲清楚。
 *
 * 这样分工的理由：机械项用 SQL/正则做是确定性的、零 token 的，模型做则每轮结果不一样；
 * 而判断类项恰恰相反。工具**只报告不修改**——改动类动作仍要用户确认（设计 §6.4）。
 *
 * 不落库、不写文件：产出一份结构化清单交给调用方（Agent），由它决定怎么呈现与是否写报告。
 */

import type { DatabaseAdapter } from '@mtbot/agent-runtime'

/** 偏好层的注入预算（字符）：与 bridge-prompt-composer 的截断口径一致 */
export const PROFILE_BUDGET_CHARS = 2400

/** 长期未用的判定线 */
export const STALE_DAYS = 30

export type CheckStatus = 'ok' | 'issue' | 'skipped'

export interface CheckCandidate {
  /** 可点名的对象 id（记忆条目 id / 章节名），让报告能落到具体东西上 */
  readonly id: string
  /** 给用户看的一行 */
  readonly label: string
}

export interface CheckResult {
  /** 跨期稳定的问题标识，与 maintenance_report_write 的 findings[].key 同源 */
  readonly key: string
  readonly title: string
  readonly status: CheckStatus
  /** 结论一句话（ok 也要给——「查过了，没事」同样是信息） */
  readonly detail: string
  readonly candidates?: readonly CheckCandidate[]
}

export interface MemoryRow {
  readonly id: string
  readonly agent_id: string
  readonly category: string
  readonly content: string
  readonly importance: number
  readonly created_at: string
  readonly last_used: string
  readonly is_archived: number
}

/** 偏好层读取（由平台注入口，便于单测替身） */
export interface AssetCheckupDeps {
  readonly db: DatabaseAdapter
  /** 读 user-memory.md 全文；文件不存在返回 null */
  readonly readUserMemory: () => Promise<string | null>
  /** 当前时刻（单测注入固定值） */
  readonly now?: () => number
}

function daysSince(iso: string, now: number): number | null {
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return null
  return Math.floor((now - ts) / 86_400_000)
}

/** 提取 `## ` 章节标题 */
function sectionsOf(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((line) => /^##\s+\S/.test(line))
    .map((line) => line.replace(/^##\s+/, '').trim())
}

/**
 * 偏好层：注入预算与章节结构。
 *
 * 超预算是**第一优先级**：每轮对话都按 2400 字符截断注入，超出部分用户与 Agent 都看不到，
 * 但写的时候没人会注意到。
 */
function checkProfileBudget(markdown: string | null): CheckResult {
  const key = 'memory:profile-budget'
  if (markdown === null) {
    return { key, title: '偏好层注入预算', status: 'skipped', detail: 'user-memory.md 尚未创建' }
  }
  const chars = markdown.length
  const sections = sectionsOf(markdown)
  const emptySections = sections.filter((name) => {
    const idx = markdown.indexOf(`## ${name}`)
    const rest = markdown.slice(idx + name.length + 3)
    const body = rest.split(/\n##\s/)[0] ?? ''
    return body.replace(/<!--[\s\S]*?-->/g, '').trim().length === 0
  })

  if (chars > PROFILE_BUDGET_CHARS) {
    return {
      key,
      title: '偏好层注入预算',
      status: 'issue',
      detail: `实测 ${chars} 字符，超出 ${PROFILE_BUDGET_CHARS} 预算 ${chars - PROFILE_BUDGET_CHARS} 字——超出部分每轮都读不到`,
      candidates: emptySections.map((name) => ({ id: `section:${name}`, label: `空章节：${name}` })),
    }
  }
  return {
    key,
    title: '偏好层注入预算',
    status: emptySections.length > 0 ? 'issue' : 'ok',
    detail:
      emptySections.length > 0
        ? `${chars}/${PROFILE_BUDGET_CHARS} 字符在预算内，但有 ${emptySections.length} 个空章节`
        : `${chars}/${PROFILE_BUDGET_CHARS} 字符在预算内，${sections.length} 个章节均有内容`,
    ...(emptySections.length > 0
      ? { candidates: emptySections.map((name) => ({ id: `section:${name}`, label: `空章节：${name}` })) }
      : {}),
  }
}

/** 工作记忆：内容完全相同的条目（规范化空白后逐字相同） */
function checkWorkingDuplicates(rows: readonly MemoryRow[]): CheckResult {
  const key = 'memory:working-duplicates'
  const byContent = new Map<string, MemoryRow[]>()
  for (const row of rows) {
    const norm = row.content.replace(/\s+/g, ' ').trim()
    if (!norm) continue
    const list = byContent.get(norm) ?? []
    list.push(row)
    byContent.set(norm, list)
  }
  const dupes = [...byContent.values()].filter((l) => l.length > 1)
  if (dupes.length === 0) {
    return {
      key,
      title: '工作记忆完全重复',
      status: 'ok',
      detail: `${rows.length} 条活跃条目，无内容完全相同的重复`,
    }
  }
  return {
    key,
    title: '工作记忆完全重复',
    status: 'issue',
    detail: `${dupes.length} 组内容完全相同的条目（共 ${dupes.reduce((n, l) => n + l.length, 0)} 条）`,
    candidates: dupes.flatMap((l) =>
      l.map((row, i) => ({
        id: row.id,
        label: `${i === 0 ? '保留候选' : '重复'}：${row.content.slice(0, 40)}…（${row.agent_id}）`,
      })),
    ),
  }
}

/** 工作记忆：JSON 序列化残迹（提取链路把 JSON 片段截进了正文） */
function checkJsonResidue(rows: readonly MemoryRow[]): CheckResult {
  const key = 'memory:json-residue'
  const hit = rows.filter((row) => /["!\]}]{2,}\s*$/.test(row.content.trim()))
  if (hit.length === 0) {
    return { key, title: '记忆正文 JSON 残迹', status: 'ok', detail: '未发现以 JSON 片段结尾的条目' }
  }
  return {
    key,
    title: '记忆正文 JSON 残迹',
    status: 'issue',
    detail: `${hit.length} 条正文以 "}] / !}] 之类的 JSON 片段结尾，提取时被截入`,
    candidates: hit.map((row) => ({ id: row.id, label: `${row.content.slice(0, 40)}…` })),
  }
}

/** 工作记忆：指令式话术残留（本该是用户偏好，却以指令句存在工作记忆里） */
function checkInstructionResidue(rows: readonly MemoryRow[]): CheckResult {
  const key = 'memory:instruction-residue'
  const pattern = /只回复|请?只(?:要)?回答|回复[「"']?好|不要回复|已了解/
  const hit = rows.filter((row) => pattern.test(row.content))
  if (hit.length === 0) {
    return { key, title: '指令式话术残留', status: 'ok', detail: '未发现「只回复…」这类测试/注入样式的条目' }
  }
  return {
    key,
    title: '指令式话术残留',
    status: 'issue',
    detail: `${hit.length} 条含指令式话术，若被注入后续会话可能压制真实回复`,
    candidates: hit.map((row) => ({ id: row.id, label: `${row.content.slice(0, 40)}…` })),
  }
}

/** 工作记忆：长期未用且低重要度 */
function checkStale(rows: readonly MemoryRow[], now: number): CheckResult {
  const key = 'memory:stale'
  const hit = rows.filter((row) => {
    const days = daysSince(row.last_used || row.created_at, now)
    return days !== null && days > STALE_DAYS && row.importance < 0.5
  })
  if (hit.length === 0) {
    return {
      key,
      title: `长期未用（>${STALE_DAYS} 天且低重要度）`,
      status: 'ok',
      detail: `无超过 ${STALE_DAYS} 天未用且重要度低于 0.5 的条目`,
    }
  }
  return {
    key,
    title: `长期未用（>${STALE_DAYS} 天且低重要度）`,
    status: 'issue',
    detail: `${hit.length} 条超过 ${STALE_DAYS} 天未被使用且重要度偏低`,
    candidates: hit
      .slice(0, 20)
      .map((row) => ({ id: row.id, label: `${row.content.slice(0, 40)}…（${row.last_used.slice(0, 10)}）` })),
  }
}

/** 工作记忆：空/极短条目（多为提取噪声） */
function checkTinyRows(rows: readonly MemoryRow[]): CheckResult {
  const key = 'memory:tiny-entries'
  const hit = rows.filter((row) => row.content.replace(/\s+/g, '').length < 6)
  if (hit.length === 0) {
    return { key, title: '过短条目', status: 'ok', detail: '无少于 6 字的条目' }
  }
  return {
    key,
    title: '过短条目',
    status: 'issue',
    detail: `${hit.length} 条正文不足 6 字，多半是提取噪声`,
    candidates: hit.map((row) => ({ id: row.id, label: JSON.stringify(row.content.slice(0, 20)) })),
  }
}

export interface AssetCheckupResult {
  readonly scope: 'memory'
  readonly checks: readonly CheckResult[]
  readonly issueCount: number
  readonly checkedCount: number
  /** 概览一句话 */
  readonly summary: string
}

/**
 * 跑一轮记忆体检的机械部分。
 *
 * 只读：不写库、不改文件。改动类动作（删重复、改偏好层）由用户在会话里确认后另行执行。
 */
export async function runMemoryCheckup(deps: AssetCheckupDeps): Promise<AssetCheckupResult> {
  const now = deps.now?.() ?? Date.now()
  const markdown = await deps.readUserMemory()
  const rows = deps.db
    .prepare<MemoryRow>(
      `SELECT id, agent_id, category, content, importance, created_at, last_used, is_archived
       FROM agent_memories
       WHERE is_archived = 0 AND deleted_at IS NULL
       ORDER BY created_at DESC`,
    )
    .all()

  const checks: CheckResult[] = [
    checkProfileBudget(markdown),
    checkWorkingDuplicates(rows),
    checkJsonResidue(rows),
    checkInstructionResidue(rows),
    checkStale(rows, now),
    checkTinyRows(rows),
  ]
  const issues = checks.filter((c) => c.status === 'issue')
  const ran = checks.filter((c) => c.status !== 'skipped')
  return {
    scope: 'memory',
    checks,
    issueCount: issues.length,
    checkedCount: ran.length,
    summary:
      issues.length === 0
        ? `记忆体检：${ran.length} 项机械检查均未发现问题（活跃条目 ${rows.length} 条）`
        : `记忆体检：${ran.length} 项机械检查命中 ${issues.length} 项（活跃条目 ${rows.length} 条）`,
  }
}
