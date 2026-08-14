# 渠道出站 Hub — 完整设计

> 日期：2026-08-14  
> 状态：v1.0 方案确认（Channel Hub + 双工具 + 硬失败 + cron 统一路由）  
> 相关：`apps/windows/src/main/channel/`、`bridge-tool-registrar.ts`、`cron-scheduler.ts`  
> 前置讨论：已确认采用 **方案 2（Channel Hub）**；出站失败 **硬失败**；工具 **channel_list + channel_send**；收件人 **必须显式 to**；cron **必须走同一 Router**

---

## 0. 结论摘要

| 问题 | 结论 |
|------|------|
| 方案是否可行 | **可行**。现有 `IChannelAdapter` 已统一入站；缺口在出站注册表、peer 维护、Agent 工具与 cron 分叉。 |
| 最大风险 | 微信 iLink **无真 Push**，只能缓存 `context_token` 伪 Push；企微 aibot SDK **仅 replyStream**，一期 `channel_send` 对企微应 **硬失败** 并标明 `reply_only`。 |
| MVP 边界 | **Channel Hub + ChannelRegistry + ChannelOutboundRouter**；Agent 工具 **`channel_list` / `channel_send`**；微信 token 持久化；cron 改走 Router；**不**抽 packages 通用包。 |
| 与旧工具关系 | 保留 `message` 微信会话内回复兼容层，标记 **deprecated**；新出站一律走 `channel_send`。 |
| 失败策略 | **硬失败**：`ok: false` + 稳定 `errorCode` + 可操作 `message`；禁止 `ok:true` 软投递。 |

---

## 1. 背景

### 1.1 缺口

| 已有 | 能做 | 做不到 |
|------|------|--------|
| `IChannelAdapter` + 三渠道 adapter | 入站消息 → Agent → **被动** `sendTextReply` | 没有「已连接渠道 + 可寻址 peer」的统一视图 |
| `message` 工具 | 微信会话内回复（依赖 `getCurrentWeixinCtx()`） | 无 `list`；无显式 `to`；依赖 Gateway 的其它 channel |
| `sendFeishuMessage` / cron `notify_targets=feishu` | 飞书主动推（固定 openId） | 与 Agent 工具不同源；微信/企微 cron 回落 `system` |
| Settings 三套 `*Service` IPC | 扫码登录 / 登出 / 状态 | 无统一 Channel 管理 API |

Agent 需要：**先知道哪些渠道已连接、能推给谁，再向指定 peer 发消息**。定时任务也需要同一套出站能力，避免维护两套推送逻辑。

### 1.2 设计要回答的三件事

1. **维护**：已连接渠道与可寻址 peer 如何注册、刷新、持久化？
2. **抽象**：出站 `reply` vs `push` 如何统一接口并声明能力降级？
3. **调用**：Agent 内置工具与 cron 如何走同一条 `ChannelOutboundRouter`？

### 1.3 已确认的产品决策

| 决策点 | 选择 |
|--------|------|
| 不支持真 Push 的渠道 | 微信：**缓存 context_token 伪 Push**；企微：一期 **不伪装**，硬失败 |
| 发送失败 | **硬失败**（A） |
| Agent 工具形态 | **channel_list + channel_send**（B），不扩展 `message` |
| 收件人 | **必须显式 `to` / peerId**（B） |
| cron 通知 | **必须统一 Router**（A） |

---

## 2. 代码事实核查

> 以下基于仓库当前代码，每条注明来源。

### 2.1 已验证成立的假设

| 假设 | 代码证据 |
|------|---------|
| 入站已有统一 adapter 接口 | `channel/types.ts`：`IChannelAdapter.sendTextReply` |
| 飞书具备真 Push | `feishu-login-service.ts:190`：`pushText()` → `im.message.create` |
| 微信发送依赖 contextToken | `weixin-login-service.ts:881-898`：`sendTextReply` 无 token 直接失败 |
| 企微仅 WS replyStream | `wecom-login-service.ts:168`：`client.replyStream` |
| cron 飞书走独立注入 | `cron-scheduler.ts:596-598`：`sendFeishuMessage(payload.body)` |
| 微信 cron 故意回落 system | `resolve-channel-from-session-key.test.ts:17-22` |
| Agent message 工具已有 channel 分类 | `integration-tools.ts:26-31`：`category: "channel"` |
| bridge 注入出站钩子 | `bridge-types.ts:74-79`：`sendWeixinMessage` / `sendFeishuMessage` |

