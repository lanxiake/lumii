import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import type { BridgeToolRegistrarDeps } from '../../../main/agent-runtime/bridge-tool-registrar-types'
import type {
  DashboardFeedBatchCursor,
  DashboardFeedBatchPage,
  DashboardFeedCursor,
  DashboardFeedItem,
  DashboardFeedMeta,
  DashboardFeedPage,
  DashboardFeedSnapshot,
} from './store'

/**
 * 概览信息流对核心暴露的能力。
 *
 * 核心有三类消费方：
 * - cron 调度器：写盘版本号 + 头部插入 + 读快照（判断「资讯落在 feed 里」）；
 * - cron → wiki 归档、新闻命令、API 分页：读快照/分页/批次；
 * - bridge：注入 db、注册 `dashboard_feed_*` 工具。
 *
 * 插件停用 ⇒ 服务消失 ⇒ 这些路径全部静默跳过（资讯卡保持空态、工具不注册）。
 * 存储本身仍在自己手里（`store.ts`），核心拿不到直接实现。
 */
export interface DashboardFeedService {
  setDb(db: DatabaseAdapter): void

  /** 注册 `dashboard_feed_write/read` 工具（bridge 的 registrar deps 由核心传进来） */
  installTools(deps: BridgeToolRegistrarDeps): void

  /** 写盘版本：cron 用它判断本轮是否写过 feed */
  readVersion(): number

  readSnapshot(feedId?: string): Promise<DashboardFeedSnapshot | null>
  readMeta(feedId: string): Promise<DashboardFeedMeta | null>
  readActiveFeedId(): Promise<string>
  readActiveSnapshot(): Promise<DashboardFeedSnapshot | null>
  readPage(
    feedId: string,
    opts?: { limit?: number; before?: DashboardFeedCursor | null },
  ): Promise<DashboardFeedPage>
  readBatches(
    feedId: string,
    opts?: { limit?: number; before?: DashboardFeedBatchCursor | null },
  ): Promise<DashboardFeedBatchPage>

  /** 向活跃 feed 头部插入一条（cron 结果推送） */
  prependActiveItem(
    item: DashboardFeedItem,
    maxItems?: number,
    batch?: { source?: string; conversationId?: string },
  ): Promise<void>

  ensureMigrated(feedId?: string): Promise<void>
  setActiveFeedId(feedId: string): Promise<void>
}
