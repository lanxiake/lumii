// @vitest-environment node
/**
 * 清理审计读取：只读最近 N 条、坏行跳过、按时间倒序。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readCleanupHistory } from './workspace-cleanup-history'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'lumii-history-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readCleanupHistory', () => {
  it('没有文件时返回空数组', async () => {
    expect(await readCleanupHistory(dir, 10)).toEqual([])
  })

  it('跨文件按时间倒序，坏行跳过', async () => {
    await writeFile(
      path.join(dir, 'cleanup-20261026.jsonl'),
      [
        JSON.stringify({ at: '2026-10-26T03:00:00.000Z', action: 'trash', path: 'outputs/x/cut-1.png', trigger: 'ttl' }),
        'not json',
      ].join('\n') + '\n',
    )
    await writeFile(
      path.join(dir, 'cleanup-20261027.jsonl'),
      [
        JSON.stringify({ at: '2026-10-27T03:00:00.000Z', action: 'trash', path: 'outputs/y/cut-2.png', trigger: 'quota' }),
      ].join('\n') + '\n',
    )

    const entries = await readCleanupHistory(dir, 10)
    expect(entries.map((entry) => entry.path)).toEqual([
      'outputs/y/cut-2.png',
      'outputs/x/cut-1.png',
    ])
  })

  it('limit 只取最新的几条', async () => {
    const lines = Array.from({ length: 8 }, (_, index) =>
      JSON.stringify({ at: `2026-10-27T03:0${index}:00.000Z`, action: 'trash', path: `p${index}` }),
    )
    await writeFile(path.join(dir, 'cleanup-20261027.jsonl'), lines.join('\n') + '\n')

    const entries = await readCleanupHistory(dir, 3)
    expect(entries).toHaveLength(3)
    expect(entries.map((entry) => entry.path)).toEqual(['p7', 'p6', 'p5'])
  })
})
