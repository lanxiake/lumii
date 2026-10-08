# 微信消息实时监控与交互优化方案

> **状态（2026-10-08 更新）**
> - **P0-A 路径发现**：已落地（`25a35ea3`）。
> - **P0-B 发送链路**：已落地（`25a35ea3` 重试与错误码、`d6bb59be` 三处根因修复）——实现方案与本节
>   原稿不同，见 [§2.2](#22-p0-b-发送链路已完成方案改写)。
> - **P1 实时读取**：已落地（`246f6d59`，见 [§2.3](#23-实时读取原-p1-核心已完成)）。原方案里
>   「WAL 帧解析」「watchdog 独立监控进程」两个设计**作废**，理由见 [§3.2](#32-作废的设计记录理由避免重走)。
> - **监控回路（零 token 门闩）**：**v1+v2 已落地**（v1 `7f5e9b5f` / v2 `2afdf560`，见 [§3.3](#33-监控回路零-token-门闩v1--v2-已落地)）——
>   15 秒一拍、确定性读库；按**分组**决定「只提醒 / 起草待确认 / 直接代回」。
> - **组织形态收敛**：**M1 + M2 + M3 已落地**（本机微信成为独立渠道 `pcwechat`，会话按 peer 分；
>   注册为该渠道的**出站 provider**，策略落 `channel-policies.json` 并在
>   设置 → 渠道 → 本机微信 里配账号·回复策略·黑白名单；
>   代聊主体是用户 Agent **「灵栖代聊」**，手册住在它的 `systemPrompt` 里，
>   盯梢改走 `channel_send`，见 [§3.4](#34-组织形态复盘与收敛路线m1-已落地)）；
>   剩 M3 的入站 adapter（现在仍走盯梢旁路）。

---

## 一、现状诊断（按实测修正）

### 1.1 原判断 vs 实测

| 原方案判断 | 实测 | 证据 |
|---|---|---|
| P0-A：硬编码单一路径，20%+ 用户找不到数据目录 | **成立**，已修 | `list_accounts()` 多路径 + 注册表；本机数据其实在 `Documents\xwechat_files`（junction 是读的前提） |
| P0-B：「UI Automation 定位失败」→ 需上 COM Interop | **不成立**。真因是三个独立缺陷（见 §1.2），与定位无关；且微信**不提供** `WeChat.Application` 这类 COM 接口，做它等于协议逆向——触碰「零注入」红线 | `d6bb59be`；实测往返 |
| P1：「轮询 CPU 空转 99%」 | **定性错了**。轮的不是 CPU，是**模型 token**：每个 tick 都叫一次 LLM，只为发现「没事发生」。真正的技术缺陷在**读路径**（读旧×3、读贵×2） | §1.2 / §1.3 |
| P1：「解析 WAL 帧、提取新消息 rowid」 | **不可行**：WAL 帧是**加密页**，里面没有可解析的行。正确姿势是「感知文件变化 → 增量解密 → 查库」，见 §2.3 | `wxread4.py` 的页格式 |
| P1：「watchdog 监听 + 独立监控进程 + bridge 集成」 | **不必要**：MCP 子进程内单线程做增量即可（空闲 2.5ms/拍）；独立进程只多出生命周期、并发与状态同步问题 | §2.3 |

### 1.2 读路径的五个真实缺陷（本轮实测发现并修复）

1. **读旧①（最严重）**：缓存新鲜度**只看主库 mtime**。微信是 WAL 模式，新消息先落 `-wal`、主库文件
   只在 checkpoint 时才写——两次 checkpoint 之间的新消息在这个键上**完全不可见**：轮询永远轮不到。
2. **读旧②**：`-wal` 文件是**不截断复用**的。每次 checkpoint 重置只改写 32 字节的头（新 salt）然后从
   偏移 32 继续追加；上一轮的老帧**物理留在后面**。实测本机 `message_0.db-wal`：689 帧里 **683 帧不属于
   当前会话**（salt 与头不符）。机械地把整文件当一段重放，会把**多个时代的页**混着贴上去——现场症状
   正是「群行消失 / 群名回退」。
3. **读旧③**：临时目录里的**过期 `.copy-wal`** 被当成这次的输入。checkpoint 后 SQLite 会**删掉** `-wal`，
   而旧实现「源里没有就不复制」，于是上一轮的旧副本继续参与重放 → 又是读旧。
4. **读贵①**：`keys()` 扫微信进程内存取密钥，实测 **~1.9s**，而每次全量重建都白付一遍（密钥在微信重启前不变）。
5. **读贵②**：`Msg_*` 表**没有 create_time 索引**，`create_time > ?` 是全表扫描 + 临时排序；轮询还按
   「每会话 × 每分片」各开一次连接（68 会话 → 135+ 次连接）。

### 1.3 关键实测数据（本机：`message_0.db` 3.5MB + WAL 2.7MB，68 个会话）

| 项 | 改造前 | 改造后 |
|---|---|---|
| 冷启动首次读 | 3.2s | 1.9s（首拍仍要扫一次进程内存取密钥，不可省） |
| 空闲一轮刷新 | 主库变了就 1.6~3.2s 全量；只动 WAL 则**永远看不到** | **2.5ms**（WAL 感知 + 密钥缓存） |
| 一条新消息的增量 | —（看不见） | **~10ms**（解密新增帧 + 该会话一次查询） |
| checkpoint 落主库那一次 | 1.6~3.2s | **~55ms**（换密钥缓存后：复制 8ms + 解密 908 页 30ms + 写 4ms + quick_check 9ms） |
| 一次 `poll_new`（68 会话） | 266~300ms（全表扫描） | **31~42ms**（高水位复用；真变化才扫） |
| 5 帧解密 / quick_check | — | 0.19ms / 8.6ms |

---

## 二、已落地方案

### 2.1 P0-A 路径自动发现（已完成）

`wechat_core.list_accounts()` 依次探测 `~/xwechat_files`、`~/Documents/xwechat_files`、注册表
`HKCU\Software\Tencent\WeChat\FileSavePath`；`db_root()` 失败时给出**已扫描路径清单 + 修复建议**
（含 `LUMII_WECHAT_DB` 环境变量写法）。多账号用 `LUMII_WECHAT_ACCOUNT` 锁定。

### 2.2 P0-B 发送链路（已完成，方案改写）

**真实根因（全部实测复现）**：

1. **OCR 大小写**：目标校验用的归一化保留大小写，OCR 把 `Loop` 读成 `LOOP` → 相似度 0.25 → 误判失败。
2. **输入落地校验不可靠**：本版微信输入框很高（窗口 y≈455–795），文字渲染在顶部，按「贴底区域」做 OCR
   必然漏读小号拉丁文本 → 误报 `input_not_landed`。改为**剪贴板回读**（Ctrl+A/Ctrl+C 后读
   `CF_UNICODETEXT`）比对。
3. **标点吞字**：`KEYEVENTF_UNICODE` 逐字注入在标点处 100% 复现吞字（`看-着，挺` → `看--，，`），
   加间隔无效。改为**剪贴板粘贴**（Ctrl+V）。
4. **顺带修掉一个 ctypes 64 位坑**：`GetClipboardData`/`GlobalLock` 的 `HANDLE` 被按 32 位整型截断 →
   剪贴板读取**静默返回空**。必须显式声明 `restype/argtypes`。
5. **短消息让目标校验永远过不去**（2026-10-08 实测，白名单里的人照样发不出）：`verify_target` 的
   内容锚点里，`anchor_exact` 要求 4 字**精确**子串、`anchor_lcs` 门槛 10 字——两者之间那段（4~9 字）
   **只能靠精确匹配**。而微信里最常见的消息（「你在干嘛？」）恰好在这个区间，OCR 把 `吗` 读成 `雨`、
   `？` 读成 `7` 之后锚点全灭（`hits=0`）；此时**只要锚点列表非空**就不允许凭头部放行（原 ③ 档的前提是
   `not usable`），于是环境对、窗口对、名单对，仍然稳定失败成 `target_unconfirmed`（现场截图
   `ui_srch00.png` 里头部明明是 `韩玉`、聊天区就是那条消息）。
   修法：把 ③ 档的前提从「**没有**锚点」改成「**没有够长的**锚点」（够长 = ≥10 字，即 `anchor_lcs`
   够得着的那批），并给这条独占放行的路加了道**重名反证**——有别的会话名字与头部吻合得不比目标差时
   不许放行（本机真有 `韩玉` / `韩玉妈`、三个 `loop` 这种形状，头部那时不含任何区分信息）。
   锚点够长时仍是一票否决：它真能证伪，就不许被头部绕过去。

**现在的发送链路**（`wechat_sender.py`，仍是零注入）：环境闸门 → 目标会话校验（内容锚点 + 头部相似度 +
「更像别的会话即拒绝」反证 + 群成员昵称第三重；锚点全短时才允许「强头部 + 无重名」独占放行）→
输入落地（粘贴 + 剪贴板回读）→ 发送生效（输入框清空）→ **读库确认**（`create_time` 之后该会话真的多了一条）。

**重试与错误码**（`server.py`）：`error_code` 由发送层文案归一，`_code_of` 是唯一码表（有测试对账，
文案改了不改码表会静默退化成 `unknown`）。

| 错误码 | 可否自动重试 | 为什么 |
|---|---|---|
| `input_not_landed` / `send_unconfirmed` / `attachment_not_landed` | ✅ | 消息**没发出去**，且发送层每次都会先 Ctrl+A/Del 清空输入框 → 重来不会粘两遍 |
| `busy` / `clipboard_failed` / `verification_failed` | ✅ | 锁竞争 / 剪贴板偶发占用 / OCR 抖动，都属临时性 |
| **`send_not_confirmed`**（已回车、库里没看到） | ❌ **绝不** | 语义存疑：可能真发出去了、只是还没落库——重试就是给好友发第二遍 |
| `env_not_ready` / `target_unconfirmed` / `quote_not_found` / `menu_not_found` / `bad_args` / `attachment_missing` | ❌ | 重试也不会好，交给 Agent 改参数或请用户处理 |

失败时返回 `suggestion`（可操作修复建议）+ `shot`（现场截图路径）。

### 2.3 实时读取（原 P1 核心，已完成）

**数据模型**：每个分片（`message_N.db` / `session.db` / `contact.db`）一份**明文镜像**（`%TEMP%/lumii-wechat-mcp/`），
进程内常驻、按需增量刷新。

**四条机制**：

1. **新鲜度键 = 主库 + `-wal` 的 `(mtime, size)`**（旧实现只有主库）→ 修掉读旧①；主库变（checkpoint）才做
   全量重建，只动 WAL 走增量。
2. **增量重放**：续读 `-wal` 里**新提交**的帧，逐页解密后原地写进镜像（`pwrite` + 按提交页数截断），
   再 `quick_check` 验一遍。一条新消息通常只有几帧 → 毫秒级。
3. **帧归属判据（salt）**：只认「帧头 salt（[8:16]）== WAL 头 salt（[16:24]）」的帧，遇到不符即停 →
   修掉读旧②（历史残留帧永不参与）。这是 SQLite 自己判「这一帧属不属于当前 WAL 会话」的规则。
4. **双重护栏 + 副本清理**：陈旧 WAL（末次提交页数 < 库页数）一律弃用；重放结果必须过 `quick_check`；
   源里已消失的 `-wal`/`-shm` 会把临时目录的旧副本一并删掉 → 修掉读旧③。

**查询快路径**：`poll()` 先用 `local_id`（主键，AUTOINCREMENT，插入即单调）做**高水位探测**：
表的高水位没动 + 这次窗口不比上次宽 + 上次没被 `per` 截断 → 直接复用上次结果（一次索引探测即可跳过整张表）；
只有真变了的表才做那次（无索引的）`create_time` 扫描 → 修掉读贵②。68 张表一轮 31~42ms。

**密钥缓存**（`keys()`，TTL 10 分钟 + 解密出现整页 HMAC 失败时自动重取）→ 修掉读贵①，把「checkpoint 全量」
从 1.6~3.2s 压到 ~55ms。

**为什么不做后台线程 / 独立监听进程**：镜像与数据库连接是单线程共享状态，加线程就要处处加锁；而空闲一拍
只要 2.5ms、高水位探测只走索引——**调用方（几秒一次）同步跑就够**，没有引入并发的理由。

**语义保证**：*不读旧*（三条护栏：salt 归属 / dbsize / quick_check）、*不漏*（有变化必扫；`next_since_ts`
按 `create_time` 严格大于推进）、*不重复*（同窗口复用 + 交付后水位前移）。

---

## 三、待开发

### 3.1 发送侧小增强（可选，低优先）

- 同 talker 连续多条时**一次打开会话发多条**（现在逐条独立校验，安全优先；只在批量场景做合并优化）。
- 发送失败后的「半自动重试」：把 `send_not_confirmed` 的现场（截图 + 读库结果）整理成一句给用户的确认问句。

### 3.2 作废的设计（记录理由，避免重走）

| 设计 | 结论 | 理由 |
|---|---|---|
| COM Interop（`WeChat.Application`） | **作废** | 微信不提供该接口；实现它=协议逆向/DLL 注入，碰「零注入」红线 |
| UI Automation 定位输入框 | **作废** | 微信 4.x（Qt）不暴露 `contenteditable`，UIA 拿不到；现方案用「几何布局 + 剪贴板」 |
| 自己解析 WAL 帧提取 rowid | **作废** | 帧是加密页，行级信息不可得；改成「salt 判会话 + 增量解密 + 查库」 |
| `watchdog` 监听 + 独立监控进程 | **作废** | MCP 子进程内同步增量已满足实时（秒级）；独立进程徒增生命周期/状态同步问题 |
| 环境变量 `LUMII_WECHAT_DB` 作为主路径 | 降级为**兜底** | 多路径探测 + 注册表已覆盖；环境变量只在探测失败时用 |

### 3.3 监控回路（零 token 门闩）——v1 + v2 已落地

**问题**：原来的监控姿势是「定时任务每 N 分钟**叫一次模型**，问有没有新消息」——token 全花在「没事发生」上
（用户实测 30s 一拍），而把间隔拉长又牺牲实时性。

**先例**：`pet-sensing`（`pet-sensing-tick.ts`）确立了模式——系统 cron + magic instruction +
**零 token 的确定性读库**，只在「该冒泡」时才产生副作用。

**已落地（v1，`7f5e9b5f`）**：

```
wechat-watch（系统 cron，every 15s，任务页可见/可暂停，agent_id=NULL ⇒ 不进 Agent）
   └─ 确定性处理器 runWechatWatch（主进程，不叫模型）
        ├─ McpManager.callTool('wechat-local','poll_new',{since_ts=水位})
        ├─ 无新消息 → 什么都不做（日志 agentId=none；不建会话、不通知、零 token）
        └─ 有新消息 → 推进水位 + 系统通知（`名字：内容`，最多 3 条）
```

- 实测：15 秒一拍，空闲拍 `runLocalCronJob … result="无新消息"`、`agentId=none`（无回合）；
  读取侧一轮 ~35ms（§2.3 的增量路径），CPU 占比可忽略。
- 护栏：**只通知不代发**；水位落库（`runtime_state`）重启不重复报；首次运行只看「从现在起」；
  任何失败（未连接/超时/解析失败）都返回一句话、不抛；自裁执行记录（留最近 500 条——
  cron 的 run 没有全局保留期，15s 一拍不裁就是一天 ~5700 行空转记录）。
- **与 wechat-mcp 解耦**（硬约束：MCP 可给别的 AI 工具用、客户端不依赖它）：客户端只依赖
  「有个 MCP Server 暴露 `poll_new(since_ts)`」这一契约；**未配置/未启用的机器上不建这条任务**
  （按 MCP 配置文件判断，已存在则暂停）；未连接时安静跳过。
- 配置：`~/.lumii/wechat-watch.json`（写坏/缺字段一律退回默认值——后台循环不能因为一行配置就停；
  v1 的 `watch`/`ignore` 仍被识别，等价于「一个 notify 分组 + defaultMode=ignore」+ 黑名单）。

**v2（同一提交串）：能替我回，且按分组授权**

按会话分档，**谁能替我用哪种方式回**写成一张表（`~/.lumii/wechat-watch.json`）：

| 档 | 行为 | 模型开销 |
|---|---|---|
| `ignore` | 完全不处理（黑名单；或「只盯名单」时的默认档） | 无 |
| `notify` | 只提醒我 | 无 |
| `draft` | 叫醒模型**起草**，草稿落在**那个好友的会话**里等我点头（我说「发」才发） | 有新消息才付 |
| `auto` | 以我本人身份直接回（信得过的人；仍有冷却与「发完必报」） | 有新消息才付 |

```jsonc
{
  "defaultMode": "notify",                       // 不在分组里的会话：只提醒
  "blacklist": ["filehelper"],                   // 永不处理
  "groups": [
    { "name": "好友试点", "mode": "draft", "peers": ["Loop"], "cooldownSeconds": 120 },
    { "name": "家人",     "mode": "auto",  "peers": ["妈妈"], "cooldownSeconds": 300 }
  ]
}
```

- 交互落点是**每个好友自己的会话**（`pcwechat:<talker>`，侧栏「渠道 → 本机微信」分组，见 §3.4 的 M1）：
  被盯到的消息以一条提示出现在那个人的会话里，助手的草稿/代回结果紧跟其后；
  通知点击直达 ✓（通知第三个参数传该会话 id；一拍涉及多个会话时不带跳转目标——没法替用户挑一个）。
- 驱动回合沿用 `cron-scheduler.driveAgent` 的 L1 五件套配方（确保会话 → 建实例 → prompt →
  等空闲 → 取输出 → 收实例），只是会话按 peer 分。
- 护栏：**冷却**（分组可配，默认 60s，冷却期内降级为提醒）；**起草模式自证**——回合结束后读库实测
  「我名下有没有真发出去的消息」，有就如实标 ⚠️（提示词只是约定，这才是不让它悄悄代发的兜底）；
  没有 `driveTurn` 接线时 draft/auto 自动降级为提醒（缺部件就退档，不半途出错）；auto 的提示词里写明
  「不确定/敏感/涉及承诺时不猜，改为给我看草稿」。
- **仍需产品化**：设置页里做一个分组成员编辑器（现在用手写 JSON）；「待回消息」列表页（现在靠会话+通知）。

**判据**：空闲时模型 token = 0（v1 实测 `agentId=none`）；draft 档下**未经确认不会有任何消息发出**（有自证兜底）；
auto 档新消息 → 回复延迟 ≈ 回合时长 + 发送（秒级）；不丢不重（`next_since_ts` 连续推进 + 水位落盘）。

---

### 3.4 组织形态复盘与收敛路线（M1 已落地）

**问题**：v2 的能力是对的，但**归属**是错的——它被拼成「通用助手 + 假会话 + 外挂配置」，
而 app 里三套现成范式只用了半套。用户体感「别扭」，来源是四个错位：

| 维度 | app 既有范式 | v1/v2 的做法（错位） | 后果 |
|---|---|---|---|
| **会话** | 三种既定来路：`<渠道>:<peerId>`（唯一构造点 `channel-route.ts:108`）、`cron:<jobId>`、`evolution:<agentId>` | 手搓单例 `wechat:watch`（第四种；前缀不在归属表 → `channel_type` 回落 `ipc` → 侧栏归**默认 tab**） | 所有好友混一条线；通知跳进一个"没有对方"的线程；与助手会话并排 |
| **身份** | 领域专属 agent：`code-dev`/`system-keeper`/`chronicler`/`info-curator`，各自 `systemPrompt` 就是它的路数（`chronicler` 的描述明写绑定定时任务） | 通用 `assistant`（`bridge.ts` 的 `DEFAULT_AGENT_ID`）+ 每轮把 RUNBOOK 全文硬注入提示词 | 人格是补丁；"谁在替我说话"看不见、改不了、审计不到；每轮多花几千字 |
| **配置** | `local_cron_jobs` 自带 `system_prompt`（表注释："预置任务的完整系统提示词"）与 `notify_targets` | 分四片：cron 行 / `wechat-watch.json` / RUNBOOK.md（workspace 里的 md）/ 隐式的 agent 选择 | 用户问"怎么停"要改文件、问"按什么规矩"要读 md |
| **传输** | 渠道层齐活：入站 adapter 注册表、出站 provider 注册表、peer 白名单硬校验（`channel-outbound-router.ts:75-84`）、presence 驱动默认收件人、设置页 peer 列表 UI、长轮询先例（weixin 35s） | **平行管线**：绕开 adapter/provider/Router/peer store/presence 全套，直连 MCP `send_text` | 同一件事两套实现；代聊不在渠道审计里 |

**根因**：渠道层假设「入站 = 叫醒 agent」，全库**没有任何 per-peer 策略/自动回复开关**
（唯一渠道级开关是跨渠道接续）——「允许谁自动回」在 app 里**没有归属地**，于是被塞进了 `wechat-watch.json`。

**收敛路线（三步，可独立落地）**

**M1 · 会话归位（✅ 本轮）**——本机微信成为一个**渠道**，会话按 peer 分：

- 新归属 `pcwechat`（`channel-identity.ts`），中文名**「本机微信」**：与 `weixin`（**用户在**微信里找 Lumii）
  方向相反——这条是**助手替用户**在微信里回好友。侧栏独立分组（渠道 tab），不再混进默认 tab。
- 会话 id `pcwechat:<talker>`、标题 `本机微信 · <备注名>`（唯一构造处 `watchConversationIdFor` /
  `watchConversationTitleFor`）。草稿/代回/对方消息都落在那个人的会话里，通知点击直达。
- 代聊型会话**不参与跨渠道接续**（`DELEGATED_OWNERSHIPS`）：飞书/QQ 的消息「接续」进一条代聊会话
  没有语义（那是助手对外的通道，不是用户的对话），还可能让回复发错人。
- 历史遗留的 `wechat:watch` 单例会话不再使用（仍回落 `ipc`/默认 tab，可手动删）。

**M2 · 身份与配置归位（✅ 本轮，不动传输）**

- 建**「灵栖代聊」专属 agent**（`apps/windows/src/main/agent-runtime/wechat-relay-agent.ts`）：
  RUNBOOK 的内容成了它的 `systemPrompt`（`agent-instance.ts:344` 每轮现取现用）；
  回路的 `agentId` 从 `assistant` 换成它，`buildAutoPrompt`/`buildDraftPrompt` 不再注入全文，
  只留「本次触发」+ 发送分支。
- **它是用户 Agent**（`~/.lumii/config/agents.json`），不是内置定义：内置的权威在 api-server 的
  `system_agents`，客户端自加一条只会造成漂移；而且系统 Agent 在 `updateAgentRecord` 里不可改，
  用户就改不了口吻与护栏。播种语义 = `seedIfAbsent`（与渠道策略同款，见 bridge 里那段）：
  **只在不存在时创建一次**，此后真源是设置页里那条记录。
- **手册读不到就不建**（没配 `instructionsFile` / 文件没了）：一个"代聊"却在裸奔比没有更危险。
  回路发现 **Agent 里那份 ≠ RUNBOOK.md** 时记一条 warn 说明"以设置页为准、文件只是留档"——
  否则"改了手册却没反应"就是静默失效。RUNBOOK.md 是用户的文件，**绝不修改**。
- 它被排除出 Pre-LLM Router 候选（`getCustomAgents` 里按 id 过滤）：那是渠道回路按名单驱动的
  **行为主体**，不是拿一份微信口径的 systemPrompt 去接普通对话的路由目标；设置页里照常可见可改。
- 收益：代聊主体在 agent 设置页**可见、可改、可审计**；每轮省几千字注入；要给不同好友不同人格，
  就再建一个 agent 绑到那个 peer。配置源（`wechat-watch.json`）这轮先不动，一次只改一件事。
- 刻意**没做**的：`memory` 字段留空（`autoExtract` 不再把微信闲聊抽进用户长期记忆；要恢复就照
  assistant 那份补 `memoryConfig`）。
- **预设工作流分区**（2026-10-08）：systemPrompt 里多一段**程序维护**的内容（画像注入的口径、
  缺画像时先 `wechat_digest`→`wechat_profile_save`→记水位、画像卡 ≤250 字、别把画像当话题说出来），
  带标记 `<!-- lumii:relay-workflow v1 -->`，位置在铁律之后、用户手册之前。老 Agent 靠
  `relayPromptWithWorkflow` **追加**式升级——Agent 记录归用户所有，程序只往后面接自己那一段，
  有标记就不重复追加、prompt 被清空就尊重不动。
  分工：**约定住在 Agent 里**（长期不变），**画像每轮由回路拼在提示词前面**（事实会变，见
  `bridge.wechatProfilePrompt`；命中 `wechat-distill` 设计文档 §7 的隐私口径变更）。

**M3 · 渠道归位 + 产品化（✅ 出站与策略已落地；⏳ 入站 adapter 未做）**

把它注册成**第 5 个渠道**（`pcwechat`），形状照抄现有四个（`feishu`/`weixin`/`wecom`/`qbot`）：

| 部件 | 现状（盯梢旁路） | M3（正式渠道） |
|---|---|---|
| 入站传输 | 15s cron tick 直接读库 | ⏳ 同一个轮询，但作为该渠道的 **adapter 入站**（weixin 已有长轮询先例） |
| 出站 | ~~agent 直接调 MCP `send_text`~~ → ✅ 已注册 provider：`snapshot.peers` 就是策略名单，名单外的人 `PEER_NOT_FOUND`（Provider 内还会再拦一道），工具没确认发出就不算成功 | 不变 |
| 会话 | `pcwechat:<talker>` ✅ M1 已做 | 不变 |
| 策略 | ~~`wechat-watch.json` 的 groups~~ → ✅ 落 `~/.lumii/channel/channel-policies.json`，旧文件只在首次播种时读一次；盯梢每拍读主进程同一份缓存，改完立即生效 | 不变 |

> 实测记一笔：加了渠道却只改了主进程的合法渠道清单，忘了 `channel_send` 的 **JSON schema enum**，
> 结果模型一调用就被参数校验层拒掉（`channel: must be equal to constant`），Router 的白名单门根本没执行。
> 现在清单只有一份（`packages/agent-runtime` 的 `OUTBOUND_CHANNEL_IDS`，schema enum 由它生成、
> 主进程 `outbound-types.ts` 再导出），并有对账测试盯着。
>
> 绑定内配置的三个字段：**账号**是给用户自己区分"哪个微信"的备注（本机多账号探测还没接，
> 出站永远走本机此刻登录的那个）；**回复策略**是四档 `ignore/notify/draft/auto`；
> **黑白名单**就是名单里的 `ignore` 档——黑名单不再是另一份清单。单人条目按 wxid/群号配，
> 只知备注名也能匹配（联系人改名后失效）。

**绑定内要配的东西（用户 2026-10-08 指定）**：

1. **账号**——盯哪个微信账号（本机可能登录多个：`wechat_core` 的账号根探测已支持多账号）；
2. **回复策略**——`ignore` / `notify` / `draft` / `auto`（现在就是这四档语义，只是挪到 peer 上）；
3. **黑白名单**——哪些人不处理、哪些人允许自动回（现在 `blacklist` + `groups[].peers` 的语义）。

这一条同时**反向补齐渠道层的缺口**：渠道层目前没有 per-peer 策略概念（入站一律叫醒），
而飞书/QQ 一样需要「这个人自动回、那个只提醒」。**per-peer 回复策略是渠道层的通用能力**，
不是为微信特设——这是把 M3 从"重构"变成"新能力"的关键。

**同一轮要补的工程缺口**（已知、未做）：
- python 侧 `test_watch.py`（12 例）未接入 CI（CI 只跑 vitest）；
- 「窗口最小化时不能发」挡住了远程（飞书）回话——要不要让发送自动还原窗口，属产品决策；
- 主进程争用（73s 的 `app_screenshot`、cloud-sync 导出周期）会拖慢盯梢的某一拍（下一拍补上，不丢消息）。

**坑已修（本轮）**：任务页曾把 `wechat-watch` 判成**用户的普通任务**（`classifyCronJobSource` → `user`），
露出删除与编辑入口。编辑弹窗保存必然写入非空 `agentId`（`CreateJobModal` 的 `canSubmit` 要求），
一写就让 magic 拦截失效（`cron-scheduler` 只在 `!job.agent_id` 时走 companion 通道）——
管道会变成拿 `__wechat_watch__` 当普通文本跑的普通任务，15s 节奏也会被表单改写。
现修法：`wechat-watch` 归入 `SYSTEM_EXACT_IDS` + `isReseededCronJob`（→ 系统任务组、无删除入口），
UI 对 `reseeded` 任务隐藏编辑按钮，`handleCronUpdate` 再加一道闸**只挡身份字段**
（`taskText`/`agentId`/`scheduleType`/`scheduleExpr`）——**启停走同一个接口，必须放行**（任务页暂停是受支持的操作）。

---

## 四、路线图（更新）

| 阶段 | 内容 | 状态 | 提交 |
|---|---|---|---|
| 1 | P0-A 多路径探测 + 可操作错误提示 | ✅ | `25a35ea3` |
| 1 | P0-B 发送重试 + 错误码 + 修复建议 | ✅ | `25a35ea3` |
| 1 | P0-B 发送链路三处根因修复（OCR/剪贴板/粘贴） | ✅ | `d6bb59be` |
| 2 | 诊断工具增强（`devcli selftest` / `watch`） | ✅ | 本轮 |
| 2 | **实时读取：WAL 感知 + 增量重放 + 快路径 + 密钥缓存** | ✅ | 本轮 |
| 3 | 零 token 门闩 v1：确定性读库 + 通知（§3.3） | ✅ | `7f5e9b5f` |
| 3 | 门闩 v2：分组策略 + 起草/代回（§3.3） | ✅ | 本轮 |
| 3 | 任务页管道护栏：`wechat-watch` 归系统任务 + 禁改身份字段（§3.4） | ✅ | 本轮 |
| 3 | **M1 会话归位**：`pcwechat` 渠道 + 每 peer 会话 + 通知直达（§3.4） | ✅ | 本轮 |
| 4 | **M2 身份归位**：专属「灵栖代聊」agent（RUNBOOK → systemPrompt） | ✅ | 本轮 |
| 4 | **M3 渠道归位**：注册 `pcwechat` 出站 provider（策略即出站名单） | ✅ | 本轮 |
| 4 | **策略归位**：落 `~/.lumii/channel/channel-policies.json`，旧 `wechat-watch.json` 只播种一次 | ✅ | 本轮 |
| 4 | **绑定内配置**：账号 / 回复策略 / 黑白名单（设置 → 渠道 → 本机微信），弹窗 + 从微信里挑人 + 批量设档 | ✅ | 本轮 |
| 4 | 盯梢改走 `channel_send`（绕过渠道直发 = 绕开名单） | ✅ | 本轮 |
| 4 | 代聊会话里**看得见对方的输入**（对方消息落成会话里的用户消息，不再只有助手独白） | ✅ | 本轮 |
| 4 | 发送层根因修复：短消息锚点被 OCR 读花 ⇒ 目标会话永远校验不过（白名单里也发不出） | ✅ | 本轮 |
| 4 | 发送闸门自恢复：主窗口最小化 ⇒ 恢复一次再复检（不再"看着在跑、一条没发"） | ✅ | 本轮 |
| 4 | 预设工作流写进代聊 Agent（程序维护分区，追加式升级不覆盖用户改动） | ✅ | 本轮 |
| 4 | 每轮自动注入本地蒸馏画像 + 缺画像时明说「还没有/已过期」 | ✅ | 本轮 |
| 4 | M3 收尾：入站 adapter（现在仍走盯梢旁路） | ⏳ | §3.4 |
| 4 | 监控面板 UI（盯哪些人、开关、最近事件） | ⏳ | — |
| — | python 测试接入 CI（`test_watch.py` 22 例，含 E 层目标校验证据强度 / F 层发送闸门） | ⏳ | §3.4 |
| — | ~~COM Interop~~ / ~~WAL 帧解析~~ / ~~watchdog 进程~~ | ❌ 作废 | §3.2 |

---

## 五、成功指标（实测对照）

| 指标 | 原目标 | 现状 |
|---|---|---|
| 路径发现成功率 | 95%+ | 多路径 + 注册表 + 兜底环境变量；本机 2 条路径均命中 |
| 发送成功率（真人往返） | 95%+ | 与 Loop 端到端往返逐字一致；失败均有稳定 `error_code` + 建议 |
| 增量读取成本 | — | 空闲 2.5ms/拍；新消息 ~10ms；poll 31~42ms（68 会话） |
| 读到的数据新鲜度 | — | **永不读旧**（三条护栏）；与微信界面逐条对照一致 |
| 响应延迟 | < 2s | 检测侧 ≤15s（一拍即见，实测 lag≈0）；通知即时。**代回延迟**取决于 v2 是否开 |
| 空转成本 | — | **已归零**：15s 一拍、无新消息时零 token（ 实测）；模型只在有新消息时才可能被叫醒（v2 代回） |

---

## 附录

### A. 验证与复现命令

```bash
cd apps/windows/resources/wechat-mcp

# 离线回归（不需要微信、不碰真实数据）：真加密夹具逐字节 + 真 SQLite 语义 + 错误码对账
python test_watch.py

# 真机自检（只读）：依赖 / 数据目录 / 会话 / 实时读取耗时
python devcli.py selftest

# 真机盯消息（只读）：每拍打一行 JSON（新消息、滞后秒数、刷新/查询耗时、快路径命中）
python devcli.py watch --ticks 10 --interval 3

# 协议级直连（不经 App，最快；dry_run 安全）
printf '<initialize 行>\n<tools/call 行>\n' | python server.py
```

### B. 关键文件与常量

| 文件 | 职责 |
|---|---|
| `wechat_core.py` | 目录发现 / 取密钥（缓存）/ 解密 / `_ShardMirror` 增量镜像 / `poll` 快路径 / 蒸馏 / 画像 |
| `wxread4.py` | SQLCipher4 页解密 + WAL 解析（`parse_wal_frames` 的 **salt 会话判据**在这里） |
| `wechat_sender.py` | 发送（布局 + 剪贴板粘贴 + 回读 + 读库确认） |
| `server.py` | MCP 入口 + 工具描述 + `_code_of` 码表 + `_send_with_retry` |
| `devcli.py` | 自检命令行（`selftest` / `watch` / `sessions` / `history` / `send` / `digest` …） |
| `test_watch.py` | 实时读取的离线回归（A/B/C 三层，10 例） |

- 护栏常量：`_plain` 的陈旧判据（`dbsize >= 主库页数`）、`_incr` 的 `quick_check`、`_send_with_retry` 的
  `RETRIABLE_CODES` / `NON_RETRIABLE_CODES`。
- 运行期注意：**改 `.py` 后必须重启 App**（MCP 子进程在连接时载入代码）；`dev:restart` 可能静默失败。

客户端侧（盯梢回路与渠道归属）：

| 文件 | 职责 |
|---|---|
| `src/main/agent-runtime/wechat-watch-tick.ts` | 15s 门闩：配置解析 / 分组策略 / 冷却 / 水位 / 会话 id 与标题的**唯一构造处** |
| `src/main/channel/channel-identity.ts` | 归属 `pcwechat` 与中文名「本机微信」的**唯一登记处**（`DELEGATED_OWNERSHIPS` = 不可接续） |
| `src/main/agent-runtime/cron-job-meta.ts` | `wechat-watch` 归系统任务（+ 受管的启停、无删除入口） |
| `src/main/ipc/agent-runtime/cron-commands.ts` | `handleCronUpdate` 的管道护栏（只挡身份字段，放行启停） |
