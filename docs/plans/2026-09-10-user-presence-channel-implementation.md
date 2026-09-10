# 用户在场感知与渠道自适应 — 代码实施计划

> 日期：2026-09-10
> 状态：实施计划（待开工）
> 规格：`docs/design/2026-09-09-user-presence-channel-design.md`（v1.3）
> 代码根：`apps/windows/src/main/`

---

## 0. 目标与范围

落地设计文档的四期工作，按依赖顺序排：

| 期 | 内容 | 设计出处 |
|----|------|---------|
| **P0** | 二元在场信号 + 提示词注入（风格/详略自适应） | §3、§4、§5.1 |
| **P1.0** | 渠道架构收敛：渠道工厂 + 入站媒体管线 | §5.9 |
| **P1.1** | SDK 升级：飞书 1.72.0 → 1.73.3 | §5.7 |
| **P1.2** | SDK 补全：飞书/企微入站媒体下载 + 语音转文字 + `sendFileReply` | §5.7 |
| **P1.3** | HTML 单文件交付（飞书/企微文件出站能力补齐） | §5.6 |
| **P1.4** | qbot（QQ 机器人）渠道接入 + 扫码建应用 | §5.8 |
| P2 / P3 | 跨渠道连续性、交互降级、工具进度过滤 | §5.4/5.5/5.2（**不在本期**） |

**范围锁**：本期不做 P2（询问式接续、交互降级）、P3（工具进度分级过滤）。企微主动推送仍维持 `UNSUPPORTED_PUSH`（设计未要求一期开启企微主动 push，仅补 `sendFileReply` 被动回复路径）。

---

## 1. 架构改动地图

```
channel/types.ts                    增加 channelLabelOf() + 在场类型
channel/session-manager.ts          _doPrompt 统一写入在场状态（P0 核心注入点）
agent-runtime/bridge-instance-state.ts   InstanceState 增加 presence 字段
agent-runtime/bridge.ts             setInstancePresence()
agent-runtime/bridge-prompt-composer.ts  buildPromptWithMemory 注入 User Presence 段
channel/adapters/*.ts               无改动（P0 靠 session-manager 收敛，见 §2 说明）

channel/channel-factory.ts          [新] createChannelFactory 收掉初始化样板
channel/media-pipeline.ts           [新] 入站媒体归一化共享纯函数
feishu-login-service.ts             放开非 text 入站 + 下载 + 语音转文字
feishu-channel-adapter.ts           sendFileReply
wecom-login-service.ts              image/file 监听 + downloadFile
wecom-channel-adapter.ts            sendFileReply
outbound-types.ts / channel-registry.ts   OutboundChannelId 增 qbot
qbot-app-registration.ts            [新] 扫码建应用（lite_create）
qbot-session-store.ts               [新] 凭证落盘
qbot-login-service.ts               [新] Gateway WS 长连接 + 消息事件
channel/adapters/qbot-channel-adapter.ts   [新]
channel/providers/qbot-outbound-provider.ts [新]
index.ts                            渠道工厂装配 + qbot 接线
```

---

## 2. P0：二元在场信号 + 提示词注入

### 关键设计决策（偏离设计的收敛）

设计 §3.2 写「adapter 在 `sessionManager.prompt()` 前写入」，需要改 4 个 adapter。实际更优：**在 `SessionManager._doPrompt` 统一写入**——所有主 Agent 路径（ipc / weixin / feishu / wecom）都经过 `sessionManager.prompt()`，且 `PromptParams` 已带 `session.channelType`。一处写点替代四处，`channelLabel` 映射也收敛到一处，消除四份拷贝（正是 §5.9 要解决的问题）。

> 注：ACP 子进程路径（feishu/weixin 的 `handleAcpPrompt`）不走 `sessionManager.prompt()`，是独立后端，本轮不注入在场段（它们有自己的系统提示词构造，P0 收益面仅主 Agent）。如需覆盖，后续在 ACP `startRun`/`runCodingDevAcpPrompt` 入参加 `channelLabel`，不在本期。

### Task 2.1：在场状态字段 + 写入 API

**Files:**
- Modify `agent-runtime/bridge-instance-state.ts`
- Modify `agent-runtime/bridge.ts`

