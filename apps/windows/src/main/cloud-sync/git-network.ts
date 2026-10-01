/**
 * 云同步的网络慢路径：**真 git 子进程**（fetch / push）。
 *
 * ## 为什么网络操作必须走真 git
 *
 * isomorphic-git 的 HTTP 客户端（simple-get）有两个实测到的硬伤，在 sync 仓库长到
 * GB 级后同时爆发（2026-09-30 连续数周同步全挂的根因）：
 *
 * 1. **默认 5s socket 空闲超时**：Node 的 https Agent 给每条 socket
 *    `setTimeout(5000)`，而 GitCode 在算 pack 时会安静十几到几十秒，simple-get
 *    到点就 `abort()`。`git-http.ts` 关掉它只是第一层。
 * 2. **吞吐差一个数量级**：同一远端、同一凭证、同一网络，实测
 *    真 git 3.2~8.3MB/s（2.9GB pack 约 9 分钟）↔ isomorphic-git 0.5~0.7MB/s
 *    且反复中途 `aborted`（isomorphic-git 把响应体整块收进内存再落盘，
 *    没有真 git 的增量协商/多轮 ack）。
 *
 * 传输差的代价是**长度依赖的随机失败**：仓库越大越容易在半路断，而超时掐的只是
 * "等待"——后台仍在传、下一轮又从头开始，永远完不成。所以网络两件事
 * （fetch / push）交给真 git，本地对象操作（merge / commit / 读 ref）仍用
 * isomorphic-git——那边的 pack 阅读有 64MB 单包上限，与真 git 的分包 gc 配合。
 *
 * ## 凭证：只认客户端配置里的 token
 *
 * 不依赖用户机器的 git credential helper（那是环境状态，换台机器就没了）——
 * 把 sync 仓库配置里的 token 经 `GIT_ASKPASS` 临时脚本喂给子进程，用完即删。
 * token 不进命令行（pids 可见）、不进日志。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { detectGit, runGit } from '../git-cli'

const log = {
  info: (...args: unknown[]) => console.log('[cloud-sync/git-network]', ...args),
  warn: (...args: unknown[]) => console.warn('[cloud-sync/git-network]', ...args),
}

/** 网络操作默认超时：首次追平实测 9 分钟，给足余量 */
const DEFAULT_NETWORK_TIMEOUT_MS = 60 * 60_000

/**
 * 写一个"把密码读给 git"的临时脚本。
 *
 * git 调 askpass 时传一个提示串（"Username for ..." / "Password for ..."）作为参数；
 * 用户名固定 `oauth2`（GitCode 约定），密码从同目录的 token 文件读——
 * 这样 token 不出现在命令行里（命令行会出现在进程列表）。
 * 目录权限 0700、退出时删除。
 */
async function withAskpass<T>(
  token: string,
  fn: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const dir = path.join(os.tmpdir(), `lumii-sync-askpass-${randomBytes(6).toString('hex')}`)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tokenFile = path.join(dir, 'token')
  const scriptFile = path.join(dir, process.platform === 'win32' ? 'askpass.cmd' : 'askpass.sh')
  try {
    fs.writeFileSync(tokenFile, token, { encoding: 'utf-8', mode: 0o600 })
    if (process.platform === 'win32') {
      // cmd 里没有 sh 的重定向，用 type 读文件；%* 忽略 git 传的提示参数
      fs.writeFileSync(scriptFile, `@echo off\r\ntype "${tokenFile}"\r\n`, 'utf-8')
    } else {
      fs.writeFileSync(scriptFile, `#!/bin/sh\ncat "${tokenFile}"\n`, { encoding: 'utf-8', mode: 0o700 })
    }
    return await fn({
      GIT_ASKPASS: scriptFile,
      // 部分 git 版本在无 tty 时优先读这个变量而不是调 askpass
      GIT_ASKPASS_REQUIRE: 'force',
      GIT_TERMINAL_PROMPT: '0',
    })
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响结果，残留目录只有一次性 token */
    }
  }
}

