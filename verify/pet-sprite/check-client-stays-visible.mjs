#!/usr/bin/env node
/**
 * 验：宠物模式下**主窗口（客户端）是否仍然显示**。
 *
 * ## 为什么用 HWND 而不是"看截图/看进程"
 *
 * - **看进程数**不行：Electron 的所有 BrowserWindow 属于同一个主进程，`Get-Process`
 *   的 `MainWindowHandle` 只会给出其中一个，判断不了"主窗口是不是被藏了"。
 * - **看截图**不行：宠物窗口是全屏透明覆盖层，截图里主窗口与桌面混在一起，
 *   「有没有主窗口」得靠人眼看，不是判据。
 *
 * 可靠判据是**盯住主窗口那个具体的 HWND**：进宠物模式前记下它，进之后再问一次
 * `IsWindowVisible(同一个 hwnd)`。主窗口在 `enterPetMode` 里不会被重建，HWND 不变；
 * 被 `hide()` 过的话这个值就是 false。这是二值判据，没有"看起来像"。
 *
 * ## 背景（2026-09-21）
 *
 * 提交 680a4bff 把 `enterPetMode` 从「隐藏主窗口」改成「主窗常驻」（为 R9 攀附
 * 提供一个可爬的对象）。本脚本就是那条改动的验收判据。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { makeAppUiPost, readAppUiConfig, sleep } from './lib/pet-frame.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const post = makeAppUiPost(readAppUiConfig())

const PREFIX =
  "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;" +
  "public class LumiiWinApi{[DllImport(\"user32.dll\")]public static extern bool IsWindowVisible(IntPtr h);}' ;"

function ps(cmd) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PREFIX + cmd], {
    encoding: 'utf-8',
  }).trim()
}

/** 主窗口 HWND：唯一一个 MainWindowHandle 非零的 electron 进程 */
function mainWindowHandle() {
  const out = ps(
    "(Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle",
  )
  const n = Number(out)
  return Number.isFinite(n) && n > 0 ? n : null
}

const isVisible = (hwnd) => ps(`[LumiiWinApi]::IsWindowVisible([IntPtr]${hwnd})`) === 'True'

/**
 * CDP 能看到的页面 target。
 *
 * 别用 `Get-Process` 的 `MainWindowHandle` 去数窗口——Electron 的所有 BrowserWindow
 * 属于同一个主进程，那个字段只会给出其中一个，数出来永远是 1（实测踩过）。
 * CDP 是 per-page 的，主窗口与宠物窗口各是一个 target，数得准。
 */
function cdpTargets() {
  const out = execFileSync('node', [join(ROOT, 'scripts', 'lumii-cdp.mjs'), 'list'], {
    encoding: 'utf-8',
  })
  const pages = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('page |') && !l.includes('devtools://'))
  return {
    main: pages.filter((l) => !l.includes('mode=pet')).length,
    pet: pages.filter((l) => l.includes('mode=pet')).length,
  }
}

// ---- 1. 回到桌面模式，拿干净的基线 ----
await post('/ipc/pet/switchMode', { mode: 'desktop' })
await sleep(2500)

const hwnd = mainWindowHandle()
if (!hwnd) {
  console.log('✗ 找不到主窗口句柄——客户端没在跑？')
  process.exit(1)
}
const beforeVisible = isVisible(hwnd)
console.log(`主窗口 HWND=${hwnd}，进入宠物模式前 visible=${beforeVisible}`)
if (!beforeVisible) {
  console.log('✗ 基线就不对（主窗口本来就不可见），本轮作废')
  process.exit(1)
}

// ---- 2. 进宠物模式 ----
const res = await post('/ipc/pet/switchMode', { mode: 'pet', modelId: 'demo_shimeji_nekojapan' })
console.log(`switchMode → ${JSON.stringify(res)?.slice(0, 120)}`)
await sleep(3000)

// ---- 3. 判据：同一个 HWND 还在不在 ----
const afterVisible = isVisible(hwnd)
const tg = cdpTargets()

console.log(`\n进入宠物模式后：同一个主窗口 HWND visible=${afterVisible}`)
console.log(`CDP target：主窗口 ${tg.main} 个 / 宠物窗口 ${tg.pet} 个（两个都该是 1）`)

console.log('\n===== 判定 =====')
if (afterVisible && tg.main >= 1 && tg.pet >= 1) {
  console.log('✓ 主窗口在宠物模式下**仍然显示**——「客户端与宠物同时显示」成立')
} else if (!afterVisible) {
  console.log('✗ 主窗口被隐藏了！「同时显示」不成立，需要查是哪条路径 hide 的')
} else {
  console.log(`✗ 主窗口还在，但 target 数不对（主 ${tg.main} / 宠物 ${tg.pet}）——宠物窗口可能没起来`)
}

// ---- 4. 还原桌面模式 ----
await post('/ipc/pet/switchMode', { mode: 'desktop' })
console.log('\n已还原桌面模式')
// 用 exitCode 而不是 exit()：进程里有 fetch 的 keep-alive socket 与 execFileSync 的句柄，
// 硬退会撞 libuv 的 UV_HANDLE_CLOSING 断言（实测噪音，但会盖掉上面几行判定）
process.exitCode = afterVisible && tg.pet >= 1 ? 0 : 2
