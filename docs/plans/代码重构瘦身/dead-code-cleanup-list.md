# 死代码清理清单（批次 0）

> 核对时间：2026-09-12
> 核对提交：`f0cf09d105ae994880814eb36750225a367c103e`
> 上游文档：[Lumii 源码重构瘦身分析报告](./README.md)
> 复核方法：`grep` 全仓引用统计 + 编译配置交叉验证；标注 ✅ 的条目已逐条人工复核

本清单只覆盖**批次 0（清库）**。每删除一项前，须先跑 `pnpm typecheck`，删除后再跑 `pnpm typecheck` + `pnpm build`。

---

## A 级 · 确认可删（已验证零风险）

### A1. 嵌套脏拷贝目录（git 跟踪中）


| 路径                                                                                     | 行数  | 证据                                                                      |
| -------------------------------------------------------------------------------------- | --- | ----------------------------------------------------------------------- |
| `apps/windows/apps/windows/src/main/ipc/autonomous-ipc.ts`                             | 52  | 全仓唯一文件；与 `apps/windows/src/main/ipc/autonomous-ipc.ts` 内容不同，属误提交的脏拷贝    |
| `packages/agent-runtime/packages/agent-runtime/src/tools/built-in/bing-search-tool.ts` | 201 | 同上，与 `packages/agent-runtime/src/tools/built-in/bing-search-tool.ts` 重复 |


**验证命令**

```bash
git ls-files "apps/windows/apps/windows" "packages/agent-runtime/packages"
# 期望：两条均被跟踪；删除后此命令无输出
```

**风险**：无。路径不存在于任何 tsconfig / vite alias / package.json 的 include 配置中。

---



### A2. `main/stubs/` 4 个文件 + 对应死 alias


| 文件                                                 | 行数     | 证据                                     |
| -------------------------------------------------- | ------ | -------------------------------------- |
| `apps/windows/src/main/stubs/infra-ports.ts`       | 35     | 零 import ✅                             |
| `apps/windows/src/main/stubs/logging-subsystem.ts` | 36     | 零 import ✅                             |
| `apps/windows/src/main/stubs/process-exec.ts`      | 19     | 零 import ✅                             |
| `apps/windows/src/main/stubs/utils.ts`             | 8      | 零 import ✅（其 `MTBOT_STATE_DIR` 全仓无写入点） |
| **小计**                                             | **98** |                                        |


**连带删除**：`apps/windows/electron.vite.config.ts:258-261` 的 4 条 alias。

```ts
// 这 4 条的 key 是绝对路径（resolve(ROOT, 'src/logging/subsystem.js')），
// 而 Vite/Rollup 的 alias 匹配的是 import 说明符，全仓无任何说明符以该绝对路径开头 → 永不命中
[resolve(ROOT, 'src/logging/subsystem.js')]: resolve(__dirname, 'src/main/stubs/logging-subsystem.ts'),
[resolve(ROOT, 'src/infra/ports.js')]:      resolve(__dirname, 'src/main/stubs/infra-ports.ts'),
[resolve(ROOT, 'src/utils.js')]:            resolve(__dirname, 'src/main/stubs/utils.ts'),
[resolve(ROOT, 'src/process/exec.js')]:     resolve(__dirname, 'src/main/stubs/process-exec.ts'),
```

**功能替代**（均已由真实实现覆盖且在使用中）：

- `packages/browser-control/src/lib/ports.ts`
- `packages/browser-control/src/lib/exec.ts`
- `packages/browser-control/src/logging/subsystem.ts`
- `packages/browser-control/src/lib/config-dir.ts`

**风险**：低。删除后必须跑 `pnpm build` 验证（alias 死配置不影响构建，但需确认无动态解析路径命中）。

---



### A3. 零引用源文件


| 文件                                                                | 行数  | 引用数                 | 复核                                               |
| ----------------------------------------------------------------- | --- | ------------------- | ------------------------------------------------ |
| `apps/windows/src/main/channel/html-report-template.ts`           | 76  | 0                   | ✅ 仅设计文档提及                                        |
| `apps/windows/src/main/cloud-sync/sync-v3-test.ts`                | 123 | 0                   | ✅ 自带 `console` 脚本，文件名非 `*.test.ts` 故不被 vitest 收集 |
| `packages/agent-runtime/src/wiki/wiki-batch-classifier.ts`        | 261 | 0                   | ✅                                                |
| `packages/agent-runtime/src/tools/built-in/execute-skill-tool.ts` | 63  | 仅自身 + `dist/*.d.ts` | ✅ 注释自述由 bridge 覆盖，实际无人注入                         |
| `apps/windows/src/renderer/utils/formatCreditDescription.ts`      | 38  | 仅自身                 | ✅ 闭源版积分功能残留                                      |


