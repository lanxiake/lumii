/**
 * 发版：把微信 MCP（`wechat-chat-mcp`）发到**它自己的 tag**，与 App 版本解耦。
 *
 *   tag    = `wechat-chat-mcp-v<WECHAT_MCP_VERSION>`
 *   asset  = `wechat-chat-mcp.exe`
 *
 * **客户端不再下载这个资产**（2026-10-25：MCP 与插件解耦，用户自己装、自己在
 * 「设置 › MCP 服务」里配）。本脚本仍用于把二进制发到公开 release，供用户手动取；
 * `mcp-presets.ts` 的 `WECHAT_MCP_VERSION` 只表示「客户端验证过的版本」，发版后
 * 跟着改，面板据此提示「低于验证版」。
 *
 * 用法：node scripts/upload-wechat-mcp.mjs [--dry-run] [--no-proxy] [--skip-build]
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createGithubRelease, sha256Of } from './github-release.mjs'
import { wechatMcpRepo } from './wechat-mcp-repo.mjs'

const WINDOWS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PRESETS_TS = path.join(WINDOWS_ROOT, 'src', 'shared', 'mcp-presets.ts')
const ASSET_NAME = 'wechat-chat-mcp.exe'

const dryRun = process.argv.includes('--dry-run')
const noProxy = process.argv.includes('--no-proxy')
const skipBuild = process.argv.includes('--skip-build')

function log(msg) {
  console.log(`[upload-wechat-mcp] ${msg}`)
}

/** 版本唯一来源仍是独立仓库；TS 里是镜像，测试会对账 */
function readTsVersion() {
  const src = fs.readFileSync(PRESETS_TS, 'utf-8')
  const version = src.match(/WECHAT_MCP_VERSION\s*=\s*'([^']+)'/)?.[1]
  if (!version) throw new Error(`读不到 WECHAT_MCP_VERSION：${PRESETS_TS}`)
  return version
}

/** 优先用带版本号的副本，防止把没改版本号的旧产物传上去 */
function resolveExe(version) {
  const repo = wechatMcpRepo()
  const dir = path.join(repo, 'dist', 'wechat-chat-mcp')
  const candidates = [
    path.join(dir, `wechat-chat-mcp-${version}.exe`),
    path.join(dir, 'wechat-chat-mcp.exe'),
    // 旧布局（三档时代）只作迁移兜底
    path.join(repo, 'dist', 'pro', 'wechat-mcp.exe'),
  ]
  const hit = candidates.find((file) => fs.existsSync(file))
  if (!hit) {
    throw new Error(`找不到构建产物。先跑 node scripts/build-wechat-mcp.mjs；候选：\n  ${candidates.join('\n  ')}`)
  }
  return hit
}

function main() {
  const version = readTsVersion()
  const tag = `wechat-chat-mcp-v${version}`
  log(`MCP 版本 ${version} → tag ${tag}`)

  if (skipBuild) {
    log('跳过构建（--skip-build）')
  } else {
    log('构建 wechat-chat-mcp（--if-stale）')
    execFileSync(process.execPath, [path.join(WINDOWS_ROOT, 'scripts', 'build-wechat-mcp.mjs'), '--if-stale'], {
      stdio: 'inherit',
      windowsHide: true,
    })
  }

  const file = resolveExe(version)
  const sha256 = sha256Of(file)
  const sizeMb = (fs.statSync(file).size / 1048576).toFixed(1)
  log(`上传 ${path.basename(file)} → ${ASSET_NAME}（${sizeMb} MB）`)

  const client = createGithubRelease({ dryRun, noProxy })
  const release = client.ensureRelease(tag)
  client.upsertAsset(release, file, ASSET_NAME)

  // 判据：下载回来对 sha256；「上传成功」只说明 HTTP 201
  if (!dryRun) {
    client.verifyDownload(tag, ASSET_NAME, sha256)
    log(`✓ ${ASSET_NAME} sha256 ${sha256.slice(0, 12)}`)
  }
  log('完成')
}

try {
  main()
} catch (err) {
  console.error(`[upload-wechat-mcp] 失败：${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
}
