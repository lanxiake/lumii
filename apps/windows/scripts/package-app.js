/**
 * Lumii 客户端一键清理并打包脚本（本地优先 / 离线独立版）
 *
 * 支持 Windows 与 Linux 两条产物线，由 --platform 选择（默认按宿主平台）。
 *
 * 用法:
 *   node scripts/package-app.js [选项]
 *
 * 选项:
 *   --platform         目标平台 (win | linux)，默认按 process.platform
 *   --skip-clean       跳过清理步骤
 *   --skip-install     跳过依赖安装
 *   --skip-draw-check  跳过 Draw API 配置校验
 *   --arch             目标架构 (x64 | ia32 | both)，默认 x64
 *   --target           打包目标：
 *                        win   → nsis | portable | zip | dir
 *                        linux → appimage | deb | both | dir
 *                     默认 win=nsis / linux=appimage
 *                     （linux 的 both = 一轮构建同时产出 AppImage + deb）
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

/** 各平台的目标与默认值 */
const PLATFORM_PROFILES = {
  win: {
    label: 'Windows',
    targets: ['nsis', 'portable', 'zip', 'dir'],
    defaultTarget: 'nsis',
    defaultArch: 'x64',
    // electron-builder 的 --<platform> 取值
    builderFlag: '--win',
    /** 解包目录名，用于定位 app.asar 等（electron-builder 约定） */
    unpackedDir: 'win-unpacked',
    artifactExts: ['.exe', '.zip', '.7z'],
    /** 打包前需要终止的进程（Windows 文件占用） */
    killProcesses: true,
  },
  linux: {
    label: 'Linux',
    // `both` = 一轮构建同时产出 AppImage + deb（设计 §9 的验收要求）。
    // 只给 Linux：Windows 侧没有对应的「一次出多个安装包」需求，加了是多余分支。
    targets: ['appimage', 'deb', 'both', 'dir'],
    defaultTarget: 'appimage',
    defaultArch: 'x64',
    builderFlag: '--linux',
    unpackedDir: 'linux-unpacked',
    artifactExts: ['.appimage', '.deb'],
    // Linux 可直接删除被占用的目录，不需要先杀进程
    killProcesses: false,
  },
}

/** 国内镜像加速 */
const MIRRORS = {
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
}

/** 解析 --platform，默认按宿主平台 */
function resolvePlatform(explicit) {
  const key = (explicit ?? (process.platform === 'win32' ? 'win' : 'linux')).toLowerCase()
  if (!PLATFORM_PROFILES[key]) {
    throw new Error(`不支持的平台: ${explicit}（可选: ${Object.keys(PLATFORM_PROFILES).join(' | ')}）`)
  }
  return key
}

/**
 * 把 `package-app.js` 的 target 名翻译成 electron-builder 的参数。
 *
 * `both` 是本脚本的伪 target，对应 electron-builder 的多目标语法
 * （即 --linux 后面跟空格分隔的 appimage 与 deb 两个值）。
 * 它存在的理由：设计 §9 要求「一次性产出 .AppImage 与 .deb」。分两次跑
 * 不只是麻烦——每次都会跑一遍完整的 `electron-vite build` 与 asar 打包
 * （单次约 130s，asar 332MB），等于把最贵的步骤做两遍。
 *
 * 只对 Linux 开放（见 PLATFORM_PROFILES.linux.targets）。
 */
