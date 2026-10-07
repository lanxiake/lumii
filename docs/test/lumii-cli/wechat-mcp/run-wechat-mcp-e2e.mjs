#!/usr/bin/env node
/**
 * 微信 MCP 集成 · CLI E2E 套件（WM 套件）
 *
 * 全部经 lumii-ui CLI 驱动真实运行的客户端 + 真实 LLM，验证「Agent 通过 MCP 读/写微信」：
 * - WM-01 工具注册：tools list 含全部 mcp__wechat-local__* 且 enabled
 * - WM-02 环境检查：check_env → ok + 字段齐全（进程/可见/最小化/前台/尺寸·比例/DPI）
 * - WM-03 Agent 读会话：list_sessions 返回含「文件传输助手」
 * - WM-04 Agent 读历史：read_history(filehelper,3) 与库内最近消息一致
 * - WM-05 dry-run 发送：Agent 调 send_text(dry_run=true) → 报成功但**库内无痕**（全库扫描）
 * - WM-06 真发送：Agent 调 send_text(dry_run=false) → **库内出现该标记**（轮询）
 * - WM-07 fail-closed：目标不存在 → Agent 报失败且**全库无痕**
 * - WM-08 回归：普通聊天不受影响
 * - WM-09 环境不满足（窗口最小化）→ 拒绝发送且无痕
 * - WM-10 发图片（内联，落库 type=3）；WM-11 发文件（附件，落库 type=49）
 * - WM-12 会话定位：Agent 用 list_sessions(query) 按关键词定位到目标
 * - WM-13 错误码：目标不存在 → 稳定 error_code=target_not_found
 * - WM-14 并发互斥：持锁时第二次返回 busy（确定性，不走 LLM）
 * - WM-15 批量发送：Agent 调 send_batch(dry_run=true) → 报成功但**库内无痕**
 * - WM-16 群/单聊结构反证：误开另一类会话 → `verify_target` 拒绝（双向 fail-closed，确定性）
 * - WM-17 引用回复：Agent 调 reply_to(dry_run=true) → 报成功但**库内无痕**
 * - WM-18 蒸馏 digest：`core.digest` 结构/跨分片/全局·单会话一致（确定性）
 * - WM-19 蒸馏画像：`profile_save/get` 落盘·读回·列出 + 历史带 `from_me`（确定性）
 * - WM-20 蒸馏清除：`distill_clear` 单 scope / 防误清 / everything（确定性，临时目录）
 *
 * 微信侧断言用 `apps/windows/resources/wechat-mcp/devcli.py`（只读、固定动作脚本），不经 LLM。
 * 规范：docs/test/lumii-cli/CLI-TEST-SPEC.md
 * 用法：node docs/test/lumii-cli/wechat-mcp/run-wechat-mcp-e2e.mjs
 * 环境变量：WM_ONLY=WM-05,WM-06、WM_TURN_TIMEOUT_MS、LUMII_WECHAT_PYTHON
 *
 * 副作用与恢复：只在微信「文件传输助手」（自己给自己）会话里发探针消息，不打扰他人；
 *                会话用 [wechat-mcp] 前缀，保留便于排查。
 */

