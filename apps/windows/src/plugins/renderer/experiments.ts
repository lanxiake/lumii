import type React from 'react'

import { autonomousExperiment } from '../builtin/autonomous/renderer'
import { channelContinuityExperiment } from '../builtin/channel-continuity/renderer'
import { promptStyleExperiment } from '../builtin/prompt-style/renderer'

/**
 * 设置页「实验功能」里由插件提供的条目。
 *
 * 一条 = 列表行（标题 + 摘要）与详情子页。列表页按 `usePluginEnabled(id)` 过滤，
 * **插件禁用后整条消失**，不是灰掉——这正是「前后端一起启停」在 UI 上的样子。
 *
 * 摘要用组件而不是字符串：档位/开关状态是活的（提示词风格要显示「当前：简要」），
 * 而注册时算不出来。
 */
export interface ExperimentEntry {
  /** 与主进程 manifest.id 一致 */
  id: string
  title: string
  /** 列表行右侧的摘要文本 */
  Summary: React.ComponentType
  /** 点进条目后的详情子页 */
  Detail: React.ComponentType<{ onBack: () => void }>
}

export const PLUGIN_EXPERIMENT_ENTRIES: readonly ExperimentEntry[] = [
  promptStyleExperiment,
  channelContinuityExperiment,
  autonomousExperiment,
]
