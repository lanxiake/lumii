/**
 * MCP Server 的 Python 解释器解析
 *
 * 背景（2026-10-08）：内置 wechat-local 写的是裸 `python`。MCP 客户端不走 shell 直接 spawn，
 * Windows 上 PATH 里的 `WindowsApps\python.exe`（Microsoft Store 应用执行别名占位程序）
 * 往往排在真实解释器前面，一启动就以 9009 退出；Linux 发行版则常常只有 `python3`。
 *
 * 两类命令分别处理：
 * - `{{LUMII_PYTHON}}`：由灵栖托管的解释器（Windows 内置 embeddable、Linux 应用 venv），
 *   缺失时自动安装，并按预置项声明补齐依赖——内置 Python MCP 一律用它；
 * - 裸 `python` / `python3`（用户导入的第三方配置）：解析为**真正可用**的系统解释器绝对路径
 *   （`--version` 探测会自然排除 Store 占位程序），没有系统 Python 时退回托管解释器。
 */

import { execFile, execSync } from 'node:child_process'
import { promisify } from 'node:util'
import {
  buildBundledPipInstallArgs,
  detectSystemPythonInfo,
  ensureBundledPython,
  getBundledPythonExe,
} from './python-env'
import { ensurePythonVenv, getPythonVenvExe } from './python-venv'

const execFileAsync = promisify(execFile)

const log = {
  info: (...a: unknown[]) => console.log('[McpPython]', ...a),
  warn: (...a: unknown[]) => console.warn('[McpPython]', ...a),
}

/** MCP 配置中代表「灵栖托管 Python 解释器」的占位符（明文存盘，连接前解析） */
export const LUMII_PYTHON_TOKEN = '{{LUMII_PYTHON}}'

/** 视为「裸 Python 命令」的写法（大小写不敏感） */
const BARE_PYTHON_COMMANDS = new Set(['python', 'python3', 'python.exe', 'python3.exe'])

/** Python 依赖声明：pip 安装规格 + 用于探测是否已装的导入名 */
export interface PythonPackageRequirement {
  /** pip 规格，如 `pycryptodome>=3.20` */
  readonly spec: string
  /** 导入名，如 `Crypto`（与发行包名不同时必须写对） */
  readonly module: string
}

/** Python 命令类型：托管占位符 / 裸命令 / 非 Python 命令 */
export type McpPythonCommandKind = 'managed' | 'bare' | null

/** 解析结果：成功给出可直接 spawn 的绝对路径，失败给出可展示给用户的原因 */
export type McpPythonResolution =
  | { readonly ok: true; readonly command: string; readonly warning?: string }
  | { readonly ok: false; readonly message: string }

/**
 * 判断 MCP 启动命令是否需要走 Python 解析
 *
 * @param command 配置里的原始 command
 * @returns managed（占位符）、bare（裸 python/python3）或 null（与 Python 无关）
 */
export function classifyPythonCommand(command: string): McpPythonCommandKind {
  const trimmed = command.trim()
  if (trimmed === LUMII_PYTHON_TOKEN) return 'managed'
  if (BARE_PYTHON_COMMANDS.has(trimmed.toLowerCase())) return 'bare'
  return null
}

/** 托管解释器的可执行文件路径（不保证存在），用于识别旧配置里写死的绝对路径 */
export function getManagedPythonExePaths(): string[] {
  return [getBundledPythonExe(), getPythonVenvExe()]
}

/**
 * 确保托管解释器可用并返回其绝对路径
 *
 * Windows 用内置 embeddable（首装约 15-40s），其他平台用应用 venv（依赖系统 python3）。
 */
async function ensureManagedPython(): Promise<string> {
  return process.platform === 'win32' ? ensureBundledPython() : ensurePythonVenv()
}

/** 系统解释器绝对路径缓存（正结果常驻；负结果交给 detectSystemPythonInfo 的 TTL） */
let cachedSystemPythonExe: string | null = null

/** 测试用：清空系统解释器路径缓存 */
export function _resetMcpPythonCache(): void {
  cachedSystemPythonExe = null
}

/**
 * 定位真实可用的系统 Python 3 绝对路径
 *
 * 先用 detectSystemPythonInfo 做 `--version` 探测（Store 占位程序会失败而被排除），
 * 再取 `sys.executable` 得到绝对路径——直接 spawn 绝对路径就不会再被 PATH 顺序误导。
 *
 * @returns 绝对路径；系统没有可用 Python 3 时返回 null
 */
