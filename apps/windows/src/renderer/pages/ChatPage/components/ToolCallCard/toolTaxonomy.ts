/**
 * 工具分类：把工具名归入语义家族，供 ToolCallCard 图标与 ToolBatchGroup 批次摘要复用。
 * 分类规则为小写子串匹配，顺序敏感（todo 含 "write"，必须先判）。
 */

export type ToolFamily =
  | 'read'
  | 'search'
  | 'write'
  | 'exec'
  | 'agent'
  | 'todo'
  | 'image'
  | 'other'

/** 将工具名归类为语义家族 */
export function classifyToolFamily(name: string): ToolFamily {
  const n = (name || '').toLowerCase()
  if (n.includes('todo')) return 'todo'
  if (n.includes('read') || n.includes('view')) return 'read'
  if (n.includes('search') || n.includes('grep') || n.includes('glob')) return 'search'
  if (n.includes('write') || n.includes('edit') || n.includes('create')) return 'write'
  if (n.includes('bash') || n.includes('exec') || n.includes('run')) return 'exec'
  if (n.includes('agent') || n.includes('spawn')) return 'agent'
  if (n === 'image_generate') return 'image'
  return 'other'
}
