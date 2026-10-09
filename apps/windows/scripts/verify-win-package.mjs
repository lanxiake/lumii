#!/usr/bin/env node
/**
 * Windows 产物验收：把「打包命令退出码 0」与「产物真的能用」分开判。
 *
 * ## 存在理由（2026-09-21）
 *
 * 跑「Windows 门槛 3」时实测到：`pnpm package:win` **成功退出、安装包也生成了**，
 * 但产物里的 `app.asar` 是坏的 —— 439/504 个 `node_modules/**\/package.json`
 * 装的是**别的文件的字节**，Electron 加载主脚本即失败，只弹一个标题为 `Error`
 * 的对话框：没有窗口、不写日志、不建数据根，看起来像「什么都没发生」。
 *
 * 也就是说：**exit code 0 + 文件存在，都不构成「产物可用」的判据**。
 * 本脚本提供两条能自动断言的判据，换台机器也能重跑出同样的结论。
 *
 * ## 子命令
 *
 *   asar       读 app.asar，逐个 package.json 做 JSON.parse，并核对数据区长度
 *   resources  断言随包独立 MCP exe 真的进了产物，且与仓库构建产物一致
 *   launch     用隔离的数据根启动 win-unpacked/Lumii.exe，等日志出现就绪标记后退出
 *   all        全跑（默认）
 *
 * ## 用法
 *
 *   node apps/windows/scripts/verify-win-package.mjs all
 *   node apps/windows/scripts/verify-win-package.mjs asar
 *   node apps/windows/scripts/verify-win-package.mjs resources
 *   node apps/windows/scripts/verify-win-package.mjs all --release-dir release-build-1234
 *
 * `--release-dir` 用相对 `apps/windows` 的路径指定产物目录（默认 `release`）——
 * `package-app.js` 在 release/ 被占用时会兜底输出到 `release-build-<时间戳>/`，
 * 那时要验的就是那一份。
 *
 * ## 前置
 *
 *   已跑过 `pnpm package:win`（或 `--target dir`）产出 release/win-unpacked
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WIN_ROOT = path.resolve(HERE, '..')

/** 解析 `--release-dir`（相对 apps/windows）；默认 release */
function resolveReleaseDir(argv) {
  const i = argv.indexOf('--release-dir')
  if (i === -1) return path.join(WIN_ROOT, 'release')
  const value = argv[i + 1]
  if (!value) {
    console.error('--release-dir 需要跟一个路径')
    process.exit(2)
  }
  return path.resolve(WIN_ROOT, value)
}

const RELEASE = resolveReleaseDir(process.argv.slice(2))
const UNPACKED = path.join(RELEASE, 'win-unpacked')
const ASAR = path.join(UNPACKED, 'resources', 'app.asar')
const EXE = path.join(UNPACKED, 'Lumii.exe')

const red = (s) => console.log(`\x1b[31m✗ ${s}\x1b[0m`)
const grn = (s) => console.log(`\x1b[32m✓ ${s}\x1b[0m`)
const ylw = (s) => console.log(`\x1b[33m! ${s}\x1b[0m`)
const step = (s) => console.log(`\n\x1b[36m== ${s} ==\x1b[0m`)

/** 启动后必须出现的就绪标记（与主进程/渲染进程实际打印的文案一致） */
const READY_MARKERS = ['日志系统已初始化', 'React 应用已挂载', '窗口准备就绪', '创建系统托盘']

// ---------------------------------------------------------------- asar

/**
 * 解析 asar 头。
 *
 * 实测字节布局（@electron/asar 的 pickle，取本仓库产物实测值对照）：
 *   [0..4)   uint32 固定 4
 *   [4..8)   uint32 外层 pickle 载荷长度（= 数据区起点 - 8，也是库里说的 headerSize）
 *   [8..12)  uint32 内层 pickle 载荷长度（= 字符串长度 + 4 + 对齐填充）
 *   [12..16) uint32 **头字符串字节数**（只有这个是我们要的）
 *   [16..)   UTF-8 的 JSON 头，其后按 4 字节对齐补 \0
 * 文件数据从 `8 + 外层载荷长度` 开始，条目里的 offset 相对该起点。
 * 这里不依赖 @electron/asar（它只是 electron-builder 的传递依赖），自己读更稳。
 */
