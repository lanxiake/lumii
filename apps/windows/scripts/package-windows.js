/**
 * Windows 客户端一键清理并打包脚本
 *
 * 用法:
 *   node scripts/package-windows.js [选项]
 *
 * 选项:
 *   --skip-clean    跳过清理步骤
 *   --skip-install  跳过依赖安装
 *   --arch          目标架构 (x64 | ia32 | both)，默认 x64
 *   --target        打包目标 (nsis | portable | zip | dir)，默认 nsis
 *   --help          显示帮助
 */

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

// ========== 配置 ==========

const PROJECT_ROOT = path.resolve(__dirname, '../../..')
const WINDOWS_ROOT = path.resolve(__dirname, '..')
const RELEASE_DIR = path.resolve(WINDOWS_ROOT, 'release')
const OUT_DIR = path.resolve(WINDOWS_ROOT, 'out')
const SERVER_CONFIG_PATH = path.resolve(WINDOWS_ROOT, 'config/server-config.json')
const ENV_PACK_PATH = path.resolve(WINDOWS_ROOT, 'config/.env.pack')
const DRAW_CONFIG_PATH = path.resolve(WINDOWS_ROOT, 'config/draw-config.json')
const DRAW_CONFIG_EXAMPLE_PATH = path.resolve(WINDOWS_ROOT, 'config/draw-config.example.json')
const DEFAULT_DRAW_API_BASE_URL = 'https://www.right.codes/draw'

/** 本地生产环境变量文件（与 deploy / remote-build 使用同一份） */
const PROD_ENV_FILE = path.resolve(
  PROJECT_ROOT,
  '.qoder/docs/生产环境部署信息/.env.production',
)

/** 生产环境默认值（.env.production 缺失时的兜底） */
const PROD_DEFAULTS = {
  apiUrl: 'https://www.mtbot.top',
  gatewayUrl: 'wss://www.mtbot.top/ws',
  gatewaySecret: 'mtbot-prod-gateway-internal-7f3a9c2e1b8d4f6a0e5c3b9d2f8a1e4c',
}

// 国内镜像加速
const MIRRORS = {
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
}

// ========== 工具函数 ==========

function log(msg) {
  console.log(`\n\x1b[36m[打包]\x1b[0m ${msg}`)
}

function success(msg) {
  console.log(`\x1b[32m✓\x1b[0m ${msg}`)
}

function warn(msg) {
  console.log(`\x1b[33m⚠\x1b[0m ${msg}`)
}

