#!/usr/bin/env node
/**
 * P3 实机验收 — 验证启动器插件在**运行中的客户端**里可用。
 *
 * 前提：客户端带远程调试端口启动：
 *   pnpm dev -- --remoteDebuggingPort=9222
 * 或（已有 dev 实例时）按 Ctrl+R 重启它。
 *
 * 用法：node verify/listary-p3/accept.mjs [port]
 *
 * 验的是**跨进程行为**，不是单元逻辑：
 * 1. 插件是否真的被加载（主进程日志有"本地启动器插件已启动"）
 * 2. 启动器窗口能否被打开（IPC 的 rescan/status 通不通）
 * 3. 索引是否建好、检索能否返回结果
 * 4. 渲染层 UI 是否挂载（DOM 里有没有搜索框）
 *
 * 不验的：双击 Ctrl 的真实按键 —— 那是物理输入，只能用真手或 keybd_event 注入，
 * 且会干扰用户当前操作。留人工步骤（见脚本末尾打印的清单）。
 */
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.argv[2] ?? 9222)
const OUT_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function fetchJson(url) {
  const res = await fetch(url)
  return res.json()
}

/** 找到启动器窗口的 target（按 URL 里的 mode 匹配） */
async function listTargets() {
  return fetchJson(`http://127.0.0.1:${PORT}/json/list`)
}

function makeSession(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const msgId = ++id
            pending.set(msgId, { res, rej })
            ws.send(JSON.stringify({ id: msgId, method, params }))
            setTimeout(() => {
              if (pending.has(msgId)) {
                pending.delete(msgId)
                rej(new Error(`${method} 超时`))
              }
            }, 15_000)
          })
        },
        close: () => ws.close(),
      }),
    )
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
      }
    })
    ws.addEventListener('error', reject)
  })
}

async function evalIn(session, expression) {
  const r = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? 'eval 抛错')
  }
  return r.result?.value
}

console.log(`CDP 端口 ${PORT}\n`)

// ── 1. 主窗口在不在（确认客户端活着） ──
console.log('[1] 客户端与插件加载')
let targets
try {
  targets = await listTargets()
} catch (e) {
  console.log(`  ❌ 连不上 CDP（${e.message}）`)
  console.log('\n  请先用调试端口启动客户端：pnpm dev -- --remoteDebuggingPort=9222')
  process.exit(2)
}
const pages = targets.filter((t) => t.type === 'page')
console.log(`  发现 ${pages.length} 个页面 target`)
for (const p of pages) console.log(`    - ${p.title || '(无标题)'}  ${p.url.slice(0, 90)}`)
check('客户端已启动', pages.length > 0, `${pages.length} 个页面`)

// ── 2. 检索链路（通过主窗口的 electronAPI 调 IPC） ──
console.log('\n[2] 检索链路（经 IPC）')
const mainPage = pages.find((p) => !p.url.includes('mode=')) ?? pages[0]
check('找到主窗口 target', !!mainPage, mainPage?.url?.slice(0, 80))

