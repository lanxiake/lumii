/**
 * AI 生成 Agent 团队 — 工具函数
 */

import type { QuickTemplate, CapabilityOption, GeneratedAgent, GroupRole } from './types'

/** 将 agents 按 groupId 分组，保持原始顺序（泛型，兼容 GeneratedAgent 和 GeneratedAgentForm） */
export function groupAgents<T extends { groupId?: string; groupName?: string }>(
  agents: T[],
): Array<{ groupId: string; groupName: string; agents: T[] }> {
  const map = new Map<string, { groupName: string; agents: T[] }>()
  for (const agent of agents) {
    const gid = agent.groupId || 'default'
    if (!map.has(gid)) {
      map.set(gid, { groupName: agent.groupName || '默认分组', agents: [] })
    }
    map.get(gid)!.agents.push(agent)
  }
  return Array.from(map.entries()).map(([groupId, v]) => ({ groupId, ...v }))
}

export const GROUP_ROLE_LABELS: Record<GroupRole, string> = {
  coordinator: '协调者',
  executor: '执行者',
  reviewer: '审查者',
}

/** 将分组信息编码到 description 末尾（存储用） */
export function encodeGroupToDescription(description: string, groupId: string, groupName: string, groupRole: GroupRole): string {
  return `${description}\n[group:${groupId}|${groupName}|${groupRole}]`
}

/** 从 description 中解析分组信息，返回纯描述文本 */
export function decodeGroupFromDescription(description: string): {
  cleanDescription: string
  groupId?: string
  groupName?: string
  groupRole?: GroupRole
} {
  const match = description.match(/\n\[group:([^|]+)\|([^|]+)\|([^\]]+)\]$/)
  if (!match) return { cleanDescription: description }
  return {
    cleanDescription: description.slice(0, match.index),
    groupId: match[1],
    groupName: match[2],
    groupRole: match[3] as GroupRole,
  }
}

/**
 * 需要额外配置才能使用的技能（skill name 关键词 → 配置说明）
 * key 为小写关键词，匹配技能 name/id 中包含该词的技能
 */
export const SKILLS_REQUIRING_CONFIG: Record<string, string> = {
  github: '需要在技能设置中配置 GitHub Personal Access Token',
  gitlab: '需要在技能设置中配置 GitLab Access Token',
  jira: '需要在技能设置中配置 Jira API Token 和项目地址',
  notion: '需要在技能设置中配置 Notion Integration Token',
  slack: '需要在技能设置中配置 Slack Bot Token',
  email: '需要在技能设置中配置邮件服务器 SMTP 信息',
  database: '需要在技能设置中配置数据库连接字符串',
  aws: '需要在技能设置中配置 AWS Access Key 和 Secret',
  figma: '需要在技能设置中配置 Figma Personal Access Token',
  linear: '需要在技能设置中配置 Linear API Key',
  confluence: '需要在技能设置中配置 Confluence API Token 和空间地址',
}

/** 检查技能名称是否需要额外配置，返回配置说明或 null */
export function getSkillConfigHint(skillName: string): string | null {
  const lower = skillName.toLowerCase()
  for (const [keyword, hint] of Object.entries(SKILLS_REQUIRING_CONFIG)) {
    if (lower.includes(keyword)) return hint
  }
  return null
}

/** prompt 模板 — {userRequirement}、{skillsSection} 占位符由调用方替换 */
export const TEAM_GENERATION_PROMPT = `你是一个 AI 团队架构师，专门为用户设计高效协作的 AI Agent 团队。

用户需求：{userRequirement}
{skillsSection}
请输出一个 JSON 数组，包含 2-6 个 Agent，每个 Agent 格式如下：
{
  "name": "见名知意的角色名，格式为[领域][角色]，如：代码审查员、需求分析师、数据清洗工程师、SEO内容策划。禁止使用纯英文或过于抽象的词（如'助手'、'专家'）",
  "emoji": "代表该角色职能的emoji",
  "groupId": "所属分组ID（英文小写+连字符，如 dev-core、qa-team），同一分组的Agent协作完成相关任务",
  "groupName": "分组中文名称，如：核心开发组、质量保障组、内容创作组",
  "groupRole": "coordinator（协调者，负责分解任务和汇总结果，每组最多1个）| executor（执行者，负责具体任务）| reviewer（审查者，负责检查和反馈）",
  "description": "30-60字描述，格式：[触发场景]+[核心能力]+[输出效果]。让用户知道何时使用该Agent、使用后能得到什么结果",
  "systemPrompt": "结构化系统提示词，必须包含以下章节：\\n## 角色定位\\n你是[团队名]中的[角色名]，专注于[核心职责]。\\n\\n## 工作职责\\n1. [主要职责1]\\n2. [主要职责2]\\n3. [主要职责3]\\n\\n## 工作方式\\n- 接收任务时：[如何理解和分解任务]\\n- 执行过程中：[工作流程和方法论]\\n- 输出结果时：[输出格式和质量标准]\\n\\n## 协作规范\\n- [与其他角色的协作方式]\\n\\n如果分配了需要配置的技能（如github、jira等），末尾必须加：\\n\\n## ⚠️ 使用前配置\\n[具体说明用户需要先完成哪些配置步骤]",
  "modelTier": "basic（简单问答/格式化任务）| balanced（常规分析/代码生成）| performance（复杂推理/架构设计）",
  "capabilities": ["只填写该Agent真正需要的能力，不要全部填写"],
  "skills": ["从可用技能列表中选择适合该Agent的技能ID，没有合适的填空数组"]
}

capabilities 说明（按需选择，不要全选）：
- web_search: 联网搜索最新信息（需要查询实时数据时才选）
- web_fetch: 访问和读取网页内容（需要抓取网页时才选）
- file_read: 读取文件和目录（需要读取本地文件时才选）
- file_write: 创建和修改文件（需要写入文件时才选）
- exec: 执行命令和脚本（需要运行程序时才选）
- task_tracking: 创建任务列表追踪多步骤进度（复杂多步骤任务时才选）
- agent_delegation: 委派子Agent并行处理（协调者角色才选）
- scheduling: 创建定时提醒和计划（需要定时执行时才选）

分组设计原则：
- 2-3个Agent：可以是单一分组
- 4个以上Agent：应分2-3个功能分组，每组有明确职责边界
- 每组设置1个coordinator负责协调，其余为executor或reviewer
- 分组名称要体现团队结构，如"核心开发组"、"质量保障组"

只返回 JSON 数组，不要任何解释文字。`

