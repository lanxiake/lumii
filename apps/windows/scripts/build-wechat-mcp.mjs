/**
 * 把 resources/wechat-mcp（Python 源码）打成独立的单文件 exe（**lite 与 pro 各一个**）
 *
 * 产物不依赖任何 Python 环境与灵栖占位符，任意 MCP 客户端写 exe 绝对路径即可用。
 * 构建用 uv 准备隔离的 Python 3.11 + PyInstaller，不污染本机/托管解释器。
 *
 * 用法：node scripts/build-wechat-mcp.mjs [--if-stale] [--edition pro|lite|both]
 *   （不带 --edition）= **两档都打**（默认），等价于 --edition both
 *   --edition pro     只打高级版（`wechat-mcp.exe`）
 *   --edition lite    只打基础版（`wechat-mcp-lite.exe`）
 *   --if-stale        两档产物都已存在且比所有源码新时跳过（开发期反复执行不浪费几分钟）
 *
 * **档位是构建期注入的**：源码整个拷进临时目录，再写一个 `edition.py`（server.py 里
 * `from edition import EDITION`，取不到就默认 pro）。工作区不落这个文件，
 * 所以「跑源码 = pro」，也不会出现"本地改过 edition.py 忘了改回来"。
 * 两档各自用**独立的临时目录**，互不影响。
 *
 * 版本号唯一来源是 server.py 的 SERVER_VERSION（与 pack-wechat-mcp-npm.mjs 一致），
 * 它同时写进 exe 的 Windows 版本资源（右键属性 → 详细信息）。
 *
 * 产物：resources/wechat-mcp/dist/
 *   wechat-mcp.exe / wechat-mcp-lite.exe            名字固定，electron-builder 由此拷进安装包、
 *                                                   灵栖也据此把 exe 同步到固定的部署路径，不能带版本号
 *   wechat-mcp-<version>.exe / wechat-mcp-lite-<version>.exe
 *                                                   同一份二进制的副本，供人眼区分与单独分发
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WINDOWS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = path.join(WINDOWS_ROOT, 'resources', 'wechat-mcp')
const DIST_DIR = path.join(SRC_DIR, 'dist')

/**
 * 两档的构建参数。
 *
 * `exe` 是基名：灵栖内置与 npm 平台包都写死 `wechat-mcp`（绑定部署路径），不能带版本号或档位；
 * lite 的基名恰好多一个 `-lite` 后缀——这层**前缀关系**是本文件最容易被写错的地方，
 * 见 `ownerOf()`。
 *
 * `hidden` 是 PyInstaller 的 `--hidden-import`：这些模块是**惰性导入**的，静态分析看不见。
 * `asr` 决定要不要带上语音转写的重依赖（`pilk`/`sherpa-onnx`/`numpy`）——**只有 pro 需要**，
 * 否则两版体积就没区别了。ASR **模型**（78MB）也不在这里：按需下到 `~/.lumii/models/voice/`。
 */
const EDITION_SPECS = {
  pro: { exe: 'wechat-mcp', hidden: ['wechat_sender', 'wechat_asr'], asr: true },
  lite: { exe: 'wechat-mcp-lite', hidden: ['wechat_sender'], asr: false },
}
const EDITIONS = Object.keys(EDITION_SPECS)

/**
 * 按基名**从长到短**排——用来判定 dist 里的某个文件属于哪一档。
 *
 * 为什么必须最长优先：pro 的基名 `wechat-mcp` 是 lite 的 `wechat-mcp-lite` 的**前缀**，
 * 光按 `startsWith('wechat-mcp-')` 判断会把 `wechat-mcp-lite.exe` 当成 pro 的旧副本删掉
 * （真踩过：pro 构建删掉了刚打好的 lite 产物）。反过来按「第一个匹配上的最长的名字」判定，
 * `wechat-mcp-lite-0.7.0.exe` 归 lite、`wechat-mcp-0.7.0.exe` 归 pro，两个方向都对。
 */
const NAMES_LONGEST_FIRST = EDITIONS.map((e) => EDITION_SPECS[e].exe).sort((a, b) => b.length - a.length)

