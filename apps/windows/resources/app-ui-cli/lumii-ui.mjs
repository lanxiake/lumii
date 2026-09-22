#!/usr/bin/env node
/**
 * lumii-ui — 零依赖 CLI，通过本机 HTTP 控制 Lumii 客户端 UI 与设置/命令总线/技能/桌宠。
 *
 * 读取 ~/.lumii/runtime/app-ui.json（或 LUMII_CLIENT_DATA_DIR）获取 port/token。
 * 分发逻辑完全由 commands.mjs 的声明式注册表驱动：新增命令只改那个文件。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { COMMANDS } from './commands.mjs'

/** 统一退出码：0 成功 | 1 其它错误 | 2 参数错误 | 3 应用未运行 | 4 认证失败 | 5 被拒绝 */
const EXIT = { ok: 0, other: 1, usage: 2, appDown: 3, auth: 4, denied: 5 }

/**
 * 解析客户端数据根目录。
 */
function resolveDataRoot() {
  const env = process.env.LUMII_CLIENT_DATA_DIR?.trim()
  if (env) {
    if (env.startsWith('~')) {
      return path.resolve(env.replace(/^~(?=$|[/\\])/, os.homedir()))
    }
    return path.resolve(env)
  }
  return path.join(os.homedir(), '.lumii')
}

/**
 * 读取 runtime/app-ui.json。
 */
function loadRuntimeConfig() {
  const configPath = path.join(resolveDataRoot(), 'runtime', 'app-ui.json')
  if (!fs.existsSync(configPath)) {
    return null
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    if (typeof raw?.port !== 'number' || typeof raw?.token !== 'string') {
      return null
    }
    return raw
  } catch {
    return null
  }
}

/**
 * 简易 argv 解析：支持 --key value 与 --flag。
 */
function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next != null && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

/**
 * 向本机控制口发送 POST 请求。
 */
async function postJson(config, route, body) {
  const url = `http://127.0.0.1:${config.port}${route}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { ok: false, error: 'invalid_response', status: res.status }
  }
  return { status: res.status, data }
}

/**
 * 把 HTTP status + 响应体映射为统一退出码。
 */
function exitFromResponse(status, data) {
  if (status === 401) return EXIT.auth
  const err = data?.error
  if (err === 'not_exposed' || err === 'disabled' || err === 'field_protected' || err === 'rate_limited') {
    return EXIT.denied
  }
  if (data?.ok === false) return EXIT.other
  return status >= 400 ? EXIT.other : EXIT.ok
}

/**
 * 把截图响应整理成适合终端/Agent 消费的形态：
 * 一律剥掉 imageBase64（几十万字符会刷屏），改成 imagePath；
 * 带 --out 时另存一份 JPEG 到指定路径。
 */
function formatScreenshot(data, flags) {
  if (data?.ok !== true || typeof data.imageBase64 !== 'string') {
    return data
  }

  const { imageBase64, previewPath, ...rest } = data
  const output = { ...rest, imagePath: previewPath ?? null }

  if (typeof flags.out === 'string') {
    const target = path.resolve(flags.out)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, Buffer.from(imageBase64, 'base64'))
    output.imagePath = target
  }

  return output
}

/**
 * 格式化 status 命令的输出，提供用户友好的状态报告
 */
function formatStatus(data) {
  if (data?.ok !== true) {
    return data
  }

  const lines = []
  lines.push('')
  lines.push('=== Lumii 服务状态 ===')
  lines.push('')

  // 服务运行状态
  lines.push('✅ 服务运行中')
  const config = loadRuntimeConfig()
  if (config) {
    lines.push(`   控制口: http://127.0.0.1:${config.port}`)
    lines.push(`   启动时间: ${config.startedAt}`)
  }
  lines.push('')

  // 核心服务状态
  const services = data.services || {}
  const skillSuffix = typeof services.skillCount === 'number' ? ` (${services.skillCount} 个技能已加载)` : ''
  lines.push('✅ 核心服务')
  lines.push(services.agentRuntime ? '   ✅ Agent Runtime' : '   ❌ Agent Runtime')
  lines.push(services.skillSystem ? `   ✅ 技能系统${skillSuffix}` : '   ❌ 技能系统')
  lines.push(services.cloudSync ? '   ✅ 云同步' : '   ⚠️  云同步（未配置）')
  lines.push('')

  // 配置检查
  const config2 = data.configuration || {}
  const hasIssues = !config2.hasProviders || !config2.browserExecutable

  if (hasIssues) {
    lines.push('⚠️  配置检查')
  } else {
    lines.push('✅ 配置检查')
  }

  if (!config2.hasProviders) {
    lines.push('   ❌ AI 模型提供商: 未配置')
    lines.push('      → 运行: lumii-ui setup')
    lines.push('')
  } else {
    lines.push('   ✅ AI 模型提供商: 已配置')
  }

  if (!config2.browserExecutable) {
    lines.push('   ⚠️  浏览器控制: 未配置')
    lines.push('      → 设置环境变量:')
    lines.push('        export LUMII_BROWSER_EXECUTABLE=/usr/bin/google-chrome')
    lines.push('        export LUMII_BROWSER_NO_SANDBOX=1')
    lines.push('      → 重启应用')
    lines.push('')
  } else {
    lines.push(`   ✅ 浏览器控制: ${config2.browserExecutable}`)
    if (!config2.browserNoSandbox) {
      lines.push('      ⚠️  建议启用 --no-sandbox: export LUMII_BROWSER_NO_SANDBOX=1')
    }
  }

  // 推荐下一步：固定给上手路径，序号按实际渲染顺序现算
  // （服务端的 recommendations 已在上面「配置检查」里逐条展开，不在 JSON 之外重复渲染，
  //   Agent 仍可从 raw 里读到原始建议）
  const nextSteps = []
  if (!config2.hasProviders) {
    nextSteps.push({ text: '配置 AI 模型提供商（必需）', cmd: 'lumii-ui setup' })
  }
  nextSteps.push({ text: '创建第一个会话', cmd: 'lumii-ui conversation create' })
  nextSteps.push({ text: '查看场景化使用指南', cmd: 'lumii-ui guide' })

  lines.push('')
  lines.push('──────────────────────────────────────────')
  lines.push('推荐下一步')
  lines.push('──────────────────────────────────────────')
  lines.push('')
  nextSteps.forEach((step, i) => {
    if (i > 0) lines.push('')
    lines.push(`${i + 1}. ${step.text}`)
    lines.push(`   ${step.cmd}`)
  })

  lines.push('')

  return { ok: true, formatted: lines.join('\n'), raw: data }
}

