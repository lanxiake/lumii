/**
 * WorkspaceVcs 单元测试 — 真实 isomorphic-git + 临时目录全流程。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { WorkspaceVcs } from './vcs-repo'

describe('WorkspaceVcs', () => {
  let workspaceDir: string
  let vcs: WorkspaceVcs

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtbot-vcs-test-'))
    vcs = new WorkspaceVcs({ workspaceDir })
  })

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true })
  })

  const writeFile = (name: string, content: string) => {
    const abs = path.join(workspaceDir, name)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf-8')
  }
  const readFile = (name: string) => fs.readFileSync(path.join(workspaceDir, name), 'utf-8')

  it('ensureInitialized: 建立仓库与初始提交，幂等', async () => {
    await vcs.ensureInitialized()
    expect(fs.existsSync(path.join(workspaceDir, '.mtbot-vcs', 'HEAD'))).toBe(true)
    expect(fs.existsSync(path.join(workspaceDir, '.gitignore'))).toBe(true)

    const log1 = await vcs.log()
    expect(log1.length).toBe(1)

    // 再次调用不应重复初始化
    await vcs.ensureInitialized()
    const log2 = await vcs.log()
    expect(log2.length).toBe(1)
  })

  it('commit: 有变更才提交，无变更返回 null', async () => {
    await vcs.ensureInitialized()

    writeFile('SOUL.md', '# 初始人格\n')
    const c1 = await vcs.commit({ author: 'user', message: '添加 SOUL' })
    expect(c1).not.toBeNull()
    expect(c1?.author).toBe('user')

    // 无新变更
    const c2 = await vcs.commit({ author: 'agent', message: '空提交尝试' })
    expect(c2).toBeNull()
  })

  it('log: 记录 author / conversationId / runId 元信息', async () => {
    await vcs.ensureInitialized()
    writeFile('a.md', 'v1')
    await vcs.commit({
      author: 'agent',
      message: '自动快照',
      conversationId: 'conv-123',
      runId: 'run-456',
    })

    const entries = await vcs.log({ limit: 1 })
    expect(entries[0].author).toBe('agent')
    expect(entries[0].conversationId).toBe('conv-123')
    expect(entries[0].runId).toBe('run-456')
    expect(entries[0].message).toBe('自动快照')
  })

  it('diffCommits: 计算两版本间的增删与 hunks', async () => {
    await vcs.ensureInitialized()
    writeFile('doc.md', 'line1\nline2\n')
    const c1 = await vcs.commit({ author: 'user', message: 'v1' })

    writeFile('doc.md', 'line1\nline2-changed\nline3\n')
    const c2 = await vcs.commit({ author: 'user', message: 'v2' })

    const diff = await vcs.diffCommits(c1!.oid, c2!.oid, { withHunks: true })
    const docDiff = diff.find((d) => d.filepath === 'doc.md')
    expect(docDiff).toBeDefined()
    expect(docDiff?.status).toBe('modified')
    expect(docDiff?.insertions).toBeGreaterThan(0)
    expect(docDiff?.hunks?.length).toBeGreaterThan(0)
  })

  it('readFileAt: 读取历史版本内容', async () => {
    await vcs.ensureInitialized()
    writeFile('x.md', '旧内容')
    const c1 = await vcs.commit({ author: 'user', message: 'v1' })
    writeFile('x.md', '新内容')
    await vcs.commit({ author: 'user', message: 'v2' })

    const old = await vcs.readFileAt(c1!.oid, 'x.md')
    expect(old).toBe('旧内容')
  })

  it('rollbackTo: 回滚到旧版本，且可逆（备份点可恢复）', async () => {
    await vcs.ensureInitialized()
    writeFile('data.md', 'A')
    const cA = await vcs.commit({ author: 'user', message: 'A' })
    writeFile('data.md', 'B')
    const cB = await vcs.commit({ author: 'user', message: 'B' })
    expect(readFile('data.md')).toBe('B')

    // 回滚到 A
    const result = await vcs.rollbackTo(cA!.oid)
    expect(readFile('data.md')).toBe('A')
    expect(result.restoredOid).toBe(cA!.oid)

    // 可逆：回滚到 B 时刻内容应能恢复
    await vcs.rollbackTo(cB!.oid)
    expect(readFile('data.md')).toBe('B')
  })

  it('statusDiff: 工作区相对 HEAD 的未提交变更', async () => {
    await vcs.ensureInitialized()
    writeFile('s.md', 'base')
    await vcs.commit({ author: 'user', message: 'base' })

    // 未提交修改
    writeFile('s.md', 'base-modified')
    writeFile('new.md', 'brand new')

    const diff = await vcs.statusDiff()
    const paths = diff.map((d) => d.filepath).sort()
    expect(paths).toContain('s.md')
    expect(paths).toContain('new.md')
    expect(diff.find((d) => d.filepath === 'new.md')?.status).toBe('added')
    expect(diff.find((d) => d.filepath === 's.md')?.status).toBe('modified')
  })

  it('hasUncommittedChanges: 正确反映工作区状态', async () => {
    await vcs.ensureInitialized()
    expect(await vcs.hasUncommittedChanges()).toBe(false)
    writeFile('z.md', 'change')
    expect(await vcs.hasUncommittedChanges()).toBe(true)
  })

  it('diffCommits: OID 相同的未改文件不进入结果；默认无 hunks', async () => {
    await vcs.ensureInitialized()
    // 建 80 个稳定文件
    for (let i = 0; i < 80; i++) writeFile(`bulk/f-${i}.txt`, `stable-${i}\n`)
    await vcs.commit({ author: 'user', message: 'bulk' })

    writeFile('only-change.md', 'v1\n')
    const c2 = await vcs.commit({ author: 'user', message: 'one file' })
    writeFile('only-change.md', 'v2\n')
    const c3 = await vcs.commit({ author: 'user', message: 'edit one' })

    const t0 = Date.now()
    const list = await vcs.diffCommits(c2!.oid, c3!.oid, { withHunks: false })
    const ms = Date.now() - t0

    expect(list).toHaveLength(1)
    expect(list[0].filepath).toBe('only-change.md')
    expect(list[0].hunks).toBeUndefined()
    expect(ms).toBeLessThan(2000) // 本地 CI 宽松上限；改造前会远超
  })

  it('diffCommits: withHunks true 时仅变更文件带 hunks', async () => {
    await vcs.ensureInitialized()
    writeFile('a.md', '1\n')
    const c1 = await vcs.commit({ author: 'user', message: 'a' })
    writeFile('a.md', '1\n2\n')
    writeFile('b.md', 'new\n')
    const c2 = await vcs.commit({ author: 'user', message: 'ab' })

    const diff = await vcs.diffCommits(c1!.oid, c2!.oid, { withHunks: true })
    expect(diff.length).toBe(2)
    for (const e of diff) {
      expect(e.hunks?.length).toBeGreaterThan(0)
    }
  })
})
