# Lumii 场景记忆设计：全局通用 + 按场景加载（2026-09-12）

> 关系：本文深化 `2026-08-24-memory-design.md` 中「个人记忆」部分，把单一全局文件演进为「全局 + 场景」两层。
> 参照：Hermes Agent（`E:\open-source-project\hermes-agent`）的已验证实现，引用格式 `文件:行号`。
> 决策记录：存储位置＝项目目录内文件；加载方式＝命中即注入 + 主动搜索兜底；场景范围＝项目 + 消息渠道。

---

## 0. 结论摘要

| # | 结论 | 依据 |
|---|------|------|
| 1 | 个人记忆拆两层：**全局层**（身份/交互偏好/长期习惯，常驻注入）＋**场景层**（项目、渠道，命中才加载） | 用户本机 `user-memory.md` 实际内容：`## 项目偏好` 节两条均为场景内容，却在所有对话注入 |
| 2 | 全局与场景的判据只有一条：**换个项目/渠道还成立吗？** 成立→全局，不成立→场景 | Hermes 用同一判据做物理分离（USER.md vs AGENTS.md） |
| 3 | 项目记忆的**主存储是项目目录内文件**（`<项目>/.lumii/memory.md`）；无目录项目与渠道记忆存 Lumii 数据目录 | 用户决策；Hermes 同构：项目约定放 cwd 发现的 AGENTS.md（`agent/prompt_builder.py:2458-2529`） |
| 4 | 命中判定 P0 只做两件事：sessionKey 解析渠道 + 消息文本匹配项目名/别名 | `channelOfSessionKey()` 已实现（`cross-channel-continuity.ts:61`）；匹配是纯文本操作，零 LLM 成本 |
| 5 | **写入侧必须同步改**：不改写入分流，只做读取过滤必然复发污染 | 现有链路：段落总结产出的 `user/feedback` 候选自动写入全局文件（`manager.ts:190-192`） |
| 6 | 全局层引入硬预算 + 超限要求模型整理 | Hermes：写满返回错误＋现有条目清单，要求同轮合并（`tools/memory_tool.py:428-441`） |

---

## 1. 问题

### 1.1 实际数据

用户本机 `~/.lumii/data/user-memory.md` 三节内容的真实构成：

| 节 | 内容性质 | 示例 |
|----|---------|------|
| `## 基本信息` | **真全局** | 用户是普通程序员；关注 AI/经济/历史 |
| `## 交互偏好` | **多为全局** | 去 AI 味；方案对比输出 Markdown；翻译对照呈现 |
| `## 项目偏好（标注适用范围）` | **全是场景** | 二十四史学习规划颗粒度；picture-book-studio 绘本禁令 |

「项目偏好」节两条，只对特定任务有效，却在**每一次对话**注入（2400 字符预算内）。这正是用户描述的"不做这个项目的时候，这部分内容就是干扰"。

### 1.2 三个根因

1. **注入无过滤**：`buildPromptWithMemory`（`bridge-prompt-composer.ts:342-368`）无条件注入全文，无 agent 分支、无会话分支、无场景判断。唯一约束是 2400 字符按 `## ` 章节顺序截断（`:461-493`）。
2. **文本标注不可执行**：条目里的「适用范围：…」是 LLM 整理时写下的散文（`memory-consolidation.ts:146`），注入层读不懂；只有 prompt 里一句硬约束"标注了适用范围的规则仅在该范围内生效"（`memory-injector.ts:54`）指望模型自觉。
3. **写入无分流**：段落总结 LLM 输出 `user/feedback` 候选 → `onPersonalMemoryExtracted`（`manager.ts:190-192`）→ 自动追加全局文件。项目性内容就是这么进去的。

### 1.3 与 `agent_memories` 的关系（避免误读）

- 工作记忆（`agent_memories`）是**另一条线**：写入仍在跑（每轮规则提取、段落总结、cron、进化引擎），但注入管线三处调用点被有意停用（`agent-instance.ts:416-420` 等），待重新设计。
- `2026-08-24-memory-design.md` §3.5 曾规划给 `agent_memories` 加 `scope` 列（session/project/agent/global）。**本设计不采用该路径**——项目记忆走可见、可编辑、随项目走的文件，而不是数据库行。`scope` 列方案不再推进。
- 本设计解决的是**个人记忆（user-memory.md）的场景化**，与工作记忆重设计互不阻塞。

