/**
 * 探针：用 `GIT_INDEX_FILE` + 原子改名，能否既强制全量重算、又不制造读者空窗？
 *
 * ## 问题回顾
 *
 * 现状靠 `rm index` + `git add -A` 强制按内容重算（保住「等长 + utimesSync 还原 mtime
 * 的改写必须被检出」）。但删 index 有**读者可见的空窗** —— isomorphic-git 的 statusMatrix
 * （版本面板 statusDiff）此刻读不到 index，实测报 internal error。
 * 原实现没这问题：isomorphic-git 用「临时文件 + 改名」原子写 index，读者看不到中间态。
 *
 * ## 另一个候选已被否决
 *
 * `git add -A --renormalize` 检出能力没问题，但**有删除时会 fatal**
 * （`unable to stat 'gone.md'`）—— 它按 `-u` 语义 stat 所有已跟踪文件。
 * 见 probe-vcs-renormalize-semantics.mjs。
 *
 * ## 本方案
 *
 * 把 index 写到**另一个路径**（`GIT_INDEX_FILE=<gitdir>/index.mtbot-tmp`），
 * git 在没有既有 index 的情况下只能逐个读文件重算 hash；完成后把临时文件
 * **原子改名**盖到真 index 上。读者全程看到旧 index，切换是原子的。
 *
 * 必须验：① 等长改写仍被检出（用例同款，且要睡足消除 racy 时序巧合）
 *        ② 新增/修改/删除语义不变 ③ 最终 index 确实生效
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ENV_BASE = {
  ...process.env,
  GIT_AUTHOR_NAME: 'M', GIT_AUTHOR_EMAIL: 'm@m', GIT_COMMITTER_NAME: 'M', GIT_COMMITTER_EMAIL: 'm@m',
  GIT_CONFIG_NOSYSTEM: '1',
}

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-idxfile-'))
  const gitdir = path.join(dir, '.git')
  const run = (args, extraEnv) =>
    execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'index.version=2',
      `--git-dir=${gitdir}`, `--work-tree=${dir}`, ...args],
    { cwd: dir, env: { ...ENV_BASE, ...extraEnv }, encoding: 'utf8', stdio: 'pipe' })
  fs.mkdirSync(gitdir, { recursive: true })
  run(['init', '-q', '-b', 'main'])
  return { dir, gitdir, run }
}

let failed = 0
const check = (name, cond, detail = '') => {
  if (!cond) failed++
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

/** 方案：临时 index 全量重算 + 原子改名 */
function stageViaTempIndex(dir, gitdir, run) {
  const tmp = path.join(gitdir, 'index.mtbot-tmp')
  fs.rmSync(tmp, { force: true })
  run(['add', '-A'], { GIT_INDEX_FILE: tmp })
  fs.renameSync(tmp, path.join(gitdir, 'index'))
}

console.log('=== ① 等长 + mtime 还原的改写能否检出 ===')
{
  const { dir, gitdir, run } = mkRepo()
  const abs = path.join(dir, 'a.md')
  fs.writeFileSync(abs, 'AAAA')
  const s0 = fs.statSync(abs)
  fs.utimesSync(abs, s0.atime, s0.mtime) // 归一到整数毫秒，堵死纳秒逃生口
  const ref = fs.statSync(abs)
  run(['add', '-A']); run(['commit', '-q', '--no-verify', '-m', 'init'])
  // 睡足 1.5 秒：否则 index 写入时刻≈文件 mtime，git 的 racy 规则会顺手重查，探针失去分辨力
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
  fs.writeFileSync(abs, 'ZZZZ')
  fs.utimesSync(abs, ref.atime, ref.mtime)
  const now = fs.statSync(abs)
  check('前置：size 与 mtime 确实未变', now.size === ref.size && now.mtimeMs === ref.mtimeMs)

  stageViaTempIndex(dir, gitdir, run)
  const staged = run(['diff', '--cached', '--name-only'])
  check('检出等长改写', staged.includes('a.md'), JSON.stringify(staged.trim()))
  check('临时文件已清掉', !fs.existsSync(path.join(gitdir, 'index.mtbot-tmp')))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('\n=== ② 新增/修改/删除语义 ===')
{
  const { dir, gitdir, run } = mkRepo()
  fs.writeFileSync(path.join(dir, 'keep.md'), 'K0')
  fs.writeFileSync(path.join(dir, 'mod.md'), 'M0')
  fs.writeFileSync(path.join(dir, 'gone.md'), 'G0')
  run(['add', '-A']); run(['commit', '-q', '--no-verify', '-m', 'base'])

  fs.writeFileSync(path.join(dir, 'new.md'), 'N0')
  fs.writeFileSync(path.join(dir, 'mod.md'), 'M1')
  fs.rmSync(path.join(dir, 'gone.md'))

  stageViaTempIndex(dir, gitdir, run)
  const s = run(['diff', '--cached', '--name-status']).trim().split('\n').filter(Boolean)
  check('新增 A', s.some((l) => l.startsWith('A\tnew.md')), JSON.stringify(s))
  check('修改 M', s.some((l) => l.startsWith('M\tmod.md')))
  check('删除 D', s.some((l) => l.startsWith('D\tgone.md')))
  check('未变文件不进结果', !s.some((l) => l.includes('keep.md')))

  // 提交后工作树应干净 —— 证明最终 index 真的生效
  run(['commit', '-q', '--no-verify', '-m', 'after'])
  const dirty = run(['status', '--porcelain']).trim()
  check('提交后工作树干净（最终 index 生效）', dirty === '', JSON.stringify(dirty.slice(0, 120)))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? '方案可用' : failed + ' 项未通过'}`)
process.exit(failed ? 1 : 0)