/** exe 里需要的随包数据（运行时由 sys._MEIPASS 定位） */
const DATA_FILES = ['ocr4.ps1', 'uia_read.ps1', 'tray_click.ps1']
/** 基础依赖，与 requirements.txt 前两条保持一致 */
const RUNTIME_DEPS = ['pycryptodome>=3.20', 'zstandard>=0.22']
/** 只有 pro 的语音转写用得上的重依赖 */
const ASR_DEPS = ['pilk>=0.2', 'sherpa-onnx>=1.10', 'numpy>=1.24']
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
 * 解析 `--edition`：不给就是**两档都打**
 * @returns {string[]} 要构建的档位列表
 */
function parseEditions() {
  const i = process.argv.indexOf('--edition')
  if (i < 0) return [...EDITIONS]
  const value = process.argv[i + 1]
  if (value === 'both') return [...EDITIONS]
  if (!EDITIONS.includes(value)) {
    throw new Error(`--edition 只认 ${EDITIONS.join(' / ')} / both，收到 ${value}`)
  }
  return [value]
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

/** 无版本号的固定产物路径（灵栖与 electron-builder 认的就是它） */
function exePathOf(spec) {
  return path.join(DIST_DIR, `${spec.exe}.exe`)
}

/**
 * 带版本号的副产物路径（同名规则见文件头注释）
 * @param {object} spec 档位参数
 * @param {string} version 版本号
 */
function versionedExePath(spec, version) {
  return path.join(DIST_DIR, `${spec.exe}-${version}.exe`)
}

/** dist 里这个文件归哪一档（不属于任何一档返回 null） */
function ownerOf(fileName) {
  const hit = NAMES_LONGEST_FIRST.find((n) => fileName.startsWith(`${n}-`))
  return hit ?? null
}

/**
 * 把源码拷进临时目录并写入 `edition.py`（档位**只在构建期**注入，工作区不落这个文件）
 *
 * 只拷源码与随包数据，跳过 dist/、npm/、__pycache__ 与 test_*.py——
 * PyInstaller 只跟 import 和显式 `--add-data`，测试文件进不进目录都不影响产物。
 *
 * @param {string} workDir 本次构建的临时目录
 * @param {object} spec 档位参数
 * @param {string} edition 档位名（写进 edition.py）
 * @returns {string} 供 PyInstaller 使用的源码目录（绝对路径）
 */
function prepareSource(workDir, spec, edition) {
  const dst = path.join(workDir, 'src')
  fs.mkdirSync(dst, { recursive: true })
  for (const f of fs.readdirSync(SRC_DIR)) {
    if (f.startsWith('test_') || ['dist', 'npm', '__pycache__'].includes(f)) continue
    const src = path.join(SRC_DIR, f)
    if (!fs.statSync(src).isFile()) continue
    if (!(f.endsWith('.py') || DATA_FILES.includes(f))) continue
    fs.copyFileSync(src, path.join(dst, f))
  }
  fs.writeFileSync(path.join(dst, 'edition.py'), `# 构建期生成：本产物的档位\nEDITION = "${edition}"\n`)
  return dst
}

/**
 * 生成 PyInstaller 的 Windows 版本资源文件内容
 *
 * 写进 exe 本体后，资源管理器属性页（详细信息/Detail）能直接看到版本，
 * 与文件名无关——文件被改名或复制后依旧可辨认。
 *
 * @param {string} version 形如 0.5.0
 * @param {object} spec 档位参数
 */
function versionInfoSource(version, spec) {
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
      StringStruct('InternalName', '${spec.exe}'),
      StringStruct('OriginalFilename', '${spec.exe}.exe'),
      StringStruct('ProductName', 'Lumii ${spec.exe}'),
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
 * 这一档的 exe 与其带版本号的副本是否都已比全部源码新
 * @param {object} spec 档位参数
 * @param {string} version 版本号
 * @returns {boolean}
 */
function isUpToDate(spec, version) {
  const exe = exePathOf(spec)
  const versioned = versionedExePath(spec, version)
  if (!fs.existsSync(exe) || !fs.existsSync(versioned)) return false
  const exeTime = fs.statSync(exe).mtimeMs
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
 * @param {object} spec 档位参数
 * @param {string} edition 档位名
 * @returns {string} exe 自报的版本
 */
function smokeTest(spec, edition) {
  const exe = exePathOf(spec)
  const printed = spawnSync(exe, ['--version'], { encoding: 'utf-8', windowsHide: true }).stdout?.trim()

  const request = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'build-smoke', version: '0' } },
  })
  const result = spawnSync(exe, [], {
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
  const got = spawnSync(exe, ['--edition'], { encoding: 'utf-8', windowsHide: true }).stdout?.trim()
  if (got !== edition) throw new Error(`exe 档位不符：本次构建 --edition ${edition}，产物自报 ${got}`)
  log(`冒烟通过：${reply.result.serverInfo.name} v${reported} (构建档位 ${got}，运行期 ${reply.result.serverInfo.edition})`)
  return reported
}

/**
 * 构建一个档位
 *
 * @param {string} uv uv 可执行文件
 * @param {string} edition 档位名
 * @param {string} version 构建前读到的版本号
 * @param {object} env 带镜像配置的环境变量
 */
function buildOne(uv, edition, version, env) {
  const spec = EDITION_SPECS[edition]
  const exe = exePathOf(spec)

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `wechat-mcp-build-${edition}-`))
  let built
  try {
    const srcDir = prepareSource(workDir, spec, edition)
    const versionFile = path.join(workDir, 'version_info.txt')
    fs.writeFileSync(versionFile, versionInfoSource(version, spec))

    const args = [
      'run', '--no-project', '--python', '3.11',
      '--with', PYINSTALLER_SPEC,
      ...RUNTIME_DEPS.flatMap((dep) => ['--with', dep]),
      ...(spec.asr ? ASR_DEPS.flatMap((dep) => ['--with', dep]) : []),
      '--', 'pyinstaller',
      '--noconfirm', '--clean', '--onefile', '--console',
      '--name', spec.exe,
      '--version-file', versionFile,
      '--distpath', DIST_DIR,
      '--workpath', path.join(workDir, 'build'),
      '--specpath', workDir,
      '--paths', srcDir,
      ...spec.hidden.flatMap((m) => ['--hidden-import', m]),
      ...DATA_FILES.flatMap((f) => ['--add-data', `${path.join(srcDir, f)};.`]),
      path.join(srcDir, 'server.py'),
    ]
    log(`--- 构建 ${edition} 档（uv + PyInstaller，首次需下载依赖）---`)
    execFileSync(uv, args, { cwd: srcDir, env, stdio: 'inherit', windowsHide: true })
    built = smokeTest(spec, edition)
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }

  if (built !== version) {
    log(`警告：构建期间 server.py 的 SERVER_VERSION 由 ${version} 变成了 ${built}，以 exe 实际版本为准`)
  }

  // dist 里**本档**历史版本的副本清掉，免得堆一堆认不出谁是谁的 exe（正被占用就留给下一次）。
  // 归属判定走 `ownerOf()`——它按「最长的名字」优先，所以 pro 不会把 lite 的副本当自己的删掉。
  const versionedExe = versionedExePath(spec, built)
  for (const f of fs.readdirSync(DIST_DIR)) {
    const full = path.join(DIST_DIR, f)
    if (ownerOf(f) !== spec.exe || full === versionedExe) continue
    try {
      fs.rmSync(full, { force: true })
    } catch {
      log(`旧副本删不掉（可能在运行中），忽略：${f}`)
    }
  }
  fs.copyFileSync(exe, versionedExe)

  const sizeMb = (fs.statSync(exe).size / 1024 / 1024).toFixed(1)
  log(`产物：${path.relative(WINDOWS_ROOT, exe)}（${sizeMb} MB）`)
  log(`带版本号副本：${path.relative(WINDOWS_ROOT, versionedExe)}`)
}

/** 构建主流程 */
function main() {
  if (process.platform !== 'win32') {
    log('本机微信 MCP 仅支持 Windows，跳过构建')
    return
  }
  const editions = parseEditions()
  const version = readServerVersion()

  if (process.argv.includes('--if-stale') && editions.every((e) => isUpToDate(EDITION_SPECS[e], version))) {
    const names = editions.map((e) => `${EDITION_SPECS[e].exe}.exe`).join('、')
    log(`${editions.length > 1 ? '两档' : '本档'}都已是最新，跳过：${names}`)
    return
  }

  const uv = locateUv()
  if (!uv) {
    throw new Error('未找到 uv（https://docs.astral.sh/uv/），无法构建')
  }
  const env = { ...process.env }
  if (!env.UV_DEFAULT_INDEX && !env.UV_INDEX_URL && !env.CI) env.UV_DEFAULT_INDEX = DEFAULT_INDEX

  for (const edition of editions) buildOne(uv, edition, version, env)
  log(`完成：${editions.join(' + ')}`)
}

try {
  main()
} catch (err) {
  console.error(`[build-wechat-mcp] 失败：${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
