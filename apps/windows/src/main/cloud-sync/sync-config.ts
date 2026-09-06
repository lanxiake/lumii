/**
 * 云同步配置读写。
 *
 * 独立文件 ~/.lumii/config/cloud-sync.json，token 经 safeStorage 加密落盘
 * （加密不可用时用 plain: 前缀明文兜底，与 provider-config.ts 同模式）。
 * 所有加密逻辑集中在本模块；渲染层只看到掩码，IPC/manager 层不直接操作密文。
 */
import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { resolveWindowsClientDataRoot } from '../client-data-root'
import { createLogger } from '../logger'
import type { CloudSyncConfig, CloudSyncConfigView } from './types'

const logger = createLogger('cloud-sync/config')

const configFile = (): string =>
  path.join(resolveWindowsClientDataRoot(), 'config', 'cloud-sync.json')

export const DEFAULT_CLOUD_SYNC_CONFIG: CloudSyncConfig = {
  enabled: false,
  provider: 'gitcode',
  repoUrl: '',
  branch: 'main',
  intervalMinutes: 15,
}

function encryptToken(token: string): string {
  if (!token) return ''
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(token).toString('base64')
  }
  return `plain:${token}`
}

/** 仅主进程内部使用（sync onAuth / testConnection 需明文），绝不经 IPC 返回渲染层 */
export function decryptToken(enc?: string): string {
  if (!enc) return ''
  if (enc.startsWith('plain:')) return enc.slice(6)
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return ''
  }
}

export function loadCloudSyncConfig(): CloudSyncConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(), 'utf-8')) as Partial<CloudSyncConfig>
    return { ...DEFAULT_CLOUD_SYNC_CONFIG, ...raw }
  } catch {
    return { ...DEFAULT_CLOUD_SYNC_CONFIG }
  }
}

/** 从视图保存：token 显式语义，空串沿用旧值 */
export function saveConfigFromView(view: CloudSyncConfigView): CloudSyncConfig {
  const cur = loadCloudSyncConfig()
  const tokenEnc = view.token && view.token.trim() !== '' ? encryptToken(view.token) : cur.tokenEnc
  const next: CloudSyncConfig = {
    enabled: view.enabled,
    provider: view.provider,
    repoUrl: view.repoUrl.trim(),
    branch: view.branch?.trim() || 'main',
    intervalMinutes: view.intervalMinutes,
    tokenEnc,
  }
  fs.mkdirSync(path.dirname(configFile()), { recursive: true })
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2), 'utf-8')
  logger.info(`[saveConfigFromView] 已保存云同步配置, provider=${next.provider}, enabled=${next.enabled}`)
  return next
}

/** 只读回显视图（token 掩码），workspaceDir 由 IPC 层填充 */
export function toConfigView(cfg: CloudSyncConfig): CloudSyncConfigView {
  const token = decryptToken(cfg.tokenEnc)
  const masked =
    token.length <= 4 ? (token ? '****' : '') : `${token.slice(0, 4)}****${token.slice(-4)}`
  return {
    enabled: cfg.enabled,
    provider: cfg.provider,
    repoUrl: cfg.repoUrl,
    branch: cfg.branch,
    intervalMinutes: cfg.intervalMinutes,
    tokenMasked: masked,
    workspaceDir: '',
  }
}