/* ────────────────── 会话消息：可读正文提取与等待回复 ────────────────── */

/** 角色 → 中文标签 */
const ROLE_LABELS = { user: '用户', assistant: '助手', tool: '工具', system: '系统' }

/**
 * 从一条消息里取可读正文。
 *
 * 主进程的 `conversation:messages` 对 assistant 消息**不再填 content[].text**
 * （新格式正文在 contentJson 的 assistant_parts.parts 里，渲染进程用共享 parser 还原），
 * 只读 content[].text 会得到空串——终端里看起来像「Agent 没回话」。
 * 这里按同一份 contentJson 还原，兼容旧的 text/content 格式。
 */
function extractMessageText(item) {
  const fromContent = Array.isArray(item?.content)
    ? item.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('')
    : ''
  if (fromContent.trim()) return fromContent

  const raw = item?.contentJson
  if (typeof raw !== 'string' || raw.length === 0) return ''
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  if (typeof parsed === 'string') return parsed
  if (Array.isArray(parsed?.parts)) {
    return parsed.parts
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
  }
  if (typeof parsed?.text === 'string') return parsed.text
  if (typeof parsed?.content === 'string') return parsed.content
  return ''
}

/** 从一条消息里取工具调用名列表（用于「本轮调用了什么」的摘要） */
function extractToolNames(item) {
  const raw = item?.contentJson
  if (typeof raw !== 'string' || raw.length === 0) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed?.parts)) return []
    return parsed.parts
      .filter((p) => p?.type === 'tool' && typeof p.name === 'string')
      .map((p) => p.name)
  } catch {
    return []
  }
}

/**
 * 取「这一轮是模型调用失败」标记（contentJson.llmError）。
 * 失败时正文也是一句人话（「模型调用失败：…」），脚本没法靠正文区分，得看这个字段。
 */
function extractLlmError(item) {
  const raw = item?.contentJson
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  try {
    const parsed = JSON.parse(raw)
    const err = parsed?.llmError
    if (!err || typeof err !== 'object') return undefined
    return {
      code: typeof err.code === 'string' ? err.code : 'llm_error',
      message: typeof err.message === 'string' ? err.message : '',
      retryable: err.retryable === true,
    }
  } catch {
    return undefined
  }
}

/** 会话消息的可读转录（`context messages --text`） */
function formatMessagesText(data) {
  const items = Array.isArray(data?.items) ? data.items : []
  if (items.length === 0) return '（没有消息）\n'

  const lines = ['']
  items.forEach((item, index) => {
    const role = ROLE_LABELS[item?.role] ?? String(item?.role ?? '未知')
    const when = Number.isFinite(item?.timestamp)
      ? new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour12: false })
      : ''
    lines.push(`[${index + 1}] ${role}${when ? `  ${when}` : ''}`)

    const text = extractMessageText(item).trim()
    if (text) {
      for (const line of text.split('\n')) lines.push(`    ${line}`)
    } else {
      lines.push('    （无文本）')
    }

    const tools = extractToolNames(item)
    if (tools.length > 0) lines.push(`    🔧 工具: ${tools.join(', ')}`)
    const llmError = extractLlmError(item)
    if (llmError) lines.push(`    ⚠️ 模型调用失败: ${llmError.message || llmError.code}`)
    if (typeof item?.thinkingText === 'string' && item.thinkingText.trim()) {
      lines.push(`    💭 思考过程 ${item.thinkingText.trim().length} 字（--json 可看全文）`)
    }
    if (item?.isStreaming === true) lines.push('    ⏳ 正在生成…')
    lines.push('')
  })
  if (data?.hasMore === true) lines.push('（还有更早的消息，用 --limit 调大或加游标翻页）')
  return lines.join('\n')
}

/** 取最近一条 assistant 消息的 id，作为「本轮新回复」的基线 */
async function fetchLastAssistantId(config, sessionKey) {
  const { data } = await postJson(config, '/command', {
    type: 'conversation:messages',
    sessionKey,
    limit: 5,
  })
  const items = Array.isArray(data?.items) ? data.items : []
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]?.role === 'assistant') return items[i].id
  }
  return undefined
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 等这一轮回复落库。
 *
 * 控制口没有事件流，只能轮询消息；判据是「出现了一条新的 assistant 消息且不在流式中」——
 * 用发送前的最后一条 assistant id 做基线，避免把上一轮的旧回复当成本轮结果。
 * 失败返回 { ok:false, error }，由调用方决定退出码。
 */
