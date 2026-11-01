# 原子 `reverse` + pipeline agent 节点 · P1 实施计划

> **设计**：[`../../design/逆向与复刻/2026-11-01-逆向复刻与流水线编排设计.md`](../../design/逆向与复刻/2026-11-01-逆向复刻与流水线编排设计.md) §4.2 / §4.3 / §5.2 / §8.2
> **状态**：已完成（P1）——总结见 [`2026-11-01-P1实施总结.md`](2026-11-01-P1实施总结.md)
> **范围**：`reverse` 原子 + `capability-router` + pipeline `agent` 节点 + 完整 `web-clone` spec。**安全域（红蓝）不在本期**（P4）。
> **前置**：P0 已完成（`clone` 原子、浏览器工具 14 个、eval 扁平化、播种时机修复）。

---

## 1. Goal

两条腿并行，互不依赖：

1. **`/reverse <目标>` 单独可用**：不给重建工程，只回答「它是怎么工作的」，产出 `analysis/`。
2. **流水线支持 agent 节点**：不可枚举的段落（看截图、写代码、循环对比）收进一个节点，但路径仍由 spec 写死。
3. **流水线只能在对话里跑**：删掉 UI/IPC 的执行入口，避免「流水线像另一个执行器」。

**可验证判据（五条，缺一不算完成）**：

1. `/reverse ./某二进制` 与 `/reverse https://某站` 都能单独跑出 `analysis/`，不必接 `clone`
2. 同一条 spec 连跑 3 次，**tool 节点**的步数与 `observed` 一致
3. 一次真实站点复刻全程跑通，产物能 `pnpm build`
4. 从对话里跑（Agent 调 `pipeline_run`）时 agent 节点正常；UI 上**没有任何**能直接执行流水线的按钮
5. 失败时 `failedAt` + `expected/observed` 能定位到具体步骤

---

## 2. 关键代码事实（撰写本计划时已核实）

| # | 事实 | 影响 |
|---|---|---|
| F1 | `orchestrator.spawnAgent(params, parentInstanceId)`，`SpawnAgentParams = {name, prompt, agentType?, mode?, model?, allowedTools?}`（`orchestrator.ts:64-78`） | **没有 `maxTurns` 参数**；用户已定「budget 粒度先这样」，本期不做 per-step 预算 |
| F2 | 未知 `agentType` 会**静默回落 `assistant`**（`orchestrator.ts:494-529`） | 流水线必须加载期硬校验，禁止回落 |
| F3 | `listAgentDefinitions()`（`main/agents-repo.ts`）同步返回全部定义，`isActive` 已由 `isEnabled` 映射（`agents-repo.ts:94`） | `knownAgents = defs.filter(isActive !== false).map(id)`；内置 id 含 `assistant` / `builtin:explore` / `builtin:plan` / `builtin:verify` / `code-dev` / `chronicler` / `info-curator` |
| F4 | `currentToolExecutorInstanceIdRef` 由真实实例的 `toolLifecycle` 在工具执行前后维护（`bridge-instance-factory.ts:899-903`）；流水线的合成 runner 不改它 | `runAgentStage` 用 `getCurrentToolExecutorInstanceId()` 拿父实例即可；`toolCallInstanceMap` 需要 toolCallId，而 executor 没有，**本期不接** |
| F5 | `validateAllowedTools` 只在 `allowedTools` 非空时校验，且要求是父实例工具的**子集**（`orchestrator.ts:390-418`） | 默认白名单要**从父实例工具里扣掉** `pipeline_run` / `spawn_agent`；不传则子 Agent 按自身定义拿全量（`assistant` 能再 spawn，**递归风险**） |
| F6 | `validateSpec(raw, knownTools)` 被 `store.listPipelines` / `store.readSpec` 与 4 处测试调用 | 第三参 `knownAgents` **必填**，所有调用点一起改 |
| F7 | UI 执行链：`PipelinePage` → `usePipelines.run` → preload `pipeline:run` → `ipc.ts` | 四处一起删；预填输入框已有现成通道 `mtbot:chat-draft-request`（`ChatPage.tsx:2154-2167`）+ `onViewChange('chat')` |
| F8 | P0 已把 `browser_eval` 扁平化 | 断言路径写 `{{step.result.field}}`，**不是**设计稿里的 `result.result` |
| F9 | 内置流水线已在 workspace getter 就绪后逐条播种（P0 修复） | 新增 spec 只加目录，老工作区也会收到 |
| F10 | `reverse-skill` 源材料**不在本仓库**（`E:/my-project/open-source/reverse-skill` 不存在） | Task 0 必须先取源或明确按设计提纲自写；**不许凭记忆编工具名** |

