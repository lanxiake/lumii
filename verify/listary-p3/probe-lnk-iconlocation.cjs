/**
 * 「快捷方式的**原有图标**」到底从哪来。
 *
 * 用户澄清（2026-11-15）：不是要彩色图标，是要**和资源管理器里显示的那个一模一样**，
 * 这样一眼能认出是哪个软件。
 *
 * 上一版按 `TargetPath` 取图标 —— 那只是"目标程序的默认图标"。
 * 快捷方式真正显示的是 **`IconLocation`**（`.lnk` 的图标路径 + 索引）：
 * 用户可以在属性里自定义，很多安装程序也会写这一项（指向自己的 .ico）。
 * IconLocation 为空时才回退到目标程序的图标。
 *
 * 本探针要回答三件事：
 *   1. 本机快捷方式里有多少带自定义 IconLocation、形式长什么样
 *   2. Electron 的 `app.getFileIcon` 对 `.ico` 路径给不给得出东西
 *   3. IconLocation 带索引（`foo.dll,3`）时怎么取到那一个
 *
 * 用法：pnpm exec electron verify/listary-p3/probe-lnk-iconlocation.cjs
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { app, nativeImage } = require('electron')

const OUT = path.join(__dirname, 'iconlocation.out')
const lines = []
fs.rmSync(OUT, { force: true })
function log(s) {
  lines.push(s)
  process.stdout.write(s + '\n')
  fs.writeFileSync(OUT, lines.join('\n') + '\n')
}

const START_MENU = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
const DESKTOP = path.join(process.env.USERPROFILE ?? '', 'Desktop')

function collectLinks(dirs, max) {
  const out = []
  for (const d of dirs) {
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isFile() && e.name.toLowerCase().endsWith('.lnk')) {
          out.push(path.join(d, e.name))
          if (out.length >= max) return out
        }
      }
    } catch {
      /* 目录不存在 */
    }
  }
  return out
}

/** 读 IconLocation + TargetPath（一次 PowerShell 批量） */
function readLinks(links) {
  return new Promise((resolve) => {
    if (links.length === 0) return resolve(new Map())
    const arr = links.map((p) => `'${p.replace(/'/g, "''")}'`).join(',')
    const script =
      `$sh = New-Object -ComObject WScript.Shell; ` +
      `foreach ($p in @(${arr})) { try { ` +
      `  $s = $sh.CreateShortcut($p); ` +
      `  Write-Output ($p + "\`t" + $s.TargetPath + "\`t" + $s.IconLocation) ` +
      `} catch { } }`
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 20000, windowsHide: true },
      (err, so) => {
        const map = new Map()
        if (!err && so) {
          for (const line of String(so).split(/\r?\n/)) {
            const parts = line.split('\t')
            if (parts.length < 3) continue
            map.set(parts[0].trim(), { target: parts[1].trim(), iconLocation: parts[2].trim() })
          }
        }
        resolve(map)
      },
    )
  })
}

async function iconPng(p) {
  try {
    const img = await app.getFileIcon(p, { size: 'large' })
    return img.isEmpty() ? null : img.toPNG()
  } catch {
    return null
  }
}

