# 用户在场感知与渠道自适应 — 设计

> 日期：2026-09-09（2026-09-10 修订）
> 状态：v1.3 方案草案（按「官方文档核对 + 内置扫码 + 架构收敛」修订）
> 相关：`apps/windows/src/main/channel/`、`bridge-prompt-composer.ts`、`bridge-prompt-dispatcher.ts`、`cron-notify-format.ts`
> 参考：`docs/temp/笔记html规范.log`（HTML 样式规范，仅参考样式风格）

---

## 0. 结论摘要

| 问题 | 结论 |
|------|------|
| 信号是什么 | 二元：消息来源判定。`channelType === 'ipc'` = 用户在客户端面前（100%）；**其余一切渠道** = 不在客户端。**渠道不写死**，未知渠道自动适用；**不做**频率/间隔判定，**不做**静默时段 |
| 注入方式 | 每轮 prompt 重建时注入 **User Presence 段**（与 Client Diagnostics 段并列），含回复风格与详略约束；**渠道名用变量动态替换**（`${channelLabel}`），客户端为默认形态不加强 |
| 工具进度 | **P3**（分级过滤方案保留备查，§5.2） |
| 跨渠道连续性 | **P2**：询问式接续（§5.4），同会话只问一次，1 分钟超时默认接续，记忆系统兜底 |
| 消息渠道 SDK 补全 | **P1**：文本/语音/图片/文件四类内容在客户端↔各渠道互传；飞书/企微入站媒体下载 + 飞书语音自动转文字 + 文件客户端可拿（§5.7） |
| 渠道文件交付 | **HTML 单文件**（Tailwind Play CDN 在线样式），移动端优先，不用 Markdown（§5.6） |
| qbot 渠道 | **P1**：QQ 机器人接入，扫码建应用（`lite_create`）+ 凭证表单双通道，Gateway WebSocket，复用 channel 架构（§5.8） |
| 接入架构 | **P1**：渠道工厂 + 入站媒体管线收敛，新增渠道只加 3 文件不改既有代码（§5.9） |
| 定时任务推送 | 保持现状；在创建定时任务工具的提示词中提醒用户注意推送时机 |
| 最小实现 | P0 约 2 个文件改动：adapter 写入在场状态 + composer 注入段落 |

---

## 1. 背景

### 1.1 问题

用户通过三条路径与 Agent 对话，体验差异巨大：

| 路径 | 用户所处环境 | 能感知的信息 | 现状问题 |
|------|-------------|-------------|---------|
| 客户端（IPC） | 坐在电脑前 | 流式文本、工具卡片、文件树、图片预览、Markdown 渲染、图表 | Agent 无感知，输出未充分利用渲染能力 |
| 微信 / 企微 | 手机/电脑聊天窗 | **纯文本**（Markdown 记号原样显示） | Agent 输出长 Markdown 报告、工具细节 → 用户阅读困难 |
| 飞书 | 手机/电脑聊天窗 | 纯文本 + 换行（不解析 Markdown） | 同上 |

Agent 目前**不知道自己面对的是哪种载体**，用同一套输出策略回复所有渠道。

### 1.2 调研带来的设计原则

网络调研（见 §8 参考）的共识：

1. **连续性优先**：深度 AI 用户期望对话跨设备无缝继续，不必重复上下文。
2. **Summary-first**：结论前置；用户只读摘要就应拿到最小可行答案。
3. **三层递进式披露**：摘要 → 细节 → 深挖（按需），聊天渠道默认最简。
4. **保守默认**：主动行为需频率上限、可退订，宁可沉默不可打扰。
5. **跨渠道一致性在语义层**：术语与心智模型一致，而非结构相同。

---

## 2. 代码事实核查

> 以下基于仓库当前代码，每条注明来源。

### 2.1 已验证的事实

| 事实 | 代码证据 |
|------|---------|
| 渠道类型已有统一枚举值 | `channel/types.ts:21`：`channelType: 'ipc' \| 'weixin' \| string`（实际还有 feishu/wecom） |
| 渠道会话对象是注入点 | `ChannelSession`（`channel/types.ts:16-27`）贯穿 adapter → sessionManager → bridge |
| 主 Agent 路径工具事件**不**发给渠道 | `weixin-channel-adapter.ts:279-298`：只收集 `message:end.fullText`；飞书 `feishu-channel-adapter.ts:235-256` 同 |
| 即时回执已有 | `channel-error-helper.ts:13`：`CHANNEL_ACK_TEXT = '✅ 已收到，正在处理…'`，三渠道均在入口发送 |
| ACP 路径有节流进度 | `weixin-channel-adapter.ts:448-464`：`🔧 执行中`（3s 节流）+ `💭 思考中`；飞书同（`feishu-channel-adapter.ts:320-337`） |
| 渠道格式化策略已存在 | `cron-notify-format.ts`：`markdownToPlainText` / `truncate` / 单行化——说明"渠道不渲染 Markdown"已是既有认知 |
| NO_REPLY 协议已有 | `weixin-channel-adapter.ts:328-334`：Agent 通过 message 工具发送后回复 NO_REPLY 避免重复投递 |
| 微信发文件已有 | `IChannelAdapter.sendFileReply`（`channel/types.ts:108`，微信已实现）；飞书/企微未实现 || 跨渠道绑定已有 | `weixin-session-binding.ts`：`/link` 可把微信会话绑定到客户端会话 |
| Prompt 每轮动态段注入点 | `bridge-prompt-composer.ts:414-420`：Client Diagnostics 段（5s 采样缓存） |
| 渠道交互已文字化 | `channel-interaction-hub.ts:94-114`：AskUserQuestion → 文字选项推送 |
| 富媒体收发严重不均衡 | 微信已基本完整；飞书/企微入站仅文本、出站缺文件。见下矩阵 |

