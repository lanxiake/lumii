/**
 * P0-1 spike — 双击 Ctrl 的全局键盘钩子能不能用。
 *
 * 这是 P0 里唯一可能推翻 P3 主路径的一项：Electron 的 globalShortcut 注册的是**组合键**，
 * 捕获不了"Ctrl 被按了两次"的时序模式，所以双击 Ctrl 必须走低层键盘钩子。
 *
 * 本 spike 验四件事：
 *   1. uiohook-napi（N-API，win32-x64 prebuild）能否在 Electron 主进程里加载并 start()
 *   2. 双击判定算法在合成事件下的正确性（确定性，不依赖时序）—— 含 dirty 标志防 Ctrl+C 误触
 *   3. **端到端**：用 keybd_event 注入真实的低级键盘事件，看钩子是否真收到、算法是否真触发
 *   4. 记录 libuiohook 上报的键码与 injected 标志，供实现时对齐
 *
 * 不装进项目依赖：从临时目录按绝对路径 require，这样 P0 结论出来前不动 lockfile。
 *
 * 用法：pnpm exec electron verify/listary-p0/hook-spike.cjs
 * 结果写 verify/listary-p0/hook-spike.out
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { app } = require('electron')

const OUT = path.join(__dirname, 'hook-spike.out')
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

// ══════════════════════════════════════════════════════════════════
// 被测逻辑：双击 Ctrl 判定（纯函数，便于不依赖时序地单测）
// ══════════════════════════════════════════════════════════════════

/** libuiohook 的 Ctrl 键码（见 dist/index.d.ts：Ctrl=29, CtrlRight=3613） */
const CTRL_CODES = new Set([29, 3613])

function isCtrl(code) {
  return CTRL_CODES.has(code)
}

/**
 * 双击判定器。
 *
 * 关键点：一次 Ctrl 要算「有效点击」，必须这**一次按住期间没夹别的键**。
 *
 * 为什么不能用「两次 Ctrl 之间有没有别的键」（第一版就是这么写的，实测被 `Ctrl+C` 打脸）：
 * `Ctrl+C` 的事件序列是 Ctrl↓ C↓ C↑ Ctrl↑ —— C 夹在 **Ctrl 按下与松开之间**，
 * 不在两次 Ctrl 的**松开**之间。若只看"两次松开之间"，`Ctrl+C` 的收尾 Ctrl↑ 会被当成
 * 一次干净的点击，于是 100ms 内再按 Ctrl（比如 `Ctrl+V`）就触发启动器 ——
 * 而 `Ctrl+C` 紧接着 `Ctrl+V` 是极常见的操作序列，必然误弹。
 *
 * 故：Ctrl↑ 时若期间夹过别的键，则**作废**任何待配对的点击（lastUpAt 归零），
 * 而不是把它当成第一次点击。代价是 `Ctrl+C` 后必须重新连按两次 Ctrl 才能唤起，这是可接受的。
 */
function makeDetector({ thresholdMs = 400, isCtrlCode = isCtrl, now = () => Date.now() } = {}) {
  let lastUpAt = 0
  let ctrlHeld = false
  let heldDirty = false // 本次 Ctrl 按住期间是否夹了别的键
  let triggers = 0
  return {
    keydown: (code) => {
      if (isCtrlCode(code)) {
        ctrlHeld = true
        heldDirty = false
      } else if (ctrlHeld) {
        heldDirty = true // Ctrl 被当作修饰键用了（Ctrl+C / Ctrl+V ...）
      }
    },
    keyup: (code) => {
      if (!isCtrlCode(code)) return false
      const t = now()
      let fired = false
      if (heldDirty) {
        lastUpAt = 0 // 修饰键用法：作废待配对的点击
      } else if (lastUpAt !== 0 && t - lastUpAt < thresholdMs) {
        triggers++
        fired = true
        lastUpAt = 0 // 触发后重置，避免三连击变成两次触发
      } else {
        lastUpAt = t
      }
      ctrlHeld = false
      heldDirty = false
      return fired
    },
    get triggers() {
      return triggers
    },
  }
}

// ══════════════════════════════════════════════════════════════════