export function locateSystemPythonExe(): string | null {
  if (cachedSystemPythonExe) return cachedSystemPythonExe
  const info = detectSystemPythonInfo()
  if (!info) return null
  const launcher = info.command === 'py' ? 'py -3' : info.command
  try {
    const exe = execSync(`${launcher} -c "import sys;print(sys.executable)"`, {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    }).trim()
    if (!exe) return null
    cachedSystemPythonExe = exe
    return exe
  } catch (err) {
    log.warn(`读取系统 Python 路径失败（${launcher}）:`, err instanceof Error ? err.message : err)
    return null
  }
}

/** 同一解释器的依赖安装单飞：并发连接共用一次 pip */
const inflightInstalls = new Map<string, Promise<string | undefined>>()

/**
 * 找出解释器里还没装的依赖（按导入名探测，起一个进程，约 100ms）
 *
 * @param pythonExe 解释器绝对路径
 * @param packages 依赖声明
 * @returns 缺失的依赖声明
 */
export async function findMissingPythonPackages(
  pythonExe: string,
  packages: readonly PythonPackageRequirement[],
): Promise<PythonPackageRequirement[]> {
  if (packages.length === 0) return []
  const probe =
    'import importlib.util,sys;' +
    'print(",".join(m for m in sys.argv[1:] if importlib.util.find_spec(m) is None))'
  const { stdout } = await execFileAsync(
    pythonExe,
    ['-c', probe, ...packages.map((p) => p.module)],
    { timeout: 15_000, windowsHide: true },
  )
  const missing = new Set(stdout.trim().split(',').filter(Boolean))
  return packages.filter((p) => missing.has(p.module))
}

/**
 * 确保托管解释器里装齐依赖
 *
 * 失败不抛错：依赖缺失时 Server 仍可启动并通过自检工具报告，
 * 这里只返回一条告警供日志与界面展示，不阻断连接。
 *
 * @returns 告警文案；全部就绪返回 undefined
 */
async function ensurePythonPackages(
  pythonExe: string,
  packages: readonly PythonPackageRequirement[],
): Promise<string | undefined> {
  if (packages.length === 0) return undefined
  const running = inflightInstalls.get(pythonExe)
  if (running) return running

  const task = (async (): Promise<string | undefined> => {
    try {
      const missing = await findMissingPythonPackages(pythonExe, packages)
      if (missing.length === 0) return undefined
      const specs = missing.map((p) => p.spec)
      log.info(`安装 MCP 依赖: ${specs.join(' ')}`)
      await execFileAsync(pythonExe, buildBundledPipInstallArgs(specs), {
        timeout: 300_000,
        windowsHide: true,
      })
      return undefined
    } catch (err) {
      const message = `Python 依赖安装失败：${err instanceof Error ? err.message : String(err)}`
      log.warn(message)
      return message
    }
  })().finally(() => inflightInstalls.delete(pythonExe))

  inflightInstalls.set(pythonExe, task)
  return task
}

/**
 * 把 MCP 配置里的 Python 命令解析为可直接 spawn 的解释器绝对路径
 *
 * @param command 原始 command（`{{LUMII_PYTHON}}` 或裸 python/python3）
 * @param packages 托管解释器需要补齐的依赖（仅 managed 生效，不往用户的系统 Python 里装包）
 */
export async function resolveMcpPython(
  command: string,
  packages: readonly PythonPackageRequirement[] = [],
): Promise<McpPythonResolution> {
  const kind = classifyPythonCommand(command)
  if (!kind) return { ok: true, command }

  if (kind === 'bare') {
    const system = locateSystemPythonExe()
    if (system) return { ok: true, command: system }
    log.info(`系统未找到可用的 ${command}，改用灵栖托管的 Python 运行时`)
  }

  let exe: string
  try {
    exe = await ensureManagedPython()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      message: `未找到可用的 Python 3，且自动准备 Python 运行时失败：${reason}`,
    }
  }
  const warning = kind === 'managed' ? await ensurePythonPackages(exe, packages) : undefined
  return warning ? { ok: true, command: exe, warning } : { ok: true, command: exe }
}
