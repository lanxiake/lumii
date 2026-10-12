/**
 * 把 resources/wechat-file-mcp（文件归档 MCP，Python 源码）打成单文件 exe。
 *
 * 与 `build-wechat-mcp.mjs` 的区别：本产品**单档**、无授权、无 ASR、无随包数据；
 * 且它**依赖 wechat-mcp 的共享读取层**（wechat_core / wxkey4 / wxread4），
 * 所以打包时要**保留兄弟目录布局**（`wechat-file-mcp/` 与 `wechat-mcp/` 并列），
 * filecore.py 里那句 `sys.path.insert(0, ../wechat-mcp)` 在源码运行与冻结运行时行为一致。
 *
 * 用法：node scripts/build-wechat-file-mcp.mjs [--if-stale]
 *
 * 产物：resources/wechat-file-mcp/dist/wechat-file-mcp.exe（固定名）
 *       + wechat-file-mcp-<version>.exe（带版本号副本，供人眼区分与单独分发）
 *
 * 版本号唯一来源是 server.py 的 SERVER_VERSION。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WINDOWS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = path.join(WINDOWS_ROOT, 'resources', 'wechat-file-mcp')
const SHARED_DIR = path.join(WINDOWS_ROOT, 'resources', 'wechat-mcp')
const DIST_DIR = path.join(SRC_DIR, 'dist')

const NAME = 'wechat-file-mcp'
const RUNTIME_DEPS = ['pycryptodome>=3.20', 'zstandard>=0.22']   // 共享读取层的依赖
const PYINSTALLER_SPEC = 'pyinstaller>=6.10'
const SKIP_DIRS = new Set(['dist', 'npm', '__pycache__'])

function log(msg) {
  console.log(`[build-wechat-file-mcp] ${msg}`)
}

function readSourceVersion() {
  const m = fs.readFileSync(path.join(SRC_DIR, 'server.py'), 'utf-8').match(/SERVER_VERSION\s*=\s*"([^"]+)"/)
  if (!m) throw new Error('server.py 里找不到 SERVER_VERSION')
  return m[1]
}

/** 拷贝某个目录下所有非测试 .py 到 staged（保持子目录名）。 */
function stagePyDir(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true })
  for (const f of fs.readdirSync(fromDir)) {
    if (f.endsWith('.py') && !f.startsWith('test_') && !SKIP_DIRS.has(f)) {
      fs.copyFileSync(path.join(fromDir, f), path.join(toDir, f))
    }
  }
}

/**
 * 把两个包的源码拷进临时目录，**保留 `wechat-file-mcp/` 与 `wechat-mcp/` 的兄弟关系**。
 * @returns {string} 供 PyInstaller 作为入口的目录（staged/wechat-file-mcp）
 */
function prepareSource(workDir) {
  const staged = path.join(workDir, 'staged')
  stagePyDir(SRC_DIR, path.join(staged, 'wechat-file-mcp'))
  stagePyDir(SHARED_DIR, path.join(staged, 'wechat-mcp'))
  return path.join(staged, 'wechat-file-mcp')
}

function locateUv() {
  if (spawnSync('uv', ['--version'], { encoding: 'utf-8', windowsHide: true }).status === 0) return 'uv'
  const fallback = path.join(os.homedir(), '.local', 'bin', 'uv.exe')
  return fs.existsSync(fallback) ? fallback : null
}

/** exe 冒烟：`--version` 与 `initialize` 自报的版本必须一致，且服务名正确。 */
function smokeTest(exe) {
  const printed = spawnSync(exe, ['--version'], { encoding: 'utf-8', windowsHide: true }).stdout?.trim()
  const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
                               params: { protocolVersion: '2025-06-18' } })
  const res = spawnSync(exe, [], { input: `${req}\n`, encoding: 'utf-8', timeout: 60_000, windowsHide: true })
  const line = (res.stdout ?? '').split('\n').find((l) => l.trim())
  const reply = line ? JSON.parse(line) : null
  if (reply?.result?.serverInfo?.name !== 'wechat-file') {
    throw new Error(`exe 握手冒烟失败：stdout=${res.stdout} stderr=${res.stderr}`)
  }
  const reported = reply.result.serverInfo.version
  if (printed !== reported) throw new Error(`exe 版本自相矛盾：--version=${printed}，initialize=${reported}`)
  log(`冒烟通过：${reply.result.serverInfo.name} v${reported}`)
  return reported
}

function build(uv, env) {
  const version = readSourceVersion()
  const exe = path.join(DIST_DIR, `${NAME}.exe`)
  const versioned = path.join(DIST_DIR, `${NAME}-${version}.exe`)
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-file-build-'))
  let built
  try {
    const entryDir = prepareSource(workDir)
    const sharedDir = path.join(path.dirname(entryDir), 'wechat-mcp')
    const args = [
      'run', '--no-project', '--python', '3.11',
      '--with', PYINSTALLER_SPEC,
      ...RUNTIME_DEPS.flatMap((d) => ['--with', d]),
      '--', 'pyinstaller',
      '--noconfirm', '--clean', '--onefile', '--console',
      '--name', NAME,
      '--distpath', DIST_DIR,
      '--workpath', path.join(workDir, 'build'),
      '--specpath', workDir,
      '--paths', entryDir, '--paths', sharedDir,   // 共享读取层也进搜索路径
      path.join(entryDir, 'server.py'),
    ]
    log('--- 构建（uv + PyInstaller，首次需下载依赖）---')
    execFileSync(uv, args, { cwd: entryDir, env, stdio: 'inherit', windowsHide: true })
    built = smokeTest(exe)
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
  // 拷一份带版本号的副本；清掉 dist 里本产品的历史版本副本（固定名保留）
  fs.copyFileSync(exe, versioned)
  for (const f of fs.readdirSync(DIST_DIR)) {
    const full = path.join(DIST_DIR, f)
    if (f.startsWith(`${NAME}-`) && f.endsWith('.exe') && full !== versioned) {
      try { fs.rmSync(full) } catch { /* 被占用留给下次 */ }
    }
  }
  log(`产物：${exe}`)
  log(`      ${versioned}`)
}

function isUpToDate() {
  const version = readSourceVersion()
  const exe = path.join(DIST_DIR, `${NAME}.exe`)
  const versioned = path.join(DIST_DIR, `${NAME}-${version}.exe`)
  if (!fs.existsSync(exe) || !fs.existsSync(versioned)) return false
  const t = fs.statSync(exe).mtimeMs
  const srcs = [SRC_DIR, SHARED_DIR].flatMap((d) =>
    fs.readdirSync(d).filter((f) => f.endsWith('.py') && !f.startsWith('test_')).map((f) => path.join(d, f)))
  return srcs.every((f) => fs.statSync(f).mtimeMs <= t)
}

function main() {
  const argv = process.argv.slice(2)
  const uv = locateUv()
  if (!uv) {
    console.error('找不到 uv，请先安装：https://docs.astral.sh/uv/')
    process.exit(1)
  }
  if (argv.includes('--if-stale') && isUpToDate()) {
    log('产物已是最新，跳过构建')
    return
  }
  const env = { ...process.env }
  if (!env.UV_DEFAULT_INDEX && process.env.npm_config_registry?.includes('npmmirror')) {
    env.UV_DEFAULT_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple'
  }
  build(uv, env)
}

main()
