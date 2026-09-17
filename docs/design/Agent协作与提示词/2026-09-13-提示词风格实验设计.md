# 系统提示词注入风格实验设计（简要/详细 · 段级渐进加载）

> 日期：2026-09-13（v2，评审后修订）
> 状态：决策已定稿，待实施
> 需求来源：为强模型提供"索引式 + 渐进式加载"的简要提示词风格，与现行"详细描述"风格全局切换；实验性功能。
> 关联代码：
> - `packages/agent-runtime/src/prompt/system-prompt-builder.ts`（构建器主入口）
> - `packages/agent-runtime/src/prompt/system-prompt.types.ts`（类型/标签/边界标记）
> - `packages/agent-runtime/src/prompt/sections/*.ts`（各段实现）
> - `apps/windows/src/main/agent-runtime/bridge-prompt-composer.ts`（每轮组装）
> - `apps/windows/src/main/agent-runtime/bridge-prompt-dispatcher.ts`（每轮重建调度）
> - `apps/windows/src/main/agent-runtime/bridge-tool-registrar-guide.ts`（指南工具先例）
> - Hermes 对照源码：`E:\open-source-project\hermes-agent`（`agent/system_prompt.py`、`website/docs/developer-guide/prompt-assembly.md`）

---

## 决策记录（2026-09-13 设计评审，已拍板）

| # | 决策 | 设计影响 |
|---|------|---------|
| 1 | 风格只保留**两个状态：简要 / 详细**（无 off 第三态） | 配置面 = 二选一 |
| 2 | 配置作用域 = **全局用户级**（不下沉 Agent 级） | 随现有用户设置存储/同步 |
| 3 | **不做逐段自定义**；段 ID 可以暴露，**方便调试** | 段级行为是设计期属性；注册表保留，UI 只读 |
| 4 | terse 引导句**保持英文**（与段正文语言一致） | 文案规范 |
| 5 | **不做**"已展开段回流系统提示词" | 展开结果只进对话历史 |
| 6 | **移除旧 tier→详度调度与 `PromptDetail`（compact/standard/full）定义** | 单一风格轴取代原"双轴"设想 |

> v1 稿曾设计"两个正交轴（detail × style）+ 逐段用户配置 + 预设/覆盖"；按上述决策**大幅简化**为单轴两态。

---

## 1. 背景与目标

### 1.1 需求（含评审后调整）

- **简要（terse）**：索引式描述 + 渐进式加载。面向强模型，信任其推理能力，只给"有什么、何时用、去哪拿"。
- **详细（detailed）**：现行风格。参数、作用、规则描述清楚。
- 初版设想的"用户手动逐段设置"已按决策 3 简化为：**不做逐段自定义**，段与段之间的呈现差异由设计内置（红线类段始终详细，能力/规则类段支持索引化），用户只在全局两态间切换。

### 1.2 目标（可验收）

- 详细风格 = 现状基线（吸收旧 standard/full 的差异，见 §4.1 迁移映射）。
- 简要风格 = 索引化渲染 + 引导句 + 按需展开；默认关闭实验时行为与现状一致。
- 旧 tier 详度调度移除后，提示词构建**不再依赖 modelTier**（决策 6），详度选择只由全局风格决定。
- 强模型场景下实测 token 下降、任务成功率不降（场景化验收，见 §6）。

### 1.3 非目标

- 不改动 static/dynamic 分区与 `CACHE_BOUNDARY_MARKER` 缓存机制。
- 不引入"LLM 自动改写提示词"。
- 不改变各段语义与红线约束（terse 是呈现方式变化，细节仍可达）。

---

## 2. 现状盘点（Lumii）

### 2.1 提示词流水线（保持）

