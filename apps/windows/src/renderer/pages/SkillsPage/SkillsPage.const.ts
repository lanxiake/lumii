/** 工具分类中文标签 */
export const CATEGORY_LABELS: Record<string, string> = {
  filesystem: '文件工具',
  shell: 'Shell 工具',
  web: '网络工具',
  memory: '记忆工具',
  agent: 'Agent 工具',
  channel: 'MCP 工具',
}

/** 工具分类排序权重（数字越小越靠前） */
export const CATEGORY_ORDER: Record<string, number> = {
  filesystem: 1,
  shell: 2,
  web: 3,
  agent: 4,
  memory: 5,
  channel: 6,
}
