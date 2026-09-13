# 提示词风格实验实施计划（简要/详细 · 段级渐进加载）

> 设计依据：[`docs/design/AGENT优化/2026-09-13-prompt-style-experiment-design.md`](../../design/AGENT优化/2026-09-13-prompt-style-experiment-design.md)（v2，六项决策已拍板）
> 分析来源：对本仓库提示词链路逐文件实勘（构建器 / 宿主包装 / 每轮调度 / 设置同步 / 工具注册），行号均为 2026-09-13 实测。

**Goal:** 引入全局两态提示词风格（详细 = 现状基线 / 简要 = 索引化 + 渐进式加载），移除旧 `tier → PromptDetail` 调度链，段 ID 与段级计量暴露用于调试。

**Architecture:** 轻量段元数据表（id / group / zone / terse / expandVia）+ 构建器 `emit()` 包装（计量与调试日志），**不迁移渲染函数**（见 §0.4 修订 1）。terse 段细节经 `prompt_guide`（M2，新增）与既有指南工具（M1：cron_guide / weixin_send_guide / skill_invoke 等）按需展开；展开内容只进对话历史、不回流系统提示词（决策 5）。

**Tech Stack:** TypeScript、Vitest、既有 `assembleSystemPrompt` / `BridgePromptComposer` / `bridge-prompt-dispatcher` 链路、localStorage 设置 + IPC 主进程缓存。

**原则:** TDD、小步提交、每步可验收；**默认 detailed，行为不变**；红线段（safety / verification / language / taskCompletion 等）不索引化；YAGNI。

**预期收益:** 简要档削减静态段体量（首批 5 段目标 −40%~60%，以实测为准）；新增段级计量与稳定段 ID（调试、验收共用）。

**工作方式:** 独立分支 `feat/prompt-style-experiment`（用户并行改动多，勿在主工作区留未提交产物）。提交规范：先看 diff → `git add` 指定文件 → 不带 pathspec 提交；每个 Task 独立提交。

---

## 进度

**P0 — 结构基座（行为零变化）**

- [ ] P0-T1 快照基线测试（先于一切改动）
- [ ] P0-T2 段元数据表 + `emit()` 包装 + `sectionStats`
- [ ] P0-T3 宿主侧段日志
- [ ] P0-T4 设置存储与读取链（无消费）
- [ ] P0-T5 只读段清单面板（实验页）

**P1 — 两态落地**

- [ ] P1-T1 `section-guides.ts` + `prompt_guide` 工具
- [ ] P1-T2 风格接线 + 移除 PromptDetail 全链（迁移映射执行）
- [ ] P1-T3 首批 5 段 terse 渲染 + UI 开关启用
- [ ] P1-T4 测试重写与新增（含守卫测试）
- [ ] P1-T5 场景化验收

**P2 — 扩展（另开计划细化）**

- [ ] 其余段 terse 覆盖 / 段级 token 面板 / Disk-Index 与 Tool Naming Contract 去留判定 / A/B 观测

---

## 0. 代码实勘结论（实施前必读）

### 0.1 数据流锚点

```
① 构建器（结构化，per-instance）
   buildClientSystemPromptStructured()      packages/agent-runtime/src/prompt/system-prompt-builder.ts:111
   const detail = params.promptDetail ?? "standard"                                    :139
   静态段 if 链 :167-395（含 detail 分支 :205 / :229 / :249 / :264 / :266 / :269 / :300 / :341 / :376 / :390）
   动态段 :397-451（含 :432 detail 分支）
   → SystemPromptResult { staticPrompt, dynamicPrompt, fullPrompt }（types :173-183）

② 宿主包装（host-kit）
   assembleSystemPrompt()                   packages/agent-runtime/src/host-kit/prompt-assembly.ts:101
   buildPrompt 闭包签名（3 参）                                                                :28-32
   promptDetail 透传                                                                    :51 / :142
   assemble-agent.ts :54 / :163 同步透传

③ 每轮调度（apps/windows）
   实例创建：bridge-instance-factory.ts:632  promptDetail: resolvePromptDetail(def.modelTier)
   composer：bridge-prompt-composer.ts:668   resolvePromptDetail()（唯一调用方 = 工厂 :632）
   每轮：bridge-prompt-dispatcher.ts:212 prompt()
        →:252 rebuilder（缓存闭包）  →:304 rebuilder(hints, currentModelId, routerLite)
        →:312 读 injSettings        →:319 buildPromptWithMemory →:325 setSystemPrompt
   ⚠ pi-agent-core 每轮 run 开始快照 systemPrompt（agent-instance.ts:416）——风格变更下一轮生效

④ 设置同步
   渲染层：useSettings.types.ts:98-111 AppSettings / settings-core.ts:19-74 DEFAULT_SETTINGS
   主进程：index.ts:701-713 getMemoryInjectionSettings（读渲染层 localStorage，带缓存）
          index.ts:968-984 缓存 + setMemoryInjectionSettingsCache
          index.ts:1042-1063 registerAllIpcHandlers（:1058 接线）
          bridge-types.ts:142 / bridge.ts:255 注入到 bridge

⑤ 工具注册（指南工具先例）
   bridge-tool-registrar-guide.ts:23 registerGuideTools（a2ui_guide / cron_guide / weixin_send_guide）
```