**富媒体收发现状矩阵**（文本 / 语音 / 图片 / 文件四类）：

入站：

| 内容 | 微信 | 飞书 | 企微 |
|------|------|------|------|
| 文本 | ✅ | ✅ | ✅ |
| 语音 | ✅ SILK 解码 → ASR 转文字（`weixin-login-service.ts:411-429`） | ❌ `normalizeMessageEvent` 非 text 直接跳过（`feishu-login-service.ts:484-487`） | ⚠️ SDK 已给转写文字 `voice.content`（无原始音频） |
| 图片 | ✅ 下载本地 `[media attached]` | ❌ | ⚠️ SDK 给 `image.url`+`aeskey`（未下载，`wecom-login-service.ts` 只监听 text/voice/mixed） |
| 文件 | ✅ 下载本地，Agent 可读 | ❌ | ⚠️ SDK 给 `file.url`+`aeskey`（未下载，同上） |

出站：

| 内容 | 微信 | 飞书 | 企微 |
|------|------|------|------|
| 文本 | ✅ | ✅ | ✅ |
| 文件/图片 | ✅ `sendMediaReply` | ⚠️ `pushMedia` 已实现，但 `FeishuChannelAdapter` 未实现 `sendFileReply` | ⚠️ SDK 支持 `uploadMedia`+`replyMedia`/`sendMediaMessage`（未接线） |

> 飞书 SDK 已具备 `im.messageResource.get`（下载音频/视频/图片/文件）与 `im.image/im.file` 上传能力（`@larksuiteoapi/node-sdk`）。企微 SDK `@wecom/aibot-node-sdk` 也已具备 `downloadFile(url, aeskey)` 下载、`uploadMedia` 三步上传、`replyMedia`/`sendMediaMessage` 发送，能力在 SDK 层齐备，只差 adapter 接线——上一版「企微无文件能力」的判断已过时，需更正。

### 2.2 须修正的认知

- `docs/design/2026-08-14-channel-outbound-hub-design.md` 已定义出站统一路由，但**入站消息来源 → Agent 输出策略**这一环没有设计——本设计补上。
- `cron-notify-dispatch.ts` 源文件不存在（仅测试残留），cron 推送实际在 `cron-scheduler.ts` 内（`sendFeishuMessage` 注入 + `cron-notify-format.ts` 格式化）。

---

## 3. 在场（Presence）模型

### 3.1 二元信号（已确认的方案）

```
userAtClient = (channelType === 'ipc')
```

| 消息来源 | 判定 |
|---------|------|
| 客户端对话（IPC） | 用户在客户端面前（100%） |
| 任何非 ipc 渠道 | 用户不在客户端面前 |

**渠道不写死**：判定只认 `ipc`，其余渠道（现有微信/飞书/企微 + 未来接入的任何渠道）自动归入"不在场"，新渠道接入零改动。置信度不做区分（90% 之类的估计不写入逻辑）。

**已确认不做**（评审决策）：
- 不做客户端消息频率/间隔判定
- 不做静默时段设置
- 不做五态在场模型（active/idle/away/dnd/offline）
- 定时任务推送时机：保持现状，在**创建定时任务工具的提示词**中提醒用户注意即可

### 3.2 信号传播路径

```
[ipc-channel-adapter] ──┐
[weixin-channel-adapter]┼─→ handleMessage() → sessionManager.prompt()
[feishu-channel-adapter]┤        │
[wecom-channel-adapter]─┘        ▼
                          bridge.prompt() → promptRebuilder() 重建 basePrompt
                                  │
                                  ▼
                          BridgePromptComposer.buildPromptWithMemory()
                                  │  读取 instanceStates[instanceId].userAtClient
                                  ▼
                          注入 User Presence 段 → instance.setSystemPrompt()
```

实现要点：
1. 不新增字段，由 `channelType` 推导（`channelType === 'ipc'`），零冗余
2. adapter 在 `sessionManager.prompt()` 调用前，将 `userAtClient` 与 `channelLabel`（渠道中文名，未知渠道 fallback `消息渠道`）写入 `instanceStates[instanceId]`
3. `BridgePromptComposer.buildPromptWithMemory()` 读该值，生成段落（`${channelLabel}` 动态替换）
4. **信号按消息来源判定，而非会话归属**——`/link` 绑定后渠道消息仍判为"不在客户端"

