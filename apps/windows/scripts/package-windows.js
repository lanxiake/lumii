/**
 * Windows 客户端一键清理并打包脚本（本地优先 / 离线独立版）
 *
 * 用法:
 *   node scripts/package-windows.js [选项]
 *
 * 选项:
 *   --skip-clean       跳过清理步骤
 *   --skip-install     跳过依赖安装
 *   --skip-draw-check  跳过 Draw API 配置校验
 *   --arch             目标架构 (x64 | ia32 | both)，默认 x64
 *   --target           打包目标 (nsis | portable | zip | dir)，默认 nsis
 *   --output-dir       指定输出目录
 *   --help             显示帮助
 */

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

// ========== 配置 ==========

const PROJECT_ROOT = path.resolve(__dirname, '../../..')
const WINDOWS_ROOT = path.resolve(__dirname, '..')
const RELEASE_DIR = path.resolve(WINDOWS_ROOT, 'release')
const OUT_DIR = path.resolve(WINDOWS_ROOT, 'out')
const DRAW_CONFIG_PATH = path.resolve(WINDOWS_ROOT, 'config/draw-config.json')
const DRAW_CONFIG_EXAMPLE_PATH = path.resolve(WINDOWS_ROOT, 'config/draw-config.example.json')
const DEFAULT_DRAW_API_BASE_URL = 'https://www.right.codes/draw'

/** 国内镜像加速 */
const MIRRORS = {
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
}

// ========== 工具函数 ==========

/** 打印普通日志 */
function log(msg) {
  console.log(`\n\x1b[36m[打包]\x1b[0m ${msg}`)
}

/** 打印成功日志 */
function success(msg) {
  console.log(`\x1b[32m✓\x1b[0m ${msg}`)
}

/** 打印警告日志 */
function warn(msg) {
  console.log(`\x1b[33m⚠\x1b[0m ${msg}`)
}

