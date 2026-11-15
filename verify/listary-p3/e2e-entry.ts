/**
 * 端到端图标链路 —— 真实索引库 + 真实 search + 真实 icons handler。
 *
 * 前一个探针（icons-entry.ts）只喂了开始菜单的 12 个 lnk，全过。
 * 但用户看到的是**搜索结果里的**图标是空白 —— 结果里还有 .exe / 文件夹 / 普通文件，
 * 而且真实库有 3 万多条。要复现用户场景，必须用真实库跑。
 *
 * 本探针要区分两种可能：
 *   A. handler 对某些条目确实返回不了图 → out 里缺这个 path
 *   B. handler 都返回了，但图是**全透明**的（能解码、无可见像素）→ 前端渲染成空白
 *
 * 用户说「空白」而不是「显示成 emoji 兜底」，说明拿到的是"有 src 但看不见"的图
 * （B），而不是 img 根本不存在（A 会退化成 emoji）。
 *
 * 用法：
 *   node verify/listary-p3/build-e2e.mjs
 *   pnpm exec electron verify/listary-p3/e2e-bundle.cjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, nativeImage } from 'electron'

import { buildListaryIpcTable, LISTARY_CHANNEL } from '../../apps/windows/src/plugins/builtin/listary/ipc'
import { ListaryDb } from '../../apps/windows/src/plugins/builtin/listary/db'
import { search } from '../../apps/windows/src/plugins/builtin/listary/query'
import type { IpcHandler } from '../../apps/windows/src/plugins/api/ipc'

const OUT = path.join(__dirname, 'e2e.out')
const lines: string[] = []
fs.rmSync(OUT, { force: true })
function log(s: string): void {
  lines.push(s)
  process.stdout.write(s + '\n')
  fs.writeFileSync(OUT, lines.join('\n') + '\n')
}

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (!ok) failures++
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const REAL_DB = path.join(process.env.APPDATA ?? '', 'lumii-windows', 'listary', 'index.db')

/** 用真实库的副本（不碰用户数据） */
function copyDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lz-e2e-'))
  const dst = path.join(dir, 'index.db')
  for (const suffix of ['', '-wal', '-shm']) {
    const src = REAL_DB + suffix
    if (fs.existsSync(src)) fs.copyFileSync(src, dst + suffix)
  }
  return dst
}

interface PixelInfo {
  w: number
  h: number
  bytes: number
  opaque: number
  colors: number
}

function inspect(dataUrl: string): PixelInfo | null {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64')
  if (buf.length === 0) return null
  const img = nativeImage.createFromBuffer(buf)
  if (img.isEmpty()) return null
  const s = img.getSize()
  const bmp = img.toBitmap()
  let opaque = 0
  const colors = new Set<string>()
  for (let i = 0; i + 3 < bmp.length; i += 4) {
    if (bmp[i + 3] > 16) {
      opaque++
      if (colors.size < 64) colors.add(`${bmp[i]},${bmp[i + 1]},${bmp[i + 2]}`)
    }
  }
  return { w: s.width, h: s.height, bytes: buf.length, opaque, colors: colors.size }
}

