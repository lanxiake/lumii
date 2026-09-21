#!/usr/bin/env node
/**
 * local-toolchain-server.mjs — 用**源码**跑工具链的本地控制口
 *
 * ## 为什么要这个
 *
 * `pet-creator/run.ts` 通过控制口 `/pet/asset` 调工具链，而控制口在**运行中的 App**
 * 主进程里，加载的是打包进去的那份 `pet-asset`。改了 `packages/pet-asset` 之后，
 * 不重启 App 就不会生效——而重启会打断用户手上正在跑的会话。
 *
 * 这里起一个**同协议**的本地服务，背后直接是源码（经 esbuild 打包）。
 * `run.ts` 一行不改，只是把数据根指过来：
 *
 *   LUMII_CLIENT_DATA_DIR=<临时目录> node run.ts
 *
 * 于是「流水线逻辑仍然只有 run.ts 一份」，改的只是它连到哪个工具链。
 *
 * ⚠ 这只用于**离线产出随包资源**。真机回归仍须走 App 自己的控制口。
 *
 * 用法：node local-toolchain-server.mjs <端口>
 */

import http from 'node:http'
import { runPetAssetOp, isPetAssetOp, describeRoots } from './_ipc.built.mjs'

const port = Number(process.argv[2]) || 18799

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.startsWith('/pet/asset')) {
    res.writeHead(404).end('{}')
    return
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', async () => {
    let out
    try {
      const parsed = JSON.parse(body)
      if (parsed.op === 'roots') out = { ok: true, result: describeRoots() }
      else if (!isPetAssetOp(parsed.op)) out = { ok: false, error: `未知 op ${parsed.op}` }
      else out = await runPetAssetOp({ op: parsed.op, args: parsed.args })
    } catch (err) {
      out = { ok: false, error: String(err?.message ?? err) }
    }
    const json = JSON.stringify(out)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(json)
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[local-toolchain] listening on 127.0.0.1:${port}`)
  console.log(`[local-toolchain] roots =`, JSON.stringify(describeRoots()))
})
