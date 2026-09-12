/**
 * 会话级开发上下文（项目 + 工具）持久化。
 *
 * 与 backend-selection.json 同目录：`<config>/coding-dev-backends/dev-context.json`。
 * 键 = `${accountId}:${peerId}`：
 * - 桌面会话：accountId='local-user'，peerId=会话 id（sessionKey === conversationId）
 * - 渠道会话：accountId=channelUserId，peerId=sessionKey
 *
 * 语义（解析优先级见 coding-dev-env.ts / user-commands.ts）：
 * 会话显式（本文件）> Agent 绑定（app.json codingDevAgentBindings）> 全局默认。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { isCodingDevBackendId, type CodingDevBackendId } from './coding-dev-backends-stub/contracts.js'

export type DevContextRecord = {
  /** 会话级工具覆盖（/claude、/lumii 写入；显式写 'lumii' 用于退出开发模式） */
  backendId?: CodingDevBackendId
  /** 会话级项目覆盖（/project 写入；存项目名而非路径，项目被移除后自然失效） */
  projectName?: string
  updatedAt: string
}

/** 更新补丁：字段传 null 表示清除该项，传 undefined 表示保持原值 */
export type DevContextPatch = {
  backendId?: CodingDevBackendId | null
  projectName?: string | null
}

type DevContextFile = {
  version: number
  contexts: Record<string, DevContextRecord>
}

const DEV_CONTEXT_FILE_VERSION = 1

/**
 * 允许外部注入持久化基目录（Windows 客户端设为 ~/.lumii/config）。
 * 未注入时回退到 %TEMP%/mtbot（gateway 等场景）。
 */
let _customBaseDir: string | undefined

export function setDevContextBaseDir(dir: string): void {
  _customBaseDir = dir
}

function resolveDevContextDir(): string {
  const base = _customBaseDir ?? path.join(os.tmpdir(), 'mtbot')
  return path.join(base, 'coding-dev-backends')
}

function resolveDevContextPath(): string {
  return path.join(resolveDevContextDir(), 'dev-context.json')
}

function makeContextKey(accountId: string, peerId: string): string {
  return `${accountId}:${peerId}`
}

function readDevContextFile(): DevContextFile {
  const filePath = resolveDevContextPath()
  try {
    if (!fs.existsSync(filePath)) {
      return { version: DEV_CONTEXT_FILE_VERSION, contexts: {} }
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<DevContextFile>
    const contexts = parsed.contexts ?? {}
    const normalized: Record<string, DevContextRecord> = {}
    for (const [key, value] of Object.entries(contexts)) {
      if (!value || typeof value !== 'object') continue
      const raw = value as { backendId?: unknown; projectName?: unknown; updatedAt?: unknown }
      const backendId =
        typeof raw.backendId === 'string' && isCodingDevBackendId(raw.backendId) ? raw.backendId : undefined
      const projectName =
        typeof raw.projectName === 'string' && raw.projectName.trim() ? raw.projectName.trim() : undefined
      if (!backendId && !projectName) continue
      normalized[key] = {
        ...(backendId ? { backendId } : {}),
        ...(projectName ? { projectName } : {}),
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
      }
    }
    return { version: DEV_CONTEXT_FILE_VERSION, contexts: normalized }
  } catch {
    return { version: DEV_CONTEXT_FILE_VERSION, contexts: {} }
  }
}

function writeDevContextFile(data: DevContextFile): void {
  const dir = resolveDevContextDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(resolveDevContextPath(), JSON.stringify(data, null, 2), 'utf-8')
}

/** 读取会话级开发上下文；无记录返回 undefined */
export function getDevContext(accountId: string, peerId: string): DevContextRecord | undefined {
  const file = readDevContextFile()
  return file.contexts[makeContextKey(accountId, peerId)]
}

/**
 * 更新会话级开发上下文。
 * 补丁字段为 null 时清除该项；两项都为空时删除整条记录。
 * 返回更新后的记录；整条被清除时返回 undefined。
 */
export function setDevContext(
  accountId: string,
  peerId: string,
  patch: DevContextPatch,
): DevContextRecord | undefined {
  const file = readDevContextFile()
  const key = makeContextKey(accountId, peerId)
  const prev = file.contexts[key]

  const backendId =
    patch.backendId === undefined ? prev?.backendId : (patch.backendId ?? undefined)
  const projectName =
    patch.projectName === undefined ? prev?.projectName : (patch.projectName?.trim() || undefined)

  if (!backendId && !projectName) {
    if (!prev) return undefined
    delete file.contexts[key]
    writeDevContextFile(file)
    return undefined
  }

  const next: DevContextRecord = {
    ...(backendId ? { backendId } : {}),
    ...(projectName ? { projectName } : {}),
    updatedAt: new Date().toISOString(),
  }
  file.contexts[key] = next
  writeDevContextFile(file)
  return next
}

/** 清除整条会话级开发上下文；原记录存在返回 true */
export function clearDevContext(accountId: string, peerId: string): boolean {
  const file = readDevContextFile()
  const key = makeContextKey(accountId, peerId)
  if (!file.contexts[key]) return false
  delete file.contexts[key]
  writeDevContextFile(file)
  return true
}