app.whenReady().then(async () => {
  log(`Electron ${process.versions.electron} / Node ${process.versions.node} / ABI ${process.versions.modules}`)
  log(`platform=${process.platform} arch=${process.arch}\n`)

  // ── 1. 合成事件单测（确定性） ──
  log('═'.repeat(66))
  log('[1] 双击判定算法 — 合成事件单测（不依赖真实时序）')
  log('═'.repeat(66))

  // 用一个可控的假时钟
  {
    let clock = 10_000
    const now = () => clock
    const d = makeDetector({ thresholdMs: 400, now })

    d.keydown(29); d.keyup(29) // 第一次 Ctrl
    check('单次 Ctrl 不触发', d.triggers === 0, `triggers=${d.triggers}`)

    clock += 150 // 150ms 后第二次
    d.keydown(29)
    const fired = d.keyup(29)
    check('双击 Ctrl 触发（间隔 150ms）', fired && d.triggers === 1, `triggers=${d.triggers}`)

    // 三连击：触发后重置，不应产生第二次触发
    clock += 150
    d.keydown(29); d.keyup(29)
    check('三连击只触发一次', d.triggers === 1, `triggers=${d.triggers}（触发后重置）`)
  }

  {
    let clock = 20_000
    const d = makeDetector({ thresholdMs: 400, now: () => clock })
    d.keydown(29); d.keyup(29)
    clock += 900 // 超过阈值
    d.keydown(29)
    const fired = d.keyup(29)
    check('间隔 900ms 不触发（超阈值）', !fired && d.triggers === 0, `triggers=${d.triggers}`)
  }

  {
    // 关键负例：Ctrl+C 之后按 Ctrl 不应触发
    let clock = 30_000
    const d = makeDetector({ thresholdMs: 400, now: () => clock })
    // Ctrl down → C down → C up → Ctrl up （即 Ctrl+C）
    d.keydown(29)
    d.keydown(46) // C 键码 46（libuiohook）
    d.keyup(46)
    d.keyup(29)
    check('Ctrl+C 本身不触发', d.triggers === 0, `triggers=${d.triggers}`)
    // 紧接着再按一次 Ctrl（快，看似"双击"）—— Ctrl+C 里的 C 已把这次点击作废
    clock += 100
    d.keydown(29)
    const fired = d.keyup(29)
    check(
      'Ctrl+C 后紧接 Ctrl 不触发（修饰键用法作废点击）',
      !fired && d.triggers === 0,
      `triggers=${d.triggers}`,
    )
    // 再按一次才算干净的第二次
    clock += 100
    d.keydown(29); d.keyup(29)
    check('随后再补一次 Ctrl 才触发', d.triggers === 1, `triggers=${d.triggers}`)
  }

  {
    // Ctrl+V 同理：这是 Ctrl+C 之后最常见的操作
    let clock = 35_000
    const d = makeDetector({ thresholdMs: 400, now: () => clock })
    // 先来一次干净的点击
    d.keydown(29); d.keyup(29)
    clock += 120
    // 用户改主意去粘贴：Ctrl+V
    d.keydown(29); d.keydown(47); d.keyup(47); d.keyup(29) // V=47
    check('Ctrl 单击后改用 Ctrl+V 不触发', d.triggers === 0, `triggers=${d.triggers}`)
  }

  {
    // 左右 Ctrl 混用也应识别
    let clock = 40_000
    const d = makeDetector({ thresholdMs: 400, now: () => clock, isCtrlCode: (c) => c === 29 || c === 3613 })
    d.keydown(29); d.keyup(29)
    clock += 120
    d.keydown(3613)
    const fired = d.keyup(3613)
    check('左 Ctrl + 右 Ctrl 也算双击', fired && d.triggers === 1, `triggers=${d.triggers}`)
  }

  // ── 2. 加载原生模块 ──
  log('\n' + '═'.repeat(66))
  log('[2] 在 Electron 主进程里加载 uiohook-napi')
  log('═'.repeat(66))

  const probeDir = path.join(os.tmpdir(), 'hook-probe', 'node_modules', 'uiohook-napi')
  if (!fs.existsSync(probeDir)) {
    check('找到临时安装的 uiohook-napi', false, `不存在：${probeDir}（先跑 npm install uiohook-napi）`)
    finish()
    return
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(probeDir, 'package.json'), 'utf8'))
  log(`  版本 ${pkg.version}，从临时目录按绝对路径加载（不改项目依赖）`)

  let uIOhook, UiohookKey
  try {
    const mod = require(probeDir)
    uIOhook = mod.uIOhook
    UiohookKey = mod.UiohookKey
    check('require uiohook-napi', true, `UiohookKey.Ctrl=${UiohookKey?.Ctrl} CtrlRight=${UiohookKey?.CtrlRight}`)
  } catch (e) {
    check('require uiohook-napi', false, e.message)
  }
  if (!uIOhook) {
    finish()
    return
  }

  // N-API 模块应能跨 Node/Electron ABI 使用（对比 better-sqlite3 的 ABI 127/135 问题）
  check(
    'N-API 模块在 Electron 下加载成功（无 ABI 冲突）',
    true,
    `ABI ${process.versions.modules}；N-API 不绑定 ABI，故无需为 Electron 重建`,
  )
  check('键码常量可用', UiohookKey.Ctrl === 29, `Ctrl=${UiohookKey.Ctrl}, CtrlRight=${UiohookKey.CtrlRight}`)

  // ── 3. start() 是否成功 ──
  log('\n' + '═'.repeat(66))
  log('[3] 启动钩子并端到端验证（注入真实按键事件）')
  log('═'.repeat(66))

  const seen = []
  let liveTriggers = 0

  try {
    // 钩子只负责**捕获真实事件**，不做判定。判定放在后面用捕获到的事件重放，
    // 这样可以把环境里其他程序的按键噪声过滤掉（全局钩子是收全系统输入的）。
    uIOhook.on('keydown', (e) => seen.push({ type: 'down', keycode: e.keycode, raw: e }))
    uIOhook.on('keyup', (e) => seen.push({ type: 'up', keycode: e.keycode, raw: e }))
    uIOhook.start()
    check('uIOhook.start() 未抛错', true)
  } catch (e) {
    check('uIOhook.start()', false, e.message)
    finish()
    return
  }

  // 等钩子就绪
  await sleep(700)

  // 注入器：用 keybd_event 产生真实的低级键盘事件（低层钩子能看到注入事件）
  const INJECT = `
$sig = @'
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
'@
Add-Type -Name K -Namespace W -MemberDefinition $sig
$VK_CTRL = 0x11
$VK_C    = 0x43
$UP = 2
function CtrlTap { [W.K]::keybd_event($VK_CTRL, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [W.K]::keybd_event($VK_CTRL, 0, $UP, [UIntPtr]::Zero) }
function CtrlC { [W.K]::keybd_event($VK_CTRL, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [W.K]::keybd_event($VK_C, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [W.K]::keybd_event($VK_C, 0, $UP, [UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [W.K]::keybd_event($VK_CTRL, 0, $UP, [UIntPtr]::Zero) }
switch ($args[0]) {
  'double'    { CtrlTap; Start-Sleep -Milliseconds 150; CtrlTap }
  'single'    { CtrlTap }
  'slow'      { CtrlTap; Start-Sleep -Milliseconds 900; CtrlTap }
  'ctrlc'     { CtrlC; Start-Sleep -Milliseconds 100; CtrlTap }
  'triple'    { CtrlTap; Start-Sleep -Milliseconds 150; CtrlTap; Start-Sleep -Milliseconds 150; CtrlTap }
}
`
  const psPath = path.join(__dirname, 'inject-keys.ps1')
  fs.writeFileSync(psPath, INJECT)

  function inject(mode) {
    try {
      execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath, mode], {
        timeout: 20_000,
        stdio: 'pipe',
      })
      return true
    } catch (e) {
      log(`    注入 ${mode} 失败: ${e.message}`)
      return false
    }
  }

  /** 各场景关心的键码：Ctrl 之外只有 ctrlc 关心 C(46)。其余键属环境噪声，重放时滤掉。 */
  const SCENARIO_KEYS = {
    double: new Set([29, 3613]),
    single: new Set([29, 3613]),
    slow: new Set([29, 3613]),
    ctrlc: new Set([29, 3613, 46]),
    triple: new Set([29, 3613]),
  }

  /**
   * 用捕获到的真实事件重放判定器。
   *
   * 为什么不在事件回调里直接判定：全局钩子收的是**全系统**输入，本机还有别的键盘活动，
   * 会往 seen 里混入无关按键（实测 `single` 场景混进了 C 键、`slow` 场景混进一堆数字键），
   * 把断言污染成假失败。按场景白名单过滤后重放，既用真实事件、又不受环境干扰。
   */
  function replay(keycodes) {
    // 时钟必须取事件自带的 time，不能用 Date.now()：
    // 重放是同步循环，所有事件会落在同一毫秒内，间隔全变 0，慢速双击会被误判成触发。
    let clock = 0
    const d = makeDetector({
      thresholdMs: 400,
      isCtrlCode: (c) => c === 29 || c === 3613,
      now: () => clock,
    })
    let fires = 0
    for (const ev of seen) {
      if (!keycodes.has(ev.keycode)) continue
      if (typeof ev.raw?.time === 'number') clock = ev.raw.time
      if (ev.type === 'down') d.keydown(ev.keycode)
      else if (d.keyup(ev.keycode)) fires++
    }
    return fires
  }

  async function scenario(mode, ms, expectTrigger) {
    seen.length = 0
    const t0 = Date.now()
    const ok = inject(mode)
    const injectMs = Date.now() - t0
    await sleep(ms)

    const keys = SCENARIO_KEYS[mode]
    const fires = replay(keys)
    const ctrlEvents = seen.filter((s) => keys.has(s.keycode)).length
    const noise = seen.length - ctrlEvents

    // 记录真实时间轴（供人工核对阈值）
    if (seen.length > 0) {
      const t0e = seen[0].raw?.time ?? 0
      const ups = seen.filter((s) => s.type === 'up' && keys.has(s.keycode))
      const gap = ups.length >= 2 ? `${(ups[1].raw?.time ?? 0) - (ups[0].raw?.time ?? 0)}ms` : 'n/a'
      log(
        `    真实事件 ${ctrlEvents} 个（过滤掉环境噪声 ${noise} 个），两次有效松开间隔 = ${gap}，` +
          `注入脚本耗时 ${injectMs}ms`,
      )
    }

    const pass = ok && fires === (expectTrigger ? 1 : 0)
    check(
      `注入「${mode}」→ ${expectTrigger ? '应触发' : '不应触发'}`,
      pass,
      `重放真实事件得触发 ${fires} 次`,
    )

    // 排空，避免残余事件漏进下一个场景
    let quiet = 0
    let last = seen.length
    for (let i = 0; i < 12; i++) {
      await sleep(100)
      if (seen.length === last) quiet++
      else quiet = 0
      last = seen.length
      if (quiet >= 2) break
    }
    return ctrlEvents
  }

  const totalA = await scenario('double', 900, true)
  if (totalA === 0) {
    check(
      '钩子收到真实的低级键盘事件',
      false,
      '未收到任何事件 —— 可能被安全软件拦截，或注入事件被过滤',
    )
    log('\n    提示：若注入被拦而真实按键可用，请手动连按两次 Ctrl 观察是否触发。')
  } else {
    check('钩子收到真实的低级键盘事件', true, `共 ${totalA} 个`)
    await scenario('single', 700, false)
    await scenario('slow', 1600, false)
    await scenario('ctrlc', 900, false)
    await scenario('triple', 900, true)

    // 记录实际键码与事件字段，供实现对齐
    const sample = seen.find((s) => s.keycode === 29) || seen[0]
    if (sample) {
      const keys = Object.keys(sample.raw || {})
      log(`\n  事件字段：${JSON.stringify(keys)}`)
      log(`  Ctrl 的 keycode 实测 = ${sample.keycode}（与 UiohookKey.Ctrl=29 一致：${sample.keycode === 29}）`)
      if (sample.raw && 'injected' in sample.raw) {
        log(`  injected 标志存在 = ${sample.raw.injected}（可用于区分真实按键与注入事件）`)
      } else {
        log('  未提供 injected 字段（若将来需过滤注入事件，要走别的方式）')
      }
    }
  }

  try {
    uIOhook.stop()
    check('uIOhook.stop() 未抛错', true)
  } catch (e) {
    check('uIOhook.stop()', false, e.message)
  }

  finish()
})

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function finish() {
  const failed = results.filter((r) => !r.ok)
  log('\n' + '─'.repeat(66))
  if (failed.length === 0) {
    log(`P0-1 结论：通过（${results.length} 项）`)
    log('  - 双击判定算法正确，含 dirty 标志防 Ctrl+C 误触、三连击只触发一次、左右 Ctrl 混用')
    log('  - uiohook-napi（N-API）在 Electron 主进程内加载并 start() 成功，无需 ABI 重建')
    log('  - 端到端：真实低级键盘事件被捕获，算法正确触发/不触发')
  } else {
    log(`P0-1 结论：不通过 / 部分通过（${failed.length} / ${results.length} 项失败）`)
    for (const f of failed) log(`  - ${f.name}: ${f.detail || ''}`)
  }
  log('─'.repeat(66))
  app.exit(failed.length === 0 ? 0 : 1)
}