**Step 1**：`InstanceState` 增字段（与 `skipTaskInjection` 并列）：

```ts
/** 本轮消息来源的在场/渠道标签（P0：二元在场信号） */
presence?: {
  /** channelType === 'ipc' 时用户在客户端面前 */
  userAtClient: boolean
  /** 渠道中文名（微信/飞书/企业微信/QQ/消息渠道），ipc 为 undefined */
  channelLabel?: string
}
```

`createInstanceState` 默认不写 `presence`（undefined = 尚未有消息来源，composer 读到 undefined 时按「客户端」处理，等价默认）。

**Step 2**：`bridge.ts` 加公开写入方法（对齐既有 `markInstanceAsExternalChannel`）：

```ts
/** 写入本轮在场状态（P0：二元在场信号），由 SessionManager 在 prompt 前调用 */
setInstancePresence(instanceId: string, presence: { userAtClient: boolean; channelLabel?: string }): void {
  const s = this.instanceStates.get(instanceId)
  if (s) s.presence = presence
}
```

### Task 2.2：channelLabel 映射 + SessionManager 写入

**Files:**
- Modify `channel/types.ts`
- Modify `channel/session-manager.ts`

**Step 1**：`channel/types.ts` 增纯函数：

```ts
/** 渠道标识 → 中文名；未知渠道 fallback「消息渠道」。ipc 返回 undefined（客户端默认，不强加） */
export function channelLabelOf(channelType: string): string | undefined {
  if (channelType === 'ipc') return undefined
  const map: Record<string, string> = {
    weixin: '微信', feishu: '飞书', wecom: '企业微信', qbot: 'QQ',
  }
  return map[channelType] ?? '消息渠道'
}
```

**Step 2**：`session-manager.ts` `_doPrompt` 解构加 `session`，在 `bridge.prompt` 前写入：

```ts
const { instanceId, sessionKey, message, strategy, imageAttachmentPaths, pendingUserMsgId, session } = params
this.bridge.setInstancePresence(instanceId, {
  userAtClient: session.channelType === 'ipc',
  channelLabel: channelLabelOf(session.channelType),
})
```

放在 `strategy.beforePrompt` 之后、`bridge.prompt` 之前（确保 promptRebuilder 重建系统提示词时已可读）。

### Task 2.3：composer 注入 User Presence 段

**Files:**
- Modify `agent-runtime/bridge-prompt-composer.ts`

在 `buildPromptWithMemory` 中，紧跟「客户端诊断段」之后（约 line 420 后）注入。读 `this.deps.instanceStates.get(instanceId)?.presence`：

- `undefined` 或 `userAtClient === true` → **不注入**（客户端默认形态，零 token 开销，符合设计「客户端为默认不加强」）。
- `userAtClient === false` → 注入：

```
## User Presence（本轮回复载体）
用户此刻不在桌面客户端面前，只能收到纯文本（渠道：${channelLabel}），Markdown 记号原样显示为噪声，看不到工具卡片与文件树。
- 风格：结论前置（1-2 句摘要开头）；口语化短句；用「1. 2. 3.」编号替代列表与表格。
- 详略：默认 ≤200 字；用户明确要求"详细"时再展开（仍用纯文本结构，不分层标题）。
- 禁忌：不输出表格、代码块、分层标题；不写「见左侧文件树」「点击下方按钮」等 UI 依赖表述。
- 生成文件时：告知文件名与保存位置；长内容（报告/笔记）写成 HTML 文件发送，聊天内只发 3 行摘要。
```

实现为私有方法 `buildUserPresenceSection(presence)`，返回 string，`dynamicParts.push()`。与 `buildClientDiagnosticsSection` 同风格，包裹 try/catch，失败只 log 不阻断主流程。

**验收**：`presence` 注入为软约束；渠道兜底格式化（`markdownToPlainText`/`truncate`）在 P1.3 文件发送前接入，见 §5.2 末尾的硬保证项。

### Task 2.4：P0 验证

- 构造三组对照：同一问题分别经 ipc / weixin / feishu 发出，断言 weixin/feishu 实例的 `instanceStates` 内 `presence` 正确、`buildPromptWithMemory` 输出含/不含 User Presence 段。
- 加最小单测 `channel/session-manager` 或 `bridge-prompt-composer` 的 `buildUserPresenceSection`（纯函数：`userAtClient=true` → 空、`false` + `channelLabel='微信'` → 含「微信」）。