/** 打印错误日志 */
function error(msg) {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`)
}

/**
 * 在指定目录执行命令（注入国内镜像环境变量）。
 * @returns {boolean} 成功时 true；allowFail 时失败返回 false
 */
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

/** 解析 CLI 参数 */
function parseArgs() {
  const args = process.argv.slice(2)
  const config = {
    skipClean: false,
    skipInstall: false,
    skipDrawCheck: false,
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
      case '--skip-draw-check':
      case '--skip-prod-check': // 兼容旧参数名
        config.skipDrawCheck = true
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

/** 打印帮助信息 */
function showHelp() {
  console.log(`
Lumii Windows 客户端打包脚本（本地优先，不注入网关 / API Server）

用法: node scripts/package-windows.js [选项]

选项:
  --skip-clean        跳过清理步骤（保留上次构建产物）
  --skip-install      跳过依赖安装
  --skip-draw-check   跳过 Draw API 配置校验
  --arch <arch>       目标架构: x64 (默认) | ia32 | both
  --target <type>     打包目标: nsis (默认) | portable | zip | dir
  --output-dir <dir>  指定 electron-builder 输出目录
  --help, -h          显示帮助

示例:
  node scripts/package-windows.js
  node scripts/package-windows.js --skip-clean
  node scripts/package-windows.js --target portable
  node scripts/package-windows.js --arch both
  node scripts/package-windows.js --output-dir release-build

EBUSY 排查（app.asar 被占用）:
  1. 关闭 release\\\\win-unpacked 中运行的 Lumii
  2. 任务管理器结束 Lumii.exe / electron.exe
  3. 关闭资源管理器中 release 目录窗口
  4. 仍失败时使用 --output-dir release-build 绕过旧目录
`)
}

/** 打包前终止可能锁定 exe / app.asar 的进程 */
function killLockedAppProcesses() {
  if (process.platform !== 'win32') {
    return
  }

  log('终止可能占用构建产物的进程')
  const imageNames = [
    'Lumii.exe',
    'MtBotAssistant.exe',
    'MtBot Assistant.exe',
    'electron.exe',
  ]
  for (const name of imageNames) {
    run(`taskkill /F /IM "${name}" /T 2>nul`, { allowFail: true })
  }

  run(
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like \'*\\win-unpacked\\*\') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
    { allowFail: true },
  )

  success('进程检查完成')
}

/**
 * 删除目录并在 EBUSY/EPERM 时重试。
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

/** 打印 app.asar 被占用时的排查提示 */
function printEBUSYHelp(lockedPath, autoFallback = false) {
  if (autoFallback) {
    warn(`release/ 中 app.asar 仍被占用: ${lockedPath}`)
    console.log('  已自动切换输出目录，打包将继续。\n')
    return
  }
  error(`文件被占用: ${lockedPath}`)
  console.log(`
请尝试以下操作后重试:
  1. 关闭从 release\\\\win-unpacked 启动的 Lumii
  2. 任务管理器 → 结束 Lumii.exe / electron.exe
  3. 关闭资源管理器中 release 目录窗口
  4. node scripts/package-windows.js --output-dir release-build
`)
}

// ========== 步骤 ==========

/** 清理旧构建产物 */
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

  const cacheDir = path.resolve(WINDOWS_ROOT, 'node_modules/.cache')
  removeDirWithRetry(cacheDir, 'node_modules/.cache/')

  success('清理完成')
}

/** 安装 workspace 依赖 */
function stepInstall() {
  log('步骤 2/5: 安装依赖')
  run('pnpm install --frozen-lockfile', { cwd: PROJECT_ROOT })
  success('依赖安装完成')
}

/** 验证打包所需文件（不校验网关 / 生产环境变量） */
function stepVerify() {
  log('步骤 3/5: 验证必要文件')

  const requiredFiles = [
    { path: 'config/server-config.json', desc: '本地占位配置（离线独立版）' },
    { path: 'assets/icon.ico', desc: '应用图标' },
    { path: 'electron-builder.json', desc: 'electron-builder 配置' },
    { path: 'build-resources/license.txt', desc: '许可证文件' },
    { path: 'build-resources/installer.nsh', desc: 'NSIS 安装脚本' },
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

  const configPath = path.resolve(WINDOWS_ROOT, 'config/server-config.json')
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      console.log(`  apiUrl:     ${config.apiUrl} (本地占位，离线不连接)`)
      console.log(`  gatewayUrl: ${config.gatewayUrl} (本地占位，离线不连接)`)
    } catch {
      warn('server-config.json 格式错误')
    }
  }

  if (fs.existsSync(DRAW_CONFIG_PATH)) {
    try {
      const drawCfg = JSON.parse(fs.readFileSync(DRAW_CONFIG_PATH, 'utf-8'))
      const key = drawCfg.drawApiKey ? `${String(drawCfg.drawApiKey).slice(0, 8)}...` : '(未设置)'
      console.log(`  Draw API:    ${drawCfg.drawApiBaseUrl ?? DEFAULT_DRAW_API_BASE_URL}`)
      console.log(`  Draw Key:    ${key}`)
    } catch {
      warn('draw-config.json 格式错误')
    }
  } else {
    warn(
      `缺少 Draw API 配置: 可复制 ${path.relative(WINDOWS_ROOT, DRAW_CONFIG_EXAMPLE_PATH)} → config/draw-config.json`,
    )
  }

  if (!allGood) {
    warn('部分文件缺失，打包可能失败')
  }

  verifyVoiceNativeModule()
  success('验证完成')
}

/**
 * 校验语音 native 模块（sherpa-onnx-win-x64）二进制是否就位。
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

  const missing = requiredBinaries.filter((f) => !fs.existsSync(path.join(pkgDir, f)))
  if (missing.length > 0) {
    warn(`语音 native 二进制缺失: ${missing.join(', ')}（语音功能可能不可用）`)
  } else {
    success(`语音 native 模块就位: sherpa-onnx-win-x64 (${requiredBinaries.length} 个二进制)`)
  }
}

/**
 * 校验 Draw API 配置（仅读本地文件，不发起 HTTP）。
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

/** 读取 draw-config.json；缺失时从环境变量生成（可选能力，非网关依赖） */
function ensureDrawConfigForPackaging() {
  if (fs.existsSync(DRAW_CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(DRAW_CONFIG_PATH, 'utf-8'))
  }

  const apiKey = process.env.MTBOT_DRAW_API_KEY?.trim() || process.env.LUMII_DRAW_API_KEY?.trim()
  if (!apiKey) {
    throw new Error(
      '缺少 config/draw-config.json，且未设置 LUMII_DRAW_API_KEY / MTBOT_DRAW_API_KEY。' +
        '请复制 config/draw-config.example.json 并填入 drawApiKey，或使用 --skip-draw-check。',
    )
  }

  const generated = {
    drawApiBaseUrl:
      process.env.MTBOT_DRAW_API_BASE_URL?.trim() ||
      process.env.LUMII_DRAW_API_BASE_URL?.trim() ||
      DEFAULT_DRAW_API_BASE_URL,
    drawApiKey: apiKey,
  }
  fs.writeFileSync(DRAW_CONFIG_PATH, JSON.stringify(generated, null, 2), 'utf-8')
  success('已从环境变量生成 draw-config.json')
  return generated
}

/** electron-vite 生产构建 */
function stepBuild() {
  log('步骤 4/5: 构建项目 (electron-vite build)')
  run('npx electron-vite build')
  success('构建完成')
}

/** 调用 electron-builder 打包 */
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

  log('打包产物:')
  if (fs.existsSync(outputPath)) {
    const files = fs.readdirSync(outputPath).filter((f) => {
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

/** 打包主入口 */
async function main() {
  const config = parseArgs()

  if (config.help) {
    showHelp()
    process.exit(0)
  }

  console.log('\n========================================')
  console.log('  Lumii Windows 客户端打包工具')
  console.log('  （本地优先 · 不注入网关 / API Server）')
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

    if (!config.skipDrawCheck) {
      const drawCfg = ensureDrawConfigForPackaging()
      log('校验 Draw API 配置（不发起生图请求）')
      verifyDrawConfig(drawCfg)
    } else {
      warn('已跳过 Draw API 配置校验 (--skip-draw-check)')
      if (fs.existsSync(DRAW_CONFIG_PATH) || fs.existsSync(DRAW_CONFIG_EXAMPLE_PATH)) {
        try {
          ensureDrawConfigForPackaging()
        } catch {
          warn('draw-config.json 未生成，extraResources 可能跳过该文件')
        }
      }
    }

    stepBuild()
    stepPackage(config)

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    const finalOut = path.resolve(WINDOWS_ROOT, config.outputDir || 'release')
    console.log('\n========================================')
    success(`全部完成! 耗时 ${elapsed}s`)
    console.log(`  输出目录: ${finalOut}`)
    console.log('========================================\n')
  } catch (e) {
    error(`打包失败: ${e.message}`)
    process.exit(1)
  }
}

main()