---

## 3. 设计决策（本期新增）

### D-P1-1 agent 节点结构（不引入预算字段）

```ts
type PipelineStep = ToolStep | AgentStep

interface BaseStep {
  readonly id: string
  readonly label?: string
  readonly narration?: string
  readonly holdMs: number
  readonly expect?: StepExpect
}

interface ToolStep extends BaseStep {
  readonly kind?: 'tool'          // 缺省 = tool，老 spec 零改动
  readonly tool: string
  readonly params?: Record<string, unknown>
}

interface AgentStep extends BaseStep {
  readonly kind: 'agent'
  readonly agentType?: string     // 缺省 assistant，但仍要过 knownAgents
  readonly prompt: string         // 自包含；子 Agent 看不到父对话
  readonly allowedTools?: readonly string[]
  readonly model?: string
  readonly rehearsal?: 'run' | 'skip'   // 缺省 skip
}
```

**不写 `maxTurns`**：`spawnAgent` 没有这个入参，加它要改 orchestrator 签名并透传到子实例。等实测确实需要按 step 收紧再谈。

### D-P1-2 加载期硬校验（不回落）

- `validateSpec(raw, knownTools, knownAgents)`，第三参**必填**
- `kind === 'agent'`：`prompt` 非空；**不允许同时写 `tool`**（歧义写法直接拒）；`agentType` 缺省按 `assistant` 校验
- `agentType` 不在 `knownAgents` → 拒，错误文案：`未知或未启用的 Agent "security"：请先在 Agents 页启用它`
- `refsIn(prompt)` 参与向后引用校验（与 params 同规则）
- 未知 `kind`（非 `tool`/`agent`）→ 拒

### D-P1-3 执行与 journal

- `RunnerDeps.runAgentStage?(opts) => Promise<{ok, data?, error?}>`；**可选**，但 `kind==='agent'` 而依赖缺失时该步**明确失败**，不静默跳过
- `data` 固定为 `{ output: string; agentDefinitionId: string; agentName: string }`，模板引用写成 `{{brief.output}}`
- `resolveParams(step.prompt, outputs)` 解析 `{{}}`；若整串是单个引用且解析出非字符串，`JSON.stringify`
- `JournalLine.kind?: 'tool' | 'agent'`，缺省 `'tool'`（老 journal 可读）
- rehearsal：`kind==='agent' && step.rehearsal !== 'run'` → `skipped:'rehearsal'`，`outputs.set(id, {})`

### D-P1-4 默认工具白名单

- spec 显式给 `allowedTools` → 原样传
- 未给 → 取父实例工具名，扣掉 `pipeline_run` / `spawn_agent`，传给 `spawnAgent`
- 父实例取不到（`currentToolExecutorInstanceIdRef` 为空）→ 该步失败并提示「无法解析发起流水线的 Agent 实例」，**不猜**

### D-P1-5 UI 去掉执行入口

- 删 `pipeline:run` IPC、preload `run`、`usePipelines.run`、`PipelinePage` 两个运行按钮与其结果区
- 换成「在对话里运行」：`onViewChange('chat')` + `window.dispatchEvent(new CustomEvent('mtbot:chat-draft-request', { detail: { text: '跑流水线 <id>' } }))`
- `pipeline:cancel` / `openDir` / `list` / `detail` 保留；进度/完成事件保留（由 Agent 跑的 run 同样会推）

### D-P1-6 `reverse` 的技能边界

- 本期覆盖：**前端/网页**（读 JS、找签名、运行时采样）+ **二进制 triage**（先判类型与保护，再决定要不要深入）
- `mobile.md` / `desktop.md`（APK/EXE 深挖）按设计放 **P2**，本期不写
- `reverse` 只产出 `analysis/`，**不建工程**；需要重建时交给 `clone`
- 产物落 `projects/<slug>/analysis/`；目标不是工程时落 `{workspace}/projects/_reverse/<slug>/analysis/`