---

## 2. 参照：Hermes 的分层机制（已验证）

Hermes 里「记忆」不是一个带 scope 字段的存储，而是**四种性质不同的机制**，各有加载条件与预算：

| 层 | 内容性质 | 加载条件 | 预算 |
|----|---------|---------|------|
| `USER.md` | 用户身份/沟通偏好 | **总是注入** system prompt 尾部 | 1375 字符硬上限（`agent_init.py:1776-1784`） |
| `MEMORY.md` | agent 环境笔记 | 总是注入 | 2200 字符硬上限（`tools/memory_tool.py:165-169`） |
| `AGENTS.md`/`.hermes.md` | **项目约定、项目偏好** | **仅当 cwd 命中该项目** | 每文件动态上限（`agent/prompt_builder.py:2458-2529`） |
| provider prefetch + `session_search` | 相关性记忆 / 无限历史 | 每轮检索 / agent 主动调用 | 8 秒超时 / 无 |

三个值得借鉴的机制：

1. **项目偏好从记忆里赶出去**——放进项目目录自己管理，由 cwd 决定加载。全局文件只保留"任何项目都成立"的内容。（`agent/prompt_builder.py:2458-2529`）
2. **硬字符预算 + 超限时模型自整理**——写满不是静默截断，而是返回错误 + `current_entries` 清单，要求同一轮内用 replace/remove 腾空间（`tools/memory_tool.py:428-441`）；每轮最多 3 次整理尝试防死循环（`:159-201`）。信噪比是被预算逼出来的。
3. **冻结快照**——记忆在会话开始时快照，会话中写盘不改变 prompt（保护 prefix cache，`tools/memory_tool.py:11-14`）；压缩后重载（`system_prompt.py:894-903`）。

一个明确不借鉴的：**MemoryProvider 插件架构**（`agent/memory_provider.py:104-404`）——为多后端竞争设计，单机桌面应用引入是纯成本。

---

## 3. 设计

### 3.1 三层职责边界

| 层 | 存什么 | 判据 | 加载 |
|----|--------|------|------|
| **全局层** | 身份、语言、沟通风格、跨项目习惯 | 换个项目/渠道仍成立 | 每轮注入（现有机制，收窄） |
| **项目层** | 项目约定、项目偏好、项目上下文 | 仅本项目成立 | 命中即注入 + 搜索 |
| **渠道层** | 渠道行为偏好（如"微信回复简短"） | 仅该渠道成立 | 命中即注入 + 搜索 |

同一判据在三个位置执行：写入分流时（LLM 判断）、整理时（存量再判）、命中时（机器执行）。

### 3.2 存储布局

```
~/.lumii/data/user-memory.md              全局层（保留，内容收窄）
~/.lumii/data/scene-memory/
  ├─ _registry.json                       项目注册表（名称/别名/路径）
  ├─ project-<key>.md                     项目记忆 · 无目录项目
  └─ channel-<type>.md                    渠道记忆（weixin/feishu/wecom/qbot）

<项目目录>/.lumii/memory.md               项目记忆 · 有目录项目（主形态）
```

**为什么渠道记忆不放项目目录**：渠道是客户端概念，没有对应目录。渠道不是项目，不应混进项目注册表。

**格式**：与 `user-memory.md` 完全一致——自由 Markdown，`## ` 分节。复用现有解析、章节截断（`bridge-prompt-composer.ts:461-493`）、备份（`.bak`）逻辑。

**注册表结构**：

```jsonc
{
  "projects": [
    {
      "key": "lumii",                          // 稳定 slug，文件名用
      "name": "Lumii",                         // 显示名
      "aliases": ["lumii", "E:\\my-project\\open-source\\lumii"],  // 命中匹配词（含路径）
      "path": "E:\\my-project\\open-source\\lumii",  // 可为 null（无目录项目）
      "lastActiveAt": 1757600000000
    }
  ]
}
```

### 3.3 命中判定

每轮消息组装 prompt 时执行（`bridge-prompt-dispatcher.ts:319` 的刷新点），纯文本操作、零 LLM 成本：

```
① sessionKey --channelOfSessionKey()--> channelType      （cross-channel-continuity.ts:61）
    非 'ipc' → 加载 channel-<type>.md
② 消息文本 × 注册表 aliases 子串匹配（大小写不敏感）
    命中 → 加载对应项目记忆（多个命中取匹配最长的 1 个）
③ 都未命中 → 不加载场景层，agent 可用 scene_memory / memory_search 主动捞
```

