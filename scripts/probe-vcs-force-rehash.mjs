/**
 * 探针：有没有**不删 index** 的等价手段来强制全量重算？
 *
 * ## 为什么必须找替代
 *
 * `stageAllCli` 现在靠 `rm index` + `git add -A` 强制按内容重算（保住「等长 + utimesSync
 * 还原 mtime 的改写必须被检出」）。但删 index 制造了一个**读者可见的空窗**：
 * isomorphic-git 的 statusMatrix（版本面板的 statusDiff）此刻读不到 index，
 * 实测直接报 internal error —— 2026-09-18 日志里的 `[VCS-IPC] statusDiff 失败` 就是它。
 *
 * 原实现没有这个问题：isomorphic-git 用「临时文件 + 改名」原子写 index，
 * 读者永远看不到中间态。删文件破坏了那条原子性。
 *
 * ## 候选
 *
 * 判据必须与 vcs-repo.test.ts 的用例同款：先**把 mtime 归一到整数毫秒**，
 * 消除纳秒精度这个逃生口，再写等长新内容并把 mtime 还原回去。
 * （不归一的话测到的只是「mtime 变了」，是假通过 —— 这个坑踩过一次。）
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

/** @returns 是否检出改写 */
function trial(label, stageArgs, dropIndex) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-renorm-'))
  const gitdir = path.join(dir, '.git')
  const git = (args) =>
    execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'index.version=2',
      `--git-dir=${gitdir}`, `--work-tree=${dir}`, ...args], { cwd: dir, env: ENV, encoding: 'utf8', stdio: 'pipe' })

  fs.mkdirSync(gitdir, { recursive: true })
  git(['init', '-q', '-b', 'main'])
  const abs = path.join(dir, 'a.md')

  fs.writeFileSync(abs, 'AAAA')
  const s0 = fs.statSync(abs)
  fs.utimesSync(abs, s0.atime, s0.mtime) // 归一到整数毫秒
  const ref = fs.statSync(abs)
  git(['add', '-A'])
  git(['commit', '-q', '--no-verify', '-m', 'init'])

  // **必须等一会儿再改**：git 的 racy 判定是「entry.mtime >= index 写入时刻 → 强制重查内容」。
  // 整个用例若在毫秒内跑完，index 写入时刻≈文件 mtime，git 就顺手重查了 —— 于是对照组
  // 也会「检出」，探针失去分辨力（第一版就是这样，三个方案全报 ✅）。
  // 睡足 1.5 秒后，index 时间戳明显晚于文件的还原 mtime，stat 缓存才会被真正信任。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)

  // 等长改写 + mtime 还原
  fs.writeFileSync(abs, 'ZZZZ')
  fs.utimesSync(abs, ref.atime, ref.mtime)
  const now = fs.statSync(abs)
  const sameStat = now.size === ref.size && now.mtimeMs === ref.mtimeMs

  // 记录执行耗时 —— 替代方案若比 rm index 贵太多就没意义
  const t = Date.now()
  if (dropIndex) fs.rmSync(path.join(gitdir, 'index'), { force: true })
  let err = null
  try {
    git(stageArgs)
  } catch (e) {
    err = e
  }
  const ms = Date.now() - t

  let detected = false
  if (!err) {
    try {
      detected = git(['diff', '--cached', '--name-only']).includes('a.md')
    } catch { /* 视作未检出 */ }
  }
  console.log(`  ${label}`)
  console.log(`    前置(size/mtime 未变)=${sameStat ? '✅' : '❌'}  检出=${detected ? '✅' : '❌'}  耗时=${ms}ms` +
    (err ? `  错误: ${String(err.stderr || err.message).slice(0, 80)}` : ''))
  fs.rmSync(dir, { recursive: true, force: true })
  return { detected, ms, sameStat, err: !!err }
}

console.log('不删 index 能否强制全量重算（用例同款：等长 + mtime 还原）\n')
const a = trial('A. rm index + add -A（当前实现）', ['add', '-A'], true)
const b = trial('B. add -A --renormalize', ['add', '-A', '--renormalize'], false)
const c = trial('C. add -A（对照：应漏检）', ['add', '-A'], false)

console.log('\n结论：')
console.log(`  A 检出=${a.detected} (${a.ms}ms)  ← 但删 index 有读者空窗`)
console.log(`  B 检出=${b.detected} (${b.ms}ms)  ← 不删 index，${b.detected ? '可用' : '不可用'}`)
console.log(`  C 检出=${c.detected} (${c.ms}ms)  ← 基线，应为 false`)
process.exit(b.detected && !c.detected ? 0 : 1)