### 2.2 须修正或补全的认知

#### P1：types 引用的设计文档不存在

`channel/types.ts:4` 指向 `.qoder/design/channel/2026-04-19-windows-channel-unified-architecture.md`，仓库内无此文件。本设计作为 **出站 + 注册表** 的正式补档。

#### P2：LoginService 在 channel/ 外，三套平行

`weixin-login-service.ts` / `wecom-login-service.ts` / `feishu-login-service.ts` 各自独立。Hub **不搬迁** LoginService，但通过 **Provider 注册** 接入 Registry。

#### P3：微信 context_token 可缓存复用，但有边界

- 用户须至少发过一条消息才有 token  
- token 会随新消息刷新；旧 token 社区验证可复用数天，也可能静默不投递  
- iLink `sendmessage` 常返回 HTTP 200 + `{}`，**不能**以此判成功 → 需结合 API 层返回值与发送后可选探测（一期以 `apiSendTextChunk` 返回为准，失败硬失败）

#### P4：企微缓存 rawFrame 不可靠

`WecomChannelAdapter.sendTextReply` 依赖入站 `rawFrame`。缓存帧做「伪 Push」成功率和行为不可预期 → **一期不对企微做 cached_reply**。

#### P5：message 工具与 Gateway 耦合

`registerIntegrationTools` 在 `callGateway` 存在时注册；微信路径又依赖 `sendWeixinMessage` + 会话内 ctx。新工具应 **bridge-only 注册**，不依赖 Gateway。

---

## 3. 业务闭环（必须守住）

```
用户：「我飞书和微信都连了，把这条简报分别发给张三（微信）和我飞书。」

  1. channel_list()
     → feishu: connected, pushMode=native_push, peers=[{ id: ou_xxx, label: "我" }]
     → weixin: connected, pushMode=cached_reply, peers=[{ id: wxid_abc, label: "张三", tokenFresh: true }]

  2. channel_send({ channel: "weixin", to: "wxid_abc", text: "..." })
     → 内部取持久化 context_token → sendTextReply
     → { ok: true } 或 { ok: false, errorCode: "NO_REPLY_CONTEXT", message: "..." }

  3. channel_send({ channel: "feishu", to: "ou_xxx", text: "..." })
     → pushText / im.message.create
     → { ok: true }

  4. Agent 用自然语言汇总两次结果；任一次失败必须如实告知原因与补救（如「请让张三在微信里给 Bot 发任意消息」）。
```

闭环规则：

1. **先 list 再 send**：Agent 不应猜测 peerId；`channel_send` 缺 `to` 直接硬失败。
2. **能力透明**：`channel_list` 必须返回 `pushMode` 与 `canSend`，模型可据此决策。
3. **失败可懂**：稳定 `errorCode`，禁止 silent success。
4. **cron 同源**：`notify_targets=weixin,feishu` 与 Agent 调 `channel_send` 走同一 Router。

---

## 4. 能力全景

### 4.1 渠道出站能力矩阵（目标态）

| 渠道 | 连接态来源 | pushMode | 一期 channel_send | 被动 reply（adapter） |
|------|-----------|----------|-------------------|----------------------|
| feishu | `FeishuLoginStatus=connected` | `native_push` | ✅ `to`=open_id | ✅ replyText |
| weixin | `WeixinLoginStatus=logged_in` | `cached_reply` | ✅ 需持久化 token | ✅ sendTextReply |
| wecom | `WecomLoginStatus=connected` | `reply_only` | ❌ 硬失败 `UNSUPPORTED_PUSH` | ✅ replyStream |
| ipc | 主窗会话 | `reply_only` | ❌ 不适用 | ✅ 流式 UI 事件 |

### 4.2 Agent 工具分工

| 工具 | 职责 | 与旧工具 |
|------|------|----------|
| `channel_list` | 列出已连接渠道 + peers + 能力 | 新增 |
| `channel_send` | 向指定 channel + to 发文本（MVP） | 新增；取代出站场景的 `message` |
| `message` | 会话内快捷回复（微信 NO_REPLY 模式） | 保留兼容，文档标记 deprecated |

### 4.3 cron notify_targets（统一后）

