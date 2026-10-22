/**
 * virtual-human-context - 虚拟人 Prompt 上下文解析（主进程）
 *
 * 设计依据：06 号文档 §5、07 号计划 §3.1 (5.1)、08 号 ADR-14
 *
 * 主进程自 registry + pet-mode-store 解析 VirtualHumanPromptContext（单一数据源，
 * 渲染层不回传 emotionMap）。voice-service.startCall 检测 pet 模式时调用本函数，
 * 把结果挂到 session 级激活态，BridgePromptComposer 据此注入表情/动作/persona 段。
 */

import {
  type VirtualHumanPromptContext,
  type VirtualHumanMotionAction,
} from '../../shared/virtual-human'
import { getVirtualHumanSettings } from './pet-mode-store'
import { getPetModelConfig, resolveModelMotionActions } from './pet-model-resolver'

const log = {
  info: (...args: unknown[]) => console.log('[vh]', ...args),
  warn: (...args: unknown[]) => console.warn('[vh]', ...args),
}

/**
 * 若当前处于虚拟人（pet）模式，解析当前模型的 VH 上下文并按 sessionKey 激活。
 * 文字发送（pet:activate-virtual-human-context）与语音 startCall 共用，确保两条
 * 链路都能注入表情/persona 段。非 pet 模式或解析失败时静默跳过。
 *
 * 动态 import 规避循环依赖（pet-mode-ipc → pet-window-manager → voice-service）。
 */
export async function activateVirtualHumanContextForSession(
  sessionKey: string,
): Promise<void> {
  if (!sessionKey) return
  try {
    const { getPetWindowManager } = await import('./pet-mode-ipc')
    const mgr = getPetWindowManager()
    if (!mgr || mgr.getMode() !== 'pet') return

    const { activateVirtualHumanContext } = await import('./virtual-human-activation')
    const ctx = await resolveVirtualHumanContext(mgr.getCurrentModelId())
    if (ctx) activateVirtualHumanContext(sessionKey, ctx)
  } catch (err) {
    log.warn(`[activateVirtualHumanContextForSession] 跳过: ${(err as Error).message}`)
  }
}

/**
 * 从 registry + store 解析虚拟人 Prompt 上下文。
 * @param modelId 当前虚拟人模型 ID（空取 registry 默认）
 * @returns 解析后的上下文；模型不存在或表情/动作开关全关时返回 null。
 */
export async function resolveVirtualHumanContext(
  modelId: string,
): Promise<VirtualHumanPromptContext | null> {
  const config = (await getPetModelConfig(modelId)) as Record<string, unknown> | null
  if (!config) {
    log.warn(`[resolveVirtualHumanContext] 未找到模型配置 modelId=${modelId}`)
    return null
  }

  const settings = getVirtualHumanSettings()
  const emotionMap = (config.emotionMap as Record<string, number>) ?? {}
  const emotionKeys = Object.keys(emotionMap)

  // 模型级 toolPrompts 与用户设置取交集：模型显式关闭则不注入
  const modelTools = config.toolPrompts as { expression?: boolean; thinkTag?: boolean } | undefined
  const enableExpressionPrompt =
    settings.enableExpressionPrompt && (modelTools?.expression ?? true)
  const enableThinkTagPrompt =
    settings.enableThinkTagPrompt && (modelTools?.thinkTag ?? false)

  // 解析模型可触发动作（注册表精选 / model3.json 自动编号）。
  // [motion:tag] 是「标签驱动虚拟人形体」能力，与表情标签同源（enableExpressionPrompt，默认开），
  // 不再绑定 enableThinkTagPrompt（神态/心理描写是纯文本旁白，与真实动作播放是两回事，须解耦）。
  // 否则默认设置下（expr=true、think=false）动作永不注入提示词，模型不知道有动作可触发。
  let motionActions: VirtualHumanMotionAction[] = []
  if (enableExpressionPrompt) {
    const resolved = await resolveModelMotionActions(config)
    motionActions = resolved.map((a) => ({ tag: a.tag, description: a.description }))
  }

  const ctx: VirtualHumanPromptContext = {
    modelId: config.id as string,
    modelName: (config.name as string) ?? (config.id as string),
    emotionKeys,
    motionActions,
    personaAddon: config.personaAddon as string | undefined,
    enableExpressionPrompt,
    enableThinkTagPrompt,
  }

  log.info(
    `[resolveVirtualHumanContext] modelId=${ctx.modelId} emotions=${emotionKeys.length} motions=${motionActions.length} expr=${enableExpressionPrompt} think=${enableThinkTagPrompt}`,
  )
  return ctx
}

/**
 * 把虚拟人上下文渲染为 system prompt dynamic 段落（中文模板）。
 * 注入内容进 CACHE_BOUNDARY_MARKER 之后，模型切换时可刷新而不动静态骨架。
 *
 * @returns Markdown 文本；无可注入内容时返回空串。
 */
