# Channel Outbound Hub Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 落地渠道出站 Hub：统一 `ChannelOutboundRouter` + Registry + 三 Provider，Agent 工具 `channel_list`/`channel_send`，微信 token 持久化，cron 通知同源硬失败。

**Architecture:** Hub 全部放在 `apps/windows/src/main/channel/`；LoginService 不搬迁，经 Provider 接入。Agent 工具 stub 在 `packages/agent-runtime`，execute 由 bridge 覆盖。cron `dispatchNotifications` 改走 Router。

**Tech Stack:** TypeScript、Vitest、现有 Feishu/Weixin/Wecom LoginService、TypeBox 工具、`~/.lumii` 持久化

**规格：** `docs/design/2026-08-14-channel-outbound-hub-design.md`（v1.0）

**范围锁：** 下列任务 1–8 为一期 MVP。不做：富媒体、企微伪 Push、Renderer Channel 面板、抽 packages 通用包。

---

### Task 1: outbound 类型 + WeixinReplyContextStore

**Files:**
- Create: `apps/windows/src/main/channel/outbound-types.ts`
- Create: `apps/windows/src/main/channel/weixin-reply-context-store.ts`
- Create: `apps/windows/src/main/channel/weixin-reply-context-store.test.ts`

**Step 1: 写失败测试**

覆盖：`upsert` 后 `get`/`list`；`updatedAt` 超过 24h → `isStale=true`；落盘到临时目录再 reload 能读回。

**Step 2: 跑测试确认失败**

```bash
cd apps/windows && npx vitest run src/main/channel/weixin-reply-context-store.test.ts
```

**Step 3: 最小实现**

- `outbound-types.ts`：`ChannelPeer` / `ChannelSnapshot` / `ChannelSendParams` / `ChannelSendResult` / errorCode 联合类型 / `IChannelOutboundProvider` / `CHANNEL_LIST_TOOL` / `CHANNEL_SEND_TOOL` / `TOKEN_STALE_MS = 24h`
- `WeixinReplyContextStore`：构造注入 `filePath`；JSON 读写；函数级中文注释

**Step 4: 测试通过后提交**

```bash
git add apps/windows/src/main/channel/outbound-types.ts apps/windows/src/main/channel/weixin-reply-context-store.ts apps/windows/src/main/channel/weixin-reply-context-store.test.ts
git commit -m "feat(channel): WeixinReplyContextStore + outbound 类型"
```

---

### Task 2: ChannelRegistry + ChannelOutboundRouter

**Files:**
- Create: `apps/windows/src/main/channel/channel-registry.ts`
- Create: `apps/windows/src/main/channel/channel-outbound-router.ts`
- Create: `apps/windows/src/main/channel/channel-outbound-router.test.ts`

**Step 1: 写失败测试（mock Provider）**

| 用例 | 断言 |
|------|------|
| list 飞书 connected | peers 含 openId |
| list 微信无 token | peers 空或 canSend false |
| send 缺 to | `PEER_NOT_FOUND` |
| send 企微 | `UNSUPPORTED_PUSH` |
| send 微信无 context | `NO_REPLY_CONTEXT` |
| send 未连接 | `CHANNEL_NOT_CONNECTED` |
| send 未知 peer | `PEER_NOT_FOUND`（白名单） |

**Step 2: 最小实现**

- `ChannelRegistry.register(provider)` / `listSnapshots()` / `getProvider(channel)`
- `ChannelOutboundRouter.list()` / `send(params)`：校验 channel、connected、to 非空、peer 在 snapshot.peers 中（或允许飞书显式 to 在 list 已知 openId；设计：未知 to 硬失败）
- 硬失败统一返回 `ChannelSendResult`，禁止 throw（工具层再包装）

**Step 3: 测试通过后提交**

```bash
git commit -m "feat(channel): ChannelRegistry + OutboundRouter 硬失败路由"
```

---

### Task 3: 三渠道 Outbound Provider

**Files:**
- Create: `apps/windows/src/main/channel/providers/feishu-outbound-provider.ts`
- Create: `apps/windows/src/main/channel/providers/weixin-outbound-provider.ts`
- Create: `apps/windows/src/main/channel/providers/wecom-outbound-provider.ts`
- Create: `apps/windows/src/main/channel/providers/providers.test.ts`
- Modify: `apps/windows/src/main/feishu-login-service.ts` — `pushText` 支持可选 `to`（默认 session.openId）

**行为（设计 §7.5）：**

- Feishu：`connected` + peer=`openId`；send → `pushText(text, to)`
- Weixin：peers 来自 store；send 取 token → `sendTextReply`；无 token → `NO_REPLY_CONTEXT`
- Wecom：`send` 恒返回 `UNSUPPORTED_PUSH`；可选内存 recent peers 供 list

**提交：** `feat(channel): feishu/weixin/wecom outbound providers`

---

### Task 4: Hub bootstrap + adapter upsert + index 装配

