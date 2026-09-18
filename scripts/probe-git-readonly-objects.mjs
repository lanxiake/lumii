/**
 * 探针：真 git 写出的**只读** object，isomorphic-git 再写同一个会不会失败？
 *
 * ## 为什么必须探
 *
 * 真 git 在 Windows 上把 loose object 写成 `444`（只读），isomorphic-git 写成可写。
 * 两个模块现在都混用两者（见 apps/windows/src/main/git-cli.ts 的文件头）：
 *   - workspace-vcs：真 git 暂存/提交，isomorphic-git 读 log/diff/readBlob
 *   - cloud-sync   ：真 git 暂存，isomorphic-git 做 commit/fetch/merge/push
 *
 * 「读」没问题。风险在「两边都会写同一个 object」时：git 的对象写入本应「已存在就跳过」，
 * 但那需要它先 stat 到只读文件并正确识别为已存在 —— 若它直接覆盖，就会 EPERM。
 *
 * 同一个内容在同一个仓库里被两种实现先后写入是很常见的（例如同一个文件被两次提交、
 * 或是 merge 时复用已有 blob），所以这不是理论边界。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const git = require('isomorphic-git')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ro-probe-'))
const gitdir = path.join(dir, '.git')

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'M', GIT_AUTHOR_EMAIL: 'm@m', GIT_COMMITTER_NAME: 'M', GIT_COMMITTER_EMAIL: 'm@m',
  GIT_CONFIG_NOSYSTEM: '1',
}
const cli = (args) =>
  execFileSync('git', ['-c', 'core.autocrlf=false', `--git-dir=${gitdir}`, `--work-tree=${dir}`, ...args], {
    cwd: dir, env: ENV, encoding: 'utf8', stdio: 'pipe',
  })

let failed = 0
const check = (name, cond, detail = '') => {
  if (!cond) failed++
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

fs.mkdirSync(gitdir, { recursive: true })
cli(['init', '-q', '-b', 'main'])

// 1. 真 git 写一个 object
fs.writeFileSync(path.join(dir, 'a.txt'), 'same-content\n')
cli(['add', '-A'])
cli(['commit', '-q', '-m', 'by real git'])

const objHash = cli(['rev-parse', 'HEAD:a.txt']).trim()
const objPath = path.join(gitdir, 'objects', objHash.slice(0, 2), objHash.slice(2))
const st = fs.statSync(objPath)
check('前置：真 git 的 object 确实是只读', !(st.mode & 0o200), `mode=${(st.mode & 0o777).toString(8)}`)

// 2. isomorphic-git 写**同一个**内容（会产生同一个 oid → 同一个文件）
//    这是最常见的情形：同一份内容被再次提交。
let isoErr = null
try {
  fs.writeFileSync(path.join(dir, 'b.txt'), 'same-content\n') // 同内容 → 同 blob oid
  await git.add({ fs, dir, gitdir, filepath: 'b.txt' })
} catch (e) {
  isoErr = e
}
check('isomorphic-git 能写入与真 git 相同内容的 blob（同 oid）', isoErr === null,
  isoErr ? `${isoErr.code ?? ''} ${isoErr.message}` : '')

// 3. isomorphic-git 直接提交（内部会再写一次 tree/commit 对象）
let commitErr = null
try {
  await git.commit({ fs, dir, gitdir, message: 'by iso', author: { name: 'M', email: 'm@m' } })
} catch (e) {
  commitErr = e
}
check('isomorphic-git 能在真 git 建过的仓库里提交', commitErr === null,
  commitErr ? `${commitErr.code ?? ''} ${commitErr.message}` : '')

// 4. 反向：真 git 在 isomorphic-git 建过的仓库里提交
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ro-probe2-'))
const gitdir2 = path.join(dir2, '.git')
await git.init({ fs, dir: dir2, gitdir: gitdir2, defaultBranch: 'main' })
fs.writeFileSync(path.join(dir2, 'x.txt'), 'x\n')
await git.add({ fs, dir: dir2, gitdir: gitdir2, filepath: '.' })
await git.commit({ fs, dir: dir2, gitdir: gitdir2, message: 'by iso', author: { name: 'M', email: 'm@m' } })
let cliErr = null
try {
  fs.writeFileSync(path.join(dir2, 'y.txt'), 'x\n') // 同内容 → 同 blob
  execFileSync('git', ['-c', 'core.autocrlf=false', `--git-dir=${gitdir2}`, `--work-tree=${dir2}`, 'add', '-A'],
    { cwd: dir2, env: ENV, encoding: 'utf8', stdio: 'pipe' })
  execFileSync('git', ['-c', 'core.autocrlf=false', `--git-dir=${gitdir2}`, `--work-tree=${dir2}`,
    'commit', '-q', '--no-verify', '-m', 'by real git'], { cwd: dir2, env: ENV, encoding: 'utf8', stdio: 'pipe' })
} catch (e) {
  cliErr = e
}
check('真 git 能在 isomorphic-git 建过的仓库里提交', cliErr === null,
  cliErr ? String(cliErr.stderr ?? cliErr.message).slice(0, 160) : '')

// 5. 写坏一个只读 object 会怎样（暴露「不能覆盖」的真实后果面）
fs.rmSync(dir, { recursive: true, force: true })
fs.rmSync(dir2, { recursive: true, force: true })
console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项未通过'}`)
process.exit(failed ? 1 : 0)