---

## 4. 提示词注入设计

### 4.1 注入内容（含风格与详略约束）

在 `buildPromptWithMemory()` 的 dynamicParts 中追加（与 Client Diagnostics 段并列，约 20 tokens）。**渠道名是变量**：`${channelLabel}` 由 adapter 写入实例状态（如 `微信`/`飞书`/`企业微信`，未知渠道 fallback 为 `消息渠道`），注入时动态替换，不在提示词中写死渠道枚举。

```
## User Presence（本轮回复载体）
- 用户在客户端面前（channel=ipc）：
  - 默认形态，无额外约束（完整界面能力由系统提示词其余部分与工具描述覆盖）。
- 用户不在客户端面前（channel=${channelLabel}）：
  - 用户只能收到纯文本，Markdown 记号原样显示为噪声；看不到工具卡片与文件树。
  - 风格：结论前置（1-2 句摘要开头）；口语化短句；用「1. 2. 3.」编号替代列表与表格。
  - 详略：默认 ≤200 字；用户明确要求"详细"时再展开（此时仍用纯文本结构，不分层标题）。
  - 禁忌：不输出表格、代码块、分层标题；不写「见左侧文件树」「点击下方按钮」等 UI 依赖表述。
  - 生成文件时：告知文件名与保存位置；长内容（报告/笔记）写成 HTML 文件发送（见工具约束），聊天内只发 3 行摘要。
```

### 4.2 为什么注入系统提示词而不是用户消息

- 系统提示词每轮随 `promptRebuilder` 重建，天然跟随会话渠道切换
- 不污染 DB 中持久化的用户消息（历史回溯时不会重复出现）
- 与既有动态段（记忆/任务/诊断）同一机制，实现成本最低

### 4.3 不做什么

- **不**在注入段里教 Agent "你该用什么工具"——工具过滤已有独立机制（§5.2）
- **不**持久化在场状态——它是轮次级瞬态，不是记忆
- **不**让模型自行决定推送路由——路由是确定性代码逻辑，不是 LLM 判断

---

## 5. 应用场景

### 5.1 回复风格与详略自适应（P0，收益最高）

**问题**：同一 Agent 给微信用户输出 500 字 Markdown 报告。

**方案**：
1. §4.1 注入段给出风格与详略约束（软约束）
2. 渠道侧兜底格式化（硬保证）：adapter `sendTextReply` 前复用 `cron-notify-format.ts` 的 `markdownToPlainText` / `truncate` 做纯文本化

**详略三级**（注入段约束，渠道兜底截断）：

| 级别 | 触发 | 长度 |
|------|------|------|
| 简答（默认） | 渠道常规消息 | ≤200 字，结论前置 |
| 标准 | 用户明确要"详细" | ≤800 字，编号分段 |
| 长内容 | 报告/笔记/多文件结果 | 聊天内 3 行摘要 + HTML 文件（§5.6） |

**调研依据**：
- Summary-first：只读摘要即拿到最小可行答案
- 三层递进式披露：摘要 → 细节 → "需要详细版回复'详细'"
- 反模式警戒：**不可逆副作用、权限、安全关键细节不得折叠/省略**——渠道压缩长度时，审批与危险操作描述必须完整保留

### 5.2 工具进度分级过滤（**P3**，暂缓，方案保留备查）

**决策**：评审确认暂时不做。以下方案保留，未来做时直接启用。

**问题**：主 Agent 路径渠道只收最终文本，**5 分钟以上的长任务期间用户完全不知道 Agent 是干活还是挂了**。

**现状**：

| 路径 | 渠道可见 |
|------|---------|
| 主 Agent（微信/飞书/企微） | 仅 ACK + 最终文本 |
| ACP（微信/飞书） | ACK + 节流 `🔧 执行中` / `💭 思考中` + 最终结果 |

**方案（分级过滤，替代二元的"全发/全不发"）**：

| 事件等级 | 触发条件 | 渠道输出 |
|---------|---------|---------|
| 心跳 | 单工具运行 >45s 且无输出 | `⏳ 任务仍在进行（已45s）：<工具名>`，之后每 60s 一次 |
| 里程碑 | 关键工具成功（构建通过/文件已保存） | `✅ <一句话结果>`（合并进最终回复，不单独发） |
| 失败摘要 | 工具失败且 Agent 继续 | `⚠️ <工具> 失败：<错误首行>，已尝试继续` |
| 产出物 | 生成文件/图片 | 文件走 HTML/`sendFileReply`（§5.6）；不支持富媒体的渠道发路径 |
| 最终回复 | 始终 | 不变 |

**护栏**：每轮渠道消息数上限 ≤5 条，超出合并为一条摘要；心跳消息不得包含敏感路径与完整错误堆栈。

**实现位置（未来启用时）**：主 Agent 路径在 `registerNodeStreamCallback` 中监听 `agent:tool:start/end` 事件（现只监听 message:end，扩展即可）；ACP 路径在现有节流逻辑上升级。