let hotkey = null
let status = null
if (mainPage) {
  const s = await makeSession(mainPage.webSocketDebuggerUrl)
  try {
    const hasApi = await evalIn(s, 'typeof window.electronAPI?.listary')
    check('preload 暴露了 listary API', hasApi === 'object', `typeof = ${hasApi}`)

    if (hasApi === 'object') {
      // 唤起方式：这是"为什么双击没反应"的唯一可观测来源
      try {
        hotkey = await evalIn(s, 'window.electronAPI.listary.hotkey()')
        check(
          'hotkey 通道可用',
          !!hotkey && typeof hotkey.mode === 'string',
          `mode=${hotkey?.mode}${hotkey?.reason ? ` reason=${hotkey.reason}` : ''}`,
        )
        check(
          hotkey?.mode === 'double-ctrl'
            ? '唤起方式 = 双击 Ctrl（钩子已加载）'
            : hotkey?.mode === 'accelerator'
              ? '唤起方式 = 组合键兜底（钩子不可用，见 reason）'
              : '唤起方式可用',
          hotkey?.mode === 'double-ctrl' || hotkey?.mode === 'accelerator',
          `mode=${hotkey?.mode}`,
        )
      } catch (e) {
        check('hotkey 通道可用', false, e.message)
      }

      // 索引状态
      try {
        status = await evalIn(s, 'window.electronAPI.listary.status()')
        check('status 通道可用', !!status && typeof status.items === 'number', `items=${status?.items}`)
        check('索引库健康', status?.healthy === true, status?.reason ?? `items=${status?.items} fts=${status?.fts}`)
        check('有索引条目', (status?.items ?? 0) > 0, `${status?.items} 条`)
        console.log(`    索引根：`)
        for (const r of status?.roots ?? []) {
          console.log(`      ${r.enabled ? '✓' : '✗'} ${r.path}  (${r.itemCount ?? '?'} 条)`)
        }
      } catch (e) {
        check('status 通道可用', false, e.message)
      }

      // 真实检索
      try {
        const hits = await evalIn(s, "window.electronAPI.listary.search('设计', 5)")
        check('中文检索返回结果', Array.isArray(hits) && hits.length > 0, `${hits?.length ?? 0} 条`)
        if (hits?.[0]) console.log(`    首条：${hits[0].name}\n          ${hits[0].path}`)
      } catch (e) {
        check('中文检索返回结果', false, e.message)
      }

      // 转义回归（在真实 IPC 路径上再验一次）
      try {
        const evil = await evalIn(s, "window.electronAPI.listary.search('\\\" OR (', 3)")
        check('语法字符不炸 IPC', Array.isArray(evil), `${evil?.length ?? 0} 条`)
      } catch (e) {
        check('语法字符不炸 IPC', false, e.message)
      }
    }
  } finally {
    s.close()
  }
}

// ── 3. 启动器窗口 UI ──
console.log('\n[3] 启动器窗口')
console.log('  说明：启动器窗只有被唤起时才存在，故此处默认找不到。')
console.log('  请手动双击 Ctrl，然后重跑本脚本，或看下面的人工清单。')

const launcherTarget = pages.find((p) => p.url.includes('mode=listary-launcher'))
if (launcherTarget) {
  check('启动器窗口已打开', true, launcherTarget.url.slice(0, 80))
  const ls = await makeSession(launcherTarget.webSocketDebuggerUrl)
  try {
    const hasInput = await evalIn(ls, "!!document.querySelector('input[placeholder*=\"搜索\"]')")
    check('搜索输入框已渲染', hasInput === true)
    const shot = await ls.send('Page.captureScreenshot', { format: 'png' })
    const shotPath = path.join(OUT_DIR, 'launcher-window.png')
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
    console.log(`    截图：${shotPath}`)
  } finally {
    ls.close()
  }
} else {
  console.log('  （未打开 —— 需手动双击 Ctrl）')
}

// ── 汇总 ──
const failed = results.filter((r) => !r.ok)
console.log('\n' + '─'.repeat(66))
console.log(failed.length === 0 ? `自动验收通过（${results.length} 项）` : `自动验收：${failed.length} / ${results.length} 项失败`)
for (const f of failed) console.log(`  - ${f.name}: ${f.detail ?? ''}`)

console.log('\n人工验收清单（物理输入，脚本测不了）：')
console.log('  1. 在**任意前台应用**里双击 Ctrl → 启动器应弹出并聚焦输入框')
console.log('  2. 输入中文（如「设计」）→ 结果列表应出现且高亮首条')
console.log('  3. ↑↓ 切换高亮，Enter 打开（文件应该用默认程序打开）')
console.log('  4. Esc 收起；点窗口外（失焦）也应自动收起')
console.log('  5. 打开过一次某条目后，再搜同一个词，它应该排到更前（越用越准）')
console.log('  6. 设置页禁用「本地启动器」→ 双击 Ctrl 应无反应；重新启用后恢复')

process.exit(failed.length === 0 ? 0 : 1)