### 0.2 六项决策 → 代码触点

| 决策 | 触点 |
|------|------|
| 1 两态风格 | `AppSettings.promptStyle`（单字段二选一）；无 off |
| 2 全局配置 | localStorage 设置 + 主进程缓存 + dispatcher 每轮读取（同 injSettings 通路） |
| 3 段 ID 暴露 | `PROMPT_SECTIONS` 元数据表 → `sectionStats` 返回 + 宿主日志 + 只读面板；terse 引导句携带 `prompt_guide(section: "<id>")` |
| 4 terse 引导句英文 | `section-guides.ts` 与各段 terse 文案均为英文 |
| 5 不回流 | `prompt_guide` 结果仅作工具结果；系统提示词每轮仍按 style 渲染 terse |
| 6 移除 tier 调度 | 删 `resolvePromptDetail`（composer:668）+ `PromptDetail` 类型/参数全链（见 §2 P1-T2 迁移表） |

### 0.3 易踩坑

1. **Runtime 段含日期**（`runtime-section.ts:26` `new Date()`）——快照测试必须冻结系统时间（`vi.setSystemTime`），否则每天红。
2. **快照必须先于重构生成并提交**——先跑现网代码出快照，再重构；重构后快照零 diff 才是"零行为变化"的证明。
3. **`PROMPT_SECTION_TAGS` 目前没有宿主观测消费方**（全仓仅 types:194-200 定义 + builder/index 导出）——段级计量本次不进该通道，走 `sectionStats` + 日志；标签扩展与计量面板留 P2。
4. **cron 段其实已索引化**：`buildCronSection` 返回 `[]`（misc-sections.ts:458-461），规则在 Tooling 的 `TOOL_SUMMARIES`/`GROUP_NOTES`（`Call cron_guide first...`）。故首批试点剔除 cron，换 `progressiveLoading`（见 §0.4 修订 2）。
5. **`buildSkillsSection` 的 `_promptDetail` 参数已弃用**（skills-section.ts:19），直接删除，不要再接风格。
6. **移除 detail 会改变 basic 档行为**（原 compact）；这是决策 6 的已知代价。验收时以"detailed 基线 = 原 standard（balanced 档）逐字节一致"为准绳。
7. **设置缓存失效要跟住既有通路**（`memoryInjectionSettingsCache` 的 IPC 更新路径），否则 UI 切换不即时生效。
8. **`AgentDefinition.modelTier` 字段保留**（另有用途：用途槽兜底、管理 UI），只删"tier→详度"调度。
9. **测试基线**：`apps/windows` 存在 39 个既有失败（8 文件），别误判成本次引入；对照 `packages/agent-runtime` 与目标文件单测。
10. **提交规范**：用户并行改动多——先看 diff → `git add` 指定文件 → 不带 pathspec 提交。

### 0.4 与设计 v2 的三处实施修订（实勘后细化，可评审）