**Files:**
- Create: `apps/windows/src/main/channel/channel-hub-bootstrap.ts`
- Modify: `apps/windows/src/main/channel/adapters/weixin-channel-adapter.ts` — 入站 upsert token
- Modify: `apps/windows/src/main/index.ts` — 装配 Hub，注入 bridge / cron
- Modify: `apps/windows/src/main/agent-runtime/bridge-types.ts` — 增加 `channelRouter?`
- Modify: `apps/windows/src/main/agent-runtime/bridge.ts` — 把 `channelRouter` 传给 CronScheduler 与 tool registrar

**bootstrap：**

```ts
createChannelHub(deps: {
  feishu: FeishuLoginService
  weixin: WeixinLoginService
  wecom: WecomLoginService
  dataRoot: string
}): { router: ChannelOutboundRouter; weixinStore: WeixinReplyContextStore; wecomProvider: WecomChannelProvider }
```

路径：`path.join(dataRoot, 'channel', 'weixin-reply-contexts.json')`

微信 adapter：在设置 `replyContext` / `setWeixinMessageContext` 处调用 `weixinStore.upsert(...)`。

**提交：** `feat(channel): Hub bootstrap 与微信入站 token 持久化`

---

### Task 5: channel_list / channel_send 工具 + WRITE_TOOL_NAMES + 系统提示

**Files:**
- Create: `packages/agent-runtime/src/tools/built-in/channel-tools.ts`
- Modify: `packages/agent-runtime/src/tools/built-in/index.ts` — 导出并加入 ALL_BUILT_IN
- Modify: `packages/agent-runtime/src/tools/built-in/tool-names.ts`
- Modify: `packages/agent-runtime/src/index.ts` — 导出
- Modify: `packages/agent-runtime/src/security/permission-types.ts` — `channel_send` 加入 `WRITE_TOOL_NAMES`
- Modify: `packages/agent-runtime/src/prompt/system-prompt-builder.ts` — Messaging 段补充 Channel outbound（有 `channel_list`/`channel_send` 时）
- Create: `packages/agent-runtime/src/tools/built-in/channel-tools.test.ts`（stub 契约：name/flags）
- Modify: `apps/windows/src/main/agent-runtime/bridge-tool-registrar.ts` — `registerChannelTools()`，不依赖 Gateway
- Modify: `apps/windows/src/main/agent-runtime/bridge-types.ts` — deps 已有 channelRouter

**工具契约：** 设计 §7.4。execute 返回 JSON `{ ok, ... }`。

**提交：** `feat(agent): channel_list/channel_send 工具与权限提示`

---

### Task 6: cron 统一 Router

**Files:**
- Modify: `apps/windows/src/main/agent-runtime/cron-scheduler.ts`
- Modify: `apps/windows/src/main/agent-runtime/cron-notify-dispatch.test.ts`
- Modify: `apps/windows/src/main/agent-runtime/cron-e2e.test.ts`（若仍 mock sendFeishuMessage，改为 channelRouter 或 thin wrapper）
- Modify: `apps/windows/src/main/agent-runtime/cron-notify-format.ts` — 若 target 带 `weixin:` 前缀，格式化时剥前缀取渠道策略

**dispatch 规则（设计 §7.6）：**

- `feishu` → `router.send({ channel:'feishu', to: 默认 openId 从 list, text })`；无默认 peer → warn 跳过
- `weixin:<peerId>` → `router.send({ channel:'weixin', to: peerId, text })`
- plain `weixin` → warn + 跳过（不 fallback system）
- `wecom` / `wecom:<id>` → warn（或 send 得 UNSUPPORTED_PUSH），不伪装成功
- 保留 `sendFeishuMessage` 作为 thin wrapper（可选）：内部调 router，便于过渡；优先直接 `channelRouter`

**测试断言：** mock `channelRouter.send`；`weixin:peer` 正确 to；plain weixin 不调用 send。

**提交：** `feat(cron): notify_targets 走 ChannelOutboundRouter`

---

### Task 7: 飞书 pushText(to) + 回归测试跑通

**Files:** 已在 Task 3 改 `pushText`；本任务确认全量相关测试绿。

```bash
cd apps/windows && npx vitest run src/main/channel src/main/agent-runtime/cron-notify-dispatch.test.ts
cd ../../packages/agent-runtime && pnpm test -- channel-tools
```

**提交：** 如有修复则 `fix(channel): ...`

---

### Task 8: 文档小补档（可选）

- `channel/types.ts` 顶部注释改为指向本设计文档
- message 工具 description 加一句 deprecated outbound 提示（可选，不改行为）

**提交：** `docs(channel): 出站 Hub 类型引用补档`

---

## 验收对照（设计 §11）

- [ ] list 飞书 connected → peers 含 openId
- [ ] list 微信无 token → canSend false / 空
- [ ] send 缺 to → PEER_NOT_FOUND
- [ ] send 企微 → UNSUPPORTED_PUSH
- [ ] send 微信无 context → NO_REPLY_CONTEXT
- [ ] cron feishu → mock router.send
- [ ] cron weixin:peer → 正确 to
- [ ] cron weixin 无 peer → 不 send + warn
