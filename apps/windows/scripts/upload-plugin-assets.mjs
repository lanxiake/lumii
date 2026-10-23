/**
 * 发版：把**跟 App 版本绑定**的按需资产上传到 GitHub Release（tag = `v<App版本>`）。
 *
 *   pet-<id>.zip            → 移出随包的宠物（id 见 src/plugins/install/builtin.ts 的 PET_PLUGIN_IDS）
 *   ext-<id>.js             → 官方外部扩展（清单见 resources/extensions/catalog.json）
 *
 * 微信 MCP **不在这里**：它跟 App 解耦、发到自己的 tag
 * `wechat-chat-mcp-v<版本>`（见 `upload-wechat-mcp.mjs`），升级不必跟着 App 发版。
 *
 * 用法：node scripts/upload-plugin-assets.mjs [--dry-run] [--no-proxy] [--skip-build] [--only=<资产名,...>]
 * 前置：无需 `gh`；token 从 git 凭据管理器取，REST 走本地代理（127.0.0.1:10808）。
 * ffmpeg 走 npm（npmmirror），不需要这里的资产。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createGithubRelease, sha256Of } from './github-release.mjs'

const WINDOWS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PET_IDS = ['demo_cartoon_cat', 'ug_official', 'xiaomai']

const dryRun = process.argv.includes('--dry-run')
const noProxy = process.argv.includes('--no-proxy')
const skipBuild = process.argv.includes('--skip-build')
/** `--only=pet-x.zip,ext-x.js`：补传单个资产时用，避免为了一个文件重打全部包 */
const onlyArg = process.argv.find((a) => a.startsWith('--only='))
const only = onlyArg
  ? onlyArg
      .slice('--only='.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : null

function log(msg) {
  console.log(`[upload-plugin-assets] ${msg}`)
}

function runBuild(script, ...args) {
  execFileSync(process.execPath, [path.join(WINDOWS_ROOT, 'scripts', script), ...args], {
    stdio: 'inherit',
    windowsHide: true,
  })
}

function main() {
  const version = JSON.parse(fs.readFileSync(path.join(WINDOWS_ROOT, 'package.json'), 'utf-8')).version
  const tag = `v${version}`
  log(`App 版本 ${version} → tag ${tag}（客户端拼的 URL 就用它）`)

  if (skipBuild) {
    log('跳过构建（--skip-build）')
  } else {
    log('打包宠物 zip')
    runBuild('pack-pet-zips.mjs')
    log('构建官方扩展')
    runBuild('build-official-extensions.mjs')
  }

  const extRoot = path.join(WINDOWS_ROOT, 'resources', 'extensions')
  const catalog = JSON.parse(fs.readFileSync(path.join(extRoot, 'catalog.json'), 'utf-8'))
  const all = [
    ...PET_IDS.map((id) => {
      const file = path.join(WINDOWS_ROOT, 'resources', 'pet-models', 'dist', `pet-${id}.zip`)
      return { file, name: path.basename(file), sha256: undefined }
    }),
    ...catalog.extensions.map((entry) => ({
      file: path.join(extRoot, entry.id, 'main.js'),
      name: entry.asset,
      sha256: entry.sha256,
    })),
  ]
  const assets = only ? all.filter((a) => only.includes(a.name)) : all
  if (assets.length === 0) throw new Error(`没有匹配的资产：${only?.join(', ')}`)
  for (const asset of assets) {
    if (!fs.existsSync(asset.file)) throw new Error(`资产缺失：${asset.file}`)
    asset.sha256 ??= sha256Of(asset.file)
  }

  const client = createGithubRelease({ dryRun, noProxy })
  const release = client.ensureRelease(tag)

  log(`${dryRun ? '[dry-run] ' : ''}上传 ${assets.length} 个资产`)
  for (const asset of assets) {
    client.upsertAsset(release, asset.file, asset.name)
    log(`  · ${asset.name}（${(fs.statSync(asset.file).size / 1048576).toFixed(1)} MB）`)
  }

  // 判据：下载回来对 sha256；「上传成功」只说明 HTTP 201
  if (!dryRun) {
    for (const asset of assets) {
      client.verifyDownload(tag, asset.name, asset.sha256)
      log(`  ✓ ${asset.name} sha256 ${asset.sha256.slice(0, 12)}`)
    }
  }
  log(`完成：${assets.map((a) => a.name).join('、')}`)
}

try {
  main()
} catch (err) {
  console.error(`[upload-plugin-assets] 失败：${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
}
