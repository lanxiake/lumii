/**
 * 把 resources/wechat-mcp（Python 源码）打成独立的单文件 wechat-mcp.exe
 *
 * 产物不依赖任何 Python 环境与灵栖占位符，任意 MCP 客户端写 exe 绝对路径即可用。
 * 构建用 uv 准备隔离的 Python 3.11 + PyInstaller，不污染本机/托管解释器。
 *
 * 用法：node scripts/build-wechat-mcp.mjs [--if-stale] [--edition lite|pro]
 *   --if-stale       exe 已存在且比所有源码都新时跳过（开发期反复执行不浪费 1 分钟）
 *   --edition        档位，默认 pro。pro 出 `wechat-mcp.exe`（灵栖内置与 npm 平台包都用它，
 *                    路径写死不能改），lite 出 `wechat-mcp-lite.exe`（基础版，单独分发）
 *
 * **档位是构建期注入的**：源码整个拷进临时目录，再写一个 `edition.py`（server.py 里
 * `from edition import EDITION`，取不到就默认 pro）。工作区不落这个文件，
 * 所以「跑源码 = pro」，也不会出现"本地改过 edition.py 忘了改回来"。
 *
 * 版本号唯一来源是 server.py 的 SERVER_VERSION（与 pack-wechat-mcp-npm.mjs 一致），
 * 它同时写进 exe 的 Windows 版本资源（右键属性 → 详细信息）。
 *
 * 产物：resources/wechat-mcp/dist/
 *   wechat-mcp.exe / wechat-mcp-lite.exe            名字固定，electron-builder 由此拷进安装包、
 *                                                   灵栖也据此把 exe 同步到固定的部署路径，不能带版本号
 *   wechat-mcp-<version>.exe 等                     同一份二进制的副本，供人眼区分与单独分发
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WINDOWS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = path.join(WINDOWS_ROOT, 'resources', 'wechat-mcp')
const DIST_DIR = path.join(SRC_DIR, 'dist')
/** 档位：pro（默认，`wechat-mcp.exe`）/ lite（`wechat-mcp-lite.exe`） */
const EDITION = (() => {
  const i = process.argv.indexOf('--edition')
  const value = i >= 0 ? process.argv[i + 1] : 'pro'
  if (value !== 'pro' && value !== 'lite') throw new Error(`--edition 只认 pro / lite，收到 ${value}`)
  return value
})()
/** exe 基名：灵栖内置与 npm 平台包都写死 `wechat-mcp`（绑定部署路径），不能带版本号或档位 */
const EXE_NAME = EDITION === 'lite' ? 'wechat-mcp-lite' : 'wechat-mcp'
/**
 * 另一档的基名——清理旧副本时必须排除它。
 *
 * pro 的名字 `wechat-mcp` 恰好是 lite 名字的前缀，光按 `startsWith('wechat-mcp-')` 判断
 * 会把 `wechat-mcp-lite.exe` 一起当旧副本删掉（踩过一次）。lite 反过来不会误伤 pro。
 */
const OTHER_EXE_NAME = EXE_NAME === 'wechat-mcp' ? 'wechat-mcp-lite' : null
const EXE_PATH = path.join(DIST_DIR, `${EXE_NAME}.exe`)
/** exe 里需要的随包数据（运行时由 sys._MEIPASS 定位） */
const DATA_FILES = ['ocr4.ps1', 'uia_read.ps1', 'tray_click.ps1']
/** 基础依赖，与 requirements.txt 前两条保持一致 */
const RUNTIME_DEPS = ['pycryptodome>=3.20', 'zstandard>=0.22']
/**
 * 只有 **pro 的语音转写**（`wechat_asr.py`，惰性导入）用得上的重依赖——**lite 版不带**，
 * 否则两版体积就没区别了。ASR **模型**（78MB）也不在这里：按需下到 `~/.lumii/models/voice/`。
 */
const ASR_DEPS = ['pilk>=0.2', 'sherpa-onnx>=1.10', 'numpy>=1.24']
/** 惰性导入的模块，PyInstaller 静态分析看不见，必须显式声明 */
const HIDDEN_IMPORTS = { pro: ['wechat_sender', 'wechat_asr'], lite: ['wechat_sender'] }
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
  return path.join(DIST_DIR, `${EXE_NAME}-${version}.exe`)
}

/**
 * 把源码拷进临时目录并写入 `edition.py`（档位**只在构建期**注入，工作区不落这个文件）
 *
 * 只拷源码与随包数据，跳过 dist/、npm/、__pycache__ 与 test_*.py——
 * PyInstaller 只跟 import 和显式 `--add-data`，测试文件进不进目录都不影响产物。
 *
 * @param {string} workDir 本次构建的临时目录
 * @returns {string} 供 PyInstaller 使用的源码目录（绝对路径）
 */
