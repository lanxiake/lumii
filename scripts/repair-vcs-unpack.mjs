/**
 * 修复：把 packfile 拆回松散对象。
 *
 * ## 为什么需要
 *
 * 工作区 `.mtbot-vcs` 与云同步的 `sync/.git` 是**两种实现共用**的仓库：
 * 真 git 暂存/拉取，isomorphic-git 读历史。isomorphic-git 读 pack 是**整个读进内存**的，
 * 大 pack 直接失败：
 *
 *   Could not read packfile at .../pack-<oid>.pack.
 *   The file may be missing, corrupted, or too large to read into memory.
 *
 * 2026-09-18 实测踩中：真 git 的 `gc --auto` 把工作区 .mtbot-vcs 压成 1.38GB 单包、
 * sync 仓库 632MB。代码侧已加 `-c gc.auto=0` 防复发（见 git-cli.ts）。
 *
 * ## ⚠️ 这个脚本第一版闯过祸，两条教训写在这里
 *
 * 第一版**在原地展开**（pack 仍留在 `objects/pack/` 下）。而 git 通过同目录的 `.idx`
 * 就已经"认识"这些对象了，于是 `unpack-objects` 把每一个都判为「已存在」而跳过 ——
 * **退出码 0 却什么都没导出**。脚本接着按计划删了 pack，1.3GB 对象就此丢失、无法恢复。
 *
 * 所以本版有两条硬约束：
 *  1. **必须先把 pack 移出 `objects/pack/`**，让 git 看不见它，才会真的展开。
 *  2. **删之前必须校验对象数**。第一版没有任何校验，只看退出码 —— 而退出码在这里
 *     完全不能说明问题。校验不通过就还原现场、报告失败，绝不删。
 *
 * 用法：node scripts/repair-vcs-unpack.mjs <gitdir> [<gitdir> ...]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const gitdirs = process.argv.slice(2)
if (!gitdirs.length) {
  console.error('用法：node scripts/repair-vcs-unpack.mjs <gitdir> [<gitdir> ...]')
  process.exit(2)
}

const ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  // 关键：修复过程中绝不能再触发一次打包
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'gc.auto',
  GIT_CONFIG_VALUE_0: '0',
}

/** 数松散对象（不含 pack 目录） */
function countLoose(gitdir) {
  const root = path.join(gitdir, 'objects')
  if (!fs.existsSync(root)) return 0
  let n = 0
  for (const d of fs.readdirSync(root)) {
    if (d === 'pack' || d === 'info') continue
    const sub = path.join(root, d)
    if (fs.statSync(sub).isDirectory()) n += fs.readdirSync(sub).length
  }
  return n
}

/** 从 .idx 估算 pack 里的对象数（v2 索引：8 头 + 256*4 扇出 + N*20 oid + N*4 crc + N*4 偏移 + 40 尾） */
function estimateObjectsFromIdx(idxPath) {
  const size = fs.statSync(idxPath).size
  return Math.max(0, Math.floor((size - 8 - 1024 - 40) / 28))
}

/** 用 pack 文件喂给 `git unpack-objects` 的 stdin（流式，不把 GB 级文件读进内存） */
function unpack(gitdir, packPath) {
  return new Promise((resolve) => {
    const child = spawn('git', ['--git-dir', gitdir, 'unpack-objects', '-q'], {
      env: ENV,
      windowsHide: true,
    })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += String(d) })
    child.on('error', (e) => resolve({ ok: false, err: e.message }))
    child.on('close', (code) => resolve({ ok: code === 0, code, err: stderr.trim().slice(0, 300) }))
    fs.createReadStream(packPath).pipe(child.stdin)
  })
}

let failed = 0
for (const gitdir of gitdirs) {
  console.log(`\n=== ${gitdir} ===`)
  const packDir = path.join(gitdir, 'objects', 'pack')
  if (!fs.existsSync(packDir)) {
    console.log('  无 pack 目录，跳过')
    continue
  }
  const packs = fs.readdirSync(packDir).filter((f) => f.endsWith('.pack'))
  if (!packs.length) {
    console.log('  无 pack，跳过')
    continue
  }

  // 暂存区放在仓库外：留在 objects/pack 下 git 就会「认识」这些对象，展开会变成空操作
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'mtbot-unpack-'))

  for (const p of packs) {
    const src = path.join(packDir, p)
    const base = p.slice(0, -'.pack'.length)
    const sizeMB = (fs.statSync(src).size / 1048576).toFixed(0)

    if (fs.existsSync(path.join(packDir, `${base}.keep`))) {
      console.log(`  ⏭️  ${p}（${sizeMB}MB）有 .keep，跳过`)
      continue
    }

    const idxPath = path.join(packDir, `${base}.idx`)
    const expected = fs.existsSync(idxPath) ? estimateObjectsFromIdx(idxPath) : -1

    // ① 连同伴生文件一起移出 objects/pack —— 这是让 unpack-objects 真正干活的前提
    const moved = []
    for (const suffix of ['.pack', '.idx', '.mtimes', '.rev', '.bitmap']) {
      const from = path.join(packDir, `${base}${suffix}`)
      if (!fs.existsSync(from)) continue
      const to = path.join(staging, `${base}${suffix}`)
      fs.renameSync(from, to)
      moved.push([from, to])
    }

    const before = countLoose(gitdir)
    const r = await unpack(gitdir, path.join(staging, `${base}.pack`))
    const after = countLoose(gitdir)
    const delta = after - before

    // ② 校验：对象数必须与索引推算量级相符。第一版就是漏了这一步才把数据删掉的。
    const plausible = expected < 0 ? delta > 0 : delta >= expected * 0.9
    if (!r.ok || !plausible) {
      failed++
      console.log(`  ❌ ${p}（${sizeMB}MB）未通过校验，**已还原现场**`)
      console.log(`     unpack 退出码=${r.code ?? 'n/a'}${r.err ? ' 错误=' + r.err : ''}`)
      console.log(`     对象数 ${before} → ${after}（增量 ${delta}，索引推算应约 ${expected}）`)
      for (const [from, to] of moved) fs.renameSync(to, from)
      continue
    }

    for (const [, to] of moved) fs.rmSync(to, { force: true })
    console.log(`  ✅ ${p}（${sizeMB}MB）已拆为松散对象并删除`)
    console.log(`     对象数 ${before} → ${after}（+${delta}，索引推算约 ${expected}）`)
  }

  fs.rmSync(staging, { recursive: true, force: true })
  fs.rmSync(path.join(packDir, 'multi-pack-index'), { force: true })
  console.log(`  剩余 pack：${fs.readdirSync(packDir).filter((f) => f.endsWith('.pack')).length}`)
}

console.log(failed ? `\n${failed} 个 pack 未处理（现场已还原）` : '\n全部完成')
process.exit(failed ? 1 : 0)
