import React from 'react'
import { Search, Globe, FileText, FilePen, Terminal, CheckSquare, GitBranch, Clock } from 'lucide-react'
import type { ModelTier } from '../../services/agent-service'
import type { CapabilityOption, ModelTierOption } from './AgentsPage.types'

// 工具名称与 bridge.ts 内 ALL_BUILT_IN_TOOL_CONFIGS 保持一致
export const CAPABILITY_OPTIONS: CapabilityOption[] = [
  {
    id: 'web_search',
    label: '联网搜索',
    description: '可以搜索互联网获取最新信息',
    toolNames: ['web_search'],
    icon: <Search size={14} />,
  },
  {
    id: 'web_fetch',
    label: '访问网页',
    description: '可以打开和阅读网页内容',
    toolNames: ['web_fetch'],
    icon: <Globe size={14} />,
  },
  {
    id: 'file_read',
    label: '读取文件',
    description: '可以读取设备上的文件和目录',
    toolNames: ['file_read', 'list_dir', 'glob', 'grep'],
    icon: <FileText size={14} />,
  },
  {
    id: 'file_write',
    label: '修改文件',
    description: '可以创建、编辑、移动和复制设备上的文件',
    toolNames: ['file_write', 'file_edit', 'file_mkdir', 'file_move', 'file_copy'],
    icon: <FilePen size={14} />,
  },
  {
    id: 'exec',
    label: '执行命令',
    description: '可以在设备上运行程序或命令',
    toolNames: ['bash'],
    icon: <Terminal size={14} />,
  },
  {
    id: 'task_tracking',
    label: '任务追踪',
    description: '会话内临时任务清单，追踪多步骤进度；会话结束后自动清空',
    toolNames: ['todo_write'],
    icon: <CheckSquare size={14} />,
  },
  {
    id: 'agent_delegation',
    label: '协调子 Agent',
    description: '可以委派其他 Agent 并行处理子任务',
    toolNames: ['spawn_agent', 'send_message'],
    icon: <GitBranch size={14} />,
  },
  {
    id: 'scheduling',
    label: '定时任务',
    description: '可以创建定时提醒和计划任务',
    toolNames: ['cron_create', 'cron_list', 'cron_delete'],
    icon: <Clock size={14} />,
  },
]

export function capabilitiesToSkillBlacklist(enabledIds: Set<string>): string[] {
  const blacklist: string[] = []
  for (const cap of CAPABILITY_OPTIONS) {
    if (!enabledIds.has(cap.id)) {
      blacklist.push(...cap.toolNames)
    }
  }
  return blacklist
}

export function skillBlacklistToCapabilityIds(blacklist: string[] | undefined): Set<string> {
  if (!blacklist || blacklist.length === 0) {
    return new Set(CAPABILITY_OPTIONS.map((c) => c.id))
  }
  const blackSet = new Set(blacklist)
  const enabled = new Set<string>()
  for (const cap of CAPABILITY_OPTIONS) {
    // 只要黑名单中不包含该能力的任意工具，则视为已启用
    if (!cap.toolNames.every((t) => blackSet.has(t))) {
      enabled.add(cap.id)
    }
  }
  return enabled
}

export const MODEL_TIER_OPTIONS: ModelTierOption[] = [
  {
    value: 'basic',
    label: '基础',
    description: '速度快、成本低，适合简单任务',
  },
  {
    value: 'balanced',
    label: '均衡',
    description: '速度与能力兼顾，适合大多数任务',
  },
  {
    value: 'performance',
    label: '性能',
    description: '最强推理能力，适合复杂任务',
  },
]

export function defaultCapabilities(): Set<string> {
  return new Set(CAPABILITY_OPTIONS.map((c) => c.id))
}

export const DEFAULT_MODEL_TIER: ModelTier = 'basic'