---



### A4. CronPage 死组件


| 文件                                                                 | 行数      | 证据                                                                                                              | 复核  |
| ------------------------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------- | --- |
| `renderer/pages/CronPage/components/PipelinesTab/PipelinesTab.tsx` | 174     | 仅被自身 + `hooks/business/useCron/usePipelines.ts:5` 的**注释**提及；`CronPage.tsx` 不 import                             | ✅   |
| `renderer/pages/CronPage/components/ScheduleTab/ScheduleTab.tsx`   | 104     | 同上，无任何外部引用                                                                                                      | ✅   |
| `.../shared/CreateJobModal/CronBuilder.tsx`                        | 206     | 同目录 `index.ts` 只 re-export `CreateJobModal`；`CreateJobModal.tsx` 只 import `schedule-helpers` 与 `NextRunPreview` | ✅   |
| `.../shared/CreateJobModal/DateTimePicker.tsx`                     | 74      | 同上，全仓无引用                                                                                                        | ✅   |
| `.../shared/CreateJobModal/IntervalPicker.tsx`                     | 72      | 同上，全仓无引用                                                                                                        | ✅   |
| `.../shared/CreateJobModal/SchedulePresets.tsx`                    | 31      | 同上，全仓无引用                                                                                                        | ✅   |
| **小计**                                                             | **661** |                                                                                                                 |     |


**连带确认**（随 A4 一并处理，但**必须先确认再删**）：


| 文件                                                                  | 行数  | 证据                                                                                       |
| ------------------------------------------------------------------- | --- | ---------------------------------------------------------------------------------------- |
| `renderer/hooks/business/useCron/usePipelines.ts`                   | 47  | 文件注释自述"独立版：无网关，故列表恒为空、增删改查均 no-op，仅保留接口以兼容 PipelinesTab"。PipelinesTab 删除后该 hook 失去唯一存在理由 |
| `renderer/pages/CronPage/components/shared/CreatePipelineModal.tsx` | 173 | 仅被 `PipelinesTab.tsx:12,148` 引用（含 `CreatePipelineModal.module.css`）                      |


**执行期新发现的同簇文件**（原清单未列出，但因只被上述死代码引用而必须同删）：


| 文件                                                                        | 行数  | 唯一引用方                                                    |
| ------------------------------------------------------------------------- | --- | -------------------------------------------------------- |
| `renderer/pages/CronPage/components/PipelinesTab/PipelineGraph.tsx`       | 185 | `PipelinesTab.tsx:13`                                    |
| `renderer/pages/CronPage/utils/pipeline-utils.ts`                         | 135 | `CreatePipelineModal.tsx:13`（仅 `hasCycle`；其余 5 个导出全仓零引用） |
| `renderer/pages/CronPage/components/PipelinesTab/PipelinesTab.module.css` | 169 | `PipelinesTab.tsx:9`                                     |
| `renderer/pages/CronPage/components/ScheduleTab/ScheduleTab.module.css`   | 84  | `ScheduleTab.tsx:9`                                      |


**随之失效的类型定义**（已从 `useCron/types.ts` 与 `useCron/index.ts` 移除）：


| 符号                          | 说明                            |
| --------------------------- | ----------------------------- |
| `Pipeline` / `PipelineEdge` | 仅被上述 Pipeline 死代码簇使用，删除后全仓零引用 |
| `CronViewTab`               | 定义为 `'overview'               |


> ⚠️ **不要删除** `shared/CreateJobModal/CreateJobModal.tsx` 及其 `schedule-helpers.ts` / `NextRunPreview.tsx` —— 它们被 `CronPage.tsx` 正常使用。

**验证命令**

```bash
grep -rn "PipelinesTab\|ScheduleTab\|CronBuilder\|DateTimePicker\|IntervalPicker\|SchedulePresets" \
  --include=*.ts --include=*.tsx apps/windows/src \
  | grep -v "CronPage/components/"