| target | Router 行为 |
|--------|---------------|
| `system` | 现有 Electron Notification |
| `news` / `focus` | 现有 dashboard / memory |
| `feishu` | `router.send({ channel:'feishu', to: openId, text })` |
| `weixin` | `router.send({ channel:'weixin', to: peerId, text })` — **需 cron 任务配置或从 job 元数据取 to** |
| `wecom` | 一期：若 job 未配置有效 peer → 记录 warn，**不伪装成功** |
| `silent` | 不变 |

> **注意**：cron 的 `weixin` target 必须解决「推给谁」：MVP 要求 job 的 `notify_targets` 扩展为 `weixin:<peerId>` 或在 `local_cron_jobs` 增加 `notify_peer` 字段（见 §7.6）。

---

## 5. 原则

1. **Hub 一处出站**：Agent、cron、未来技能脚本均经 `ChannelOutboundRouter`。
2. **能力声明，不假装统一**：`pushMode` 写入 Registry；不支持就硬失败。
3. **peer 显式**：发送必须 `to`；list 提供权威 peer 列表。
4. **Login 与 Hub 解耦**：LoginService 仍管扫码与长连接；Hub 管「谁能收消息」。
5. **硬失败**：无 token / 未连接 / 不支持 → `ok: false`。
6. **YAGNI**：Hub 放 `apps/windows/src/main/channel/`，不抽 workspace 包。
7. **安全默认**：`channel_send` 需用户确认（`needsPermission: true`）。

---

## 6. 目标架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        Agent / Cron / Skills                     │
│              channel_list │ channel_send │ notify_targets        │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
                  ┌─────────────────────────────┐
                  │   ChannelOutboundRouter      │
                  │   send(params) → Result      │
                  │   list() → ChannelSnapshot[] │
                  └──────────────┬──────────────┘
                                 │
                  ┌──────────────┴──────────────┐
                  ▼                             ▼
        ┌──────────────────┐          ┌──────────────────┐
        │  ChannelRegistry  │◄─────────│ ChannelProviders │
        │  peers / caps     │  register│ feishu/weixin/   │
        └──────────────────┘          │ wecom            │
                                        └────────┬─────────┘
                                                 │
                    ┌────────────────────────────┼────────────────────────────┐
                    ▼                            ▼                            ▼
           FeishuLoginService          WeixinLoginService           WecomLoginService
           pushText / replyText         sendTextReply + token store   replyText only
                    │                            │                            │
                    ▼                            ▼                            ▼
              飞书 Open API                  iLink sendmessage              aibot WS