**提交**：`feat(presence): 二元在场信号 + 提示词注入`

---

## 3. P1.0：渠道架构收敛

### Task 3.1：createChannelFactory（初始化样板收敛）

**Files:**
- Create `channel/channel-factory.ts`
- Modify `index.ts`（改用工厂装配）

**现状**（`index.ts:1387-1474`）：三渠道各自 `new LoginService → initialize → new Adapter → startListening → on(statusChange/qrcode/error) 转发`，约 40 行 × 3。

**工厂形态**（不迁 LoginService，只收「实例化→装配→事件转发」样板）：

```ts
export interface ChannelWiring<L extends EventEmitter> {
  id: string                          // 'weixin' | 'wecom' | 'feishu' | 'qbot'
  createLogin: () => L                // new XxxLoginService()
  loginInitialize: (l: L) => Promise<void>
  createAdapter: (l: L, bridge: AgentRuntimeBridge) => IChannelAdapter
  /** 状态/二维码/错误 → 渲染进程事件名（缺省按 `${id}:statusChange` 约定） */
  ipcChannel: string
  afterStart?: (adapter: IChannelAdapter) => void   // 微信 bindingManager 挂接等
}
export function createChannelFactory(deps: {
  bridge: AgentRuntimeBridge
  send: (channel: string, payload: unknown) => void  // mainWindow?.webContents.send
}): (w: ChannelWiring<any>) => Promise<{ login: any; adapter: IChannelAdapter } | null>
```

工厂内部：`try` 包裹，失败 `log.warn` 返回 `null`（对齐现有「单渠道失败不拖垮其它渠道」语义）；统一 `on('statusChange'|'qrcode'|'error') → send()`。微信的特殊项（`silkAsrCallback` 注入、`setWeixinBindingManagerForIpc`、`AcpBackendManager`、`ReplyContextStore`）通过 `afterStart`/`loginInitialize` 回调保留在 index.ts 侧，**不塞进工厂泛型参数里**。

> ponytail 提示：三个渠道形状有差异（微信最重、飞书/企微同构），工厂若硬抽象会反向复杂化。一期只收「事件转发 + 构造顺序 + try/catch」这些真正重复的样板；差异项留在调用侧闭包。若后续接第 6 个渠道仍觉冗余，再评估抽基类。

**验收**：`index.ts` 三渠道初始化段缩为 3 个 `createChannelFactory(...)({...})` 调用，行为不变（startup 日志、错误降级、事件名完全一致）。

### Task 3.2：normalizeInboundMedia（入站媒体管线共享纯函数）

**Files:**
- Create `channel/media-pipeline.ts`
- Modify `weixin-login-service.ts`（可选，抽公共段，本期不强改已稳定的微信路径）

**真正可共享的部分**（避免四份拷贝）：媒体行组装 + 语音转录行组装 + ASR 调用封装。下载器各渠道不同（微信 CDN / 飞书 `im.messageResource.get` / 企微 `downloadFile`），作为参数注入。

```ts
/** 入站媒体归一化结果 */
export interface NormalizedInboundMedia {
  /** `[media attached: <path> (<filename>)]` 行列表 */
  mediaLines: string[]
  /** `[语音转录: <text>]` 行（有成功转录时） */
  transcriptLine?: string
}

/** 把已落盘媒体 + 可选转录拼成注入 prompt 的行 */
export function assembleMediaPrompt(media: NormalizedInboundMedia, userText?: string): string

/** 语音转文字：原始音频文件 → 16k PCM → sherpa-onnx ASR。降级返回空串不抛 */
export async function transcribeVoiceFile(
  absPath: string,
  asr: (samples: Float32Array, sampleRate: number) => Promise<string>,
): Promise<string>
```

- `transcribeVoiceFile` 内部：飞书 opus/音频经 `@ffmpeg-installer/ffmpeg` 转 16k PCM（复用设计 §5.7 约定）；微信 SILK 已走 `silk-sdk.decode`，不在本函数内重复，但可复用其「PCM → ASR」后半段。企微 `voice` 只有转写文字，无原始音频，直接透传 SDK 给的 `content`，不走此函数。
- 单测：`assembleMediaPrompt`（空/有文本/多附件/有转录）、`transcribeVoiceFile` 降级分支（asr 返回空串 → 无 transcriptLine）。