async function waitForAssistantReply(config, sessionKey, baselineId, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(700)
    let items = []
    try {
      const { data } = await postJson(config, '/command', {
        type: 'conversation:messages',
        sessionKey,
        limit: 5,
      })
      items = Array.isArray(data?.items) ? data.items : []
    } catch {
      continue // 控制口偶发失败不该中断等待
    }
    let last
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (items[i]?.role === 'assistant') {
        last = items[i]
        break
      }
    }
    if (!last || last.id === baselineId || last.isStreaming === true) continue

    const toolNames = extractToolNames(last)
    return {
      ok: true,
      messageId: last.id,
      text: extractMessageText(last).trim(),
      toolNames,
      llmError: extractLlmError(last),
      elapsedMs: Date.now() - startedAt,
    }
  }
  return { ok: false, error: 'wait_timeout', elapsedMs: Date.now() - startedAt }
}

/**
 * 场景化指南正文（纯客户端渲染，不发请求）。
 *
 * 这里出现的每条命令都必须真实存在——用户照抄跑不通的指南比没有更糟。
 * 新增/改命令时同步核对 commands.mjs。
 */
const GUIDE_SCENARIOS = [
  {
    key: 'chat',
    title: '基础对话',
    summary: '创建会话、发送消息、查看历史、上下文管理',
    body: `=== 场景：基础对话 ===

涵盖：创建会话 → 发送消息 → 查看历史 → 上下文管理

──────────────────────────────────────────
步骤 1：创建会话
──────────────────────────────────────────

  lumii-ui conversation create --title "我的第一个会话"

输出示例：
  {"ok":true,"sessionKey":"conv_xxx","title":"我的第一个会话"}

💡 记下 sessionKey（下文统一写作 <会话ID>）

──────────────────────────────────────────
步骤 2：发送消息
──────────────────────────────────────────

  lumii-ui send --session <会话ID> --text "你好，请介绍一下自己"

# 长文本从文件 / 管道读
  cat message.txt | lumii-ui send --session <会话ID> --data -

# 等回答生成完再返回，并把正文打出来（脚本/新手都建议这么用）
  lumii-ui send --session <会话ID> --text "统计一下今天的新闻" --wait

# 任务比较慢时自定义等待上限（这里是 5 分钟）
  lumii-ui send --session <会话ID> --text "写一份周报" --wait 300

──────────────────────────────────────────
步骤 3：查看回复与历史
──────────────────────────────────────────

# --text 打印可读转录（不加则输出原始 JSON，供脚本解析）
  lumii-ui context messages --session <会话ID> --limit 10 --text

输出示例：
  [2] 助手  09:12:03
      你好！我是 Lumii……

──────────────────────────────────────────
步骤 4：列出所有会话
──────────────────────────────────────────

  lumii-ui conversation list

──────────────────────────────────────────
相关命令
──────────────────────────────────────────

  中止正在生成的回答
    lumii-ui send abort --session <会话ID>

  编辑消息 / 编辑后重跑
    lumii-ui send edit   --session <会话ID> --message <消息ID> --text "改后的内容"
    lumii-ui send resend --session <会话ID> --message <消息ID> --text "改后的内容"

  切换模型（本次会话）
    lumii-ui model set <模型ID> --session <会话ID>

  上下文占用与压缩
    lumii-ui context usage   --session <会话ID>
    lumii-ui context compact --session <会话ID> [--keep <条数>]
    lumii-ui context abort   --session <会话ID>

💡 详细帮助: lumii-ui help <命令名>`,
  },
  {
    key: 'browser',
    title: '浏览器控制',
    summary: '让 Agent 打开网页、点击、截图（CDP 控制本机 Chrome 系浏览器）',
    body: `=== 场景：浏览器控制 ===

让 Agent 能打开网页、点击、填表、截图。
原理：控制本机已装的 Chrome 系浏览器（CDP），不是内置浏览器。

──────────────────────────────────────────
前提：本机要有 Chrome 系浏览器
──────────────────────────────────────────

Ubuntu 桌面默认只有 Firefox，而 Firefox 不支持 CDP，开箱不可用。

  # 推荐：snap 装的 chromium 自带 AppArmor profile，渲染沙箱完好
  sudo snap install chromium

  # 或者指向任意一份已有的 Chromium（无需 root）

──────────────────────────────────────────
步骤 1：设置环境变量并重启应用
──────────────────────────────────────────

  export LUMII_BROWSER_EXECUTABLE=/snap/bin/chromium
  export LUMII_BROWSER_NO_SANDBOX=1

⚠️  这是环境变量，不是设置项：CLI 改不了运行中的进程，改完必须重启应用。

──────────────────────────────────────────
步骤 2：确认配置生效
──────────────────────────────────────────

  lumii-ui status

  # 配置检查里应出现:
  #   ✅ 浏览器控制: /snap/bin/chromium

──────────────────────────────────────────
步骤 3：让 Agent 使用浏览器
──────────────────────────────────────────

  lumii-ui send --session <会话ID> --text "打开 example.com，把页面标题告诉我"

Agent 会自动调用 browser_navigate 等工具完成任务。

──────────────────────────────────────────
排障
──────────────────────────────────────────

  报错 "No supported browser found"
    → 本机没装 Chrome 系浏览器，或 LUMII_BROWSER_EXECUTABLE 指向的路径不对

  浏览器起来了但立刻崩
    → 容器 / 无权限环境需要 LUMII_BROWSER_NO_SANDBOX=1`,
  },
  {
    key: 'skill',
    title: '技能管理',
    summary: '查看、启用/停用技能；技能目录与热加载说明',
    body: `=== 场景：技能管理 ===

技能 = 可复用的 Agent 能力包（一个目录 + SKILL.md，可带脚本与资源）。

──────────────────────────────────────────
查看与开关
──────────────────────────────────────────

  lumii-ui skill list              # 列出已安装技能（含 id 与启用状态）
  lumii-ui skill enable <技能ID>    # 启用
  lumii-ui skill disable <技能ID>   # 停用

──────────────────────────────────────────
技能存放在哪
──────────────────────────────────────────

  <数据目录>/workspace/skills/<技能ID>/SKILL.md

  自带的技能按分类分目录，例如：
    <数据目录>/workspace/skills/语音与音频/qwen3-tts-local/SKILL.md

  数据目录默认 ~/.lumii（无头启动横幅里会打印实际路径）。

──────────────────────────────────────────
写一个新技能
──────────────────────────────────────────

  1. 建目录：<数据目录>/workspace/skills/my-skill/
  2. 写 SKILL.md（YAML frontmatter 里写 name / description 等）
  3. 目录有监听，写入后自动加载；没有出现就重启应用或再跑一次 skill list

💡 技能里的脚本用 Python/Node 都行，运行环境由技能自己声明。`,
  },
  {
    key: 'channel',
    title: '渠道接入',
    summary: '微信 / 企微 / 飞书 / QQ 扫码登录，手机上直接和 Agent 对话',
    body: `=== 场景：渠道接入（微信 / 企微 / 飞书 / QQ） ===

登录后，Agent 可以通过渠道收发消息——在手机上直接对话。

──────────────────────────────────────────
步骤 1：发起扫码登录
──────────────────────────────────────────

  lumii-ui channel login weixin      # weixin | wecom | feishu | qbot

⚠️  二维码打印在【运行应用的终端】里，不在本命令的输出里。
    无头模式没有界面，请到启动 Lumii 的那个终端扫码。

──────────────────────────────────────────
步骤 2：确认登录状态
──────────────────────────────────────────

  lumii-ui channel status            # 全部渠道
  lumii-ui channel status weixin     # 单个渠道

  状态含义：
    idle              未登录
    waiting_qrcode    等待扫码
    scanned           已扫码（微信在二维码刚生成时即为此态）
    confirmed         已确认
    logged_in         已登录（微信）
    connected         已连接（企微 / 飞书 / QQ）
    error             异常，可重新 login

──────────────────────────────────────────
步骤 3：退出登录
──────────────────────────────────────────

  lumii-ui channel logout weixin

──────────────────────────────────────────
说明
──────────────────────────────────────────

  - 登录态会持久化，重启应用自动恢复；
  - 服务端过期后需重新扫码（status 会回到 idle）；
  - 渠道 ID：weixin=微信、wecom=企业微信、feishu=飞书、qbot=QQ 机器人。`,
  },
]