### 5.3 定时任务推送

**决策**：保持现状（`notify_targets` 路由 + `cron-notify-format.ts` 格式化），不做在场路由与静默时段。在**创建定时任务工具的提示词**中增加一句提醒："请提醒用户：定时任务会在设定时间推送到所选渠道，请自行注意推送时机与频率。"

### 5.4 跨渠道连续性（P2）

**问题**：用户微信里说"继续上次的任务"，Agent 不知道"上次"指哪个会话。

**方案（询问式接续）**：

```
渠道消息到达（非斜杠命令）
      │
      ▼
检查：该 channelUserId 是否在其他渠道有活跃会话（客户端/微信/飞书/企微，最近 N 天有消息）
      │ 有，且本渠道会话未标记"已询问过"
      ▼
先回复询问：
  「检测到你在【客户端】有进行中的对话：<标题+一句摘要>
   是否接续？回复 0 否，1 是（1 分钟内不回复默认接续）」
      │
      ├─ 回复 1 → /link 绑定该会话（复用 weixin-session-binding），后续消息走该会话
      ├─ 回复 0 → 继续当前会话，标记"已询问过"
      └─ 1 分钟超时 → 默认接续（同回复 1），标记"已询问过"
```

- **只问一次**：会话级标志位（内存 Map 即可，不需要持久化——重启后重问一次成本可接受）
- **连续对话直接跳过**：同一会话后续消息不再询问
- **复杂度评估**：中等——需要在 session-manager 或 adapter 层加一个 pending-continuation 状态机 + 1 分钟定时器。**可暂缓**：记忆系统（MemPalace + user_memory）已提供跨渠道复用兜底，Agent 可从记忆中恢复上下文
- 调研依据：连续性是多渠道 AI 的第一期望（83%），"不必重复自己"

### 5.5 交互降级（P2）

**问题**：`AskUserQuestion` 文字化后（`channel-interaction-hub.ts`），>3 个选项在聊天窗不可读。

**方案**：
- ≤3 选项：文字化呈现（现状），选项编号 `1/2/3`
- >3 选项或需要富交互（多选/文件选择）：回复"此操作需要桌面客户端完成，请打开 Lumii 客户端继续"，并在客户端弹窗

### 5.6 渠道文件交付：HTML 单文件（P1）

**决策**：发给消息渠道的文件信息用 **HTML 单文件**，不用 Markdown（手机端 Markdown 无渲染）。

**样式规范**（参考 `docs/temp/笔记html规范.log` 的样式风格，不参考其内容）：

| 项 | 规范 |
|----|------|
| 样式方案 | **Tailwind Play CDN**（在线样式），不手写大段 CSS；自定义样式仅允许少量 `<style>` 固定类 |
| 交付形态 | 单文件 HTML，需联网打开（样式走 CDN） |
| 移动端优先 | 正文 16.5px；段落短；表格 `overflow-x-auto` + `min-w`；长图容器允许横滑 |
| 图表 | Mermaid v10 CDN（如需要） |
| 标记体系（借鉴） | 关键结论高亮（每节 ≤2 处）、警告红字（每节 ≤1 处）、折叠块收次要内容——宁缺勿滥 |
| 图片 | 小图 base64 内嵌（保证手机可见）；大图/多图改为提示回客户端查看 |
| 结构 | 顶部结论摘要卡 → 正文编号节 → 底部"本报告由 Lumii 生成 + 时间" |

**发送路径**：
- 微信：`sendFileReply`（已实现）
- 飞书：`FeishuChannelAdapter.sendFileReply` 待补（接 `pushMedia`，`im.file.create` 上传 + 消息）
- 企微：`WecomChannelAdapter.sendFileReply` 待补（SDK `uploadMedia` + `replyMedia`/`sendMediaMessage`，能力已具备）

**实现要点**：
- Agent 侧：提供 HTML 报告模板（写入工具提示词或作为 skill），Agent 生成 HTML 文件到 workspace，再走文件发送
- 代码量控制：Tailwind 类名 + 固定模板，Agent 只填内容，不自由发挥样式

### 5.7 消息渠道 SDK 补全：文本/语音/图片/文件互传（P1）

**目标**：补全并保持「当前最新」的消息渠道 SDK，重新梳理验证四类内容在「客户端 ↔ 各渠道」两个方向都能通达。一句话验收：**飞书发语音给客户端 → 自动转文字；飞书发文件 → 客户端拿得到。**

**SDK 版本核对结论（2026-09-10）**：

| SDK | 项目依赖声明 | 实际安装 | npm 最新 | 动作 |
|-----|------------|---------|---------|------|
| `@larksuiteoapi/node-sdk`（飞书） | `^1.71.1` | 1.72.0 | 1.73.3 | **升级到 1.73.3**（补丁版，向后兼容） |
| `@wecom/aibot-node-sdk`（企微） | `^1.0.7` | 1.0.7 | 1.0.7 | 已最新，无需动 |
| QQ 官方 SDK | — | — | — | 见 §5.8 选型 |