# 期望：无输出
```

---



### A5. 死导出


| 符号                        | 位置                                                   | 证据                                                                      |
| ------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `registerAgentRuntimeIPC` | `apps/windows/src/main/ipc/agent-runtime-ipc.ts:805` | 仅被 barrel `apps/windows/src/main/agent-runtime/index.ts:3` 再导出，无任何调用方 ✅ |


实际 IPC 注册走 `installAgentRuntimeCommandIpc`（`main/index.ts:872`）。

**连带删除**：`apps/windows/src/main/agent-runtime/index.ts:3` 的对应 re-export。

---



## B 级 · 需人工 / 产品确认后再删

> 本节于 2026-09-12 重新核对。**原分析有三处结论有误，已在下方标注更正**——B 级项目涉及功能取舍，误判代价高，逐条复核是必要的。

### B1. `packages/agent-runtime/src/index.ts` barrel 裁剪 —— 本轮不动

现状：约 505 个导出中约 53% 无外部 importer（抽样 20 个验证量级属实）。

该包是 workspace 公共契约（`package.json` 的 `exports` 指向它，MIT 许可，计划中的 Linux 客户端会复用），属**公共 API 而非内部聚合**。

**决策（用户确认）**：本轮不动。若将来要裁剪，先标 `@internal` 观察一个迭代周期，确认无消费方后再删；删除需同步 `package.json` 的 `exports` 字段。

---

### B2. feature flag —— 已执行

**更正**：原分析称"5 个 flag 的 true 分支不可达"。实际复核发现更强的结论——**其中 4 个 flag 从来没有被读过**（除定义处外零引用）：

| flag | 真实状态 | 处置 |
| --- | --- | --- |
| `ENABLE_ASK_USER_QUESTION` | 零引用。AskUserModal 早已无条件生效，flag 是死声明 | ✅ 已删 |
| `ENABLE_BUILTIN_SUB_AGENTS` | 零引用。Explore/Plan/Verify 子 Agent 早已默认可用 | ✅ 已删 |
| `ENABLE_COORDINATOR_ENGINE` | 零引用。无任何实现，置 true 无效果 | ✅ 已删 |
| `ENABLE_PLAN_ONLY_MODE` | 零引用。无实现（相关死 UI 见 B6） | ✅ 已删 |
| `ENABLE_SKILL_ACTIVATION` | **唯一有实现的**：门控技能自动激活（`activation-resolver.ts` 297 行，逻辑完整） | ⏸ 保留（用户决策） |

删除位置：`packages/agent-runtime/src/config/feature-flags.ts` 的接口定义与 `DEFAULT_FEATURE_FLAGS`。

---

### B3. `api-ipc.ts` 中的桩 handler —— 已执行

**更正**：同文件中 `api:getConfigModels` **不是桩**（它真实读取 `getModelMapping()`），不在删除范围。

删除的三个桩：

| handler | 现状 | 连带删除 |
| --- | --- | --- |
| `api:uploadSkillFile` | 直接返回错误 | `preload/api/api-server-api.ts`、`preload/api/api-server-http-api.ts`、`preload/index.ts` 的类型声明 |
| `api:getChatModels` | 返回空 | 同上 |
| `api:setChatModel` | no-op | 同上 |

**验证依据**：renderer 的 `model-config-service.ts` 中 `fetchChatModelChoices()` / `saveChatModel()` 直接读写本地 provider 配置，**完全绕过这三个 IPC**，确认不可达。

> 遗留观察：`api:getConfigModels` 与 `api:getUserSkills` 虽零 renderer 调用，但都是真实实现（非桩），本轮保留。

---

### B4. autonomous 6 模块 —— **原结论完全错误，必须保留**

**更正**：原分析列这 6 个模块（`conflict-detector` / `coordinated-scheduler` / `memory-evolution` / `pareto-frontier` / `skill-evolution` / `tool-evolution`）为"仅测试引用，待确认"。深查后结论是 **全部必须保留**：

- **这是路线图代码，不是废弃代码**。`docs/plans/AGENT自我进化/README.md:249` 写明"P0/P1 已完成，**P2 代码已落地待接线**，P3 设计阶段"；P3 计划开篇写"多层协同优化的算法部分已经在 P2 写完了，真正缺的是把它接进运行时"，主线 A 标注**必做**。
- **测试是认真的**：6 个单测共 145 个 `it`、245 个 `expect`，覆盖边界（NaN、单调性、归一化）；`p2-e2e.test.ts` 761 行含 8 个端到端场景（重启恢复、隐私脱敏、性能 p95 门槛）。
- 删除等于删掉 P3 的实施对象。

---

### B5. `segment-memory-service.ts` —— **原结论完全错误，必须保留**

**更正**：原分析称"灰度环境变量 `MTBOT_SEGMENT_MEMORY` 全仓无设置点，该服务恒为 no-op"。实际代码是：

```ts
// apps/windows/src/main/agent-runtime/segment-memory-service.ts:51
enabled = MTBOT_SEGMENT_MEMORY !== '0'   // 默认开启，只有显式设为 '0' 才关闭
```

它是**默认开启且已完整接线**的活跃功能：`bridge.ts:690` 构造、`user-commands.ts:183` observe、`bridge.ts:2205` flush、退出 flush、宫殿归档，并有 `segment-memory-pipeline.test.ts` 等测试。**绝不能删**。

---

### B6. Plan-Only / Gateway 审批死 UI —— 已执行

`ChatPage` / `ChatContainer` 中两张恒不显示的卡片（均由 `EMPTY_*` 常量驱动，注释自述"始终为空"）：

| 删除项 | 说明 |
| --- | --- |
| `components/PlanApprovalCard/` | 计划审批卡片 |
| `components/ApprovalCard/` | Gateway 工具审批卡片 |
| `types/plan-approval.ts`、`types/exec-approvals.ts` | 上述卡片独占的类型 |
| `test/components/ApprovalCard.test.tsx` | 死 UI 的测试 |
| `EMPTY_APPROVAL_ITEMS` / `EMPTY_PLAN_APPROVAL_ITEMS` / `EMPTY_RESOLVING_IDS` + 3 个空 handler | ChatPage 侧的配套占位 |

**文档同步**：`README.md` 原宣传"审批流（`ApprovalCard`）"与"计划审批（`PlanApprovalCard`）"，均为失实。已改写为真实的 `ConfirmationDialog` 权限确认流程（仅本次允许 / 总是允许 24h / 拒绝 / 超时自动拒绝）。

> 保留观察：`workflowItems` 同样是恒空占位（`EMPTY_WORKFLOW_ITEMS`），但属另一套 Gateway 工作流概念，本轮未动。

---

### B7. 其他零散死代码 —— 已执行

| 删除项 | 证据 |
| --- | --- |
| `WeixinCodingDevPanel.tsx` | 零引用，与 `CodingDevAcpPanel.tsx` 功能重复 |
| `coding-dev-backends-stub/contracts.ts` 的 6 个导出 | `normalizeCodingDevBackendId`、`ResolvedCodingDevBackend`、`BackendSelectionSource`、`CodingDevLightweightBackendAdapter`、`CodingDevLightweightBackendInput`、`isLightweightCodingDevBackendId` —— 均零外部引用 |
| `tool-evolution-engine.ts` 的 `checkAndTriggerIfNeeded` | `@deprecated` 空实现，仅测试引用（含对应测试用例一并删除） |

> **更正**：原分析称 contracts.ts 有"9 个零用导出"，实际 `isImplementedCodingDevBackendId` **正在被 `switch-backend.ts` 使用**。真零用是 6 个。
>
> 另注：`ImplementedCodingDevBackendId`、`IMPLEMENTED_CODING_DEV_BACKEND_IDS`、`CodingDevToolProgressPhase` 虽零外部引用，但被**保留的**类型依赖，**不可独立删**。

---

### B8. browser-control 旧层 —— 部分执行

| 项 | 处置 | 依据 |
| --- | --- | --- |
| `client-actions.ts`（4 行门面） | ✅ 已删 | 零 importer |
| `client-actions-observe.ts`（200 行） | ✅ 已删 | 仅被上述门面引用 |
| `client-actions-state.ts`（295 行） | ✅ 已删 | 仅被上述门面引用 |
| `profiles.ts`（114 行） | ⏸ 保留并标注 `@roadmap` | 零引用，但函数在全仓**无替代实现**，属多 profile 功能的半成品 |

**确认被取代的依据**：已接线的 `pw-ai.ts` 暴露了完全相同的能力——`cookiesGetViaPlaywright`、`storageSetViaPlaywright`、`setOfflineViaPlaywright`、`getConsoleMessagesViaPlaywright`、`pdfViaPlaywright`、`traceStartViaPlaywright` 等。被删的两个文件是这层的旧包装。

> `client-actions-types.ts` 与 `client-actions-core.ts` **必须保留**：前者被 keep 的 core 引用，后者被 `agent.act.ts` 与 `pw-tools-core.interactions.ts` 直接引用。

---

## C 级 · 勿删（命名陷阱，避免误判）


| 路径                                                | 为什么不能删                                                                                                                                                                                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/windows/src/main/coding-dev-backends-stub/` | **名字含 stub，实为真实实现**。被 6 处引用：`coding-dev-acp-run.ts:15-20`、`channel/acp-backend-manager.ts:14-19`、`weixin`/`feishu` channel adapter、`ipc/agent-runtime/coding-dev-commands.ts:8-9`、`slash-commands/{switch-backend,backend}.ts`、`main/index.ts:1312`（动态 import） |
| `apps/windows/src/main/stubs/qrcode-terminal.ts`  | bare alias，被 `@tencent-connect/qqbot-connector` 间接依赖                                                                                                                                                                                                           |
| `apps/windows/src/renderer/stubs/util.ts`         | `:309` 处为必需依赖                                                                                                                                                                                                                                                  |
| `packages/agent-runtime/dist/`                    | 构建产物，`.d.ts` 会干扰引用统计，分析时需排除                                                                                                                                                                                                                                    |


