/**
 * serve-fixtures — 常驻起测试页面服务器（手工调试 / 套件复用）
 *
 * 套件运行时会自己起服务器（见 run-browser-suite.mjs）；本脚本用于手工场景：
 * 先在终端跑着，再用真实对话让 Agent 打开这些页面观察行为。
 *
 * 用法：node docs/test/lumii-cli/browser/lib/serve-fixtures.mjs [port]
 */

import { startProbeServer } from './probe-server.mjs'

const port = Number(process.argv[2] ?? 18799)
const s = await startProbeServer(port)
console.log(`[serve-fixtures] ${s.origin}`)
console.log(`  ${s.origin}/interact.html`)
console.log(`  ${s.origin}/second.html`)
console.log('Ctrl+C 退出')

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await s.close()
    process.exit(0)
  })
}

// 父进程用 child.kill() 时未必走得到 signal handler（Windows 下尤甚），
// 兜底一分钟后自我了断，免得残留进程占着端口。
setTimeout(() => process.exit(0), 60 * 60 * 1000).unref?.()