**通用约定**（三个渠道统一，避免各写各的）：

1. **入站媒体统一归一化**：下载到 workspace 本地文件后，以既有 `[media attached: <绝对路径> (<文件名>)]` 行注入 prompt（复用微信现协议 `weixin-message-utils.ts` 的 `extractMediaAttachmentLines`），Agent 直接读本地路径。
2. **入站语音统一转文字**：能拿原始音频的（微信 SILK、飞书 audio/file、企微 file），用已就绪的 `@ffmpeg-installer/ffmpeg`（转 16k PCM）+ `sherpa-onnx-node` ASR（`voice-transcription.ts` 的 `transcribePcm`）转成 `[语音转录: <text>]` 注入；原始音频文件同时按媒体行保留，Agent 可选读。只能拿转写文字的（企微 `voice.content`），直接用 SDK 给的字。
3. **出站文件统一走 `sendFileReply`**：补齐飞书、企微两个 adapter 的 `sendFileReply`（微信已实现）；文件/图片经各 LoginService 的媒体 API 发送。

**各渠道落地清单**：

| 渠道 | 入站要补 | 出站要补 | 改动文件 |
|------|---------|---------|---------|
| 微信 | ✅ 已完整（语音/图片/文件已下载+ASR） | ✅ 已完整（`sendMediaReply`） | 无（仅验证） |
| 飞书 | ① `normalizeMessageEvent` 放开非 text：audio/image/file 各解析 content 拿 `file_key` ② `im.messageResource.get` 下载 ③ audio 转 opus→pcm→ASR | `FeishuChannelAdapter.sendFileReply` 接 `pushMedia`（复用已有上传） | `feishu-login-service.ts`、`feishu-channel-adapter.ts` |
| 企微 | ① `wecom-login-service.ts` 增监听 `message.image`/`message.file`（+`video` 可选）② 走 SDK `downloadFile(url, aeskey)` 下载本地 | `WecomChannelAdapter.sendFileReply` 接 SDK `uploadMedia`+`replyMedia`；主动推送走 `sendMediaMessage` | `wecom-login-service.ts`、`wecom-channel-adapter.ts` |

**飞书入站非 text 消息的 content 结构**（对齐 SDK 事件 `im.message.receive_v1`）：`audio`/`file` 类 content JSON 内带 `file_key`；`image` 带 `image_key`。下载统一走 `im.messageResource.get({ path: { message_id, file_key }, params: { type } })`，返回 `getReadableStream()`。

> 实测更正（2026-09-10）：`messageResource.get` 的 `type` 参数**仅接受 `image` / `file`**，传 `audio` 会返回 HTTP 400（`Request failed with status code 400`）。语音消息须以 `type: 'file'` 下载原始 opus，再走 ffmpeg → 16k PCM → ASR 转文字。

**企微入站媒体结构**（对齐 `@wecom/aibot-node-sdk` `types/message.d.ts`）：`ImageContent`/`FileContent`/`VideoContent` 均带 `url`（5 分钟内有效，已加密）+ `aeskey`；`VoiceContent` 只有转写文字 `content`。下载统一走 `WSClient.downloadFile(url, aeskey)` 返回 `{ buffer, filename }`。

**验证用例（验收标准）**：
1. 飞书发语音 → 客户端对话出现 `[语音转录: …]`（无 ffmpeg/ASR 时降级为媒体行，不报错）
2. 飞书发图片/文件 → 客户端可下载、Agent 拿到本地路径
3. 企微发图片/文件 → 同上（`downloadFile` 解密落地）
4. 客户端生成文件发飞书/企微 → 对方收到文件（`sendFileReply`）
5. 微信现有四类互传回归无回归

> 语音载体语义（2026-09-10 实测确认）：微信/飞书语音消息只把 `[语音转录: …]` 注入 prompt，**不**附带原始音频文件路径（`.silk`/`.opus` Agent 读不了，附上会被当成噪声）。无转录结果时给占位文案，不静默吞消息。

### 5.8 qbot（QQ 机器人）渠道接入（P1）

**目标**：新增 QQ 机器人渠道，复用现有 channel 架构（`IChannelAdapter` + `ChannelSession` + 出站 Hub），支持扫码接入。

**官方文档核对结论（2026-09-10，来源见 §8）**：