function error(msg) {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`)
}

function run(cmd, options = {}) {
  const cwd = options.cwd || WINDOWS_ROOT
  console.log(`  $ ${cmd}`)
  try {
    execSync(cmd, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, ...MIRRORS },
      ...options,
    })
    return true
  } catch (e) {
    if (options.allowFail) {
      warn(`命令失败（已忽略）: ${cmd}`)
      return false
    }
    throw e
  }
}

/** 同步等待（用于 Windows 文件锁释放） */
function sleep(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    /* spin */
  }
}

/**
 * 解析 .env 文件内容为键值对（忽略注释与空行，支持引号包裹的值）。
 */
function parseEnvFile(content) {
  /** @type {Record<string, string>} */
  const vars = {}
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    vars[key] = value
  }
  return vars
}

/**
 * 从 .env.production 读取生产配置（与 Gateway / API Server 部署同源）。
 *
 * 优先级：进程环境变量 > .env.production 文件 > PROD_DEFAULTS
 */
function loadProductionSettings() {
  /** @type {Record<string, string>} */
  let fileVars = {}
  if (fs.existsSync(PROD_ENV_FILE)) {
    fileVars = parseEnvFile(fs.readFileSync(PROD_ENV_FILE, 'utf-8'))
    success(`已加载生产配置: ${path.relative(PROJECT_ROOT, PROD_ENV_FILE)}`)
  } else {
    warn(`未找到 ${path.relative(PROJECT_ROOT, PROD_ENV_FILE)}，将使用环境变量或内置默认值`)
  }

  const pick = (...keys) => {
    for (const key of keys) {
      const fromEnv = process.env[key]?.trim()
      if (fromEnv) return { value: fromEnv, source: `env:${key}` }
      const fromFile = fileVars[key]?.trim()
      if (fromFile) return { value: fromFile, source: `file:${key}` }
    }
    return null
  }

  const apiPick =
    pick('MTBOT_API_URL', 'VITE_API_SERVER_URL', 'API_SERVER_PUBLIC_URL', 'API_SERVER_DOMAIN') ??
    { value: PROD_DEFAULTS.apiUrl, source: 'default' }

  const gatewayPick =
    pick('MTBOT_GATEWAY_URL', 'GATEWAY_PUBLIC_URL') ??
    { value: PROD_DEFAULTS.gatewayUrl, source: 'default' }

  const secretPick = pick(
    'API_SERVER_GATEWAY_SECRET',
    'MTBOT_GATEWAY_SECRET',
    'GATEWAY_SECRET',
  )

  const searxngPick = pick('SEARXNG_BASE_URL')
  const searxngSecretPick = pick('SEARXNG_SECRET_KEY')
  const langsearchPick = pick('LANGSEARCH_API_KEY')

  /** 裸域名 mtbot.top 无法访问 SearXNG，统一规范为 www */
  const normalizeSearxng = (url) =>
    url
      ? url
          .replace(/^http:\/\/mtbot\.top\//i, 'http://www.mtbot.top/')
          .replace(/^https:\/\/mtbot\.top\//i, 'https://www.mtbot.top/')
          .replace(/\/+$/, '')
      : ''

  return {
    apiUrl: apiPick.value.replace(/\/+$/, ''),
    gatewayUrl: gatewayPick.value,
    gatewaySecret: secretPick?.value ?? PROD_DEFAULTS.gatewaySecret,
    searxngBaseUrl: normalizeSearxng(searxngPick?.value ?? ''),
    searxngSecretKey: searxngSecretPick?.value ?? '',
    langsearchApiKey: langsearchPick?.value ?? '',
    sources: {
      apiUrl: apiPick.source,
      gatewayUrl: gatewayPick.source,
      gatewaySecret: secretPick?.source ?? 'missing',
      searxngBaseUrl: searxngPick?.source ?? 'missing',
      langsearchApiKey: langsearchPick?.source ?? 'missing',
    },
  }
}

function parseArgs() {
  const args = process.argv.slice(2)
  const config = {
    skipClean: false,
    skipInstall: false,
    skipProdCheck: false,
    arch: 'x64',
    target: 'nsis',
    outputDir: null,
    help: false,
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--skip-clean':
        config.skipClean = true
        break
      case '--skip-install':
        config.skipInstall = true
        break
      case '--skip-prod-check':
        config.skipProdCheck = true
        break
      case '--arch':
        config.arch = args[++i] || 'x64'
        break
      case '--target':
        config.target = args[++i] || 'nsis'
        break
      case '--output-dir':
        config.outputDir = args[++i] || null
        break
      case '--help':
      case '-h':
        config.help = true
        break
    }
  }
  return config
}

function showHelp() {
  console.log(`
MtBot Windows 客户端打包脚本

用法: node scripts/package-windows.js [选项]

选项:
  --skip-clean       跳过清理步骤（保留上次构建产物）
  --skip-install     跳过依赖安装
  --skip-prod-check  跳过 Draw API 配置校验（默认会检查 draw-config.json 格式）
  --arch <arch>      目标架构: x64 (默认) | ia32 | both
  --target <type> 打包目标: nsis (默认) | portable | zip | dir
  --output-dir <dir> 指定 electron-builder 输出目录（release 被占用时可改用 release-build）
  --help, -h      显示帮助

示例:
  node scripts/package-windows.js                     # 默认: 清理 + 安装 + 构建 + 打包 NSIS x64
  node scripts/package-windows.js --skip-clean        # 增量构建
  node scripts/package-windows.js --output-dir release-build  # release 被锁时使用新目录
  node scripts/package-windows.js --target portable   # 打包为便携版
  node scripts/package-windows.js --arch both         # 同时打包 x64 和 ia32

EBUSY 排查（app.asar 被占用）:
  1. 关闭 release\\win-unpacked 中运行的 MtBot Assistant
  2. 任务管理器结束 MtBotAssistant.exe / electron.exe
  3. 关闭资源管理器中 release 目录窗口
  4. 仍失败时使用 --output-dir release-build 绕过旧目录

生产配置（与 Gateway / API Server 一致）:
  自动读取 .qoder/docs/生产环境部署信息/.env.production
  含 MTBOT_API_URL、MTBOT_GATEWAY_URL、API_SERVER_GATEWAY_SECRET
  进程环境变量可覆盖文件中的值
  `)
}

/** 打包前终止可能锁定 exe / app.asar 的 MtBot / Electron 进程 */
function killLockedAppProcesses() {
  if (process.platform !== 'win32') {
    return
  }

  log('终止可能占用构建产物的进程')
  const imageNames = ['MtBotAssistant.exe', 'MtBot Assistant.exe', 'electron.exe']
  for (const name of imageNames) {
    run(`taskkill /F /IM "${name}" /T 2>nul`, { allowFail: true })
  }

  // 终止从 release/win-unpacked 目录启动的任意进程（避免 exe 名称不一致时漏杀）
  run(
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like \'*\\win-unpacked\\*\') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
    { allowFail: true },
  )

  success('进程检查完成')
}

/**
 * 删除目录并在 EBUSY/EPERM 时重试（Windows 上 app.asar 常被未退出的客户端占用）
 * @returns {boolean} 是否成功删除
 */
function removeDirWithRetry(dir, label, maxAttempts = 5) {
  if (!fs.existsSync(dir)) {
    return true
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 })
      success(`已清理 ${label}`)
      return true
    } catch (err) {
      const retriable = ['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(err.code)
      if (retriable && attempt < maxAttempts) {
        warn(`删除 ${label} 失败 (${err.code}: ${err.message})，重试 ${attempt}/${maxAttempts}...`)
        killLockedAppProcesses()
        sleep(1500)
        continue
      }
      if (retriable) {
        warn(`无法删除 ${label}（文件仍被占用）`)
        return false
      }
      throw err
    }
  }

  return false
}

/** 打印 app.asar 被占用时的排查提示（autoFallback=true 表示已自动换目录，打包会继续） */
function printEBUSYHelp(lockedPath, autoFallback = false) {
  if (autoFallback) {
    warn(`release/ 中 app.asar 仍被占用: ${lockedPath}`)
    console.log('  已自动切换输出目录，打包将继续。若需手动释放文件锁，可关闭 release 目录窗口或重启后再清理。\n')
    return
  }
  error(`文件被占用: ${lockedPath}`)
  console.log(`
请尝试以下操作后重试:
  1. 关闭从 release\\win-unpacked 启动的 MtBot Assistant
  2. 任务管理器 → 结束 MtBotAssistant.exe / electron.exe
  3. 关闭资源管理器中 release 目录窗口
  4. 使用独立输出目录绕过:
     node scripts/package-windows.js --output-dir release-build
  5. 或跳过清理:
     node scripts/package-windows.js --skip-clean --output-dir release-build
`)
}

// ========== 步骤 ==========

function stepClean(config) {
  log('步骤 1/5: 清理旧构建产物')

  killLockedAppProcesses()
  sleep(500)

  removeDirWithRetry(OUT_DIR, 'out/ 目录')

  const releaseCleaned = removeDirWithRetry(RELEASE_DIR, 'release/ 目录', 2)
  if (!releaseCleaned && !config.outputDir) {
    config.outputDir = `release-build-${Date.now()}`
    warn(`release/ 无法清理，本次打包将输出到: ${config.outputDir}/`)
    printEBUSYHelp(path.join(RELEASE_DIR, 'win-unpacked/resources/app.asar'), true)
  }

  // 清理 node_modules/.cache
  const cacheDir = path.resolve(WINDOWS_ROOT, 'node_modules/.cache')
  removeDirWithRetry(cacheDir, 'node_modules/.cache/')

  success('清理完成')
}

function stepInstall() {
  log('步骤 2/5: 安装依赖')
  run('pnpm install --frozen-lockfile', { cwd: PROJECT_ROOT })
  success('依赖安装完成')
}

function stepVerify() {
  log('步骤 3/5: 验证必要文件')

  const requiredFiles = [
    { path: 'config/server-config.json', desc: '服务器配置文件' },
    { path: 'config/draw-config.json', desc: 'Draw API 配置文件（含 drawApiKey）' },
    { path: 'assets/icon.ico', desc: '应用图标' },
    { path: 'electron-builder.json', desc: 'electron-builder 配置' },
    { path: 'build/license.txt', desc: '许可证文件' },
    { path: 'build/installer.nsh', desc: 'NSIS 安装脚本' },
  ]

  let allGood = true
  for (const file of requiredFiles) {
    const fullPath = path.resolve(WINDOWS_ROOT, file.path)
    if (fs.existsSync(fullPath)) {
      success(`${file.desc}: ${file.path}`)
    } else {
      warn(`缺少 ${file.desc}: ${file.path}`)
      allGood = false
    }
  }

  // 检查 server-config.json 内容
  const configPath = path.resolve(WINDOWS_ROOT, 'config/server-config.json')
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      console.log(`  API URL:     ${config.apiUrl}`)
      console.log(`  Gateway URL: ${config.gatewayUrl}`)
    } catch (e) {
      warn('server-config.json 格式错误')
    }
  }

  // 检查 draw-config.json 内容
  if (fs.existsSync(DRAW_CONFIG_PATH)) {
    try {
      const drawCfg = JSON.parse(fs.readFileSync(DRAW_CONFIG_PATH, 'utf-8'))
      const key = drawCfg.drawApiKey ? `${String(drawCfg.drawApiKey).slice(0, 8)}...` : '(未设置)'
      console.log(`  Draw API:    ${drawCfg.drawApiBaseUrl ?? DEFAULT_DRAW_API_BASE_URL}`)
      console.log(`  Draw Key:    ${key}`)
    } catch (e) {
      warn('draw-config.json 格式错误')
    }
  } else {
    warn(`缺少 Draw API 配置: 请复制 config/draw-config.example.json → config/draw-config.json 并填入 drawApiKey`)
  }

  if (!allGood) {
    warn('部分文件缺失，打包可能失败')
  }

  verifyVoiceNativeModule()

  success('验证完成')
}

/**
 * 校验语音 native 模块（sherpa-onnx-win-x64）的二进制是否就位。
 *
 * sherpa-onnx-node 的 native 实现位于其 optionalDependency 平台子包
 * sherpa-onnx-win-x64（含 sherpa-onnx.node 与 onnxruntime 系列 dll）。
 * 该包是否被提升到 apps/windows/node_modules 决定 electron-builder 能否打包它。
 * 缺失会导致打包后语音功能在用户机器上报「无法加载对应模块」。
 */
function verifyVoiceNativeModule() {
  const pkgDir = path.resolve(WINDOWS_ROOT, 'node_modules/sherpa-onnx-win-x64')
  const requiredBinaries = [
    'sherpa-onnx.node',
    'onnxruntime.dll',
    'sherpa-onnx-c-api.dll',
  ]

  if (!fs.existsSync(pkgDir)) {
    warn(
      '语音 native 包缺失: node_modules/sherpa-onnx-win-x64 未安装。\n' +
        '    语音对话功能打包后将无法使用。请执行 `pnpm install` 安装 optional 平台包。',
    )
    return
  }

  const missing = requiredBinaries.filter(
    (f) => !fs.existsSync(path.join(pkgDir, f)),
  )
  if (missing.length > 0) {
    warn(`语音 native 二进制缺失: ${missing.join(', ')}（语音功能可能不可用）`)
  } else {
    success(`语音 native 模块就位: sherpa-onnx-win-x64 (${requiredBinaries.length} 个二进制)`)
  }
}

/**
 * 校验 Draw API 配置（仅读 draw-config.json，不发起生图 HTTP 请求）。
 *
 * 生图接口一次请求常需 30–60s，打包阶段不适合做连通性探测；
 * Key 正确时反而会因服务端开始出图而长时间无响应，易被误判为失败。
 */
function verifyDrawConfig(drawConfig) {
  const baseUrl = (drawConfig.drawApiBaseUrl || DEFAULT_DRAW_API_BASE_URL).trim()
  const apiKey = drawConfig.drawApiKey?.trim()

  if (!apiKey) {
    throw new Error('draw-config.json 缺少 drawApiKey')
  }
  if (!apiKey.startsWith('sk-')) {
    warn(`drawApiKey 格式非常规（期望 sk- 开头）: ${apiKey.slice(0, 8)}...`)
  }
  try {
    const parsed = new URL(baseUrl)
    if (parsed.protocol !== 'https:') {
      warn(`drawApiBaseUrl 建议使用 HTTPS: ${baseUrl}`)
    }
  } catch {
    throw new Error(`drawApiBaseUrl 不是合法 URL: ${baseUrl}`)
  }

  success(`Draw API 配置有效: ${baseUrl} (key=${apiKey.slice(0, 8)}...)`)
}

/** 读取 draw-config.json，缺失时从 example + 环境变量生成 */
function ensureDrawConfigForPackaging() {
  if (fs.existsSync(DRAW_CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(DRAW_CONFIG_PATH, 'utf-8'))
  }

  const apiKey = process.env.MTBOT_DRAW_API_KEY?.trim()
  if (!apiKey) {
    throw new Error(
      '缺少 config/draw-config.json，且未设置 MTBOT_DRAW_API_KEY。' +
        '请复制 config/draw-config.example.json 并填入 drawApiKey。',
    )
  }

  const generated = {
    drawApiBaseUrl: process.env.MTBOT_DRAW_API_BASE_URL?.trim() || DEFAULT_DRAW_API_BASE_URL,
    drawApiKey: apiKey,
  }
  fs.writeFileSync(DRAW_CONFIG_PATH, JSON.stringify(generated, null, 2), 'utf-8')
  success('已从 MTBOT_DRAW_API_KEY 生成 draw-config.json')
  return generated
}

/** 将生产用 .env 写入 config/.env.pack，供 electron-builder 打入 resources/.env */
function switchToProdEnv(prodSettings) {
  log('写入生产环境 .env（Analytics / 搜索引擎等）')

  let original = null
  if (fs.existsSync(ENV_PACK_PATH)) {
    original = fs.readFileSync(ENV_PACK_PATH, 'utf-8')
  }

  const secret = prodSettings.gatewaySecret?.trim()
  if (!secret) {
    throw new Error(
      '打包生产客户端缺少 API_SERVER_GATEWAY_SECRET。\n' +
        `  请在 ${path.relative(PROJECT_ROOT, PROD_ENV_FILE)} 中配置，\n` +
        '  或设置环境变量 API_SERVER_GATEWAY_SECRET（需与生产 api-server 一致）。',
    )
  }

  const lines = [
    '# MtBot Windows 客户端生产环境变量（打包时自动生成，勿提交仓库）',
    `# 来源: ${prodSettings.sources.gatewaySecret}`,
    `API_SERVER_GATEWAY_SECRET=${JSON.stringify(secret)}`,
  ]

  if (prodSettings.searxngBaseUrl) {
    lines.push(`SEARXNG_BASE_URL=${JSON.stringify(prodSettings.searxngBaseUrl)}`)
  }
  if (prodSettings.searxngSecretKey) {
    lines.push(`SEARXNG_SECRET_KEY=${JSON.stringify(prodSettings.searxngSecretKey)}`)
  }
  if (prodSettings.langsearchApiKey) {
    lines.push(`LANGSEARCH_API_KEY=${JSON.stringify(prodSettings.langsearchApiKey)}`)
  }

  fs.writeFileSync(ENV_PACK_PATH, lines.join('\n') + '\n', 'utf-8')
  success(
    `生产 .env 已写入 config/.env.pack (gatewaySecret len=${secret.length}, searxng=${prodSettings.searxngBaseUrl || '未配置'})`,
  )

  return original
}

