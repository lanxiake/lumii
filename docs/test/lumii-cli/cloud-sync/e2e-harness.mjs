/**
 * 云同步 E2E 测试的引导层：隔离数据目录 + 本地 git 远程 + 真实客户端进程。
 *
 * 三条硬约束（都有安全含义，别绕过）：
 *  1. **必须**在测试专用数据目录下运行 —— 真实 `~/.lumii` 里的云同步配置
 *     指向真实 GitCode 仓库，对它发同步会污染线上数据。这里显式拒绝。
 *  2. 客户端以 `--test-mode` 启动，跳过单实例锁，才能与用户正在用的实例共存。
 *  3. 结束务必 `stop()`：Electron 是 detached 的孙进程，不杀会残留。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'

export const ROOT = path.resolve(import.meta.dirname, '../../../..')

/** 测试数据目录必须位于此前缀下，防止误用真实用户数据 */
const SAFE_PREFIX = path.join(os.tmpdir(), 'lumii-sync-e2e-')

export function assertIsolatedDataRoot(dataRoot) {
  const resolved = path.resolve(dataRoot)
  const tmp = path.resolve(os.tmpdir())
  const isTmpChild = resolved.startsWith(tmp + path.sep)
  const isMarked = resolved.includes('lumii-e2e') || resolved.includes('lumii-sync-e2e')
  if (!isTmpChild || !isMarked) {
    throw new Error(
      `拒绝在非隔离目录运行云同步 E2E：${resolved}\n` +
        `要求：位于 ${tmp} 下且路径含 "lumii-e2e"。` +
        `真实 ~/.lumii 的云同步指向线上仓库，误跑会污染真实数据。`,
    )
  }
}

export function makeTempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lumii-sync-e2e-${label}-`))
}

/** 轮询直到 predicate 为真；超时抛错 */
export async function waitFor(predicate, { timeoutMs = 90_000, intervalMs = 1_000, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await predicate()
      if (last) return last
    } catch (err) {
      last = err
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`等待${label}超时（${timeoutMs}ms），最后结果：${last}`)
}

/** 读控制口信息（客户端 listen 成功后写入） */
export function readRuntimeInfo(dataRoot) {
  try {
    const raw = fs.readFileSync(path.join(dataRoot, 'runtime', 'app-ui.json'), 'utf-8')
    const info = JSON.parse(raw)
    return typeof info?.port === 'number' ? info : null
  } catch {
    return null
  }
}

/** 写云同步配置（绕过设置页的 URL 校验，指向本地 git server） */
export function writeCloudSyncConfig(dataRoot, { repoUrl, token, intervalMinutes = 1440, enabled = true }) {
  const file = path.join(dataRoot, 'config', 'cloud-sync.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        enabled,
        provider: 'gitcode', // 只为实现 oauth2:<token> 认证头；真实同步路径不校验 URL
        repoUrl,
        branch: 'main',
        intervalMinutes,
        tokenEnc: `plain:${token}`,
      },
      null,
      2,
    ),
    'utf-8',
  )
  return file
}

/**
 * 启动一个隔离的真实客户端实例。
 *
 * 额外传 `--user-data-dir=<唯一路径>`，一石二鸟：
 *  - 隔离 Electron userData（`LUMII_CLIENT_DATA_DIR` 管不到 `%APPDATA%\lumii-windows`，
 *    渲染进程 localStorage 里的设置会跨数据目录共享）
 *  - 给测试实例一个**可识别且唯一**的命令行标记。数据目录是靠环境变量传的、
 *    不出现在命令行里，没有这个标记就无法在不误伤用户正在跑的实例的前提下精确清理。
 *
 * @returns {{ proc, dataRoot, workspaceDir, userDataDir, logs: string[], stop(): Promise<void> }}
 */
export async function startClient({ dataRoot, extraArgs = [] }) {
  assertIsolatedDataRoot(dataRoot)
  fs.mkdirSync(dataRoot, { recursive: true })

  const userDataDir = `${dataRoot}-userdata`
  const logs = []

  // 走 pnpm dev（= apps/windows 的 run-dev.cjs，原样透传给 electron-vite）。
  // 两个参数不能省：
  //  - --test-mode：跳过单实例锁，否则用户已在运行的实例会让本实例静默 app.quit()
  //  - --user-data-dir：隔离 Electron userData（LUMII_CLIENT_DATA_DIR 管不到
  //    %APPDATA%\lumii-windows），同时给清理逻辑一个唯一可识别的进程标记 ——
  //    数据目录是靠环境变量传的、不出现在命令行里
  const cliArgs = ['--test-mode', `--user-data-dir=${userDataDir}`, ...extraArgs]
  const command = `pnpm dev -- ${cliArgs.map((a) => `"${a}"`).join(' ')}`

  const proc = spawn(command, {
    cwd: ROOT,
    env: { ...process.env, LUMII_CLIENT_DATA_DIR: dataRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    windowsHide: true,
  })
  const collect = (chunk) => {
    const text = chunk.toString('utf-8')
    logs.push(text)
    if (logs.length > 400) logs.splice(0, logs.length - 400)
  }
  proc.stdout.on('data', collect)
  proc.stderr.on('data', collect)

  const stop = async () => {
    // Electron 是 detached 孙进程（pnpm → cmd → node → npx → electron），
    // 只 kill 包装层会留下一串孤儿并占住数据目录。
    //
    // 匹配用测试专属片段而非完整 userDataDir 路径：经 shell 转义后命令行里是
    // 双反斜杠，精确匹配会落空。用户自己的实例命令行不含该片段，不会误杀。
    try {
      proc.kill()
    } catch {
      /* 已退出 */
    }
    try {
      execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `${psMatchExpr()}Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$pat*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
        ],
        { stdio: 'ignore', timeout: 30_000 },
      )
    } catch {
      /* 清理尽力而为 */
    }
    // 等文件句柄释放，否则后续删目录会 EPERM
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500))
      if (!hasProcessWithMark()) break
    }
  }

  return { proc, dataRoot, workspaceDir: path.join(dataRoot, 'workspace'), userDataDir, logs, stop }
}

/**
 * 测试进程的识别标记。
 *
 * 注意 PowerShell 里必须用**字符串拼接**构造它（`'lumii-sync' + '-e2e'`）：
 * 若命令行里出现完整字面量，`CommandLine -like` 会匹配到查询进程自己，
 * 于是 Stop-Process 把正在执行清理的 PowerShell 一起杀掉 —— 表现为
 * 「清理命令无输出、退出码 255，进程没杀干净」。
 */
const PROC_MARK_PARTS = ['lumii-sync', '-e2e']

/** 生成能安全匹配测试进程的 PowerShell 过滤表达式（模式由拼接产生，不自匹配） */
function psMatchExpr() {
  const [a, b] = PROC_MARK_PARTS
  return `$pat = '${a}' + '${b}'; `
}

/** 是否还有测试进程在跑（同步查询，用于等待句柄释放） */
function hasProcessWithMark() {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `${psMatchExpr()}(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$pat*" } | Measure-Object).Count`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 },
    )
    return Number.parseInt(out.toString().trim(), 10) > 0
  } catch {
    return false
  }
}

/** 带重试地删目录（Electron 退出后句柄释放有延迟） */
export async function removeDirWithRetry(dir, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 800))
    }
  }
  return false
}

/** 等客户端控制口就绪并返回 {port, token} */
export async function waitForReady(dataRoot, timeoutMs = 120_000) {
  return waitFor(() => readRuntimeInfo(dataRoot), {
    timeoutMs,
    intervalMs: 1_500,
    label: '客户端控制口就绪',
  })
}