/** 打印场景总览 */
function printGuideIndex() {
  const lines = ['', '=== Lumii 场景化指南 ===', '', '选择一个场景查看详细步骤：', '']
  for (const s of GUIDE_SCENARIOS) {
    lines.push(`  ${s.key.padEnd(9)} ${s.title} —— ${s.summary}`)
  }
  lines.push('')
  lines.push('用法: lumii-ui guide <场景>')
  lines.push('      lumii-ui guide chat')
  lines.push('')
  lines.push('💡 全部命令: lumii-ui help      服务状态: lumii-ui status')
  console.log(lines.join('\n'))
}

/** 本地命令分发：返回进程退出码 */
async function runLocalCommand(name, positional) {
  if (name === 'guide') {
    const scenario = positional[0]
    if (scenario === undefined) {
      printGuideIndex()
      return EXIT.ok
    }
    const found = GUIDE_SCENARIOS.find((s) => s.key === scenario)
    if (!found) {
      console.error(
        `未知场景: ${scenario}（可用: ${GUIDE_SCENARIOS.map((s) => s.key).join(' / ')}）`,
      )
      return EXIT.usage
    }
    console.log(`\n${found.body}\n`)
    return EXIT.ok
  }

  if (name === 'setup') {
    return await runSetupWizard()
  }

  console.error(`本地命令未实现: ${name}`)
  return EXIT.other
}

/* ────────────────────────── setup 交互式向导 ────────────────────────── */

/** 常见提供商预设（type 必须是 provider-config.ts 里的 ProviderType） */
const PROVIDER_PRESETS = [
  { type: 'openai', label: 'OpenAI (GPT)', needsKey: true },
  { type: 'anthropic', label: 'Anthropic (Claude)', needsKey: true },
  { type: 'deepseek', label: 'DeepSeek', needsKey: true },
  { type: 'gemini', label: 'Google Gemini', needsKey: true },
  { type: 'zai', label: '智谱 GLM', needsKey: true },
  { type: 'dashscope', label: '阿里百炼（通义）', needsKey: true },
  { type: 'ollama', label: 'Ollama（本地，无需 Key）', needsKey: false },
  { type: 'lmstudio', label: 'LM Studio（本地，无需 Key）', needsKey: false },
  { type: 'openai-compatible', label: '其它 OpenAI 兼容服务（自填端点）', needsKey: true },
]