### D-P1-7 占位符仍用 `__TARGET_URL__`

`expect` 不解析引用、spec 也无运行时变量（P0 已核实）。完整 `web-clone` spec 继续用占位符，**不**顺手做 `$input`——那是语义变更，单独排期。

---

## 4. 全局约束

- 不加新工具 / 新插件 / 新执行引擎；agent 节点只是把已有 `spawnAgent` 接进 runner
- agent 节点**不得**影响路由：不能决定「下一步跑不跑」，不能产出分支条件
- pipeline 包**不 import `main/**`**：`runAgentStage` / `knownAgents` 由 bridge 注入
- 加载期拒绝优于运行期失败；一次报全部错误
- 流水线内不允许递归触发流水线（默认白名单扣掉 `pipeline_run`）

---

## 5. File Map

### 新增

| 文件 | 内容 |
|---|---|
| `bundled-skills/逆向与复刻/reverse/SKILL.md` | 目标类型判定 → triage → static → dynamic → synthesis；首节「什么时候不该用它」 |
| `bundled-skills/逆向与复刻/reverse/references/frontend.md` | 前端签名定位、运行时采样、本地复现 |
| `bundled-skills/逆向与复刻/reverse/references/binary.md` | 二进制 triage 与工具选用判据（缺工具就报，不预置安装） |
| `bundled-skills/逆向与复刻/capability-router/SKILL.md` | 先路由后动手：属于哪个原子、要不要组合 |
| `bundled-pipelines/web-clone/spec.json` | 完整版：取证 tool 节点 + brief/build/report agent 节点 + build/样式断言 |
| `pipeline/agent-step.test.ts` 等 | 校验 / 执行 / 跳过 / journal 用例 |

### 修改

| 文件 | 改动 |
|---|---|
| `plugins/builtin/pipeline/types.ts` | 判别联合、`JournalLine.kind`、`RunnerDeps.runAgentStage` |
| `plugins/builtin/pipeline/spec.ts` | agent 分支校验；第三参必填 |
| `plugins/builtin/pipeline/store.ts` | `listPipelines` / `readSpec` 增加 `knownAgents` 参数 |
| `plugins/builtin/pipeline/runner.ts` | agent 分支、prompt 解析、rehearsal、journal kind |
| `plugins/builtin/pipeline/runtime.ts` | 注入 `knownAgents` / `runAgentStage`，透传给 store/runner |
| `plugins/builtin/pipeline/ipc.ts` | 删 `pipeline:run` |
| `preload/api/pipeline-api.ts` + `preload/index.ts` | 删 `run` |
| `plugins/builtin/pipeline/ui/usePipelines.ts` / `PipelinePage.tsx` / `renderer.tsx` | 去掉执行按钮，改为「在对话里运行」 |
| `main/agent-runtime/bridge.ts` | `createPipelineExecutor` 返回 `runAgentStage` / `knownAgents` |
| `apps/windows/bundled-pipelines/web-clone-evidence/spec.json` | 不动；保留为“只取证”的最小模板 |
| `pipeline/*.test.ts` / `ui/PipelinePage.test.tsx` | 适配第三参、删 run 用例、加新用例 |

---

## 6. Task 分解

### Task 0 — `reverse` + `capability-router` 技能包（无代码）

**前置**：源材料不在本仓库（F10）。先取 `reverse-skill` 仓库或文章原文；取不到就按设计 §5.2 的提纲自写，**但每条工具名必须在 Lumii 里真实存在**（写完后用 `grep` 对照 `bridge-*` 注册名）。

结构按技能包规范：frontmatter（name/description/metadata）、正文 <500 行、references 渐进加载、首节写「什么时候不该用它」。

**验证**：重启后技能列表出现 `逆向与复刻/reverse` 与 `逆向与复刻/capability-router`；`/reverse` 可触发。

---

### Task 1 — schema + 校验 `[TDD]`

**先写失败测试**（`spec.test.ts` 新增）：

