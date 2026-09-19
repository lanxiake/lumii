/**
 * 探针：能不能让 `git gc` 产出**多个小包**，从而让 isomorphic-git 每次只读一个小包？
 *
 * ## 问题
 *
 * cloud-sync 的 maybePruneObjectStore 用 `git gc --prune=now` 压对象库。而
 * isomorphic-git 读 pack 是把**整个 pack 读进内存**（`fs.read(packFile)` 一个 Buffer），
 * 读不到就吞成 null 并报「too large to read into memory」。实测工作区仓库被压成
 * 1.38GB 单包时读不了；sync 仓库 629MB 目前能读 —— 但那是**尺寸侥幸**：
 * 上限取决于当时的可用内存（Buffer.alloc 失败也会走到同一句报错）。
 *
 * ## 候选
 *
 * `pack.packSizeLimit` 让 repack 把对象分到多个 pack 里。若 `git gc` 也认这个配置，
 * 就能把单包压在安全尺寸内，而 iso 的 `readObjectPacked` 本来就遍历
 * `objects/pack` 下所有 `.idx`，多包对它是透明的。
 *
 * 必须同时验：① gc 是否真的分包 ② iso 能否从多包仓库里读出对象。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const git = require('isomorphic-git')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sizelimit-'))
const gitdir = path.join(dir, '.git')
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'M', GIT_AUTHOR_EMAIL: 'm@m', GIT_COMMITTER_NAME: 'M', GIT_COMMITTER_EMAIL: 'm@m',
  GIT_CONFIG_NOSYSTEM: '1',
}
const cli = (args) =>
  execFileSync('git', ['--git-dir', gitdir, '--work-tree', dir, ...args],
    { cwd: dir, env: ENV, encoding: 'utf8', stdio: 'pipe' })

let failed = 0
const check = (name, cond, detail = '') => {
  if (!cond) failed++
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

// 造**不可压缩**的内容：随机字节。否则 git 把一切 delta 压成几 KB，
// 根本触不到尺寸上限（本探针第一版就是这样，1MB 内容压成 6KB，什么都没测到）。
// 另注：git 对 --max-pack-size / pack.packSizeLimit 有 **1MiB 下限**，参数会被夹到 1MB。
fs.mkdirSync(gitdir, { recursive: true })
cli(['init', '-q', '-b', 'main'])
const { randomBytes } = await import('node:crypto')
for (let c = 0; c < 6; c++) {
  for (let f = 0; f < 4; f++) {
    fs.writeFileSync(path.join(dir, `f${f}.bin`), randomBytes(256 * 1024))
  }
  cli(['add', '-A'])
  cli(['commit', '-q', '--no-verify', '-m', `c${c}`])
}

const packDir = path.join(gitdir, 'objects', 'pack')
const packsOf = () => fs.readdirSync(packDir).filter((f) => f.endsWith('.pack'))
const sizeOf = (f) => fs.statSync(path.join(packDir, f)).size

console.log('=== 不限制（现状）===')
cli(['gc', '--prune=now'])
let packs = packsOf()
console.log(`  pack 数=${packs.length}  最大=${Math.round(Math.max(...packs.map(sizeOf)) / 1024)}KB`)

console.log('\n=== 限制 pack.packSizeLimit=1m ===')
cli(['-c', 'pack.packSizeLimit=1m', 'gc', '--prune=now'])
packs = packsOf()
const sizes = packs.map(sizeOf)
console.log(`  pack 数=${packs.length}  最大=${Math.round(Math.max(...sizes) / 1024)}KB` +
  `  各包=${sizes.map((s) => Math.round(s / 1024) + 'KB').join(', ')}`)
check('gc 确实按 packSizeLimit 分包', packs.length > 1, `得到 ${packs.length} 个包`)

console.log('\n=== isomorphic-git 能否从多包仓库读出对象 ===')
const head = cli(['rev-parse', 'HEAD']).trim()
try {
  const log = await git.log({ fs, dir, gitdir, depth: 3 })
  check('iso 能读 log', log.length === 3, `${log.length} 条`)
  const { blob } = await git.readBlob({ fs, dir, gitdir, oid: head, filepath: 'f0.bin' })
  check('iso 能读 blob（随机二进制，256KB）', blob.length === 256 * 1024, blob.length + ' 字节')
} catch (e) {
  check('iso 读取', false, String(e.message).slice(0, 160))
}

console.log(`\n${failed === 0 ? '方案可用' : failed + ' 项未通过'}`)
fs.rmSync(dir, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