> `coding-dev-backends-stub/` 确为**真实实现**，目录名误导。其中 6 个零用导出已于 B7 清理，但 `isImplementedCodingDevBackendId` 等仍在使用，详见 [B7](#b7-其他零散死代码--已执行)。

---



## D 级 · 重复实现（批次 2 处理，此处仅登记）


| 重复项                                                                     | 处数     | 位置                                                                                                                     |
| ----------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `formatBytes`                                                           | 5 | `ScreenRecordPanel.tsx:63`、`useSystem.ts:163`、`PluginCard.tsx:16`、`StorageInfo.tsx:32`、`VoiceModelsPanel/index.tsx:14` |
| `truncate`                                                              | 4      | —                                                                                                                      |
| `sleep` / `delay`                                                       | 2      | —                                                                                                                      |
| `ensureDir`                                                             | 2      | —                                                                                                                      |
| `vendor/ports-inspect.ts` vs `browser-control/src/lib/ports-inspect.ts` | 2      | 111 行 vs 296 行                                                                                                         |
| `pcm-processor.js` vs `pcm-processor-source.ts`                         | 2      | 手工同步双份                                                                                                                 |


---



## 执行检查清单

- [x] 删除前记录基线：`pnpm typecheck` 通过
- [x] A1 嵌套脏拷贝目录（2 文件）
- [x] A2 `main/stubs/` 4 文件 + `electron.vite.config.ts` 死 alias 4 条
- [x] A3 零引用源文件 5 个
- [x] A4 CronPage 死组件簇（13 文件 + 3 个失效类型定义）
- [x] A5 `registerAgentRuntimeIPC` 死导出
- [x] A 级全量验证：`pnpm typecheck` ✅ + `pnpm build` ✅ + agent-runtime 1832 用例 ✅ + apps/windows 无新增失败 ✅
- [x] B2 4 个死 feature flag（保留 `ENABLE_SKILL_ACTIVATION`）
- [x] B3 `api-ipc.ts` 三个桩 handler + preload 三处
- [x] B6 PlanApproval / Approval 死 UI + 修 README
- [x] B7 WeixinCodingDevPanel、contracts 6 导出、`checkAndTriggerIfNeeded`
- [x] B8 browser-control 旧 client-actions 层（`profiles.ts` 保留并标 `@roadmap`）
- [x] B1 barrel 裁剪 —— 用户决策本轮不动
- [x] B4/B5 —— 复核后判定**必须保留**，不动
- [x] B 级全量验证：`pnpm typecheck` ✅ + `pnpm build` ✅ + agent-runtime 1832 用例 ✅ + apps/windows 39 个失败与基线逐一吻合 ✅



## 实际执行结果（2026-09-12）


| 项                     | 文件数                  | 删除行数         |
| --------------------- | -------------------- | ------------ |
| A1 嵌套脏拷贝              | 2                    | 253          |
| A2 stubs + 死 alias 配置 | 4 文件 + 1 配置          | 98 + 6 = 104 |
| A3 零引用源文件             | 5                    | 561          |
| A4 CronPage 死组件簇      | 13                   | 1640         |
| A4 失效类型定义             | —                    | 27           |
| A5 死导出                | —                    | 29           |
| **合计**                | **24 文件 + 6 处配置/类型** | **2614**     |


> 净变化：`24 个文件删除 + 5 个文件修改`，`-2592 行`（含修改文件中的少量新增行）。A4 因执行期发现额外同簇文件（`PipelineGraph.tsx`、`pipeline-utils.ts`、两个 `.module.css`）而大于原计划，详见 A4 章节。

**验证结论**：`pnpm build` 通过；`@mtbot/agent-runtime` 1832 个用例全绿；`lumii-windows` 的 39 个失败用例经 stash 对照证明为**既有失败**（见 [README 执行记录](./README.md#七执行记录)）。

## 预期收益


| 项                                                                     | 文件数    | 行数         |
| --------------------------------------------------------------------- | ------ | ---------- |
| A1 嵌套脏拷贝                                                              | 2      | 253        |
| A2 `main/stubs/` + 死 alias                                            | 4      | 98         |
| A3 零引用源文件                                                             | 5      | 561        |
| A4 CronPage 死组件                                                       | 6      | 661        |
| A5 死导出                                                                | 0      | ~10        |
| **A 级合计**                                                             | **17** | **~1,583** |
| A4 连带项（`usePipelines.ts` + `CreatePipelineModal.tsx` + `.module.css`） | 3      | 406        |
| **合计（含连带）**                                                           | **20** | **~1,989** |


> - B 级执行后的净收益见下方"B 级实际执行结果"。
> - A3 的 `execute-skill-tool.ts` 与 `formatCreditDescription.ts` 删除后，需同步清理 `packages/agent-runtime/dist/` 中的陈旧产物。

---

## B 级实际执行结果（2026-09-12）


| 项                       | 删除内容                                                                                              | 备注               |
| ----------------------- | ------------------------------------------------------------------------------------------------- | ---------------- |
| B2 死 feature flag        | 4 个 flag 的定义与默认值                                                                                   | 保留 `ENABLE_SKILL_ACTIVATION` |
| B3 api-ipc 桩             | 3 个 handler + preload 3 文件各 1~2 处                                                                 | `getConfigModels` 非桩，保留 |
| B6 Plan/Gateway 审批死 UI  | 2 个组件目录 + 2 个类型文件 + 1 个测试 + ChatPage/ChatContainer 占位与空 handler                                          | 同步修 README        |
| B7 零散死代码                | `WeixinCodingDevPanel.tsx`、contracts 6 个导出、`checkAndTriggerIfNeeded` + 对应测试                            |                  |
| B8 browser-control 旧层   | `client-actions.ts`、`client-actions-observe.ts`、`client-actions-state.ts`                          | `profiles.ts` 保留并标 `@roadmap` |

**B 级验证结论**：`pnpm typecheck` ✅；`pnpm build` ✅（App bundle 6406 kB → 6389 kB）；`@mtbot/agent-runtime` 1832 用例全绿；`lumii-windows` 的 39 个失败用例与基线**逐一吻合**（文件名、用例名、数量完全一致），无新增失败。

### 复核中被推翻的三处原结论（重要）

| 原结论 | 实际情况 |
| --- | --- |
| B4 autonomous 6 模块"仅测试引用，可考虑删" | **必须保留**：P2 已交付（145 个 it / 245 断言的真测试），P3 计划主线 A 标 **必做**，删除等于删掉 P3 的实施对象 |
| B5 `segment-memory-service` 恒为 no-op | **默认开启的活跃功能**（`MTBOT_SEGMENT_MEMORY !== '0'`），已完整接线，绝不能删 |
| B7 contracts.ts 有 9 个零用导出 | 实为 6 个；`isImplementedCodingDevBackendId` 正在使用 |

> 教训：B 级项目涉及"功能取舍"而非"技术债"，**必须逐个读代码复核**，不能依赖仅看引用次数的自动化判断。

### 执行期新发现（未处理，留给后续）

1. **`docs/standards/feature-development-standards.md` 严重过期** —— 其"主进程目录结构"一节的 8 个示例文件中 5 个已不存在（`gateway-client.ts`、`node-connection.ts`、`api-client.ts`、`device-pairing-service.ts`、`node-mode-coordinator.ts`），`exec-approvals-manager.ts` 同样不存在。属 Gateway 时代文档残留，建议并入批次 1 清理。
2. **`workflowItems` 同为恒空占位**（`EMPTY_WORKFLOW_ITEMS`）—— 属第三套 Gateway 概念，本轮未动，待确认后处理。
3. **`api:getConfigModels` / `api:getUserSkills` 零 renderer 调用** —— 但两者都是真实实现（非桩），保留待确认。