/** 团队优化 prompt 模板 */
export const TEAM_OPTIMIZATION_PROMPT = `你是一个 AI 团队优化专家。用户有一支现有的 AI Agent 团队，需要根据新的要求进行优化。

【现有团队】
{existingAgents}

【优化要求】
{optimizationRequirement}

【优化模式】
{optimizationMode}

请输出优化后的 JSON 数组，保持相同的 Agent 数量，每个 Agent 必须包含原有的 "id" 字段。
只修改需要改进的字段，保持其他字段不变。格式与创建时相同，额外包含 "id" 字段。
只返回 JSON 数组，不要任何解释文字。`

/** 构建团队优化 prompt */
export function buildOptimizePrompt(
  existingAgents: Array<{ id: string; name: string; description?: string; systemPrompt?: string }>,
  requirement: string,
  mode: 'regenerate' | 'refine',
): string {
  const agentsJson = JSON.stringify(
    existingAgents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description ?? '',
      systemPrompt: a.systemPrompt ?? '',
    })),
    null,
    2,
  )
  const modeText =
    mode === 'regenerate'
      ? '完全重新生成（可以大幅修改名称、描述、系统提示词）'
      : '追加优化（在现有基础上改进，保持核心职责不变，只优化表达和细节）'

  return TEAM_OPTIMIZATION_PROMPT
    .replace('{existingAgents}', agentsJson)
    .replace('{optimizationRequirement}', requirement)
    .replace('{optimizationMode}', modeText)
}

/** 快速模板 */
export const QUICK_TEMPLATES: QuickTemplate[] = [
  {
    id: 'dev-team',
    label: '软件开发团队',
    description: '产品经理、前后端工程师、测试等',
    content: '我需要一个软件开发团队，包含产品经理、前端工程师、后端工程师、测试工程师和架构师',
  },
  {
    id: 'content-team',
    label: '内容创作团队',
    description: '文案策划、编辑、校对、运营等',
    content: '我需要一个内容创作团队，包含文案策划、内容编辑、校对专家、社交媒体运营和数据分析',
  },
  {
    id: 'data-team',
    label: '数据分析团队',
    description: '数据工程师、分析师、可视化专家等',
    content: '我需要一个数据分析团队，包含数据工程师、数据分析师、业务分析师和数据可视化专家',
  },
]

/** 根据启用的能力 ID 生成 skillBlacklist */
export function capabilitiesToSkillBlacklist(
  enabledIds: Set<string>,
  capabilityOptions: CapabilityOption[],
): string[] {
  const blacklist: string[] = []
  for (const cap of capabilityOptions) {
    if (!enabledIds.has(cap.id)) {
      blacklist.push(...cap.toolNames)
    }
  }
  return blacklist
}

/**
 * 从文本（可能含 markdown fence）中提取并解析 JSON 数组。
 * 支持：纯 JSON、```json ... ```、``` ... ``` 三种格式。
 */
export function parseStreamingJson(text: string): { complete: boolean; data: GeneratedAgent[] | null } {
  try {
    // 剥离 markdown 代码块：```json ... ``` 或 ``` ... ```
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    const candidate = fenceMatch ? fenceMatch[1].trim() : text

    // 提取最外层 JSON 数组
    const arrayMatch = candidate.match(/\[[\s\S]*\]/)
    if (arrayMatch) {
      const data = JSON.parse(arrayMatch[0]) as GeneratedAgent[]
      if (Array.isArray(data) && data.length > 0) {
        return { complete: true, data }
      }
    }
    return { complete: false, data: null }
  } catch {
    return { complete: false, data: null }
  }
}

/** 构建发送给网关的 prompt */
export function buildPrompt(
  requirement: string,
  userSkills: { id: string; name: string; description?: string }[] = [],
): string {
  const skillsSection =
    userSkills.length > 0
      ? `\n【可用技能列表】\n以下是用户已安装的技能，可按需分配给 Agent：\n${userSkills.map((s) => `- ${s.id}: ${s.name}${s.description ? `（${s.description}）` : ''}`).join('\n')}\n`
      : ''

  return TEAM_GENERATION_PROMPT
    .replace('{userRequirement}', requirement)
    .replace('{skillsSection}', skillsSection)
}
