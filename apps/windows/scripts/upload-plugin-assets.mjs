/**
 * 把插件资产上传到 GitHub Release。
 *
 * 客户端在装「微信本机助手」插件时，从
 *   https://github.com/<repo>/releases/download/v<App版本>/wechat-mcp.exe
 * 下载（走 gh 镜像加速，见 `src/main/plugins/github-fetch.ts`）。**tag 必须等于
 * 客户端拼的 `v${app.getVersion()}`**，否则下载 404。
 *
 * 用法：node scripts/upload-plugin-assets.mjs [--dry-run]
 * 前置：`gh` 已登录且有该仓库写权限；release 不存在时会自动创建。
 * 只传 wechat-mcp；ffmpeg 走 npm（npmmirror），不需要这里的资产。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WINDOWS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'lanxiake/lumii'
const EXE = path.join(WINDOWS_ROOT, 'resources', 'wechat-mcp', 'dist', 'wechat-mcp.exe')
/** 客户端认的资产名（与 builtin.ts 的 WECHAT_MCP_ASSET 一致） */
const ASSET_NAME = 'wechat-mcp.exe'

function log(msg) {
  console.log(`[upload-plugin-assets] ${msg}`)
}

/** 是否已有这个 tag 的 release */
function releaseExists(tag) {
  const r = spawnSync('gh', ['release', 'view', tag, '--repo', REPO], { encoding: 'utf-8', windowsHide: true })
  return r.status === 0
}

function main() {
  const dryRun = process.argv.includes('--dry-run')

  const version = JSON.parse(
    fs.readFileSync(path.join(WINDOWS_ROOT, 'package.json'), 'utf-8'),
  ).version
  const tag = `v${version}`
  log(`App 版本 ${version} → tag ${tag}（客户端拼的 URL 就用它）`)

  // 确保 exe 是最新的（客户端拿到的必须是当前源码构建的）
  log('构建 wechat-mcp.exe（--if-stale）')
  execFileSync(process.execPath, [path.join(WINDOWS_ROOT, 'scripts', 'build-wechat-mcp.mjs'), '--if-stale'], {
    stdio: 'inherit',
    windowsHide: true,
  })
  if (!fs.existsSync(EXE)) throw new Error(`构建产物缺失：${EXE}`)

  if (dryRun) {
    log(`[dry-run] 将上传 ${path.relative(WINDOWS_ROOT, EXE)} → ${REPO} release ${tag} 的 ${ASSET_NAME}`)
    return
  }

  if (!releaseExists(tag)) {
    log(`release ${tag} 不存在，创建中`)
    execFileSync('gh', ['release', 'create', tag, '--repo', REPO, '--title', tag, '--notes', `Lumii ${tag}`], {
      stdio: 'inherit',
      windowsHide: true,
    })
  }

  log(`上传 ${ASSET_NAME}（--clobber 覆盖旧的）`)
  execFileSync('gh', ['release', 'upload', tag, EXE, `--repo`, REPO, `--clobber`], {
    stdio: 'inherit',
    windowsHide: true,
  })
  log(`完成：https://github.com/${REPO}/releases/download/${tag}/${ASSET_NAME}`)
}

try {
  main()
} catch (err) {
  console.error(`[upload-plugin-assets] 失败：${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