**提交**：`refactor(channel): 渠道工厂 + 入站媒体管线收敛`

---

## 4. P1.1：SDK 升级

**Files:**
- Modify `apps/windows/package.json`：`@larksuiteoapi/node-sdk` `^1.71.1` → `^1.73.3`

```bash
cd apps/windows && pnpm add @larksuiteoapi/node-sdk@^1.73.3
```

- 企微 `@wecom/aibot-node-sdk@1.0.7` 已是最新，不动。
- 回归：`pnpm --filter @mtbot/windows build` 通过 + 飞书登录/收发消息冒烟（升级为补丁版，API 向后兼容）。

**提交**：`chore(deps): 升级飞书 SDK 1.72.0 → 1.73.3`

---

## 5. P1.2：SDK 补全（入站媒体 + 语音转文字 + sendFileReply）

### Task 5.1：飞书入站非 text（audio/image/file）

**Files:**
- Modify `feishu-login-service.ts`

**改动** `normalizeMessageEvent`（现 line 464-511 非 text 直接 `return null`）：

1. `FeishuNormalizedMessage.type` 扩为 `'text' | 'audio' | 'image' | 'file'`，增 `fileKey?: string`、`fileName?: string`、`mediaPath?: string`。
2. 非 text 分支解析 `content` JSON：
   - `audio`/`file`：content 内 `file_key`；`image`：`image_key`。
   - 取 `file_name`（file 类），缺省按类型给 `.opus`/`.bin`/`.jpg`。
3. 调 `im.messageResource.get({ path: { message_id, file_key }, params: { type } })` 下载，`getReadableStream()` 读为 Buffer，落盘 `workspace/uploads/{YYYYMMDD}/`，回填 `mediaPath`。
4. `audio` 下载后走 `transcribeVoiceFile`（Task 3.2）转文字，注入 `[语音转录: …]`。
5. `type: 'text'` 路径保持不变；`text` 为空但有媒体时，用 `buildMediaFallbackText` 同款语义（`用户发送了媒体消息…`），并拼 `[media attached: …]`。

**注入 adapter 侧**：`FeishuChannelAdapter.handleMessage` 现取 `msg.text`，媒体消息时改为读 `assembleMediaPrompt`（Task 3.2）拼接后的 `prompt`（含媒体行 + 转录行），逻辑对齐 `weixin-channel-adapter.ts:195-204`。

### Task 5.2：企微入站 image/file

**Files:**
- Modify `wecom-login-service.ts`

**改动**：

1. `startWsClient` 增监听：`client.on('message.image', handleInbound)`、`client.on('message.file', handleInbound)`（SDK event.d.ts 已定义 `message.image`/`message.file`/`message.video`）。
2. `normalizeFrame` 扩展 `WecomNormalizedMessage`：`type` 增 `'image' | 'file'`，增 `mediaPath?`。image/file 分支取 `body.image?.{url,aeskey}` / `body.file?.{url,aeskey}`，调 `client.downloadFile(url, aeskey)` 得 `{ buffer, filename }`，落盘 `workspace/uploads/{YYYYMMDD}/`，回填 `mediaPath`。
3. 企微 `voice` 只有 SDK 给的转写文字（`voice.content`），直接作为文本注入，无需下载/ASR（设计 §5.7 已明确）。
4. 纯图片/文件无文字时，同样走 `buildMediaFallbackText` + `[media attached]`。

**注入 adapter 侧**：`WecomChannelAdapter.handleMessage` 同飞书，媒体消息拼 `assembleMediaPrompt`。

### Task 5.3：飞书/企微 sendFileReply

**Files:**
- Modify `channel/adapters/feishu-channel-adapter.ts`
- Modify `channel/adapters/wecom-channel-adapter.ts`

**飞书**（LoginService `pushMedia` 已实现，只差 adapter 接线）：

