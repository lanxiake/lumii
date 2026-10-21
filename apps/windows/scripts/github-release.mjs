/**
 * GitHub Release 发布工具（REST + curl + 本地代理）。
 *
 * 为什么不用 `gh`：本机没有装（PATH 与常见安装目录都没有），但发版是必须能跑的。
 * token 从 git 凭据管理器取（classic PAT），不落盘、不打印。
 *
 * 上传后**下载回来对 sha256** 是验收判据 —— 「上传成功」只说明 HTTP 201。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = 'lanxiake/lumii'
const API = `https://api.github.com/repos/${REPO}`
const UPLOAD = `https://uploads.github.com/repos/${REPO}`
const DEFAULT_PROXY = 'http://127.0.0.1:10808'

/** git 凭据管理器里的 GitHub PAT（不落盘、不打印） */
export function readGithubToken() {
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

export function sha256Of(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * @param {{ proxy?: string, noProxy?: boolean, dryRun?: boolean }} [opts]
 */
export function createGithubRelease(opts = {}) {
  const useProxy = !opts.noProxy
  const proxy = opts.proxy?.trim() || process.env.LUMII_PROXY?.trim() || DEFAULT_PROXY
  const dryRun = Boolean(opts.dryRun)
  let token = null

  function auth() {
    token ??= readGithubToken()
    return token
  }

  /** curl + 临时配置文件：token 走文件（0600），不进 argv/进程列表 */
  function curl(args, withToken = true) {
    const configFile = path.join(os.tmpdir(), `.lumii-curlrc-${process.pid}`)
    const config = []
    if (useProxy) config.push(`proxy = "${proxy}"`)
    if (withToken) config.push(`header = "Authorization: Bearer ${auth()}"`)
    config.push('header = "Accept: application/vnd.github+json"')
    config.push('header = "X-GitHub-Api-Version: 2022-11-28"')
    fs.writeFileSync(configFile, `${config.join('\n')}\n`, { mode: 0o600 })
    try {
      return execFileSync('curl', ['-sS', '-K', configFile, ...args], {
        encoding: 'utf-8',
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      })
    } finally {
      fs.rmSync(configFile, { force: true })
    }
  }

  function api(pathname, { method = 'GET', body } = {}) {
    const args = ['-X', method, `${API}${pathname}`, '-w', '\n%{http_code}']
    if (body !== undefined) args.push('-H', 'Content-Type: application/json', '--data-binary', body)
    const out = curl(args)
    const idx = out.lastIndexOf('\n')
    return { status: Number(out.slice(idx + 1).trim()), text: out.slice(0, idx), body: safeJson(out.slice(0, idx)) }
  }

  function ensureRelease(tag) {
    if (dryRun) return { tag_name: tag, assets: [], id: 0 }
    const got = api(`/releases/tags/${encodeURIComponent(tag)}`)
    if (got.status === 200) return got.body
    if (got.status !== 404) throw new Error(`查询 release 失败 HTTP ${got.status}: ${got.text.slice(0, 300)}`)
    const created = api('/releases', {
      method: 'POST',
      body: JSON.stringify({ tag_name: tag, name: tag, draft: false, prerelease: false }),
    })
    if (created.status !== 201) {
      throw new Error(`创建 release 失败 HTTP ${created.status}: ${created.text.slice(0, 300)}`)
    }
    return created.body
  }

  function deleteAsset(assetId) {
    const out = curl(['-X', 'DELETE', `${API}/releases/assets/${assetId}`, '-w', '\n%{http_code}'])
    const status = Number(out.slice(out.lastIndexOf('\n') + 1).trim())
    if (status !== 204) throw new Error(`删除旧资产 ${assetId} 失败 HTTP ${status}`)
  }

  /** 同名资产先删后传（Release 不支持覆盖） */
  function upsertAsset(release, file, name = path.basename(file)) {
    if (dryRun) return
    const existing = (release.assets ?? []).find((a) => a.name === name)
    if (existing) deleteAsset(existing.id)
    const out = curl(
      [
        '-X', 'POST',
        `${UPLOAD}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
        '-H', 'Content-Type: application/octet-stream',
        '--data-binary', `@${file}`,
        '-w', '\n%{http_code}',
      ],
    )
    const idx = out.lastIndexOf('\n')
    const status = Number(out.slice(idx + 1).trim())
    if (status !== 201) throw new Error(`上传 ${name} 失败 HTTP ${status}: ${out.slice(0, 300)}`)
  }

  /** 下载回来核对 sha256；返回实际值 */
  function verifyDownload(tag, name, expectSha) {
    if (dryRun) return expectSha
    const url = `https://github.com/${REPO}/releases/download/${tag}/${name}`
    const tmp = path.join(os.tmpdir(), `.lumii-verify-${process.pid}-${name.replace(/[^\w.-]/g, '_')}`)
    try {
      execFileSync(
        'curl',
        ['-sS', '-L', ...(useProxy ? ['-x', proxy] : []), '-H', `Authorization: Bearer ${auth()}`, '-o', tmp, url],
        { windowsHide: true },
      )
      const actual = sha256Of(tmp)
      if (expectSha && actual !== expectSha) {
        throw new Error(`${name} 下载回来 sha256 不符（${actual} != ${expectSha}）`)
      }
      return actual
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  }

  return { repo: REPO, ensureRelease, upsertAsset, verifyDownload, dryRun }
}
