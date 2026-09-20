/**
 * sync 仓库的提交到底贵在哪 —— **直接测**，不推理。
 *
 * ## 为什么写这个
 *
 * 我此前给 `commitSyncRepo` 写的理由是「isomorphic-git 的 commit 要按内容全量
 * 重算 blob hash」。读 `node_modules/isomorphic-git/index.cjs` 后**这个说法站不住**：
 *
 *   - `_commit` 不传 `tree` 时走 `constructTree`，而它只读 index 里的
 *     `mode` / `oid`（`flatFileListToDirectoryStructure(index.entries)`）；
 *   - `GitWalkerIndex` 同样只用 index 元数据；
 *   - `GitIndexManager.acquire` 只读 index 文件本身，dirty 时写回。
 *
 *   **全链路没有一处读工作区文件内容**。真正按内容重算 hash 的是 iso 的 `git.add`。
 *
 * 所以「提交慢」这个归因需要证据。本脚本把「暂存」与「提交」**分开计时**，
 * 在同一个仓库形状上跑 iso / 真 git 四种组合。
 *
 *   node scripts/probe-sync-commit-cost.mjs
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const git = require('isomorphic-git')

// ── 仓库形状：照着真实 sync 仓库造 ───────────────────────────────────────
const SMALL = { count: 1100, bytes: 20 * 1024 }
const MEDIUM = { count: 50, bytes: 1024 * 1024 }
const LARGE = { count: 3, bytes: 10 * 1024 * 1024 }

function makeRepo(root) {
  fs.mkdirSync(root, { recursive: true })
  const run = (args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  run(['init', '-q', '-b', 'main'])
  run(['config', 'core.autocrlf', 'false'])
  run(['config', 'commit.gpgsign', 'false'])
  run(['config', 'gc.auto', '0'])

  const buf = Buffer.alloc(64 * 1024)
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + 7) & 0xff

  let made = 0
  const write = (dir, name, bytes) => {
    const abs = path.join(root, dir, name)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    const parts = Math.ceil(bytes / buf.length)
    const fds = fs.openSync(abs, 'w')
    for (let i = 0; i < parts; i++) fs.writeSync(fds, buf, 0, Math.min(buf.length, bytes - i * buf.length))
    fs.closeSync(fds)
    made++
  }
  for (let i = 0; i < SMALL.count; i++) write('workspace/outputs', `s${i}.bin`, SMALL.bytes)
  for (let i = 0; i < MEDIUM.count; i++) write('workspace/files', `m${i}.bin`, MEDIUM.bytes)
  for (let i = 0; i < LARGE.count; i++) write('workspace/outputs', `l${i}.bin`, LARGE.bytes)
  return made
}

const totalBytes =
  SMALL.count * SMALL.bytes + MEDIUM.count * MEDIUM.bytes + LARGE.count * LARGE.bytes

const ROOT = path.join(os.tmpdir(), 'lumii-probe-sync-commit')
fs.rmSync(ROOT, { recursive: true, force: true })
const WORK = path.join(ROOT, 'work')
const files = makeRepo(WORK)
console.log(`仓库形状：${files} 个文件 / ${(totalBytes / 1048576).toFixed(0)} MB`)
console.log(`  ${SMALL.count} × 20KB + ${MEDIUM.count} × 1MB + ${LARGE.count} × 10MB\n`)

const p = { fs, dir: WORK, gitdir: path.join(WORK, '.git') }
const AUTHOR = { name: 'Lumii CloudSync', email: 'sync@lumii.local' }
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: AUTHOR.name,
  GIT_AUTHOR_EMAIL: AUTHOR.email,
  GIT_COMMITTER_NAME: AUTHOR.name,
  GIT_COMMITTER_EMAIL: AUTHOR.email,
}
const ms = (t) => Number(t) / 1e6

/** 把仓库恢复成「工作区有内容、index 空、无提交」 */
function reset() {
  fs.rmSync(path.join(WORK, '.git', 'index'), { force: true })
  try {
    execFileSync('git', ['update-ref', '-d', 'refs/heads/main'], { cwd: WORK, stdio: 'pipe', env: ENV })
  } catch {
    /* 首次运行时没有这个 ref */
  }
}

const results = []
const REPS = 3

/** 真 git 的公共参数（与 gitArgv 的关键项一致） */
const args = (extra) => [
  '-c', 'core.autocrlf=false', '-c', 'gc.auto=0',
  `--git-dir=${p.gitdir}`, `--work-tree=${p.dir}`,
  ...extra,
]
const gitAdd = () => execFileSync('git', args(['add', '-A']), { cwd: WORK, env: ENV, stdio: 'pipe' })
const gitCommit = (msg) =>
  execFileSync('git', args(['commit', '-q', '--no-verify', '--allow-empty', '-F', '-']), {
    cwd: WORK, input: msg, env: ENV, stdio: ['pipe', 'pipe', 'pipe'],
  })

/**
 * 跑一个组合 REPS 次，返回各自耗时中位数。
 * `add` 传 null 表示 index 已由上一次组合留下、不重新暂存。
 */
async function bench(name, doAdd, doCommit) {
  const adds = []
  const commits = []
  for (let i = 0; i < REPS; i++) {
    reset()
    if (doAdd) {
      const t0 = process.hrtime.bigint()
      await doAdd()
      adds.push(ms(process.hrtime.bigint() - t0))
    }
    const t1 = process.hrtime.bigint()
    await doCommit(name)
    commits.push(ms(process.hrtime.bigint() - t1))
  }
  const med = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null)
  results.push({ name, add: med(adds), commit: med(commits) })
}

const isoAdd = () => git.add({ ...p, filepath: '.' })
const isoCommit = (m) => git.commit({ ...p, message: m, author: AUTHOR })

// A：iso 暂存 + iso 提交 —— 改动前的 sync-large-queue
await bench('A iso add + iso commit', isoAdd, isoCommit)
// B：iso 暂存 + 真 git 提交 —— 本次改动后的 sync-large-queue
await bench('B iso add + git commit', isoAdd, gitCommit)
// C：真 git 暂存 + 真 git 提交 —— 本次改动后的 export 路径
await bench('C git add + git commit', gitAdd, gitCommit)
// D：真 git 暂存 + iso 提交 —— **改动前的 export 路径**（缺的就是这一格）
await bench('D git add + iso commit', gitAdd, isoCommit)

console.log('=== 结果（各 3 次取中位数）===')
console.log('组合                        暂存        提交')
for (const r of results) {
  const add = r.add === null ? '     —  ' : `${r.add.toFixed(0).padStart(6)} ms`
  console.log(`${r.name.padEnd(26)} ${add}  ${r.commit.toFixed(0).padStart(6)} ms`)
}

const get = (n) => results.find((r) => r.name.startsWith(n))
console.log('\n=== 判读 ===')
console.log(`  export 路径      改动前 D ${get('D').commit.toFixed(0)}ms  →  改动后 C ${get('C').commit.toFixed(0)}ms`)
console.log(`  大文件队列路径   改动前 A ${get('A').commit.toFixed(0)}ms  →  改动后 B ${get('B').commit.toFixed(0)}ms`)

fs.rmSync(ROOT, { recursive: true, force: true })
