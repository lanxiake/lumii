/**
 * 组装并（可选）发布 wechat-mcp 的 npm 包
 *
 *   @lumii/wechat-mcp            启动器（bin/cli.js），按平台选二进制
 *   @lumii/wechat-mcp-win32-x64  只装 wechat-mcp.exe（os/cpu 限定，npm 只在匹配平台下载）
 *
 * 用法：node scripts/pack-wechat-mcp-npm.mjs [--publish]
 *   默认：组装 → npm pack → 本地装 tgz 并经 cli.js 做 MCP 握手验证（不联网、不发布）
 *   --publish：验证通过后发布到 registry.npmjs.org（先平台包、后主包；需已 npm login 或 NODE_AUTH_TOKEN）
 *
 * 版本号唯一来源是 server.py 的 SERVER_VERSION；模板里的 0.0.0 在组装时替换。
 * 产物：resources/wechat-mcp/dist/npm/
 */

import { execFileSync, execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WINDOWS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = path.join(WINDOWS_ROOT, 'resources', 'wechat-mcp')
const TEMPLATE_DIR = path.join(SRC_DIR, 'npm')
const EXE_PATH = path.join(SRC_DIR, 'dist', 'wechat-mcp.exe')
const STAGE_DIR = path.join(SRC_DIR, 'dist', 'npm')
const MAIN_PKG = 'wechat-mcp'
const PLATFORM_PKG = 'wechat-mcp-win32-x64'
const PUBLIC_REGISTRY = 'https://registry.npmjs.org/'

/**
 * 打印带前缀的日志
 * @param {string} msg 日志内容
 */
function log(msg) {
  console.log(`[pack-wechat-mcp-npm] ${msg}`)
}

/**
 * 从 server.py 读取 SERVER_VERSION
 * @returns {string}
 */
function readServerVersion() {
  const source = fs.readFileSync(path.join(SRC_DIR, 'server.py'), 'utf-8')
  const match = source.match(/^SERVER_VERSION\s*=\s*"([^"]+)"/m)
  if (!match) throw new Error('server.py 里找不到 SERVER_VERSION')
  return match[1]
}

/**
 * 拷贝模板并写入版本号（主包的 optionalDependencies 同步锁到同一版本）
 * @param {string} name 模板目录名
 * @param {string} version 版本号
 * @returns {string} 组装后的包目录
 */
function stagePackage(name, version) {
  const dest = path.join(STAGE_DIR, name)
  fs.cpSync(path.join(TEMPLATE_DIR, name), dest, { recursive: true })
  const manifestPath = path.join(dest, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  manifest.version = version
  for (const dep of Object.keys(manifest.optionalDependencies ?? {})) {
    manifest.optionalDependencies[dep] = version
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return dest
}

/**
 * 在包目录执行 npm pack，返回 tgz 绝对路径
 * @param {string} dir 包目录
 */
function npmPack(dir) {
  const out = execSync(`npm pack --pack-destination "${STAGE_DIR}" --json`, { cwd: dir, encoding: 'utf-8' })
  return path.join(STAGE_DIR, JSON.parse(out)[0].filename)
}

/**
 * 本地装两个 tgz，经 cli.js 跑 --version 与 initialize 握手
 * @param {string[]} tarballs tgz 路径（主包 + 平台包）
 * @param {string} version 期望版本
 */
function verifyInstall(tarballs, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-mcp-npm-'))
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"verify","private":true}')
    execSync(`npm install --offline --no-audit --no-fund ${tarballs.map((t) => `"${t}"`).join(' ')}`, {
      cwd: dir,
      stdio: 'inherit',
    })
    const cli = path.join(dir, 'node_modules', '@lumii', MAIN_PKG, 'bin', 'cli.js')
    const printed = execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf-8' }).trim()
    if (printed !== version) throw new Error(`--version 输出 ${printed}，期望 ${version}`)

    const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    const result = spawnSync(process.execPath, [cli], { input: `${request}\n`, encoding: 'utf-8', timeout: 60_000 })
    const line = (result.stdout ?? '').split('\n').find((l) => l.trim())
    if (JSON.parse(line ?? 'null')?.result?.serverInfo?.version !== version) {
      throw new Error(`经 cli.js 握手失败：stdout=${result.stdout} stderr=${result.stderr}`)
    }
    log(`本地安装验证通过（--version 与 initialize 握手均为 v${version}）`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  }
}

/** 组装主流程 */
function main() {
  if (process.platform !== 'win32') throw new Error('wechat-mcp 目前只有 Windows 版，须在 Windows 上组装')
  const publish = process.argv.includes('--publish')
  const version = readServerVersion()

  execFileSync(process.execPath, [path.join(WINDOWS_ROOT, 'scripts', 'build-wechat-mcp.mjs'), '--if-stale'], {
    stdio: 'inherit',
  })

  fs.rmSync(STAGE_DIR, { recursive: true, force: true })
  const platformDir = stagePackage(PLATFORM_PKG, version)
  fs.mkdirSync(path.join(platformDir, 'bin'), { recursive: true })
  fs.copyFileSync(EXE_PATH, path.join(platformDir, 'bin', 'wechat-mcp.exe'))
  const mainDir = stagePackage(MAIN_PKG, version)

  const tarballs = [npmPack(mainDir), npmPack(platformDir)]
  log(`已打包 v${version}：${tarballs.map((t) => path.basename(t)).join('、')}`)
  verifyInstall(tarballs, version)

  if (!publish) {
    log('未加 --publish，只组装与验证。发布：node scripts/pack-wechat-mcp-npm.mjs --publish')
    return
  }
  // 平台包先发：主包一旦可见，用户安装就要能解析到同版本的平台包
  for (const dir of [platformDir, mainDir]) {
    execSync(`npm publish --access public --registry ${PUBLIC_REGISTRY}`, { cwd: dir, stdio: 'inherit' })
  }
  log(`已发布 @lumii/${PLATFORM_PKG}@${version} 与 @lumii/${MAIN_PKG}@${version}`)
}

try {
  main()
} catch (err) {
  console.error(`[pack-wechat-mcp-npm] 失败：${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