import path from 'node:path'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as h from '../lib/cli-harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WX_DIR = path.join(h.ROOT, 'apps/windows/resources/wechat-mcp')
const DEVCLI = path.join(WX_DIR, 'devcli.py')
const PY = process.env.LUMII_WECHAT_PYTHON || 'python'
const PREFIX = '[wechat-mcp]'
const TURN_TIMEOUT = Number(process.env.WM_TURN_TIMEOUT_MS) || 240000
const ONLY = (process.env.WM_ONLY || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
const selected = (id) => !ONLY.length || ONLY.some((t) => id.toUpperCase().includes(t))

/** 便于「没发出去」的断言：带时间戳的唯一标记 */
const stamp = () => new Date().toISOString().replace(/[-:T.]/g, '').slice(4, 14)
const MARK_DRY = `WM-DRY-${stamp()}`
const MARK_REAL = `WM-REAL-${stamp()}`
const MARK_FAIL = `WM-FAIL-${stamp()}`
const MARK_BATCH = `WM-BATCH-${stamp()}`
const MARK_REPLY = `WM-REPLY-${stamp()}`

const ev = h.createEvidence(__dirname, 'wechat-mcp', '微信 MCP 集成 · CLI E2E')
const fails = { count: 0 }

// ────────────────────────────────────────────────
// 微信侧只读断言（走 devcli.py，固定动作、不经 LLM）
// ────────────────────────────────────────────────
function devcli(args, timeoutMs = 90000) {
  return spawnSync(PY, [DEVCLI, ...args], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
}
function devJson(args) {
  const r = devcli(args)
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop()
  if (!line) throw new Error(`devcli ${args[0]} 无输出（stderr: ${(r.stderr || '').slice(0, 200)}）`)
  try {
    return JSON.parse(line)
  } catch {
    throw new Error(`devcli ${args[0]} 输出非 JSON：${line.slice(0, 200)}`)
  }
}
const wxStatus = () => devJson(['status'])
const wxHistory = (talker, n = 5) => devJson(['history', talker, String(n)])
const wxScan = (marker) => devJson(['scan', marker])

/** 文件传输助手当前最新一条的时间戳（探针断言基线） */
function wxLatestTs() {
  const h1 = wxHistory('filehelper', 1)
  return h1.messages?.[0]?.ts ?? 0
}
/** 文件传输助手里比基线更新的消息 */
function wxNewerThan(ts) {
  return wxHistory('filehelper', 5).messages.filter((m) => m.ts > ts)
}

/** 生成一张探针图片（供 send_file 测试），返回绝对路径 */
function makeProbeImage() {
  const p = path.join(__dirname, 'wm-probe.png')
  const ps =
    "Add-Type -AssemblyName System.Drawing;" +
    "$b=New-Object System.Drawing.Bitmap(200,100);" +
    "$g=[System.Drawing.Graphics]::FromImage($b);" +
    "$g.Clear([System.Drawing.Color]::Coral);" +
    "$g.Dispose();" +
    `$b.Save('${p.replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png);` +
    '$b.Dispose()'
  spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 30000 })
  return p
}

/** 生成一个探针文本文件（供 send_file 测试），返回绝对路径 */
function makeProbeFile() {
  const p = path.join(__dirname, 'wm-probe.txt')
  fs.writeFileSync(p, `Lumii WM probe file ${stamp()}\n`, 'utf8')
  return p
}

/** 文件传输助手里比基线更新、且类型命中的消息 */
function wxNewerTyped(ts, type) {
  return wxNewerThan(ts).filter((m) => (m.type & 0xffffffff) === type)
}

/** 最小化 / 还原微信主窗口（SW_MINIMIZE=6 / SW_RESTORE=9）——用于验证「窗口不可用时拒绝发送」 */
function setWechatMinimized(min) {
  const st = wxStatus()
  h.assert(st.hwnd, '取不到微信窗口句柄')
  const code =
    "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;" +
    "public class W{[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h,int c);}';" +
    `[W]::ShowWindow([IntPtr]${st.hwnd}, ${min ? 6 : 9}) | Out-Null`
  return spawnSync('powershell', ['-NoProfile', '-Command', code], { encoding: 'utf8', timeout: 20000 })
}

/** 兜底：套件异常退出时也要把微信还原 */
function restoreWechatWindow() {
  try {
    setWechatMinimized(false)
  } catch {
    /* ignore */
  }
}
process.on('exit', restoreWechatWindow)
process.on('SIGINT', () => {
  restoreWechatWindow()
  process.exit(130)
})

// ────────────────────────────────────────────────
// 预检
// ────────────────────────────────────────────────
let SESSION = null