1. **注册表轻量化**：不做"渲染函数迁入注册表"的完整重构（此前 tooling 重构已判定同类改造过度设计，见 `2026-08-28-tooling-prompt-refactor-implementation.md` §5）。改为：**元数据表（id/group/zone/terse/expandVia）+ 构建器 `emit()` 包装**，渲染函数留在原处。段 ID、计量、风格分发三个目标不受影响。
2. **首批试点替换**：cron（已索引，无改造空间）→ 换为 `progressiveLoading`。首批 = `operatingPrinciples` / `progressiveLoading` / `fileOutput` / `browser` / `messaging`。
3. **UI 开关延迟到 P1**：P0 只上只读段清单面板（避免出现"可点但不生效"的死开关）；P1 接线完成后开关启用。

---

## 1. P0 任务分解（行为零变化）

> 分支：`feat/prompt-style-experiment`（P0 全部可独立合并）

### P0-T1 快照基线测试（先于一切改动）

**新增:** `packages/agent-runtime/src/__tests__/system-prompt-snapshot.test.ts`

1. `beforeAll` 冻结时间：`vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))`。
2. 构建 4 组配置并 `toMatchSnapshot()`：
   - 最小 assistant（无技能 / 无设备 / 无任务）；
   - 全能力（code tools + skills + customAgents + userDevices + activeTasks + mcpServerHints）；
   - 子 Agent（`isSubAgent: true`）；
   - 中文渠道场景（`runtimeInfo.channel = "weixin"` + messaging 工具）。
3. 全部显式传 `promptDetail: "standard"`（P0 阶段 detail 仍在）。
4. **先跑、先提交快照文件**，作为后续所有重构的对照基线。

**验收:** 快照生成并提交；`pnpm --filter ./packages/agent-runtime test` 绿。

### P0-T2 段元数据表 + `emit()` 包装 + `sectionStats`

**新增:** `packages/agent-runtime/src/prompt/prompt-sections.ts`

```ts
export type PromptSectionGroup = "identity" | "rules" | "capabilities" | "collaboration" | "memory" | "runtime" | "channel"
export type PromptSectionId = "identity" | "permissionMode" | "tooling" | "systemRules" | /* …共约 30 个，从 builder 静态/动态段逐一枚举… */
export interface PromptSectionMeta {
  readonly id: PromptSectionId
  readonly group: PromptSectionGroup
  readonly zone: "static" | "dynamic"
  /** 是否具备 terse 渲染（P0 全部先标 false/规划值，P1 起真实生效） */
  readonly terse: boolean
  /** 展开方式（terse 时引导句用） */
  readonly expandVia?: "prompt-guide" | "existing-tool"
}
export const PROMPT_SECTIONS: readonly PromptSectionMeta[] = [ /* … */ ]
```

**修改:** `system-prompt-builder.ts`、`system-prompt.types.ts`

1. builder 内新增局部统计与包装：
   ```ts
   const stats: PromptSectionStat[] = []
   const emit = (zone: "static" | "dynamic", id: PromptSectionId, lines: string[]) => {
     if (lines.length === 0) return
     (zone === "static" ? staticLines : dynamicLines).push(...lines)
     stats.push({ id, zone, chars: lines.join("\n").length })
   }
   ```
2. 把现有 `staticLines.push(...)` / `dynamicLines.push(...)` 调用点（约 30 处）机械替换为 `emit(zone, id, [...])`。**顺序、内容、空段过滤行为不变**（快照验证）。
3. `system-prompt.types.ts`：`SystemPromptResult` 增 `readonly sectionStats?: readonly PromptSectionStat[]`；导出 `PromptSectionStat`。
4. `prompt/index.ts`、`src/index.ts` 导出新类型与 `PROMPT_SECTIONS`。

**验收:** P0-T1 快照零 diff；`sectionStats` 覆盖全部实际渲染段且 chars 总和 = fullPrompt 近似值（允许分隔符误差，测试断言 > 0）。

### P0-T3 宿主侧段日志

**修改:** `bridge-prompt-dispatcher.ts`（rebuild 成功后，:304-309 附近）

1. `state.basePrompt.sectionStats` 存在时：info 级输出汇总（`[prompt-section] sections=N totalChars=M style=…`），debug 级逐段输出 `id/zone/chars`。

**验收:** 跑一轮真实对话，日志可查到段级计量；无 sectionStats 时不报错（防御）。

### P0-T4 设置存储与读取链（无消费）

