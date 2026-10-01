/**
 * 应用 Python venv —— Linux 运行时对等的核心件（设计 D21）
 *
 * 与 Windows 的内置 embeddable 运行时对位：**宿主级** Python 包（模型下载器
 * modelscope、Qwen3 TTS 链路、Torch）安装到这里。无 root、不污染系统环境
 * （Ubuntu 的 PEP 668 externally-managed 会让「往系统 python3 里 pip install」直接报错）。
 *
 * 创建引导：
 * 1. `python3 -m venv <dir>` —— 系统装了 python3-venv 时一步到位；
 * 2. 失败（Ubuntu 常见：缺 python3-venv，ensurepip 不可用）则
 *    `--without-pip` + get-pip.py 补 pip —— 与 Windows 内嵌流程同一手法，
 *    **不需要 sudo，也不要求用户装 python3-venv**。
 *
 * 装到 `<dir>.tmp` 再整体 rename，中途失败不留半装状态（同 installBundledPython）。
 */

import { execFile, execSync } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { downloadFile } from './download-file'
import { createLogger } from './logger'
import { resolvePluginRuntimeDir } from './paths'
import { detectSystemPythonInfo } from './python-env'

const execFileAsync = promisify(execFile)
const log = createLogger('PythonVenv')

const RUNTIME_NAME = 'python-venv'

/** venv 要求的最低 Python 版本（Torch 2.5.1 / modelscope 实际支持范围之上取整） */
export const PYTHON_VENV_MIN_VERSION: readonly [number, number] = [3, 10]

const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py'

/** venv 目录（不保证存在） */
export function getPythonVenvDir(): string {
  return resolvePluginRuntimeDir(RUNTIME_NAME)
}

/** venv 内可执行文件路径（平台布局：POSIX bin/，Windows Scripts/） */
function venvExecutable(dir: string, name: string): string {
  return process.platform === 'win32'
    ? join(dir, 'Scripts', `${name}.exe`)
    : join(dir, 'bin', name)
}

/** venv 的 python 可执行文件路径（不保证存在） */
export function getPythonVenvExe(): string {
  return venvExecutable(getPythonVenvDir(), 'python')
}

/** venv 的 bin 目录（并入 CLI 检索路径用，见 cli-user-path） */
export function getPythonVenvBinDir(): string {
  return process.platform === 'win32'
    ? join(getPythonVenvDir(), 'Scripts')
    : join(getPythonVenvDir(), 'bin')
}

/** 系统 Python 版本是否满足 venv 下限 */
export function meetsVenvRequirement(version: readonly [number, number, number]): boolean {
  if (version[0] !== 3) return version[0] > 3
  return version[1] >= PYTHON_VENV_MIN_VERSION[1]
}

/** venv 就绪探测缓存（负结果带 TTL，理由同 python-env.detectSystemPythonInfo） */
let cachedVenvReady: boolean | undefined
let cachedVenvReadyAt = 0

const VENV_READY_NEGATIVE_TTL_MS = 30_000

/**
 * 测试用：重置或预置 venv 就绪状态。
 *
 * @param ready 传 true/false 预置结果，不传表示回到未探测状态
 */
export function _resetPythonVenvCache(ready?: boolean): void {
  cachedVenvReady = ready
  cachedVenvReadyAt = ready === false ? Date.now() : 0
}

/** venv 是否可用（python 在 + pip 能跑） */
export function isPythonVenvReady(): boolean {
  if (cachedVenvReady !== undefined) {
    const expired =
      cachedVenvReady === false && Date.now() - cachedVenvReadyAt >= VENV_READY_NEGATIVE_TTL_MS
    if (!expired) return cachedVenvReady
  }

  let ready = false
  const exe = getPythonVenvExe()
  if (existsSync(exe)) {
    try {
      execSync(`"${exe}" -m pip --version`, { encoding: 'utf-8', timeout: 10_000, windowsHide: true })
      ready = true
    } catch {
      ready = false
    }
  }
  cachedVenvReady = ready
  cachedVenvReadyAt = ready ? 0 : Date.now()
  return ready
}

/** 单飞 promise：并发调用共用同一次创建 */
let inflight: Promise<string> | null = null

/**
 * 确保应用 venv 可用，返回 venv 的 python 路径。
 *
 * 已就绪直接返回（不起进程之外的开销）；未就绪则创建（含失败回退链）。
 */
export function ensurePythonVenv(onProgress?: (msg: string) => void): Promise<string> {
  if (isPythonVenvReady()) return Promise.resolve(getPythonVenvExe())
  if (inflight) return inflight

  inflight = createPythonVenv(onProgress).finally(() => {
    inflight = null
  })
  return inflight
}

async function createPythonVenv(onProgress?: (msg: string) => void): Promise<string> {
  const info = detectSystemPythonInfo()
  if (!info) {
    throw new Error('未找到系统 Python 3。请先安装：sudo apt install python3')
  }
  if (!meetsVenvRequirement(info.version)) {
    throw new Error(
      `系统 Python ${info.version.join('.')} 版本过低，创建运行环境需要 ${PYTHON_VENV_MIN_VERSION.join('.')} 及以上`,
    )
  }

  const dir = getPythonVenvDir()
  const tmpDir = `${dir}.tmp`
  const report = (msg: string) => {
    log.info(msg)
    onProgress?.(msg)
  }
  const cmdArgs = info.command === 'py' ? ['-3'] : []

  try {
    if (existsSync(tmpDir)) {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
    await fs.mkdir(tmpDir, { recursive: true })

    report('正在创建 Python 虚拟环境...')
    let created = false
    try {
      await execFileAsync(info.command, [...cmdArgs, '-m', 'venv', tmpDir], {
        timeout: 120_000,
        windowsHide: true,
      })
      created = true
    } catch (err) {
      // Ubuntu 常见：缺 python3-venv，ensurepip 不可用。退到 --without-pip + get-pip.py
      log.warn(
        'python3 -m venv 失败，改用 --without-pip + get-pip.py：',
        err instanceof Error ? err.message : err,
      )
    }

    if (!created) {
      await execFileAsync(info.command, [...cmdArgs, '-m', 'venv', '--without-pip', tmpDir], {
        timeout: 120_000,
        windowsHide: true,
      })

      report('正在安装 pip（get-pip.py）...')
      const getPipPath = join(tmpDir, 'get-pip.py')
      await downloadFile(GET_PIP_URL, getPipPath)
      await execFileAsync(venvExecutable(tmpDir, 'python'), [getPipPath, '--no-warn-script-location'], {
        timeout: 300_000,
        windowsHide: true,
      })
      await fs.unlink(getPipPath)
    }

    report('正在校验运行环境...')
    await execFileAsync(venvExecutable(tmpDir, 'python'), ['-m', 'pip', '--version'], {
      timeout: 60_000,
      windowsHide: true,
    })

    if (existsSync(dir)) {
      await fs.rm(dir, { recursive: true, force: true })
    }
    await fs.rename(tmpDir, dir)

    cachedVenvReady = true
    cachedVenvReadyAt = 0
    log.info('Python venv 创建完成:', dir)
    return getPythonVenvExe()
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    cachedVenvReady = false
    cachedVenvReadyAt = Date.now()
    log.error('Python venv 创建失败:', err instanceof Error ? err.message : err)
    throw err
  }
}
