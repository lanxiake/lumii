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
    console.error('用法: lumii-ui screenshot [--annotate] | goto --view <v> [--category <c>] | click --ref <r> [--snapshot-id <id>]')
    process.exit(1)
  }

  try {
    if (command === 'screenshot') {
      const body = flags.annotate ? { annotate: true } : {}
      const { status, data } = await postJson(config, '/screenshot', body)
      console.log(JSON.stringify(data))
      process.exit(status === 401 ? 1 : status >= 400 ? 1 : 0)
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

    console.error(`未知命令: ${command}`)
    process.exit(1)
  } catch {
    failConnection()
  }
}

main()
