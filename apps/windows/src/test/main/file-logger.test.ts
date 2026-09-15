/**
 * 日志文件滚动：主日志与错误日志分文件后的清理规则
 *
 * 两条日志前缀重叠（mtbot- 也匹配 mtbot-error-），一旦主日志的清理把错误日志
 * 也算进自己的 7 个名额，错误日志就会被成批误删——而它恰恰是崩溃复盘时
 * 唯一会被翻出来的东西。这里把「各按各的配额、互不挤占」锁住。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
}))

import { cleanOldLogs } from '../../main/file-logger'

let dir: string

/** 造一个日志文件；mtime 越大表示越新 */
function makeLog(name: string, ageIndex: number): void {
  const file = join(dir, name)
  writeFileSync(file, 'x')
  const t = new Date(Date.now() - ageIndex * 60_000)
  utimesSync(file, t, t)
}

function names(): string[] {
  return readdirSync(dir).toSorted()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumii-log-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('cleanOldLogs', () => {
  it('主日志只保留最新 7 个', () => {
    for (let i = 0; i < 10; i++) makeLog(`mtbot-2026-09-${String(i + 1).padStart(2, '0')}.log`, 10 - i)
    cleanOldLogs(dir)
    expect(names()).toEqual([
      'mtbot-2026-09-04.log',
      'mtbot-2026-09-05.log',
      'mtbot-2026-09-06.log',
      'mtbot-2026-09-07.log',
      'mtbot-2026-09-08.log',
      'mtbot-2026-09-09.log',
      'mtbot-2026-09-10.log',
    ])
  })

  it('错误日志不占主日志的保留名额', () => {
    for (let i = 0; i < 7; i++) makeLog(`mtbot-2026-09-0${i + 1}.log`, 20 - i)
    // 更新时间比主日志都新：若不排除前缀，这些都会被算进主日志的 7 个名额
    for (let i = 0; i < 5; i++) makeLog(`mtbot-error-2026-09-0${i + 1}.log`, 10 - i)

    cleanOldLogs(dir)

    const kept = names()
    expect(kept.filter(f => f.startsWith('mtbot-error-'))).toHaveLength(5)
    expect(kept.filter(f => f.startsWith('mtbot-') && !f.startsWith('mtbot-error-'))).toHaveLength(7)
  })

  it('错误日志按自己的配额（30 个）保留，比主日志久', () => {
    for (let i = 0; i < 35; i++) {
      makeLog(`mtbot-error-2026-08-${String(i + 1).padStart(2, '0')}.log`, 100 - i)
    }
    cleanOldLogs(dir)

    const kept = names()
    expect(kept).toHaveLength(30)
    // 最新的一批留下，最早 5 个被删
    expect(kept).toContain('mtbot-error-2026-08-35.log')
    expect(kept).not.toContain('mtbot-error-2026-08-01.log')
  })

  it('忽略非日志文件', () => {
    makeLog('mtbot-2026-09-01.log', 1)
    writeFileSync(join(dir, 'notes.txt'), 'x')
    writeFileSync(join(dir, 'perf-2026-09-01.jsonl'), 'x')

    cleanOldLogs(dir)

    expect(names()).toEqual(['mtbot-2026-09-01.log', 'notes.txt', 'perf-2026-09-01.jsonl'])
  })

  it('目录不存在时静默返回', () => {
    expect(() => cleanOldLogs(join(dir, 'not-exist'))).not.toThrow()
  })
})