/** 恢复 config/.env.pack */
function restoreEnvPack(original) {
  if (original !== null) {
    fs.writeFileSync(ENV_PACK_PATH, original, 'utf-8')
    success('已恢复 config/.env.pack')
  } else if (fs.existsSync(ENV_PACK_PATH)) {
    fs.unlinkSync(ENV_PACK_PATH)
    success('已删除临时 config/.env.pack')
  }
}

/** 将 server-config.json 切换为生产环境地址，返回原始内容用于恢复 */
function switchToProdConfig(prodSettings) {
  log('切换为生产环境配置')

  let original = null
  if (fs.existsSync(SERVER_CONFIG_PATH)) {
    original = fs.readFileSync(SERVER_CONFIG_PATH, 'utf-8')
  }

  const prodConfig = {
    apiUrl: prodSettings.apiUrl,
    gatewayUrl: prodSettings.gatewayUrl,
  }
  fs.writeFileSync(SERVER_CONFIG_PATH, JSON.stringify(prodConfig, null, 2), 'utf-8')
  success(`API URL:     ${prodConfig.apiUrl} (${prodSettings.sources.apiUrl})`)
  success(`Gateway URL: ${prodConfig.gatewayUrl} (${prodSettings.sources.gatewayUrl})`)

  return original
}

