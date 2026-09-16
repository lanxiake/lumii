/**
 * api-agent-mapper：API 记录 → AgentDefinition
 *
 * 重点覆盖路由信号与常驻技能的映射——这三项一旦漏映射，
 * 用户 Agent 在 AI 团队页里配好的 whenToUse / triggerExamples / bundledSkills 就等于白配。
 */
import { describe, it, expect } from 'vitest'
import { mapApiRecordToAgentDefinition } from '../api-agent-mapper.js'

/** 用户 Agent 经 agents-repo 落盘的记录形态（agents.json 顶层字段） */
function userAgentRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'user-1',
    name: '周报助手',
    description: '汇总一周工作并生成周报',
    systemPrompt: '你是周报助手…',
    userId: 'local-user',
    isEnabled: true,
    skillFilter: ['系统维护手册'],
    skillBlacklist: ['web_search'],
    ...overrides,
  }
}

describe('mapApiRecordToAgentDefinition', () => {
  it('映射路由信号与常驻技能（AI 自动填写/表单配置的落点）', () => {
    const def = mapApiRecordToAgentDefinition(
      userAgentRecord({
        whenToUse: '用户想要写周报、汇总一周工作时',
        triggerExamples: ['帮我写周报', '这周我干了什么'],
        bundledSkills: ['weather', 'coding-agent'],
        category: 'writing',
      }),
    )

    expect(def.whenToUse).toBe('用户想要写周报、汇总一周工作时')
    expect(def.triggerExamples).toEqual(['帮我写周报', '这周我干了什么'])
    expect(def.bundledSkills).toEqual(['weather', 'coding-agent'])
    expect(def.category).toBe('writing')
  })

  it('缺省时路由信号为 undefined，不影响基础字段映射', () => {
    const def = mapApiRecordToAgentDefinition(userAgentRecord())

    expect(def.whenToUse).toBeUndefined()
    expect(def.triggerExamples).toBeUndefined()
    expect(def.bundledSkills).toBeUndefined()
    expect(def.skills).toEqual(['系统维护手册'])
    expect(def.disallowedTools).toEqual(['web_search'])
  })

  it('工具黑名单含 MCP 工具时按原样带出（未勾选的 MCP 服务走这条链路禁用）', () => {
    const def = mapApiRecordToAgentDefinition(
      userAgentRecord({
        skillBlacklist: ['web_search', 'mcp__excel-mcp__read_excel'],
      }),
    )

    expect(def.disallowedTools).toContain('mcp__excel-mcp__read_excel')
  })
})
