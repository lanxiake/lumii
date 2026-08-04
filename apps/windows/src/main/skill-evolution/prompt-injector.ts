/**
 * System Prompt 进化指引注入
 */

export const SKILLS_EVOLUTION_GUIDANCE = `
## 技能记录指引

完成以下情况后，主动考虑是否需要记录为可复用技能：
- 完成了包含 5 次以上工具调用的复杂任务
- 解决了一个棘手的错误或问题
- 发现了一个非显而易见的工作流程

使用某个技能后，如果发现它已过时、不完整或有误，立即标记需要更新，不要等用户提醒。
未被维护的技能会成为负担。
`

export function injectEvolutionGuidance(systemPrompt: string): string {
  return systemPrompt + '\n\n' + SKILLS_EVOLUTION_GUIDANCE
}

/**
 * 将进化指引注入到 SystemPromptResult 的 staticPrompt 中，返回新对象。
 * 使用对象展开而非 readonly 强制转换，保持类型安全。
 */
export function injectEvolutionGuidanceIntoResult<T extends { staticPrompt: string; dynamicPrompt: string; fullPrompt: string }>(
  result: T,
): T {
  const newStatic = injectEvolutionGuidance(result.staticPrompt)
  return {
    ...result,
    staticPrompt: newStatic,
    fullPrompt: newStatic + result.dynamicPrompt,
  }
}
