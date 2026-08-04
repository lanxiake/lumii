/**
 * 技能草稿生成器 — 调用 LLM 生成 SKILL.md 草稿与 HumanSummary
 */

import { randomUUID } from 'node:crypto'
import type { ConversationMessage, SkillDraft, LLMCaller } from './types'
import { check } from './skill-quality-gate'

/** 将对话消息压缩为关键步骤摘要（控制 token 量） */
function compressMessages(messages: ConversationMessage[]): string {
  const steps: string[] = []
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.toolName) {
      steps.push(`[工具] ${msg.toolName}`)
    } else if (msg.role === 'assistant') {
      // 只取前 80 字
      const snippet = msg.content.slice(0, 80).replace(/\n/g, ' ')
      if (snippet.trim()) steps.push(`[助手] ${snippet}`)
    } else if (msg.role === 'user') {
      const snippet = msg.content.slice(0, 60).replace(/\n/g, ' ')
      if (snippet.trim()) steps.push(`[用户] ${snippet}`)
    }
  }
  return steps.join('\n')
}

function buildPrompt(compressedSteps: string, existingSkillNames: string[], existingCategories: string[]): string {
  const categoryHint = existingCategories.length > 0
    ? `已有分类（优先复用，也可新建）：${existingCategories.join('、')}`
    : '暂无已有分类，请根据技能内容自行命名分类（中文或英文均可，如"内容创作"、"数据处理"）'

  return `请根据以下对话步骤，输出 JSON（不要有任何额外文字，只输出 JSON）：
{
  "skillMd": "完整的 SKILL.md 内容（frontmatter + 正文，< 40 行）",
  "category": "分类目录名（中文或英文，如"内容创作与发布"）",
  "humanSummary": {
    "title": "简短标题（< 10 字）",
    "scenario": "适用场景（一句话，< 30 字）",
    "steps": ["步骤1", "步骤2"]
  }
}

SKILL.md frontmatter 格式要求：
---
name: kebab-case-name
description: 一句话描述
when_to_use: 适用场景
---

${categoryHint}
已有技能（避免重复）：${existingSkillNames.join(', ') || '无'}
对话步骤：
${compressedSteps}`
}

function parseResponse(raw: string): { skillMd: string; category?: string; humanSummary: { title: string; scenario: string; steps: string[] } } | null {
  try {
    // 提取 JSON 块（LLM 可能包裹在 ```json ... ``` 中）
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/)
    const jsonStr = jsonMatch ? jsonMatch[1] : raw
    return JSON.parse(jsonStr)
  } catch {
    return null
  }
}

export async function draftSkill(
  messages: ConversationMessage[],
  existingSkillNames: string[],
  callLLM: LLMCaller,
  existingCategories: string[] = [],
): Promise<SkillDraft> {
  const compressedSteps = compressMessages(messages)
  const prompt = buildPrompt(compressedSteps, existingSkillNames, existingCategories)
  const raw = await callLLM(prompt)

  const parsed = parseResponse(raw)
  if (!parsed) {
    throw new Error('LLM 返回格式无效，无法解析 SkillDraft')
  }

  const { skillMd, category, humanSummary } = parsed
  const { score } = check(skillMd)

  return {
    id: randomUUID(),
    skillMd,
    category: category?.trim() || undefined,
    humanSummary: {
      title: humanSummary.title ?? '未命名技能',
      scenario: humanSummary.scenario ?? '',
      steps: Array.isArray(humanSummary.steps) ? humanSummary.steps : [],
    },
    qualityScore: score,
    createdAt: new Date().toISOString(),
  }
}
