/**
 * 把官方外部扩展（`ext-<id>.js`）发布到 GitHub Release。
 *
 * 安装包只带 `catalog.json`；用户点「安装」时客户端从
 * `https://github.com/lanxiake/lumii/releases/download/v<App版本>/ext-<id>.js`
 * 下载并按 catalog 里的 sha256 校验。所以**发版必须上传这些资产**，
 * 否则新装用户看到的「可安装」会 404。
 *
 * 只是扩展的子集；完整发版用 `upload-plugin-assets.mjs`（它也会调本脚本的构建）。
 *
 * 用法：node scripts/publish-official-extensions.mjs [--dry-run] [--no-proxy]
 * 前置：pnpm dev / prebuild 已生成 resources/extensions（脚本自己会重新构建）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createGithubRelease, sha256Of } from './github-release.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WINDOWS_ROOT = path.resolve(HERE, '..')

const dryRun = process.argv.includes('--dry-run')
const noProxy = process.argv.includes('--no-proxy')

function log(msg) {
  console.log(`[publish-official-ext] ${msg}`)
}

function main() {
  log('构建官方扩展')
  execFileSync(process.execPath, [path.join(HERE, 'build-official-extensions.mjs')], {
    stdio: 'inherit',
    windowsHide: true,
  })

  const extRoot = path.join(WINDOWS_ROOT, 'resources', 'extensions')
  const catalog = JSON.parse(fs.readFileSync(path.join(extRoot, 'catalog.json'), 'utf-8'))
  const version = JSON.parse(fs.readFileSync(path.join(WINDOWS_ROOT, 'package.json'), 'utf-8')).version
  const tag = `v${version}`
  log(`App 版本 ${version} → tag ${tag}；扩展 ${catalog.extensions.length} 个`)

  const client = createGithubRelease({ dryRun, noProxy })
  const release = client.ensureRelease(tag)

  for (const entry of catalog.extensions) {
    const file = path.join(extRoot, entry.id, 'main.js')
    const sha = sha256Of(file)
    if (sha !== entry.sha256) throw new Error(`${entry.id}: catalog sha256 与产物不一致`)
    client.upsertAsset(release, file, entry.asset)
    log(`${dryRun ? '[dry-run] ' : ''}已上传 ${entry.asset}（${(fs.statSync(file).size / 1024).toFixed(0)}KB）`)
  }

  // 对账：下载回来逐字节校验（dry-run 跳过）
  if (!dryRun) {
    for (const entry of catalog.extensions) {
      const actual = client.verifyDownload(tag, entry.asset, entry.sha256)
      log(`✓ ${entry.asset} sha256 ${actual.slice(0, 12)}`)
    }
  }
  log(`完成：${catalog.extensions.map((e) => e.asset).join('、')}`)
}

try {
  main()
} catch (err) {
  console.error(`[publish-official-ext] 失败：${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
}
