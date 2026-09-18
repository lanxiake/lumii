/**
 * 组合测试：`.mtbot-vcs` 被 .gitignore 忽略 vs 被命令行排除，四种组合各自的结果。
 *
 * 为什么要单独测：上一步实测发现「被忽略」与「被命令行 pathspec 命名」同时成立时，
 * `git add -A -- . :(exclude).mtbot-vcs` 会以退出码 1 失败
 * （The following paths are ignored by one of your .gitignore files: .mtbot-vcs）。
 * 而**默认 .gitignore 本来就含 `.mtbot-vcs/`** —— 如果组合 A 失败，
 * 那么"用命令行 pathspec 保护 .mtbot-vcs"在正常场景下就是不可用的。
 *
 * 这直接决定防线该放在哪一层。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'M', GIT_AUTHOR_EMAIL: 'm@m', GIT_COMMITTER_NAME: 'M', GIT_COMMITTER_EMAIL: 'm@m',
  GIT_CONFIG_NOSYSTEM: '1',
}

function scenario(label, { gitignoreHasRule, cliExclude, excludeFileHasRule }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-combo-'))
  const gitdir = path.join(dir, '.mtbot-vcs')
  const excludeFile = path.join(gitdir, 'exclude')
  fs.mkdirSync(gitdir, { recursive: true })
  fs.writeFileSync(excludeFile, excludeFileHasRule ? '.mtbot-vcs/\n' : '', 'utf-8')

  const git = (args, allowFail) => {
    try {
      return { code: 0, out: execFileSync('git', [
        '-c', 'core.autocrlf=false', '-c', 'index.version=2', `-c`, `core.excludesFile=${excludeFile}`,
        `--git-dir=${gitdir}`, `--work-tree=${dir}`, ...args,
      ], { cwd: dir, env: ENV, encoding: 'utf8', stdio: 'pipe' }) }
    } catch (e) {
      if (!allowFail) throw e
      return { code: e.status ?? -1, out: '', err: String(e.stderr ?? '').trim().split('\n')[0] }
    }
  }

  git(['init', '-q', '-b', 'main'])
  fs.writeFileSync(path.join(dir, '.gitignore'),
    gitignoreHasRule ? '.mtbot-vcs/\n' : '# 用户清空了规则\n', 'utf-8')
  fs.writeFileSync(path.join(dir, 'a.md'), 'x\n')
  fs.mkdirSync(path.join(dir, '.mtbot-vcs', 'objects', 'ab'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.mtbot-vcs', 'objects', 'ab', 'cdef'), 'OBJ\n')

  const args = ['add', '-A', '--', '.', ...(cliExclude ? [' :(exclude).mtbot-vcs'.trim()] : [])]
  const r = git(args, true)
  if (r.code !== 0) {
    console.log(`  ${label}`)
    console.log(`    ❌ 退出码 ${r.code}：${r.err}`)
  } else {
    const staged = git(['diff', '--cached', '--name-only']).out.trim().split('\n').filter(Boolean)
    const leaked = staged.some((f) => f.startsWith('.mtbot-vcs/'))
    console.log(`  ${label}`)
    console.log(`    ${leaked ? '❌ 泄漏' : '✅ 挡住'}：已暂存 [${staged.join(', ')}]`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('.gitignore 与命令行排除的组合（核心问题：A 是否失败）\n')
console.log('【CLI 用 :(exclude) 保护】')
scenario('A. .gitignore 有规则 + CLI 排除（← 正常场景！）', { gitignoreHasRule: true, cliExclude: true, excludeFileHasRule: false })
scenario('B. .gitignore 有规则 + 无 CLI 排除（基线）', { gitignoreHasRule: true, cliExclude: false, excludeFileHasRule: false })
scenario('C. .gitignore 清空 + CLI 排除（← 要防的场景）', { gitignoreHasRule: false, cliExclude: true, excludeFileHasRule: false })
scenario('D. .gitignore 清空 + 无 CLI 排除（灾难：自我索引）', { gitignoreHasRule: false, cliExclude: false, excludeFileHasRule: false })

console.log('\n【改用 core.excludesFile 保护】')
scenario('E. .gitignore 有规则 + excludesFile 有规则', { gitignoreHasRule: true, cliExclude: false, excludeFileHasRule: true })
scenario('F. .gitignore 清空 + excludesFile 有规则（← 要防的场景）', { gitignoreHasRule: false, cliExclude: false, excludeFileHasRule: true })
