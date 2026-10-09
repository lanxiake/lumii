#!/usr/bin/env node
/**
 * @lumii/wechat-mcp 启动器：找到当前平台的二进制包，把 stdio 原样交给它。
 *
 * 二进制按平台拆成 optionalDependencies（esbuild 同款），npm 只下载与本机匹配的那一个。
 * stdout 是 MCP 协议通道，这里的任何提示一律写 stderr。
 */
'use strict'

const { spawn } = require('node:child_process')
const path = require('node:path')

/**
 * 定位平台二进制
 *
 * `LUMII_WECHAT_MCP_BINARY` 可指向任意一份 wechat-mcp.exe（调试 / 离线拷贝时用）。
 * @returns {string} 二进制绝对路径
 */
function resolveBinary() {
  const override = process.env.LUMII_WECHAT_MCP_BINARY
  if (override) return override

  const target = `${process.platform}-${process.arch}`
  if (target !== 'win32-x64') {
    throw new Error(`暂只支持 Windows x64，当前平台 ${target}`)
  }
  const pkg = `@lumii/wechat-mcp-${target}`
  try {
    return path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'bin', 'wechat-mcp.exe')
  } catch {
    throw new Error(`缺少平台包 ${pkg}（安装时跳过了 optionalDependencies？请去掉 --no-optional / omit=optional 后重装）`)
  }
}

/** 启动二进制并透传退出码与终止信号 */
function main() {
  let binary
  try {
    binary = resolveBinary()
  } catch (err) {
    process.stderr.write(`[wechat-mcp] ${err.message}\n`)
    process.exit(1)
  }

  const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit', windowsHide: true })
  child.on('error', (err) => {
    process.stderr.write(`[wechat-mcp] 启动 ${binary} 失败：${err.message}\n`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => child.kill(sig))
  }
}

main()
