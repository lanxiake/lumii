/**
 * 内置 Python 运行时 — 自动下载 Python Embeddable，用户无需自行安装
 *
 * 装到 ~/.lumii/runtimes/python-embed，带 pip 与 Lib/site-packages。
 * 原先这段流程内联在 MemPalace 插件安装里，现抽出为公共能力：
 * 技能 python-runner、bash 工具里的 python 命令、MemPalace 三方共用同一个运行时。
 *
 * 探测顺序始终「系统优先」：用户机器上已有 Python 3 就用它，
 * 只有确实没有时才落到内置运行时，避免抢用户环境。
 */

import { execFile, execSync } from 'node:child_process'
import { existsSync, promises as fs, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { downloadFile } from './download-file'
import { resolvePluginRuntimeDir } from './paths'

const execFileAsync = promisify(execFile)

const log = {
  info: (...a: unknown[]) => console.log('[PythonEnv]', ...a),
  warn: (...a: unknown[]) => console.warn('[PythonEnv]', ...a),
  error: (...a: unknown[]) => console.error('[PythonEnv]', ...a),
}

/** 运行时目录名 — 与 MemPalace 原有目录保持一致，已装用户不必重下 */
const RUNTIME_NAME = 'python-embed'

export const PYPI_MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple'

/**
 * 内置运行时钉死的 onnxruntime。
 *
 * chromadb 会拉最新版；1.21+ 的 Windows wheel 在 Win10 19045 上
 * LoadLibrary 返回 1114（DLL 初始化失败），chroma 误报成「未安装」。
 * 1.20.1 是本机验证过能 import 的最后一版。
 */
export const BUNDLED_ONNXRUNTIME_SPEC = 'onnxruntime==1.20.1'

const PYTHON_EMBED_URLS = [
  'https://npmmirror.com/mirrors/python/3.11.9/python-3.11.9-embed-amd64.zip',
  'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip',
]

/** 内置 Python 运行时目录 */
function getPythonRuntimeDir(): string {
  return resolvePluginRuntimeDir(RUNTIME_NAME)
}

/** 内置 python.exe 路径（不保证存在） */
export function getBundledPythonExe(): string {
  return join(getPythonRuntimeDir(), 'python.exe')
}

/** 内置运行时的 site-packages 目录 */
export function getBundledSitePackages(): string {
  return join(getPythonRuntimeDir(), 'Lib', 'site-packages')
}

/** 内置运行时是否已就绪（python.exe + pip 均在位） */
function isBundledPythonReady(): boolean {
  return existsSync(getBundledPythonExe()) && hasPackage('pip')
}

/**
 * 检测 site-packages 里是否已有某个包（快速路径，不起进程）。
 *
 * 只看目录名前缀，够用且比 `pip show` 快两个数量级。
 */
export function hasPackage(name: string): boolean {
  const sitePackages = getBundledSitePackages()
  if (!existsSync(sitePackages)) return false
  try {
    return readdirSync(sitePackages).some((n) => n === name || n.startsWith(`${name}-`))
  } catch {
    return false
  }
}

/**
 * 构造内置 Python 的 pip install 参数。
 *
 * 禁止 `--target`：embed 的 site-packages 里 protobuf 与 googleapis-common-protos
 * 共用 `google/` 命名空间，`--target` 会整目录覆盖，留下 dist-info 但删掉 `google.rpc`。
 */
export function buildBundledPipInstallArgs(
  packages: string[],
  extra: string[] = [],
): string[] {
  return [
    '-m', 'pip', 'install',
    ...packages,
    ...extra,
    '--no-warn-script-location',
    '-i', PYPI_MIRROR,
  ]
}

/** 系统 Python 的探测结果 */
export interface SystemPythonInfo {
  /** 可用命令名（python3 / python / py） */
  readonly command: string
  /** `Python 3.12.3` → [3, 12, 3] */
  readonly version: readonly [number, number, number]
}

/** 系统 Python 探测结果缓存（undefined = 未探测；正结果常驻） */
let cachedSystemPython: SystemPythonInfo | null | undefined
/** 负结果的写入时间（TTL 用） */
let cachedSystemPythonAt = 0

/**
 * 负结果缓存时长。
 *
 * 用户可能在我们探测失败**之后**才装上 python3（apt / 官方安装包），
 * 永久缓存会让「装了也要重启应用才生效」（与 feature-probe 的
 * 「用户装完不该要求重启」承诺矛盾）。30s 是「不重启能自愈」与
 * 「不每次探测都起进程」之间的折中。
 */
const SYSTEM_PYTHON_NEGATIVE_TTL_MS = 30_000

/**
 * 测试用：重置或预置系统 Python 探测结果。
 *
 * @param primed 传 null 表示"已探测且系统无 Python"，不传表示回到未探测状态
 * @param version 预置命令的版本号（默认 3.12.0；venv 路径要求 ≥3.10 时用得上）
 */
export function _resetSystemPythonCache(
  primed?: string | null,
  version: readonly [number, number, number] = [3, 12, 0],
): void {
  if (primed === undefined) {
    cachedSystemPython = undefined
    cachedSystemPythonAt = 0
    return
  }
  cachedSystemPython = primed === null ? null : { command: primed, version }
  cachedSystemPythonAt = primed === null ? Date.now() : 0
}

/** 解析 `--version` 输出；非 Python 3 返回 null */
function parsePythonVersion(out: string): readonly [number, number, number] | null {
  const m = out.match(/Python\s+(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  if (m[1] !== '3') return null
  return [3, Number(m[2]), Number(m[3])]
}

/** 跑 `<cmd> --version`；返回 Python 3 版本号，命令不存在或非 Python 3 返回 null */
function queryPython3(
  command: string,
  args: readonly string[] = [],
): readonly [number, number, number] | null {
  try {
    const out = execSync([command, ...args, '--version', '2>&1'].join(' '), {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    }).trim()
    return parsePythonVersion(out)
  } catch {
    return null
  }
}

/**
 * 探测系统 Python 3：python3 → python → py -3。
 *
 * @returns 命令名与版本；未找到返回 null（负结果带 30s TTL）
 */
export function detectSystemPythonInfo(): SystemPythonInfo | null {
  if (cachedSystemPython !== undefined) {
    const expiredNegative =
      cachedSystemPython === null &&
      Date.now() - cachedSystemPythonAt >= SYSTEM_PYTHON_NEGATIVE_TTL_MS
    if (!expiredNegative) return cachedSystemPython
  }

  for (const cmd of ['python3', 'python']) {
    const version = queryPython3(cmd)
    if (version) {
      cachedSystemPython = { command: cmd, version }
      return cachedSystemPython
    }
  }
  if (process.platform === 'win32') {
    const version = queryPython3('py', ['-3'])
    if (version) {
      cachedSystemPython = { command: 'py', version }
      return cachedSystemPython
    }
  }

  cachedSystemPython = null
  cachedSystemPythonAt = Date.now()
  return null
}

/**
 * 探测系统 Python 3（只要命令名）。
 *
 * @returns 可用命令名，未找到返回 null
 */
export function detectSystemPython(): string | null {
  return detectSystemPythonInfo()?.command ?? null
}

/** 单飞 promise：并发调用共用同一次安装，避免重复下载 */
let inflightInstall: Promise<string> | null = null

/**
 * 确保内置 Python 运行时可用，返回 python.exe 路径。
 *
 * 已就绪则直接返回（不联网）。未就绪则下载 embeddable 包（约 11MB）、
 * 打开 site 机制、装 pip，全程约 15-40s。并发调用共用同一次安装。
 *
 * 装到 `<dir>.tmp` 再整体 rename，中途失败不会留下半装状态。
 */
export function ensureBundledPython(onProgress?: (msg: string) => void): Promise<string> {
  if (isBundledPythonReady()) return Promise.resolve(getBundledPythonExe())
  if (inflightInstall) return inflightInstall

  inflightInstall = installBundledPython(onProgress).finally(() => {
    inflightInstall = null
  })
  return inflightInstall
}

async function installBundledPython(onProgress?: (msg: string) => void): Promise<string> {
  const runtimeDir = getPythonRuntimeDir()
  const tmpDir = `${runtimeDir}.tmp`
  const report = (msg: string) => {
    log.info(msg)
    onProgress?.(msg)
  }

  try {
    if (existsSync(tmpDir)) {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
    await fs.mkdir(tmpDir, { recursive: true })

    const zipPath = join(tmpDir, 'python-embed.zip')
    let downloaded = false
    for (const url of PYTHON_EMBED_URLS) {
      try {
        report(`正在下载 Python 运行时 (${new URL(url).hostname})...`)
        await downloadFile(url, zipPath, (pct) => report(`正在下载 Python 运行时... ${pct}%`))
        downloaded = true
        break
      } catch (err) {
        log.warn(`下载失败 ${url}:`, err instanceof Error ? err.message : err)
        await fs.unlink(zipPath).catch(() => {})
      }
    }
    if (!downloaded) throw new Error('Python 运行时下载失败，请检查网络后重试')

    report('正在解压...')
    await execFileAsync('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force`,
    ], { timeout: 60000, windowsHide: true })
    await fs.unlink(zipPath)

    await enableSiteInPth(tmpDir)

    report('正在安装 pip...')
    const getPipPath = join(tmpDir, 'get-pip.py')
    await downloadFile('https://bootstrap.pypa.io/get-pip.py', getPipPath)
    await execFileAsync(join(tmpDir, 'python.exe'), [
      getPipPath, '--no-warn-script-location',
      '--target', join(tmpDir, 'Lib', 'site-packages'),
    ], { timeout: 180000, windowsHide: true })
    await fs.unlink(getPipPath)

    report('正在完成安装...')
    if (existsSync(runtimeDir)) {
      await fs.rm(runtimeDir, { recursive: true, force: true })
    }
    await fs.rename(tmpDir, runtimeDir)

    log.info('内置 Python 运行时安装完成:', runtimeDir)
    return getBundledPythonExe()
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    log.error('内置 Python 安装失败:', err instanceof Error ? err.message : err)
    throw err
  }
}

/**
 * embeddable 包默认禁用 site 机制，需取消注释 `import site`
 * 并把 Lib/site-packages 加进 ._pth，否则 pip 装的包 import 不到。
 */
async function enableSiteInPth(dir: string): Promise<void> {
  const pthFiles = (await fs.readdir(dir)).filter((f) => f.endsWith('._pth'))
  if (pthFiles.length === 0) throw new Error('未找到 ._pth 文件')

  const pthPath = join(dir, pthFiles[0])
  await fs.mkdir(join(dir, 'Lib', 'site-packages'), { recursive: true })

  let content = await fs.readFile(pthPath, 'utf-8')
  content = content.replace(/^#import site/m, 'import site')
  if (!content.includes('import site')) content += '\nimport site\n'
  if (!content.includes('Lib/site-packages')) content += './Lib/site-packages\n'
  await fs.writeFile(pthPath, content, 'utf-8')
}