/** 恢复 server-config.json 为原始内容 */
function restoreConfig(original) {
  if (original !== null) {
    fs.writeFileSync(SERVER_CONFIG_PATH, original, 'utf-8')
    success('已恢复开发环境配置')
  }
}

function stepBuild() {
  log('步骤 4/5: 构建项目 (electron-vite build)')
  run('npx electron-vite build')
  success('构建完成')
}

function stepPackage(config) {
  log('步骤 5/5: 打包安装程序')

  const outputDir = config.outputDir || 'release'
  const outputPath = path.resolve(WINDOWS_ROOT, outputDir)
  const archList = config.arch === 'both' ? ['x64', 'ia32'] : [config.arch]

  for (const arch of archList) {
    log(`打包 ${config.target} (${arch}) → ${outputDir}/...`)
    run(
      `npx electron-builder --win ${config.target} --${arch} --config electron-builder.json --config.directories.output=${outputDir}`,
    )
  }

  // 列出产物
  log('打包产物:')
  if (fs.existsSync(outputPath)) {
    const files = fs.readdirSync(outputPath).filter(f => {
      const ext = path.extname(f).toLowerCase()
      return ['.exe', '.zip', '.7z'].includes(ext)
    })

    if (files.length === 0) {
      warn('未发现安装包文件')
    } else {
      for (const file of files) {
        const filePath = path.resolve(outputPath, file)
        const stat = fs.statSync(filePath)
        const sizeMB = (stat.size / 1024 / 1024).toFixed(1)
        success(`${file} (${sizeMB} MB)`)
      }
    }
  }

  success('打包完成')
}

