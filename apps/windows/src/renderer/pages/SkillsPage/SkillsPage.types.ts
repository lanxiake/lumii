export interface MySkillDetailInfo {
  skillItemId: string
  isEnabled: boolean
  category: string
  skill: {
    name: string
    description?: string
    version: string
    tags?: string[]
  }
}

/**
 * 标签页类型
 */
export type TabType = 'my-skills' | 'store' | 'tools' | 'mcp'

/**
 * 筛选状态类型
 */
export type FilterStatus = 'all' | 'enabled' | 'disabled'

export interface SkillsPageProps {
  /** Hub 嵌入时收紧 padding */
  embedded?: boolean
  /** 初始 Tab（Hub MCP Tab 用 mcp） */
  initialTab?: TabType
  /** Hub 已把 MCP 提到顶栏时隐藏页内 MCP Tab */
  hideMcpTab?: boolean
  /** 仅展示 MCP Tab 内容（隐藏其它 Tab 导航） */
  mcpOnly?: boolean
}
