/**
 * 本地 Agents 仓库（灵栖/Lumii 独立版）
 *
 * 无后端、无 api-server。系统 Agent 来自 @mtbot/agent-runtime 内置定义（离线镜像），
 * 用户自建 Agent 存本地 JSON（~/.lumii/config/agents.json）。
 *
 * 对外暴露与原 apiClient.getAgents/forkAgent/updateAgent/deleteAgent 等价的记录形态
 * （api-record shape：{ id, name, userId, modelTier, systemPrompt, ... }），
 * 供渲染层 Agent UI 与 mapApiRecordToAgentDefinition 复用。
 */

import fs from 'node:fs'
import path from 'node:path'
import { BUILT_IN_AGENTS, type AgentDefinition } from '@mtbot/agent-runtime'
import { resolveWindowsClientDataRoot } from './client-data-root.js'

const LOCAL_USER_ID = 'local-user'

/** api-record 形态的 Agent 记录（对齐 apps/api-server transformAgentForFrontend） */
export interface AgentRecord {
  id: string
  name: string
  description?: string
  systemPrompt?: string
  isEnabled: boolean
  isDefault?: boolean
  /** 有值 = 用户 Agent；无值 = 系统 Agent */
  userId?: string
  sourceType?: string
  modelTier?: string
  primaryModel?: string
  identity?: { emoji?: string; theme?: string; avatar?: string }
  skillFilter?: string[]
  skillBlacklist?: string[]
  createdAt: string
  updatedAt: string
}

function agentsFilePath(): string {
  return path.join(resolveWindowsClientDataRoot(), 'config', 'agents.json')
}

/** 内置系统 Agent → api-record（离线镜像，无 userId） */
function systemAgentRecords(): AgentRecord[] {
  return BUILT_IN_AGENTS.map((def: AgentDefinition) => ({
    id: def.id,
    name: def.name,
    description: def.description,
    systemPrompt: def.systemPrompt,
    isEnabled: def.isActive !== false,
    isDefault: def.id === 'assistant',
    modelTier: def.modelTier,
    primaryModel: def.model,
    skillFilter: def.skills ? [...def.skills] : undefined,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }))
}

/** 读取用户自建 Agent（本地 JSON） */
function loadUserAgents(): AgentRecord[] {
  const p = agentsFilePath()
  try {
    if (!fs.existsSync(p)) return []
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
    if (!Array.isArray(raw)) return []
    return raw.filter((r): r is AgentRecord => r && typeof r === 'object' && typeof r.id === 'string')
  } catch {
    return []
  }
}

function saveUserAgents(agents: AgentRecord[]): void {
  const p = agentsFilePath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(agents, null, 2), 'utf-8')
}

/** 列出全部 Agent（系统 + 用户） */
export function listAgents(): { agents: AgentRecord[]; total: number } {
  const agents = [...systemAgentRecords(), ...loadUserAgents()]
  return { agents, total: agents.length }
}

/** 按 id 查单个 Agent */
export function getAgentRecord(id: string): AgentRecord | undefined {
  return listAgents().agents.find((a) => a.id === id)
}

/** 仅用户 Agent（供系统提示词注入 getCustomAgents） */
export function listUserAgentRecords(): AgentRecord[] {
  return loadUserAgents()
}

/**
 * Fork 系统/任意 Agent 为用户 Agent。
 * 复制源定义字段，赋新 id + userId，可覆盖 name/description/systemPrompt。
 */
export function forkAgentRecord(
  sourceAgentId: string,
  data: { name?: string; description?: string; systemPrompt?: string },
): AgentRecord {
  const source = getAgentRecord(sourceAgentId)
  if (!source) throw new Error(`源 Agent 不存在: ${sourceAgentId}`)
  const now = new Date().toISOString()
  const forked: AgentRecord = {
    ...source,
    id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: data.name?.trim() || `${source.name} 副本`,
    description: data.description ?? source.description,
    systemPrompt: data.systemPrompt ?? source.systemPrompt,
    isEnabled: true,
    isDefault: false,
    userId: LOCAL_USER_ID,
    sourceType: 'fork',
    createdAt: now,
    updatedAt: now,
  }
  const users = loadUserAgents()
  users.push(forked)
  saveUserAgents(users)
  return forked
}

/** 更新用户 Agent（系统 Agent 不可改，抛错） */
export function updateAgentRecord(agentId: string, patch: Record<string, unknown>): AgentRecord {
  const users = loadUserAgents()
  const idx = users.findIndex((a) => a.id === agentId)
  if (idx === -1) throw new Error(`用户 Agent 不存在或不可编辑: ${agentId}`)
  // id / userId / createdAt 不可被 patch 覆盖
  const { id: _id, userId: _uid, createdAt: _c, ...safe } = patch as Record<string, unknown>
  const next: AgentRecord = {
    ...users[idx]!,
    ...(safe as Partial<AgentRecord>),
    id: users[idx]!.id,
    userId: LOCAL_USER_ID,
    createdAt: users[idx]!.createdAt,
    updatedAt: new Date().toISOString(),
  }
  users[idx] = next
  saveUserAgents(users)
  return next
}

/** 删除用户 Agent */
export function deleteAgentRecord(agentId: string): void {
  const users = loadUserAgents()
  const next = users.filter((a) => a.id !== agentId)
  if (next.length === users.length) throw new Error(`用户 Agent 不存在: ${agentId}`)
  saveUserAgents(next)
}
