/**
 * Step3Review — 左列表 + 右详情：逐个核对角色配置，再批量创建
 *
 * 每个角色可单独移除；技能 / 可用能力 / MCP 服务都以勾选列表呈现，
 * 用户一眼能看出 AI 选了什么、漏了什么。未勾选的 MCP 服务，其工具会写进该 Agent 的工具黑名单。
 */

import React, { useState } from 'react'
import clsx from 'clsx'
import { forkAgent, updateAgent } from '../../../../services/agent-service'
import type { GeneratedAgent, GeneratedAgentForm, CapabilityOption, McpServerOption } from './types'
import { capabilitiesToSkillBlacklist, encodeGroupToDescription } from './utils'
import { Trash2 } from 'lucide-react'
import styles from './GenerateTeamWizard.module.css'

interface Step3ReviewProps {
  agents: GeneratedAgent[]
  capabilityOptions: CapabilityOption[]
  systemAgents: { id: string; name: string }[]
  userSkills: { id: string; name: string; description?: string }[]
  /** 已启用的 MCP 服务（勾选项；未勾选的 server 工具进黑名单） */
  mcpServers: McpServerOption[]
  onBack: () => void
  onComplete: () => void
}

/**
 * 补齐 AI 可能漏掉的字段，避免编辑区拿到 undefined。
 * 能力/MCP 若 AI 压根没给（而不是给了空数组），按「全开」兜底——
 * 这两种字段是「未勾选 = 禁用」，默认空会让 Agent 一个工具都用不了。
 */
function toForm(
  agent: GeneratedAgent,
  capabilityOptions: CapabilityOption[],
  mcpServers: McpServerOption[],
): GeneratedAgentForm {
  return {
    ...agent,
    capabilities: Array.isArray(agent.capabilities)
      ? [...agent.capabilities]
      : capabilityOptions.map((c) => c.id),
    mcpServers: Array.isArray(agent.mcpServers)
      ? [...agent.mcpServers]
      : mcpServers.map((s) => s.name),
    whenToUse: agent.whenToUse ?? '',
    triggerExamples: Array.isArray(agent.triggerExamples) ? [...agent.triggerExamples] : [],
    bundledSkills: Array.isArray(agent.bundledSkills) ? [...agent.bundledSkills] : [],
    status: 'pending',
  }
}

const STATUS_LABEL: Record<GeneratedAgentForm['status'], string> = {
  pending: '待确认',
  creating: '创建中',
  success: '已创建',
  error: '失败',
}

