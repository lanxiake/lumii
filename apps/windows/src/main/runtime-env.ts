/**
 * 脚本运行环境 — 让用户装完客户端就能跑 JS / Python，无需自行装环境
 *
 * 两条来源：
 * - Node：Electron 自带（process.execPath + ELECTRON_RUN_AS_NODE=1），零额外体积
 * - Python：内置 embeddable 运行时（见 python-env.ts），首次用到时自动下载
 *
 * 对 bash 工具里的裸命令（`node x.js` / `python3 x.py`），在 ~/.lumii/runtimes/bin
 * 生成 shim 并**追加**到 PATH 末尾 —— 追加而非前置，保证用户机器上真实的
 * node/python 始终优先，我们只填空缺。
 */

import { existsSync, promises as fs } from 'node:fs'
import { delimiter, join } from 'node:path'
import { execSync } from 'node:child_process'
import {
  PYPI_MIRROR,
  detectSystemPython,
  ensureBundledPython,
  getBundledPythonExe,
  getBundledSitePackages,
} from './python-env'
import { resolveLumiiUiScriptPath } from './app-ui-control/cli-paths'
import { resolvePluginRuntimeDir } from './paths'

const log = {
  info: (...a: unknown[]) => console.log('[RuntimeEnv]', ...a),
  warn: (...a: unknown[]) => console.warn('[RuntimeEnv]', ...a),
}

/** shim 存放目录 */
export function getShimDir(): string {
  return resolvePluginRuntimeDir('bin')
}

/** 系统 node 探测缓存 */
let cachedSystemNode: string | null | undefined

/**
 * 测试用：重置或预置系统 node 探测结果。
 *
 * @param primed 传 null 表示"已探测且系统无 node"，不传表示回到未探测状态
 */
export function _resetSystemNodeCache(primed?: string | null): void {
  cachedSystemNode = primed === undefined ? undefined : primed
}

/** 系统上是否有可用的 node */
export function detectSystemNode(): string | null {
  if (cachedSystemNode !== undefined) return cachedSystemNode
  try {
    execSync('node --version', { encoding: 'utf-8', timeout: 5000, windowsHide: true })
    cachedSystemNode = 'node'
  } catch {
    cachedSystemNode = null
  }
  return cachedSystemNode
}

/**
 * 解析用于跑 JS 的 node 可执行文件。
 *
 * 系统有 node 就用系统的；没有则用 Electron 自带的 —— Electron 的 execPath
 * 配 ELECTRON_RUN_AS_NODE=1 就是一个纯 Node，不会再起一个应用窗口。
 * 与 mcp-client.ts 的做法一致。
 *
 * @returns command 与需要附加的环境变量
 */
export function resolveNodeExec(): { command: string; env: Record<string, string> } {
  const system = detectSystemNode()
  if (system) return { command: system, env: {} }
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
}

/** Windows 路径转 Git Bash 可用的正斜杠形式 */
function toPosixish(p: string): string {
  return p.replace(/\\/g, '/')
}

/**
 * 生成一对 shim（无扩展名的 sh 脚本给 Git Bash，.cmd 给 cmd.exe）。
 *
 * sh 脚本里先判存在再 exec，运行时没装好时给出可读错误而不是 "command not found"。
 */
async function writeShimPair(
  dir: string,
  name: string,
  target: string,
  prefixArgs: readonly string[],
  extraEnv: Record<string, string>,
): Promise<void> {
  const quotedArgs = prefixArgs.map((a) => `"${a}"`).join(' ')
  const envLinesSh = Object.entries(extraEnv)
    .map(([k, v]) => `export ${k}="${v}"`)
    .join('\n')
  const envLinesCmd = Object.entries(extraEnv)
    .map(([k, v]) => `set "${k}=${v}"`)
    .join('\r\n')

  const sh = `#!/bin/sh
# 由灵栖 Lumii 自动生成，请勿手改
TARGET="${toPosixish(target)}"
if [ ! -f "$TARGET" ]; then
  echo "[lumii] ${name} 运行时尚未就绪（预期路径: $TARGET）。请在客户端内重试，或稍候等待自动安装完成。" >&2
  exit 127
fi
${envLinesSh}
exec "$TARGET" ${quotedArgs} "$@"
`

  const cmd = `@echo off\r
rem 由灵栖 Lumii 自动生成，请勿手改\r
${envLinesCmd}\r
"${target}" ${quotedArgs} %*\r
`

  await fs.writeFile(join(dir, name), sh, { encoding: 'utf-8', mode: 0o755 })
  await fs.writeFile(join(dir, `${name}.cmd`), cmd, 'utf-8')
}

