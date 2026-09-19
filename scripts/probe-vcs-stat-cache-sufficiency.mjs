/**
 * 探针：workspace 仓库能不能回到 git 默认的 stat 缓存（放弃强制全量 rehash）？
 *
 * ## 背景
 *
 * `stageAllCli` 现在每次都用临时 index 逼 git 全量重算 hash（实测 2469ms / 12866 文件），
 * 挂在「每条助手消息一次」上。它的**唯一**论据写在 vcs-git-cli.ts:29：
 *
 *   「任何内容改写都被检出，包括『等长 + utimesSync 还原 mtime』这种
 *     （云同步导入路径确实会 utimesSync）」
 *
 * 但复核 cloud-sync 后，括号里那句是错的：
 *   - sync-copy.ts 的 utimesSync 只在 `skipUnchanged: true` 时执行
 *   - 只有 sync-exporter.ts:497/519 传了它，目标是 **syncDir**
 *   - sync-large-queue.ts:353 的目标同样是 syncOutputsDir
 *   - 真正写 workspace 的 sync-importer.ts:654/667 **只 copyFileSync，不回写 mtime**
 *
 * 所以「等长 + mtime 不变」在 workspace 里到底会不会发生？本探针用两组对照回答：
 *
 *   A. 模拟 importer 的真实行为（copyFileSync 覆盖，不回写 mtime）→ stat 缓存该检出
 *   B. 人为还原 mtime（当前注释假设的场景）     → stat 缓存预期漏检
 *
 * A 通过 + B 漏检 = 论据不成立，可以去掉强制全量重算；
 * A 漏检 = 论据虽然写错了理由，但结论仍要保留，得另找原因。
 *
 * ## 为什么必须 sleep ≥1.5s
 *
 * git 的 racy-timestamp 规则：`entry.mtime >= index 写入时间` 时强制重读内容。
 * 整个试验在毫秒内跑完时两者相等，git 会**无条件**检查，对照组会假通过
 * （probe-vcs-force-rehash.mjs 第一版就是这样全绿的）。所以 commit 后必须等过这个窗口。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'M', GIT_AUTHOR_EMAIL: 'm@m',
  GIT_COMMITTER_NAME: 'M', GIT_COMMITTER_EMAIL: 'm@m',
  GIT_CONFIG_NOSYSTEM: '1',
}

let failed = 0
const check = (name, cond, detail = '') => {
  if (!cond) failed++
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

/** 等过 racy 窗口。Atomics.wait 是同步 sleep，不引入 async 时序噪声 */
const sleep = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** 建一个带初始提交的仓库，返回 { dir, gitdir, cli } */
function makeRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vcs-statcache-${tag}-`))
  const gitdir = path.join(dir, '.mtbot-vcs')
  const cli = (args) =>
    execFileSync('git', ['--git-dir', gitdir, '--work-tree', dir, ...args],
      { cwd: dir, env: ENV, encoding: 'utf8', stdio: 'pipe' })
  fs.mkdirSync(gitdir, { recursive: true })
  cli(['init', '-q', '-b', 'main'])
  // 原样照抄生产配置（vcs-git-cli.ts 的 GIT_BASE_CONFIG 关键项）
  cli(['config', 'core.autocrlf', 'false'])
  cli(['config', 'index.version', '2'])
  cli(['config', 'gc.auto', '0'])
  // ⚠️ 必须挡住 gitdir 自我索引。gitdir 叫 .mtbot-vcs 而非 .git，git 不会自动跳过它，
  // 于是每次 `add -A` 都会把 objects/、index、logs/ 加进来 —— diff --cached 永远非空，
  // 组 A/B 的「检出」会全变成这个噪声（本探针第一版就是这样，组 B 假通过）。
  // 生产侧同一道防线在 vcs-git-cli.ts 的 ensureExcludeFile。
  const excludeFile = path.join(gitdir, 'probe-exclude')
  fs.writeFileSync(excludeFile, `${path.basename(gitdir)}/\n.src-*\n`, 'utf-8')
  cli(['config', 'core.excludesFile', excludeFile])
  // 内容长度固定为 32，后面的改写必须等长
  fs.writeFileSync(path.join(dir, 'a.txt'), 'A'.repeat(32))
  fs.writeFileSync(path.join(dir, 'b.txt'), 'B'.repeat(32))
  cli(['add', '-A'])
  cli(['commit', '-q', '--no-verify', '-m', 'init'])
  return { dir, gitdir, cli }
}

/** 用 git 默认 stat 缓存暂存后，问「index 相对 HEAD 有没有差异」 */
function detectsChange(r) {
  r.cli(['add', '-A'])
  try {
    r.cli(['diff', '--cached', '--quiet'])
    return false // 退出码 0 = 无差异 = 漏检
  } catch (e) {
    return e.status === 1 // 退出码 1 = 有差异 = 检出
  }
}

const results = []

// ── 组 A：模拟 sync-importer 的真实行为 ─────────────────────────────
// copyFileSync 覆盖目标，**不回写 mtime** → 目标 mtime = 复制时刻（变新）
{
  const r = makeRepo('A')
  sleep(1600) // 过 racy 窗口，让 stat 缓存真正生效
  const src = path.join(r.dir, '.src-a')
  fs.writeFileSync(src, 'X'.repeat(32)) // 等长但内容不同
  fs.copyFileSync(src, path.join(r.dir, 'a.txt')) // ← importer 的真实动作
  fs.rmSync(src)
  const got = detectsChange(r)
  results.push(['A', got])
  check('组 A：importer 真实行为（等长 + 不回写 mtime）被 stat 缓存检出', got,
    got ? 'mtime 变新，git 重读内容' : '漏检 —— 论据仍需保留')
  fs.rmSync(r.dir, { recursive: true, force: true })
}

// ── 组 B：注释假设的场景（人为还原 mtime）───────────────────────────
// 先把 mtime 归一化到整毫秒再取基准：否则 utimesSync 的舍入本身就会让
// mtime 发生变化，git 因此检出，对照组变成假通过（mtime-precision 坑）
{
  const r = makeRepo('B')
  const abs = path.join(r.dir, 'a.txt')
  const ms = Math.floor(fs.statSync(abs).mtimeMs)
  fs.utimesSync(abs, new Date(ms), new Date(ms)) // 归一化
  const ref = fs.statSync(abs)
  r.cli(['add', '-A'])
  r.cli(['commit', '-q', '--no-verify', '--allow-empty', '-m', 'normalize'])
  sleep(1600)
  fs.writeFileSync(abs, 'Y'.repeat(32)) // 等长改写
  fs.utimesSync(abs, ref.atime, ref.mtime) // 还原 mtime
  const got = detectsChange(r)
  results.push(['B', got])
  console.log(`${got ? '⚠️ ' : 'ℹ️ '} 组 B：人为还原 mtime ${got ? '竟被检出（探针可能失真）' : '漏检（符合预期）'}`)
  fs.rmSync(r.dir, { recursive: true, force: true })
}

// ── 组 C：删除与新增（stat 缓存对它们本来就没有漏检风险，验证语义完整）──
{
  const r = makeRepo('C')
  sleep(1600)
  fs.rmSync(path.join(r.dir, 'a.txt'))
  fs.writeFileSync(path.join(r.dir, 'c.txt'), 'C'.repeat(32))
  const got = detectsChange(r)
  check('组 C：删除 + 新增被检出', got)
  const st = r.cli(['diff', '--cached', '--name-status']).trim().split('\n').sort()
  check('组 C：增删语义正确', st.join('|') === 'A\tc.txt|D\ta.txt', st.join(' '))
  fs.rmSync(r.dir, { recursive: true, force: true })
}

const a = results.find(([k]) => k === 'A')[1]
const b = results.find(([k]) => k === 'B')[1]
console.log()
if (a && !b) {
  console.log('结论：stat 缓存对 workspace 的真实改写路径足够（组 A 检出）；')
  console.log('      组 B 的漏检场景在 workspace 里不会发生 —— 强制全量重算的论据不成立。')
} else if (!a) {
  console.log('结论：stat 缓存漏掉了 importer 的真实行为 —— 强制全量重算必须保留。')
} else {
  console.log('结论：组 B 也被检出，探针失真（racy 窗口或 mtime 归一化有问题），勿据此下结论。')
}
console.log(`\n${failed === 0 ? '断言全部通过' : failed + ' 项未通过'}`)
process.exit(failed ? 1 : 0)