function readAsarHeader(archivePath) {
  const fd = fs.openSync(archivePath, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const pickleSize = head.readUInt32LE(4)
    const headerStringSize = head.readUInt32LE(12)
    const jsonBuf = Buffer.alloc(headerStringSize)
    fs.readSync(fd, jsonBuf, 0, headerStringSize, 16)
    const dataOffset = 8 + pickleSize + ((4 - (pickleSize % 4)) % 4)
    return { fd, header: JSON.parse(jsonBuf.toString('utf8')), dataOffset }
  } catch (err) {
    fs.closeSync(fd)
    throw err
  }
}

/** 遍历 asar 条目（跳过 unpacked / link——它们的数据不在归档数据区里） */
function walkEntries(node, prefix, visit) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const full = `${prefix}/${name}`
    if (child.files) walkEntries(child, full, visit)
    else visit(full, child)
  }
}

function cmdAsar() {
  step('asar 体检：每个 package.json 必须能解析')
  if (!fs.existsSync(ASAR)) {
    red(`缺少 ${ASAR} —— 先跑 pnpm package:win`)
    return false
  }

  const { fd, header, dataOffset } = readAsarHeader(ASAR)
  const fileSize = fs.statSync(ASAR).size
  const dataArea = fileSize - dataOffset

  let total = 0
  let declaredMax = 0
  let entryCount = 0
  const failed = []

  walkEntries(header, '', (p, entry) => {
    entryCount++
    if (entry.unpacked || entry.link || !entry.size) return
    const end = Number(entry.offset) + entry.size
    if (end > declaredMax) declaredMax = end
    if (!/package\.json$/.test(p)) return

    total++
    const buf = Buffer.alloc(entry.size)
    const read = fs.readSync(fd, buf, 0, entry.size, dataOffset + Number(entry.offset))
    const text = read === entry.size ? buf.toString('utf8') : ''
    try {
      JSON.parse(text)
    } catch {
      failed.push({ p, size: entry.size, head: text.slice(0, 60) })
    }
  })
  fs.closeSync(fd)

  console.log(`  归档 ${(fileSize / 1024 / 1024).toFixed(1)} MB，条目 ${entryCount}，package.json ${total}`)
  console.log(`  数据区 ${dataArea} 字节，条目声明合计上限 ${declaredMax} 字节`)

  let ok = true
  if (declaredMax > dataArea) {
    // 声明比实际数据区还长，说明头部与数据错位（打包竞态的症状之一）
    red(`条目声明超出数据区 ${declaredMax - dataArea} 字节——归档内部不一致`)
    ok = false
  } else {
    grn('数据区长度自洽')
  }

  if (failed.length > 0) {
    red(`package.json 解析失败 ${failed.length} / ${total}`)
    for (const f of failed.slice(0, 5)) {
      console.log(`    ${f.p} (${f.size} 字节) 头部: ${JSON.stringify(f.head)}`)
    }
    console.log('  说明：内容看起来是「别的文件的字节」时，属 electron-builder 流式写 asar 的已知缺陷')
    ok = false
  } else {
    grn(`package.json 全部可解析（${total} 个）`)
  }

  ok = checkSizeBudget(header) && ok
  return ok
}

/** asar 里允许出现的顶层目录（其余顶层项视为「不该进包」） */
const ALLOWED_ROOTS = new Set([
  'out',
  'node_modules',
  'package.json',
  // config/ 只有 9 KB：draw-config.ts 解析顺序里 `__dirname/../../config/draw-config.json`
  // 是 extraResources 那份的兜底，留着它换「extraResources 万一没打进去」时的可救性
  'config',
])

/**
 * 体积护栏：打印体积构成，并在「多了不该有的顶层目录」或「总量超阈值」时报错。
 *
 * 2026-09-21 实测过两类静默膨胀，都是「命令跑通、包变大」而没有任何报错：
 * `.mtbot/tool-results`（dev 期 agent 工具结果，250 MB）与 `release-build-*`（上一轮产物，
 * 一次 864 MB）。它们都不是代码变化带来的，靠肉眼看安装包大小发现太晚。
 */
