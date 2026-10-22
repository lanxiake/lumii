/**
 * 技能改进器 — 调用 LLM 生成局部 Patch 方案
 */

import type { LLMCaller } from './types'

export interface ImprovementProposal {
  patchOldString: string        // 要替换的原始内容片段
  patchNewString: string        // 替换后的新内容
  naturalLanguageDiff: string   // 用户友好描述
}

function buildImprovementPrompt(currentSkillMd: string, userFeedback: string): string {
  return `用户对以下技能的执行结果不满意，请生成最小化的局部修改方案，输出 JSON（不要有任何额外文字，只输出 JSON）：
{
  "patchOldString": "需要替换的原始文本片段（精确匹配，不超过3行）",
  "patchNewString": "替换后的新文本",
  "naturalLanguageDiff": "用一句话描述改了什么（< 30 字，格式：把[原内容]改成[新内容]）"
}

约束：
- patchOldString 必须是 SKILL.md 中的精确子串
- 只改有问题的部分，保持整体结构不变
- 如果问题涉及多处，只改最关键的一处，其余下次再改

用户反馈："${userFeedback}"
当前技能内容：
${currentSkillMd}`
}

function parseProposal(raw: string): ImprovementProposal | null {
  try {
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/)
    const jsonStr = jsonMatch ? jsonMatch[1] : raw
    const parsed = JSON.parse(jsonStr)
    if (
      typeof parsed.patchOldString === 'string' &&
      typeof parsed.patchNewString === 'string' &&
      typeof parsed.naturalLanguageDiff === 'string'
    ) {
      return parsed as ImprovementProposal
    }
    return null
  } catch {
    return null
  }
}

export async function proposeImprovement(
  currentSkillMd: string,
  userFeedback: string,
  callLLM: LLMCaller,
): Promise<ImprovementProposal> {
  const prompt = buildImprovementPrompt(currentSkillMd, userFeedback)
  const raw = await callLLM(prompt)
  const proposal = parseProposal(raw)
  if (!proposal) {
    throw new Error('LLM 返回格式无效，无法解析 ImprovementProposal')
  }
  return proposal
}