export interface SyncFetchResult {
  ok: boolean
  /** 失败原因（已脱敏，可直接进日志） */
  error?: string
  /** 远端分支 tip（成功后） */
  remoteOid?: string
}

/**
 * 真 git fetch：拉远端分支到 `refs/remotes/origin/<branch>`。
 *
 * 与原 isomorphic-git 路径的契约差异：**不抛异常**，用返回值的 ok 表达成败——
 * 调用方原本就区分"远端没有该分支"（走首次推送）与"拉取失败"（等下轮），
 * 真 git 的错误文本在两个 locale 下不稳定，不适合按字符串分类。
 */
export async function nativeFetch(opts: {
  syncDir: string
  gitDir: string
  repoUrl: string
  branch: string
  token: string
  timeoutMs?: number
}): Promise<SyncFetchResult> {
  if (!(await detectGit())) return { ok: false, error: '系统 git 不可用' }

  const refspec = `+refs/heads/${opts.branch}:refs/remotes/origin/${opts.branch}`
  const t0 = Date.now()
  try {
    const res = await withAskpass(opts.token, (env) =>
      runGit({
        workTree: opts.syncDir,
        gitDir: opts.gitDir,
        args: ['fetch', '--no-tags', '--progress', opts.repoUrl, refspec],
        config: ['-c', 'http.sslVerify=false'],
        timeoutMs: opts.timeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS,
        env: { ...env, GIT_ASKPASS_DISABLE: '' },
      }),
    )
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    if (res.code !== 0) {
      return { ok: false, error: sanitizeGitError(res.stderr || res.stdout, opts.token) }
    }
    // 成功：读远端 tip 回填返回值
    const head = await runGit({
      workTree: opts.syncDir,
      gitDir: opts.gitDir,
      args: ['rev-parse', `refs/remotes/origin/${opts.branch}`],
      timeoutMs: 30_000,
    })
    const remoteOid = head.code === 0 ? head.stdout.trim() : undefined
    log.info(`[nativeFetch] 完成 ${elapsed}s remote=${remoteOid?.slice(0, 8) ?? '?'}`)
    return { ok: true, remoteOid }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 真 git push：把本地分支推到远端同名分支 */
export async function nativePush(opts: {
  syncDir: string
  gitDir: string
  repoUrl: string
  branch: string
  token: string
  timeoutMs?: number
}): Promise<{ ok: boolean; rejected: boolean; error?: string }> {
  if (!(await detectGit())) return { ok: false, rejected: false, error: '系统 git 不可用' }

  const t0 = Date.now()
  try {
    const res = await withAskpass(opts.token, (env) =>
      runGit({
        workTree: opts.syncDir,
        gitDir: opts.gitDir,
        args: ['push', '--progress', opts.repoUrl, `refs/heads/${opts.branch}:refs/heads/${opts.branch}`],
        config: ['-c', 'http.sslVerify=false'],
        timeoutMs: opts.timeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS,
        env,
      }),
    )
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    if (res.code === 0) {
      log.info(`[nativePush] 完成 ${elapsed}s`)
      return { ok: true, rejected: false }
    }
    const text = res.stderr || res.stdout
    return {
      ok: false,
      // 非快进是"远端有更新"，调用方要降级为下轮重试而不是报错
      rejected: /\[rejected\]|non-fast-forward|fetch first/i.test(text),
      error: sanitizeGitError(text, opts.token),
    }
  } catch (err) {
    return { ok: false, rejected: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 错误文本脱敏 + 截断：git 的 stderr 可能带 URL 里的凭证或极长进度行 */
function sanitizeGitError(text: string, token: string): string {
  let out = text
  if (token) out = out.split(token).join('***')
  out = out.replace(/\/\/[^/@\s]*@/g, '//***@')
  const lines = out.split(/\r?\n/).filter((l) => l.trim() && !/^\s*(Receiving|Resolving|Counting|Compressing)\s/.test(l))
  return lines.slice(-6).join('\n').slice(0, 2000) || 'git 退出码非 0'
}
