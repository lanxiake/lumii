/**
 * 审批配置管理相关类型定义
 */

/**
 * 命令执行审批请求
 */
export interface ExecApprovalRequest {
  id: string
  request: {
    command: string
    cwd?: string | null
    host?: string | null
    security?: string | null
    ask?: string | null
    agentId?: string | null
    resolvedPath?: string | null
    sessionKey?: string | null
  }
  createdAtMs: number
  expiresAtMs: number
}

/**
 * 命令执行审批决策
 */
export type ExecApprovalDecision = 'allow-once' | 'allow-always' | 'deny'

/**
 * 审批配置文件结构
 */
export interface ExecApprovalsFile {
  version: 1
  socket?: {
    path?: string
    token?: string
  }
  defaults?: {
    security?: 'deny' | 'allowlist' | 'full'
    ask?: 'off' | 'on-miss' | 'always'
    askFallback?: 'deny' | 'allowlist' | 'full'
    autoAllowSkills?: boolean
  }
  agents?: Record<string, {
    security?: 'deny' | 'allowlist' | 'full'
    ask?: 'off' | 'on-miss' | 'always'
    askFallback?: 'deny' | 'allowlist' | 'full'
    autoAllowSkills?: boolean
    allowlist?: Array<{
      id?: string
      pattern: string
      lastUsedAt?: number
      lastUsedCommand?: string
      lastResolvedPath?: string
    }>
  }>
}

/**
 * 审批配置快照
 */
export interface ExecApprovalsSnapshot {
  path: string
  exists: boolean
  hash: string
  file: ExecApprovalsFile
}

/**
 * 审批模式
 */
export type ApprovalMode = 'strict' | 'balanced' | 'trusted' | 'custom'

/**
 * 审批模式配置
 */
export interface ApprovalModeConfig {
  ask: 'off' | 'on-miss' | 'always'
  security: 'deny' | 'allowlist' | 'full'
  description: string
}

/**
 * 审批模式预设
 */
export const APPROVAL_PRESETS: Record<Exclude<ApprovalMode, 'custom'>, ApprovalModeConfig> = {
  strict: {
    ask: 'always',
    security: 'deny',
    description: '总是需要审批，最安全',
  },
  balanced: {
    ask: 'on-miss',
    security: 'allowlist',
    description: '白名单外需要审批，平衡安全与便利',
  },
  trusted: {
    ask: 'off',
    security: 'full',
    description: '完全信任，无需审批（仅在私人设备使用）',
  },
}

/**
 * 获取当前审批模式
 */
export function getCurrentMode(snapshot: ExecApprovalsSnapshot): ApprovalMode {
  const { ask, security } = snapshot.file.defaults || {}

  if (ask === 'off' && security === 'full') {
    return 'trusted'
  }
  if (ask === 'on-miss' && security === 'allowlist') {
    return 'balanced'
  }
  if (ask === 'always' && security === 'deny') {
    return 'strict'
  }

  return 'custom'
}
