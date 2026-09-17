/**
 * WorkspaceVcs 单元测试 — 真实 isomorphic-git + 临时目录全流程。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import git from 'isomorphic-git'
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

  it('statusDiff: outputs 下 PDF 纳入变更列表且跳过文本 diff', async () => {
    await vcs.ensureInitialized()
    // 写入伪 PDF 二进制内容
    const pdfRel = path.join('outputs', '合并_同意函.pdf')
    writeFile(pdfRel, '%PDF-1.4 binary\x00\x01\x02 content')

    const diff = await vcs.statusDiff()
    const entry = diff.find((d) => d.filepath.replace(/\\/g, '/') === 'outputs/合并_同意函.pdf')
    expect(entry).toBeDefined()
    expect(entry?.status).toBe('added')
    expect(entry?.truncated).toBe(true)
    expect(entry?.skipReason).toMatch(/二进制/)

    const committed = await vcs.commit({ author: 'agent', message: '产出 PDF' })
    expect(committed).not.toBeNull()
  })

  it('ensureInitialized: 移除误忽略 outputs/ 的 gitignore 规则', async () => {
    fs.writeFileSync(
      path.join(workspaceDir, '.gitignore'),
      'node_modules/\noutputs/\nuploads/**/*.pdf\n',
      'utf-8',
    )
    await vcs.ensureInitialized()
    const gi = fs.readFileSync(path.join(workspaceDir, '.gitignore'), 'utf-8')
    expect(gi).not.toMatch(/^outputs\/?$/m)
    expect(gi).toContain('node_modules/')
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

  it('diffFile: 返回单文件 hunks', async () => {
    await vcs.ensureInitialized()
    writeFile('x.md', 'a\n')
    const c1 = await vcs.commit({ author: 'user', message: '1' })
    writeFile('x.md', 'a\nb\n')
    const c2 = await vcs.commit({ author: 'user', message: '2' })
    const one = await vcs.diffFile(c1!.oid, c2!.oid, 'x.md')
    expect(one.filepath).toBe('x.md')
    expect(one.hunks!.length).toBeGreaterThan(0)
  })

  it('diffFile: 超大文件标记 truncated 且不抛错', async () => {
    await vcs.ensureInitialized()
    const big = 'x'.repeat(600_000) + '\n'
    writeFile('big.txt', big)
    const c1 = await vcs.commit({ author: 'user', message: 'big1' })
    writeFile('big.txt', big + 'y\n')
    const c2 = await vcs.commit({ author: 'user', message: 'big2' })
    const one = await vcs.diffFile(c1!.oid, c2!.oid, 'big.txt')
    expect(one.truncated).toBe(true)
    expect(one.hunks ?? []).toEqual([])
  })

  it('index 被写坏（零填充）时自动重建并正常提交', async () => {
    await vcs.ensureInitialized()
    writeFile('a.md', 'v1')
    await vcs.commit({ author: 'user', message: 'v1' })

    // 模拟进程被强杀留下的零填充 index
    const indexPath = path.join(workspaceDir, '.mtbot-vcs', 'index')
    const size = fs.statSync(indexPath).size
    expect(size).toBeGreaterThan(0)
    fs.writeFileSync(indexPath, Buffer.alloc(size))

    writeFile('a.md', 'v2')
    const commit = await vcs.commit({ author: 'agent', message: 'v2' })
    expect(commit).not.toBeNull()
    expect(await vcs.readFileAt(commit!.oid, 'a.md')).toBe('v2')

    // 历史完整保留，且未残留原子写入的临时文件
    const entries = await vcs.log()
    expect(entries.length).toBe(3)
    const leftovers = fs
      .readdirSync(path.join(workspaceDir, '.mtbot-vcs'))
      .filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('index 被清空时 statusDiff 仍可返回未提交变更', async () => {
    await vcs.ensureInitialized()
    writeFile('s.md', 'base')
    await vcs.commit({ author: 'user', message: 'base' })

    fs.writeFileSync(path.join(workspaceDir, '.mtbot-vcs', 'index'), Buffer.alloc(0))
    writeFile('s.md', 'base-modified')

    const diff = await vcs.statusDiff()
    expect(diff.find((d) => d.filepath === 's.md')?.status).toBe('modified')
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

  // ── 批量暂存（git.add('.')）的安全边界 ──
  //
  // 背景：逐个 add 的代价几乎全在「每次调用重建一遍 index」（实测 2000 文件 9.7s
  // vs 批量 1.3s），改成一次 add('.') 后，工作区快照从 30–80 秒降到秒级。
  // 代价是 add('.') 会走**整个**工作树 —— 包括 .mtbot-vcs 自己，而它只被
  // .gitignore 挡着。下面三个用例守住这条边界。

  const listHead = () => git.listFiles({ ...vcs.getGitParams(), ref: 'HEAD' })

  it('批量暂存不会把 .mtbot-vcs 自身索引进 index', async () => {
    writeFile('a.md', 'hello')
    await vcs.commit({ author: 'user', message: 'init' })

    const files = await listHead()
    expect(files).toContain('a.md')
    // 漏了这条就等于 VCS 把自己的对象库版本化 —— index/refs/objects 全量自引用
    expect(files.some((f) => f.startsWith('.mtbot-vcs/'))).toBe(false)
  })

  it('.gitignore 不再忽略 .mtbot-vcs 时退回逐个路径，仍不自我索引', async () => {
    await vcs.ensureInitialized()
    // 模拟用户把默认规则删掉：批量路径的前置条件不成立
    fs.writeFileSync(path.join(workspaceDir, '.gitignore'), '# 用户清空了规则\n', 'utf-8')
    writeFile('a.md', 'hello')

    await vcs.commit({ author: 'user', message: 'no-default-ignore' })

    const files = await listHead()
    // 回退路径靠 walkWorktreeFiles 硬剪枝，不依赖 .gitignore 内容 —— 这正是留着它的理由
    expect(files).toContain('a.md')
    expect(files.some((f) => f.startsWith('.mtbot-vcs/'))).toBe(false)
  })

  // ── 等长 + 时间戳还原的改写必须被检出 ──
  //
  // 这是 stageAll 坚持按**内容**重算 blob hash 的理由：批量 add 与逐个 add 都实测过，
  // 对这种「size 与 mtime 都看不出变化」的改写仍能检出。
  //
  // 关于 ctime：实测它**只在跨时钟 tick 时**才变 —— 同一 tick 内的「写+还原」
  // 它同样分辨不出（即 git 的 racy-timestamp 问题）。所以不能拿 stat 当
  // 「没变更」的判据（见 vcs-repo.ts 的 stageAll 注释里对短路的取舍说明）。
  it('等长且时间戳被还原的改写，仍能被检出并提交', async () => {
    await vcs.ensureInitialized()
    const abs = path.join(workspaceDir, 'a.md')
    writeFile('a.md', 'AAAA')

    // 先把 mtime 归一到整数毫秒（utimes 回写会被舍入），让后面的「还原」
    // 真的能还原成同一个值 —— 否则测到的只是「mtime 变了」
    const st0 = fs.statSync(abs)
    fs.utimesSync(abs, st0.atime, st0.mtime)
    const ref = fs.statSync(abs)
    await vcs.commit({ author: 'user', message: 'init' })

    fs.writeFileSync(abs, 'ZZZZ') // 等长改写
    fs.utimesSync(abs, ref.atime, ref.mtime) // mtime 还原
    const now = fs.statSync(abs)
    expect(now.size).toBe(ref.size)
    expect(now.mtimeMs).toBe(ref.mtimeMs)
    // 注：ctime 是否变化取决于两次操作是否落在同一个时钟 tick ——
    // 同 tick 内「写+还原」它分辨不出（git 的 racy-timestamp 问题），跨 tick 才会变。
    // 所以这里不断言 ctime，只断言真正要守的东西：内容改写必须被检出。

    const c = await vcs.commit({ author: 'agent', message: '等长改写' })
    expect(c).not.toBeNull()
    expect(await vcs.readFileAt(c!.oid, 'a.md')).toBe('ZZZZ')
  })
})
