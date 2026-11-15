/**
 * `resolveLinks` 对**中文路径**的快捷方式为什么解析失败。
 *
 * 观察（verify/listary-p3/e2e.out）：中文名的 lnk（豆包.lnk / chrome.exe - 快捷方式.lnk）
 * 经 handler 取到的图和直接取 lnk 一样（538 B 通用箭头），说明 `resolveLinks` 没把它
 * 放进 Map —— 于是 `sourceOf()` 退回 lnk 自身。ASCII 名（Apifox.lnk）是成功的。
 *
 * 怀疑：PowerShell 5.1 的 stdout 默认是控制台代码页（中文 Windows = 936/GBK），
 * 而 `execFile(..., { encoding: 'utf8' })` 按 UTF-8 解码 → 中文路径变乱码 →
 * `out.set(line, info)` 的 key 与查询用的真实路径对不上。
 *
 * 本探针直接比对同一批 lnk 在三种解码下的输出。
 *
 * 用法：node verify/listary-p3/probe-ps-encoding.cjs
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const OUT = path.join(__dirname, 'ps-encoding.out')
const lines = []
fs.rmSync(OUT, { force: true })
function log(s) {
  lines.push(s)
  process.stdout.write(s + '\n')
  fs.writeFileSync(OUT, lines.join('\n') + '\n')
}

const START_MENU = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')

/** 收集 lnk，优先挑中文名的 */
function collect(dir, max) {
  const all = []
  const walk = (d) => {
    if (all.length >= max * 4) return
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (all.length >= max * 4) return
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && e.name.toLowerCase().endsWith('.lnk')) all.push(full)
    }
  }
  walk(dir)
  // 中文名的排前面，确保样本里有非 ASCII
  all.sort((a, b) => {
    const an = /[^\x00-\x7f]/.test(path.basename(a)) ? 0 : 1
    const bn = /[^\x00-\x7f]/.test(path.basename(b)) ? 0 : 1
    return an - bn
  })
  return all.slice(0, max)
}

function buildScript(links) {
  const arr = links.map((p) => `'${p.replace(/'/g, "''")}'`).join(',')
  return (
    `$sh = New-Object -ComObject WScript.Shell; ` +
    `foreach ($p in @(${arr})) { try { ` +
    `  $s = $sh.CreateShortcut($p); ` +
    `  Write-Output ($p + "\`t" + $s.TargetPath + "\`t" + $s.IconLocation) ` +
    `} catch { } }`
  )
}

/** 用指定编码跑一次，返回原始 stdout（Buffer）与其按该编码的解码结果 */
function run(script, encoding) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: null,
      timeout: 20000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })
  } catch (e) {
    return Buffer.from(String(e.message))
  }
}

log(`Node ${process.version} / 控制台代码页探测\n`)

const links = collect(START_MENU, 6)
if (links.length === 0) {
  log('本机没有开始菜单快捷方式')
  process.exit(0)
}

log(`样本 ${links.length} 个：`)
for (const l of links) log(`  ${/[^\x00-\x7f]/.test(path.basename(l)) ? '[中文]' : '[ASCII]'} ${path.basename(l)}`)
log('')

const script = buildScript(links)

// ── A: 现状（execFile encoding:'utf8'）──
log('═'.repeat(78))
log("[A] 现状：execFile(..., { encoding: 'utf8' })")
log('═'.repeat(78))
const utf8Buf = run(script, 'utf8')
const asUtf8 = utf8Buf.toString('utf8')
const asGb18030 = new TextDecoder('gb18030').decode(utf8Buf)
log(`  原始字节 ${utf8Buf.length} B`)
log(`  按 utf8 解出的第一行：  ${JSON.stringify(asUtf8.split(/\r?\n/)[0] ?? '')}`)
log(`  按 gb18030 解出的第一行：${JSON.stringify(asGb18030.split(/\r?\n/)[0] ?? '')}`)

function parse(stdout) {
  const map = new Map()
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const link = parts[0].trim()
    if (!link) continue
    map.set(link, { target: parts[1].trim(), iconLocation: parts[2].trim() })
  }
  return map
}

const mapUtf8 = parse(asUtf8)
const mapGb = parse(asGb18030)

log('')
let hitUtf8 = 0
let hitGb = 0
for (const l of links) {
  const k = /[^\x00-\x7f]/.test(path.basename(l)) ? '[中文]' : '[ASCII]'
  const h1 = mapUtf8.has(l)
  const h2 = mapGb.has(l)
  if (h1) hitUtf8++
  if (h2) hitGb++
  log(`  ${k} ${path.basename(l).padEnd(30)} utf8命中=${h1 ? '✓' : '✗'}  gb18030命中=${h2 ? '✓' : '✗'}`)
}
log('')
log(`  按 utf8 解码命中：${hitUtf8} / ${links.length}`)
log(`  按 gb18030 解码命中：${hitGb} / ${links.length}`)

// ── B: 在脚本内部强制 UTF-8 输出 ──
log('\n' + '═'.repeat(78))
log('[B] 修复候选：脚本内设 [Console]::OutputEncoding = UTF8')
log('═'.repeat(78))
const fixedScript = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n` + script
const fixedBuf = run(fixedScript, 'utf8')
const fixedOut = fixedBuf.toString('utf8')
const mapFixed = parse(fixedOut)
let hitFixed = 0
for (const l of links) if (mapFixed.has(l)) hitFixed++
log(`  原始字节 ${fixedBuf.length} B`)
log(`  第一行：${JSON.stringify(fixedOut.split(/\r?\n/)[0] ?? '')}`)
log(`  命中：${hitFixed} / ${links.length}`)

log('\n' + '─'.repeat(78))
const ok = hitFixed === links.length
log(ok ? '✅ 结论：脚本内强制 UTF-8 输出可解决（中文路径全部命中）' : '❌ 强制 UTF-8 仍不足，需另找原因')
process.exit(ok ? 0 : 1)