1. **凭证**：`AppID + AppSecret`，创建于 `q.qq.com`（机器人可进群聊/频道，QQ 用户可单聊）。`Token` 鉴权已废弃，统一 `Access Token`。
2. **长连接**：标准 Discord 式 Gateway WebSocket —— `GET /gateway` 拿 `wss://api.bot.qq.com/websocket`，`op=2 Identify`（token=`QQBot {AccessToken}` + intents + shard）→ `READY`，心跳 `op=1`/`op=11`，断线 `op=6 Resume` 补发事件。
3. **富媒体**：发送走 `msg_type=7` + `media.file_info`；先上传拿 `file_info`（`POST /v2/users/{openid}/files` 或 `/v2/groups/{openid}/files`），支持图片/语音/文件/视频，硬限制 200MB，超软限制降级为文件。**接收**语音/图片/文件同飞书/企微，需下载资源。
4. **官方 SDK**：`bot-node-sdk`（`github.com/tencent-connect/bot-node-sdk`，npm `qq-guild-bot`），但**版本停更于 2022**（latest 2.9.5，dep 依赖 `ws@7`、`resty-client@0.0.5`），落后于 2026 官方文档（新版 Access Token / 富媒体分片上传 / api-v2）。结论：**不直接引老 SDK**，Gateway 与 REST 用 `ws`（已在依赖中）+ 原生 fetch 自写，体积 ~150 行，符合「已装依赖优先」原则。

**接入方式：内置扫码（优先）**：

已逆向核对 OpenClaw 社区 `@sliverp/qqbot` 的前端实现，QQ 官方**确有**一套 device-code 扫码创建机器人的接口，且与本项目飞书/企微的扫码链路同构，可复用既有 `FeishuLoginService.startLogin` 的「出码 → 轮询 → 拿凭证」骨架：

| 步骤 | 接口 | 说明 |
|------|------|------|
| 1. 开发者登录态 | `q.qq.com` 手机 QQ 扫码（OAuth，拿到 `developer_id` cookie） | 前端 `useLoginSession.js` 轮询 `{code: Success/Waiting/Scanned/Rejected/Expired}` |
| 2. 创建机器人 | `POST bot.q.qq.com/cgi-bin/lite_create`（body `{apply_source:1, idempotency_key}`） | 返回 `data.appid` + `data.client_secret`（= AppID/AppSecret） |
| 3. 重置 Secret | `POST /cgi-bin/dev_info/lite_reset_secret`（body `{bot_appid}`） | AppSecret 忘时用 |

- **注意**：这套接口是**内部 cgi（未公开承诺稳定）**，OpenClaw 也在用（其 `docs/temp/qbot文档.md` 的扫码页即此）。设计上把「扫码建应用」封装成独立 `QbotAppRegistration`（对齐 `feishu-app-registration.ts`），若接口失效则自动降级为**凭证表单**（用户去 `q.qq.com` 手填 AppID+AppSecret），二者共享同一 `QbotLoginService` 收尾。
- **落地顺序**：先做「扫码建应用 + 凭证表单双通道」，扫码接口能通就用扫码，异常兜底表单。这是唯一把 AppSecret 一次性写入本地的路径，且不需要用户在腾讯侧手动拷贝。

**实现清单**：

| 项 | 内容 | 文件 |
|----|------|------|
| 注册客户端 | `QbotAppRegistration`：init/begin/poll 三态（对齐 `feishu-app-registration.ts`），内部调 `lite_create` | 新增 `qbot-app-registration.ts` |
| LoginService | `QbotLoginService`：凭证落盘（`qbot-session-store.ts`）+ Gateway WS 长连接（op10/2/6/1）+ Access Token 换取 + 消息事件发射 | 新增 `qbot-login-service.ts`、`qbot-session-store.ts` |
| 消息归一化 | 文本为主；`msg_type` 区分（文本/图片/语音/文件），媒体走 §5.7 统一下载路径 | 同上 |
| Adapter | `QbotChannelAdapter`：复用 `StatelessContextStrategy` + `SlashCommandRegistry`（help/new/clear/compact/stop） | 新增 `adapters/qbot-channel-adapter.ts` |
| 出站 Provider | `QbotChannelProvider`：`native_push`（openid/群 openid），文本 + 富媒体（msg_type=7） | 新增 `providers/qbot-outbound-provider.ts` |
| 注册接线 | `channel-registry.ts` order 增加 `qbot`；`channel-hub-bootstrap.ts` 注入；`index.ts` 初始化 + 状态事件转发 | 改 3 处 |
| 前端展示 | 设置页 `QbotChannelSettings` 卡片（扫码建应用 + AppID/AppSecret 表单兜底）；preload 暴露 `qbotService`（含 `saveCredentials`）；侧栏 QQ 会话分组；`ChannelBrandIcon` QQ 字标 | 新增/改 7 处渲染进程文件 |

**qbot 在场/详略语义**：与其它非 ipc 渠道一致 —— `channelType = 'qbot'`，自动落入「不在客户端」分支，注入段 `channelLabel = QQ`，零额外改动（§3.1 渠道不写死的设计红利）。

### 5.9 渠道接入的可维护性 / 扩展性 / 可读性 / 稳定性（架构设计）

> 现状四渠道（ipc/weixin/feishu/wecom）已按 `IChannelAdapter` + `ChannelSession` 抽象。加入 qbot 后变五渠道、且未来可能再接更多，若不收敛，每个新渠道都要在 `index.ts` 复制 40+ 行初始化 + 手工写 adapter 的入站/出站/状态代码，维护成本线性膨胀。

