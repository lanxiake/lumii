/**
 * Windows 开发启动包装：先切 UTF-8 代码页，再启动 electron-vite，减少控制台中文乱码
 */
const { spawn, execSync } = require('node:child_process')
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

const cwd = path.resolve(__dirname, '..')
try {
  require('node:child_process').execSync('node scripts/sync-user-guides.mjs', { cwd, stdio: 'inherit' })
} catch {
  console.warn('[run-dev] sync-user-guides 失败，将使用 resources/user-guides 现有副本')
}
// 透传 CLI 参数，供调试用（如 --inspect=5858 --remoteDebuggingPort=9222 --sourcemap）
const child = spawn('npx', ['electron-vite', 'dev', ...process.argv.slice(2)], {
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
