#!/usr/bin/env node
/**
 * gen.mjs — 驱动真实 Agent 轮次出图（Shimeji 那三批）
 *
 * 与 `verify/pet-sprite/characters/drive-gen.mjs` 同一套做法，理由也一样：
 * 出图工具会**清洗文件名**再拼日期与随机后缀，所以只能给扁平唯一名去等通配，
 * 落地后拷到稳定路径；`since` 用来把本轮产物与上一轮的旧图分开（踩过）。
 *
 * 用法：node gen.mjs [角色前缀]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { command } from '../pet-sprite/lib/control.mjs'
import { SHIMEJI_RAW, STATES, genPrompt, planFor } from './shimeji.mjs'

const WORKSPACE = path.join(os.homedir(), '.lumii/workspace')
const prefix = process.argv[2] ?? 'cat'

const tokenFor = (st) => `${prefix}-${st.name.toLowerCase()}`

function findProduced(token, since) {
  const root = path.join(WORKSPACE, 'outputs')
  const hits = []
  for (const day of fs.readdirSync(root)) {
    const dir = path.join(root, day)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(token + '_') || !/\.(png|jpg|webp)$/i.test(f)) continue
      const abs = path.join(dir, f)
      if (since && fs.statSync(abs).mtimeMs < since) continue
      hits.push(abs)
    }
  }
  if (hits.length === 0) return null
  hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return hits[0]
}

const plan = await planFor(prefix)
const created = await command({ type: 'conversation:create', title: `Shimeji 精灵表 · ${prefix}` })
const sessionKey = created.json?.sessionKey ?? created.json?.result?.sessionKey
if (!sessionKey) throw new Error(`建会话失败：${created.text.slice(0, 200)}`)

const since = Date.now()
await command({ type: 'user:send', sessionKey, content: genPrompt(prefix, plan), msgId: randomUUID() })
console.log('已发送，等待出图…')

const done = new Map()
const lastSize = new Map()
const t0 = Date.now()
while (Date.now() - t0 < 900_000 && done.size < STATES.length) {
  for (const st of STATES) {
    const token = tokenFor(st)
    if (done.has(token)) continue
    const hit = findProduced(token, since)
    if (!hit) continue
    const size = fs.statSync(hit).size
    if (lastSize.get(token) !== size || size === 0) {
      lastSize.set(token, size)
      continue
    }
    done.set(token, hit)
  }
  if (done.size === STATES.length) break
  await new Promise((r) => setTimeout(r, 5000))
}

fs.mkdirSync(SHIMEJI_RAW, { recursive: true })
for (const st of STATES) {
  const token = tokenFor(st)
  const hit = done.get(token)
  if (!hit) {
    console.log(`  ✗ ${token} 超时没落地`)
    continue
  }
  fs.copyFileSync(hit, path.join(SHIMEJI_RAW, `${token}.png`))
  console.log(`  ✓ ${token} → ${path.relative(WORKSPACE, path.join(SHIMEJI_RAW, `${token}.png`))}`)
}