**设计目标**：新增一个渠道 = 新增 3 个文件（LoginService / Adapter / OutboundProvider）+ 在注册表登记一行，**不改既有代码**（开闭原则）。

**分层与职责**（沿用现状，明确边界，不改结构）：

| 层 | 职责 | 稳定/易变 |
|----|------|----------|
| `IChannelAdapter`（协议） | 收发文本/文件、上下文策略、斜杠命令路由 | 稳定 |
| `ChannelSession` | 路由信息（sessionKey/channelType/channelUserId/replyContext） | 稳定 |
| `*LoginService` | 各厂商 SDK 封装：扫码/长连接/媒体 API，只对 adapter 暴露规范化事件与 `replyText/pushText/pushMedia` | 易变（随 SDK 升级） |
| `*OutboundProvider` | 出站 Hub 的 `sendText/sendMedia/getSnapshot` | 易变 |
| `ChannelRegistry`/`Router` | 渠道注册与路由分发 | 稳定 |

**可维护性 / 扩展性约定**：

1. **渠道工厂收敛初始化**：新增 `createChannelFactory()`，把「LoginService 实例化 → Adapter 构造 → startListening → 状态事件转发到渲染进程」这一套固定样板收进一个函数，`index.ts` 只传渠道清单。当前四渠道在 `index.ts` 内各自手写初始化（飞书 20 行、企微/微信各自展开），qbot 接入时一并抽成统一工厂，避免第五份样板。
2. **入站媒体管线模板方法**：四渠道入站「下载媒体 → 语音转文字 → 组装 `[media attached]` + `[语音转录]`」逻辑高度一致，抽成共享纯函数 `normalizeInboundMedia()`（放 `channel/media-pipeline.ts`），各 adapter 调它，只填厂商差异（下载器、原始音频判断）。这是 §5.7 三约定落到代码的承载点，避免四份拷贝。
3. **出站文件走统一接口**：`IChannelAdapter.sendFileReply` 已是可选方法，飞书/企微补齐后，四个渠道的「文件/图片出站」由 Agent 侧同一工具路径触发，adapter 各自实现，不新增平行路径。
4. **凭证/会话持久化统一**：`*session-store.ts` 已有飞书/企微/微信三份，均「load/save/clear 一个 JSON」。qbot 复用同模式（`qbot-session-store.ts`），后续可再抽共享基类（YAGNI，暂不抽）。
5. **斜杠命令复用**：`SlashCommandRegistry` + `clear/help/new/compact/stop` 已跨渠道复用；qbot 直接挂同一套，不重复注册。

**稳定性约定**：

1. **连接态单一事实源**：每个 `*LoginService` 用 `status` 状态机（idle/waiting_qrcode/connected/error）+ `statusChange` 事件，adapter/provider 一律读 `getStatus()`，不自建第二份连接标志。
2. **串行队列防并发**：入站处理沿用 `userQueues`（微信/飞书/企微已有），qbot 照搬，避免同一用户并发跑 Agent 导致上下文错乱。
3. **幂等 + 去重**：媒体下载按 `file_key/message_id` 幂等（已存在则复用本地路径）；Gateway 事件按 `s`（seq）去重/续传（QQ 特有 `op=6 Resume`）。
4. **错误兜底不静默**：出站沿用 `ChannelSendResult{ok,errorCode,message}` 硬失败语义；扫码/长连接异常一律 emit `error` + 状态回退，绝不吞异常。
5. **软限制降级**：富媒体超过厂商软限制（QQ 图片 >20MB 等）时降级为「文件类型」发送，硬限制（200MB）时明确报错，不赌运气。

---

## 6. 实施分期

### P0（本期）：二元在场信号 + 提示词注入（风格与详略）
1. adapter 三处 `handleMessage` → `sessionManager.prompt()` 前写入 `instanceStates[instanceId]`（`userAtClient` + `channelLabel`）
2. `bridge-prompt-composer.ts`：注入 User Presence 段（`${channelLabel}` 动态替换）
3. 评估：构造 3 组对照样本（微信/飞书/客户端同一问题），验证回复长度与格式差异

### P1：渠道架构收敛 + SDK 补全 + HTML 文件交付 + qbot 接入
0. **架构收敛**（§5.9，先做，为后续铺路）：`createChannelFactory()` 收掉四渠道初始化样板；`normalizeInboundMedia()` 抽出入站媒体管线（下载→转写→组装）
1. **SDK 升级**（§5.7）：飞书 `@larksuiteoapi/node-sdk` 1.72.0 → 1.73.3
2. **SDK 补全**（§5.7）：飞书入站非 text（audio/image/file）下载 + 语音转文字；企微入站 image/file 监听 + `downloadFile`；`FeishuChannelAdapter.sendFileReply`、`WecomChannelAdapter.sendFileReply` 补上
3. **HTML 文件交付**（§5.6）：HTML 报告模板 + 飞书/企微文件上传能力补齐
4. **qbot 接入**（§5.8）：扫码建应用（`QbotAppRegistration`）+ 凭证表单双通道 + `QbotLoginService`/`QbotChannelAdapter`/`QbotChannelProvider` + 注册接线

