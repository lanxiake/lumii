/**
 * SegmentMemoryService — 段落总结记忆的桥接层装配（记忆系统升级阶段① S10 接线）
 *
 * 把 @mtbot/agent-runtime 的 SegmentMemoryPipeline 接进 Windows 客户端：
 * - 每个 agentId 一条 pipeline（记忆按 agent+user 隔离），按需创建并 start（重启恢复）
 * - observe 仅在 user 消息持久化点调用——段边界只在 user 轮评估，段内 assistant 上下文
 *   由 pipeline 的 loadSegmentText 按时间区间回读自动补齐
 * - 灰度：默认关闭（环境变量 MTBOT_SEGMENT_MEMORY=1 开启），关闭时所有方法 no-op，
 *   完全不影响旧逻辑
 *
 * 设计：.qoder/design/client-agent-runtime/2026-05-30-记忆系统升级-段落总结提取设计.md
 */

import { randomUUID } from 'node:crypto'
import {
  SegmentMemoryPipeline,
  type SegmentRepo,
  type ConversationRepo,
  type MemoryManager,
  type ArchivePalaceMeta,
} from '@mtbot/agent-runtime'
import { agentRuntimeLog as log } from './bridge-utils'

const LOCAL_USER_ID = 'local-user'

export interface SegmentMemoryServiceDeps {
  segmentRepo: SegmentRepo
  conversationRepo: ConversationRepo
  memoryManager: MemoryManager
  callLLM: (prompt: string) => Promise<string>
  /**
   * 段原文归档进记忆宫殿（诉求 A · 宫殿互引）。
   * runtime 不可 import 插件，由宿主（持 mempalace MCP client）注入。
   */
  archivePalace?: (text: string, meta: ArchivePalaceMeta) => Promise<{ drawerId?: string }>
}

export interface ObserveUserTurnParams {
  conversationId: string
  agentId: string
  messageId: string
  text: string
}

export class SegmentMemoryService {
  private readonly enabled: boolean
  private readonly pipelines = new Map<string, SegmentMemoryPipeline>()

  constructor(private readonly deps: SegmentMemoryServiceDeps) {
    // 默认开启（无正式用户，直接启用）；如需关闭设 MTBOT_SEGMENT_MEMORY=0
    this.enabled = process.env.MTBOT_SEGMENT_MEMORY !== '0'
    log.info(
      `[SegmentMemoryService] 段落总结记忆 ${this.enabled ? '已启用' : '已关闭(MTBOT_SEGMENT_MEMORY=0)'}`,
    )
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  /** 观察一条 user 消息（在其持久化后调用） */
  observeUserTurn(p: ObserveUserTurnParams): void {
    if (!this.enabled) return
    try {
      this.getPipeline(p.agentId).observe({
        conversationId: p.conversationId,
        userId: LOCAL_USER_ID,
        agentId: p.agentId,
        messageId: p.messageId,
        ts: Date.now(),
        text: p.text,
        role: 'user',
      })
    } catch (err) {
      log.error('[SegmentMemoryService] observeUserTurn 失败:', err)
    }
  }

  /** 强制关闭某会话的 open 段（会话切换/清空/退出前） */
  flush(conversationId: string, reason: string): void {
    if (!this.enabled) return
    for (const pipe of this.pipelines.values()) {
      try {
        pipe.flush(conversationId, reason)
      } catch (err) {
        log.error('[SegmentMemoryService] flush 失败:', err)
      }
    }
  }

  /**
   * 关闭所有会话的残留 open 段（app 退出前调用）。
   * 直接基于 DB 中所有 open 段（按 agentId 创建对应 pipeline），关闭为 closed；
   * 下次启动各 pipeline 的 start() 会重启恢复总结它们——故无需等待异步总结。
   */
  flushAllOpen(reason: string): void {
    if (!this.enabled) return
    try {
      const open = this.deps.segmentRepo.findAllOpen()
      for (const seg of open) {
        this.getPipeline(seg.agentId).flush(seg.conversationId, reason)
      }
    } catch (err) {
      log.error('[SegmentMemoryService] flushAllOpen 失败:', err)
    }
  }

  /** 优雅停止（app 退出） */
  async shutdown(): Promise<void> {
    if (!this.enabled) return
    for (const pipe of this.pipelines.values()) {
      try {
        await pipe.settle()
        pipe.stop()
      } catch {
        // 退出阶段忽略
      }
    }
  }

  private getPipeline(agentId: string): SegmentMemoryPipeline {
    let pipe = this.pipelines.get(agentId)
    if (!pipe) {
      pipe = new SegmentMemoryPipeline({
        segmentRepo: this.deps.segmentRepo,
        conversationRepo: this.deps.conversationRepo,
        memoryManager: this.deps.memoryManager,
        callLLM: this.deps.callLLM,
        agentId,
        userId: LOCAL_USER_ID,
        newId: () => randomUUID(),
        archivePalace: this.deps.archivePalace,
      })
      pipe.start() // 重启恢复遗留 closed 段
      this.pipelines.set(agentId, pipe)
    }
    return pipe
  }
}
