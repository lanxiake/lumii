/**
 * journal.jsonl 的追加 / 读回 / 续跑跳过集（计划 Task 2）。
 *
 * 三条取舍（设计 §5.2 + 计划 Task 2）：
 * - **appendFileSync，不用流**：run 目录生命周期短，流要处理 close/error，收益为零。
 * - **不每行 fsync**：崩溃丢最后一行已被「半行容忍」覆盖，而每步 fsync 在 Windows 上要 5~10ms，
 *   直接吃掉设计 §9.3 的 20ms 预算。
 * - **半行即崩溃遗留**：JSONL 追加写，被杀时最后一行可能截断——读回时跳过并计数，**不抛**。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { JournalLine, RunMeta } from './types'

const JOURNAL_FILE = 'journal.jsonl'
const META_FILE = 'meta.json'

const journalPath = (runDir: string) => path.join(runDir, JOURNAL_FILE)
const metaPath = (runDir: string) => path.join(runDir, META_FILE)

/** 追加一行。目录不存在会先建（run 目录由 store 建，这里兜底）。 */
export function appendJournal(runDir: string, line: JournalLine): void {
  fs.mkdirSync(runDir, { recursive: true })
  fs.appendFileSync(journalPath(runDir), JSON.stringify(line) + '\n', 'utf8')
}

export function readJournal(runDir: string): { lines: JournalLine[]; corrupt: number } {
  let raw: string
  try {
    raw = fs.readFileSync(journalPath(runDir), 'utf8')
  } catch {
    return { lines: [], corrupt: 0 } // 没有 journal 不是错误（首次跑 / 空目录）
  }
  const lines: JournalLine[] = []
  let corrupt = 0
  for (const text of raw.split('\n')) {
    const t = text.trim()
    if (!t) continue
    try {
      lines.push(JSON.parse(t) as JournalLine)
    } catch {
      corrupt++ // 半行 / 损坏行：跳过，不抛
    }
  }
  return { lines, corrupt }
}

export function writeMeta(runDir: string, meta: RunMeta): void {
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(metaPath(runDir), JSON.stringify(meta, null, 2), 'utf8')
}

export function readMeta(runDir: string): RunMeta | null {
  try {
    return JSON.parse(fs.readFileSync(metaPath(runDir), 'utf8')) as RunMeta
  } catch {
    return null
  }
}

export type ResumeResult = { ok: true; skip: Set<string> } | { ok: false; reason: 'spec_changed' }

/**
 * 续跑跳过集。**先校验 specHash 一致**——spec 改了还续跑，等于在新 spec 上假装旧结果有效，
 * 那是「撒谎」（设计 §4.4）。不一致就拒，让调用方决定重跑还是放弃。
 */
export function computeResume(runDir: string, specHash: string): ResumeResult {
  const meta = readMeta(runDir)
  if (meta && meta.specHash !== specHash) return { ok: false, reason: 'spec_changed' }
  const { lines } = readJournal(runDir)
  const skip = new Set<string>()
  for (const l of lines) if (l.ok) skip.add(l.id)
  return { ok: true, skip }
}