**P0 不做会话黏性**（本会话上一轮命中过的项目保持生效）——先看文本命中的实际命中率，误报/漏报有数据后再加。

**显式绑定**（会话绑定项目，不依赖文本匹配）：等 coding agent 的 workspace 落地后接入（`AgentDevBinding` 目前未实现），届时"coding agent 会话 → workspace → 项目"是最强信号。

### 3.4 注入

在 `buildPromptWithMemory`（`bridge-prompt-composer.ts:316-448`）扩展，与全局块同处 dynamicPrompt 尾部、cache boundary 之后：

```
## 关于用户（个人记忆）        ← 全局层（现有，收窄）
## 项目记忆：Lumii（仅本项目适用）  ← 场景层（新增）
## 渠道偏好：微信（仅微信渠道生效） ← 场景层（新增）
```

| 预算 | 现值 | 建议值 | 理由 |
|------|-----|--------|------|
| 全局 | 2400 字符 | 2000 字符 | 收窄后若仍超限，说明有场景内容没分流出去 |
| 项目 | — | 4000 字符 | 项目约定可以比用户画像更长 |
| 渠道 | — | 1200 字符 | 渠道偏好天然短 |
| 同轮项目数 | — | 1 个 | 防止多项目同时注入膨胀 |

### 3.5 写入与分流

**新增工具 `scene_memory`**（agent 侧）：

```
action:  list | read | write | append | remove
scene:   'project' | 'channel'
key?:    项目名或路径；缺省用当前上下文（本轮命中的项目 / 当前会话渠道）
content?: string
```

- `write/append` 时 key 不在注册表：带路径 → 登记并写 `<路径>/.lumii/memory.md`；只带名字 → 登记为无目录项目，写数据目录。
- 渠道场景的 key 缺省 = 当前渠道；显式指定允许（用户说"记住飞书里回复要简短"→ 写 feishu）。

**自动提取分流**（改动两处提示词）：

1. 段落总结 / 提取（`memory-extractor.ts`）：输出候选时增加判断——"仅对当前项目成立 → 标记为项目候选"。仅当本会话有命中的项目时启用，避免乱建项目。
2. 整理（`memory-consolidation.ts:150-158`）：**删除**推荐结构中的 `## 项目偏好` 节。整理时若发现条目带明确项目范围（如"使用/更新 picture-book-studio 时…"），不再写回全局文件，而是输出为场景迁移建议。

**保守原则**：自动提取不确定归属时**不写场景**（宁可留在候选池），场景写入以显式工具为主。乱建项目文件比少记一条更难收拾。

### 3.6 搜索兜底

`memory_search`（`bridge-tool-registrar-integration.ts:150-224`）现有降级路径是 user-memory.md 逐行 includes 匹配——**把场景记忆文件加入搜索范围**，命中返回"来自项目 Lumii 的记忆：…"。这让"没自动命中"的场景内容仍可被 agent 捞回，不需要新检索设施。

### 3.7 全局层收窄与存量迁移

1. **存量迁移（一次性）**：读现有 `user-memory.md`，把「项目偏好」节条目按内容判断归属：
   - 有明确项目（picture-book-studio 技能、lumii 等）→ 写对应场景文件 + 从全局删除
   - 无法归属 → 保留原地，整理时再判
   - 用户本机当前只有 2 条，手工确认成本极低；迁移动作**先出 diff 给用户确认再落盘**。
2. **硬预算**：全局文件设 2000 字符软上限（现有截断保留），新增写入使总量超限时**拒绝并在工具返回中给出当前条目清单**，要求模型同轮整理（Hermes 机制，`tools/memory_tool.py:428-441`）。P1 实现，P0 先观察截断日志。
3. **不静默丢**：任何迁移/整理导致的内容减少，保留 `.bak`（现有机制，`plugin-ipc.ts:108-121`）。

---

## 4. 复用的现成资产