### P2：跨渠道连续性 + 交互降级
1. 询问式接续状态机（§5.4）；期间由记忆系统兜底跨渠道复用
2. `channel-interaction-hub` 选项数分级（>3 引导回客户端，§5.5）

### P3（暂缓）：工具进度分级过滤
1. 分级过滤（§5.2），用户反馈"长任务进度无把控"时启用

---

## 7. 风险与开放问题

| 风险 | 缓解 |
|------|------|
| 模型无视注入段，仍输出长 Markdown | 渠道侧兜底格式化（P1）是硬保证；注入段只是软约束 |
| `userAtClient` 与 `/link` 绑定的组合语义 | 信号必须按**消息来源**而非会话归属判定，已写入 §3.2 |
| 注入段增加 token 开销 | 约 20 tokens/轮，可忽略；与 Client Diagnostics 段同机制 |
| 新渠道接入遗漏渠道名映射 | `channelLabel` 有 fallback（`消息渠道`），未知渠道自动适用 |
| HTML 文件依赖联网（CDN） | 用户手机端打开均有网络；样式失败时 HTML 仍有基本结构可读（渐进增强） |
| 飞书/企微文件发送未实现 | P1 补齐飞书 + 企微（企微 SDK `uploadMedia`/`replyMedia` 已具备，能力无缺口） |
| 飞书语音转文字依赖 ffmpeg + ASR 链路 | 复用已就绪的 `@ffmpeg-installer/ffmpeg` + `sherpa-onnx-node` ASR（微信 SILK 路径已验证同链路） |
| qbot 扫码建应用接口是内部 cgi，非公开承诺 | 把扫码封装成独立 `QbotAppRegistration`，接口失效自动降级凭证表单（去 `q.qq.com` 手填），二者共享 `QbotLoginService` 收尾 |
| qbot 官方 SDK 停更于 2022，落后于 2026 文档 | 不引老 SDK；Gateway + REST 用 `ws`（已在依赖）+ 原生 fetch 自写 ~150 行，紧跟官方文档 |
| 企微入站图片/文件未接线（上一版误判为「无能力」） | 更正：SDK `downloadFile(url,aeskey)` 已具备，P1 补 adapter 监听即可，非能力缺口 |

---

## 8. 参考资料

调研来源（2026-09-09 网络搜索）：

- [One Size Fits None: Why the Future of AI Interfaces Must Be Radically Adaptive](https://martechseries.com/mts-insights/guest-authors/one-size-fits-none-why-the-future-of-ai-interfaces-must-be-radically-adaptive/)
- [Design trends 2026: AI leaves the chat](https://www.goodbarber.com/blog/design-trends-2026-ai-leaves-the-chat-the-design-system-makes-the-rule-a1608/)
- [Cross-Platform IA: Maintaining Consistency from Web to Voice — UX Matters](https://www.uxmatters.com/mt/archives/2026/03/cross-platform-ia-maintaining-consistency-from-web-to-voice.php)
- [10 Guidelines for Designing Your Site's AI Chatbots — NN/g](https://www.nngroup.com/articles/ai-chatbots-design-guidelines/)
- [Multichannel AI Chatbot: Unified Support Across Web, Mobile & Social Channels](https://hologrow.ai/blog/multichannel-ai-chatbot-unified-support)
- [Progressive Disclosure — AI UX Playground](https://www.aiuxplayground.com/pattern/progressive-disclosure/)
- [Progressive Disclosure in Agent Interactions — CallSphere](https://callsphere.ai/blog/progressive-disclosure-agent-interactions-right-information-right-time)
- [FullAgenticStack WhatsApp-first: RFC-WF-0023](https://dev.to/fullagenticstack/fullagenticstack-whatsapp-first-rfc-wf-0023-18en)

内部参考：
- `docs/temp/笔记html规范.log`（HTML 样式规范）
- `docs/design/2026-08-14-channel-outbound-hub-design.md`（渠道出站 Hub）

官方文档 / SDK 核对（2026-09-10）：

- QQ 机器人官方文档：`https://bot.q.qq.com/wiki/`（启动接入 / WebSocket 方式 / 富媒体消息概述 / api-v2）
- QQ 官方 Node SDK（停更 2022）：`https://github.com/tencent-connect/bot-node-sdk`（npm `qq-guild-bot`）
- OpenClaw QQ 扫码建应用内部接口（逆向自其前端资源 `q.qq.com/qqbot/openclaw`）：`POST bot.q.qq.com/cgi-bin/lite_create` → `{appid, client_secret}`
- 飞书 SDK：`@larksuiteoapi/node-sdk`（npm 最新 1.73.3，项目安装 1.72.0）
- 企微 SDK：`@wecom/aibot-node-sdk`（npm 最新 1.0.7 = 已安装；`WSClient.downloadFile/uploadMedia/replyMedia/sendMediaMessage` 能力核对自其 `dist/*.d.ts`）
