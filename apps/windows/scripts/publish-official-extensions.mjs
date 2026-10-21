/**
 * 把官方外部扩展（`ext-<id>.js`）发布到 GitHub Release。
 *
 * 安装包只带 `catalog.json`；用户点「安装」时客户端从
 * `https://github.com/lanxiake/lumii/releases/download/v<App版本>/ext-<id>.js`
 * 下载并按 catalog 里的 sha256 校验。所以**发版必须跑本脚本**，
 * 否则新装用户看到的「可安装」会 404。
 *
 * 本机没有 `gh`：token 从 git 凭据管理器取（classic PAT），REST 走 curl + 本地代理。
 * 不打印 token。
 *
 * 用法：node scripts/publish-official-extensions.mjs [--dry-run] [--no-proxy]
 * 前置：pnpm dev / prebuild 已生成 resources/extensions（脚本自己会重新构建）。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WINDOWS_ROOT = path.resolve(HERE, '..')
const REPO = 'lanxiake/lumii'
const API = `https://api.github.com/repos/${REPO}`
const UPLOAD = `https://uploads.github.com/repos/${REPO}`
const PROXY = process.env.LUMII_PROXY?.trim() || 'http://127.0.0.1:10808'

const dryRun = process.argv.includes('--dry-run')
const useProxy = !process.argv.includes('--no-proxy')

function log(msg) {
  console.log(`[publish-official-ext] ${msg}`)
}

/** git 凭据管理器里的 GitHub PAT（不落盘、不打印） */
function readGithubToken() {
  const r = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf-8',
    windowsHide: true,
  })
  if (r.status !== 0) throw new Error(`git credential fill 失败：${r.stderr || r.status}`)
  const line = r.stdout.split('\n').find((l) => l.startsWith('password='))
  const token = line?.slice('password='.length).trim()
  if (!token) throw new Error('凭据管理器里没有 github.com 的密码/token')
  return token
}

/** curl + 临时配置文件：token 走文件（0600），不进 argv/进程列表 */
function curl(args, { token, input } = {}) {
  const configFile = path.join(os.tmpdir(), `.lumii-curlrc-${process.pid}`)
  const config = []
  if (useProxy) config.push(`proxy = "${PROXY}"`)
  if (token) config.push(`header = "Authorization: Bearer ${token}"`)
  config.push('header = "Accept: application/vnd.github+json"')
  config.push('header = "X-GitHub-Api-Version: 2022-11-28"')
  fs.writeFileSync(configFile, `${config.join('\n')}\n`, { mode: 0o600 })
  try {
    return execFileSync('curl', ['-sS', '-K', configFile, ...args], {
      encoding: 'utf-8',
      windowsHide: true,
      input,
      maxBuffer: 32 * 1024 * 1024,
    })
  } finally {
    fs.rmSync(configFile, { force: true })
  }
}

function api(pathname, { method = 'GET', body, token } = {}) {
  const args = ['-X', method, `${API}${pathname}`, '-w', '\n%{http_code}']
  if (body !== undefined) args.push('-H', 'Content-Type: application/json', '--data-binary', body)
  const out = curl(args, { token })
  const idx = out.lastIndexOf('\n')
  return { status: Number(out.slice(idx + 1).trim()), text: out.slice(0, idx), body: safeJson(out.slice(0, idx)) }
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function sha256Of(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** 确保 tag 对应的 release 存在；返回 release 对象 */
function ensureRelease(tag, token) {
  const got = api(`/releases/tags/${encodeURIComponent(tag)}`, { token })
  if (got.status === 200) return got.body
  if (got.status !== 404) throw new Error(`查询 release 失败 HTTP ${got.status}: ${got.text.slice(0, 300)}`)
  log(`release ${tag} 不存在，创建`)
  if (dryRun) return { tag_name: tag, assets: [], id: 0 }
  const created = api('/releases', {
    method: 'POST',
    token,
    body: JSON.stringify({ tag_name: tag, name: tag, draft: false, prerelease: false }),
  })
  if (created.status !== 201) throw new Error(`创建 release 失败 HTTP ${created.status}: ${created.text.slice(0, 300)}`)
  return created.body
}

function uploadAsset(releaseId, file, name, token) {
  const out = curl(
    [
      '-X', 'POST',
      `${UPLOAD}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
      '-H', 'Content-Type: application/javascript',
      '--data-binary', `@${file}`,
      '-w', '\n%{http_code}',
    ],
    { token },
  )
  const idx = out.lastIndexOf('\n')
  const status = Number(out.slice(idx + 1).trim())
  if (status !== 201) throw new Error(`上传 ${name} 失败 HTTP ${status}: ${out.slice(0, 300)}`)
  return safeJson(out.slice(0, idx))
}

function deleteAsset(assetId, token) {
  const out = curl(['-X', 'DELETE', `${API}/releases/assets/${assetId}`, '-w', '\n%{http_code}'], { token })
  const status = Number(out.slice(out.lastIndexOf('\n') + 1).trim())
  if (status !== 204) throw new Error(`删除旧资产 ${assetId} 失败 HTTP ${status}`)
}

/** 从 GitHub 下载回来对账：「上传成功」只说明 HTTP 201 */
function verifyDownload(tag, asset, expectSha, token) {
  const url = `https://github.com/${REPO}/releases/download/${tag}/${asset}`
  const tmp = path.join(WINDOWS_ROOT, 'resources', `.verify-${asset}`)
  try {
    execFileSync(
      'curl',
      ['-sS', '-L', ...(useProxy ? ['-x', PROXY] : []), '-H', `Authorization: Bearer ${token}`, '-o', tmp, url],
      { windowsHide: true },
    )
    const actual = sha256Of(tmp)
    if (actual !== expectSha) throw new Error(`${asset} 下载回来 sha256 不符（${actual} != ${expectSha}）`)
    return actual
  } finally {
    fs.rmSync(tmp, { force: true })
  }
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

  if (dryRun) {
    for (const entry of catalog.extensions) {
      const file = path.join(extRoot, entry.id, 'main.js')
      log(`[dry-run] ${entry.asset} (${fs.statSync(file).size} bytes, sha256 ${sha256Of(file).slice(0, 12)})`)
    }
    return
  }

  const token = readGithubToken()
  const release = ensureRelease(tag, token)
  const existing = new Map((release.assets ?? []).map((a) => [a.name, a.id]))

  for (const entry of catalog.extensions) {
    const file = path.join(extRoot, entry.id, 'main.js')
    const sha = sha256Of(file)
    if (existing.has(entry.asset)) {
      log(`替换已有资产 ${entry.asset} (id=${existing.get(entry.asset)})`)
      deleteAsset(existing.get(entry.asset), token)
    }
    uploadAsset(release.id, file, entry.asset, token)
    log(`已上传 ${entry.asset}（${(fs.statSync(file).size / 1024).toFixed(0)}KB）`)
  }

  // 对账：下载回来逐字节校验
  for (const entry of catalog.extensions) {
    const actual = verifyDownload(tag, entry.asset, entry.sha256, token)
    log(`✓ ${entry.asset} sha256 ${actual.slice(0, 12)}`)
  }
  log(`完成：${catalog.extensions.map((e) => e.asset).join('、')}`)
}

try {
  main()
} catch (err) {
  console.error(`[publish-official-ext] 失败：${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
}
