import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearStaleLock } from './vcs-git-cli'

const tempDirs: string[] = []

function makeLock(dir: string): { lock: string; stderr: string } {
  const lock = path.join(dir, 'index.lock')
  fs.writeFileSync(lock, '')
  // git 在报错里用正斜杠
  return { lock, stderr: `fatal: Unable to create '${lock.replace(/\\/g, '/')}': File exists.` }
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('clearStaleLock', () => {
  it('删除超过阈值的死锁（进程崩溃遗留）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-vcs-lock-'))
    tempDirs.push(dir)
    const { lock, stderr } = makeLock(dir)

    const cleared = clearStaleLock(stderr, Date.now() + 60 * 60 * 1000)

    expect(cleared).toBe(lock.replace(/\\/g, '/'))
    expect(fs.existsSync(lock)).toBe(false)
  })

  it('刚创建的锁不动 —— 否则会撕裂正在写入的 index', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-vcs-lock-'))
    tempDirs.push(dir)
    const { lock, stderr } = makeLock(dir)

    expect(clearStaleLock(stderr)).toBeNull()
    expect(fs.existsSync(lock)).toBe(true)
  })

  it('报错里没有锁路径时什么都不做', () => {
    expect(clearStaleLock('fatal: something else broke')).toBeNull()
  })
})