function builderTarget(target) {
  return target === 'both' ? 'appimage deb' : target
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
 * @returns {boolean} 成功时 true；allowFail 时失败返回 false；returnError 时返回 {error, cmd}
 */
function run(cmd, options = {}) {
  const cwd = options.cwd || WINDOWS_ROOT
  console.log(`  $ ${cmd}`)
  try {
    execSync(cmd, {
      cwd,
      stdio: options.returnError ? 'pipe' : 'inherit',
      env: { ...process.env, ...MIRRORS },
      ...options,
    })
    return true
  } catch (e) {
    if (options.allowFail) {
      warn(`命令失败（已忽略）: ${cmd}`)
      return false
    }
    if (options.returnError) {
      return { error: e, cmd }
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
    platform: null,
    arch: null,
    target: null,
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
      case '--platform':
        config.platform = args[++i] || null
        break
      case '--arch':
        config.arch = args[++i] || null
        break
      case '--target':
        config.target = args[++i] || null
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

  // 平台相关的默认值在解析后补齐，保证 --platform linux 能拿到 linux 的默认 target
  const platformKey = resolvePlatform(config.platform)
  const profile = PLATFORM_PROFILES[platformKey]
  config.platformKey = platformKey
  config.profile = profile
  config.arch = config.arch || profile.defaultArch
  config.target = config.target || profile.defaultTarget

  if (!profile.targets.includes(config.target)) {
    throw new Error(
      `${profile.label} 不支持的 target: ${config.target}（可选: ${profile.targets.join(' | ')}）`,
    )
  }
  if (config.arch === 'both' && platformKey === 'linux') {
    throw new Error('Linux 产物本期只支持单架构（x64），不支持 --arch both')
  }

  return config
}

/** 打印帮助信息 */
function showHelp() {
  console.log(`
Lumii 客户端打包脚本（本地优先，不注入网关 / API Server）

用法: node scripts/package-app.js [选项]

选项:
  --platform <p>      目标平台: win | linux（默认按宿主平台）
  --skip-clean        跳过清理步骤（保留上次构建产物）
  --skip-install      跳过依赖安装
  --skip-draw-check   跳过 Draw API 配置校验
  --arch <arch>       目标架构: x64 (默认) | ia32 | both（both 仅 win）
  --target <type>     打包目标:
                        win   → nsis (默认) | portable | zip | dir
                        linux → appimage (默认) | deb | both | dir
                                both = 一轮构建同时产出 AppImage + deb
  --output-dir <dir>  指定 electron-builder 输出目录
  --help, -h          显示帮助

示例:
  node scripts/package-app.js --platform linux
  node scripts/package-app.js --platform linux --target deb
  node scripts/package-app.js --platform linux --target both
  node scripts/package-app.js --platform win --target nsis --arch both
  node scripts/package-app.js --skip-clean
  node scripts/package-app.js --output-dir release-build

EBUSY 排查（Windows，app.asar 被占用）:
  1. 关闭 release\\\\win-unpacked 中运行的 Lumii
  2. 任务管理器结束 Lumii.exe / electron.exe
  3. 关闭资源管理器中 release 目录窗口
  4. 仍失败时使用 --output-dir release-build 绕过旧目录

Linux 说明:
  - 产物为 AppImage 与 deb：--target both 一轮出齐（设计 §9 的验收方式），
    或 --target appimage / --target deb 单出，--target dir 只解包不打包
  - AppImage 与 deb 必须**在 Linux 上构建**：原生模块（better-sqlite3 等）不能在
    Windows 上交叉编译，electron-builder 也不支持跨平台产出 Linux 原生依赖
  - 构建需 Node 22（见仓库 Linux 构建说明）
`)
}

/**
 * 打包前终止可能锁定产物的进程。
 *
 * Windows：exe / app.asar 会被运行中的应用与 electron.exe 占用，必须先杀。
 * Linux：运行中的应用同样会占用 app.asar（进程映射了文件），但删除目录时
 * 内核允许 unlink 已打开的文件，不需要预先杀进程；这里只在**明确知道**有
 * 同目录产物在运行时给出提示，避免用户困惑于「改了代码但产物没变」。
 */
function killLockedAppProcesses(config) {
  const profile = config?.profile ?? PLATFORM_PROFILES[process.platform === 'win32' ? 'win' : 'linux']

  if (!profile.killProcesses) {
    warnProcessesHoldingArtifacts()
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
 * Linux：提示可能仍在运行的解包产物（不自动杀，避免误杀用户手动启动的实例）。
 * @returns {boolean} 是否存在疑似在运行的产物
 */
function warnProcessesHoldingArtifacts() {
  const unpackedPath = path.join(RELEASE_DIR, 'linux-unpacked')
  if (!fs.existsSync(unpackedPath)) return false

  let running = false
  try {
    // pgrep 在多数发行版的基础包中；缺失时静默跳过，不影响打包
    const out = execSync(`pgrep -af "${unpackedPath}" 2>/dev/null || true`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    running = out.trim().length > 0
  } catch {
    return false
  }

  if (running) {
    warn('检测到 release/linux-unpacked 中的产物正在运行；Linux 下删除目录不受影响，')
    warn('但若要验证新产物，请先退出该实例，否则看到的仍是旧版本。')
  }
  return running
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
  1. 关闭从 release/unpacked 目录启动的 Lumii
  2. Windows: 任务管理器 → 结束 Lumii.exe / electron.exe
     Linux:   pkill -f "release/linux-unpacked"
  3. 关闭资源管理器中 release 目录窗口
  4. node scripts/package-app.js --output-dir release-build
`)
}

// ========== 步骤 ==========

/** 清理旧构建产物 */
function stepClean(config) {
  log('步骤 1/5: 清理旧构建产物')

  killLockedAppProcesses(config)
  sleep(500)

  removeDirWithRetry(OUT_DIR, 'out/ 目录')

  const releaseCleaned = removeDirWithRetry(RELEASE_DIR, 'release/ 目录', 2)
  if (!releaseCleaned && !config.outputDir) {
    config.outputDir = `release-build-${Date.now()}`
    warn(`release/ 无法清理，本次打包将输出到: ${config.outputDir}/`)
    printEBUSYHelp(
      path.join(RELEASE_DIR, config.profile.unpackedDir, 'resources/app.asar'),
      true,
    )
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
function stepVerify(config) {
  log('步骤 3/5: 验证必要文件')

  // 图标与安装脚本按平台区分：win 需要 .ico + NSIS 脚本，linux 需要 ≥512 的 PNG
  const requiredFiles =
    config.platformKey === 'linux'
      ? [
          { path: 'assets/icon-512.png', desc: '应用图标（Linux 需 ≥512px PNG）' },
          { path: 'electron-builder.json', desc: 'electron-builder 配置' },
          { path: 'build-resources/license.txt', desc: '许可证文件' },
          { path: 'build-resources/after-pack.js', desc: 'afterPack 钩子（chrome-sandbox 权限）' },
          { path: 'build-resources/deb-postinst.sh', desc: 'deb 安装后脚本' },
        ]
      : [
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

  verifyVoiceNativeModule(config)
  success('验证完成')
}

/**
 * 校验语音 native 模块二进制是否就位。
 *
 * win：sherpa-onnx-win-x64；linux：sherpa-onnx-linux-x64。
 * 两者都由 loader 按 `${platform}-${arch}` 命名约定查找（见 sherpa-onnx-node/addon.js），
 * 缺失时语音功能会在运行时才失败，故提前在打包阶段拦下。
 */
function verifyVoiceNativeModule(config) {
  const isLinux = config.platformKey === 'linux'
  const pkgName = isLinux ? 'sherpa-onnx-linux-x64' : 'sherpa-onnx-win-x64'
  const pkgDir = path.resolve(WINDOWS_ROOT, 'node_modules', pkgName)
  const requiredBinaries = isLinux
    ? ['sherpa-onnx.node', 'libonnxruntime.so', 'libsherpa-onnx-c-api.so']
    : ['sherpa-onnx.node', 'onnxruntime.dll', 'sherpa-onnx-c-api.dll']

  if (!fs.existsSync(pkgDir)) {
    warn(
      `语音 native 包缺失: node_modules/${pkgName} 未安装。\n` +
        '    语音对话功能打包后将无法使用。请执行 `pnpm install` 安装 optional 平台包。',
    )
    return
  }

  const missing = requiredBinaries.filter((f) => !fs.existsSync(path.join(pkgDir, f)))
  if (missing.length > 0) {
    warn(`语音 native 二进制缺失: ${missing.join(', ')}（语音功能可能不可用）`)
  } else {
    success(`语音 native 模块就位: ${pkgName} (${requiredBinaries.length} 个二进制)`)
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
  log('从 assets/icon.png 生成 icon.ico + icon-512.png（win / linux 图标）')
  run('node scripts/generate-icon.cjs')
  run('npx electron-vite build')
  success('构建完成')
}

/** 调用 electron-builder 打包 */
function stepPackage(config) {
  log('步骤 5/5: 打包安装程序')

  const { profile } = config
  const outputDir = config.outputDir || 'release'
  const outputPath = path.resolve(WINDOWS_ROOT, outputDir)
  const archList = config.arch === 'both' ? ['x64', 'ia32'] : [config.arch]
  // Windows 的 EPERM-rename 重试是为 QQ 电脑管家扫盘准备的，Linux 无此问题
  const maxRetries = profile.killProcesses ? 5 : 1

  for (const arch of archList) {
    log(`打包 ${config.target} (${arch}) → ${outputDir}/...`)

    let retries = maxRetries
    let success = false

    while (retries > 0 && !success) {
      const result = run(
        `npx electron-builder ${profile.builderFlag} ${builderTarget(config.target)} --${arch} --config electron-builder.json --config.directories.output=${outputDir}`,
        { returnError: true }
      )

      if (result === true) {
        success = true
        break
      }

      const err = result.error
      const stderr = err.stderr?.toString() || ''
      const stdout = err.stdout?.toString() || ''
      const message = err.message || ''
      const fullOutput = stderr + stdout + message

      // 检查是否是 rename 权限错误（Windows 专属：安全软件扫盘）
      if (
        fullOutput.includes('EPERM') &&
        fullOutput.includes('rename') &&
        fullOutput.includes(profile.unpackedDir)
      ) {
        retries--
        if (retries > 0) {
          warn(`rename 被阻止（可能是 QQ 电脑管家正在扫描），等待 10 秒后重试... (剩余 ${retries} 次)`)
          sleep(10000)

          // 清理失败的 tmp 目录
          const tmpPath = path.join(outputPath, `${profile.unpackedDir}.tmp`)
          if (fs.existsSync(tmpPath)) {
            try {
              fs.rmSync(tmpPath, { recursive: true, force: true })
            } catch (e) {
              warn(`清理 tmp 目录失败: ${e.message}`)
            }
          }
        } else {
          error('重试次数用尽，打包失败')
          console.log('\n建议解决方案:')
          console.log('  1. 【推荐】将项目目录添加到 QQ 电脑管家的信任区')
          console.log('     打开 QQ 电脑管家 → 病毒查杀 → 信任区 → 添加目录')
          console.log('  2. 临时退出 QQ 电脑管家，打包完成后再启动')
          console.log('  3. 使用 --output-dir 指定其他输出目录\n')
          throw err
        }
      } else {
        throw err
      }
    }
  }

  log('打包产物:')
  if (fs.existsSync(outputPath)) {
    // 按本次 --target 过滤，而不是把该平台所有扩展名都列出来——
    // 否则 `--target deb` 会把上个 AppImage 也列上，看起来像两者都产出了。
    // `both` 例外：它本来就要两者都列。
    const wantExt =
      config.target === 'both'
        ? profile.artifactExts
        : config.target === 'dir'
          ? []
          : [`.${config.target.replace(/^appimage$/, 'AppImage').toLowerCase()}`]
    const files = fs.readdirSync(outputPath).filter((f) => {
      const ext = path.extname(f).toLowerCase()
      if (!profile.artifactExts.includes(ext)) return false
      return wantExt.length === 0 ? false : wantExt.includes(ext)
    })

    if (files.length === 0) {
      if (config.target === 'dir') {
        log(`--target dir 只产出解包目录，不生成安装包（${profile.unpackedDir}/）`)
      } else if (config.target === 'both') {
        warn(`未发现 any 产物（查找扩展名: ${profile.artifactExts.join(' / ')}）`)
      } else {
        warn(`未发现 ${config.target} 产物（查找扩展名: ${profile.artifactExts.join(' / ')}）`)
      }
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

  const { profile } = config
  console.log('\n========================================')
  console.log(`  Lumii ${profile.label} 客户端打包工具`)
  console.log('  （本地优先 · 不注入网关 / API Server）')
  console.log('========================================')
  console.log(`  平台: ${config.platformKey}`)
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
      const asarPath = path.join(RELEASE_DIR, profile.unpackedDir, 'resources/app.asar')
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

    stepVerify(config)
    killLockedAppProcesses(config)

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
    // execSync 失败时元凶几乎总在 stderr 里，而 e.message 只有
    // "Command failed: <cmd>"。不回显 stderr 会让用户（和排查者）看不到真正原因，
    // 例如 deb 缺少 homepage 时 electron-builder 的
    // "⨯ Please specify project homepage" 就只出现在 stderr。
    error(`打包失败: ${e.message}`)
    const stderr = e.stderr?.toString().trim()
    const stdout = e.stdout?.toString().trim()
    if (stderr) {
      console.error('\n--- electron-builder stderr（末 40 行）---')
      console.error(stderr.split('\n').slice(-40).join('\n'))
    }
    if (stdout) {
      console.error('\n--- electron-builder stdout（末 40 行）---')
      console.error(stdout.split('\n').slice(-40).join('\n'))
    }
    console.error('')
    process.exit(1)
  }
}

main()
