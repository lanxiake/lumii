#!/usr/bin/env node
/**
 * check-pet-theme-follow.mjs — 验「宠物窗跟随主窗主题」这条链路。
 *
 * 设计与实施：docs/plans/客户端UI/2026-09-23-Agent通知与审批闭环实施计划.md §13.2
 *
 * ## 为什么要专门验它
 *
 * 这条链路的**每一段都建立在"同源窗口共享 localStorage"这个浏览器行为上**，而不是
 * 本仓库的代码：宠物窗读的是主窗写的键，变更信号靠 `storage` 事件（只发给**其他**
 * 同源 document，主窗自己收不到）。任何一段不成立，气泡就会停在旧主题的配色上——
 * **而且不报错**（`readPetTheme` 有兜底值，取错了也只是"颜色不对"）。
 *
 * ⚠️ 打包态走 `file://`，那条路径上的同源/localStorage 共享**没验过**。本脚本只覆盖
 * dev（`http://127.0.0.1:5174`）。
 *
 * ## 判据（读两个窗口的 DOM / localStorage，不看画面）
 *
 *   1. 宠物窗的 `<html>` **有** `data-theme`，且与主窗 localStorage 里的主题一致
 *   2. 主窗写 `mtbot_theme` → 宠物窗的 `data-theme` **跟着变**（这是链路的核心）
 *   3. 令牌真的换了值（`--mt-fg-1` 在 dark/light 下不同）——只验属性名会漏掉
 *      "属性写了但样式表没接上"这种半截状态
 *   4. 主窗写 settings 里别的字段（主题没变）→ 宠物窗**不动**（去重生效）
 *   5. 跑完把 localStorage 恢复原值
 *
 * ## 安全性
 *
 * 全程**只改 localStorage 的值**，不碰任何窗口的实际主题：主窗的 `ThemeContext`
 * 不监听 `storage` 事件，所以它的界面不会变。跑完恢复原值。
 *
 * ## 用法（客户端需带调试端口启动：`.\scripts\start-dev.ps1 -Force -RemoteDebug 9222`）
 *
 *   node verify/pet-sprite/check-pet-theme-follow.mjs
 */
const PORT = Number(process.env.CDP_PORT ?? 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'))
  })
  let myId = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = ++myId
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) {
      const d = r.result.exceptionDetails
      throw new Error(`evaluate 异常: ${d.exception?.description ?? d.text}`)
    }
    return r.result?.result?.value
  }
  return { ws, evaluate }
}

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`)
}

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const mainT = list.find(
    (t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:5174') && !t.url.includes('mode=pet'),
  )
  const petT = list.find((t) => t.type === 'page' && t.url.includes('mode=pet'))
  if (!mainT) throw new Error('找不到主窗')
  if (!petT) throw new Error('找不到宠物窗 —— 先进入宠物模式')

  const main = await connect(mainT)
  const pet = await connect(petT)

  const probePet = `(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    fg1: getComputedStyle(document.documentElement).getPropertyValue('--mt-fg-1').trim(),
  }))()`

  const original = await main.evaluate(`localStorage.getItem('mtbot_theme')`)
  console.log(`· 主窗 localStorage 的 mtbot_theme = ${JSON.stringify(original)}\n`)

  // 期望值：以主窗 settings 为准（与 ThemeContext.loadTheme 同序），独立 key 次之
  const expected = await main.evaluate(`(() => {
    try {
      const s = JSON.parse(localStorage.getItem('mtbot-assistant-settings') || 'null')
      const mode = s?.theme?.mode
      if (mode === 'light' || mode === 'dark' || mode === 'eye-care') return mode
      if (mode === 'system') return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    } catch {}
    const t = localStorage.getItem('mtbot_theme')
    if (t === 'light' || t === 'dark' || t === 'eye-care') return t
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })()`)

  const before = await pet.evaluate(probePet)
  record(
    '宠物窗有 data-theme，且与主窗的主题一致',
    before?.theme === expected,
    `宠物窗=${before?.theme} 期望=${expected} --mt-fg-1=${before?.fg1}`,
  )

  // ---- 翻转主题：写 localStorage（不改主窗界面），看宠物窗跟不跟 ----
  const flipTo = expected === 'dark' ? 'light' : 'dark'
  const fgBefore = before?.fg1
  await main.evaluate(`localStorage.setItem('mtbot_theme', ${JSON.stringify(flipTo)})`)
  await sleep(700)
  const after = await pet.evaluate(probePet)
  record(
    `主窗换主题（→${flipTo}）后宠物窗跟着变`,
    after?.theme === flipTo,
    `宠物窗 data-theme=${after?.theme}`,
  )
  record(
    '令牌真的换了值（不只是属性名变了）',
    Boolean(fgBefore) && Boolean(after?.fg1) && fgBefore !== after?.fg1,
    `--mt-fg-1: ${fgBefore} → ${after?.fg1}`,
  )

  // ---- 去重：主题没变时不该反复 apply ----
  // （apply 本身幂等，看不出来；这里验的是"宠物窗不会因为别的设置被写就抖"——
  //  它的解析值不变，所以 data-theme 不该动）
  await main.evaluate(`(() => {
    const raw = localStorage.getItem('mtbot-assistant-settings')
    const s = raw ? JSON.parse(raw) : {}
    s.__probe = Date.now()
    localStorage.setItem('mtbot-assistant-settings', JSON.stringify(s))
  })()`)
  await sleep(500)
  const after2 = await pet.evaluate(probePet)
  record(
    '写别的设置字段时宠物窗不动（去重生效）',
    after2?.theme === flipTo,
    `data-theme=${after2?.theme}`,
  )

  // ---- 恢复现场 ----
  if (original === null) await main.evaluate(`localStorage.removeItem('mtbot_theme')`)
  else await main.evaluate(`localStorage.setItem('mtbot_theme', ${JSON.stringify(original)})`)
  await main.evaluate(`(() => {
    const raw = localStorage.getItem('mtbot-assistant-settings')
    if (!raw) return
    const s = JSON.parse(raw)
    delete s.__probe
    localStorage.setItem('mtbot-assistant-settings', JSON.stringify(s))
  })()`)
  await sleep(700)
  const restored = await pet.evaluate(probePet)
  record(
    '恢复后宠物窗回到原主题',
    restored?.theme === expected,
    `data-theme=${restored?.theme}`,
  )

  main.ws.close()
  pet.ws.close()

  const failed = results.filter((r) => !r.pass)
  console.log('')
  if (failed.length === 0) {
    console.log('✓ 宠物窗主题跟随：实测通过')
  } else {
    console.log(`✗ ${failed.length} 条未过 —— 看上面逐条`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('✗', e.message)
  process.exit(1)
})
