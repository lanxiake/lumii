/**
 * Agent 定义详情区块（详情面板用）
 *
 * 回答四件事：何时使用 / 能力配置（工具 + 技能 + 边界）/ 运行方式。
 * 数据来源分两类：
 * - 系统内置 Agent：主进程从内置定义镜像来的只读 `agent.definition`
 * - 用户 Agent：记录自带的 whenToUse / skillFilter / skillBlacklist，工具面由能力开关反推
 */

import React, { useEffect, useState } from 'react'
import { groupTools } from '../tool-labels'
import { CAPABILITY_OPTIONS, skillBlacklistToCapabilityIds } from '../AgentsPage.const'
import { getCodingDevAgentBindings, type CodingDevAgentBinding } from '../../../services/coding-dev-service'
import { listInstalledSkills } from '../../../services/skills-service'
import { listEnabledMcpServers, type McpServerOption } from '../../../services/mcp-service'
import type { Agent } from './types'
import styles from './DetailPanel.module.css'

const BACKEND_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
}

const MEMORY_SCOPE_LABELS: Record<string, string> = {
  user: '跨会话长期记忆',
  conversation: '仅本会话记忆',
  none: '不积累记忆',
}

const PERMISSION_LABELS: Record<string, string> = {
  readOnly: '只读',
}

interface AgentDefinitionViewProps {
  agent: Agent
}

/** 原始工具名（并排展示用；无工具时不渲染） */
function rawToolText(tools: string[] | undefined): string | undefined {
  return tools && tools.length > 0 ? tools.join(' ') : undefined
}

/**
 * 解析「何时使用」文案。
 * 内置定义的 WHEN_TO_USE 文本填在 description 里，用户 Agent 用自己的 whenToUse；
 * DetailPanel 头部也用这个判断，避免同一段文字重复渲染两次。
 */
export function resolveWhenToUse(agent: Agent): string | undefined {
  return agent.definition?.whenToUse ?? agent.whenToUse ?? agent.description
}