| 资产 | 位置 | 复用方式 |
|------|------|---------|
| sessionKey→渠道解析 | `channelOfSessionKey`（`cross-channel-continuity.ts:61`） | 直接调用 |
| 章节截断注入 | `bridge-prompt-composer.ts:461-493` | 抽为通用函数给场景层用 |
| 清洗逻辑（去 HTML 注释/空章节） | `bridge-prompt-composer.ts:351-363` | 同上 |
| 文件读写 + `.bak` | `plugin-ipc.ts:92-121` | 泛化为任意路径 |
| `profile_memory` 工具模式 | `bridge-tool-registrar-integration.ts:273-331` | `scene_memory` 照此实现 |
| 每轮刷新点 | `bridge-prompt-dispatcher.ts:319` | 挂载场景上下文解析 |
| 整理 prompt 结构 | `memory-consolidation.ts:144-158` | 修改而非新建 |

**未复用**：`memory.scope` 配置（`agent-definition.ts:52-64`）与 `MEMORY_PLACEHOLDER` 注入管线——该管线已停用且处于遗留脏状态（占位符无替换者），不在本设计范围。

---

## 5. 实施路线

### P0：可用（小步快跑，每步可测）

> 实施状态（2026-09-12）：以下 7 项已全部落地并通过测试（agent-runtime 全量 1832 用例、场景相关 37 个单测均通过）。
> 存量迁移已执行：用户「项目偏好」节 2 条迁移到场景文件 + 注册表，全局文件仅保留基本信息/交互偏好。
> 云同步（原 P1 项）已一并完成：`sync-exporter/importer` 的 profile 区新增 `scene-memory/` 目录（有目录项目不纳入，随项目自身管理）。

| # | 内容 | 触及文件 |
|---|------|---------|
| 1 | 场景存储层：注册表读写 + 场景文件读写（含 `.bak`、路径解析） | 新建 `scene-memory-store.ts` |
| 2 | 命中解析：sessionKey→渠道、消息→项目匹配 | 新建 `scene-resolver.ts` |
| 3 | 注入接线：`buildPromptWithMemory` 增加场景块 | `bridge-prompt-composer.ts` |
| 4 | `scene_memory` 工具注册 | `bridge-tool-registrar-integration.ts` |
| 5 | 写入分流：整理 prompt 去掉「项目偏好」节；提取加项目判定 | `memory-consolidation.ts`、`memory-extractor.ts` |
| 6 | 存量迁移：一次性迁移工具（先出 diff） | 新建迁移脚本 + 手动执行 |
| 7 | `memory_search` 范围扩展 | `bridge-tool-registrar-integration.ts` |

验证顺序：先做 1+2（纯函数，可单测）→ 3（集成，看日志确认注入块）→ 4（工具调用实测）→ 5+6（写入侧，先 dry-run）→ 7。

### P1：打磨

- 全局硬预算 + 超限拒绝整理（§3.7-2）
- 会话黏性（上一轮命中保持）
- coding agent workspace → 显式项目绑定
- MemoriesPage 增加场景记忆查看/编辑入口
- ~~云同步：数据目录场景文件纳入导出导入；项目目录内文件不纳入~~ ✅ 已完成（2026-09-12）

### 明确不做

- ❌ `agent_memories` 加 scope 列（08-24 旧规划，本设计改变路径）
- ❌ 向量/语义检索场景记忆（P0 文本命中 + includes 足够）
- ❌ MemoryProvider 式插件架构
- ❌ 自动扫描磁盘发现项目（注册表只由 agent 工具和用户 UI 登记）
- ❌ 场景记忆的 pinned/重要性排序（命中就有价值，没命中就不加载）

---

## 6. 风险与待验证

| # | 风险/假设 | 验证方式 |
|---|----------|---------|
| 1 | 项目名文本匹配误报（如 "lumii" 出现在无关消息里） | P0 实测：日志记录每轮命中情况，观察 1-2 周 |
| 2 | 项目名漏报（用户用简称/代词指代项目） | 同上；漏报时可手动调用工具兜底 |
| 3 | `.lumii/` 目录写进 git 仓库是否合适 | 迁移时提示用户，可加 `.gitignore`；无目录项目不受影响 |
| 4 | 渠道记忆与"跨渠道接续"的交互（接续后当前渠道 ≠ 消息实际上下文） | 接续场景下按当前 channelType 加载，观察是否有错位 |
| 5 | 提取侧误判归属导致内容写错场景 | 保守原则：不确定不写；观察段落总结产出的归属准确率 |

---

## 7. 一句话总结

全局记忆只留"换个场景还成立"的内容；项目偏好跟项目目录走、渠道偏好跟渠道走，做相关事情的时候才加载——判据一条，机制两层，写入读取同步改。