```
① 构建器（结构化，per-instance）：
   buildClientSystemPromptStructured()   packages/.../prompt/system-prompt-builder.ts:111
   → { staticPrompt, dynamicPrompt, fullPrompt }
   静态段：Identity→Tooling→SystemRules→工作原则→Skills→协作→安全→语言→…
   动态段：Memory→Workspace→项目上下文→设备→活跃任务→Runtime→…

② 宿主包装：
   assembleSystemPrompt()                packages/.../host-kit/prompt-assembly.ts:101
   → 生成 buildPrompt 闭包（assemble-agent.ts:154 调用）

③ 每轮组装（BridgePromptComposer）：
   buildPromptWithMemory()               apps/windows/.../bridge-prompt-composer.ts:328
   static + <CACHE_BOUNDARY> + dynamic + 记忆/场景记忆/任务/宠物/牵挂/诊断/presence
   调度：bridge-prompt-dispatcher.ts:212 prompt() → :252 rebuilder → :319 组装 → :325 setSystemPrompt
   注意：pi-agent-core 每轮 run 开始时快照 systemPrompt（agent-instance.ts:416）
```

### 2.2 将被移除的详度机制（`PromptDetail`）

现状：`PromptDetail = "compact" | "standard" | "full"`，由 `resolvePromptDetail(def.modelTier)` 在实例创建时映射一次（basic→compact / balanced→standard / performance→full），注入构建器后以"跳过 / 压缩 / 增补"三种手法作用到各段。

**移除触点清单（实施参考）**：

| 环节 | 位置 |
|------|------|
| 类型定义 | `system-prompt.types.ts:205`（类型）、`:262`（参数） |
| tier 映射（唯一调用方） | `bridge-prompt-composer.ts:668` `resolvePromptDetail` ← `bridge-instance-factory.ts:632` |
| 传递链 | `host-kit/prompt-assembly.ts:51,142`、`host-kit/assemble-agent.ts:54,163`、`src/index.ts:620`（导出） |
| 分支消费 | `system-prompt-builder.ts:139,205,249,269,300,341,376,432`；`sections/tooling-section.ts:284,302,331,362`；`sections/misc-sections.ts:21,80,138`；`sections/skills-section.ts:19`（参数已弃用） |
| 测试 | `packages/agent-runtime/src/__tests__/system-prompt-builder.test.ts`（4 处） |

⚠️ 注意：`AgentDefinition.modelTier` **字段本身保留**——它另有消费方（默认用途槽兜底 `agent-definition.ts:145-154`、API 映射 `api-agent-mapper.ts:89-92`、团队生成 UI）。本次移除的只是"**tier → 提示词详度**"这一条调度链。

### 2.3 已存在的渐进式加载先例（新设计直接复用）

| # | 机制 | 位置 | 形态 |
|---|------|------|------|
| 1 | 指南工具 `a2ui_guide` / `cron_guide` / `weixin_send_guide` | `bridge-tool-registrar-guide.ts:23-169` | 提示词只留工具名+一句话；完整参数文档工具调用时返回（注释明示"节省每轮 ~150 tokens"） |
| 2 | 技能工具化 | `skills-section.ts:28-64` | 提示词只列元数据（≤30 条、描述截 120 字符）；正文 `skill_invoke` 按需加载 |
| 3 | 工具 schema | 不在提示词内 | Tooling 段只做分组索引 + 一句话摘要（`tooling-section.ts:18-107`），参数契约随 API tools 参数下发 |
| 4 | 完整记忆指南懒注入 | `bridge-agent-instance-events.ts:494-503` → `bridge-instance-state.ts:59` | 首次 memory 工具调用后打标，下次构建把摘要段替换为完整指南 |
| 5 | 记忆预算截断 + 读取提示 | `bridge-prompt-composer.ts:598-629` | 超预算按章节截断，尾部附"用工具读全文"提示 |

### 2.4 配置机制现状

- 用户设置存 localStorage（key `mtbot-assistant-settings`，`settings-core.ts:11`），主进程经 IPC 同步读取；按段开关先例：`memory.injectPersonalMemory / injectWorkMemory`。
- 实验页 `ExperimentalSection`（`SettingsPage/components/ExperimentalSection/index.tsx`）当前仅嵌 AutonomousPage。
- 段级计量标签 `PROMPT_SECTION_TAGS`（tooling/skills/mcp_servers/subagents/memory）已存在，宿主按标签统计各分类 token。

---

## 3. Hermes 调研：提示词构建与模型引导

