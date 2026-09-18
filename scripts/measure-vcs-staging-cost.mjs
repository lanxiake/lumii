/**
 * 量真 git 在**真实工作区**上的两条暂存路径 —— 决定要不要保住「全量内容哈希」这条保证。
 *
 * 背景：isomorphic-git 花 20 秒做的事，不只是"慢"，它还**顺带提供了一条保证**：
 * 任何内容改写都被检出（因为它不看 stat，直接重算全部 blob hash）。
 * 真 git 默认走 index 的 stat 缓存 —— 快，但「等长 + utimesSync 还原 mtime」这种改写会漏
 * （vcs-repo.test.ts 有一条用例正是守这个，实测真 git 会挂）。
 *
 * 但真 git 也能全量重算：删掉 index 再 add -A，它就无从比对 stat，只能逐个读文件算 hash。
 * 差别在于**它在子进程里跑**，所以再慢也不冻 UI。
 *
 * 于是问题变成纯成本问题：全量重算要多少毫秒？本脚本给出答案。
 *
 * 安全：备份 index → 测 → 还原。不产生任何提交。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const WS = path.join(os.homedir(), '.lumii', 'workspace')
const GITDIR = path.join(WS, '.mtbot-vcs')
const INDEX = path.join(GITDIR, 'index')
const EXCLUDE = path.join(GITDIR, 'mtbot-vcs-exclude')

// 与 vcs-git-cli.ts 的 excludeRules() 一致
const RULES = [
  '.mtbot-vcs/', 'node_modules/', '.cache/', 'tmp/', 'temp/', '/projects/',
  'nul', 'con', 'aux', 'prn',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
].join('\n') + '\n'

const hadExclude = fs.existsSync(EXCLUDE)
const prevExclude = hadExclude ? fs.readFileSync(EXCLUDE, 'utf-8') : null
fs.writeFileSync(EXCLUDE, RULES, 'utf-8')

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Mtbot', GIT_AUTHOR_EMAIL: 'vcs@mtbot.local',
  GIT_COMMITTER_NAME: 'Mtbot', GIT_COMMITTER_EMAIL: 'vcs@mtbot.local',
  GIT_CONFIG_NOSYSTEM: '1',
}
const GIT = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'commit.gpgsign=false',
  '-c', 'index.version=2', '-c', `core.excludesFile=${EXCLUDE}`,
  `--git-dir=${GITDIR}`, `--work-tree=${WS}`]

// cwd 必须在工作树内：--git-dir/--work-tree 不能替代 cwd，
// 否则 `add -A` 的隐式 pathspec 匹配不到任何东西，静默返回 0（本脚本第一版就踩了这个坑）
const run = (args) => execFileSync('git', [...GIT, ...args], { cwd: WS, env: ENV, encoding: 'utf8', stdio: 'pipe' })
const time = (label, fn) => {
  const t = Date.now()
  let note = ''
  try { note = fn() ?? '' } catch (e) { note = '失败: ' + String(e.stderr || e.message).slice(0, 120) }
  console.log(`  ${label.padEnd(40)} ${String(Date.now() - t).padStart(6)} ms  ${note}`)
}

if (!fs.existsSync(INDEX)) { console.error('index 不存在'); process.exit(1) }
const backup = path.join(os.tmpdir(), `mtbot-index-${Date.now()}`)
fs.copyFileSync(INDEX, backup)
console.log(`工作区：${WS}\n`)

try {
  console.log('=== 有 index（stat 缓存路径，快但会漏等长改写）===')
  time('git add -A', () => { run(['add', '-A']); return '' })
  time('git add -A（第二次，应更快）', () => { run(['add', '-A']); return '' })

  console.log('\n=== 删掉 index 后全量重算（保住保证，代价如下）===')
  fs.rmSync(INDEX, { force: true })
  time('rm index + git add -A', () => {
    run(['add', '-A'])
    const n = run(['ls-files']).trim().split('\n').filter(Boolean).length
    return `${n} 个文件入 index`
  })

  fs.rmSync(INDEX, { force: true })
  time('再跑一次（排除冷缓存因素）', () => { run(['add', '-A']); return '' })

  console.log('\n=== 对照：全量重算 vs stat 路径 的 index 内容 ===')
  const full = run(['ls-files']).trim().split('\n').filter(Boolean)
  fs.copyFileSync(backup, INDEX)
  run(['add', '-A'])
  const cached = run(['ls-files']).trim().split('\n').filter(Boolean)
  const same = full.length === cached.length && full.every((f, i) => f === cached[i])
  console.log(`  全量 ${full.length} 个 / stat ${cached.length} 个 → ${same ? '一致 ✅' : '不一致 ❌'}`)

  const dirty = run(['status', '--porcelain']).trim()
  console.log(`  当前工作区变更条目：${dirty ? dirty.split('\n').length : 0}`)
} finally {
  fs.copyFileSync(backup, INDEX)
  fs.rmSync(backup, { force: true })
  if (hadExclude) fs.writeFileSync(EXCLUDE, prevExclude, 'utf-8')
  else fs.rmSync(EXCLUDE, { force: true })
  console.log('\nindex 与排除文件已还原')
}
