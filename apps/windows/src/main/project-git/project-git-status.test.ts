import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getProjectGitStatus } from './project-git-status'

describe('getProjectGitStatus', () => {
  let repoDir: string

  beforeAll(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lumii-git-test-'))
    execFileSync('git', ['init'], { cwd: repoDir })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir })
    writeFileSync(join(repoDir, 'a.ts'), 'const a = 1\n')
    execFileSync('git', ['add', '.'], { cwd: repoDir })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir })
  })

  afterAll(() => { rmSync(repoDir, { recursive: true, force: true }) })

  it('能识别 git 仓库并返回分支名', async () => {
    const status = await getProjectGitStatus(repoDir)
    expect(status.available).toBe(true)
    expect(status.isRepo).toBe(true)
    expect(status.branch).toBeTruthy()
    expect(status.files).toEqual([])
  })

  it('修改文件后 files 含 M 条目', async () => {
    writeFileSync(join(repoDir, 'a.ts'), 'const a = 2\n')
    const status = await getProjectGitStatus(repoDir)
    const modified = status.files.find(f => f.path === 'a.ts')
    expect(modified).toBeTruthy()
    expect(modified!.worktree).toBe('M')
    writeFileSync(join(repoDir, 'a.ts'), 'const a = 1\n')
  })

  it('新增文件标记为 A（新增/绿色）', async () => {
    writeFileSync(join(repoDir, 'b.ts'), 'const b = 1\n')
    execFileSync('git', ['add', 'b.ts'], { cwd: repoDir })
    const status = await getProjectGitStatus(repoDir)
    const added = status.files.find(f => f.path === 'b.ts')
    expect(added?.index).toBe('A')
    execFileSync('git', ['reset', 'b.ts'], { cwd: repoDir })
    rmSync(join(repoDir, 'b.ts'))
  })

  it('.gitignore 命中的文件标记为 !!（忽略/灰色），且重命名不产生多余条目', async () => {
    writeFileSync(join(repoDir, '.gitignore'), 'ignored.log\n')
    writeFileSync(join(repoDir, 'ignored.log'), 'x\n')
    execFileSync('git', ['add', '.gitignore'], { cwd: repoDir })
    execFileSync('git', ['commit', '-m', 'add gitignore'], { cwd: repoDir })

    execFileSync('git', ['mv', 'a.ts', 'a-renamed.ts'], { cwd: repoDir })
    const status = await getProjectGitStatus(repoDir)

    const ignored = status.files.find(f => f.path === 'ignored.log')
    expect(ignored?.index).toBe('!')
    expect(ignored?.worktree).toBe('!')

    // 重命名只产生一条新路径记录，旧路径（-z 输出里的第二段）不应被误当成状态行
    const renamed = status.files.filter(f => f.path.includes('a.ts') || f.path.includes('a-renamed.ts'))
    expect(renamed.length).toBe(1)
    expect(renamed[0].path).toBe('a-renamed.ts')

    execFileSync('git', ['mv', 'a-renamed.ts', 'a.ts'], { cwd: repoDir })
    execFileSync('git', ['rm', '--cached', '.gitignore'], { cwd: repoDir })
    rmSync(join(repoDir, '.gitignore'), { force: true })
    rmSync(join(repoDir, 'ignored.log'), { force: true })
  })

  it('非 git 目录返回 isRepo false', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'not-git-'))
    try {
      const status = await getProjectGitStatus(tmp)
      expect(status.isRepo).toBe(false)
      expect(status.files).toEqual([])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
