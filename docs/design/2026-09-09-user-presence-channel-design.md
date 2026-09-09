# 用户在场感知与渠道自适应 — 设计

> 日期：2026-09-09
> 状态：v1.1 方案草案（已按评审意见修订）
> 相关：`apps/windows/src/main/channel/`、`bridge-prompt-composer.ts`、`bridge-prompt-dispatcher.ts`、`cron-notify-format.ts`
> 参考：`docs/temp/笔记html规范.log`（HTML 样式规范，仅参考样式风格）

---

## 0. 结论摘要

| 问题 | 结论 |
|------|------|
| 信号是什么 | 二元：消息来源判定。`channelType === 'ipc'` = 用户在客户端面前（100%）；**其余一切渠道** = 不在客户端。**渠道不写死**，未知渠道自动适用；**不做**频率/间隔判定，**不做**静默时段 |
| 注入方式 | 每轮 prompt 重建时注入 **User Presence 段**（与 Client Diagnostics 段并列），含回复风格与详略约束；**渠道名用变量动态替换**（`${channelLabel}`），客户端为默认形态不加强 |
| 工具进度 | **暂缓**（方案保留备查，§5.2） |
| 跨渠道连续性 | 询问式接续：渠道消息到达后询问"是否接续上次对话"（0 否 / 1 是，30s 超时默认否），同会话只问一次。复杂可暂缓，记忆系统兜底 |
| 渠道文件交付 | **HTML 单文件**（Tailwind Play CDN 在线样式），移动端优先，不用 Markdown |
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
| 微信发文件已有 | `IChannelAdapter.sendFileReply`（`channel/types.ts:108`，微信已实现）；飞书/企微未实现 |
| 跨渠道绑定已有 | `weixin-session-binding.ts`：`/link` 可把微信会话绑定到客户端会话 |
| Prompt 每轮动态段注入点 | `bridge-prompt-composer.ts:414-420`：Client Diagnostics 段（5s 采样缓存） |
| 渠道交互已文字化 | `channel-interaction-hub.ts:94-114`：AskUserQuestion → 文字选项推送 |

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

### 5.2 工具进度分级过滤（**暂缓**，方案保留备查）

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

### 5.4 跨渠道连续性（P3，可暂缓）

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
   是否接续？回复 0 否，1 是（30 秒内不回复默认不接续）」
      │
      ├─ 回复 1 → /link 绑定该会话（复用 weixin-session-binding），后续消息走该会话
      ├─ 回复 0 → 继续当前会话，标记"已询问过"
      └─ 30s 超时 → 默认不接续，标记"已询问过"
```

- **只问一次**：会话级标志位（内存 Map 即可，不需要持久化——重启后重问一次成本可接受）
- **连续对话直接跳过**：同一会话后续消息不再询问
- **复杂度评估**：中等——需要在 session-manager 或 adapter 层加一个 pending-continuation 状态机 + 30s 定时器。**可暂缓**：记忆系统（MemPalace + user_memory）已提供跨渠道复用兜底，Agent 可从记忆中恢复上下文
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
- 飞书/企微：`IChannelAdapter.sendFileReply` 未实现，需补（飞书 `im.file.create` 上传 + 消息；企微 aibot 仅 replyStream，退化为路径文本提示）

**实现要点**：
- Agent 侧：提供 HTML 报告模板（写入工具提示词或作为 skill），Agent 生成 HTML 文件到 workspace，再走文件发送
- 代码量控制：Tailwind 类名 + 固定模板，Agent 只填内容，不自由发挥样式

---

## 6. 实施分期

### P0（本期）：二元在场信号 + 提示词注入（风格与详略）
1. adapter 三处 `handleMessage` → `sessionManager.prompt()` 前写入 `instanceStates[instanceId]`（`userAtClient` + `channelLabel`）
2. `bridge-prompt-composer.ts`：注入 User Presence 段（`${channelLabel}` 动态替换）
3. 评估：构造 3 组对照样本（微信/飞书/客户端同一问题），验证回复长度与格式差异

### P1：渠道兜底格式化 + HTML 文件交付
1. adapter `sendTextReply` 前纯文本化（复用 `markdownToPlainText`）
2. HTML 报告模板 + 飞书文件上传能力补齐

### P2：交互降级
1. `channel-interaction-hub` 选项数分级（>3 引导回客户端）

### P3（可暂缓）：跨渠道连续性、工具进度分级过滤
1. 询问式接续状态机（§5.4）；暂缓期间由记忆系统兜底跨渠道复用
2. 工具进度分级过滤（§5.2），用户反馈"长任务进度无把控"时启用

---

## 7. 风险与开放问题

| 风险 | 缓解 |
|------|------|
| 模型无视注入段，仍输出长 Markdown | 渠道侧兜底格式化（P1）是硬保证；注入段只是软约束 |
| `userAtClient` 与 `/link` 绑定的组合语义 | 信号必须按**消息来源**而非会话归属判定，已写入 §3.2 |
| 注入段增加 token 开销 | 约 20 tokens/轮，可忽略；与 Client Diagnostics 段同机制 |
| 新渠道接入遗漏渠道名映射 | `channelLabel` 有 fallback（`消息渠道`），未知渠道自动适用 |
| HTML 文件依赖联网（CDN） | 用户手机端打开均有网络；样式失败时 HTML 仍有基本结构可读（渐进增强） |
| 飞书/企微文件发送未实现 | P1 补齐飞书；企微退化为路径文本，不做超出现状能力的事 |

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
