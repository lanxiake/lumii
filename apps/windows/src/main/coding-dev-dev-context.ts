/**
 * 会话级开发上下文（项目 + 工具）持久化。
 *
 * 与 backend-selection.json 同目录：`<config>/coding-dev-backends/dev-context.json`。
 *
 * **键 = 会话 id**（sessionKey === conversationId）。2026-09-15（10-S3b）之前是
 * `${accountId}:${peerId}`，于是同一条会话在不同渠道下各有一份上下文：用户在微信里
 * `/project lumii`，转到 QQ 或客户端继续聊，项目就"丢了"——因为它们算成了两个键。
 * 会话是全局唯一的（conversations.id 是主键），项目与工具本来就跟会话走，与谁在说话无关。
 * 老键（`{accountId}:{会话id}`）仍能读出来（取最新的一条），下次写入时清理。
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
  /** 最后一次写入者（诊断用：渠道 userId 或 local-user） */
  accountId?: string
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

const DEV_CONTEXT_FILE_VERSION = 2

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
      const raw = value as {
        backendId?: unknown
        projectName?: unknown
        accountId?: unknown
        updatedAt?: unknown
      }
      const backendId =
        typeof raw.backendId === 'string' && isCodingDevBackendId(raw.backendId) ? raw.backendId : undefined
      const projectName =
        typeof raw.projectName === 'string' && raw.projectName.trim() ? raw.projectName.trim() : undefined
      if (!backendId && !projectName) continue
      normalized[key] = {
        ...(backendId ? { backendId } : {}),
        ...(projectName ? { projectName } : {}),
        ...(typeof raw.accountId === 'string' && raw.accountId ? { accountId: raw.accountId } : {}),
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

/**
 * 会话 id 在旧格式（`{accountId}:{会话id}`）下的全部候选键。
 *
 * 只认「前缀里没有冒号」的键：账号 id（渠道 userId 或 local-user）不含冒号，
 * 而会话 id 可能含（`qbot:uid:ts`）。不这么限，`x:y:abc` 会被误当成本会话 `abc` 的旧键。
 */
function legacyKeysFor(contexts: Record<string, DevContextRecord>, sessionKey: string): string[] {
  const suffix = `:${sessionKey}`
  return Object.keys(contexts).filter((k) => {
    if (k === sessionKey || !k.endsWith(suffix)) return false
    const accountId = k.slice(0, k.length - suffix.length)
    return accountId.length > 0 && !accountId.includes(':')
  })
}

/** 读取记录：新键优先，其次取旧格式里 updatedAt 最新的一条（迁移期兼容） */
function pickRecord(
  contexts: Record<string, DevContextRecord>,
  sessionKey: string,
): DevContextRecord | undefined {
  const direct = contexts[sessionKey]
  if (direct) return direct
  const legacy = legacyKeysFor(contexts, sessionKey)
    .map((k) => contexts[k])
    .filter((r): r is DevContextRecord => Boolean(r))
  if (legacy.length === 0) return undefined
  return legacy.reduce((newest, r) => (r.updatedAt > newest.updatedAt ? r : newest))
}

/** 读取会话级开发上下文；无记录返回 undefined */
export function getDevContext(sessionKey: string): DevContextRecord | undefined {
  return pickRecord(readDevContextFile().contexts, sessionKey)
}

/**
 * 更新会话级开发上下文。
 * 补丁字段为 null 时清除该项；两项都为空时删除整条记录。
 * 返回更新后的记录；整条被清除时返回 undefined。
 *
 * @param accountId 写入者（诊断用，可选）
 */
export function setDevContext(
  sessionKey: string,
  patch: DevContextPatch,
  accountId?: string,
): DevContextRecord | undefined {
  const file = readDevContextFile()
  const prev = pickRecord(file.contexts, sessionKey)
  // 迁移期：清掉该会话的旧键，避免下次读出两条不一致的上下文
  for (const legacyKey of legacyKeysFor(file.contexts, sessionKey)) {
    delete file.contexts[legacyKey]
  }

  const backendId =
    patch.backendId === undefined ? prev?.backendId : (patch.backendId ?? undefined)
  const projectName =
    patch.projectName === undefined ? prev?.projectName : (patch.projectName?.trim() || undefined)

  if (!backendId && !projectName) {
    if (!prev) return undefined
    delete file.contexts[sessionKey]
    writeDevContextFile(file)
    return undefined
  }

  const next: DevContextRecord = {
    ...(backendId ? { backendId } : {}),
    ...(projectName ? { projectName } : {}),
    ...(accountId ? { accountId } : {}),
    updatedAt: new Date().toISOString(),
  }
  file.contexts[sessionKey] = next
  writeDevContextFile(file)
  return next
}

/** 清除整条会话级开发上下文；原记录存在返回 true */
export function clearDevContext(sessionKey: string): boolean {
  const file = readDevContextFile()
  const existed = Boolean(pickRecord(file.contexts, sessionKey))
  if (!existed) return false
  delete file.contexts[sessionKey]
  for (const legacyKey of legacyKeysFor(file.contexts, sessionKey)) {
    delete file.contexts[legacyKey]
  }
  writeDevContextFile(file)
  return true
}