> 来源：`E:\open-source-project\hermes-agent`，`agent/system_prompt.py` / `agent/prompt_caching.py` / `website/docs/developer-guide/prompt-assembly.md`。

### 3.1 构建方式：三层排序 + ephemeral

`build_system_prompt_parts`（`system_prompt.py:338`）返回三层，按 `stable → context → volatile` 顺序拼接：

| 层 | 内容 | 变化频率 |
|----|------|---------|
| stable | SOUL.md/身份、工具行为指引、tool-use enforcement、环境探测、平台提示 | 会话内几乎不变 |
| context | workspace 快照、调用方 system_message、项目上下文文件 | 会话开始定 |
| volatile | 技能索引、MEMORY/USER 快照、时间戳/模型/provider | 每轮可能变 |

另设 **ephemeral 层**（`ephemeral_system_prompt`、pre_llm_call 插件上下文）：仅调用时附加，**永不写入缓存提示词**。

设计动机：stable 前缀逐字节不变 → KV-cache 命中；易变内容置尾 → 重建只重算尾部。两条铁律：系统提示词不在对话中途变化（除 `/model` 等显式操作）；ephemeral 绝不进缓存前缀。

### 3.2 引导模型工作的手法

1. **技能索引 + 显式行动指令**：「Before replying, scan the skills below. If one clearly matches your task, load it with `skill_view(name)` and follow its instructions.」——索引 + 触发条件 + 加载方式三段式。
2. **模型族差异化引导**：`tool-use enforcement` 仅对 GPT/Codex 系注入——按模型习惯裁剪话术。
3. **平台提示可配置**：`PLATFORM_HINTS` 支持 config.yaml `append`/`replace`——配置面优先。
4. **上下文文件收口**：多类候选仅加载优先级最高的一个；安全扫描（注入模式）+ 截断（70/20 头尾分割，按窗口缩放）。
5. **收尾引导**：达到 max_iterations 时去掉工具再调一次，让模型纯文本总结，而非硬截断。
6. **压缩 = 旋转会话**：压缩生成子会话（lineage 保留），提示词在压缩点重建。

### 3.3 对 Lumii 的借鉴取舍

| Hermes 机制 | Lumii 现状 | 采编结论 |
|-------------|-----------|---------|
| stable/context/volatile 排序原则 | static/dynamic 二分 | ✅ 借鉴：dynamic 内部再按"变化频率"排序（易变者置尾） |
| ephemeral 永不写缓存 | presence/concern/诊断等瞬时段混在 dynamic | ✅ 借鉴：标注 ephemeral 类段；未来引入显式缓存断点管理时置于断点后 |
| 技能索引三段式引导句 | 已有（"When a skill matches the task, you MUST use it"） | ✅ 作为 terse 段引导句模板 |
| 按模型族差异化引导 | 仅按 tier 调详度 | ⛔ 不采用：按决策 6，模型自动差异化退出，改为用户手动两态切换 |
| 平台提示 append/replace | 无 | ✅ 同思想：呈现风格可切换 |
| 上下文文件 first-match + 安全扫描 | BOOTSTRAP/CONTEXT 全量加载、无扫描 | ⏳ 记录差异，不在本设计范围 |
| 旋转会话压缩 | 已有多层压缩引擎设计（docs/design/2026-08-18） | ⏳ 独立议题 |
| 多租户/VM/MOA | — | ❌ 不迁移 |

**核心结论**：Hermes 的"分层为了缓存，索引为了按需加载，配置不改代码"三条原则与本需求同向。本设计 = 把提示词的"呈现风格"变成**全局两态可切换面**，段级差异内置。

---

## 4. 设计

### 4.1 单一风格轴 + 旧 detail 的迁移映射

```
PromptStyle = "detailed" | "terse"   （全局两态，默认 detailed）
  detailed = 现状基线（standard 为主，吸收 full 专属段，见下表）
  terse    = 索引化渲染 + 引导句 + 按需展开
```

旧 `compact/standard/full` 分支按以下映射归并（**实施时逐段核对**，确认行为与文案归属）：