function preflight() {
  const r = h.ui(['status'], { retries: 0, timeoutMs: 15000 })
  h.assert(r.code === 0 && !/app_not_running/.test(r.out), `Lumii 客户端未运行（退出码 ${r.code}）`)
  const st = wxStatus()
  h.assert(st.weixin_running, '微信进程未运行')
  h.assert(st.ok, `微信窗口不可用：${st.reason}`)
  return st
}

function newSession(title) {
  return h.createSession(title, { prefix: PREFIX })
}

// ────────────────────────────────────────────────
// 用例
// ────────────────────────────────────────────────
async function main() {
  console.log('=== 微信 MCP 集成 · CLI E2E ===\n')
  const st = preflight()
  ev.record('WM-00', 'INFO', `预检通过：微信进程运行、窗口 ok（尺寸 ${st.size}，dpi ${st.dpi}）`)

  // WM-01 工具注册
  if (selected('WM-01')) {
    h.runCase(ev, 'WM-01', () => {
      const r = h.okJson(h.ui(['tools', 'list']), 'tools list')
      const list = Array.isArray(r) ? r : (r.tools ?? [])
      const wx = list.filter((t) => String(t.name).startsWith('mcp__wechat-local__'))
      h.assert(wx.length >= 5, `wechat-local 工具数 ${wx.length} < 5`)
      const disabled = wx.filter((t) => t.enabled === false)
      h.assert(disabled.length === 0, `有未启用的 wechat-local 工具：${disabled.map((t) => t.name).join(',')}`)
      return `${wx.length} 个 wechat MCP 工具已注册并启用（${wx.map((t) => t.name.split('__').pop()).join(', ')}）`
    }, { fails })
  }

  // WM-02 环境检查
  if (selected('WM-02')) {
    h.runCase(ev, 'WM-02', () => {
      const s = wxStatus()
      for (const k of ['weixin_running', 'visible', 'minimized', 'foreground', 'size', 'ratio', 'dpi', 'ok']) {
        h.assert(k in s, `check_env 缺字段 ${k}`)
      }
      h.assert(s.ok === true, `环境 ok=false：${s.reason}`)
      return `环境正常：进程运行、窗口可见未最小化、尺寸 ${s.size}（比例 ${s.ratio}，dpi ${s.dpi}）`
    }, { fails })
  }

  // WM-03 / WM-04 Agent 读
  if (selected('WM-03') || selected('WM-04')) {
    SESSION = SESSION || newSession('读会话与历史')
    if (selected('WM-03')) {
      h.runCase(ev, 'WM-03', () => {
        const { text } = h.sendAndWait(
          SESSION,
          '请调用 list_sessions 工具列出我的微信会话，把返回的会话名贴出来。',
          { timeoutMs: TURN_TIMEOUT },
        )
        h.assert(/文件传输助手/.test(text), `回复里没有「文件传输助手」：${text.slice(0, 200)}`)
        return 'Agent 经 list_sessions 读到会话列表（含「文件传输助手」）'
      }, { fails })
    }
    if (selected('WM-04')) {
      h.runCase(ev, 'WM-04', () => {
        const hist = wxHistory('filehelper', 3)
        const latest = hist.messages?.[hist.messages.length - 1]?.text ?? ''
        const { text } = h.sendAndWait(
          SESSION,
          '请调用 read_history 工具读 filehelper（文件传输助手）最近 3 条消息，原样贴出来。',
          { timeoutMs: TURN_TIMEOUT },
        )
        // 断言：Agent 至少贴出了库内最近一条消息的前若干字（容忍 OCR/换行差异）
        const key = latest.replace(/[\s「」""]/g, '').slice(0, 6)
        h.assert(key.length >= 2 && text.replace(/\s/g, '').includes(key),
          `回复未包含最近历史「${latest.slice(0, 20)}」：${text.slice(0, 200)}`)
        return `Agent 经 read_history 读到 filehelper 最近消息（含「${latest.slice(0, 16)}」）`
      }, { fails })
    }
  }

  // WM-05 dry-run 发送（必须无痕）
  if (selected('WM-05')) {
    SESSION = SESSION || newSession('dry-run 发送')
    h.runCase(ev, 'WM-05', () => {
      const before = wxLatestTs()
      const { text } = h.sendAndWait(
        SESSION,
        `请调用 send_text 工具，向 文件传输助手 发送内容「${MARK_DRY}」，但 dry_run 设为 true（只校验、不真发）。把工具返回原样贴出来。`,
        { timeoutMs: TURN_TIMEOUT },
      )
      h.assert(/"ok"\s*:\s*true/.test(text) || /dry-?run/i.test(text), `dry-run 未报成功：${text.slice(0, 200)}`)
      h.sleep(3000)
      const extra = wxNewerThan(before)
      const scan = wxScan(MARK_DRY)
      h.assert(extra.length === 0 && scan.hits.length === 0,
        `dry-run 竟然落库了：基线后新增 ${extra.length} 条 / 全库扫描命中 ${scan.hits.length}`)
      return `dry-run 校验通过、未发送（基线后新增 0 条；扫描 ${scan.tables_scanned} 张表命中 0）`
    }, { fails })
  }

  // WM-06 真发送（必须落库）
  if (selected('WM-06')) {
    SESSION = SESSION || newSession('真发送')
    h.runCase(ev, 'WM-06', () => {
      const before = wxLatestTs()
      h.sendAndWait(
        SESSION,
        `请调用 send_text 工具，向 文件传输助手 真实发送一条消息（dry_run 设为 false），内容：「${MARK_REAL}」。把结果贴出来。`,
        { timeoutMs: TURN_TIMEOUT },
      )
      // 微信落库有延迟（且新消息可能先落 -wal），轮询「基线之后出现新消息」
      const landed = h.pollUntil(() => wxNewerThan(before).length > 0, 45000, 4000)
      h.assert(landed, `基线 ts=${before} 之后未见新消息（可能未发出或读取滞后）`)
      const got = wxNewerThan(before).map((m) => m.text).join(' | ')
      return `真发送成功并落库：${got.slice(0, 60)}`
    }, { fails })
  }

  // WM-07 fail-closed（目标不存在 → 中止且无痕）
  if (selected('WM-07')) {
    SESSION = SESSION || newSession('fail-closed')
    h.runCase(ev, 'WM-07', () => {
      const before = wxLatestTs()
      const { text } = h.sendAndWait(
        SESSION,
        `请调用 send_text 工具，向一个**不存在**的会话（名字叫「不存在的会话XYZQ」）发内容「${MARK_FAIL}」，dry_run 设为 false。把工具返回原样贴出来。`,
        { timeoutMs: TURN_TIMEOUT },
      )
      h.assert(/"ok"\s*:\s*false/.test(text) || /未找到|中止|fail/i.test(text), `未按预期失败：${text.slice(0, 200)}`)
      h.sleep(3000)
      const extra = wxNewerThan(before)
      const scan = wxScan(MARK_FAIL)
      h.assert(extra.length === 0 && scan.hits.length === 0,
        `fail-closed 竟然落库了：基线后新增 ${extra.length} 条 / 全库扫描命中 ${scan.hits.length}`)
      return '目标不存在时中止且未发出（基线后新增 0 条 + 全库扫描命中 0）'
    }, { fails })
  }

  // WM-10 Agent 发**图片**（内联图片，落库 type=3）
  if (selected('WM-10')) {
    SESSION = SESSION || newSession('发图片')
    h.runCase(ev, 'WM-10', () => {
      const img = makeProbeImage()
      const before = wxLatestTs()
      const { text } = h.sendAndWait(
        SESSION,
        `请调用 send_file 工具，向 文件传输助手 发送图片（dry_run 设为 false），path 用「${img}」。把工具返回原样贴出来。`,
        { timeoutMs: TURN_TIMEOUT },
      )
      const landed = h.pollUntil(() => wxNewerTyped(before, 3).length > 0, 45000, 4000)
      h.assert(landed, `图片未落库（type=3）：回复=${text.slice(0, 160)}`)
      return 'Agent 经 send_file 发送图片成功并落库（type=3）'
    }, { fails })
  }

  // WM-11 Agent 发**文件**（附件，落库 type=49）
  if (selected('WM-11')) {
    SESSION = SESSION || newSession('发文件')
    h.runCase(ev, 'WM-11', () => {
      const f = makeProbeFile()
      const before = wxLatestTs()
      const { text } = h.sendAndWait(
        SESSION,
        `请调用 send_file 工具，向 文件传输助手 发送文件（dry_run 设为 false），path 用「${f}」。把工具返回原样贴出来。`,
        { timeoutMs: TURN_TIMEOUT },
      )
      const landed = h.pollUntil(() => wxNewerTyped(before, 49).length > 0, 45000, 4000)
      h.assert(landed, `文件未落库（type=49）：回复=${text.slice(0, 160)}`)
      return 'Agent 经 send_file 发送文件成功并落库（type=49）'
    }, { fails })
  }

  // WM-09 环境不满足时应拒绝（窗口最小化）——旧版「手工用例」的自动化版
  if (selected('WM-09')) {
    h.runCase(ev, 'WM-09', () => {
      const before = wxLatestTs()
      setWechatMinimized(true)
      h.sleep(1500)
      try {
        const st = wxStatus()
        h.assert(st.minimized === true, `最小化未生效：${JSON.stringify(st.size)}`)
        h.assert(st.ok === false, '最小化后 check_env 仍报 ok=true')
        // 直接走固定动作脚本（不经 LLM），确定性地验证「拒绝发送」
        const r = devcli(['send', 'filehelper', `WM-MIN-${stamp()}`])
        const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop() || ''
        let j = null
        try {
          j = JSON.parse(line)
        } catch {
          /* fallthrough */
        }
        h.assert(j && j.ok === false, `最小化时发送未被拒：${line.slice(0, 200)}`)
        h.assert(/最小化|不可见|前置检查/.test(j.detail || ''), `拒绝理由不符：${j.detail}`)
        // 同口径复核：最小化期间确实没落库
        const extra = wxNewerThan(before)
        h.assert(extra.length === 0, `最小化期间竟然发出去了：${extra.map((m) => m.text).join('|')}`)
        return `窗口最小化时被拒且无痕：${String(j.detail).slice(0, 44)}`
      } finally {
        setWechatMinimized(false)
        h.sleep(1200)
      }
    }, { fails })
  }

  // WM-12 会话定位：Agent 用 list_sessions(query) 按关键词定位
  if (selected('WM-12')) {
    SESSION = SESSION || newSession('会话定位')
    h.runCase(ev, 'WM-12', () => {
      const { text } = h.sendAndWait(SESSION,
        '调用 list_sessions 工具，用 query 参数按关键词「测试」过滤，把命中的会话名和 talker 贴出来。',
        { timeoutMs: TURN_TIMEOUT })
      h.assert(/测试微信群/.test(text) && /50313322756@chatroom/.test(text),
        `未按关键词定位到目标：${text.slice(0, 200)}`)
      return 'Agent 经 list_sessions(query) 定位到「测试微信群」(50313322756@chatroom)'
    }, { fails })
  }

  // WM-13 错误码：目标不存在 → 稳定 error_code
  if (selected('WM-13')) {
    SESSION = SESSION || newSession('错误码')
    h.runCase(ev, 'WM-13', () => {
      const { text } = h.sendAndWait(SESSION,
        '调用 send_text 工具，向一个**不存在**的会话「不存在XYZQ」发内容「测试」，dry_run 传 true，把工具返回原样贴出来。',
        { timeoutMs: TURN_TIMEOUT })
      h.assert(/target_not_found/.test(text), `未见稳定错误码 target_not_found：${text.slice(0, 200)}`)
      return '目标不存在时返回稳定错误码 target_not_found（Agent 可据此决策）'
    }, { fails })
  }

  // WM-14 并发互斥：持锁时第二次拿不到（确定性，不走 LLM）
  if (selected('WM-14')) {
    h.runCase(ev, 'WM-14', () => {
      const code = [
        'import sys',
        `sys.path.insert(0, r"${WX_DIR}")`,
        'import wechat_sender as S',
        'lk = S._acquire_ui()',
        'print("first=", bool(lk))',
        'print("second=", S._acquire_ui(timeout=1))',
        'S._release_ui(lk)',
        'print("after=", bool(S._acquire_ui(timeout=1)))',
      ].join(String.fromCharCode(10))
      const r = spawnSync(PY, ['-c', code], { encoding: 'utf8', timeout: 60000 })
      const out = r.stdout || ''
      h.assert(/first= True/.test(out), `首次拿锁失败：${out.slice(0, 160)}`)
      h.assert(/second= None/.test(out), `持锁时第二次竟拿到锁：${out.slice(0, 160)}`)
      h.assert(/after= True/.test(out), `释放后未能重新拿锁：${out.slice(0, 160)}`)
      return '并发互斥生效：持锁时第二次返回 busy（None），释放后可重入'
    }, { fails })
  }

  // WM-15 批量发送（dry-run 必须无痕）
  if (selected('WM-15')) {
    SESSION = SESSION || newSession('批量发送')
    h.runCase(ev, 'WM-15', () => {
      const before = wxLatestTs()
      const { text } = h.sendAndWait(
        SESSION,
        `请调用 send_batch 工具做一次**批量发送演练**：messages 传 [{"talker":"filehelper","text":"${MARK_BATCH}"}]，dry_run 传 true（只校验、不真发）。把工具返回原样贴出来。`,
        { timeoutMs: TURN_TIMEOUT },
      )
      h.assert(/dry-?run|"ok"\s*:/i.test(text), `未报 dry-run：${text.slice(0, 200)}`)
      h.sleep(3000)
      const extra = wxNewerThan(before)
      const scan = wxScan(MARK_BATCH)
      h.assert(extra.length === 0 && scan.hits.length === 0,
        `dry-run 批量竟然落库：基线后新增 ${extra.length} 条 / 全库扫描命中 ${scan.hits.length}`)
      return 'Agent 经 send_batch 演练通过、未发送（基线后新增 0 条 + 全库扫描命中 0）'
    }, { fails })
  }

  // WM-16 群/单聊结构反证：误开另一类会话时必须 fail-closed（确定性，不走 LLM/UI）
  if (selected('WM-16')) {
    h.runCase(ev, 'WM-16', () => {
      const nl = String.fromCharCode(10)
      const code = [
        'import sys',
        `sys.path.insert(0, r"${WX_DIR}")`,
        'import wechat_sender as S, wechat_core as core',
        'g = core.resolve_talker("测试微信群")',
        'f = core.resolve_talker("TOOLAN")',
        'if not (g and f):',
        '    print("SKIP no group/friend"); sys.exit(0)',
        // 反方向：目标是单聊 TOOLAN，却开着「群」（头部=群名、内容锚点撞车）
        'rev = [(60,200,200,220,"TOOLAN"),(320,49,500,70,"测试信群"),(330,300,520,340,"微信MCP群发送测试171730"),(330,360,520,400,"微信MCP发送测试")]',
        'print("rev=", S.verify_target(f, "TOOLAN", rev, 1280, 820))',
        // 正方向：目标是群，却开着「单聊 TOOLAN」（头部=TOOLAN）
        'fwd = [(60,200,200,220,"测试微信群"),(320,49,500,70,"TOOLAN"),(330,300,520,340,"微信MCP发送测试")]',
        'print("fwd=", S.verify_target(g, "测试微信群", fwd, 1280, 820))',
      ].join(nl)
      const r = spawnSync(PY, ['-c', code], { encoding: 'utf8', timeout: 60000 })
      const out = r.stdout || ''
      if (/SKIP/.test(out)) return '跳过（未解析到群/好友）'
      h.assert(/rev= \(False/.test(out), `反方向误开未被拒：${out.slice(0, 200)}`)
      h.assert(/fwd= \(False/.test(out), `正方向误开未被拒：${out.slice(0, 200)}`)
      return '群/单聊误开被「头部更像其它会话」反证拦下（双向 fail-closed）'
    }, { fails })
  }

  // WM-17 引用回复（dry-run 必须无痕）
  if (selected('WM-17')) {
    SESSION = SESSION || newSession('引用回复')
    h.runCase(ev, 'WM-17', () => {
      const { text } = h.sendAndWait(
        SESSION,
        `请调用 reply_to 工具，向 测试微信群 做一次**引用回复演练**：quote 传「171730」、text 传「${MARK_REPLY}」，dry_run 传 true（只校验、不真发）。把工具返回原样贴出来。`,
        { timeoutMs: TURN_TIMEOUT },
      )
      h.assert(/dry-?run/i.test(text) || /"ok"\s*:\s*true/.test(text), `未报 dry-run 成功：${text.slice(0, 200)}`)
      h.sleep(3000)
      const scan = wxScan(MARK_REPLY)
      h.assert(scan.hits.length === 0, `dry-run 引用竟然落库：全库扫描命中 ${scan.hits.length}`)
      return 'Agent 经 reply_to 演练通过、未发送（全库扫描命中 0）'
    }, { fails })
  }

  // WM-18 蒸馏 digest（确定性：结构 + 跨分片 + 全局/单会话一致）
  if (selected('WM-18')) {
    h.runCase(ev, 'WM-18', () => {
      const nl = String.fromCharCode(10)
      const code = [
        'import sys',
        `sys.path.insert(0, r"${WX_DIR}")`,
        'import wechat_core as core',
        'd = core.digest(None, limit=100)',
        'assert d["shards"] >= 1, "shards"',
        'assert len(d["self"]["hour_hist"]) == 24, "hour_hist"',
        'assert d["self"]["from_me"] + d["self"]["from_others"] == d["self"]["total"], "sum"',
        'assert d["contacts_total"] >= 1, "contacts"',
        'g = core.resolve_talker("测试微信群")',
        'dg = core.digest(g)',
        'assert dg["contacts_total"] == 1 and dg["contacts"][0]["talker"] == g, "scope"',
        'print("OK shards=%d total=%d from_me=%d contacts=%d" % (d["shards"], d["self"]["total"], d["self"]["from_me"], d["contacts_total"]))',
      ].join(nl)
      const r = spawnSync(PY, ['-c', code], { encoding: 'utf8', timeout: 120000 })
      const out = (r.stdout || '').trim()
      h.assert(/^OK /.test(out), `digest 断言失败：${out.slice(0, 300)} | ${(r.stderr || '').slice(0, 200)}`)
      return `蒸馏 digest 结构正确、跨分片、全局/单会话一致（${out.slice(3)}）`
    }, { fails })
  }

  // WM-19 蒸馏画像落盘/读取 + 历史发送者字段（确定性；**用临时目录，不动用户真实画像**）
  if (selected('WM-19')) {
    h.runCase(ev, 'WM-19', () => {
      const nl = String.fromCharCode(10)
      const tmp = path.join(__dirname, '.wmtmp-wm19')
      const code = [
        'import sys, os',
        `sys.path.insert(0, r"${WX_DIR}")`,
        'import wechat_core as core',
        'p = core.profile_save(None, "# 用户画像\\n- WM-19 测试")',
        'assert os.path.isfile(p), "not written"',
        'assert ".wmtmp-wm19" in p, "not in tmp dir: " + p',
        'g = core.profile_get("self")',
        'assert g["exists"] and "WM-19" in g["content"], "readback"',
        'assert "updated" in g and "stale" in g, "meta"',
        'assert "self.md" in core.profile_get()["files"], "list"',
        'h = core.history("filehelper", 3)',
        'assert all("from_me" in m for m in h["messages"]), "sender field"',
        's = core.search_messages("的", limit=1)',
        'assert not s["messages"] or "from_me" in s["messages"][0], "search sender"',
        'print("OK")',
      ].join(nl)
      let r
      try {
        r = spawnSync(PY, ['-c', code], {
          encoding: 'utf8', timeout: 120000,
          env: { ...process.env, LUMII_WECHAT_DISTILL: tmp },
        })
        const out = (r.stdout || '').trim()
        h.assert(out === 'OK', `画像/发送者断言失败：${out.slice(0, 200)} | ${(r.stderr || '').slice(0, 200)}`)
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
      }
      return '画像可落盘/读回/列出（临时目录）＋ 历史带 from_me（确定性）'
    }, { fails })
  }

  // WM-20 蒸馏一键清除（确定性；临时目录）
  if (selected('WM-20')) {
    h.runCase(ev, 'WM-20', () => {
      const nl = String.fromCharCode(10)
      const tmp = path.join(__dirname, '.wmtmp-wm20')
      const code = [
        'import sys',
        `sys.path.insert(0, r"${WX_DIR}")`,
        'import wechat_core as core',
        'core.profile_save(None, "# self")',
        'core.profile_save("50313322756@chatroom", "# grp")',
        'core.set_distill_state("self", 123)',
        'assert len(core.profile_get()["files"]) == 2, "seed"',
        'r = core.distill_clear("self")',
        'assert r["ok"] and core.profile_get("self")["exists"] is False, "clear scope"',
        'assert core.distill_state()["since"] == 0, "clear state"',
        'assert core.distill_clear()["ok"] is False, "guard"',
        'core.distill_clear(None, everything=True)',
        'assert core.profile_get()["files"] == [], "clear all"',
        'print("OK")',
      ].join(nl)
      let r
      try {
        r = spawnSync(PY, ['-c', code], {
          encoding: 'utf8', timeout: 120000,
          env: { ...process.env, LUMII_WECHAT_DISTILL: tmp },
        })
        const out = (r.stdout || '').trim()
        h.assert(out === 'OK', `清除断言失败：${out.slice(0, 200)} | ${(r.stderr || '').slice(0, 200)}`)
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
      }
      return '一键清除：单 scope 清画像+水位、无 scope 被拒、everything 清空全部（临时目录）'
    }, { fails })
  }

  // WM-08 回归：普通聊天
  if (selected('WM-08')) {
    const sk = newSession('回归')
    h.runCase(ev, 'WM-08', () => {
      const { text } = h.sendAndWait(sk, '用一句话打个招呼。', { timeoutMs: TURN_TIMEOUT })
      h.assert(text && text.trim().length > 0, '普通聊天无回复')
      return '普通聊天正常（微信工具不影响基础对话）'
    }, { fails })
  }

  const { passed, failed, total } = ev.writeReport({
    meta: { 微信数据: '微信 4.x 本机库（只读断言走 devcli.py）', 探针标记: `${MARK_DRY} / ${MARK_REAL} / ${MARK_FAIL}` },
  })
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('套件异常终止:', err?.stack || err)
  try {
    ev.record('SUITE', 'FAIL', String(err?.message || err))
    ev.writeReport({})
  } catch { /* ignore */ }
  process.exit(1)
})