/**
 * 浏览器探测顺序：与主进程 `findChromeExecutableLinux()` 保持一致
 * （packages/browser-control/src/browser/chrome.executables.ts），避免两边给出不同答案。
 */
const BROWSER_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chrome',
  '/usr/bin/brave-browser',
  '/usr/bin/brave-browser-stable',
  '/usr/bin/brave',
  '/snap/bin/brave',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
]

/** 找到第一个存在的 Chrome 系浏览器 */
function detectBrowser() {
  for (const p of BROWSER_CANDIDATES) {
    if (fs.existsSync(p)) return p
  }
  return null
}

/**
 * 交互式提问：每题新建一个 readline，答完即关。
 * 这样隐藏输入（askHidden）用裸模式读 stdin 时不会和 readline 抢数据。
 */
function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (a) => {
      rl.close()
      resolve(a.trim())
    })
  })
}

/** 隐藏输入（API Key 不回显、不进滚动记录）；非 TTY 时退回普通输入 */
function askHidden(question) {
  const stdin = process.stdin
  if (!stdin.isTTY) return ask(question)
  return new Promise((resolve) => {
    process.stdout.write(question)
    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()
    let buf = ''
    const finish = (value) => {
      stdin.removeListener('data', onData)
      stdin.setRawMode(Boolean(wasRaw))
      stdin.pause()
      process.stdout.write('\n')
      resolve(value)
    }
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return finish(buf.trim())
        if (ch === '\u0003') {
          // 裸模式下收不到 SIGINT，自己处理 Ctrl-C
          process.stdout.write('\n')
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buf.length > 0) {
            buf = buf.slice(0, -1)
            process.stdout.write('\b \b')
          }
          continue
        }
        buf += ch
        process.stdout.write('*')
      }
    }
    stdin.on('data', onData)
  })
}

/** 发一个控制口请求；应用没起时返回 { appDown: true } */
async function postLocal(routePath, body) {
  const config = loadRuntimeConfig()
  if (!config) return { appDown: true, data: { ok: false, error: 'app_not_running' } }
  try {
    return await postJson(config, routePath, body ?? {})
  } catch {
    return { appDown: true, data: { ok: false, error: 'connection_failed' } }
  }
}

/** 向导第 1 步：配置文本对话模型；返回 true 表示已保存 */
async function setupProviderStep() {
  console.log('')
  console.log('──────────────────────────────────────────')
  console.log('1/3 AI 模型提供商')
  console.log('──────────────────────────────────────────')
  console.log('')
  console.log('Lumii 需要至少一个文本对话模型才能工作。')
  console.log('')
  PROVIDER_PRESETS.forEach((p, i) => console.log(`  ${i + 1}. ${p.label}`))
  console.log('  s. 跳过（稍后再配，可随时重跑 lumii-ui setup）')
  console.log('')

  const choice = await ask(`请选择提供商 [1-${PROVIDER_PRESETS.length}]，或 s 跳过: `)
  if (choice.toLowerCase() === 's' || choice === '') {
    console.log('⏭  已跳过模型配置')
    return false
  }
  const idx = Number(choice) - 1
  const preset = PROVIDER_PRESETS[idx]
  if (!preset) {
    console.log('⚠️  无效选择，已跳过模型配置')
    return false
  }
  // 「其它 OpenAI 兼容服务」走 openai 类型 + 自填端点
  const type = preset.type === 'openai-compatible' ? 'openai' : preset.type

  let baseUrl
  if (preset.type === 'openai-compatible') {
    baseUrl = await ask('API 端点（如 https://your-host/v1）: ')
    if (!baseUrl) {
      console.log('⚠️  未填端点，已跳过模型配置')
      return false
    }
  }

  const modelId = await ask('模型 ID（如 gpt-4o、claude-sonnet-4-5、qwen2.5:7b）: ')
  if (!modelId) {
    console.log('⚠️  未填模型 ID，已跳过模型配置')
    return false
  }

  let apiKey = ''
  if (preset.needsKey) {
    console.log('（输入不回显；也可稍后用: cat key.txt | lumii-ui provider set --api-key -）')
    apiKey = await askHidden('API Key: ')
    if (!apiKey) {
      console.log('⚠️  未填 API Key，已跳过模型配置')
      return false
    }
  }

  // 先测连通性，再落盘：避免写进一份连不通的配置
  console.log('')
  console.log('⏳ 正在测试连接...')
  const test = await postLocal('/provider/test', { slot: 'chat', type, modelId, apiKey, baseUrl })
  const testOk = test.data?.ok === true
  const testMsg = test.data?.result?.message
  console.log(`${testOk ? '✅' : '❌'} ${typeof testMsg === 'string' ? testMsg : '测试未返回结果'}`)

  if (!testOk) {
    console.log('   排查方向: 网络能否访问该端点 / 端点是否写全（多数要带 /v1）/ Key 是否有效')
    const anyway = await ask('仍要保存这份配置吗？[y/N]: ')
    if (anyway.toLowerCase() !== 'y') {
      console.log('⏭  已跳过模型配置')
      return false
    }
  }

  const save = await postLocal('/provider/save', { slot: 'chat', type, modelId, apiKey, baseUrl })
  if (save.data?.ok === true) {
    console.log(`✅ 已保存并启用模型: ${save.data.config?.modelId ?? modelId}`)
    console.log('')
    console.log('💡 配置变更已生效，无需重启；可用 lumii-ui provider show 复核')
    return true
  }
  console.log(`❌ 保存失败: ${save.data?.error ?? 'unknown_error'}`)
  return false
}

