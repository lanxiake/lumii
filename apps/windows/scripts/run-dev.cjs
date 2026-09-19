/**
 * 开发启动包装：Windows 先切 UTF-8 代码页，Linux 处理 Chromium 沙箱。
 */
const { spawn, execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore', shell: true })
  } catch {
    /* ignore */
  }
  process.env.PYTHONIOENCODING = 'utf-8'
  // Electron/Chromium 控制台在 Windows 上尽量走 UTF-8
  if (!process.env.NODE_OPTIONS) {
    process.env.NODE_OPTIONS = ''
  }
}

/**
 * Linux 开发期的 Chromium 沙箱处理。
 *
 * Ubuntu 24.04 默认 `kernel.apparmor_restrict_unprivileged_userns=1`，Electron 只能走
 * setuid sandbox；而 npm 镜像产出的 `chrome-sandbox` 权限是 0755，Chromium 会直接 abort。
 * 两种解法：
 *   ① 把 chrome-sandbox 设为 root:root 4755（需 sudo，且每次重装依赖都要重做）
 *   ② 开发期用 electron-vite 内建的 `--noSandbox`（追加 --no-sandbox）
 *
 * 此处检测①是否已满足，未满足则自动退回②并明确告知——不静默降级。
 * 发布产物不依赖本逻辑：deb 的 postinst 会修好权限（见打包链路）。
 */
function resolveLinuxSandbox() {
  try {
    const { createRequire } = require('node:module')
    const req = createRequire(__filename)
    const electronPath = req('electron')
    const sandboxPath = path.join(path.dirname(electronPath), 'chrome-sandbox')
    const st = fs.statSync(sandboxPath)
    const isSetuid = (st.mode & 0o4000) !== 0
    if (st.uid === 0 && isSetuid) return { ok: true }
    console.warn(
      '[run-dev] chrome-sandbox 未配置 setuid（需 root:root 4755），改用 --no-sandbox 启动。\n' +
        '          仅开发期如此；发布产物由 deb postinst 修好权限，不走这条路径。',
    )
    return { ok: false }
  } catch (err) {
    console.warn('[run-dev] 检测 chrome-sandbox 失败，改用 --no-sandbox：', err?.message ?? err)
    return { ok: false }
  }
}

const extraArgs = []
if (process.platform === 'linux' && !resolveLinuxSandbox().ok) {
  extraArgs.push('--noSandbox')
}

const cwd = path.resolve(__dirname, '..')
try {
  require('node:child_process').execSync('node scripts/sync-user-guides.mjs', { cwd, stdio: 'inherit' })
} catch {
  console.warn('[run-dev] sync-user-guides 失败，将使用 resources/user-guides 现有副本')
}
// 透传 CLI 参数，供调试用（如 --inspect=5858 --remoteDebuggingPort=9222 --sourcemap）
const child = spawn('npx', ['electron-vite', 'dev', ...extraArgs, ...process.argv.slice(2)], {
  cwd,
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
  },
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