**修改（渲染层）:**
- `useSettings.types.ts` 增：`export interface PromptStyleConfig { style: "detailed" | "terse" }`；`AppSettings` 增 `promptStyle: PromptStyleConfig`。
- `settings-core.ts` `DEFAULT_SETTINGS` 增 `promptStyle: { style: "detailed" }`。

**修改（主进程）:**
- `index.ts`：仿 `memoryInjectionSettingsCache`（:968-984）增 `promptStyleSettingsCache` + `setPromptStyleSettingsCache`；仿 :701-713 增 `getPromptStyleSettings`（读 `settings?.promptStyle`，默认 `detailed`）。
- `index.ts:1042-1063`：`registerAllIpcHandlers` 增 `setPromptStyleSettings` 接线。
- `settings-ipc.ts` / `settings-service.ts`：仿 `setMemoryInjectionSettings` 的通道，新增 promptStyle 同步通道（渲染层设置变更时推送）。
- `bridge-types.ts:142` 区域增 `getPromptStyleSettings?: () => Promise<{ style: "detailed" | "terse" }>`；`bridge.ts:255` 区域仿 `getMemoryInjectionSettings` 透传。

**验收:** 改 localStorage 中 `promptStyle.style` 后，主进程 `getPromptStyleSettings()` 返回同步值（手工 + 单测各一）；此阶段无人消费，行为不变。

### P0-T5 只读段清单面板（实验页）

**修改:** `SettingsPage/components/ExperimentalSection/index.tsx`

1. 新增卡片「提示词风格（实验）」：说明文案 + 只读段清单表格（`段 ID | 分组 | 分区 | 索引化支持 | 展开方式`），数据源 `PROMPT_SECTIONS`。
2. 实施时核实渲染层是否已依赖 `@mtbot/agent-runtime`：可导入则直接导入；否则先在页面内维护展示常量，P1 接通时替换为导入（并在计划进度中记录）。

**验收:** 面板可见、数据与 `PROMPT_SECTIONS` 一致；无交互开关（P0 不出现死开关）。

---

## 2. P1 任务分解

> 分支延续 `feat/prompt-style-experiment`；每 Task 独立提交。

### P1-T1 `section-guides.ts` + `prompt_guide` 工具

**新增:** `packages/agent-runtime/src/prompt/section-guides.ts`

```ts
export const PROMPT_GUIDE_SECTIONS: Record<string, { title: string; body: string }> = {
  operatingPrinciples: { title: "Operating Principles (full)", body: "..." },
  progressiveLoading:  { title: "Context and Input Handling (full)", body: "..." },
  fileOutput:          { title: "File Output Standards (full)", body: "..." },
  browser:             { title: "Browser Control (full)", body: "..." },
  messaging:           { title: "Messaging (full)", body: "..." },
  // P2 按设计 §5 表逐段补齐
}
export function getPromptSectionGuide(id: string): { title: string; body: string } | null
```

文档正文英文（决策 4）；内容即对应段 detailed 渲染的完整规则（可含示例，欢迎比提示词原文更长——按需加载）。

**修改:** `bridge-tool-registrar-guide.ts`（registerGuideTools 内，:23-169 同款模式）

1. 注册 `prompt_guide`：params `{ section: string }`；description：
   `Get the full rules for a prompt section — call when a terse hint in the system prompt is not enough. Pass the `section` id shown in the hint.`
2. execute：`getPromptSectionGuide(section)`；未命中返回 `{ error, available_sections: [...] }`。
3. 常驻注册（detailed 档下无害，1 行 schema）。
4. `prompt/index.ts`、`src/index.ts` 导出 guides API。

**验收:** 工具单测（已知 id 返回非空 body；未知 id 返回 available_sections）；`prompt_guide` 出现在工具清单。

### P1-T2 风格接线 + 移除 PromptDetail 全链（迁移映射执行）

**前置:** P0 快照绿。**本 Task 完成后**：详细档对原 standard 配置输出与快照一致（允许的差异仅限下方迁移表中标注项）。

**修改清单与迁移映射：**

