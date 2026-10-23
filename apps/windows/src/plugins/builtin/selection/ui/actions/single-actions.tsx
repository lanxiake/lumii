/**
 * L2 动作：直连单轮 LLM，结果进就地气泡。
 *
 * 与 local-actions 平级（注册表按同样的方式并进来）。提示词不在这里 ——
 * 通道只传 action，提示词在主进程（selection-prompts.ts）。
 */

import { Languages, Lightbulb, ListChecks, Sparkles } from 'lucide-react'
import { runSingleAction } from '../bubble-store'
import type { SelectionAction } from './types'

/**
 * 浮条排序的由来（见 local-actions 的注释）：0 引用 / 30 复制，
 * 10 与 20 留给浮条上最常用的翻译与解释；总结与润色只在右键菜单里。
 */
export const singleActions: readonly SelectionAction[] = [
  {
    id: 'translate',
    label: '翻译',
    icon: <Languages size={14} />,
    surface: 'both',
    barOrder: 10,
    tier: 'single',
    run: (ctx) => runSingleAction('translate', ctx.text, ctx.anchorRect),
  },
  {
    id: 'explain',
    label: '解释',
    icon: <Lightbulb size={14} />,
    surface: 'both',
    barOrder: 20,
    tier: 'single',
    run: (ctx) => runSingleAction('explain', ctx.text, ctx.anchorRect),
  },
  {
    id: 'summarize',
    label: '总结',
    icon: <ListChecks size={14} />,
    surface: 'menu',
    tier: 'single',
    run: (ctx) => runSingleAction('summarize', ctx.text, ctx.anchorRect),
  },
  {
    id: 'polish',
    label: '润色',
    icon: <Sparkles size={14} />,
    surface: 'menu',
    tier: 'single',
    run: (ctx) => runSingleAction('polish', ctx.text, ctx.anchorRect),
  },
]
