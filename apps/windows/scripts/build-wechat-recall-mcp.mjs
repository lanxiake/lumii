/** 构建 wechat-recall-mcp（源码在独立仓库）：参数原样透传。 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { wechatMcpRepo } from './wechat-mcp-repo.mjs'

const repo = wechatMcpRepo()
const r = spawnSync(process.execPath,
  [path.join(repo, 'scripts', 'build-wechat-recall-mcp.mjs'), ...process.argv.slice(2)],
  { stdio: 'inherit' })
process.exit(r.status ?? 1)