app.whenReady().then(async () => {
  log(`Electron ${process.versions.electron}\n`)

  if (!fs.existsSync(REAL_DB)) {
    log(`真实索引库不存在：${REAL_DB}\n先启动客户端让它建库。`)
    app.exit(1)
    return
  }

  const dbPath = copyDb()
  const ldb = new ListaryDb(dbPath)
  const health = ldb.checkHealth()
  log(`真实库副本 ${dbPath}`)
  log(`健康 ${health.isHealthy} / items ${health.items} / fts ${health.fts}\n`)

  // 构造 handler，只换掉 db 来源
  const table = buildListaryIpcTable({
    index: {
      open: () => ldb,
      status: () => ({}),
      listRoots: () => [],
      addRoot: () => [],
      removeRoot: () => ({ removed: 0 }),
      scanAll: async () => ({ indexed: 0, durationMs: 0, perRoot: [] }),
    } as never,
    launcher: { hide: () => {} } as never,
    getHotkeyStatus: () => ({ mode: 'none', acceleratorOk: false }),
  })
  const handlers = new Map<string, IpcHandler>()
  table.install((ch, fn) => handlers.set(ch, fn))
  const iconsHandler = handlers.get(LISTARY_CHANNEL.icons)!

  // ── 用户实际会搜的词 ──
  const queries = ['豆包', 'doubao', 'chrome', 'cursor', 'apifox', '设计', '微信', 'a']
  const allPaths = new Set<string>()

  log('═'.repeat(78))
  log('[1] 每个查询的前 10 条，图标能不能取到')
  log('═'.repeat(78))

  for (const q of queries) {
    const hits = search(ldb.db, q, { limit: 10 })
    log(`\n  「${q}」→ ${hits.length} 条`)
    for (const h of hits) {
      allPaths.add(h.path)
      log(`      ${h.kind.padEnd(4)} ${h.name.slice(0, 40).padEnd(42)} ${h.ext ?? ''}`)
    }
  }

  log('\n' + '═'.repeat(78))
  log(`[2] 对这 ${allPaths.size} 个路径批量取图标`)
  log('═'.repeat(78))
  const t0 = Date.now()
  const got = (await iconsHandler({}, [...allPaths])) as Record<string, string>
  log(`  耗时 ${Date.now() - t0}ms，返回 ${Object.keys(got).length} / ${allPaths.size}\n`)

  let missing = 0
  let blank = 0
  const byKind = new Map<string, { total: number; missing: number; blank: number }>()
  const fingerprints = new Map<string, string>()

  for (const p of allPaths) {
    const url = got[p]
    if (!url) {
      missing++
      log(`    ❌ 无图标  ${p}`)
      continue
    }
    const info = inspect(url)
    if (!info) {
      missing++
      log(`    ❌ 解不出  ${p}`)
      continue
    }
    if (info.opaque === 0) {
      blank++
      log(`    ⬜ 全透明 ${info.w}×${info.h} ${info.bytes}B  ${p}`)
    }
    const img = nativeImage.createFromBuffer(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
    const bmp = img.toBitmap()
    let h = 0
    for (let i = 0; i < bmp.length; i += 4) h = (h * 31 + bmp[i] * 7 + bmp[i + 1] * 13 + bmp[i + 2] * 17 + bmp[i + 3]) | 0
    fingerprints.set(p, String(h))
  }

  log('')
  check('所有条目都能取到图标', missing === 0, `${missing} 个缺失`)
  check('没有全透明（空白）图标', blank === 0, `${blank} 个空白`)

  // ── 按类型分组统计，定位是哪类条目出问题 ──
  log('\n' + '═'.repeat(78))
  log('[3] 按类型统计')
  log('═'.repeat(78))
  for (const q of queries.slice(0, 3)) {
    for (const h of search(ldb.db, q, { limit: 10 })) {
      const ext = h.ext ?? '(无扩展名)'
      const key = `${h.kind} ${ext}`
      const rec = byKind.get(key) ?? { total: 0, missing: 0, blank: 0 }
      rec.total++
      const url = got[h.path]
      const info = url ? inspect(url) : null
      if (!url || !info) rec.missing++
      else if (info.opaque === 0) rec.blank++
      byKind.set(key, rec)
    }
  }
  for (const [k, v] of [...byKind].sort((a, b) => b[1].total - a[1].total)) {
    log(`  ${k.padEnd(22)} 共 ${String(v.total).padStart(3)}  缺失 ${v.missing}  空白 ${v.blank}`)
  }

  log('\n' + '═'.repeat(78))
  log('[4] 与 Explorer 直接取图对比（抽样 3 个）')
  log('═'.repeat(78))
  for (const p of [...allPaths].slice(0, 3)) {
    try {
      const direct = await app.getFileIcon(p, { size: 'large' })
      const dInfo = direct.isEmpty() ? null : inspect(`data:image/png;base64,${direct.toPNG().toString('base64')}`)
      const mine = got[p] ? inspect(got[p]) : null
      log(`  ${path.basename(p).padEnd(28)}`)
      log(`      直接 getFileIcon : ${dInfo ? `${dInfo.w}×${dInfo.h} ${dInfo.bytes}B opaque=${dInfo.opaque}` : '取不到'}`)
      log(`      handler 返回     : ${mine ? `${mine.w}×${mine.h} ${mine.bytes}B opaque=${mine.opaque}` : '取不到'}`)
    } catch (e) {
      log(`  ${path.basename(p)} 对比失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  ldb.close()
  log('\n' + '─'.repeat(78))
  log(failures === 0 ? '全部通过' : `${failures} 项失败`)
  app.exit(failures === 0 ? 0 : 1)
})