```

### 6.1 模块职责

| 模块 | 路径（新建/改） | 职责 |
|------|----------------|------|
| `ChannelRegistry` | `channel/channel-registry.ts` | 内存注册表；聚合各 Provider 的 connection + peers |
| `ChannelOutboundRouter` | `channel/channel-outbound-router.ts` | 统一 `list` / `send`；校验 to；分发到 Provider |
| `IChannelOutboundProvider` | `channel/outbound-types.ts` | 各渠道实现：getSnapshot / listPeers / sendText |
| `WeixinReplyContextStore` | `channel/weixin-reply-context-store.ts` | `userId → { contextToken, updatedAt, botToken?, baseUrl? }` 持久化 |
| `FeishuChannelProvider` | `channel/providers/feishu-outbound-provider.ts` | 包装 `pushText` / peer=openId |
| `WeixinChannelProvider` | `channel/providers/weixin-outbound-provider.ts` | 入站刷新 token；send 读 store |
| `WecomChannelProvider` | `channel/providers/wecom-outbound-provider.ts` | list peers；send 返回 UNSUPPORTED_PUSH |
| `channel_list` / `channel_send` tool | `packages/.../channel-tools.ts` + bridge 覆盖 | Agent 内置工具 |

### 6.2 与现有 IChannelAdapter 的关系

- **入站不变**：`WeixinChannelAdapter.handleMessage` 等继续负责 prompt 与被动回复。
- **衔接点**：adapter 收到入站消息时 **调用** `WeixinReplyContextStore.upsert(channelUserId, contextToken, ...)`。
- **出站分流**：
  - 被动回合结束 → 仍走 `adapter.sendTextReply(session, text)`
  - Agent 主动 / cron → 走 `ChannelOutboundRouter.send`

---

## 7. MVP（一期重点）

### 7.1 范围

| 做 | 不做 |
|----|------|
| ChannelRegistry + Router + 三 Provider | 抽 packages 通用 channel 包 |
| `channel_list` / `channel_send`（文本） | 文件/图片出站（二期） |
| 微信 token 持久化伪 Push | 企微伪 Push |
| cron 飞书/微信改走 Router | Renderer 新 UI（可复用 Settings 只读） |
| 单测：Router / token store / tool execute | Gateway `message` 大改 |

### 7.2 MVP 用户故事

1. Agent 调 `channel_list` → 返回已连接飞书/微信及 peer 列表与 `pushMode`。
2. Agent 调 `channel_send({ channel:"feishu", to:"ou_xxx", text:"hi" })` → 成功或硬失败。
3. 用户从未给微信 Bot 发过消息 → `channel_list` 中 weixin peers 为空或 `canSend:false`；send 返回 `NO_REPLY_CONTEXT`。
4. cron `notify_targets=feishu` → 与 Agent 相同 Router 路径。
5. cron `notify_targets=weixin:wxid_abc` → Router 发送；无 token 时 job 通知失败可观测（log + last_status 附带 warn）。
6. 企微 `channel_send` → `{ ok:false, errorCode:"UNSUPPORTED_PUSH" }`。

### 7.3 数据模型

#### ChannelSnapshot（list 返回）

```ts
interface ChannelPeer {
  /** 渠道内稳定 ID：飞书 open_id、微信 channelUserId */
  id: string
  /** 展示名（可选，来自最近消息 nickname 或 Settings） */
  label?: string
  /** 是否具备出站条件（如微信有未过期 token） */
  canSend: boolean
  /** 不能发送时的原因码 */
  blockedReason?: 'NO_REPLY_CONTEXT' | 'TOKEN_STALE' | 'UNSUPPORTED'
  lastInboundAt?: number
}

interface ChannelSnapshot {
  channel: 'feishu' | 'weixin' | 'wecom'
  connected: boolean
  pushMode: 'native_push' | 'cached_reply' | 'reply_only'
  peers: ChannelPeer[]
}
```

#### WeixinReplyContext（持久化）

```ts
interface WeixinReplyContextRecord {
  channelUserId: string
  contextToken: string
  botToken?: string
  ilinkBaseUrl?: string
  updatedAt: number
  lastNickname?: string
}
```

存储路径：`~/.lumii/channel/weixin-reply-contexts.json`（或 RuntimeStateRepo 前缀 `channel:weixin:ctx:`）。

**刷新策略**：每次 `WeixinChannelAdapter` / LoginService 收到入站消息 upsert。  
**过期策略（保守）**：`updatedAt` 超过 24h → `canSend:false`，`blockedReason:TOKEN_STALE`（发送仍允许尝试一次，失败则硬失败）。

#### Send 请求 / 响应

```ts
interface ChannelSendParams {
  channel: 'feishu' | 'weixin' | 'wecom'
  to: string          // 必填
  text: string
}

