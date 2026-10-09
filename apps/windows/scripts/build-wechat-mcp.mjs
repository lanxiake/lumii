/**
 * 把 resources/wechat-mcp（Python 源码）打成独立的单文件 wechat-mcp.exe
 *
 * 产物不依赖任何 Python 环境与灵栖占位符，任意 MCP 客户端写 exe 绝对路径即可用。
 * 构建用 uv 准备隔离的 Python 3.11 + PyInstaller，不污染本机/托管解释器。
 *
 * 用法：node scripts/build-wechat-mcp.mjs [--if-stale]
 *   --if-stale  exe 已存在且比所有源码都新时跳过（开发期反复执行不浪费 1 分钟）
 *
 * 产物：resources/wechat-mcp/dist/wechat-mcp.exe（electron-builder 由此拷进安装包）
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WINDOWS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = path.join(WINDOWS_ROOT, 'resources', 'wechat-mcp')
const DIST_DIR = path.join(SRC_DIR, 'dist')
const EXE_PATH = path.join(DIST_DIR, 'wechat-mcp.exe')
/** exe 里需要的随包数据（运行时由 sys._MEIPASS 定位） */
const DATA_FILES = ['ocr4.ps1', 'uia_read.ps1']
/** 与 requirements.txt 保持一致 */
const RUNTIME_DEPS = ['pycryptodome>=3.20', 'zstandard>=0.22']
const PYINSTALLER_SPEC = 'pyinstaller>=6.10'
const DEFAULT_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple'

/**
 * 打印带前缀的日志
 * @param {string} msg 日志内容
 */
function log(msg) {
  console.log(`[build-wechat-mcp] ${msg}`)
}

/**
 * 列出参与打包的源文件（.py 与随包数据），用于判断 exe 是否过期
 * @returns {string[]} 绝对路径列表
 */
function listSources() {
  return fs
    .readdirSync(SRC_DIR)
    .filter((f) => (f.endsWith('.py') && !f.startsWith('test_')) || DATA_FILES.includes(f))
    .map((f) => path.join(SRC_DIR, f))
}

/**
 * exe 是否已比全部源码新
 * @returns {boolean}
 */
function isUpToDate() {
  if (!fs.existsSync(EXE_PATH)) return false
  const exeTime = fs.statSync(EXE_PATH).mtimeMs
  return listSources().every((f) => fs.statSync(f).mtimeMs <= exeTime)
}

/**
 * 定位 uv：PATH 优先，再试官方安装脚本的默认落点
 * @returns {string | null}
 */
function locateUv() {
  const probe = spawnSync('uv', ['--version'], { encoding: 'utf-8', windowsHide: true })
  if (probe.status === 0) return 'uv'
  const fallback = path.join(os.homedir(), '.local', 'bin', 'uv.exe')
  return fs.existsSync(fallback) ? fallback : null
}

/**
 * 用 initialize 请求冒烟：exe 必须能完成 MCP 握手并报出版本
 */
function smokeTest() {
  const request = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'build-smoke', version: '0' } },
  })
  const result = spawnSync(EXE_PATH, [], {
    input: `${request}\n`,
    encoding: 'utf-8',
    timeout: 60_000,
    windowsHide: true,
  })
  const line = (result.stdout ?? '').split('\n').find((l) => l.trim())
  const reply = line ? JSON.parse(line) : null
  if (reply?.result?.serverInfo?.name !== 'wechat-local') {
    throw new Error(`exe 握手冒烟失败：stdout=${result.stdout} stderr=${result.stderr}`)
  }
  log(`冒烟通过：${reply.result.serverInfo.name} v${reply.result.serverInfo.version}`)
}

/** 构建主流程 */
function main() {
  if (process.platform !== 'win32') {
    log('wechat-mcp 仅支持 Windows，跳过构建')
    return
  }
  if (process.argv.includes('--if-stale') && isUpToDate()) {
    log(`已是最新，跳过：${path.relative(WINDOWS_ROOT, EXE_PATH)}`)
    return
  }
  const uv = locateUv()
  if (!uv) {
    throw new Error('未找到 uv（https://docs.astral.sh/uv/），无法构建 wechat-mcp.exe')
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-mcp-build-'))
  const env = { ...process.env }
  if (!env.UV_DEFAULT_INDEX && !env.UV_INDEX_URL && !env.CI) env.UV_DEFAULT_INDEX = DEFAULT_INDEX

  const args = [
    'run', '--no-project', '--python', '3.11',
    '--with', PYINSTALLER_SPEC,
    ...RUNTIME_DEPS.flatMap((dep) => ['--with', dep]),
    '--', 'pyinstaller',
    '--noconfirm', '--clean', '--onefile', '--console',
    '--name', 'wechat-mcp',
    '--distpath', DIST_DIR,
    '--workpath', path.join(workDir, 'build'),
    '--specpath', workDir,
    '--paths', SRC_DIR,
    // server.py 在函数体里才 import 发送层，显式声明避免被分析漏掉
    '--hidden-import', 'wechat_sender',
    ...DATA_FILES.flatMap((f) => ['--add-data', `${path.join(SRC_DIR, f)};.`]),
    path.join(SRC_DIR, 'server.py'),
  ]
  log(`开始构建（uv + PyInstaller，首次需下载依赖）`)
  try {
    execFileSync(uv, args, { cwd: SRC_DIR, env, stdio: 'inherit', windowsHide: true })
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }

  const sizeMb = (fs.statSync(EXE_PATH).size / 1024 / 1024).toFixed(1)
  log(`产物：${path.relative(WINDOWS_ROOT, EXE_PATH)}（${sizeMb} MB）`)
  smokeTest()
}

try {
  main()
} catch (err) {
  console.error(`[build-wechat-mcp] 失败：${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