| 现状 detail 分支 | 位置 | 新归属（建议） |
|---|---|---|
| Tool preference 注入（非 compact） | builder:205 | detailed：现状；terse：并入 Tooling 索引一行 |
| 工作原则双版 | builder:229 | detailed：standard 版；terse：索引句 + `prompt_guide` |
| Progress Updates 双版 | builder:249-261 | detailed：现 standard 文案；terse：现 compact 文案 |
| Device Control compact 单行 | builder:341-351 | terse：单行；detailed：完整段 |
| Cron compact 单行 | builder:376-386 | terse：单行 + `cron_guide` 引导；detailed：完整段 |
| Context Management（非 compact） | builder:432 | detailed：现状；terse：一行（实施核对） |
| Self-Learning（非 compact） | builder:300 | detailed：现状；terse：一行 + `prompt_guide` |
| Progressive Loading（非 compact）；Disk-Index（仅 full） | builder:269；tooling:302 | terse：核心句 + 引导；detailed：现状 + Disk-Index 去留见 §9 |
| Tool Naming Contract（仅 full） | builder:266；tooling:362 | detailed：保留；terse：不注入（见 §9） |
| System Rules compact 单行版 | tooling:340-345 | terse：现单行版（**保留红线句**）；detailed：现状 |
| Skills `_promptDetail`（已弃用） | skills:19 | 删除参数；terse/detailed 差异由工具化索引与提示增强承担 |
| misc-sections 中 detail 分支 ×3 | misc:21/80/138 | 实施时逐段核对（safety / messaging / fileOutput 等），terse 必须保留 MUST 句 |

### 4.2 段注册表（PromptSectionRegistry）

把 builder 里现存的条件分支重构为**数据驱动的段注册表**（结构性保留；按决策 3，不承载用户配置）：

```ts
// packages/agent-runtime/src/prompt/prompt-section-registry.ts（新增）
export type PromptStyle = 'detailed' | 'terse'

export interface PromptSectionSpec {
  /** 稳定 ID：调试标识 + prompt_guide 参数 + 计量标签。一经发布不可改名 */
  readonly id: PromptSectionId
  /** UI/调试分组：identity | rules | capabilities | collaboration | memory | runtime | channel */
  readonly group: PromptSectionGroup
  /** 缓存分区 */
  readonly zone: 'static' | 'dynamic'
  /** 是否支持 terse 渲染（红线段 false，风格=terse 时仍渲染 detailed 文案） */
  readonly terseAllowed: boolean
  /** 展开机制（terse 时在段尾渲染引导句） */
  readonly expandVia?: PromptExpandRoute
  /** 渲染：同 (ctx, style) → 同字节（确定性契约） */
  readonly render: (ctx: PromptRenderCtx, style: PromptStyle) => string[]
}

type PromptExpandRoute =
  | { kind: 'prompt-guide'; sectionId: PromptSectionId }        // 新增通用指南工具
  | { kind: 'existing-tool'; tool: string }                     // 复用 cron_guide / skill_invoke / skill_search 等
  | { kind: 'none' }                                            // 纯浓缩，无展开
```

- 构建器主流程改为：**按注册表声明顺序遍历 → 按 (style, 能力条件) 选择渲染 → 沿用现有 `tagged()` 标签包裹**。渲染顺序与拆分保持不变。
- `PROMPT_SECTION_TAGS` 扩展为全段计量。
- **段 ID 暴露（决策 3，面向调试）**：
  1. 构建日志逐段输出：`[prompt-section] id=<id> zone=<static|dynamic> style=<style> chars=<n>`；
  2. terse 引导句显式携带 ID：`prompt_guide(section: "<id>")`；
  3. 实验页只读清单展示段 ID / 当前 token / 展开方式；
  4. 段在最终文本中以现有 `tagged()` 标签名（或新增注释锚点）可定位——调试捕获提示词时可直接对应到注册表条目。

### 4.3 配置与 UI（单开关两态）

```ts
// AppSettings 新增（localStorage 持久化，随现有设置同步机制走）
promptStyle: {
  /** 全局风格；detailed = 现状基线（默认），terse = 索引化+渐进加载 */
  style: 'detailed' | 'terse',
}
```

