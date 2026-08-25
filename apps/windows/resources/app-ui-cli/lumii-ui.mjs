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
  const buildArgs = { positional: rest, flags }
  let extra
  // `-` 表示从 stdin 读取：data 用于底层 command，content 用于 wiki 页面正文
  if (flags.data === '-' || flags.content === '-') {
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

  try {
    const { status, data } = await postJson(config, command.route.path, body)
    const output = command.name === 'screenshot' ? formatScreenshot(data, flags) : data
    console.log(JSON.stringify(output))
    process.exit(exitFromResponse(status, data))
  } catch {
    console.log(JSON.stringify({ ok: false, error: 'connection_failed' }))
    process.exit(EXIT.appDown)
  }
}

main()
