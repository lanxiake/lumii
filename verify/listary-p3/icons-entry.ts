/**
 * 图标链路验收 —— 跑 `ipc.ts` 里**真实的** `icons` handler，不是复制实现。
 *
 * 用户报告（2026-11-15 第二轮）：「显示的是空白图标」。
 * 上一轮修的是「所有 lnk 都是同一个通用箭头」（`getFileIcon('x.lnk')` 对所有快捷方式
 * 返回同一个 546 B 箭头），改成按 `IconLocation` → `TargetPath` 取。
 * 改完用户看到的是**空白** —— 说明取图那一步没拿到可用像素，或拿到的 PNG 前端显示不出来。
 *
 * 本探针要分辨的几件事：
 *   1. handler 到底返回了哪些 key、哪些路径被漏掉了
 *   2. dataURL 解码后是不是一张**有内容**的图（尺寸 > 0 且非全透明）
 *   3. 不同快捷方式拿到的图是否真的不同
 *
 * 用法：
 *   node verify/listary-p3/build-icons.mjs
 *   pnpm exec electron verify/listary-p3/icons-bundle.cjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { app, nativeImage } from 'electron'

import {
  buildListaryIpcTable,
  LISTARY_CHANNEL,
} from '../../apps/windows/src/plugins/builtin/listary/ipc'
import type { IpcHandler } from '../../apps/windows/src/plugins/api/ipc'

const OUT = path.join(__dirname, 'icons.out')
const lines: string[] = []
fs.rmSync(OUT, { force: true })
function log(s: string): void {
  lines.push(s)
  process.stdout.write(s + '\n')
  fs.writeFileSync(OUT, lines.join('\n') + '\n')
}

const results: Array<{ name: string; ok: boolean; detail?: string }> = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail })
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const START_MENU = path.join(
  process.env.APPDATA ?? '',
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
)

function collectLinks(dir: string, max: number): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    if (out.length >= max) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= max) return
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && e.name.toLowerCase().endsWith('.lnk')) out.push(full)
    }
  }
  walk(dir)
  return out
}

/** dataURL → 像素统计。返回 null 表示不是合法图片。 */
function inspectDataUrl(url: string): {
  w: number
  h: number
  bytes: number
  opaquePixels: number
  distinctColors: number
} | null {
  const comma = url.indexOf(',')
  if (comma < 0) return null
  const b64 = url.slice(comma + 1)
  const buf = Buffer.from(b64, 'base64')
  if (buf.length === 0) return null
  const img = nativeImage.createFromBuffer(buf)
  if (img.isEmpty()) return null
  const size = img.getSize()
  const bmp = img.toBitmap() // BGRA
  let opaque = 0
  const colors = new Set<string>()
  for (let i = 0; i + 3 < bmp.length; i += 4) {
    const a = bmp[i + 3]
    if (a > 16) {
      opaque++
      // 只记录不透明像素的颜色，透明像素的 RGB 无意义
      if (colors.size < 64) colors.add(`${bmp[i]},${bmp[i + 1]},${bmp[i + 2]}`)
    }
  }
  return { w: size.width, h: size.height, bytes: buf.length, opaquePixels: opaque, distinctColors: colors.size }
}

app.whenReady().then(async () => {
  log(`Electron ${process.versions.electron} / ABI ${process.versions.modules}\n`)

  const links = collectLinks(START_MENU, 12)
  log(`开始菜单取样 ${links.length} 个快捷方式\n`)
  if (links.length === 0) {
    log('本机没有快捷方式，无法验证')
    app.exit(1)
    return
  }

  // 构造假的 index / launcher：icons handler 不碰它们
  const table = buildListaryIpcTable({
    index: {
      open: () => ({ db: {} }),
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
  const iconsHandler = handlers.get(LISTARY_CHANNEL.icons)
  if (!iconsHandler) {
    log('❌ icons handler 没登记上')
    app.exit(1)
    return
  }
  log(`通道已登记：${table.channels().join(', ')}\n`)

  log('═'.repeat(78))
  log('[1] 调真实 handler 取这 12 个 lnk 的图标')
  log('═'.repeat(78))
  const t0 = Date.now()
  const got = (await iconsHandler({}, links)) as Record<string, string>
  const elapsed = Date.now() - t0
  log(`  耗时 ${elapsed}ms，返回 ${Object.keys(got).length} / ${links.length} 条\n`)

  let blank = 0
  const fingerprints = new Map<string, string>()
  for (const l of links) {
    const name = path.basename(l)
    const url = got[l]
    if (!url) {
      log(`    ${name.padEnd(26)} ❌ 没有返回图标`)
      blank++
      continue
    }
    const info = inspectDataUrl(url)
    if (!info) {
      log(`    ${name.padEnd(26)} ❌ dataURL 解不出图（${url.slice(0, 40)}…）`)
      blank++
      continue
    }
    const isBlank = info.opaquePixels === 0
    if (isBlank) blank++
    log(
      `    ${name.padEnd(26)} ${String(info.w)}×${String(info.h)}  ${String(info.bytes).padStart(6)} B  ` +
        `不透明 ${String(info.opaquePixels).padStart(4)} px  色数 ${info.distinctColors}` +
        (isBlank ? '   ← 全透明 = 空白' : ''),
    )
    // 指纹用不透明像素的哈希，判断"不同快捷方式是否拿到不同的图"
    const img = nativeImage.createFromBuffer(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
    const bmp = img.toBitmap()
    let h = 0
    for (let i = 0; i < bmp.length; i += 4) h = (h * 31 + bmp[i] * 7 + bmp[i + 1] * 13 + bmp[i + 2] * 17 + bmp[i + 3]) | 0
    fingerprints.set(name, String(h))
  }

  log('')
  check('每个 lnk 都拿到了图标', blank === 0, `${blank} 个缺失/空白`)
  check('没有全透明（空白）图标', blank === 0, `${blank} 个空白`)
  const uniq = new Set(fingerprints.values())
  log(`\n  不同图标的数量：${uniq.size} / ${fingerprints.size}`)
  check('不同快捷方式拿到不同的图', uniq.size > Math.max(1, Math.floor(fingerprints.size / 3)), `${uniq.size} 种`)

  const failed = results.filter((r) => !r.ok)
  log('\n' + '─'.repeat(78))
  log(failed.length === 0 ? `通过（${results.length} 项）` : `${failed.length} / ${results.length} 项失败`)
  for (const f of failed) log(`  - ${f.name}: ${f.detail ?? ''}`)
  app.exit(failed.length === 0 ? 0 : 1)
})
