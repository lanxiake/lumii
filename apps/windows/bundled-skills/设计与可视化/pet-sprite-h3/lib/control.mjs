/**
 * control.mjs — 控制口客户端（本机 HTTP + Bearer token）
 *
 * 单独一个模块，别把它塞在某个脚本里：模块顶层带副作用的脚本一被 import
 * 就会连带跑一遍（`plan-characters.mjs` 那样），复用就成了踩地雷。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let cached = null

export function controlConfig() {
  if (!cached) {
    // 与 run.ts / pet-asset 一致：`LUMII_CLIENT_DATA_DIR` 可以换数据根。
    // 本地起的那份「源码版工具链」就靠它接进来（见 characters/local-toolchain-server.mjs）。
    const root = process.env.LUMII_CLIENT_DATA_DIR?.trim() || path.join(os.homedir(), '.lumii')
    const p = path.join(root, 'runtime', 'app-ui.json')
    cached = JSON.parse(fs.readFileSync(p, 'utf-8'))
  }
  return cached
}

/** 调 `/pet/asset` 的某个 op；返回 `{ ok, result }` 或 `{ ok: false, error }` */
export async function op(name, args) {
  const cfg = controlConfig()
  const res = await fetch(`http://127.0.0.1:${cfg.port}/pet/asset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify({ op: name, args }),
  })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}` }
  }
}

/** 调 `/command`（建会话、发消息等） */
export async function command(payload) {
  const cfg = controlConfig()
  const res = await fetch(`http://127.0.0.1:${cfg.port}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 响应原样留着 */
  }
  return { status: res.status, json, text }
}