app.whenReady().then(async () => {
  log(`Electron ${process.versions.electron}\n`)

  const links = collectLinks([START_MENU, DESKTOP], 10)
  if (links.length === 0) {
    log('本机没有快捷方式，跳过')
    app.exit(0)
    return
  }

  log('═'.repeat(78))
  log('[1] 快捷方式的 IconLocation vs TargetPath')
  log('═'.repeat(78))
  const info = await readLinks(links)
  let withIcon = 0
  for (const l of links) {
    const i = info.get(l)
    if (!i) {
      log(`  ${path.basename(l).padEnd(24)} 读失败`)
      continue
    }
    const hasIcon = !!i.iconLocation && i.iconLocation !== ',0'
    if (hasIcon) withIcon++
    log(`  ${path.basename(l).padEnd(24)}`)
    log(`      target : ${i.target || '(空)'}`)
    log(`      iconLoc: ${i.iconLocation || '(空)'}${hasIcon ? '  ← 自定义' : ''}`)
  }
  log(`\n  带自定义 IconLocation 的：${withIcon} / ${links.length}`)

  log('\n' + '═'.repeat(78))
  log('[2] app.getFileIcon 能不能直接吃 .ico')
  log('═'.repeat(78))
  const icoLinks = links.filter((l) => {
    const il = info.get(l)?.iconLocation ?? ''
    return il.toLowerCase().endsWith('.ico')
  })
  if (icoLinks.length === 0) {
    log('  本机没有指向独立 .ico 的快捷方式，跳过')
    // 找一个系统 .ico 兜底测 API 行为
    const sysIco = 'C:\\Windows\\System32\\shell32.dll'
    log(`  改用系统资源测 API 行为：${sysIco}`)
  } else {
    for (const l of icoLinks.slice(0, 3)) {
      const icoPath = info.get(l).iconLocation
      const b = await iconPng(icoPath)
      log(`  ${path.basename(l).padEnd(24)} → ${icoPath}`)
      log(`      getFileIcon → ${b ? b.length + ' B' : '空'}`)
      // 也试 nativeImage 直接读
      const ni = nativeImage.createFromPath(icoPath)
      log(`      nativeImage → ${ni.isEmpty() ? '空' : JSON.stringify(ni.getSize())}`)
    }
  }

  log('\n' + '═'.repeat(78))
  log('[3] 同一 lnk：IconLocation 图标 vs TargetPath 图标 是否不同')
  log('═'.repeat(78))
  for (const l of links.slice(0, 6)) {
    const i = info.get(l)
    if (!i) continue
    const name = path.basename(l)
    const byLink = await iconPng(l) // Windows 给 lnk 自己的（可能是通用箭头）
    const byTarget = i.target && fs.existsSync(i.target) ? await iconPng(i.target) : null

    // IconLocation 的第一段（去掉 ,index）
    const iconFile = (i.iconLocation || '').split(',')[0]
    const byIconLoc = iconFile && fs.existsSync(iconFile) ? await iconPng(iconFile) : null

    log(`  ${name.padEnd(24)}`)
    log(`      lnk 本身      ${byLink ? byLink.length + ' B' : '空'}`)
    log(`      TargetPath    ${byTarget ? byTarget.length + ' B' : '空'}`)
    log(`      IconLocation  ${byIconLoc ? byIconLoc.length + ' B' : '空'}  (${iconFile || '无'})`)
  }

  log('\n' + '═'.repeat(78))
  log('[4] 带索引的 IconLocation（foo.dll,3）怎么取第 3 个')
  log('═'.repeat(78))
  log('  getFileIcon 只给"文件的主图标"，取不到指定索引。' )
  log('  试 PowerShell ExtractIconEx（Win32 shell32 的原生能力）：')
  const testDll = 'C:\\Windows\\System32\\imageres.dll'
  const idx = 3
  const script = `
Add-Type -AssemblyName System.Drawing
$src = @'
using System;
using System.Runtime.InteropServices;
public class IconEx {
  [DllImport("shell32.dll", CharSet=CharSet.Auto)]
  public static extern uint ExtractIconEx(string lpszFile, int nIconIndex, IntPtr[] phiconLarge, IntPtr[] phiconSmall, uint nIcons);
}
'@
Add-Type -TypeDefinition $src
$large = New-Object IntPtr[] 1
$small = New-Object IntPtr[] 1
$n = [IconEx]::ExtractIconEx('${testDll.replace(/'/g, "''")}', ${idx}, $large, $small, 1)
if ($n -gt 0 -and $large[0] -ne [IntPtr]::Zero) {
  $icon = [System.Drawing.Icon]::FromHandle($large[0])
  $bmp = $icon.ToBitmap()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  [Convert]::ToBase64String($ms.ToArray())
}
`
  try {
    const b64 = await new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (e, so) => (e ? reject(e) : resolve(String(so ?? '').trim())),
      )
    })
    log(`    ${testDll},${idx} → ${b64 ? b64.length + ' 字符 base64' : '空'}`)
    if (b64) {
      log(`    ✅ ExtractIconEx 可用（',index' 能精确取到第 N 个图标）`)
      const png = Buffer.from(b64, 'base64')
      log(`    PNG ${png.length} B`)
    } else {
      log(`    ⚠️ 没取到（可能索引越界）`)
    }
  } catch (e) {
    log(`    ❌ ExtractIconEx 失败：${String(e.message).split('\n')[0]}`)
  }

  const failed = []
  log('\n' + '─'.repeat(78))
  log(failed.length === 0 ? '探针完成' : `${failed.length} 项失败`)
  app.exit(0)
})
