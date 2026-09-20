#!/usr/bin/env node
/**
 * send-turn.mjs — 通过控制口向会话发送一条消息（验证点 D 用）
 *
 * 为什么不用 `lumii-ui send`：那条路径不带 msgId 会跳过分段管线。
 * 必须走底层 `command user:send` 并补 msgId（见记忆：CLI 驱动真实 Agent 轮次）。
 *
 * 用法：node verify/pet-sprite/send-turn.mjs <sessionKey> <textFile>
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const [sessionKey, textFile] = process.argv.slice(2)
if (!sessionKey || !textFile) {
  console.error('用法: node send-turn.mjs <sessionKey> <textFile>')
  process.exit(1)
}

const dataRoot = process.env.LUMII_CLIENT_DATA_DIR || path.join(os.homedir(), '.lumii')
const cfg = JSON.parse(fs.readFileSync(path.join(dataRoot, 'runtime', 'app-ui.json'), 'utf-8'))
const content = fs.readFileSync(textFile, 'utf-8')

const res = await fetch(`http://127.0.0.1:${cfg.port}/command`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
  body: JSON.stringify({
    type: 'user:send',
    sessionKey,
    content,
    msgId: randomUUID(),
  }),
})

const text = await res.text()
console.log('HTTP', res.status)
console.log(text.slice(0, 800))