- 无逐段配置、无 preset/overrides（决策 1/3）。
- UI（ExperimentalSection 新增卡片「提示词风格（实验）」）：
  - 顶部二选一开关（详细 / 简要）；
  - 下方**只读**段清单（按 group 折叠）：`段 ID | 分组 | 当前 token≈N | 索引化支持 ✓/✗ | 展开方式`，作为调试与理解入口；
  - `terseAllowed=false` 的段注明原因（如"安全红线，始终详细"）。
- 读取链路：dispatcher 每轮已有读取设置的模式（`getMemoryInjectionSettings`，`bridge-prompt-dispatcher.ts:312`）→ 新增 `getPromptStyleSettings()` → 传入 rebuilder → 构建器按 style 渲染。

### 4.4 渐进式加载：三种展开机制

terse 段的内容不是"消失"，而是转移到可发现的展开路径：

| 机制 | 适用段 | 实现 | 状态 |
|------|--------|------|------|
| **M1 复用已有工具链** | tooling、skills、cron、messaging、wiki、a2ui | terse 文案末尾指向已有工具：`cron_guide` / `skill_search` / `skill_invoke` / `weixin_send_guide` | 已有基建，terse 只改引导句 |
| **M2 新增 `prompt_guide` 工具** | 规则类段：operatingPrinciples、progressiveLoading、browser、fileOutput、deviceControl、selfLearning、contextManagement 等 | 照 `registerGuideTools` 模式注册：参数 `{ section: string }`，内部调用该段的 detailed 渲染返回 | 新增（小改动） |
| **M3 事件触发升格** | memory（完整指南）等 | 沿用 `memoryGuideInjected` 模式：首次相关工具调用 → 标记 → 下次构建替换为 detailed | 已有，保持 |

**terse 段文案模板**（参考 Hermes 技能索引三段式，引导句英文——决策 4）：

```
## <段名>
<一句话：这组能力是什么 / 何时用>。<触发条件句>。<展开指引>
例：
## Scheduled Tasks
`cron_create` / `cron_list` / `cron_delete` manage recurring and one-time
scheduled tasks. Call `cron_guide` for the parameter format before creating one.
```

`prompt_guide` 工具要点：

- 注册位置：`bridge-tool-registrar-guide.ts`（与既有 guide 工具并列）；
- 返回内容 = 该段 `render(ctx, 'detailed')` 的文本；
- **不回流系统提示词（决策 5）**：展开结果作为工具结果存在于对话历史；系统提示词保持 terse，前缀缓存稳定。

### 4.5 渲染契约（保证可缓存、可测试）

1. **确定性**：`render(ctx, style)` 对相同输入逐字节稳定（禁止时间戳、随机、遍历顺序不稳定）。
2. **分区不变**：段归 static/dynamic 与现状一致；工作记忆占位符继续留在 dynamic。
3. **去重不变**：段内既有去重逻辑（技能列表、已注入记忆等）保持不变。
4. **度量对齐**：每段包 `tagged()` 标签 + 注册表 id，供 token 计量与测试断言。

### 4.6 生效时机与缓存影响

- 设置变更 → `SETTINGS_UPDATE_EVENT` → 下一轮 dispatcher 重建生效（与记忆注入开关同路径）。
- 风格切换改变段内容 → 静态前缀缓存**一次性重建**；用户显式操作，可接受。确定性渲染保证"设置不变 → 字节不变 → 缓存稳定"。
- terse 的展开（`prompt_guide`）只追加对话消息，不触碰系统提示词前缀。

---

## 5. 段清单与 terse 支持建议

> "terse 支持"= 该段是否具备索引化渲染；风格=terse 时支持者索引化，不支持者保持详细。
> 原则：① 有独立详细文档/工具可拉取；② 低频触发；③ 误用代价低（schema/工具侧可兜底）。红线段（安全、完成契约、语言、验证）不支持或必须保留 MUST 句。

### 静态段

