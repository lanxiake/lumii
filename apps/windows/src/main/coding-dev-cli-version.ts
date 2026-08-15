/**
 * 本机 ACP 工具版本探测 + npm registry 最新版本查询
 *
 * 版本探测跑一次 `<cmd> --version`，用通用正则从 stdout 里摘取语义化版本号；
 * 最新版本查 registry.npmjs.org（同一套 HTTPS 请求模式，参考
 * cloak-browser-downloader.ts 的 fetchWithRedirects：手动处理重定向，不引入 axios/node-fetch）。
 * 两者都是"最好有，没有也不影响主功能"，失败都静默返回 undefined。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import https from 'node:https'

/**
 * 版本号：语义化 x.y.z，或 Cursor 那种日期版本 2026.07.23-e383d2b。
 * 预发布/构建后缀（-beta.1、-e383d2b）一并保留，否则 Cursor 的 build hash 会被截掉。
 */
const VERSION_REGEX = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/

/**
 * .cmd/.bat 必须经 shell 启动
 */
function needsWindowsShell(commandPath: string): boolean {
  if (process.platform !== 'win32') return false
  const ext = path.extname(commandPath).toLowerCase()
  return ext === '.cmd' || ext === '.bat'
}

/**
 * spawn 版本探测（支持 .cmd/.bat，与 local-runner 统一）
 */
function spawnWithOutput(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const useShell = needsWindowsShell(cmd)
    const child = spawn(cmd, args, {
      windowsHide: true,
      shell: useShell,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill()
        reject(new Error('版本探测超时'))
      }
    }, timeoutMs)
    child.stdout?.on('data', (buf: Buffer) => {
      stdout += buf.toString('utf8')
    })
    child.stderr?.on('data', (buf: Buffer) => {
      stderr += buf.toString('utf8')
    })
    child.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(err)
      }
    })
    child.on('close', () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({ stdout, stderr })
      }
    })
  })
}

/**
 * 各 CLI 对"版本"参数的叫法不完全统一，按顺序尝试到第一个成功的为止。
 * 只用带 - 前缀的写法：这批工具多数是"无 flag 时把位置参数当 prompt 发给
 * 大模型"的 agent CLI，裸词 `version` 可能被当成一次真实对话请求发出去。
 */
const VERSION_FLAGS = ['--version', '-v', '-V']

/**
 * 探测本机已安装 CLI 的版本号（依次尝试常见版本参数，解析 stdout/stderr）
 */
export async function detectToolVersion(resolvedPath: string): Promise<string | undefined> {
  for (const flag of VERSION_FLAGS) {
    try {
      const { stdout, stderr } = await spawnWithOutput(resolvedPath, [flag], 8_000)
      const match = VERSION_REGEX.exec(stdout) ?? VERSION_REGEX.exec(stderr)
      if (match) return match[1]
    } catch {
      /* 该参数不支持或报错，试下一个 */
    }
  }
  return undefined
}

function httpsGetJson(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'lumii-client' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`))
        res.resume()
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (err) {
          reject(err)
        }
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时: ${url}`)))
  })
}

/**
 * 查询 npm registry 上某包的最新版本号
 */
export async function fetchNpmLatestVersion(pkgName: string): Promise<string | undefined> {
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(pkgName)}/latest`
    const data = await httpsGetJson(url, 5_000)
    const version = (data as { version?: string })?.version
    return typeof version === 'string' && version.trim() ? version.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * 查询 PyPI 上某包的最新版本号（Python 系工具，如 kimi-cli / hermes-agent）
 */
export async function fetchPypiLatestVersion(pkgName: string): Promise<string | undefined> {
  try {
    const url = `https://pypi.org/pypi/${encodeURIComponent(pkgName)}/json`
    const data = await httpsGetJson(url, 5_000)
    const version = (data as { info?: { version?: string } })?.info?.version
    return typeof version === 'string' && version.trim() ? version.trim() : undefined
  } catch {
    return undefined
  }
}
