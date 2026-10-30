import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendJournal, readJournal, computeResume, writeMeta, readMeta } from './journal'
import type { JournalLine } from './types'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-pipe-journal-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const line = (i: number, id: string, ok = true): JournalLine => ({
  i,
  id,
  tool: 'app_act',
  startedAt: 1000 + i,
  ms: 10,
  ok,
})

describe('journal', () => {
  it('append 3 行后读回，顺序一致、字段完整', () => {
    appendJournal(dir, line(0, 'a'))
    appendJournal(dir, line(1, 'b'))
    appendJournal(dir, line(2, 'c'))
    const { lines, corrupt } = readJournal(dir)
    expect(lines.map((l) => l.id)).toEqual(['a', 'b', 'c'])
    expect(corrupt).toBe(0)
    expect(lines[1]).toMatchObject({ i: 1, tool: 'app_act', startedAt: 1001, ms: 10, ok: true })
  })

  it('末行被截断（半行 JSON）→ 跳过并计 corrupt:1，不抛', () => {
    appendJournal(dir, line(0, 'a'))
    // 模拟崩溃：写一半就被杀
    fs.appendFileSync(path.join(dir, 'journal.jsonl'), '{"i":1,"id":"b","ok":tr')
    const { lines, corrupt } = readJournal(dir)
    expect(lines.map((l) => l.id)).toEqual(['a'])
    expect(corrupt).toBe(1)
  })

  it('resume 跳过集只含 ok===true 的 step id', () => {
    appendJournal(dir, line(0, 'a', true))
    appendJournal(dir, line(1, 'b', false))
    appendJournal(dir, line(2, 'c', true))
    const r = computeResume(dir, 'samehash')
    expect(r.ok).toBe(true)
    if (r.ok) expect([...r.skip].sort()).toEqual(['a', 'c'])
  })

  it('specHash 与 meta 不符 → { ok:false, reason:"spec_changed" }（否则续跑是在撒谎）', () => {
    writeMeta(dir, { runId: 'r1', specId: 's', mode: 'record', specHash: 'oldhash', startedAt: 1 })
    appendJournal(dir, line(0, 'a'))
    const r = computeResume(dir, 'newhash')
    expect(r).toEqual({ ok: false, reason: 'spec_changed' })
  })

  it('specHash 一致时正常给出跳过集', () => {
    writeMeta(dir, { runId: 'r1', specId: 's', mode: 'record', specHash: 'h', startedAt: 1 })
    appendJournal(dir, line(0, 'a'))
    appendJournal(dir, line(1, 'b'))
    const r = computeResume(dir, 'h')
    expect(r.ok).toBe(true)
    if (r.ok) expect([...r.skip].sort()).toEqual(['a', 'b'])
  })

  it('连续 append 不需要串行化队列（appendFileSync 每次调用原子追加）', () => {
    for (let i = 0; i < 50; i++) appendJournal(dir, line(i, `s${i}`))
    const { lines, corrupt } = readJournal(dir)
    expect(lines).toHaveLength(50)
    expect(corrupt).toBe(0)
    expect(lines.map((l) => l.id)).toEqual(Array.from({ length: 50 }, (_, i) => `s${i}`))
  })

  it('空目录 → 空 journal，不抛', () => {
    expect(readJournal(dir)).toEqual({ lines: [], corrupt: 0 })
    expect(computeResume(dir, 'h')).toEqual({ ok: true, skip: new Set() })
  })

  it('meta 读写往返', () => {
    expect(readMeta(dir)).toBeNull()
    writeMeta(dir, { runId: 'r1', specId: 's', mode: 'rehearsal', specHash: 'h', startedAt: 5 })
    expect(readMeta(dir)).toMatchObject({ runId: 'r1', mode: 'rehearsal', specHash: 'h' })
  })
})
