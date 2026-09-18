/**
 * 探针：isomorphic-git 与真 git 能否安全共用同一个仓库？
 *
 * 背景：要把 workspace VCS 的热路径（add -A + commit）从 isomorphic-git 换成真 git
 * 子进程（20s → ~0.1s，且不占主线程），但 log/readBlob/diff/rollback 仍留在 isomorphic-git。
 * 风险点是两者对 index 格式的读写是否互通。
 *
 * 判据（全部必须通过）：
 *  1. isomorphic-git 初始化 + 提交后，真 git status 认它（无"全部已修改"的假阳性）
 *  2. 真 git add -A + commit 后，isomorphic-git 能读回 HEAD / log / statusMatrix
 *  3. 真 git 写出的 index 版本号是 2（isomorphic-git 只支持 v2）
 *  4. 混合若干轮后双方仍一致
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const git = require('isomorphic-git')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-interop-'))
const gitdir = path.join(dir, '.mtbot-vcs')
const base = { fs, dir, gitdir }

const ok = []
const bad = []
const check = (name, cond, detail = '') => {
  ;(cond ? ok : bad).push(`${name}${detail ? ' — ' + detail : ''}`)
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

/** 真 git，配置与运行时保持一致 */
const GIT_ARGS = [
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false',
  '-c', 'commit.gpgsign=false',
  '-c', 'index.version=2',
  `--git-dir=${gitdir}`,
  `--work-tree=${dir}`,
]
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Mtbot', GIT_AUTHOR_EMAIL: 'vcs@mtbot.local',
  GIT_COMMITTER_NAME: 'Mtbot', GIT_COMMITTER_EMAIL: 'vcs@mtbot.local',
  GIT_CONFIG_NOSYSTEM: '1',
}
const cli = (args) => execFileSync('git', [...GIT_ARGS, ...args], { env: GIT_ENV, encoding: 'utf8' }).trim()

console.log(`工作目录：${dir}\n`)

// ── 阶段 1：isomorphic-git 建仓并提交 ──────────────────────────
await git.init({ ...base, defaultBranch: 'main' })
fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.mtbot-vcs/\n')
fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n')
fs.writeFileSync(path.join(dir, 'b.txt'), '世界\n')
await git.add({ ...base, filepath: '.' })
const oid1 = await git.commit({ ...base, message: 'iso 首次提交', author: { name: 'Mtbot', email: 'vcs@mtbot.local' } })
console.log(`isomorphic-git 提交 oid=${oid1.slice(0, 8)}`)

// 判据 1：真 git 是否认可这个 index/工作树状态
const st1 = cli(['status', '--porcelain'])
check('真 git 认 isomorphic-git 的 index（工作树无假阳性变更）', st1 === '', st1 ? `实际输出: ${JSON.stringify(st1.slice(0, 200))}` : '')

const head1 = cli(['rev-parse', 'HEAD'])
check('真 git 读到同一 HEAD', head1 === oid1, `git=${head1.slice(0, 8)} iso=${oid1.slice(0, 8)}`)

// ── 阶段 2：真 git 提交，isomorphic-git 读回 ──────────────────
fs.writeFileSync(path.join(dir, 'c.txt'), '真 git 写的\n')
cli(['add', '-A'])
cli(['commit', '-m', 'cli 第二次提交'])
const oid2 = cli(['rev-parse', 'HEAD'])

const logIso = await git.log({ ...base, depth: 10 })
check('isomorphic-git 读回真 git 的提交', logIso.length === 2 && logIso[0].oid === oid2,
  `log 条数=${logIso.length} 最新=${logIso[0]?.oid.slice(0, 8)}`)

const matrix = await git.statusMatrix(base)
check('isomorphic-git statusMatrix 可解析真 git 的 index', matrix.length > 0, `行数=${matrix.length}`)

const clean = matrix.every(([, head, workdir, stage]) => head === workdir && workdir === stage)
check('isomorphic-git 认为工作树干净（无假阳性）', clean,
  clean ? '' : JSON.stringify(matrix.filter(([, h, w, s]) => !(h === w && w === s)).slice(0, 3)))