function checkSizeBudget(header) {
  const sums = new Map()
  let total = 0
  walkEntries(header, '', (p, entry) => {
    if (entry.unpacked || entry.link || !entry.size) return
    const parts = p.split('/').filter(Boolean)
    const key = parts[0] === 'node_modules' && parts.length > 2
      ? `node_modules/${parts[1].startsWith('@') ? `${parts[1]}/${parts[2]}` : parts[1]}`
      : parts[0]
    sums.set(key, (sums.get(key) || 0) + entry.size)
    total += entry.size
  })

  const mb = (v) => (v / 1048576).toFixed(1)
  console.log(`\n  数据区合计 ${mb(total)} MB，前 8 名:`)
  const ranked = [...sums.entries()].sort((a, b) => b[1] - a[1])
  for (const [k, v] of ranked.slice(0, 8)) console.log(`    ${mb(v).padStart(7)} MB  ${k}`)

  let ok = true
  const strays = [...sums.keys()].filter((k) => !k.startsWith('node_modules/') && !ALLOWED_ROOTS.has(k))
  if (strays.length > 0) {
    red(`asar 里出现了不该进包的顶层项: ${strays.join(', ')}`)
    console.log('  这类目录（dev 产物 / 上一轮输出 / 源码）应加进 electron-builder.json 的平台段 files')
    ok = false
  }

  const OVER_BUDGET_MB = 250
  if (total > OVER_BUDGET_MB * 1048576) {
    red(`数据区 ${mb(total)} MB 超过预算 ${OVER_BUDGET_MB} MB —— 先看上面的构成，确认不是又混进了产物目录`)
    ok = false
  }
  return ok
}

// ------------------------------------------------------------ resources

/**
 * 随包独立 MCP 可执行文件：仓库构建产物 → 打包内目标。
 *
 * 两侧路径与「来源/落点」必须和 electron-builder.json 的 extraResources 段、
 * 以及运行时 `resolveBundledMcpExe()`（packaged 分支）保持一致：
 *   from: resources/wechat-mcp/dist （filter 只留 wechat-mcp.exe） → to: wechat-mcp
 */
const BUNDLED_MCP = {
  label: 'wechat-mcp.exe',
  repo: path.join(WIN_ROOT, 'resources', 'wechat-mcp', 'dist', 'wechat-mcp.exe'),
  packed: path.join(UNPACKED, 'resources', 'wechat-mcp', 'wechat-mcp.exe'),
}

/** 文件 sha256（这些产物 10 MB 级，一次性读入即可，不必流式） */
function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * 断言随包独立 MCP exe 真的进了产物，且与仓库当前构建产物逐字节一致。
 *
 * ## 存在理由
 *
 * `extraResources` 的 `from` 目录不存在时 electron-builder **不报错**，只是静默少拷一个
 * 文件——命令退出码仍是 0。2026-09-16 那份 `release/win-unpacked/resources` 就同时缺了
 * `wechat-mcp/` 与 `headless/`，肉眼要逐个目录比对才发现。
 *
 * 缺了这个 exe 的后果不是「少个可选功能」：灵栖启动时 `deployBundledExecutables()` 找不到
 * 随包源，wechat-local 会连接失败（从未部署过）或带告警沿用旧版（部署过），两者都只在
 * 用户机器上暴露。哈希比对还能顺带拦住「打包用的 exe 与当前仓库不同步」。
 */
function cmdResources() {
  step('随包资源体检：内置 MCP 可执行文件必须在产物里')

  if (!fs.existsSync(UNPACKED)) {
    red(`缺少 ${UNPACKED} —— 先跑 pnpm package:win`)
    return false
  }
  if (!fs.existsSync(BUNDLED_MCP.repo)) {
    red(`仓库构建产物缺失 ${BUNDLED_MCP.repo}`)
    console.log('  先跑 pnpm build:wechat-mcp，再重新打包')
    return false
  }
  if (!fs.existsSync(BUNDLED_MCP.packed)) {
    red(`产物缺 ${BUNDLED_MCP.packed} —— extraResources 未把它拷进去`)
    return false
  }

  const repoHash = sha256(BUNDLED_MCP.repo)
  const packedHash = sha256(BUNDLED_MCP.packed)
  const mb = (fs.statSync(BUNDLED_MCP.packed).size / 1048576).toFixed(1)

  if (repoHash === packedHash) {
    grn(`${BUNDLED_MCP.label} 已随包（${mb} MB，与仓库产物 sha256 一致）`)
    return true
  }

  red(`${BUNDLED_MCP.label} 与仓库产物不一致`)
  console.log(`    产物 ${packedHash.slice(0, 16)}…`)
  console.log(`    仓库 ${repoHash.slice(0, 16)}…`)
  console.log('  说明：打包用的 exe 与当前仓库不同步——重跑 pnpm build:wechat-mcp 后再打包')
  return false
}

// -------------------------------------------------------------- launch

/** 收尾：按 PID 杀进程树（我们用独立 user-data-dir 启的实例，不会误伤用户正在跑的） */
function killApp(pid) {
  try {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
  } catch {
    /* 进程可能已自行退出 */
  }
}