export const AgentDefinitionView: React.FC<AgentDefinitionViewProps> = ({ agent }) => {
  const [binding, setBinding] = useState<CodingDevAgentBinding | undefined>(undefined)
  /** 技能名（小写）→ 技能 ID，用于在技能后面并列原始标识 */
  const [skillIds, setSkillIds] = useState<Record<string, string>>({})
  /** 技能 ID（小写）→ 技能名，用于把常驻技能的 ID 还原成可读名 */
  const [skillNames, setSkillNames] = useState<Record<string, string>>({})
  /** 已启用的 MCP 服务（展示该 Agent 实际可用的 MCP 与原始工具名） */
  const [mcpServers, setMcpServers] = useState<McpServerOption[]>([])

  const detail = agent.definition
  const isSystem = !agent.userId

  const whenToUse = resolveWhenToUse(agent)
  const triggerExamples = detail?.triggerExamples ?? agent.triggerExamples ?? []
  const category = detail?.category ?? agent.category

  const skillFilter = agent.skillFilter ?? []
  const bundledSkills = detail?.bundledSkills ?? agent.bundledSkills ?? []

  useEffect(() => {
    let cancelled = false
    void getCodingDevAgentBindings()
      .then((list) => {
        if (cancelled) return
        setBinding(list.find((b) => b.agentId === agent.id && b.enabled))
      })
      .catch(() => {
        // 绑定读取失败不阻塞详情展示（详情面板可能是只读回看场景）
      })
    return () => {
      cancelled = true
    }
  }, [agent.id])

  useEffect(() => {
    let cancelled = false
    void listInstalledSkills()
      .then((list) => {
        if (cancelled) return
        const byName: Record<string, string> = {}
        const byId: Record<string, string> = {}
        for (const s of list) {
          const display = s.name || s.id
          byName[display.toLowerCase()] = s.id
          byId[s.id.toLowerCase()] = display
        }
        setSkillIds(byName)
        setSkillNames(byId)
      })
      .catch(() => {
        // 拿不到技能列表时只少显示原始 ID，不影响主信息
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void listEnabledMcpServers().then((list) => {
      if (!cancelled) setMcpServers(list)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const toolGroups = isSystem ? groupTools(detail?.tools ?? []) : []
  const disabledToolLabels = groupTools(detail?.disallowedTools ?? []).map((g) => g.label)

  const enabledCapabilityIds = skillBlacklistToCapabilityIds(agent.skillBlacklist)
  const enabledCapabilities = isSystem
    ? []
    : CAPABILITY_OPTIONS.filter((cap) => enabledCapabilityIds.has(cap.id))
  const disabledCapabilities = isSystem
    ? []
    : CAPABILITY_OPTIONS.filter((cap) => !enabledCapabilityIds.has(cap.id))

  const boundaries = [
    detail?.memoryScope ? MEMORY_SCOPE_LABELS[detail.memoryScope] ?? `记忆范围：${detail.memoryScope}` : null,
    detail?.maxTurns !== undefined ? `单次最多 ${detail.maxTurns} 轮` : null,
    detail?.canSpawnSubAgents !== undefined
      ? detail.canSpawnSubAgents
        ? '可派生子 Agent'
        : '不派生子 Agent'
      : null,
    detail?.permissionMode ? PERMISSION_LABELS[detail.permissionMode] ?? null : null,
  ].filter((v): v is string => Boolean(v))

  // 仅开发类 Agent 有「外部 CLI / 内置内核」之分，其余不展示运行方式
  const showRunSurface = agent.id === 'code-dev' || binding !== undefined

  /**
   * 该 Agent 实际可用的 MCP 服务（含工具原始名）。
   * 系统 Agent 由工具白名单决定；用户 Agent 从启用中的 server 扣掉被黑名单挡掉的工具。
   */
  const blacklistSet = new Set(agent.skillBlacklist ?? [])
  const systemAllowsAllTools = !detail?.tools || detail.tools.includes('*')
  const availableMcp = mcpServers
    .map((server) => {
      const tools = isSystem
        ? systemAllowsAllTools
          ? server.tools
          : (detail?.tools ?? []).filter((t) => t.startsWith(`mcp__${server.name}__`))
        : server.tools.filter((t) => !blacklistSet.has(t))
      return { server: server.name, tools }
    })
    .filter((entry) => entry.tools.length > 0)

  return (
    <>
      {whenToUse && (
        <div className={styles.section}>
          <div className={styles['section-title']}>何时使用</div>
          <div className={styles.infoValue}>{whenToUse}</div>
          {category && <div className={styles.muted}>分类：{category}</div>}
          {triggerExamples.length > 0 && (
            <div className={styles.chipRow}>
              {triggerExamples.map((example) => (
                <span key={example} className={styles.chip} title={example}>
                  {example}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className={styles.section}>
        <div className={styles['section-title']}>能力配置</div>

        <div className={styles.infoLabel}>工具</div>
        {isSystem && toolGroups.length > 0 ? (
          <div className={styles.chipRow}>
            {toolGroups.map((group) => (
              <span key={group.label} className={styles.chip}>
                {group.label}
                <span className={styles.chipRaw}>{rawToolText(group.tools)}</span>
              </span>
            ))}
          </div>
        ) : !isSystem && enabledCapabilities.length > 0 ? (
          <div className={styles.chipRow}>
            {enabledCapabilities.map((cap) => (
              <span key={cap.id} className={styles.chip}>
                {cap.label}
                <span className={styles.chipRaw}>{rawToolText(cap.toolNames)}</span>
              </span>
            ))}
          </div>
        ) : (
          <div className={styles.muted}>未限制工具面</div>
        )}
        {disabledCapabilities.length > 0 && (
          <div className={styles.muted}>
            已关闭：{disabledCapabilities.map((cap) => cap.label).join('、')}
          </div>
        )}
        {disabledToolLabels.length > 0 && (
          <div className={styles.muted}>已禁用：{disabledToolLabels.join('、')}</div>
        )}

        <div className={styles.infoLabel}>技能</div>
        {skillFilter.length > 0 ? (
          <div className={styles.chipRow}>
            {skillFilter.map((name) => {
              const id = skillIds[name.toLowerCase()]
              return (
                <span key={name} className={styles.chip}>
                  {name}
                  {id && <span className={styles.chipRaw}>{id}</span>}
                </span>
              )
            })}
          </div>
        ) : (
          <div className={styles.muted}>未限制（全部已安装技能可用）</div>
        )}

        {bundledSkills.length > 0 && (
          <>
            <div className={styles.infoLabel}>常驻技能</div>
            <div className={styles.chipRow}>
              {bundledSkills.map((id) => (
                <span key={id} className={styles.chip}>
                  {skillNames[id.toLowerCase()] ?? id}
                  <span className={styles.chipRaw}>{id}</span>
                </span>
              ))}
            </div>
          </>
        )}

        <div className={styles.infoLabel}>MCP 服务</div>
        {availableMcp.length > 0 ? (
          <div className={styles.mcpList}>
            {availableMcp.map(({ server, tools }) => (
              <div key={server} className={styles.mcpItem}>
                <div className={styles.mcpName}>
                  {server}
                  <span className={styles.chipRaw}>{tools.length} 个工具</span>
                </div>
                <div className={styles.mcpTools}>
                  {tools.map((tool) => (
                    <span key={tool} className={styles.mcpToolName}>{tool}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.muted}>未使用 MCP 服务</div>
        )}

        {boundaries.length > 0 && <div className={styles.muted}>{boundaries.join(' · ')}</div>}
      </div>

      {showRunSurface && (
        <div className={styles.section}>
          <div className={styles['section-title']}>运行方式</div>
          {binding ? (
            <>
              <div className={styles.infoRow}>
                <span className={styles.infoLabel}>外部 CLI</span>
                <span className={styles.infoValue}>
                  {BACKEND_LABELS[binding.backendId] ?? binding.backendId}
                </span>
              </div>
              {binding.workspace && (
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>工作目录</span>
                  <span className={styles.infoValue} title={binding.workspace}>
                    {binding.workspace.split(/[/\\]/).filter(Boolean).pop() ?? binding.workspace}
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className={styles.muted}>
              内置内核（未绑定外部 CLI；工具面见上方「能力配置」）
            </div>
          )}
        </div>
      )}
    </>
  )
}