| 用例 | 期望 |
|---|---|
| agent 节点缺 `prompt` | 拒 |
| agent 节点同时写 `tool` | 拒（歧义） |
| `agentType` 未知 | 拒，文案含 id 与「Agents 页」 |
| `agentType` 缺省且 `assistant` 在集合里 | 通过，规范化为 `assistant` |
| `knownAgents` 为空集 | 缺省 agent 节点被拒（证明缺省也校验） |
| `prompt` 前向引用 | 拒 |
| 未知 `kind` | 拒 |
| 老 tool spec（无 kind） | 仍通过 |

**实现**：types.ts 判别联合；spec.ts 分支；`validateSpec` 三参必填；store/runtime/所有测试调用点补 `knownAgents`。

**验证**：`npx vitest run src/plugins/builtin/pipeline`；`npx tsc --noEmit`。

---

### Task 2 — runner 执行分支 `[TDD]`

**先写失败测试**（`runner.test.ts`）：

| 用例 | 期望 |
|---|---|
| `kind:'agent'` | 调 `runAgentStage` 而不是 `callTool`；`data.output` 进入 `outputs` |
| prompt 含 `{{prev.result.x}}` | 传下去的是解析后的字符串 |
| 整串是 `{{brief.output}}` | 原样取字符串，不 JSON 包裹 |
| agent 依赖缺失 | 该步失败，错误可读 |
| rehearsal 缺省 | 记 `skipped:'rehearsal'`，不调 `runAgentStage` |
| `rehearsal:'run'` | 在 rehearsal 下真的执行 |
| journal | 有 `kind:'agent'`；tool 步仍是 `kind` 缺省 |
| 上游 agent 产出被下游 tool 引用 | `{{brief.output}}` 能取到 |

**实现**：主循环分支、prompt 解析、journal、rehearsal。

---

### Task 3 — service 透传 `[TDD]`

`PipelineServiceDeps` 加 `knownAgents: () => ReadonlySet<string>`、`runAgentStage?`；`listPipelines` / `readSpec` 调用补第三参。

测试：service 的 list/detail 在 agent spec 上不报错；缺 `knownAgents` 时 TypeScript 直接拒绝（编译期）。

---

### Task 4 — bridge 注入

`createPipelineExecutor()` 增加：

```ts
knownAgents: () => new Set(
  listAgentDefinitions().filter((d) => d.isActive !== false).map((d) => d.id),
),
runAgentStage: async ({ agentType, prompt, allowedTools, model, signal }) => { ... }
```

实现要点：
- 父实例：`this.currentToolExecutorInstanceIdRef.value`；空 → `{ok:false, error:'无法解析发起流水线的 Agent 实例'}`
- 默认白名单：父实例 `getTools().map(t => t.name)` 去掉 `pipeline_run` / `spawn_agent`
- `spawnAgent({ name: 'pipeline-<stepId>', prompt, agentType, model, allowedTools, mode:'sync' }, parentId)`
- 结果映射：`status:'ok' && mode:'sync'` → `{ok:true, data:{output, agentDefinitionId, agentName}}`；`aborted` / `error` → `{ok:false, error}`
- 不把 `signal` 传给 spawn（`SpawnAgentParams` 不支持中断）；取消靠 runner 的步间检查

**验证**：抽一个纯函数 `resolvePipelineAgentWhitelist(parentId)` 做单测（父实例缺失、扣减清单、显式白名单三例）；bridge 接线用真机验收守。

---

### Task 5 — 删除 UI 执行入口

- `ipc.ts` 删 `pipeline:run`；preload/api 删 `run`；`usePipelines` 删 `run`
- `PipelinePage`：删「彩排 / 录制运行」按钮与结果展示；加「在对话里运行」按钮
- `renderer.tsx` 的 `app.view` 组件接收 `onViewChange` 并传给页面

**测试**（`PipelinePage.test.tsx`）：断言没有运行按钮、有「在对话里运行」；点击后触发 `mtbot:chat-draft-request` 且 text 含 pipeline id。

---

### Task 6 — 完整 `web-clone` spec

按设计 §7.1 的形状，但**全部换成真实契约**：

