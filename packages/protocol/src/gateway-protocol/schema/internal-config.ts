/**
 * 内部配置 DTO — 网关 ↔ api-server 配置通道契约
 *
 * S3 配置下沉：网关不再直连 DB 读取 6 表配置，改为：
 * - 启动/热重载：POST internal/config（携带本地 fileConfig）→ api-server 合并 6 表 → 返回完整 MtBotConfig 快照
 * - 配置变更：api-server 写库成功 → redis.publish(CONFIG_CHANGED_CHANNEL) fanout → 网关重拉快照
 *
 * 设计依据：doc 10 §3.2（internal/config 端点）+ doc 21 §5（配置中心）+ doc 22（配置中心设计）。
 *
 * 与 internal-events.ts 的关系：
 * - internal-events：上报类（usage/chat/log），网关→api，Redis Stream 消费组 + ack。
 * - internal-config：配置类（拉取 REST + 变更 pub/sub fanout），双向，非 Stream。
 *
 * 模式：纯 TS 接口（与 internal-events 一致），不走 TypeBox/AJV（那是对客户端的 RPC 协议）。
 */

// 灵栖/Lumii 独立版：MtBotConfig 是网关↔api-server 内部配置 DTO 的字段类型，
// 客户端无 api-server，此 DTO 不参与运行时；以宽松别名替代原配置类型树（避免 vendoring 13 个 config 类型文件）。
type MtBotConfig = Record<string, unknown>;

// ── Pub/Sub Channel 常量 ─────────────────────────────────────────────────────
// 配置变更广播用 Redis pub/sub（fanout 到所有网关实例），非 Stream 消费组。
// 依据 doc 10 §4.5：广播类事件用 pub/sub，上报类用 Stream。
// ioredis keyPrefix="mtbot:" 自动加前缀，物理 channel: mtbot:config.changed

/** 配置变更广播 channel（代码中不含 mtbot: 前缀，ioredis 自动加）*/
export const CONFIG_CHANGED_CHANNEL = "config.changed";

// ── 配置变更事件 type ─────────────────────────────────────────────────────────

export const CONFIG_EVENT_TYPES = {
  /** 配置变更：admin 写库成功后 api-server 产出，fanout 到所有网关 */
  CONFIG_CHANGED: "config.changed",
} as const;

export type ConfigEventType = (typeof CONFIG_EVENT_TYPES)[keyof typeof CONFIG_EVENT_TYPES];

// ── 配置变更作用域 ────────────────────────────────────────────────────────────
// 对齐 doc 10 §4.2 ConfigChangedPayload.scope，映射网关 config-reload 规则表。

/** 配置变更作用域：网关据此判定 reload 动作（restart/hot/conditional）*/
export type ConfigChangeScope = "bindings" | "channels" | "llm" | "all";

// ── 配置变更广播负载 ──────────────────────────────────────────────────────────

/**
 * config.changed — 配置变更广播负载（api-server → 所有网关）
 * Channel: mtbot:config.changed（代码写 "config.changed"）
 *
 * 低频、fanout、丢失可容忍（网关有 5min 轮询兜底 + 启动重拉）。
 * 网关收到后据 version 判断是否需重拉快照，据 scope 判定 reload 动作。
 */
export interface ConfigChangedPayload {
  /** 配置版本号（网关比对本地缓存 version 决定是否重拉）*/
  version: string;
  /** 变更作用域（映射网关 reload 规则表）*/
  scope: ConfigChangeScope;
  /** 租户 ID（仅租户级配置变更时存在；空表示系统级，影响所有租户）*/
  userId?: string;
  /** 产出时间戳（ms since epoch）*/
  ts: number;
}

// ── 配置拉取请求 ──────────────────────────────────────────────────────────────

/**
 * POST internal/config 请求体（网关 → api-server）
 *
 * 网关携带本地 fileConfig（mtbot.json），api-server 用其作为合并基底
 * 叠加 DB 6 表配置，返回合并后的完整 MtBotConfig 快照。
 *
 * 这样合并逻辑（merger）下沉到 api-server，网关无需懂"文件 vs DB 合并"。
 */
export interface GatewayConfigRequest {
  /** 网关实例 ID（多实例区分；预留按网关定制配置）*/
  gatewayId: string;
  /** 租户 ID（传入时返回租户级有效配置；空走系统级）*/
  userId?: string;
  /** 网关本地文件配置（mtbot.json 解析结果，作为合并基底）*/
  fileConfig: MtBotConfig;
}

// ── 配置快照响应 ──────────────────────────────────────────────────────────────

/**
 * internal/config 响应体（api-server → 网关）
 *
 * api-server 合并 fileConfig + DB 6 表后返回的完整可用配置。
 * 网关直接将 config 作为运行时配置，无需再做任何合并。
 *
 * ⚠️ 安全：config 含 auth token / apiKey 等敏感字段，仅经 X-Gateway-Secret
 * 鉴权的内部专网传输，不对公网暴露（doc 10 §3.1）。
 */
export interface GatewayConfigSnapshot {
  /** 配置版本号（内容指纹或单调递增；网关据此判断是否需更新）*/
  version: string;
  /** 合并后的完整配置（fileConfig + DB 6 表，可直接作为运行时配置）*/
  config: MtBotConfig;
  /** 各配置段来源标注（gateway/db-system/db-tenant，对齐 buildConfigSources）*/
  sources: Record<string, string>;
  /** 快照生成时间（ISO 8601）*/
  generatedAt: string;
}