```ts
async sendFileReply(session: ChannelSession, filePath: string): Promise<void> {
  const chatType = (session.replyContext?.chatType as 'p2p' | 'group') ?? 'p2p'
  const res = await this.feishuLoginService.pushMedia(
    filePath,
    session.replyContext?.chatId as string | undefined,
    undefined,
  )
  if (!res.ok) log.error(`[sendFileReply] 失败: ${res.error}`)
}
```

> 注：`pushMedia` 默认 `to = session.openId`（发给自己）；`chatType` 当前未参与收件人判定，一期维持现状。群聊文件发送需飞书侧 `receive_id` 用 chat_id，若验收发现群聊收不到，再给 `pushMedia` 加 `receiveIdType` 参数——列为本 Task 的开放验证项，不预埋。

**企微**（SDK `uploadMedia` + `replyMedia` 已具备）：

```ts
async sendFileReply(session: ChannelSession, filePath: string): Promise<void> {
  const rawFrame = session.replyContext?.rawFrame
  if (!rawFrame) return
  const buf = await fs.promises.readFile(filePath)
  const ext = path.extname(filePath).toLowerCase()
  const type: WeComMediaType = /\.(jpg|jpeg|png|gif|webp|bmp)$/.test(ext) ? 'image' : 'file'
  const { media_id } = await this.wecomLoginService.client.uploadMedia(buf, { type, filename: path.basename(filePath) })
  await this.wecomLoginService.client.replyMedia(rawFrame, type, media_id)
}
```

需在 `WecomLoginService` 暴露一个封装方法（`replyMediaFile(rawFrame, filePath)`），内部做 ext→type 映射 + upload + reply，避免 adapter 直接碰 `client` 裸对象（保持 LoginService 是厂商 SDK 唯一封装边界）。

**验收（§5.7 用例）**：
1. 飞书发语音 → 客户端对话出现 `[语音转录: …]`（无 ffmpeg/ASR 时降级为媒体行，不报错）
2. 飞书发图片/文件 → 客户端可下载、Agent 拿到本地路径
3. 企微发图片/文件 → 同上（`downloadFile` 解密落地）
4. 客户端生成文件发飞书/企微 → 对方收到文件（`sendFileReply`）
5. 微信四类互传回归无回归

**提交**：`feat(channel): 飞书/企微入站媒体 + 语音转文字 + sendFileReply`

---

## 6. P1.3：HTML 单文件交付

**Files:**
- Create `apps/windows/resources/` 或 `channel/html-report-template.ts`（HTML 模板常量 + 生成函数）
- 复用 `sendFileReply`（P1.2 已补齐）作为发送通道

**范围**：交付形态是「HTML 单文件」，但**生成 HTML 是 Agent 侧行为**（写入工具提示词/skill，Agent 生成到 workspace）。代码侧只需：

1. 一份固定 HTML 骨架模板（Tailwind Play CDN + 顶部结论摘要卡 + 底部「本报告由 Lumii 生成 + 时间」），Agent 填正文。模板作为字符串常量 + `renderHtmlReport({ title, summary, sections, generatedAt })` 纯函数。
2. 一个出站工具路径：Agent 调用既有 `channel_send`/文件发送工具时，若目标渠道是 feishu/wecom，走 `sendFileReply`（P1.2 已通）。**不需要新增工具**。
3. 渠道兜底格式化（设计 §5.1 硬保证）：`sendTextReply` 前复用 `cron-notify-format.ts` 的 `markdownToPlainText`/`truncate`。此项是**硬保证项**，与 P0 软约束配套，放在本 Task 补（飞书/企微 adapter 的 `sendTextReply` 加一行纯文本化）。

> 注：HTML 模板渲染函数与「生成 HTML」的提示词约束，本质是 §5.6 的 Agent 侧产物；代码侧最小交付 = 模板常量 + `sendFileReply` 已通。样式规范沿用设计 §5.6 表格。

**提交**：`feat(channel): HTML 单文件报告模板 + 渠道纯文本兜底格式化`

---

## 7. P1.4：qbot（QQ 机器人）渠道接入

复用 channel 架构，接入方式为「扫码建应用优先 + 凭证表单兜底」（设计 §5.8）。凭证 = `AppID + AppSecret`；长连接 = Discord 式 Gateway WebSocket；不引官方停更 SDK（2022），用 `ws` + 原生 fetch 自写。

