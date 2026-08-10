/**
 * 本机 ACP 工具版本探测 + npm registry 最新版本查询
 *
 * 版本探测跑一次 `<cmd> --version`，用通用正则从 stdout 里摘取语义化版本号；
 * 最新版本查 registry.npmjs.org（同一套 HTTPS 请求模式，参考
 * cloak-browser-downloader.ts 的 fetchWithRedirects：手动处理重定向，不引入 axios/node-fetch）。
 * 两者都是"最好有，没有也不影响主功能"，失败都静默返回 undefined。
 */

import { execFile } from 'node:child_process'
import https from 'node:https'

const VERSION_REGEX = /(\d+\.\d+\.\d+)/

/** 手写 Promise 包装而非 util.promisify —— execFile 的多值回调依赖 Node 内部的
 *  customPromisifyArgs 符号，直接 promisify 在测试 mock 场景下会丢失 stderr。 */
function execFileWithOutput(
  cmd: string,
  args: string[],
  options: { windowsHide: boolean; timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) })
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
      const { stdout, stderr } = await execFileWithOutput(resolvedPath, [flag], {
        windowsHide: true,
        timeout: 8_000,
        maxBuffer: 1024 * 64,
      })
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