interface ChannelSendResult {
  ok: boolean
  errorCode?:
    | 'CHANNEL_NOT_CONNECTED'
    | 'PEER_NOT_FOUND'
    | 'NO_REPLY_CONTEXT'
    | 'TOKEN_STALE'
    | 'UNSUPPORTED_PUSH'
    | 'RATE_LIMITED'
    | 'UPSTREAM_ERROR'
  message?: string    // 中文可操作说明
  channel?: string
  to?: string
}
```

### 7.4 工具契约

#### `channel_list`

```ts
// 无参数
{
  channels: ChannelSnapshot[]
}
```

- `isReadOnly: true`
- `needsPermission: false`
- `category: "channel"`

#### `channel_send`

```ts
{
  channel: 'feishu' | 'weixin' | 'wecom'
  to: string
  text: string
}
```

- `isReadOnly: false`
- `needsPermission: true`（加入 `WRITE_TOOL_NAMES` 或独立 permission 规则）
- 缺 `to` → throw / `{ ok:false, errorCode:'PEER_NOT_FOUND' }`
- 成功：`{ ok:true, channel, to }`
- 失败：**必须** `ok:false`，禁止 `ok:true` + 未确认投递

**系统提示补充（Messaging 段）**：

```markdown
## Channel outbound
- 先 `channel_list` 获取已连接渠道与 peer id，再 `channel_send`。
- `to` 必填；不要猜测收件人。
- 微信需用户曾给 Bot 发过消息；否则提示用户先发一条激活。
- 企微不支持主动推送；仅能在企微会话内被动回复。
- 发送失败时如实告知 errorCode 与 message，不要假装成功。
```

### 7.5 Provider 行为细则

#### FeishuChannelProvider

- `connected`：`feishuLoginService.getStatus()==='connected'`
- peers：登录 session 的 `openId` → 单 peer `[{ id: openId, label:'我', canSend:true }]`
- send：`im.message.create(receive_id=to)`；若 `to !== session.openId` 仍允许（显式 to 模型），但 list 只暴露已知 openId

#### WeixinChannelProvider

- `connected`：`logged_in`
- peers：ReplyContextStore 中所有 record → `{ id: channelUserId, label: lastNickname, canSend: 有 token 且未标 stale }`
- send：取 store 中 `to` 对应 token → `weixinLoginService.sendTextReply(to, text, token, ...)`；`false` → `UPSTREAM_ERROR`

#### WecomChannelProvider

- `connected`：`connected`
- peers：内存表记录最近入站 `channelUserId`（可选 label）
- send：直接返回 `{ ok:false, errorCode:'UNSUPPORTED_PUSH', message:'企业微信当前仅支持会话内被动回复，不支持主动推送' }`

### 7.6 cron 集成

**改造点**：

1. `CronSchedulerDeps`：用 `channelRouter: ChannelOutboundRouter` **替代** `sendFeishuMessage`（或保留 thin wrapper 调 router）。
2. `dispatchNotifications` 解析 target：
   - `feishu` → router.send({ channel:'feishu', to: registry 默认 openId, text })
   - `weixin:<peerId>` → router.send({ channel:'weixin', to: peerId, text })
   -  plain `weixin` 且无 peer → **log warn + 跳过**（不 fallback system，避免静默丢通知）
3. `resolveChannelFromSessionKey`：创建 cron 时若 session 为 `weixin:` / `wecom:`，可 **建议** notify 格式，但不自动 send（仍须 explicit to）。

**notify_targets 语法扩展（MVP）**：

```
system,news,feishu,weixin:wxid_abc
```

### 7.7 文件落点

| 操作 | 路径 |
|------|------|
| 新建 | `apps/windows/src/main/channel/outbound-types.ts` |
| 新建 | `apps/windows/src/main/channel/channel-registry.ts` |
| 新建 | `apps/windows/src/main/channel/channel-outbound-router.ts` |
| 新建 | `apps/windows/src/main/channel/weixin-reply-context-store.ts` |
| 新建 | `apps/windows/src/main/channel/providers/*-outbound-provider.ts` |
| 新建 | `packages/agent-runtime/src/tools/built-in/channel-tools.ts` |
| 修改 | `apps/windows/src/main/agent-runtime/bridge-tool-registrar.ts` |
| 修改 | `apps/windows/src/main/agent-runtime/cron-scheduler.ts` |
| 修改 | `apps/windows/src/main/index.ts`（装配 Hub、注入 adapter upsert） |
| 修改 | `apps/windows/src/main/channel/adapters/weixin-channel-adapter.ts`（入站 upsert token） |
| 测试 | `apps/windows/src/main/channel/channel-outbound-router.test.ts` |
| 测试 | `apps/windows/src/test/agent-runtime/cron-notify-dispatch.test.ts`（改 mock router） |

### 7.8 旧路径迁移

| 旧 | 新 |
|----|-----|
| `config.sendFeishuMessage` | `channelRouter.send({ channel:'feishu', ... })` |
| `config.sendWeixinMessage`（Agent message 工具） | 会话内保留；主动出站走 `channel_send` |
| `message` + Gateway send | 不变；文档注明 outbound 用 `channel_send` |
| `resolveChannelFromSessionKey` → feishu only | cron 文档改推 `weixin:<id>` 显式语法 |

---

## 8. 完整规格（二期及以后）

### 8.1 富媒体出站

- `channel_send` 增加 `mediaPath?` / `mediaUrl?`
- 微信：`sendMediaReply`；飞书：上传后 send；企微：仍 reply_only

### 8.2 企微真 Push

- 调研企业微信 **应用消息 API** 或 aibot 新版本主动消息能力
- 新增 `pushMode: native_push` 时升级 Provider，而非缓存 rawFrame

### 8.3 Renderer Channel 面板（可选）

- Settings → channels 增加「已连接 peer 列表 / 最近出站记录」只读视图
- IPC：`channel:list` / `channel:send` 仅供调试，非 Agent 主路径

### 8.4 统一 ChannelService IPC

- preload 暴露 `channelService.list()` / `status()`，与 Agent 工具同源

### 8.5 频率限制与重试

- 微信 iLink 共享限流：Router 层识别 `RATE_LIMITED`，提示 Agent 退避
- cron 失败写入 `local_cron_jobs.last_error` 摘要

### 8.6 废弃 message 出站

- 三期移除 Gateway send 分支；微信会话内回复合并进 `channel_send` + `replyInTurn` 标志

---

## 9. 安全与权限

1. **发送确认**：`channel_send` 默认弹权限确认（展示 channel + to + 文本摘要）。
2. **peer 白名单**：仅允许 send 到 `channel_list` 曾返回的 peer；未知 to 硬失败。
3. **凭证不落日志**：contextToken / botToken 禁止 info 级日志。
4. **cron 注入**：`notify_targets` 解析不允许任意 shell；仅允许已知 channel 前缀。
5. **多账号**：一期单账号；Registry key 预留 `accountId` 字段。

---

## 10. 分期

| 期 | 内容 |
|----|------|
| **一期 MVP** | Hub + list/send + 微信 token store + cron Router + 单测 |
| **二期** | 富媒体；企微 Push 调研落地；Settings peer 视图 |
| **三期** | 废弃 message 出站；统一 IPC；多账号 |

---

## 11. 测试与验收

### 11.1 单测

| 用例 | 断言 |
|------|------|
| list 飞书 connected | peers 含 openId |
| list 微信无 token | peers 空或 canSend false |
| send 缺 to | PEER_NOT_FOUND / throw |
| send 企微 | UNSUPPORTED_PUSH |
| send 微信无 context | NO_REPLY_CONTEXT |
| cron feishu | mock router.send 被调用 |
| cron weixin:peer | 正确 to |
| cron weixin 无 peer | 不调用 send，有 warn |

### 11.2 手工验收

1. 飞书扫码连接 → list 见 feishu → send 成功 → 飞书 App 收到。
2. 微信扫码 → 用户发「你好」→ list 见 peer → send 成功。
3. 微信未对话 → send 硬失败，文案提示用户先发消息。
4. 企微 send → 明确失败原因。
5. cron 任务 notify feishu → 与 Agent send 同路径。
6. `channel_send` 触发权限确认框。

---

## 12. 风险

| 风险 | 缓解 |
|------|------|
| iLink token 静默失效 | 硬失败 + list 标 stale；引导用户重发消息 |
| iLink 协议变更 | Provider 隔离；单测 mock LoginService |
| cron weixin 不知推谁 | 强制 `weixin:<peerId>` 语法 |
| 与 message 工具行为重复 | 文档 + 系统提示分工；长期废弃 |
| index.ts 继续膨胀 | Hub 装配独立 `channel-hub-bootstrap.ts` |

---

## 13. 附录

### 13.1 稳定 errorCode 一览

| errorCode | 含义 | Agent 建议动作 |
|-----------|------|----------------|
| `CHANNEL_NOT_CONNECTED` | 渠道未登录 | 提示用户去 Settings 连接 |
| `PEER_NOT_FOUND` | to 不在 list | 先 channel_list |
| `NO_REPLY_CONTEXT` | 微信无 token | 提示用户给 Bot 发消息 |
| `TOKEN_STALE` | token 过旧 | 同上 |
| `UNSUPPORTED_PUSH` | 企微等 reply_only | 改在会话内回复或换渠道 |
| `RATE_LIMITED` | 触达限流 | 稍后重试 |
| `UPSTREAM_ERROR` | API 失败 | 报告 message |

### 13.2 工具名常量

```ts
export const CHANNEL_LIST_TOOL = 'channel_list'
export const CHANNEL_SEND_TOOL = 'channel_send'
```

### 13.3 版本历史

| 版本 | 日期 | 描述 |
|------|------|------|
| v1.0 | 2026-08-14 | 初始方案：Channel Hub、双工具、硬失败、cron 统一 Router |