### Task 7.1：QbotAppRegistration（扫码建应用）

**Files:**
- Create `qbot-app-registration.ts`

对齐 `feishu-app-registration.ts` 的 init/begin/poll 骨架，但接口是 QQ 内部 cgi（逆向自 OpenClaw，未公开承诺稳定）：

| 步骤 | 接口 |
|------|------|
| begin | `POST https://bot.q.qq.com/cgi-bin/lite_create`（body `{ apply_source: 1, idempotency_key }`）→ `{ appid, client_secret }` |
| reset | `POST /cgi-bin/dev_info/lite_reset_secret`（body `{ bot_appid }`） |

> 开发者登录态依赖 `q.qq.com` 手机 QQ 扫码 OAuth（`useLoginSession.js` 轮询）。一期简化：若 `lite_create` 未授权，直接降级到凭证表单（用户去 `q.qq.com` 手填），不自行实现 QQ OAuth 登录轮询——把「扫码建应用」当可选加速路径，不可靠时立即降级，不赌内部接口稳定。

接口定义：

```ts
export async function liteCreateApp(idempotencyKey: string): Promise<{ appid: string; clientSecret: string }>
```

内部 fetch，失败抛错（由上层 catch 转降级）。

### Task 7.2：QbotSessionStore + QbotLoginService

**Files:**
- Create `qbot-session-store.ts`
- Create `qbot-login-service.ts`

**QbotSessionStore**：对齐 `wecom-session-store.ts`，字段 `{ appId, appSecret, loginAt }`，文件 `qbot-session.json`。

**QbotLoginService**（`extends EventEmitter`，事件 `statusChange`/`qrcode`/`message`/`error`）：

1. `startLogin()`：优先走 `QbotAppRegistration.liteCreateApp`；失败则 `emit('error', '扫码建应用不可用，请去 q.qq.com 手动创建并填写凭证')` 并停在 `waiting_credential` 状态（凭证表单入口由设置页 IPC 提供，`saveCredentials(appId, appSecret)` 收尾）。
2. `saveCredentials(appId, appSecret)`：落盘 → `startGateway()`。
3. `startGateway()`：
   - `GET https://bots.qq.com/app/getAppAccessToken`（或 api-v2 对应端点）拿 `AccessToken`；
   - `GET /gateway` 拿 `wss://api.bot.qq.com/websocket`；
   - `ws` 长连接：`op=2 Identify`（token=`QQBot {AccessToken}` + intents + shard）→ `READY`；心跳 `op=1`/`op=11`；断线 `op=6 Resume`（带 `s` seq）。
4. 事件归一化 `normalizeEvent`：`AT_MESSAGE_CREATE`（单聊/群聊）→ `QbotNormalizedMessage { channel:'qbot', channelUserId, chatId, chatType:'p2p'|'group', type:'text'|'image'|'file'|'voice', text?, msgId, mediaPath?, rawEvent }`。
   - 文本直接取 `content`；
   - 富媒体（`msg_type=7` + `media.file_info`）→ 下载资源（对齐 §5.7，走 `channel/media-pipeline` 下载落盘 + 语音转文字）。
5. `replyText(openid, chatId, chatType, text)`：REST `POST /v2/users/{openid}/messages`（或 group）发文本；富媒体走 `msg_type=7` + 先 `POST /v2/users/{openid}/files` 上传拿 `file_info`。
6. 稳定性：`s` seq 去重 + Resume；连接态单一 `status` 状态机（`idle`/`waiting_qrcode`/`connected`/`error`）。

### Task 7.3：QbotChannelAdapter + QbotChannelProvider + 注册

**Files:**
- Create `channel/adapters/qbot-channel-adapter.ts`
- Create `channel/providers/qbot-outbound-provider.ts`
- Modify `channel/outbound-types.ts`（`OutboundChannelId` 增 `'qbot'`）
- Modify `channel/channel-registry.ts`（`listProviders` order 数组增 `'qbot'`）
- Modify `channel/channel-hub-bootstrap.ts`（装配 qbot provider，可选参数）
- Modify `index.ts`（工厂接线 + `qbotLoginService` 全局变量 + IPC 命令 `qbot:startLogin`/`qbot:saveCredentials`）

