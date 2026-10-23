/** 构建主产品（源码在独立仓库，统一档位 wechat-chat-mcp）：参数原样透传。 */
import { spawnSync } from 'node:child_process'
import { wechatMcpBuildScript, wechatMcpRepo } from './wechat-mcp-repo.mjs'

const repo = wechatMcpRepo()
const r = spawnSync(process.execPath, [wechatMcpBuildScript(repo), ...process.argv.slice(2)], {
  stdio: 'inherit',
})
process.exit(r.status ?? 1)
