/**
 * 用户对话消息构建 — 进化流程中注入到对话的自然语言消息
 */

/** 节点2：执行后询问反馈 */
export function buildFeedbackRequest(humanTitle: string): string {
  return `刚才我是按之前记的"${humanTitle}"步骤来的，这次效果怎么样？`
}

/** 节点3第一步：追问具体问题 */
export function buildProblemInquiry(): string {
  return `哪里不对？你说一下，我来改。（不用说得很详细，大概说说就行）`
}

/** 节点3第三步：展示改进方案 */
export function buildImprovementProposal(diff: string): string {
  return `明白了，我改了一下：${diff}。其他步骤没变。这样对吗？`
}

/** 节点3第四步：确认保存 */
export function buildImprovementConfirmed(): string {
  return `好的，我记住了，下次会按新的方式来。`
}

/** 节点4：建议废弃 */
export function buildDeprecationSuggestion(humanTitle: string): string {
  return `这个"${humanTitle}"的步骤我改了好几次，但好像还是不太对。要不先把它删掉？以后遇到类似情况我就临时想，不按固定步骤来了。`
}

/** 新建技能：询问用户是否保存 */
export function buildSkillSavePrompt(title: string, scenario: string, steps: string[]): string {
  const stepList = steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
  return `我注意到刚才完成了一个可复用的工作流，要把它保存为技能吗？

**${title}**
适用场景：${scenario}
步骤：
${stepList}

回复"好的"或"保存"确认，回复"不用"跳过。`
}

/** 新建技能：保存成功通知 */
export function buildSkillCreatedNotice(title: string, category?: string): string {
  const location = category ? `「${category}」分类` : '技能库'
  return `✅ 技能「${title}」已保存到${location}，下次遇到类似任务我会直接用它。`
}

/** 新建技能：用户拒绝保存 */
export function buildSkillRejectedAck(): string {
  return `好的，不保存了。`
}

/** 优化技能：保存成功通知 */
export function buildSkillUpdatedNotice(title: string): string {
  return `✅ 技能「${title}」已更新，下次会按新的方式来。`
}

/** 废弃技能：完成通知 */
export function buildSkillDeprecatedNotice(title: string): string {
  return `✅ 技能「${title}」已废弃，以后不会再用这个步骤了。`
}