/** 向导第 2 步：浏览器控制（环境变量，需用户自行写入 shell） */
async function setupBrowserStep() {
  console.log('')
  console.log('──────────────────────────────────────────')
  console.log('2/3 浏览器控制（可选）')
  console.log('──────────────────────────────────────────')
  console.log('')
  console.log('配置后，Agent 可以打开网页、点击、截图（需要本机有 Chrome 系浏览器）。')
  console.log('')

  const detected = detectBrowser()
  const hint = detected ? `（回车用检测到的 ${detected}）` : '（留空跳过）'
  const input = await ask(`浏览器可执行文件路径${hint}: `)
  const browserPath = input || detected
  if (!browserPath) {
    console.log('⏭  已跳过浏览器配置')
    return false
  }

  const noSandbox = await ask('容器/无权限环境需要 --no-sandbox，启用？[y/N]: ')
  const exports = [`export LUMII_BROWSER_EXECUTABLE=${browserPath}`]
  if (noSandbox.toLowerCase() === 'y') {
    exports.push('export LUMII_BROWSER_NO_SANDBOX=1')
  }

  console.log('')
  console.log('请把下面几行加入 shell 配置后重启应用：')
  console.log('')
  for (const line of exports) console.log(`  ${line}`)
  console.log('')

  const rc = path.join(os.homedir(), '.bashrc')
  const append = await ask(`要自动追加到 ${rc} 吗？[y/N]: `)
  if (append.toLowerCase() === 'y') {
    const marker = '# Lumii 无头模式浏览器控制（lumii-ui setup 写入）'
    const block = ['', marker, ...exports, ''].join('\n')
    try {
      fs.appendFileSync(rc, block, 'utf-8')
      console.log(`✅ 已写入 ${rc}（想撤销就删掉「${marker}」那一段）`)
      console.log('⚠️  当前终端还没有这两行：新开终端或执行 source ~/.bashrc 后重启应用才生效')
    } catch (err) {
      console.log(`⚠️  写入失败: ${err instanceof Error ? err.message : String(err)}`)
      console.log('    请手动添加上面几行')
    }
  } else {
    console.log('⏭  未写入 shell 配置，记得自行添加（否则重启后不生效）')
  }
  console.log('')
  console.log('💡 重启应用后跑 lumii-ui status，应看到「✅ 浏览器控制」')
  return true
}

/** 交互式配置向导入口 */
async function runSetupWizard() {
  if (!process.stdin.isTTY) {
    console.error('setup 需要交互式终端。非交互场景请用：')
    console.error('  lumii-ui provider set --type <类型> --model <模型ID> --api-key -   # 密钥从 stdin 读')
    console.error('  lumii-ui status                                                  # 复核结果')
    return EXIT.usage
  }

  const config = loadRuntimeConfig()
  if (!config) {
    console.log(JSON.stringify({ ok: false, error: 'app_not_running' }))
    console.error('应用未运行：先启动 Lumii（无头模式: electron . --headless），再跑 lumii-ui setup')
    return EXIT.appDown
  }

  console.log('')
  console.log('=== Lumii 配置向导 ===')
  console.log('')
  console.log('这个向导会帮你完成关键配置，全程可以跳过（Ctrl-C 退出）。')

  const providerSaved = await setupProviderStep()
  const browserSaved = await setupBrowserStep()

  console.log('')
  console.log('──────────────────────────────────────────')
  console.log('3/3 完成')
  console.log('──────────────────────────────────────────')
  console.log('')
  if (!providerSaved && !browserSaved) {
    console.log('没有做任何改动。随时可以重新跑 lumii-ui setup。')
    return EXIT.ok
  }
  console.log('下一步：')
  console.log('  1. lumii-ui status                   # 复核服务状态与配置')
  console.log('  2. lumii-ui conversation create      # 创建第一个会话')
  console.log('  3. lumii-ui send --session <会话ID> --text "你好" --wait   # 发消息并等回复')
  console.log('  4. lumii-ui guide chat               # 基础对话上手')
  console.log('')
  if (browserSaved) {
    console.log('⚠️  浏览器配置需要重启应用才生效。')
  }
  console.log('💡 全部命令: lumii-ui help      场景化指南: lumii-ui guide')
  return EXIT.ok
}

/** 渠道中文名 */
const CHANNEL_LABELS = { weixin: '微信', wecom: '企业微信', feishu: '飞书', qbot: 'QQ 机器人' }

/** 各渠道状态值 → 中文（与渲染进程 STATUS_LABELS 用词保持一致，见 WecomChannelSettings） */
const CHANNEL_STATUS_LABELS = {
  idle: '未登录',
  waiting_qrcode: '等待扫码',
  scanned: '已扫码',
  confirmed: '已确认',
  logged_in: '已登录',
  connected: '已连接',
  waiting_credential: '需手动填凭证',
  error: '异常',
}

function channelStatusLabel(status) {
  return CHANNEL_STATUS_LABELS[status] ?? String(status)
}

