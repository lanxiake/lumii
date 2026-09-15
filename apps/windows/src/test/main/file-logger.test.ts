/**
 * 日志文件滚动：主日志与错误日志分文件后的清理规则
 *
 * 两条日志前缀重叠（mtbot- 也匹配 mtbot-error-），一旦主日志的清理把错误日志
 * 也算进自己的 7 个名额，错误日志就会被成批误删——而它恰恰是崩溃复盘时
 * 唯一会被翻出来的东西。这里把「各按各的配额、互不挤占」锁住。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
}))

import { cleanOldLogs, fileLogger } from '../../main/file-logger'
import { getLocalDateString } from '../../main/local-time'

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

/** 轮询等文件出现指定文本；写流是异步落盘的，不能立刻断言 */
async function readWhenContains(file: string, needle: string): Promise<string> {
  const deadline = Date.now() + 3000
  let text = ''
  do {
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      text = ''
    }
    if (text.includes(needle)) return text
    await new Promise((resolve) => setTimeout(resolve, 20))
  } while (Date.now() < deadline)
  return text
}

describe('console 拦截', () => {
  /**
   * debug 必须落盘：mempalace 子进程的 stderr 走 console.debug 透传，
   * 2026-09-15 那次「记忆整天写不进去」的根因（backend resolution failed /
   * BackendMismatchError）就只出现在这条通道上——不被拦截时它不进任何文件，
   * 只能靠人手工抓终端。同时它不能污染错误日志：错误日志要能一眼看完。
   */
  it('debug 只进主日志；error 主日志与错误日志都进', async () => {
    const logRoot = mkdtempSync(join(tmpdir(), 'lumii-logger-'))
    const previous = process.env.LUMII_CLIENT_DATA_DIR
    process.env.LUMII_CLIENT_DATA_DIR = logRoot
    try {
      fileLogger.initialize()
      console.debug('[MemPalace MCP] backend resolution failed: BackendMismatchError')
      console.error('[MemPalace] 记忆写入失败: boom')
      fileLogger.destroy() // 结束流，把缓冲刷下去

      const today = getLocalDateString()
      const logDir = join(logRoot, 'logs', 'app')
      const errorText = await readWhenContains(join(logDir, `mtbot-error-${today}.log`), '记忆写入失败')
      const mainText = await readWhenContains(join(logDir, `mtbot-${today}.log`), 'backend resolution failed')

      expect(mainText).toContain('[ERROR] [MemPalace] 记忆写入失败: boom')
      expect(mainText).toContain('[DEBUG] [MemPalace MCP] backend resolution failed: BackendMismatchError')
      // 错误日志只留 ERROR：debug 不进，否则它会被子进程 stderr 淹没
      expect(errorText).toContain('[ERROR] [MemPalace] 记忆写入失败: boom')
      expect(errorText).not.toContain('backend resolution failed')
    } finally {
      if (previous === undefined) delete process.env.LUMII_CLIENT_DATA_DIR
      else process.env.LUMII_CLIENT_DATA_DIR = previous
      rmSync(logRoot, { recursive: true, force: true })
    }
  })
})