| 段（id 建议） | 组 | terse 支持 | 展开机制 | 说明 |
|---|---|---|---|---|
| identity | identity | ✗ | — | 身份/SOUL，必须常驻 |
| permissionMode | rules | ✗ | — | 权限提示，短且敏感 |
| tooling | capabilities | ✓（已是索引） | M1 schema 随 API 下发 | 已是分组索引；terse 进一步折叠为组名+数量 |
| systemRules | rules | △（保留 MUST 句） | M2 | 反注入/URL 等运行规则 |
| toolPreference | capabilities | ✓ | M2 | 一句话优先级链 |
| operatingPrinciples | rules | ✓ | M2 | 工程原则长文 |
| bundledCapabilities | capabilities | ✓（已是索引） | M1 | 已最简 |
| progressUpdates | rules | ✓ | — | 复用现 compact 文案 |
| verification | rules | ✗ | — | 防幻觉验证，红线 |
| toolNamingContract | rules | ✗ | — | 旧 full 专属段，去留见 §9 |
| progressiveLoading | capabilities | ✓ | M2 | 保留"先索引后加载"核心句 |
| mcp | capabilities | 视内容 | — | 通常短 |
| skills | capabilities | ✓（已是索引） | M1 skill_search/skill_invoke | 已工具化 |
| selfLearning | capabilities | ✓ | M2 | 现 compact 已跳过 |
| taskOrchestration | collaboration | ✓ | M2 | 规则类长文 |
| subagentRole | collaboration | ✗ | — | 子 Agent 红线约束 |
| agentCollaboration | collaboration | ✓（已是索引） | M1 spawn/send | 目录已索引 |
| deviceControl | collaboration | ✓ | M2 | 现 compact 已有单行版 |
| safety | rules | ✗（terse 必须保留红线句） | M2 | 安全边界 |
| language | rules | ✗ | — | 输出语言约定，短 |
| taskCompletion | rules | ✗（保留一句话契约） | — | task_complete 是完成信号 |
| messaging | channel | ✓ | M1 weixin_send_guide | |
| wiki | capabilities | ✓ | M1 wiki_* 工具链 | |
| browser | capabilities | ✓ | M2 / Browser 正文 | 正文段可一并索引化 |
| cron | capabilities | ✓ | M1 cron_guide | 两版文案已存在 |
| fileOutput | rules | ✓ | M2 | 输出规范 |

### 动态段

| 段 | terse 支持 | 说明 |
|---|---|---|
| memory（摘要/完整指南） | 维持 M3 | 已有懒注入，不进本实验改动面 |
| workspace / projectContext | ✗ | 内容性文件，保留 |
| userDevices | ✓ | 可压缩 |
| activeTasks / runtime / skillActivation / routingRationale / criticalReminder | ✗ | 运行时数据与动态触发，保留 |
| contextManagement | ✓ | M2 |
| personalMemory / sceneMemory | 维持现状（预算截断） | 已有机制 |
| presence / diagnostics / concern / vh | ✗（标注 ephemeral 类） | 瞬时状态 |

### P1 首批试点（5 段，闭环最完整）

`cron`（M1 已有 cron_guide）、`messaging`（M1 已有 weixin guide）、`fileOutput`（M2）、`operatingPrinciples`（M2）、`browser`（M2）。选型理由：要么已有展开工具、要么纯规则文本，风险低、验证快。

---

## 6. 观测与验收（场景化）

### 6.1 指标

- **成本**：每轮 systemPrompt token（扩 `PROMPT_SECTION_TAGS` 后按段可见）、首轮/稳态输入 token、缓存读取占比（如可观测）。
- **行为**：任务完成率、平均轮数、工具错误率、`prompt_guide`/guide 调用率与分布、"未按规则执行"类失败次数。
- **回归**：红线行为（不得重复被拒工具、task_complete 时序、语言输出）在 terse 下不发生回归。

### 6.2 场景化用例（按真实使用旅程）

对每个场景跑 `{detailed, terse}` 两档对照：

1. 建定时提醒（微信渠道）→ 观察是否调 `cron_guide`；
2. 微信发文件 → 观察是否走 `weixin_send_guide` 指引；
3. 多步文件整理（file_* 工具 + 输出规范）→ 观察 fileOutput 规范遵守；
4. 委派子 Agent 完成任务 → 观察协作段引导；
5. 代码修改任务 → 观察工程原则/验证段行为；
6. 长对话 + 记忆保存 → 观察记忆段与 M3 懒注入无回归。

