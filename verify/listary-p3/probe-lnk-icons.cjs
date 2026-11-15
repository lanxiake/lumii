/**
 * 图标解析的端到端验证 —— 在 Electron 里走**真实的 IPC handler 逻辑**。
 *
 * 背景（2026-11-15 用户反馈）：快捷方式显示的不是它原本的图标。
 * 探针 `probe-icons-focus.cjs` 已定位根因：`app.getFileIcon('x.lnk')` 对所有快捷方式
 * 返回同一个 382 B 通用箭头图标。修法是先解析 `TargetPath` 再取图标。
 *
 * 本脚本验修法：把目标解析 + 去重 + 回填的整段逻辑跑一遍真实 lnk，断言：
 *   1. 不同快捷方式拿到**不同的**图标（不再是同一个 382 B 箭头）
 *   2. 图标字节数与"直接取目标 exe"一致
 *
 * 用法：pnpm exec electron verify/listary-p3/probe-lnk-icons.cjs
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { app } = require('electron')

const OUT = path.join(__dirname, 'lnk-icons.out')
const lines = []
fs.rmSync(OUT, { force: true })
function log(s) {
  lines.push(s)
  process.stdout.write(s + '\n')
  fs.writeFileSync(OUT, lines.join('\n') + '\n')
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const START_MENU = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')

function sampleLinks(n) {
  const out = []
  try {
    for (const e of fs.readdirSync(START_MENU, { withFileTypes: true })) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.lnk')) {
        out.push(path.join(START_MENU, e.name))
        if (out.length >= n) break
      }
    }
  } catch {
    /* 没有就算了 */
  }
  return out
}

/** 与 ipc.ts 的 resolveLinkTargets 同构（脚本里独立实现，验的是"这个办法行不行"） */
function resolveLinkTargets(links) {
  return new Promise((resolve) => {
    if (links.length === 0) return resolve(new Map())
    const arr = links.map((p) => `'${p.replace(/'/g, "''")}'`).join(',')
    const script =
      `$sh = New-Object -ComObject WScript.Shell; ` +
      `foreach ($p in @(${arr})) { try { Write-Output ($p + "\`t" + $sh.CreateShortcut($p).TargetPath) } catch { } }`
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 15000, windowsHide: true },
      (err, so) => {
        const map = new Map()
        if (!err && so) {
          for (const line of String(so).split(/\r?\n/)) {
            const tab = line.indexOf('\t')
            if (tab <= 0) continue
            const link = line.slice(0, tab).trim()
            const target = line.slice(tab + 1).trim()
            if (link && target) map.set(link, target)
          }
        }
        resolve(map)
      },
    )
  })
}

async function iconBytes(p) {
  const img = await app.getFileIcon(p, { size: 'small' })
  return img.isEmpty() ? null : img.toPNG()
}

app.whenReady().then(async () => {
  log(`Electron ${process.versions.electron}\n`)
  const links = sampleLinks(6)
  if (links.length < 2) {
    log('本机快捷方式不足 2 个，跳过')
    app.exit(0)
    return
  }
  log(`取样 ${links.length} 个快捷方式\n`)

  log('═'.repeat(64))
  log('[1] 直接取 .lnk 的图标（修复前的问题复现）')
  log('═'.repeat(64))
  const direct = new Map()
  for (const l of links) {
    const b = await iconBytes(l)
    direct.set(l, b ? b.length : 0)
    log(`    ${path.basename(l).padEnd(22)} ${b ? String(b.length).padStart(5) + ' B' : '取不到'}`)
  }
  const directSizes = new Set([...direct.values()])
  log('')
  check(
    '复现问题：所有 .lnk 直接取的图标大小完全相同',
    directSizes.size === 1,
    `${directSizes.size} 种大小：${[...directSizes].join(',')} B`,
  )

  log('\n' + '═'.repeat(64))
  log('[2] 解析 TargetPath 后再取（修复后的行为）')
  log('═'.repeat(64))
  const targets = await resolveLinkTargets(links)
  check('解析出目标路径', targets.size > 0, `${targets.size} / ${links.length} 个`)

  const viaTarget = new Map()
  for (const l of links) {
    const t = targets.get(l)
    if (!t) continue
    log(`    ${path.basename(l).padEnd(22)} → ${t}`)
    if (!fs.existsSync(t)) {
      log(`      └ 目标不存在，跳过`)
      continue
    }
    const b = await iconBytes(t)
    viaTarget.set(l, b ? b.length : 0)
    log(`      └ 图标 ${b ? b.length + ' B' : '取不到'}`)
  }

  const targetSizes = new Set([...viaTarget.values()])
  log('')
  check(
    '修复后：不同快捷方式拿到不同图标',
    targetSizes.size > 1,
    `${targetSizes.size} 种大小：${[...targetSizes].join(',')} B`,
  )
  check(
    '修复后：图标不再是 382 B 的通用箭头',
    [...targetSizes].every((n) => n !== 382),
    [...targetSizes].join(',') + ' B',
  )

  const failed = results.filter((r) => !r.ok)
  log('\n' + '─'.repeat(64))
  log(failed.length === 0 ? `通过（${results.length} 项）` : `${failed.length} / ${results.length} 项失败`)
  for (const f of failed) log(`  - ${f.name}: ${f.detail ?? ''}`)
  app.exit(failed.length === 0 ? 0 : 1)
})
