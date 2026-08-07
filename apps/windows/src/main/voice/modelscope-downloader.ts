/**
 * 通过本机 Python + ModelScope 官方 SDK 下载语音模型
 * 文档: https://www.modelscope.cn/docs/models/download
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  PYPI_MIRROR,
  detectSystemPython,
  ensureBundledPython,
  getBundledPythonExe,
  hasPackage,
} from '../python-env.js'

const log = {
  info: (...a: unknown[]) => console.log('[ModelScopeDownload]', ...a),
  warn: (...a: unknown[]) => console.warn('[ModelScopeDownload]', ...a),
  error: (...a: unknown[]) => console.error('[ModelScopeDownload]', ...a),
}

export interface ModelScopeFileMapping {
  /** 魔搭仓库内路径 */
  remote: string
  /** 落到本地模型目录的文件名 */
  local: string
}

export interface ModelScopeDownloadSpec {
  modelId: string
  outDir: string
  /** 单文件映射；snapshot 模式下可为空 */
  files: ModelScopeFileMapping[]
  /**
   * files = 按映射拉单文件；snapshot = 整库下载到 outDir（Qwen3 等大模型）
   */
  mode?: 'files' | 'snapshot'
  /** 从 config.yaml 的 token_list 生成 tokens.txt（FunASR → sherpa） */
  extractTokensFromConfig?: boolean
}

export interface ModelScopeProgress {
  percent: number
  message?: string
  file?: string
}

/**
 * 解析用于跑 SDK 的 python 可执行文件
 */
async function resolvePythonExe(): Promise<string> {
  const sys = detectSystemPython()
  if (sys === 'py') return 'py'
  if (sys) return sys
  return ensureBundledPython((msg) => log.info(msg))
}

/**
 * 确保 modelscope（及 pyyaml）已安装到当前 Python
 */
async function ensureModelScopePackage(pythonExe: string): Promise<void> {
  // 内置运行时可用 hasPackage 快路径；系统 Python 仍尝试 import
  if (pythonExe === getBundledPythonExe() && hasPackage('modelscope')) {
    return
  }

  const checkArgs =
    pythonExe === 'py'
      ? ['-3', '-c', 'import modelscope, yaml']
      : ['-c', 'import modelscope, yaml']

  const ok = await new Promise<boolean>((resolve) => {
    const p = spawn(pythonExe, checkArgs, { windowsHide: true, stdio: 'ignore' })
    p.on('error', () => resolve(false))
    p.on('exit', (code) => resolve(code === 0))
  })
  if (ok) return

  log.info('正在安装 modelscope SDK（清华 PyPI 镜像）...')
  const installArgs =
    pythonExe === 'py'
      ? ['-3', '-m', 'pip', 'install', '-q', 'modelscope', 'pyyaml', '-i', PYPI_MIRROR]
      : ['-m', 'pip', 'install', '-q', 'modelscope', 'pyyaml', '-i', PYPI_MIRROR]

  await new Promise<void>((resolve, reject) => {
    const p = spawn(pythonExe, installArgs, {
      windowsHide: true,
      env: { ...process.env, PIP_INDEX_URL: PYPI_MIRROR },
    })
    let err = ''
    p.stderr?.on('data', (b: Buffer) => {
      err += b.toString()
    })
    p.on('error', reject)
    p.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`pip install modelscope 失败 (code=${code}): ${err.slice(-500)}`))
    })
  })
  log.info('modelscope SDK 安装完成')
}

/**
 * 定位打包/源码中的 modelscope_voice_download.py
 * 优先 assets（随 extraResources 打入安装包）
 */
function resolveHelperScript(): string {
  const packagedAssets = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'scripts', 'modelscope_voice_download.py')
    : path.join(__dirname, '../../assets/scripts/modelscope_voice_download.py')
  const candidates = [
    packagedAssets,
    path.join(__dirname, 'modelscope_voice_download.py'),
    path.join(app.getAppPath(), 'src/main/voice/modelscope_voice_download.py'),
    path.join(process.cwd(), 'apps/windows/src/main/voice/modelscope_voice_download.py'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  throw new Error('找不到 modelscope_voice_download.py')
}

/**
 * 使用 ModelScope SDK 下载并拷贝到 outDir
 */
export async function downloadViaModelScopeSdk(
  spec: ModelScopeDownloadSpec,
  onProgress: (p: ModelScopeProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  const pythonExe = await resolvePythonExe()
  await ensureModelScopePackage(pythonExe)

  const cacheDir = path.join(app.getPath('temp'), 'lumii-modelscope-cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.mkdirSync(spec.outDir, { recursive: true })

  const helper = resolveHelperScript()
  const payload = JSON.stringify({
    modelId: spec.modelId,
    cacheDir,
    outDir: spec.outDir,
    files: spec.files,
    mode: spec.mode ?? (spec.files.length === 0 ? 'snapshot' : 'files'),
    extractTokensFromConfig: spec.extractTokensFromConfig === true,
  })

  const args =
    pythonExe === 'py'
      ? ['-3', helper, '--spec', payload]
      : [helper, '--spec', payload]

  onProgress({ percent: 0.02, message: `魔搭 SDK 下载 ${spec.modelId}` })

  await new Promise<void>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(pythonExe, args, {
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          MODELSCOPE_CACHE: cacheDir,
        },
      }) as ChildProcessWithoutNullStreams
    } catch (e) {
      reject(e)
      return
    }

    const killOnAbort = () => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
    if (signal.aborted) {
      killOnAbort()
      reject(new Error('已取消'))
      return
    }
    signal.addEventListener('abort', killOnAbort, { once: true })

    let stdoutBuf = ''
    let stderrBuf = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk
      const lines = stdoutBuf.split('\n')
      stdoutBuf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const ev = JSON.parse(trimmed) as {
            event?: string
            percent?: number
            message?: string
            file?: string
          }
          if (ev.event === 'error') {
            reject(new Error(ev.message || '魔搭下载失败'))
            killOnAbort()
            return
          }
          if (typeof ev.percent === 'number') {
            onProgress({
              percent: Math.min(0.99, Math.max(0, ev.percent)),
              message: ev.message,
              file: ev.file,
            })
          } else if (ev.message) {
            onProgress({ percent: 0.1, message: ev.message, file: ev.file })
          }
        } catch {
          log.info('[sdk]', trimmed)
        }
      }
    })

    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk
      // tqdm 进度条刷屏，只留尾部
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-2000)
    })

    child.on('error', (err) => {
      signal.removeEventListener('abort', killOnAbort)
      reject(err)
    })

    child.on('exit', (code) => {
      signal.removeEventListener('abort', killOnAbort)
      if (signal.aborted) {
        reject(new Error('已取消'))
        return
      }
      if (code === 0) {
        onProgress({ percent: 1, message: '魔搭下载完成' })
        resolve()
        return
      }
      reject(
        new Error(
          `魔搭 SDK 退出码 ${code}${stderrBuf ? `: ${stderrBuf.trim().slice(-400)}` : ''}`,
        ),
      )
    })
  })
}