| # | 位置 | 现状 | 动作 |
|---|------|------|------|
| 1 | `system-prompt.types.ts:205,262` | `PromptDetail` + `promptDetail?` | 增 `PromptStyle = "detailed" \| "terse"`；参数改 `promptStyle?: PromptStyle`；删 `PromptDetail` |
| 2 | `system-prompt-builder.ts:139` | `const detail = params.promptDetail ?? "standard"` | `const style = params.promptStyle ?? "detailed"` |
| 3 | builder:205 工具优先级 | `detail !== "compact"` | 移除判断（两种风格都注入；terse 合并进 Tooling 归 P2） |
| 4 | builder:229 工作原则 | 传 detail | 传 style（P1-T3 pilot：terse/detailed 双渲染） |
| 5 | builder:249-261 进度更新 | compact/standard 双版 | terse 用 compact 文案；detailed 用 standard 文案 |
| 6 | builder:264 验证 | 传 detail | 删参数，固定 standard 文案（红线段） |
| 7 | builder:266 命名契约 | 仅 full | 改 `style === "detailed"` 才注入 |
| 8 | builder:269 渐进加载 | `detail !== "compact"` | 移除判断；段内按 style 渲染（pilot） |
| 9 | builder:300 自我学习 | `!isSubAgent && detail !== "compact"` | 保留 `!isSubAgent`，移除 compact 判断 |
| 10 | builder:341-351 设备控制 | compact 单行 / 完整段 | 恒走完整段（terse 版 P2） |
| 11 | builder:376-386 Cron 块 | compact 单行 / 否则空段 | **整块删除**；同时删死函数 `buildCronSection`（misc-sections.ts:458-461） |
| 12 | builder:432 压缩告知 | `detail !== "compact"` | 移除判断 |
| 13 | `tooling-section.ts:284` 渐进加载 | detail（full 加 Disk-Index） | 改 style：terse=核心句+guide 指引；detailed=standard + Disk-Index（去留见设计 §9.1，P2 定） |
| 14 | `tooling-section.ts:331` 系统规则 | compact 单行 | 删参数，固定 standard；terse 版（保留 MUST 句）P2 |
| 15 | `tooling-section.ts:362` 命名契约 | full only | 删参数，由调用方按 style 门控（见 #7） |
| 16 | `misc-sections.ts:19-64` 安全 | compact 单行分支 | 删 compact 分支，固定 standard |
| 17 | `misc-sections.ts:78` 验证 | compact 单行分支 | 同上 |
| 18 | `misc-sections.ts:137` 工作原则 | compact 行 / standard / full+code | 改 style：terse=compact 行+guide 指引；detailed=standard，`hasCodeTools` 时并入 "When writing code" 块（原 full 行为升格） |
| 19 | `skills-section.ts:16-21` | `_promptDetail` 弃用参数 | 删除参数与调用点实参 |
| 20 | `prompt-assembly.ts:23,51,142` | `promptDetail` 透传 | 改 `promptStyle` |
| 21 | `assemble-agent.ts:27,54,163` | 同上 | 改 `promptStyle` |
| 22 | `prompt-assembly.ts:28-32` `SystemPromptBuilder` | 3 参闭包 | 增第 4 参 `promptStyle?: PromptStyle` |
| 23 | `bridge-instance-factory.ts:632` | `resolvePromptDetail(def.modelTier)` | `promptStyle: (await this.deps.config.getPromptStyleSettings?.())?.style`（创建时读一次；实施时按依赖形态落） |
| 24 | `bridge-prompt-composer.ts:668` | `resolvePromptDetail` | **删除方法** |
| 25 | `bridge-prompt-dispatcher.ts:304` | `rebuilder(hints, currentModelId, routerLite)` | 读取 settings 后传第 4 参：`rebuilder(hints, currentModelId, routerLite, style)`（与 :312 的 injSettings 读取合并为一次设置读取） |
| 26 | exports | `PromptDetail` 导出（index.ts:620、prompt/index.ts:11） | 换 `PromptStyle` |

**验收:**
- `grep -rn "PromptDetail\|promptDetail\|resolvePromptDetail" packages apps` 无残留；
- P0 快照在 `promptStyle: "detailed"` 下零 diff（迁移表 #7/#18 两处属计划内升级，若快照因此 diff，须在提交信息中逐条列明）；
- typecheck 绿。

### P1-T3 首批 5 段 terse 渲染 + UI 开关启用

**修改:** builder（风格分支）、`misc-sections.ts`（operatingPrinciples / fileOutput / browser / messaging）、`tooling-section.ts`（progressiveLoading）、`ExperimentalSection/index.tsx`（开关启用）

