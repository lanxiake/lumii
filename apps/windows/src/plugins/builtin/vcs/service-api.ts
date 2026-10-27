/**
 * 工作空间版本管理对核心暴露的能力。
 *
 * 核心在回合开始/结束时做快照（用于 diff 与回滚），并允许 Agent 主动打快照。
 * 插件停用 ⇒ 服务消失 ⇒ 快照直接跳过（回合照常跑，只是没有版本可回滚）。
 */
export interface VcsService {
  /** 抓一次工作区指纹（回合开始/结束对比用）；超时返回已抓到的部分 */
  captureTurnSnapshot(workspaceDir: string, timeoutMs?: number): Promise<Map<string, string>>

  /** 有改动才提交一次快照；返回 null 表示无改动或跳过 */
  maybeSnapshot(params: {
    workspaceDir: string
    conversationId?: string
    runId?: string
    /** P2：写入回合→commit 索引；快照排队合并时多个 id 指向同一 oid */
    messageId?: string
  }): Promise<unknown>

  /** 读某个历史版本的文本内容；插件停用/文件不在该提交时为 null */
  readFileAt(workspaceDir: string, oid: string, filepath: string): Promise<string | null>
}