export function renderVirtualHumanPromptSection(
  ctx: VirtualHumanPromptContext,
): string {
  const parts: string[] = []

  // 模式说明：让模型明确当前处于虚拟人对话，而非普通文本 Chat。
  // 注意：这里只交代"回复会驱动 Live2D"，不催促模型加标签——催促会导致简单问答也堆一串
  // [emotion]/[motion]/<vh_action>（滥用）。标签是否出现由下方各段的"克制/宁缺毋滥"规则决定。
  parts.push(
    [
      '## 宠物模式',
      `你当前以虚拟人「${ctx.modelName}」的形象与用户实时对话。`,
      '你的回复会同步驱动 Live2D 面部表情与口型；请使用自然、口语化的表达，适合朗读与陪伴式交流。',
      '标签（表情/动作/神态）是可选的点缀，不是每句话的义务。默认不加；只有情绪或动作确实明显时才用，且整段回复至多一两个。宁可不加，也不要硬凑。',
    ].join('\n'),
  )

  if (ctx.personaAddon) {
    parts.push(ctx.personaAddon.trim())
  }

  if (ctx.enableExpressionPrompt && ctx.emotionKeys.length > 0) {
    const tagList = ctx.emotionKeys.map((k) => `[${k}]`).join('、')
    parts.push(
      [
        '## 表情控制',
        '在回复中使用方括号标签控制虚拟人面部表情。仅可使用以下标签：',
        tagList,
        '',
        '用法与规则：',
        '- **默认不加**：绝大多数对话（尤其是简单问答、闲聊、陈述）都无需任何标签，虚拟人保持平静即可',
        '- **仅在情绪明显转折时**：只有当这句话的情绪相较上文有明显变化（如由平淡转为惊喜/难过）才加一个标签',
        '- **整段至多一个**：一整轮回复最多出现一个表情标签，不要每句都加，也不要连续堆叠多个',
        '- **如何放置**：标签放在该情绪对应语句的开头，如 [joy]今天真开心！然后继续正常对话',
        '- **对用户不可见**：标签不会被朗读，也不会显示在聊天界面，仅用于驱动虚拟人表情',
        '- **禁止**：不要使用列表外的标签；不要把标签当作正文内容；不要为了"显得生动"而硬加',
        '',
        '示例（正确）：用户问「你在干什么」→ 回复「我在陪你聊天呀，有什么想说的？」（平淡问答，不加任何标签）',
      ].join('\n'),
    )
  }

  if (ctx.enableThinkTagPrompt) {
    parts.push(
      [
        '## 动作与神态',
        '可选：在回复中用 <vh_action>...</vh_action> 包裹动作、神态或内心活动（不会被朗读）。',
        '**克制使用**：仅在动作/神态能明显增色时才用，整段回复至多一次；简单问答、日常闲聊不要用。',
        '示例：<vh_action>*微微歪头*</vh_action>这个问题很有意思呢。',
      ].join('\n'),
    )
  }

  // 模型可触发的真实 Live2D 动作：与神态描写解耦，只要解析到动作即注入（避免模型臆想不存在的动作）
  if (ctx.motionActions.length > 0) {
    const hasSemantic = ctx.motionActions.some((a) => a.description)
    const firstTag = ctx.motionActions[0]!.tag
    const lines: string[] = [
      '## 可触发动作',
      `当前虚拟人「${ctx.modelName}」可做以下肢体动作。用 [motion:标签] 触发真实播放，标签不会被朗读，也不会显示在聊天界面。`,
    ]
    if (hasSemantic) {
      lines.push('可用动作：')
      for (const a of ctx.motionActions) {
        lines.push(`- [motion:${a.tag}]${a.description ? ` — ${a.description}` : ''}`)
      }
    } else {
      // 无语义命名：仅暴露编号，告知模型动作含义未知
      const tagList = ctx.motionActions.map((a) => `[motion:${a.tag}]`).join('、')
      lines.push(`可用动作标签：${tagList}`)
      lines.push('这些动作没有固定语义，是该模型自带的肢体动画（如点头、摆手、转身等）。')
    }
    lines.push(
      '',
      '使用规则：',
      `- **默认不用**：绝大多数回复都不需要动作。只有当某句话的语气/语义与某个动作强烈贴合时才用，整段回复至多 1 个`,
      '- **就近原则**：动作要和它所在位置的那句话语义对应——说到开心的事再放开心动作，打招呼时才放打招呼动作',
      '- **可与表情并列**：如 [joy][motion:' + firstTag + ']太好啦！',
      '- **禁止**：只能用上面列出的标签；本虚拟人没有列表之外的动作（如跳舞、翻跟头），不要声称能做做不到的动作；不要每句都加动作；不要为了"显得活泼"而硬加',
    )
    parts.push(lines.join('\n'))
  }

  return parts.length > 0 ? parts.join('\n\n') : ''
}
