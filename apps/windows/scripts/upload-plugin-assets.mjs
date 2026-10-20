/**
 * 把插件资产上传到 GitHub Release。
 *
 * 客户端按需下载这些资产（走 gh 镜像加速，见 `src/main/plugins/github-fetch.ts`）：
 *   wechat-mcp.exe          → 微信本机助手插件（tag 必须 = `v<App版本>`）
 *   pet-<id>.zip            → 移出随包的宠物（id 见 main/plugins/builtin.ts 的 PET_PLUGIN_IDS）
 *
 * 用法：node scripts/upload-plugin-assets.mjs [--dry-run]
 * 前置：`gh` 已登录且有该仓库写权限；release 不存在时会自动创建。
 * ffmpeg 走 npm（npmmirror），不需要这里的资产。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { wechatMcpRepo } from './wechat-mcp-repo.mjs'

const WINDOWS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'lanxiake/lumii'
/** 客户端认的资产名（与 builtin.ts 一致）；源码已迁到独立仓库 */
const WECHAT_MCP = path.join(wechatMcpRepo(), 'dist', 'pro', 'wechat-mcp.exe')
const PET_IDS = ['demo_cartoon_cat', 'ug_official', 'xiaomai']

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

  // 确保资产都是当前源码构建的
  log('构建 wechat-mcp.exe（--if-stale）')
  execFileSync(process.execPath, [path.join(WINDOWS_ROOT, 'scripts', 'build-wechat-mcp.mjs'), '--if-stale'], {
    stdio: 'inherit',
    windowsHide: true,
  })
  log('打包宠物 zip')
  execFileSync(process.execPath, [path.join(WINDOWS_ROOT, 'scripts', 'pack-pet-zips.mjs')], {
    stdio: 'inherit',
    windowsHide: true,
  })

  const assets = [
    WECHAT_MCP,
    ...PET_IDS.map((id) => path.join(WINDOWS_ROOT, 'resources', 'pet-models', 'dist', `pet-${id}.zip`)),
  ]
  for (const f of assets) {
    if (!fs.existsSync(f)) throw new Error(`资产缺失：${f}`)
  }

  if (dryRun) {
    log(`[dry-run] 将上传 ${assets.length} 个资产 → ${REPO} release ${tag}`)
    for (const f of assets) console.log(`  · ${path.basename(f)}（${(fs.statSync(f).size / 1048576).toFixed(1)} MB）`)
    return
  }

  if (!releaseExists(tag)) {
    log(`release ${tag} 不存在，创建中`)
    execFileSync('gh', ['release', 'create', tag, '--repo', REPO, '--title', tag, '--notes', `Lumii ${tag}`], {
      stdio: 'inherit',
      windowsHide: true,
    })
  }

  log(`上传 ${assets.length} 个资产（--clobber 覆盖旧的）`)
  execFileSync('gh', ['release', 'upload', tag, ...assets, '--repo', REPO, '--clobber'], {
    stdio: 'inherit',
    windowsHide: true,
  })
  for (const f of assets) log(`  ✓ https://github.com/${REPO}/releases/download/${tag}/${path.basename(f)}`)
}

try {
  main()
} catch (err) {
  console.error(`[upload-plugin-assets] 失败：${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