function prepareSource(workDir) {
  const dst = path.join(workDir, 'src')
  fs.mkdirSync(dst, { recursive: true })
  for (const f of fs.readdirSync(SRC_DIR)) {
    if (f.startsWith('test_') || ['dist', 'npm', '__pycache__'].includes(f)) continue
    const src = path.join(SRC_DIR, f)
    if (!fs.statSync(src).isFile()) continue
    if (!(f.endsWith('.py') || DATA_FILES.includes(f))) continue
    fs.copyFileSync(src, path.join(dst, f))
  }
  fs.writeFileSync(path.join(dst, 'edition.py'), `# 构建期生成：本产物的档位\nEDITION = "${EDITION}"\n`)
  return dst
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
      StringStruct('InternalName', '${EXE_NAME}'),
      StringStruct('OriginalFilename', '${EXE_NAME}.exe'),
      StringStruct('ProductName', 'Lumii ${EXE_NAME}'),
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
  // 档位是构建期写进去的——产物自报的**构建档位**必须与本次参数一致，否则等于发错版本。
  // 注意比的是 `--edition`（构建档位）而不是 initialize 里的 `edition`（**运行期生效**档位）：
  // 后者会因构建机上有没有授权/内置标记而变，拿它当判据等于让机器状态决定构建是否通过。
  const edition = spawnSync(EXE_PATH, ['--edition'], { encoding: 'utf-8', windowsHide: true }).stdout?.trim()
  if (edition !== EDITION) throw new Error(`exe 档位不符：本次构建 --edition ${EDITION}，产物自报 ${edition}`)
  log(`冒烟通过：${reply.result.serverInfo.name} v${reported} (构建档位 ${edition}，运行期 ${reply.result.serverInfo.edition})`)
  return reported
}

/** 构建主流程 */
function main() {
  if (process.platform !== 'win32') {
    log(`${EXE_NAME} 仅支持 Windows，跳过构建`)
    return
  }
  const version = readServerVersion()
  if (process.argv.includes('--if-stale') && isUpToDate(version)) {
    log(`已是最新，跳过：${path.relative(WINDOWS_ROOT, EXE_PATH)}`)
    return
  }
  const uv = locateUv()
  if (!uv) {
    throw new Error(`未找到 uv（https://docs.astral.sh/uv/），无法构建 ${EXE_NAME}.exe`)
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-mcp-build-'))
  const srcDir = prepareSource(workDir)
  const versionFile = path.join(workDir, 'version_info.txt')
  fs.writeFileSync(versionFile, versionInfoSource(version))
  const env = { ...process.env }
  if (!env.UV_DEFAULT_INDEX && !env.UV_INDEX_URL && !env.CI) env.UV_DEFAULT_INDEX = DEFAULT_INDEX

  const args = [
    'run', '--no-project', '--python', '3.11',
    '--with', PYINSTALLER_SPEC,
    ...RUNTIME_DEPS.flatMap((dep) => ['--with', dep]),
    ...(EDITION === 'pro' ? ASR_DEPS.flatMap((dep) => ['--with', dep]) : []),
    '--', 'pyinstaller',
    '--noconfirm', '--clean', '--onefile', '--console',
    '--name', EXE_NAME,
    '--version-file', versionFile,
    '--distpath', DIST_DIR,
    '--workpath', path.join(workDir, 'build'),
    '--specpath', workDir,
    '--paths', srcDir,
    ...HIDDEN_IMPORTS[EDITION].flatMap((m) => ['--hidden-import', m]),
    ...DATA_FILES.flatMap((f) => ['--add-data', `${path.join(srcDir, f)};.`]),
    path.join(srcDir, 'server.py'),
  ]
  log(`开始构建 ${EDITION} 档（uv + PyInstaller，首次需下载依赖）`)
  try {
    execFileSync(uv, args, { cwd: srcDir, env, stdio: 'inherit', windowsHide: true })
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }

  const built = smokeTest()
  if (built !== version) {
    log(`警告：构建期间 server.py 的 SERVER_VERSION 由 ${version} 变成了 ${built}，以 exe 实际版本为准`)
  }

  // dist 里**本档**历史版本的副本清掉，免得堆一堆认不出谁是谁的 exe（正被占用就留给下一次）
  const versionedExe = versionedExePath(built)
  for (const f of fs.readdirSync(DIST_DIR)) {
    const full = path.join(DIST_DIR, f)
    const owned = f.startsWith(`${EXE_NAME}-`) && !(OTHER_EXE_NAME && f.startsWith(OTHER_EXE_NAME))
    if (full === versionedExe || !owned) continue
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