terse 文案模板（英文，含引导句）：

```markdown
## Operating Principles
Infer the real goal, stay within scope, fix root causes, and avoid speculative design.
Full principles: `prompt_guide(section: "operatingPrinciples")`.

## Context and Input Handling
Use bounded, progressive reads: inspect indexes or summaries first, then load only what is needed.
Details: `prompt_guide(section: "progressiveLoading")`.

## File Output Standards
Write deliverables under `outputs/<task>/` (never flat, never workspace root); reuse the task directory for continued work.
Path discipline: use returned paths verbatim; verify before citing.
Details: `prompt_guide(section: "fileOutput")`.

## Browser Control
You control a live browser; after each action take a `browser_screenshot`, and locate elements via `browser_eval`.
Details: `prompt_guide(section: "browser")`.

## Messaging
`message` = in-turn reply only (NO_REPLY flow); cross-peer delivery uses `channel_send` (call `channel_list` first).
WeChat file/image delivery: call `weixin_send_guide` first.
```

红线保持：`operatingPrinciples` 的 terse 版保留"根因/不越界"约束句；其余四段均为操作规范类，不涉红线。

**UI:** P0-T5 面板升级：新增二选一开关（详细 / 简要），写入 `promptStyle.style` → IPC 缓存 → 下一轮对话生效；面板注明"下一轮对话生效"。

**验收:** 5 段单测（terse 与 detailed 双断言）；切换开关后下一轮 `system_prompt` 读回的提示词呈现 terse 形态。

### P1-T4 测试重写与新增

1. **重写** `system-prompt-builder.test.ts`（6 例）：
   - `promptDetail: "full"` 两例 → `promptStyle: "detailed"`；断言不变（detailed 吸收 full 行为）；
   - `promptDetail: "standard"` 两例 → 去参数（默认 detailed）；
   - `promptDetail: "compact"` 一例（压缩告知缺席）→ 改为 terse 语义用例：**terse 下 `## Context Compaction` 仍注入**（该段 P1 未 terse 化，行为=detailed 渲染；P2 实现后此用例改写为"terse 下一行版存在"）；
   - 其余去掉参数。
2. **新增** `sections/__tests__/prompt-sections.test.ts`（守卫测试）：
   - `PROMPT_SECTIONS` 无重复 id；`terse: true` 段必有 `expandVia`；
   - 每个 `expandVia: "prompt-guide"` 的段：其 id 存在于 `PROMPT_GUIDE_SECTIONS`；
   - 每个 terse 渲染文本包含 `prompt_guide(section: "<id>")` 字面量（引导可发现性守卫）；
   - 红线段（safety / verification / language / taskCompletion）断言 `terse: false`。
3. **新增** builder terse/detailed 对比用例：terse 下 5 段均出现引导句、且静态段总 chars 小于 detailed（量化阈值实施时定）。
4. **prompt_guide 工具测试**：返回体结构、未知 id 兜底。
5. **dispatcher 测试**（`bridge-prompt-dispatcher.test.ts` 既有 harness 扩展）：settings 返回 `terse` 时 rebuilder 收到第 4 参。

**验收:** 上述测试全绿；`packages/agent-runtime` 全量测试绿（对照既有失败基线，不新增失败）。

### P1-T5 场景化验收（设计 §6）

按真实使用旅程双档对照（`pnpm dev` 起客户端，切换开关各跑一遍）：

1. 微信渠道建定时提醒 → terse 下应观察到 `cron_guide` 调用；
2. 微信发文件 → 应走 `weixin_send_guide` 指引；
3. 代码修改任务 → 观察 detailed 的代码细则注入与 terse 下 `prompt_guide(section:"operatingPrinciples")` 的调用或等价行为；
4. 长对话 + 记忆保存 → 记忆段与 M3 懒注入无回归（红线回归项）。

记录：完成率 / 轮数 / 工具错误 / guide 调用分布 / 提示词 token。**关键断言**：terse 下依赖被索引化段规则的场景，模型应出现对应展开调用或等价行为；若否，回到引导句文案迭代（不改机制）。

**验收:** 场景 1/2/3 双档通过；记录表归档到本计划「实施记录」节。

---

## 3. P2（占位，另开细化）

