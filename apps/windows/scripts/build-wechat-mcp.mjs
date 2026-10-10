/**
 * 把 resources/wechat-mcp（Python 源码）打成独立的单文件 wechat-mcp.exe
 *
 * 产物不依赖任何 Python 环境与灵栖占位符，任意 MCP 客户端写 exe 绝对路径即可用。
 * 构建用 uv 准备隔离的 Python 3.11 + PyInstaller，不污染本机/托管解释器。
 *
 * 用法：node scripts/build-wechat-mcp.mjs [--if-stale]
 *   --if-stale  exe 已存在且比所有源码都新时跳过（开发期反复执行不浪费 1 分钟）
 *
 * 版本号唯一来源是 server.py 的 SERVER_VERSION（与 pack-wechat-mcp-npm.mjs 一致），
 * 它同时写进 exe 的 Windows 版本资源（右键属性 → 详细信息）。
 *
 * 产物：resources/wechat-mcp/dist/
 *   wechat-mcp.exe            名字固定，electron-builder 由此拷进安装包、
 *                             灵栖也据此把 exe 同步到固定的部署路径，不能带版本号
 *   wechat-mcp-<version>.exe  同一份二进制的副本，供人眼区分与单独分发
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
const DATA_FILES = ['ocr4.ps1', 'uia_read.ps1', 'tray_click.ps1']
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
 * 从 server.py 读取 SERVER_VERSION（唯一版本源）
 * @returns {string} 形如 0.5.0
 */
function readServerVersion() {
  const source = fs.readFileSync(path.join(SRC_DIR, 'server.py'), 'utf-8')
  const match = source.match(/^SERVER_VERSION\s*=\s*"([^"]+)"/m)
  if (!match) throw new Error('server.py 里找不到 SERVER_VERSION')
  return match[1]
}

/**
 * 带版本号的副产物路径（同名规则见文件头注释）
 * @param {string} version 版本号
 */
function versionedExePath(version) {
  return path.join(DIST_DIR, `wechat-mcp-${version}.exe`)
}

/**
 * 生成 PyInstaller 的 Windows 版本资源文件内容
 *
 * 写进 exe 本体后，资源管理器属性页（详细信息/Detail）能直接看到版本，
 * 与文件名无关——文件被改名或复制后依旧可辨认。
 *
 * @param {string} version 形如 0.5.0
 */
function versionInfoSource(version) {
  const [a, b, c, d = 0] = version.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const quad = `${a}, ${b}, ${c}, ${d}`
  const dotted = `${a}.${b}.${c}.${d}`
  return `VSVersionInfo(
  ffi=FixedFileInfo(filevers=(${quad}), prodvers=(${quad}), mask=0x3f, flags=0x0, OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([StringTable('040904B0', [
      StringStruct('CompanyName', 'Lumii'),
      StringStruct('FileDescription', 'Lumii 本机微信 MCP 服务'),
      StringStruct('FileVersion', '${dotted}'),
      StringStruct('InternalName', 'wechat-mcp'),
      StringStruct('OriginalFilename', 'wechat-mcp.exe'),
      StringStruct('ProductName', 'Lumii wechat-mcp'),
      StringStruct('ProductVersion', '${dotted}')])]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])])`
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
 * exe 与其带版本号的副本是否都已比全部源码新
 * @param {string} version 版本号
 * @returns {boolean}
 */
function isUpToDate(version) {
  if (!fs.existsSync(EXE_PATH) || !fs.existsSync(versionedExePath(version))) return false
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
 * 用 initialize 请求冒烟：exe 必须能报版本、完成 MCP 握手，且两处版本自洽
 *
 * 返回的是 **exe 自报**的版本——构建期间源码可能被并行改动，
 * 这个值才是产物的真相，带版本号的副本按它命名。
 *
 * @returns {string} exe 自报的版本
 */
function smokeTest() {
  const printed = spawnSync(EXE_PATH, ['--version'], { encoding: 'utf-8', windowsHide: true }).stdout?.trim()

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
  const reported = reply.result.serverInfo.version
  if (printed !== reported) throw new Error(`exe 版本自相矛盾：--version 给 ${printed}，initialize 给 ${reported}`)
  log(`冒烟通过：${reply.result.serverInfo.name} v${reported}`)
  return reported
}

/** 构建主流程 */
function main() {
  if (process.platform !== 'win32') {
    log('wechat-mcp 仅支持 Windows，跳过构建')
    return
  }
  const version = readServerVersion()
  if (process.argv.includes('--if-stale') && isUpToDate(version)) {
    log(`已是最新，跳过：${path.relative(WINDOWS_ROOT, EXE_PATH)}`)
    return
  }
  const uv = locateUv()
  if (!uv) {
    throw new Error('未找到 uv（https://docs.astral.sh/uv/），无法构建 wechat-mcp.exe')
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-mcp-build-'))
  const versionFile = path.join(workDir, 'version_info.txt')
  fs.writeFileSync(versionFile, versionInfoSource(version))
  const env = { ...process.env }
  if (!env.UV_DEFAULT_INDEX && !env.UV_INDEX_URL && !env.CI) env.UV_DEFAULT_INDEX = DEFAULT_INDEX

  const args = [
    'run', '--no-project', '--python', '3.11',
    '--with', PYINSTALLER_SPEC,
    ...RUNTIME_DEPS.flatMap((dep) => ['--with', dep]),
    '--', 'pyinstaller',
    '--noconfirm', '--clean', '--onefile', '--console',
    '--name', 'wechat-mcp',
    '--version-file', versionFile,
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

  const built = smokeTest()
  if (built !== version) {
    log(`警告：构建期间 server.py 的 SERVER_VERSION 由 ${version} 变成了 ${built}，以 exe 实际版本为准`)
  }

  // dist 里历史版本的副本清掉，免得堆一堆认不出谁是谁的 exe（正被占用就留给下一次）
  const versionedExe = versionedExePath(built)
  for (const f of fs.readdirSync(DIST_DIR)) {
    const full = path.join(DIST_DIR, f)
    if (full === versionedExe || !/^wechat-mcp-.*\.exe$/.test(f)) continue
    try {
      fs.rmSync(full, { force: true })
    } catch {
      log(`旧副本删不掉（可能在运行中），忽略：${f}`)
    }
  }
  fs.copyFileSync(EXE_PATH, versionedExe)

  const sizeMb = (fs.statSync(EXE_PATH).size / 1024 / 1024).toFixed(1)
  log(`产物：${path.relative(WINDOWS_ROOT, EXE_PATH)}（${sizeMb} MB）`)
  log(`带版本号副本：${path.relative(WINDOWS_ROOT, versionedExe)}`)
}

try {
  main()
} catch (err) {
  console.error(`[build-wechat-mcp] 失败：${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
