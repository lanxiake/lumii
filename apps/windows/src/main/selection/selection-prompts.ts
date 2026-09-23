/**
 * 划词 L2 动作的提示词。
 *
 * 放在主进程（而不是动作定义里）：通道契约只传 action，渲染层不持有提示词 ——
 * 提示词要改、要按模型调，都不该要求渲染层跟着发版。
 *
 * 权衡记在这里，免得日后当 bug 修：提示词当前是硬编码的，不能编辑。
 * 与「提示词风格」实验功能的关系是设计 §十一 的开放问题，P1 明确不做。
 */

import type { SelectionLlmAction } from '../../shared/selection-llm-types'

/** 选中文本的包裹标记。用 XML 风格是因为它对模型最不容易歧义 */
const TEXT_OPEN = '<选中文本>'
const TEXT_CLOSE = '</选中文本>'

interface PromptSpec {
  instruction: string
  /**
   * 是否让模型先判方向再输出。
   * 只有翻译需要：目标语言要么跟着源文本走，要么按中英互译的惯例走，
   * 写死任一侧都会在另一侧上翻车。
   */
  detectDirection?: boolean
}

/**
 * 提示词里为什么要写排版要求：
 *
 * 结果落在**气泡**里读（`SelectionResultMarkdown` 会渲染 Markdown），而四挡动作的产出长度
 * 差别极大 —— 短到一个词，长到一屏。不要求结构时，长结果就是一堵字墙：没有标题、没有
 * 分段、重点与正文一样重。所以这里按「要不要长」分别给结构要求，并且**都留了退路**
 * （短文本别硬套标题），免得一个词的译文也长出小标题来。
 */
const SPECS: Record<SelectionLlmAction, PromptSpec> = {
  translate: {
    detectDirection: true,
    instruction: [
      '把选中文本翻译成另一种语言。',
      '目标语言：选中文本以中文为主就译成英文；否则译成中文。',
      `只输出译文本身，不要任何前言、说明或${TEXT_OPEN}标记。`,
      '原文若分段、分点或用了 Markdown 标记，译文保持同样的结构；原文是整段就仍是一整段。',
    ].join('\n'),
  },
  explain: {
    instruction: [
      '解释选中文本的含义。使用与原文一致的语言，不要复述原文。',
      '输出用 Markdown 排版，遵守以下要求：',
      '- 开头一句话给结论，直接说结论，不要「这段话的意思是」这类铺垫；',
      '- 然后分点展开，一点一行；关键的术语或结论用 **加粗** 标出；',
      '- 内容较多时用小标题分组，段落之间空一行；',
      '- 短文本（一两句能说清）就不要加标题、不要分组，别为了排版而排版；',
      '- 不要输出 HTML、代码块或表格。',
    ].join('\n'),
  },
  summarize: {
    instruction: [
      '概括选中文本的要点，最多三条。使用与原文一致的语言。',
      '输出用 Markdown 无序列表，每条一行，每条只承载一个要点；',
      '把最关键的信息用 **加粗** 标出。',
      '不要展开、不要评论、不要加标题。',
    ].join('\n'),
  },
  polish: {
    instruction: [
      '润色选中文本：改通顺、去冗余、订正错别字，保持原意与原语言。',
      '直接给出润色后的完整文本，不要解释改了什么。',
      '保留原文的段落与分行结构：原文是整段，润色后也要是一整段。',
    ].join('\n'),
  },
}

/** 文本里的闭合标记会提前截断包裹；换成一个不会破坏结构的替代字 */
function neutraliseMarkers(text: string): string {
  return text.replaceAll(TEXT_CLOSE, '＜/选中文本＞')
}

/** 按动作拼提示词。空文本由调用方在更外层拦掉（那里能给用户更准的话） */
export function buildSelectionPrompt(action: SelectionLlmAction, text: string): string {
  const spec = SPECS[action]
  const lines = [spec.instruction]

  if (spec.detectDirection) {
    // 判据写死成「出现一组即可判定」，避免模型在短句上纠结
    lines.push(
      '',
      '方向判据：只要看到「的、了、在、是、我、你、他、不、和、有」这类高频中文虚词或汉字，就判为中文。',
    )
  }

  lines.push('', TEXT_OPEN, neutraliseMarkers(text), TEXT_CLOSE)
  return lines.join('\n')
}
