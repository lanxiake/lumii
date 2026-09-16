import React, { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import styles from '../../AgentsPage.module.css'
import type { AgentFormData, UserSkill } from '../../AgentsPage.types'
import type { McpServerOption } from '../GenerateTeamWizard/types'
import { runAgentJsonTask } from '../../../../services/agent-json-task'
import {
  buildAgentRoutingPrompt,
  parseJsonObject,
  type GeneratedRoutingFields,
} from '../GenerateTeamWizard/utils'
import { Sparkles } from 'lucide-react'

export interface AgentRoutingFieldsProps {
  /** 完整表单数据：AI 自动填写要把名称/描述/提示词作为上下文 */
  value: AgentFormData
  onChange: (patch: Partial<AgentFormData>) => void
  mode: 'edit' | 'create'
  /** 已安装技能：绑定技能勾选项 + AI 推荐范围 */
  userSkills: UserSkill[]
  /** 已启用的 MCP 服务：勾选项 + AI 推荐范围 */
  mcpServers: McpServerOption[]
}

/**
 * Pre-LLM Router 路由信号字段（whenToUse / triggerExamples / bundledSkills），编辑与新建 Modal 共用。
 * 三项都可由「AI 自动填写」按当前名称/描述/提示词生成；绑定技能与「可用能力」同款勾选交互。
 */
export const AgentRoutingFields: React.FC<AgentRoutingFieldsProps> = ({
  value,
  onChange,
  mode,
  userSkills,
  mcpServers,
}) => {
  const isCreate = mode === 'create'
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const taskRef = useRef<{ cancel: () => void } | null>(null)

  useEffect(() => () => taskRef.current?.cancel(), [])

  const installedIds = new Set(userSkills.map((s) => s.id))
  // 本机未安装但已绑定的技能：保留展示，避免保存时被静默丢掉
  const orphanBundled = value.bundledSkills.filter((id) => !installedIds.has(id))

  const toggleBundled = (skillId: string) => {
    const next = value.bundledSkills.includes(skillId)
      ? value.bundledSkills.filter((id) => id !== skillId)
      : [...value.bundledSkills, skillId]
    onChange({ bundledSkills: next })
  }

  const toggleMcp = (serverName: string) => {
    const next = value.mcpServers.includes(serverName)
      ? value.mcpServers.filter((n) => n !== serverName)
      : [...value.mcpServers, serverName]
    onChange({ mcpServers: next })
  }

  /** 按当前表单内容让 AI 生成三项路由信号 */
  const handleAutoFill = useCallback(() => {
    if (generating || !value.name.trim()) return
    taskRef.current?.cancel()
    setGenerating(true)
    setGenError(null)

    const task = runAgentJsonTask<GeneratedRoutingFields>({
      title: 'Agent 路由字段生成',
      prompt: buildAgentRoutingPrompt(
        {
          name: value.name,
          description: value.description,
          systemPrompt: value.systemPrompt,
          category: value.category,
          selectedSkills: value.selectedSkills,
        },
        userSkills,
        mcpServers,
      ),
      parse: parseJsonObject<GeneratedRoutingFields>,
    })
    taskRef.current = task

    task.done
      .then((data) => {
        taskRef.current = null
        setGenerating(false)
        // 只回填 AI 确实产出的字段：生成期间用户手改的内容、以及 AI 没给出的项都保持原样
        const patch: Partial<AgentFormData> = {}
        if (typeof data.whenToUse === 'string' && data.whenToUse.trim()) {
          patch.whenToUse = data.whenToUse.trim()
        }
        if (Array.isArray(data.triggerExamples)) {
          const examples = data.triggerExamples
            .map((item) => String(item).trim())
            .filter(Boolean)
          if (examples.length > 0) patch.triggerExamples = examples.join('\n')
        }
        if (Array.isArray(data.bundledSkills)) {
          // AI 可能编造未安装的技能 ID，一律丢掉；全被丢掉时保持原选择
          const recommended = data.bundledSkills.filter((id) => installedIds.has(id))
          if (recommended.length > 0) {
            // 已安装技能按 AI 推荐重选；本机没装的 AI 也看不到，原样保留，别静默丢掉
            const orphans = value.bundledSkills.filter((id) => !installedIds.has(id))
            patch.bundledSkills = [...new Set([...recommended, ...orphans])]
          }
        }
        if (Array.isArray(data.mcpServers)) {
          // 同上：AI 编造的 server 名丢掉；一个都没推荐上就保持原选择
          const available = new Set(mcpServers.map((s) => s.name))
          const picked = data.mcpServers.filter((name) => available.has(name))
          if (picked.length > 0) patch.mcpServers = picked
        }
        if (Object.keys(patch).length > 0) onChange(patch)
      })
      .catch((err: Error) => {
        taskRef.current = null
        setGenerating(false)
        setGenError(err.message)
      })
  }, [generating, installedIds, mcpServers, onChange, userSkills, value])

  const autoFillDisabled = generating || !value.name.trim()

  return (
    <>
      {/* ─── Pre-LLM Router 路由信号（v2） ─── */}
      <div className={styles['routing-actions']}>
        <button
          type="button"
          className={styles['ai-fill-btn']}
          onClick={handleAutoFill}
          disabled={autoFillDisabled}
          title={
            value.name.trim()
              ? '按名称、描述和系统提示词生成下方三项'
              : '先填写名称，AI 才能生成路由信号'
          }
        >
          <Sparkles size={12} />
          {generating ? 'AI 生成中…' : 'AI 自动填写'}
        </button>
        <span className={styles['form-hint']}>
          生成「何时使用 / 触发例子 / 绑定技能」，可再手工修改
        </span>
      </div>
      {genError && <div className={styles['ai-fill-error']}>生成失败：{genError}</div>}

      <div className={styles['form-field']}>
        <label className={styles['form-label']}>
          🔀 何时使用 (whenToUse)
          <span className={styles['form-hint-inline']}>填写后可显著提升路由准确率</span>
        </label>
        <textarea
          className={styles['form-textarea']}
          value={value.whenToUse}
          onChange={(e) => onChange({ whenToUse: e.target.value })}
          placeholder={isCreate ? '例："用户想要写代码、调试或重构时"' : '用户视角描述。例："用户想要写代码、调试或重构时"'}
          rows={2}
        />
      </div>

      <div className={styles['form-field']}>
        <label className={styles['form-label']}>触发例子 (triggerExamples)</label>
        <textarea
          className={styles['form-textarea']}
          value={value.triggerExamples}
          onChange={(e) => onChange({ triggerExamples: e.target.value })}
          placeholder={
            isCreate
              ? '每行一个用户可能说的原话，例如：\n帮我写个函数\n这段代码有 bug'
              : '用户可能说的原话，每行一句。例如：\n帮我写个函数\n这段代码有 bug'
          }
          rows={3}
        />
        {!isCreate && <div className={styles['form-hint']}>每行一个例子，建议 3-10 条。</div>}
      </div>

      <div className={styles['form-field']}>
        <label className={styles['form-label']}>
          绑定技能 (bundledSkills)
          <span className={styles['form-hint-inline']}>Agent 启动时自动激活这些技能，无需再搜索</span>
        </label>
        {userSkills.length === 0 && orphanBundled.length === 0 ? (
          <div className={styles['skill-empty-hint']}>暂无已安装技能，可在技能页面创建</div>
        ) : (
          <div className={styles['skill-list']}>
            {userSkills.map((skill) => {
              const checked = value.bundledSkills.includes(skill.id)
              return (
                <label
                  key={skill.id}
                  className={clsx(styles['skill-item'], checked && styles['skill-item--checked'])}
                >
                  <input
                    type="checkbox"
                    className={styles['skill-checkbox']}
                    checked={checked}
                    onChange={() => toggleBundled(skill.id)}
                  />
                  <div className={styles['skill-info']}>
                    <span className={styles['skill-name']}>{skill.name}</span>
                    {skill.description && (
                      <span className={styles['skill-desc']}>{skill.description}</span>
                    )}
                  </div>
                </label>
              )
            })}
            {orphanBundled.map((id) => (
              <label key={id} className={styles['skill-item']}>
                <input
                  type="checkbox"
                  className={styles['skill-checkbox']}
                  checked
                  onChange={() => toggleBundled(id)}
                />
                <div className={styles['skill-info']}>
                  <span className={styles['skill-name']}>{id}</span>
                  <span className={styles['skill-desc']}>本机未安装，取消勾选可移除</span>
                </div>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className={styles['form-field']}>
        <label className={styles['form-label']}>
          MCP 服务
          <span className={styles['form-hint-inline']}>该 Agent 可连接的外部系统；未勾选的服务会被禁用</span>
        </label>
        {mcpServers.length === 0 ? (
          <div className={styles['skill-empty-hint']}>当前没有启用任何 MCP 服务（可在「设置 → MCP」里添加）</div>
        ) : (
          <div className={styles['skill-list']}>
            {mcpServers.map((server) => {
              const checked = value.mcpServers.includes(server.name)
              return (
                <label
                  key={server.name}
                  className={clsx(styles['skill-item'], checked && styles['skill-item--checked'])}
                >
                  <input
                    type="checkbox"
                    className={styles['skill-checkbox']}
                    checked={checked}
                    onChange={() => toggleMcp(server.name)}
                  />
                  <div className={styles['skill-info']}>
                    <span className={styles['skill-name']}>
                      {server.name}
                      <span className={styles['skill-raw']}>{server.tools.length} 个工具</span>
                    </span>
                  </div>
                </label>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