function newestLogFile(logDir) {
  if (!fs.existsSync(logDir)) return null
  const files = fs
    .readdirSync(logDir)
    // 排除 mtbot-error-*.log：它同样以 mtbot- 开头，按 mtime 可能被选中，
    // 而错误日志里没有就绪标记，会误判成「标记缺失」
    .filter((f) => f.startsWith('mtbot-') && !f.startsWith('mtbot-error-') && f.endsWith('.log'))
    .map((f) => path.join(logDir, f))
  if (files.length === 0) return null
  return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
}

async function cmdLaunch() {
  step('启动冒烟：起 win-unpacked，等就绪标记')
  if (!fs.existsSync(EXE)) {
    red(`缺少 ${EXE} —— 先跑 pnpm package:win`)
    return false
  }

  const work = path.join(os.tmpdir(), 'lumii-verify-win')
  const dataRoot = path.join(work, 'data')
  const profile = path.join(work, 'chromium-profile')
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(dataRoot, { recursive: true })

  // 独立 user-data-dir：避免与用户正在运行的实例抢单实例锁、也不动其真实 profile
  const child = spawn(EXE, [`--user-data-dir=${profile}`], {
    env: { ...process.env, LUMII_CLIENT_DATA_DIR: dataRoot },
    stdio: 'ignore',
    detached: false,
  })
  console.log(`  已启动 PID=${child.pid}，数据根 ${dataRoot}`)

  const startedAt = Date.now()
  const deadline = startedAt + 150_000
  const logDir = path.join(dataRoot, 'logs', 'app')
  let logFile = null
  let content = ''
  let ready = false

  while (Date.now() < deadline) {
    logFile = newestLogFile(logDir)
    if (logFile) {
      content = fs.readFileSync(logFile, 'utf8')
      ready = READY_MARKERS.every((m) => content.includes(m))
      if (ready) break
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  const waited = Math.round((Date.now() - startedAt) / 1000)
  let ok = true

  if (!logFile) {
    red(`150s 内未见 ${path.join(dataRoot, 'logs', 'app')} 下的日志`)
    console.log('  提示：应用若弹了标题为 Error 的对话框且不写日志，多半是 app.asar 损坏（先跑 asar 子命令）')
    ok = false
  } else {
    console.log(`  日志 ${logFile}（${(content.length / 1024).toFixed(0)} KB，等待 ${waited}s）`)
    for (const m of READY_MARKERS) {
      if (content.includes(m)) grn(`含「${m}」`)
      else {
        red(`缺「${m}」`)
        ok = false
      }
    }

    const missing = (content.match(/Cannot find module/g) ?? []).length
    if (missing === 0) grn('Cannot find module 计数 0')
    else {
      red(`Cannot find module 出现 ${missing} 次`)
      ok = false
    }

    const errors = content.split('\n').filter((l) => l.includes('[ERROR]'))
    if (errors.length > 0) {
      // 空数据根首启会有已知无害报错（如 vcs:ensureInit 的 git 模板拷贝），只回显不判失败
      ylw(`[ERROR] 行 ${errors.length} 条（供人眼过一遍，不判失败）`)
      for (const e of errors.slice(0, 5)) console.log(`    ${e.trim().slice(0, 160)}`)
    }
  }

  // 控制口存在本身就是「主进程 + 渲染进程都活着」的旁证
  const controlFile = path.join(dataRoot, 'runtime', 'app-ui.json')
  if (fs.existsSync(controlFile)) grn(`控制口已就绪: ${fs.readFileSync(controlFile, 'utf8').replace(/\s+/g, ' ')}`)
  else {
    red('未生成 runtime/app-ui.json（控制口未起来）')
    ok = false
  }

  killApp(child.pid)
  console.log('  已请求退出产物')
  return ok
}

// ---------------------------------------------------------------- main

async function main() {
  // 子命令 = 第一个既不是选项、也不是选项取值的参数
  const args = process.argv.slice(2)
  const cmd = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--release-dir') ?? 'all'
  if (!['asar', 'resources', 'launch', 'all'].includes(cmd)) {
    red(`未知子命令: ${cmd}（可选 asar | resources | launch | all）`)
    process.exit(2)
  }

  console.log('\n========================================')
  console.log('  Lumii Windows 产物验收')
  console.log(`  产物目录: ${RELEASE}`)
  console.log('========================================')

  let ok = true
  if (cmd === 'asar' || cmd === 'all') ok = cmdAsar() && ok
  if (cmd === 'resources' || cmd === 'all') ok = cmdResources() && ok
  if (cmd === 'launch' || cmd === 'all') ok = (await cmdLaunch()) && ok

  console.log('')
  if (ok) grn('验收通过')
  else red('验收未通过')
  process.exit(ok ? 0 : 1)
}

main()
