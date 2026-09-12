/**
 * SceneResolver — 场景命中解析
 *
 * 回答一个问题：本轮对话应该加载哪些场景记忆？
 * - 渠道：sessionKey 前缀解析（约定与 cross-channel-continuity.ts:59 一致，复用其纯函数）
 * - 项目：当前用户消息 × 注册表别名的子串匹配（大小写不敏感），多个命中取最长匹配
 *
 * 纯逻辑 + 只读注册表，不做文件内容读取（调用方用 scene-memory-store 读取命中的 filePath）。
 * 设计文档：docs/design/记忆设计/2026-09-12-scene-memory-design.md
 */

import { channelOfSessionKey } from '../channel/cross-channel-continuity'
import {
  loadRegistry,
  resolveSceneFilePath,
  type ProjectEntry,
  type SceneRegistry,
} from './scene-memory-store'

const log = {
  info: (...args: unknown[]) => console.log('[SceneResolver]', ...args),
  warn: (...args: unknown[]) => console.warn('[SceneResolver]', ...args),
}

/** 别名参与匹配的最小长度（低于此长度误报率过高） */
export const MIN_ALIAS_MATCH_LENGTH = 2

/**
 * 别名是否够特异、可以参与匹配。
 * 中文等非 ASCII 别名 >= 2 字符即可（"卤米"）；纯 ASCII 别名要求 >= 3 字符
 * （"AI"、"Go" 这类高频短词会大量误报）。
 */
export function isAliasSpecific(alias: string): boolean {
  const a = alias.trim()
  if (a.length < MIN_ALIAS_MATCH_LENGTH) return false
  if (/^[\x20-\x7e]+$/.test(a)) return a.length >= 3
  return true
}

export interface SceneHit {
  scene: 'project' | 'channel'
  key: string
  /** 展示名：项目名 / 渠道中文名（微信、飞书…） */
  name: string
  /** 记忆文件绝对路径（调用方读取，文件不存在时跳过） */
  filePath: string
}

export interface ChannelResolution {
  channelType: string
  /** 渠道中文展示名 */
  label: string
}

/**
 * sessionKey → 用户渠道（含中文展示名）。
 * 客户端会话（ipc）、定时任务（cron）、进化任务（evolution）返回 null——这些不是需要区分偏好的渠道。
 */
export function resolveChannel(sessionKey: string | undefined): ChannelResolution | null {
  if (!sessionKey) return null
  const { channelType, label } = channelOfSessionKey(sessionKey)
  if (channelType === 'ipc' || channelType === 'cron' || channelType === 'evolution') {
    return null
  }
  return { channelType, label: label || channelType }
}

/**
 * 消息文本 × 注册表别名匹配。
 * 命中规则：别名（长度 >= MIN_ALIAS_MATCH_LENGTH）作为子串出现在消息中；
 * 多项目命中时取「最长别名匹配」的项目（更长的匹配更特异），同长取最近活跃者。
 */
export function matchProject(registry: SceneRegistry, message: string): ProjectEntry | null {
  const text = message.toLowerCase()
  let best: ProjectEntry | null = null
  let bestLen = 0

  for (const proj of registry.projects) {
    let hitLen = 0
    for (const alias of proj.aliases) {
      if (!isAliasSpecific(alias)) continue
      const a = alias.trim().toLowerCase()
      if (text.includes(a)) hitLen = Math.max(hitLen, a.length)
    }
    if (hitLen === 0) continue
    if (
      hitLen > bestLen ||
      (hitLen === bestLen && best !== null && proj.lastActiveAt > best.lastActiveAt)
    ) {
      best = proj
      bestLen = hitLen
    }
  }

  return best
}

/**
 * 综合解析本轮命中的场景：渠道命中（至多一个）+ 项目命中（至多一个）。
 * 只做判定，不校验文件是否存在——读取内容时由 store 返回 undefined 自然跳过。
 */
export async function resolveSceneHits(params: {
  baseDir: string
  sessionKey?: string
  userMessage?: string
}): Promise<SceneHit[]> {
  const { baseDir, sessionKey, userMessage } = params
  const hits: SceneHit[] = []

  const channel = resolveChannel(sessionKey)
  if (channel) {
    hits.push({
      scene: 'channel',
      key: channel.channelType,
      name: channel.label,
      filePath: resolveSceneFilePath(baseDir, 'channel', channel.channelType),
    })
  }

  if (userMessage && userMessage.trim()) {
    try {
      const registry = await loadRegistry(baseDir)
      const project = matchProject(registry, userMessage)
      if (project) {
        hits.push({
          scene: 'project',
          key: project.key,
          name: project.name,
          filePath: resolveSceneFilePath(baseDir, 'project', project.key, project.path),
        })
      }
    } catch (err) {
      log.warn(
        `[resolveSceneHits] 项目匹配失败: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  if (hits.length > 0) {
    log.info(
      `[resolveSceneHits] 命中场景: ${hits.map((h) => `${h.scene}=${h.key}`).join(', ')}`,
    )
  }
  return hits
}