/**
 * 按需写入 node / python shim。
 *
 * 只为系统缺失的命令写 shim；系统已有的不写，避免遮蔽用户环境。
 * 每次启动重写一遍（内容含绝对路径，客户端换安装位置后需刷新）。
 */
export async function writeShims(): Promise<void> {
  const dir = getShimDir()
  await fs.mkdir(dir, { recursive: true })

  if (!detectSystemNode()) {
    // Electron execPath 当纯 Node 用，需 ELECTRON_RUN_AS_NODE=1
    await writeShimPair(dir, 'node', process.execPath, [], { ELECTRON_RUN_AS_NODE: '1' })
    log.info('已写入 node shim（系统未装 Node，使用 Electron 内置）')
  }

  if (!detectSystemPython()) {
    const exe = getBundledPythonExe()
    for (const name of ['python', 'python3']) {
      await writeShimPair(dir, name, exe, [], {})
    }
    log.info('已写入 python/python3 shim（系统未装 Python，使用内置运行时）')
  }

  // lumii-ui CLI：始终写入 shim，target 用 resolveNodeExec()（系统 node 或 Electron 内置）
  const node = resolveNodeExec()
  const scriptPath = resolveLumiiUiScriptPath()
  await writeShimPair(dir, 'lumii-ui', node.command, [scriptPath], node.env)
  log.info('已写入 lumii-ui shim')
}

/**
 * 在 env 中把 shim 目录追加到 PATH 末尾。
 *
 * Windows 上 process.env 的键名大小写不定（通常是 Path），必须复用已有键名，
 * 否则子进程会拿到 PATH 与 Path 两个变量，行为取决于实现，容易出诡异 bug。
 */
export function buildScriptEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...process.env, ...(extra ?? {}) } as Record<string, string>

  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const current = env[pathKey] ?? ''
  const shimDir = getShimDir()
  if (!current.split(delimiter).includes(shimDir)) {
    env[pathKey] = current ? `${current}${delimiter}${shimDir}` : shimDir
  }

  // 内置 Python 走镜像装包，否则国内 pip install 基本等于卡死。
  // 仅在用户没有自己的 Python 时注入，不干扰用户既有 pip 配置。
  if (!detectSystemPython() && !env.PIP_INDEX_URL) {
    env.PIP_INDEX_URL = PYPI_MIRROR
  }

  return env
}

/**
 * 启动时初始化脚本运行环境。
 *
 * 写 shim 是同步小操作；Python 运行时下载放后台，不阻塞启动。
 * 设 LUMII_SKIP_PYTHON_BOOTSTRAP=1 可跳过自动下载（离线环境 / 不想占带宽）。
 */
export async function initScriptRuntimes(): Promise<void> {
  try {
    await writeShims()
  } catch (err) {
    log.warn('写入 shim 失败:', err instanceof Error ? err.message : err)
  }

  if (detectSystemPython() || process.env.LUMII_SKIP_PYTHON_BOOTSTRAP === '1') return
  if (existsSync(getBundledPythonExe())) return

  log.info('系统未检测到 Python，后台下载内置运行时...')
  void ensureBundledPython((msg) => log.info(msg)).catch((err) => {
    log.warn('内置 Python 后台安装失败，将在实际用到时重试:', err instanceof Error ? err.message : err)
  })
}

/** 供诊断用：当前脚本运行环境状态 */
export function getScriptRuntimeStatus(): {
  node: { source: 'system' | 'electron'; path: string }
  python: { source: 'system' | 'bundled' | 'missing'; path: string }
  sitePackages: string
} {
  const systemNode = detectSystemNode()
  const systemPython = detectSystemPython()
  return {
    node: systemNode
      ? { source: 'system', path: systemNode }
      : { source: 'electron', path: process.execPath },
    python: systemPython
      ? { source: 'system', path: systemPython }
      : existsSync(getBundledPythonExe())
        ? { source: 'bundled', path: getBundledPythonExe() }
        : { source: 'missing', path: getBundledPythonExe() },
    sitePackages: getBundledSitePackages(),
  }
}