/**
 * 渠道命令的友好输出。
 * 无头模式下二维码打印在【应用所在终端】，这里只做状态回报，不能让人误以为没生效。
 */
function formatChannelResponse(name, data) {
  if (data?.ok !== true) {
    if (data?.error === 'not_ready') {
      return '渠道服务尚未初始化（应用可能还在启动中），稍后重试'
    }
    if (data?.error === 'unknown_channel') {
      return `未知渠道。可用: ${(data.channels ?? []).join(' / ')}`
    }
    return JSON.stringify(data)
  }

  if (name === 'channel login') {
    const label = CHANNEL_LABELS[data.channel] ?? data.channel
    return [
      `✅ 已发起 ${label} 扫码登录（当前状态: ${channelStatusLabel(data.status)}）`,
      '',
      '二维码打印在【运行应用的终端】里 —— 请到启动 Lumii 的那个终端扫码。',
      `扫码后确认: lumii-ui channel status ${data.channel}`,
    ].join('\n')
  }

  if (name === 'channel status') {
    const lines = ['', '=== 渠道登录状态 ===', '']
    for (const [ch, info] of Object.entries(data.channels ?? {})) {
      const label = CHANNEL_LABELS[ch] ?? ch
      lines.push(`  ${label}: ${info ? channelStatusLabel(info.status) : '未初始化'}`)
    }
    lines.push('')
    return lines.join('\n')
  }

  if (name === 'channel logout') {
    const label = CHANNEL_LABELS[data.channel] ?? data.channel
    return `✅ 已退出 ${label} 登录（${channelStatusLabel(data.status)}）`
  }

  return JSON.stringify(data)
}

/**
 * 按命令名分组，转成 [{ group, commands }]，保持注册表出现顺序。
 */
function groupCommands() {
  const order = []
  const byGroup = new Map()
  for (const cmd of COMMANDS) {
    if (!byGroup.has(cmd.group)) {
      byGroup.set(cmd.group, [])
      order.push(cmd.group)
    }
    byGroup.get(cmd.group).push(cmd)
  }
  return order.map((group) => ({ group, commands: byGroup.get(group) }))
}

/**
 * 打印总览或单条命令帮助。
 */
function printHelp(commandName) {
  if (commandName) {
    const cmd = COMMANDS.find((c) => c.name === commandName)
    if (!cmd) {
      console.error(`未知命令: ${commandName}`)
      return false
    }
    console.log(`用法: lumii-ui ${cmd.usage}\n`)
    console.log(cmd.summary)
    if (cmd.options.length > 0) {
      console.log('\n选项:')
      for (const opt of cmd.options) {
        console.log(`  ${opt.flag.padEnd(24)} ${opt.desc}`)
      }
    }
    return true
  }

  console.log('lumii-ui — Lumii 客户端控制 CLI\n')
  console.log('用法: lumii-ui <command> [options]\n')
  for (const { group, commands } of groupCommands()) {
    console.log(group)
    for (const cmd of commands) {
      console.log(`  ${cmd.usage.padEnd(46)} ${cmd.summary}`)
    }
    console.log('')
  }
  console.log('help [<command>] [--json]                       查看帮助；--json 输出机器可读清单')
  console.log('\n💡 新用户建议: lumii-ui setup 配置模型与浏览器 → lumii-ui status 复核 → lumii-ui guide 按场景上手')
  console.log('\n退出码: 0 成功 | 2 参数错误 | 3 应用未运行 | 4 认证失败 | 5 被拒绝(not_exposed/disabled/field_protected/rate_limited)')
  return true
}

/**
 * 输出机器可读命令清单，供 Agent 做能力发现（不含 build 函数）。
 */
function printHelpJson() {
  const serializable = COMMANDS.map(({ build, ...rest }) => rest)
  console.log(JSON.stringify({ commands: serializable }, null, 2))
}

/**
 * 按 positional 前缀匹配命令名（支持多词命令，如 "settings get"）。
 * 匹配到后返回 { command, rest }，rest 是命令名之后剩余的 positional。
 */
function matchCommand(positional) {
  const sorted = [...COMMANDS].sort(
    (a, b) => b.name.split(' ').length - a.name.split(' ').length,
  )
  for (const cmd of sorted) {
    const parts = cmd.name.split(' ')
    if (parts.length > positional.length) continue
    if (parts.every((p, i) => positional[i] === p)) {
      return { command: cmd, rest: positional.slice(parts.length) }
    }
  }
  return null
}

/**
 * 从 stdin 读取全部内容（--data - 时用）。
 */
async function readStdin() {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf-8').trim()
}

/**
 * 解析 `send` 的等待时长：
 * - 没传 --wait / --wait-ms → undefined（发完就返回）
 * - `--wait` → 默认 120s
 * - `--wait 30` → 30 秒（后面跟数字时按秒理解）
 * - `--wait-ms 5000` → 5000 毫秒（优先级最高）
 */
function parseWaitMs(flags) {
  if (flags.wait === undefined && flags['wait-ms'] === undefined) return undefined
  const rawWaitMs = flags['wait-ms']
  if (rawWaitMs !== undefined) {
    const ms = Number(rawWaitMs)
    if (Number.isFinite(ms) && ms > 0) return ms
    console.error(`--wait-ms 需要正整数毫秒，收到 "${rawWaitMs}"，改用默认 120s`)
  }
  if (typeof flags.wait === 'string') {
    const seconds = Number(flags.wait)
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  }
  return 120_000
}