// ========== 主流程 ==========

async function main() {
  const config = parseArgs()

  if (config.help) {
    showHelp()
    process.exit(0)
  }

  console.log('\n========================================')
  console.log('  MtBot Windows 客户端打包工具')
  console.log('========================================')
  console.log(`  架构: ${config.arch}`)
  console.log(`  目标: ${config.target}`)
  console.log(`  清理: ${config.skipClean ? '跳过' : '是'}`)
  console.log(`  输出: ${config.outputDir || 'release'}`)
  console.log(`  安装: ${config.skipInstall ? '跳过' : '是'}`)
  console.log('========================================\n')

  const startTime = Date.now()

  try {
    if (!config.skipClean) {
      stepClean(config)
    } else if (!config.outputDir && fs.existsSync(RELEASE_DIR)) {
      // skip-clean 时检测 release 是否可写，不可写则自动换目录
      const asarPath = path.join(RELEASE_DIR, 'win-unpacked/resources/app.asar')
      if (fs.existsSync(asarPath)) {
        try {
          const fd = fs.openSync(asarPath, 'r+')
          fs.closeSync(fd)
        } catch {
          config.outputDir = `release-build-${Date.now()}`
          warn(`release/ 中 app.asar 被占用，自动改用输出目录: ${config.outputDir}/`)
        }
      }
    }

    if (!config.skipInstall) {
      stepInstall()
    }

    stepVerify()

    killLockedAppProcesses()

    const prodSettings = loadProductionSettings()
    const originalConfig = switchToProdConfig(prodSettings)
    const originalEnvPack = switchToProdEnv(prodSettings)
    try {
      if (!config.skipProdCheck) {
        const drawCfg = ensureDrawConfigForPackaging()
        log('校验 Draw API 配置（不发起生图请求）')
        verifyDrawConfig(drawCfg)
      } else {
        warn('已跳过 Draw API 配置校验 (--skip-prod-check)')
        ensureDrawConfigForPackaging()
      }
      stepBuild()
      stepPackage(config)
    } finally {
      restoreEnvPack(originalEnvPack)
      restoreConfig(originalConfig)
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log('\n========================================')
    success(`全部完成! 耗时 ${elapsed}s`)
    console.log(`  输出目录: ${RELEASE_DIR}`)
    console.log('========================================\n')
  } catch (e) {
    error(`打包失败: ${e.message}`)
    process.exit(1)
  }
}

main()