export const Step3Review: React.FC<Step3ReviewProps> = ({
  agents,
  capabilityOptions,
  systemAgents,
  userSkills,
  mcpServers,
  onBack,
  onComplete,
}) => {
  const [forms, setForms] = useState<GeneratedAgentForm[]>(() =>
    agents.map((agent) => toForm(agent, capabilityOptions, mcpServers)),
  )
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [isCreating, setIsCreating] = useState(false)

  const installedSkillIds = new Set(userSkills.map((s) => s.id))
  const current = forms[selectedIndex]
  const editable = current?.status === 'pending'

  const updateForm = (index: number, patch: Partial<GeneratedAgentForm>) => {
    setForms((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  }

  /** 字符串数组字段的勾选开关 */
  const toggleIn = (index: number, field: 'skills' | 'bundledSkills' | 'mcpServers' | 'capabilities', value: string) => {
    const form = forms[index]
    if (!form) return
    const list = form[field] as string[]
    const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
    updateForm(index, { [field]: next } as Partial<GeneratedAgentForm>)
  }

  /** 未被勾选的 MCP 服务，其全部工具进该 Agent 的工具黑名单 */
  const disabledMcpTools = (form: GeneratedAgentForm): string[] => {
    const chosen = new Set(form.mcpServers ?? [])
    return mcpServers.filter((s) => !chosen.has(s.name)).flatMap((s) => s.tools)
  }

  /** 落库单个 Agent：fork 模板 → 一次写入全部配置 */
  const persistAgent = async (form: GeneratedAgentForm): Promise<string> => {
    const templateId = systemAgents[0]?.id
    if (!templateId) throw new Error('暂无可用的系统 Agent 模板')

    const created = await forkAgent(templateId, {
      name: form.name,
      description: form.description,
      systemPrompt: form.systemPrompt,
    })
    const newAgentId = created.id
    if (!newAgentId) throw new Error('Fork Agent 未返回有效 id')

    const skillBlacklist = [
      ...capabilitiesToSkillBlacklist(new Set(form.capabilities), capabilityOptions),
      ...disabledMcpTools(form),
    ]

    // AI 返回的是技能 id，skillFilter 侧按 name 存（编辑页以 name 匹配）
    const skillIdToName = new Map(userSkills.map((s) => [s.id, s.name]))
    const skillFilterNames = (form.skills ?? [])
      .map((id) => skillIdToName.get(id))
      .filter((n): n is string => !!n)
    // bundledSkills 按 ID 存（与主进程 skillKey 对齐），丢掉 AI 编造的未安装技能
    const bundledSkills = form.bundledSkills.filter((id) => installedSkillIds.has(id))
    const triggerExamples = form.triggerExamples.map((t) => t.trim()).filter(Boolean)

    await updateAgent(newAgentId, {
      systemPrompt: form.systemPrompt,
      description: form.groupId
        ? encodeGroupToDescription(form.description, form.groupId, form.groupName, form.groupRole)
        : form.description,
      skillBlacklist: skillBlacklist.length > 0 ? skillBlacklist : null,
      skillFilter: skillFilterNames.length > 0 ? skillFilterNames : null,
      whenToUse: form.whenToUse.trim() || null,
      triggerExamples: triggerExamples.length > 0 ? triggerExamples : null,
      bundledSkills: bundledSkills.length > 0 ? bundledSkills : null,
    })

    return newAgentId
  }

  const handleCreateAll = async () => {
    setIsCreating(true)

    for (let i = 0; i < forms.length; i++) {
      if (forms[i].status === 'success') continue
      updateForm(i, { status: 'creating' })
      try {
        const id = await persistAgent(forms[i])
        updateForm(i, { id, status: 'success' })
      } catch {
        updateForm(i, { status: 'error' })
      }
    }

    setIsCreating(false)
    setTimeout(() => onComplete(), 800)
  }

  const handleRemove = (index: number) => {
    const next = forms.filter((_, i) => i !== index)
    setForms(next)
    setSelectedIndex((cur) => Math.max(0, Math.min(cur > index ? cur - 1 : cur, next.length - 1)))
  }

  const remaining = forms.filter((f) => f.status !== 'success').length

  return (
    <div className={styles.stepContainer}>
      <div className={styles.stepHeader}>
        <h3 className={styles.stepTitle}>确认并创建 Agent</h3>
        <p className={styles.stepDesc}>
          左侧选角色，右侧核对配置；不需要的角色可以移除（共 {forms.length} 个，待创建 {remaining} 个）
        </p>
      </div>

      <div className={styles.stepContent}>
        <div className={styles.reviewSplit}>
          {/* 左：角色列表 */}
          <div className={styles.reviewList}>
            {forms.map((form, index) => (
              <button
                key={`${form.name}-${index}`}
                type="button"
                className={clsx(
                  styles.reviewItem,
                  index === selectedIndex && styles['reviewItem--active'],
                )}
                onClick={() => setSelectedIndex(index)}
              >
                <span className={styles.reviewEmoji}>{form.emoji}</span>
                <span className={styles.reviewMeta}>
                  <span className={styles.reviewName}>{form.name}</span>
                  <span className={styles.reviewGroup}>{form.groupName || '未分组'}</span>
                </span>
                <span
                  className={clsx(styles.reviewStatus, styles[`reviewStatus--${form.status}`])}
                  title={STATUS_LABEL[form.status]}
                >
                  {form.status === 'pending' ? '' : STATUS_LABEL[form.status]}
                </span>
              </button>
            ))}
            {forms.length === 0 && (
              <div className={styles.hint}>没有待创建的角色，返回上一步重新生成</div>
            )}
          </div>

          {/* 右：选中角色的配置 */}
          <div className={styles.reviewDetail}>
            {current ? (
              <>
                <div className={styles.agentEditField}>
                  <label className={styles.editLabel}>名称</label>
                  <input
                    className={styles.editInput}
                    value={current.name}
                    onChange={(e) => updateForm(selectedIndex, { name: e.target.value })}
                    disabled={!editable}
                  />
                </div>

                <div className={styles.agentEditField}>
                  <label className={styles.editLabel}>描述</label>
                  <input
                    className={styles.editInput}
                    value={current.description}
                    onChange={(e) => updateForm(selectedIndex, { description: e.target.value })}
                    disabled={!editable}
                  />
                </div>

                <div className={styles.agentEditField}>
                  <label className={styles.editLabel}>系统提示词</label>
                  <textarea
                    className={styles.editTextarea}
                    value={current.systemPrompt}
                    onChange={(e) => updateForm(selectedIndex, { systemPrompt: e.target.value })}
                    rows={6}
                    disabled={!editable}
                  />
                </div>

                <div className={styles.agentEditField}>
                  <label className={styles.editLabel}>何时使用</label>
                  <input
                    className={styles.editInput}
                    value={current.whenToUse}
                    placeholder="用户想要…时"
                    onChange={(e) => updateForm(selectedIndex, { whenToUse: e.target.value })}
                    disabled={!editable}
                  />
                </div>

                <div className={styles.agentEditField}>
                  <label className={styles.editLabel}>触发例子</label>
                  <textarea
                    className={styles.editTextarea}
                    value={current.triggerExamples.join('\n')}
                    placeholder={'每行一个用户可能说的原话'}
                    // 保留空行/行尾空格，否则受控值会把刚敲下的换行吞掉，用户加不出第二行
                    onChange={(e) =>
                      updateForm(selectedIndex, { triggerExamples: e.target.value.split('\n') })
                    }
                    rows={3}
                    disabled={!editable}
                  />
                </div>

                <div className={styles.agentEditField}>
                  <label className={styles.editLabel}>可用技能（该角色能调用的技能）</label>
                  {userSkills.length === 0 ? (
                    <div className={styles.hint}>暂无已安装技能</div>
                  ) : (
                    <div className={styles.checkList}>
                      {userSkills.map((skill) => {
                        const checked = current.skills.includes(skill.id)
                        return (
                          <label
                            key={skill.id}
                            className={clsx(styles.checkItem, checked && styles['checkItem--on'])}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!editable}
                              onChange={() => toggleIn(selectedIndex, 'skills', skill.id)}
                            />
                            <span className={styles.checkBody}>
                              <span className={styles.checkLabel}>
                                {skill.name}
                                <span className={styles.checkRaw}>{skill.id}</span>
                              </span>
                              {skill.description && (
                                <span className={styles.checkDesc}>{skill.description}</span>
                              )}
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  )}
                </div>

                <div className={styles.agentEditField}>
                  <label className={styles.editLabel}>可用能力（工具面）</label>
                  <div className={styles.checkList}>
                    {capabilityOptions.map((cap) => {
                      const checked = current.capabilities.includes(cap.id)
                      return (
                        <label
                          key={cap.id}
                          className={clsx(styles.checkItem, checked && styles['checkItem--on'])}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!editable}
                            onChange={() => toggleIn(selectedIndex, 'capabilities', cap.id)}
                          />
                          <span className={styles.checkBody}>
                            <span className={styles.checkLabel}>
                              {cap.label}
                              <span className={styles.checkRaw}>{cap.toolNames.join(' ')}</span>
                            </span>
                            <span className={styles.checkDesc}>{cap.description}</span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </div>

                <div className={styles.agentEditField}>
                  <label className={styles.editLabel}>MCP 服务（外部系统的连接）</label>
                  {mcpServers.length === 0 ? (
                    <div className={styles.hint}>当前没有启用任何 MCP 服务（可在「设置 → MCP」里添加）</div>
                  ) : (
                    <div className={styles.checkList}>
                      {mcpServers.map((server) => {
                        const checked = (current.mcpServers ?? []).includes(server.name)
                        return (
                          <label
                            key={server.name}
                            className={clsx(styles.checkItem, checked && styles['checkItem--on'])}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!editable}
                              onChange={() => toggleIn(selectedIndex, 'mcpServers', server.name)}
                            />
                            <span className={styles.checkBody}>
                              <span className={styles.checkLabel}>
                                {server.name}
                                <span className={styles.checkRaw}>
                                  {server.tools.length} 个工具
                                </span>
                              </span>
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  )}
                </div>

                <div className={styles.agentEditField}>
                  <label className={styles.editLabel}>常驻技能（启动即自动激活）</label>
                  {userSkills.length === 0 ? (
                    <div className={styles.hint}>暂无已安装技能</div>
                  ) : (
                    <div className={styles.skillChips}>
                      {userSkills.map((skill) => {
                        const checked = current.bundledSkills.includes(skill.id)
                        return (
                          <button
                            key={skill.id}
                            type="button"
                            className={clsx(styles.skillChip, checked && styles.skillChipChecked)}
                            onClick={() => toggleIn(selectedIndex, 'bundledSkills', skill.id)}
                            disabled={!editable}
                          >
                            {checked ? '✓ ' : ''}
                            {skill.name}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  className={styles.removeAgentBtn}
                  onClick={() => handleRemove(selectedIndex)}
                  disabled={isCreating || current.status === 'creating'}
                >
                  <Trash2 size={13} /> 移除这个角色
                </button>
              </>
            ) : (
              <div className={styles.hint}>左侧没有可编辑的角色</div>
            )}
          </div>
        </div>
      </div>

      <div className={styles.stepFooter}>
        <button
          className={styles.backButton}
          onClick={onBack}
          disabled={isCreating}
          type="button"
        >
          上一步
        </button>
        <span className={styles.stepIndicator}>3 / 3</span>
        <button
          className={styles.createButton}
          onClick={handleCreateAll}
          disabled={isCreating || forms.length === 0 || remaining === 0}
          type="button"
        >
          {isCreating ? '创建中...' : `创建全部 Agent（${remaining}）`}
        </button>
      </div>
    </div>
  )
}