/**
 * CLI 入口。
 */
async function main() {
  const argv = process.argv.slice(2)
  const { positional, flags } = parseArgs(argv)

  if (positional.length === 0 || positional[0] === 'help' || flags.help === true) {
    const jsonMode = flags.json === true
    if (jsonMode) {
      printHelpJson()
      process.exit(EXIT.ok)
    }
    const target = positional[0] === 'help' ? positional[1] : undefined
    const ok = printHelp(target)
    process.exit(ok ? EXIT.ok : EXIT.usage)
  }

  const matched = matchCommand(positional)
  if (!matched) {
    console.error(`未知命令: ${positional.join(' ')}，跑 lumii-ui help 查看可用命令`)
    process.exit(EXIT.usage)
  }

  const { command, rest } = matched

  // 本地命令（guide / setup）：guide 纯客户端渲染、应用没起也能看；
  // setup 是交互式向导，自己按需访问控制口
  if (command.local === true) {
    process.exit(await runLocalCommand(command.name, rest))
  }

  const buildArgs = { positional: rest, flags }
  let extra
  // `-` 表示从 stdin 读取：data 用于底层 command，content 用于 wiki 页面正文，
  // api-key 用于 provider 密钥（避免密钥进 shell 历史与 ps 输出）
  if (flags.data === '-' || flags.content === '-' || flags['api-key'] === '-') {
    extra = { stdin: await readStdin() }
  }

  const body = command.build(buildArgs, extra)
  if (body === null) {
    console.error(`参数不合法：lumii-ui ${command.usage}`)
    process.exit(EXIT.usage)
  }

  const config = loadRuntimeConfig()
  if (!config) {
    console.log(JSON.stringify({ ok: false, error: 'app_not_running' }))
    process.exit(EXIT.appDown)
  }

  // send --wait：先记下当前最后一条 assistant 消息，用来区分本轮新回复
  const waitMs = command.name === 'send' ? parseWaitMs(flags) : undefined
  const waitBaselineId =
    waitMs !== undefined && typeof body.sessionKey === 'string'
      ? await fetchLastAssistantId(config, body.sessionKey).catch(() => undefined)
      : undefined

  try {
    const { status, data } = await postJson(config, command.route.path, body)

    // 特殊格式化处理
    if (command.name === 'screenshot') {
      const output = formatScreenshot(data, flags)
      console.log(JSON.stringify(output))
    } else if (command.name === 'status') {
      const formatted = formatStatus(data)
      if (formatted.formatted) {
        console.log(formatted.formatted)
      } else {
        console.log(JSON.stringify(formatted))
      }
    } else if (command.name.startsWith('channel ')) {
      console.log(formatChannelResponse(command.name, data))
    } else if (command.name === 'context messages' && flags.text === true && data?.ok !== false) {
      // ok === false 时不渲染转录，否则报错会被渲染成「（没有消息）」
      console.log(formatMessagesText(data))
    } else {
      console.log(JSON.stringify(data))
    }

    // send --wait：发出去之后等这一轮回复落库，再把正文打出来
    if (command.name === 'send' && waitMs !== undefined && data?.runId) {
      console.log(`⏳ 已发送（runId=${data.runId}），等待回复…（最长 ${Math.round(waitMs / 1000)}s，Ctrl-C 只是不看了，回复照常生成）`)
      const reply = await waitForAssistantReply(config, body.sessionKey, waitBaselineId, waitMs)
      let exitCode = reply.ok ? EXIT.ok : EXIT.other
      if (flags.json === true) {
        console.log(JSON.stringify(reply))
      } else if (reply.ok && reply.llmError) {
        // 回合结束了但模型调用失败：正文也是一句人话，脚本没法靠正文判断，这里给非零退出码
        console.log('')
        console.log(`❌ 本轮模型调用失败: ${reply.llmError.message || reply.llmError.code}`)
        console.log(`   code=${reply.llmError.code} 可重试=${reply.llmError.retryable ? '是' : '否'}`)
        console.log('   排查: lumii-ui status   /   lumii-ui provider test')
        exitCode = EXIT.other
      } else if (reply.ok && !reply.text && reply.toolNames.length === 0) {
        // 一个字都没有，且没调工具：多半是回合被中止，别让脚本当成成功
        console.log('')
        console.log('⚠️  这一轮没有产生文本回复（常见原因：回合被中止）')
        console.log('   排查: lumii-ui status')
        console.log(`   看历史: lumii-ui context messages --session ${body.sessionKey} --text`)
        exitCode = EXIT.other
      } else if (reply.ok) {
        console.log('')
        console.log(`=== 助手回复（${(reply.elapsedMs / 1000).toFixed(1)}s）===`)
        console.log(reply.text || '（本轮只有工具调用，没有文本）')
        if (reply.toolNames.length > 0) console.log(`\n🔧 本轮工具: ${reply.toolNames.join(', ')}`)
      } else {
        console.log('')
        console.log(`⏳ 等待超时（${Math.round(reply.elapsedMs / 1000)}s）——回复可能仍在生成`)
        console.log(`   看进展: lumii-ui context messages --session ${body.sessionKey} --text`)
      }
      process.exit(exitCode)
    }

    process.exit(exitFromResponse(status, data))
  } catch {
    console.log(JSON.stringify({ ok: false, error: 'connection_failed' }))
    process.exit(EXIT.appDown)
  }
}

main()