1. 其余段 terse 覆盖（按设计 §5 表逐段：taskOrchestration / deviceControl / selfLearning / contextManagement / wiki / userDevices…）；
2. 段级 token 面板（`sectionStats` 可视化；`PROMPT_SECTION_TAGS` 通道一并评估）；
3. Disk-Index Pattern、Tool Naming Contract 去留判定（设计 §9.1）；
4. A/B 观测（复用 `autonomous-wiring.ts:201` ε-greedy 机制）；
5. 可选：dynamic 段按"变化频率"重排序（Hermes 借鉴项，设计 §3.3）。

---

## 4. 测试策略

| 层级 | 文件 | 覆盖 | 阶段 |
|------|------|------|------|
| 快照基线 | `packages/agent-runtime/src/__tests__/system-prompt-snapshot.test.ts` | 4 组配置 byte 级基线（冻结时间） | P0-T1 |
| 段结构守卫 | `prompt/sections/__tests__/prompt-sections.test.ts` | id 唯一 / terse 元数据完整 / 引导句含 id / 红线段豁免 | P1-T4 |
| 构建器单测 | `__tests__/system-prompt-builder.test.ts` | 风格语义重写；terse/detailed 对比 | P1-T4 |
| 工具单测 | bridge guide 工具测试 | prompt_guide 命中/兜底 | P1-T1 |
| 调度集成 | `bridge-prompt-dispatcher.test.ts` | 风格设置传递；记忆设置不回归 | P1-T4 |
| 场景验收 | 手工（设计 §6 场景） | 双档对照行为 | P1-T5 |

**命令：**

```bash
pnpm --filter ./packages/agent-runtime test   # 注意既有失败基线，勿误判
pnpm --filter ./apps/windows test             # 39 个既有失败为基线（8 文件）
pnpm typecheck
```

**手工验证工具**：客户端内用 `system_prompt` 工具读回实际提示词；必要时导出到 `docs/temp/` 与 P0 基线对比。

---

## 5. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 快照日期/环境漂移 | 中 | 冻结系统时间；固定 cwd/osInfo 等入参 |
| 重构引入静默漂移 | 高 | 先快照后动手；每 Task 运行快照；迁移表内两处计划内升级逐条声明 |
| 移除 detail 改变 basic 档行为 | 中 | 决策 6 已接受；默认 detailed 且验收单列明 |
| terse 引导不可发现（模型不调 guide） | 中 | 引导句三段式模板；守卫测试保证 id 可见；P1-T5 场景断言驱动文案迭代 |
| guide 文档与段正文双处维护漂移 | 中 | 守卫测试（id 覆盖 + 引导句）；P2 评估把 guide 正文与 detailed 渲染共享常量 |
| 设置缓存失效遗漏 | 中 | 跟随 `memoryInjectionSettingsCache` 同款 IPC 通路；手测切换即时生效 |
| 与用户并行改动冲突 | 中 | 独立分支；每 Task 及时提交；提交不带 pathspec |

---

## 6. 验收标准

**P0 完成条件**

- [ ] 快照测试建成并提交（先于任何重构代码）
- [ ] 重构后快照零 diff
- [ ] `sectionStats` 覆盖全部渲染段，宿主日志可见
- [ ] 设置可存（localStorage）可读（主进程 IPC 缓存）
- [ ] 实验页只读段清单可见（无死开关）

**P1 完成条件**

- [ ] `prompt_guide` 注册并单测绿
- [ ] 首批 5 段 terse/detailed 双渲染单测绿
- [ ] `grep -rn "PromptDetail|promptDetail|resolvePromptDetail"` 无残留
- [ ] 详细档为零 diff 基线（例外仅迁移表 #7/#18 且已在提交信息声明）
- [ ] UI 开关切换后下一轮生效
- [ ] 场景 1/2/3 双档对照通过并归档记录

---

## 7. 不在本计划范围

- 按 Agent 级配置、模型族差异化引导（决策 2/6 已排除）
- 展开内容回流系统提示词（决策 5）
- A/B 自动分流（P2 评估）
- MCP 段、动态段排序重构、`PROMPT_SECTION_TAGS` 宿主观测通道扩展
- 技能正文加载机制、工具 schema 加载机制（沿用现状）