**QbotChannelAdapter**：照 `wecom-channel-adapter.ts` 抄骨架（`StatelessContextStrategy` + `SlashCommandRegistry` help/new/clear/compact/stop + `userQueues` 串行 + `sendTextReply` 走 `qbotLoginService.replyText`）。在场语义自动落入「不在客户端」（`channelType='qbot'` 非 ipc），零额外改动。

**QbotChannelProvider**：`native_push`，peer 为最近入站 `channelUserId`（可主动推送，因有 openid），`sendText` → `replyText`/主动推送 REST，`sendMedia` → msg_type=7。

**channelLabel**：`channelLabelOf` 已含 `qbot: 'QQ'`（Task 2.2 已加），无需再改。

### Task 7.4：qbot 验证

- 扫码建应用（或凭证表单）→ `connected` → 手机 QQ 发消息 → 客户端对话出现消息 → Agent 回复 → 手机收到。
- 富媒体：QQ 发图片/文件 → 客户端拿得到；客户端发文件 → QQ 收到（msg_type=7）。
- 断线重连：kill 连接 → `op=6 Resume` 补发未消费事件。

**提交**：`feat(channel): qbot 渠道接入（扫码建应用 + Gateway WS）`

---

## 8. 验收对照（设计 §5.7 用例 + 各期）

- [ ] P0：ipc 消息不注入 User Presence 段；weixin/feishu/wecom 消息注入且渠道名正确
- [ ] P0：weixin/feishu 同一问题回复长度/格式明显收敛（软约束）+ 渠道侧纯文本兜底（硬保证）
- [ ] P1.0：`index.ts` 三渠道初始化缩为工厂调用，启动日志/事件名不变
- [ ] P1.1：`pnpm build` 通过，飞书登录/收发冒烟无回归
- [ ] P1.2：飞书发语音 → `[语音转录: …]`；飞书/企微发图片/文件 → 客户端拿到本地路径
- [ ] P1.2：客户端发文件飞书/企微 → 对方收到
- [ ] P1.3：HTML 报告生成 + 飞书/企微文件发送通路打通
- [ ] P1.4：QQ 扫码接入 + 文本/富媒体互传 + 断线 Resume

---

## 9. 风险与降级

| 风险 | 缓解 |
|------|------|
| 模型无视注入段 | P1.3 渠道侧纯文本兜底是硬保证 |
| 飞书群聊文件发送收不到 | `pushMedia` 加 `receiveIdType` 参数，列为开放验证项，不预埋 |
| 企微 `voice` 无原始音频 | 直接透传 SDK `voice.content`（设计 §5.7 已明确），不二次 ASR |
| qbot `lite_create` 是内部 cgi 不稳定 | 扫码建应用封装独立 `QbotAppRegistration`，失败自动降级凭证表单 |
| qbot 官方 SDK 停更 2022 | 不引老 SDK，`ws` + fetch 自写 ~150 行 |
| 工厂过度抽象 | 差异项（微信 binding/ASR）留在调用侧闭包，不塞进泛型；第 6 渠道再评估 |

---

## 10. 关键文件清单

| 位置 | 说明 |
|------|------|
| `channel/session-manager.ts` | P0 在场状态统一写入点 |
| `agent-runtime/bridge-instance-state.ts` / `bridge.ts` | presence 字段 + `setInstancePresence` |
| `agent-runtime/bridge-prompt-composer.ts` | User Presence 段注入 |
| `channel/channel-factory.ts`（新） | 渠道初始化样板收敛 |
| `channel/media-pipeline.ts`（新） | 入站媒体归一化共享纯函数 |
| `feishu-login-service.ts` / `feishu-channel-adapter.ts` | 飞书入站媒体 + sendFileReply |
| `wecom-login-service.ts` / `wecom-channel-adapter.ts` | 企微入站媒体 + sendFileReply |
| `qbot-app-registration.ts` / `qbot-session-store.ts` / `qbot-login-service.ts`（新） | qbot 扫码 + 长连接 |
| `channel/adapters/qbot-channel-adapter.ts` / `providers/qbot-outbound-provider.ts`（新） | qbot 渠道适配 |
| `channel/outbound-types.ts` / `channel-registry.ts` / `channel-hub-bootstrap.ts` | qbot 注册接线 |
