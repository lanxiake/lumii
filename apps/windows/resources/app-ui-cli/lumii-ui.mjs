#!/usr/bin/env node
/**
 * lumii-ui — 零依赖 CLI，通过本机 HTTP 控制 Lumii 主窗口 UI。
 *
 * 读取 ~/.lumii/runtime/app-ui.json（或 LUMII_CLIENT_DATA_DIR）获取 port/token。
 * 应用未运行或连不上控制口时 exit 3。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EXIT_APP_NOT_RUNNING = 3

/** act 支持的动作，与主进程 app_act 工具一致 */
const ACT_ACTIONS = ['click', 'type', 'select', 'key', 'scroll']

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
 * 打印 JSON 并退出；连接失败 exit 3。
 */
function failConnection() {
  console.log(JSON.stringify({ ok: false, error: 'connection_failed' }))
  process.exit(EXIT_APP_NOT_RUNNING)
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
 * 解析 act 的数字参数（dx/dy），非法值返回 undefined。
 */
function parseNumberFlag(value) {
  if (typeof value !== 'string') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * 由 flags 组装 /act 请求体。
 */
function buildActBody(action, flags) {
  const body = { action }
  if (typeof flags.ref === 'string') body.ref = flags.ref
  if (typeof flags['snapshot-id'] === 'string') body.snapshotId = flags['snapshot-id']
  if (typeof flags.text === 'string') body.text = flags.text
  if (flags.append === true || flags.append === 'true') body.append = true
  if (typeof flags.value === 'string') body.value = flags.value
  if (typeof flags.label === 'string') body.label = flags.label
  if (typeof flags.key === 'string') body.key = flags.key
  const dx = parseNumberFlag(flags.dx)
  const dy = parseNumberFlag(flags.dy)
  if (dx != null) body.dx = dx
  if (dy != null) body.dy = dy
  return body
}

/**
 * CLI 入口。
 */
async function main() {
  const config = loadRuntimeConfig()
  if (!config) {
    process.exit(EXIT_APP_NOT_RUNNING)
  }

  const { positional, flags } = parseArgs(process.argv.slice(2))
  const command = positional[0]

  if (!command) {
    console.error(
      [
        '用法:',
        '  lumii-ui screenshot [--annotate] [--target main|pet|preview] [--out <file.jpg>]',
        '  lumii-ui goto --view <view> [--category <category>]',
        '  lumii-ui click --ref <ref> [--snapshot-id <id>]',
        '  lumii-ui act --action click|type|select|key|scroll [--ref <ref>] [--text <t>] [--append]',
        '                [--value <v>] [--label <l>] [--key <k>] [--dx <n>] [--dy <n>] [--snapshot-id <id>]',
      ].join('\n'),
    )
    process.exit(1)
  }

  try {
    if (command === 'screenshot') {
      const body = {}
      if (flags.annotate) body.annotate = true
      if (typeof flags.target === 'string') body.target = flags.target
      const { status, data } = await postJson(config, '/screenshot', body)
      console.log(JSON.stringify(formatScreenshot(data, flags)))
      process.exit(status >= 400 ? 1 : 0)
    }

    if (command === 'goto') {
      if (!flags.view) {
        console.error('goto 需要 --view <view>')
        process.exit(1)
      }
      const body = { view: flags.view }
      if (flags.category) body.category = flags.category
      const { status, data } = await postJson(config, '/goto', body)
      console.log(JSON.stringify(data))
      process.exit(status >= 400 ? 1 : 0)
    }

    if (command === 'click') {
      if (!flags.ref) {
        console.error('click 需要 --ref <ref>')
        process.exit(1)
      }
      const body = { ref: flags.ref }
      if (flags['snapshot-id']) body.snapshotId = flags['snapshot-id']
      const { status, data } = await postJson(config, '/click', body)
      console.log(JSON.stringify(data))
      process.exit(status >= 400 ? 1 : 0)
    }

    if (command === 'act') {
      const action = typeof flags.action === 'string' ? flags.action : positional[1]
      if (!ACT_ACTIONS.includes(action)) {
        console.error(`act 需要 --action ${ACT_ACTIONS.join('|')}`)
        process.exit(1)
      }
      const { status, data } = await postJson(config, '/act', buildActBody(action, flags))
      console.log(JSON.stringify(data))
      process.exit(status >= 400 ? 1 : 0)
    }

    console.error(`未知命令: ${command}`)
    process.exit(1)
  } catch {
    failConnection()
  }
}

main()