- 取证 tool 节点：`browser_navigate` → 桌面截图 → `browser_set_device({name:'iPhone 14'})` → 移动截图 → 复位 `{width:1440,height:900}` → `browser_requests({})` → `browser_eval({script})`
- `brief` agent 节点：`agentType:'builtin:explore'`，引用 `{{shot-desktop.result.path}}`、`{{assets.result.requests}}`、`{{styles.result.h1}}`（扁平路径）
- `scaffold`：`bash` 跑 `create-next-app`（超时 300s）
- `build` agent 节点：`assistant`，先读 `docs/research/` 再建页；循环对比写在节点内部
- `check`：`bash` 跑 `pnpm build`，`expect: {exitCode: 0}`
- `verify-styles`：**跨步骤数值比对走 JS 内嵌**——把上游 `h1Size` 拼进脚本源码，返回布尔；`expect` 只比字面量（沿用 P0 D-P0-4）
- `report` agent 节点：写 README 与剩余差异

占位符：`__TARGET_URL__`、`__SLUG__`。

**测试**：`bundled-specs.test.ts` 加一条，用含 browser + bash 的 knownTools 与 knownAgents 校验新 spec。

---

### Task 7 — 真机验收

1. `/reverse https://www.python.org/` → `analysis/` 有结构、数据流、资源与结论
2. `/reverse E:\...\某.exe`（挑一个无害的小工具）→ 先 triage，缺工具要如实报
3. 改 `web-clone` 占位符后，在对话里让 Agent 调 `pipeline_run`（rehearsal）：
   - tool 步执行、agent 步按 `rehearsal:'skip'` 跳过
   - journal 的 `kind` 正确
4. 同一条 spec 连跑 3 次，比对 tool 步的 `observed`
5. 真实站点全程跑一次，`pnpm build` 通过
6. 确认 UI 无执行按钮；「在对话里运行」能预填

---

## 7. 风险

| 风险 | 缓解 |
|---|---|
| agent 节点导致流水线不可复现 | 路由仍由 spec 写死；agent 只产出数据。验收第 2 条只比对 **tool 节点** |
| 未知 agentType 静默回落 | 加载期硬校验 + 缺省也校验（D-P1-2） |
| 子 Agent 递归触发流水线 | 默认白名单扣掉 `pipeline_run` / `spawn_agent`；显式白名单由父实例工具集校验 |
| `spawnAgent` 并发排队拖慢流水线 | agent 节点默认 sync；失败/超时能定位。不新增队列 |
| 父实例解析不到 | 该步明确失败，不猜父级 |
| `create-next-app` 网络失败 | 验收记录失败原因；不改工具链（不做自动重试/镜像） |
| `reverse` 源材料缺失 | Task 0 先取源；取不到按提纲自写并标注来源 |
| UI 删入口后无法手动跑 | 设计如此：执行归属是 Agent。`openDir` 仍可查看历史 run |

---

## 8. 范围外（明确不做）

| 不做 | 理由 |
|---|---|
| `maxTurns` / 每步预算 | `spawnAgent` 无此参数；用户已定先不细化 |
| `$input` / 运行时变量 | 语义变更，需单独回归；继续占位符 |
| `mobile.md` / `desktop.md` | P2 |
| 并排对比视图 / `capability_export` | P2 |
| EXE/APP 复刻 | P3 |
| `redteam` / `blueteam` / `security` Agent | P4 |
| 截图相似度阈值 | 不把不确定性塞回执行器 |
| 自动安装逆向工具链 | 缺什么报什么 |

---

## 9. 收尾清单

- [x] agent 节点校验 8 条用例、runner 8 条用例全绿
- [x] `validateSpec` 第三参必填，所有调用点已改（含测试）
- [x] `pnpm --filter ./apps/windows test:all`（定向套件全绿；全量 9 失败均为既有，见总结）
- [x] `pnpm typecheck` 0 错误
- [x] `pnpm check:wiring` 新增 0
- [x] `/reverse` 两种目标各自单独跑通
- [x] 完整 `web-clone` 真机跑通且 `pnpm build` 通过（weflow.top，13/13 步）
- [x] UI 无执行入口；对话内可跑
- [x] 实施总结落 `docs/plans/逆向与复刻/2026-11-01-P1实施总结.md`