**关键断言**：terse 下，依赖某段详细规则的场景中，模型应出现对应展开调用（cron_guide / prompt_guide 等）或表现出等价行为；否则说明"引导句不可发现"，回到文案迭代。

### 6.3 P0 快照验证

注册表重构后，对一组典型配置（有无技能/有无 MCP/子 Agent/多设备等组合）断言 `fullPrompt` 与重构前**逐字节一致**——保证 P0 纯结构重构、零行为变化。

---

## 7. 分阶段实施

### P0：结构重构 + 调试面板骨架（行为零变化）

1. 新增 `prompt-section-registry.ts`，builder 改为注册表驱动（detail 分支原样包裹进各段渲染，暂不删除）；
2. 快照测试锁定 byte 级输出不变（§6.3）；
3. 段 ID 暴露：构建日志逐段计量 + `PROMPT_SECTION_TAGS` 扩到全段；
4. `AppSettings.promptStyle`（默认 detailed）+ ExperimentalSection 只读段清单骨架。

### P1：两态风格落地 + 移除旧详度调度

1. 实现首批 5 段 terse 渲染 + `prompt_guide` 工具；
2. **执行 §2.2 移除清单**：删除 `PromptDetail` 与 `resolvePromptDetail` 调度链（含测试同步），按 §4.1 迁移映射把旧 compact/full 分支归并到 detailed/terse；
3. 场景化验收：场景 1/2/5 双档对照跑通；
4. 观测埋点：guide 调用日志 + 段级 token 统计。

### P2：扩展与完善

1. 覆盖其余 terse 支持段；
2. 调试面板完善（段级 token 可视化、terse/detailed 对比预览）；
3. 评估 A/B（复用 `autonomous-wiring.ts:201` 的 ε-greedy 变体机制）；
4. 依据实测迭代 terse 引导句文案。

---

## 8. 风险与对策

| 风险 | 对策 |
|------|------|
| terse 误伤：模型看不到关键规则而犯错 | 红线白名单（§5 灰显段）；terse 保留 MUST 句；场景化验收兜底 |
| 模型不展开 guide：不知道去拿细节 | 引导句三段式模板（是什么/何时用/怎么拿）；terse 段尾显式给出调用示例；观测调用率迭代文案 |
| 移除 tier 调度后弱模型承接变重 | 决策 6 已接受；实验默认 detailed 不改变现状；如出现弱模型回归，再评估（不在本期范围） |
| 缓存抖动 | 渲染确定性契约；全局切换才重建；terse 展开不触碰系统前缀 |
| `prompt_guide` 被滥用（高频调用浪费轮次） | P1 先观测；必要时加调用提示 + 段级限流 |

---

## 9. 遗留小项（实施时确认）

1. 旧 full 专属内容（Disk-Index Pattern、Tool Naming Contract）归并到 detailed 还是直接删除——v2 建议：先并入 detailed 保持信息不丢，实测后决定是否精简。
2. terse 引导句是否需要在模型侧区分"必须展开"与"可选展开"两类语气（M2 多段共享一个 `prompt_guide`，语气统一 vs 分档）。
3. 调试面板是否展示 terse/detailed 双版本 diff 预览（P2 可选项）。

---

## 10. 附录：现状与设计的关系图

```
现状：modelTier ──> PromptDetail(compact/standard/full) ──> 段内容(写死在 if 链里)   ← 整链移除（决策 6）

设计：全局风格(详细|简要) ──> [段注册表] ──┬─> detailed 渲染(现状基线文案)
                                          └─> terse 渲染(索引 + 引导句)
                                                  │
                        ┌─────────────────────────┼─────────────────────────┐
                        ▼                         ▼                         ▼
                  M1 已有工具链            M2 prompt_guide           M3 事件触发升格
              (cron_guide/skill_invoke…)   (规则段通用展开)        (memory 指南，现状保留)

  段 ID 暴露（决策 3）：构建日志逐段计量 / 引导句携带 section 参数 / 只读调试清单
```