// ── 判据 3：index 版本号 ──────────────────────────────────────
const idx = fs.readFileSync(path.join(gitdir, 'index'))
const idxVer = idx.readUInt32BE(4)
check('真 git 写出的 index 版本为 2（isomorphic-git 只支持 v2）', idxVer === 2, `实际 v${idxVer}`)

// ── 阶段 4：混合多轮后仍一致 ─────────────────────────────────
let consistent = true
for (let i = 0; i < 3; i++) {
  fs.writeFileSync(path.join(dir, `mix-${i}.txt`), `第 ${i} 轮\n`)
  await git.add({ ...base, filepath: '.' })
  await git.commit({ ...base, message: `iso 混合轮 ${i}`, author: { name: 'Mtbot', email: 'vcs@mtbot.local' } })
  const dirty = cli(['status', '--porcelain'])
  if (dirty !== '') { consistent = false; console.log(`   第 ${i} 轮后真 git 报告变更: ${dirty.slice(0, 120)}`); break }

  fs.writeFileSync(path.join(dir, `climix-${i}.txt`), `cli 第 ${i} 轮\n`)
  cli(['add', '-A']); cli(['commit', '-m', `cli 混合轮 ${i}`])
  const m = await git.statusMatrix(base)
  if (!m.every(([, h, w, s]) => h === w && w === s)) { consistent = false; console.log(`   第 ${i} 轮后 iso 报告变更`); break }
}
check('交错提交 6 轮后双方仍一致', consistent)

// ── 关键：等长 + mtime 还原 的改写，**发货实现**能否检出 ──
//
// ⚠️ 这条检查第一版是**假通过**，务必别退回那种写法：
// 第一版直接 `writeFileSync` + `utimesSync(st0)`，看起来检出成功 —— 但那只是因为
// utimesSync 只还原到毫秒，而 index 里记的是 100ns 精度，纳秒位对不上，
// git 靠 mtime 不匹配就重读了，测到的其实是「mtime 变了」。
// 必须先**把 mtime 归一到整数毫秒**（下面 ref 那步），把这条逃生口堵死，
// 才是在测「size 与 mtime 都看不出变化」的真场景。
//
// 堵死之后，`git add -A` 走 stat 缓存会漏（vcs-repo.test.ts 的同款用例实测挂过），
// 所以 stageAllCli 每次都先删 index 强制全量重算。这里验的就是那条发货路径。
const racyPath = path.join(dir, 'racy.txt')
fs.writeFileSync(racyPath, 'AAAA\n')
{
  const s = fs.statSync(racyPath)
  fs.utimesSync(racyPath, s.atime, s.mtime)   // 归一到整数毫秒
}
const ref = fs.statSync(racyPath)
cli(['add', '-A']); cli(['commit', '-m', 'racy 基线'])

fs.writeFileSync(racyPath, 'BBBB\n')            // 等长内容
fs.utimesSync(racyPath, ref.atime, ref.mtime)   // mtime 还原成 index 写入之前的值
const now = fs.statSync(racyPath)
check('前置成立：size 与 mtime 完全未变（否则测的不是这个场景）',
  now.size === ref.size && now.mtimeMs === ref.mtimeMs,
  `size ${ref.size}→${now.size}, mtimeMs ${ref.mtimeMs}→${now.mtimeMs}`)

fs.rmSync(path.join(gitdir, 'index'), { force: true })   // 发货实现的关键一步
cli(['add', '-A'])
const racyStaged = cli(['diff', '--cached', '--name-only'])
check('发货路径（删 index + add -A）检出等长改写', racyStaged.includes('racy.txt'),
  racyStaged ? `已暂存: ${JSON.stringify(racyStaged.slice(0, 80))}` : '未检出')

console.log(`\n通过 ${ok.length} / ${ok.length + bad.length}`)
if (bad.length) { console.log('\n失败项：'); bad.forEach((b) => console.log('  - ' + b)) }
fs.rmSync(dir, { recursive: true, force: true })
process.exit(bad.length ? 1 : 0)
