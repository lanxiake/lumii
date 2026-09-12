# 死代码清理清单（批次 0）

> 核对时间：2026-09-12
> 核对提交：`f0cf09d105ae994880814eb36750225a367c103e`
> 上游文档：[Lumii 源码重构瘦身分析报告](./README.md)
> 复核方法：`grep` 全仓引用统计 + 编译配置交叉验证；标注 ✅ 的条目已逐条人工复核

本清单只覆盖**批次 0（清库）**。每删除一项前，须先跑 `pnpm typecheck`，删除后再跑 `pnpm typecheck` + `pnpm build`。

---

## A 级 · 确认可删（已验证零风险）

### A1. 嵌套脏拷贝目录（git 跟踪中）

| 路径 | 行数 | 证据 |
|---|---|---|
| `apps/windows/apps/windows/src/main/ipc/autonomous-ipc.ts` | 52 | 全仓唯一文件；与 `apps/windows/src/main/ipc/autonomous-ipc.ts` 内容不同，属误提交的脏拷贝 |
| `packages/agent-runtime/packages/agent-runtime/src/tools/built-in/bing-search-tool.ts` | 201 | 同上，与 `packages/agent-runtime/src/tools/built-in/bing-search-tool.ts` 重复 |

**验证命令**

```bash
git ls-files "apps/windows/apps/windows" "packages/agent-runtime/packages"
# 期望：两条均被跟踪；删除后此命令无输出
```

**风险**：无。路径不存在于任何 tsconfig / vite alias / package.json 的 include 配置中。

---

### A2. `main/stubs/` 4 个文件 + 对应死 alias

| 文件 | 行数 | 证据 |
|---|---|---|
| `apps/windows/src/main/stubs/infra-ports.ts` | 35 | 零 import ✅ |
| `apps/windows/src/main/stubs/logging-subsystem.ts` | 36 | 零 import ✅ |
| `apps/windows/src/main/stubs/process-exec.ts` | 19 | 零 import ✅ |
| `apps/windows/src/main/stubs/utils.ts` | 8 | 零 import ✅（其 `MTBOT_STATE_DIR` 全仓无写入点） |
| **小计** | **98** | |

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

| 文件 | 行数 | 引用数 | 复核 |
|---|---|---|---|
| `apps/windows/src/main/channel/html-report-template.ts` | 76 | 0 | ✅ 仅设计文档提及 |
| `apps/windows/src/main/cloud-sync/sync-v3-test.ts` | 123 | 0 | ✅ 自带 `console` 脚本，文件名非 `*.test.ts` 故不被 vitest 收集 |
| `packages/agent-runtime/src/wiki/wiki-batch-classifier.ts` | 261 | 0 | ✅ |
| `packages/agent-runtime/src/tools/built-in/execute-skill-tool.ts` | 63 | 仅自身 + `dist/*.d.ts` | ✅ 注释自述由 bridge 覆盖，实际无人注入 |
| `apps/windows/src/renderer/utils/formatCreditDescription.ts` | 38 | 仅自身 | ✅ 闭源版积分功能残留 |

---

### A4. CronPage 死组件

| 文件 | 行数 | 证据 | 复核 |
|---|---|---|---|
| `renderer/pages/CronPage/components/PipelinesTab/PipelinesTab.tsx` | 174 | 仅被自身 + `hooks/business/useCron/usePipelines.ts:5` 的**注释**提及；`CronPage.tsx` 不 import | ✅ |
| `renderer/pages/CronPage/components/ScheduleTab/ScheduleTab.tsx` | 104 | 同上，无任何外部引用 | ✅ |
| `.../shared/CreateJobModal/CronBuilder.tsx` | 206 | 同目录 `index.ts` 只 re-export `CreateJobModal`；`CreateJobModal.tsx` 只 import `schedule-helpers` 与 `NextRunPreview` | ✅ |
| `.../shared/CreateJobModal/DateTimePicker.tsx` | 74 | 同上，全仓无引用 | ✅ |
| `.../shared/CreateJobModal/IntervalPicker.tsx` | 72 | 同上，全仓无引用 | ✅ |
| `.../shared/CreateJobModal/SchedulePresets.tsx` | 31 | 同上，全仓无引用 | ✅ |
| **小计** | **661** | | |

**连带确认**（随 A4 一并处理，但**必须先确认再删**）：

| 文件 | 行数 | 证据 |
|---|---|---|
| `renderer/hooks/business/useCron/usePipelines.ts` | 47 | 文件注释自述"独立版：无网关，故列表恒为空、增删改查均 no-op，仅保留接口以兼容 PipelinesTab"。PipelinesTab 删除后该 hook 失去唯一存在理由 |
| `renderer/pages/CronPage/components/shared/CreatePipelineModal.tsx` | 173 | 仅被 `PipelinesTab.tsx:12,148` 引用（含 `CreatePipelineModal.module.css`） |

**执行期新发现的同簇文件**（原清单未列出，但因只被上述死代码引用而必须同删）：

| 文件 | 行数 | 唯一引用方 |
|---|---|---|
| `renderer/pages/CronPage/components/PipelinesTab/PipelineGraph.tsx` | 185 | `PipelinesTab.tsx:13` |
| `renderer/pages/CronPage/utils/pipeline-utils.ts` | 135 | `CreatePipelineModal.tsx:13`（仅 `hasCycle`；其余 5 个导出全仓零引用） |
| `renderer/pages/CronPage/components/PipelinesTab/PipelinesTab.module.css` | 169 | `PipelinesTab.tsx:9` |
| `renderer/pages/CronPage/components/ScheduleTab/ScheduleTab.module.css` | 84 | `ScheduleTab.tsx:9` |

**随之失效的类型定义**（已从 `useCron/types.ts` 与 `useCron/index.ts` 移除）：

| 符号 | 说明 |
|---|---|
| `Pipeline` / `PipelineEdge` | 仅被上述 Pipeline 死代码簇使用，删除后全仓零引用 |
| `CronViewTab` | 定义为 `'overview' \| 'schedule' \| 'pipelines' \| 'history'`，但全仓从未作为类型使用；引用已删的 schedule/pipelines 视图 |

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

| 符号 | 位置 | 证据 |
|---|---|---|
| `registerAgentRuntimeIPC` | `apps/windows/src/main/ipc/agent-runtime-ipc.ts:805` | 仅被 barrel `apps/windows/src/main/agent-runtime/index.ts:3` 再导出，无任何调用方 ✅ |

实际 IPC 注册走 `installAgentRuntimeCommandIpc`（`main/index.ts:872`）。

**连带删除**：`apps/windows/src/main/agent-runtime/index.ts:3` 的对应 re-export。

---

## B 级 · 需人工 / 产品确认后再删

### B1. `packages/agent-runtime/src/index.ts` barrel 裁剪

现状：**505 个导出中 267 个无外部 importer**，其中 78 个全仓从未被 import（如 `DEFAULT_FEATURE_FLAGS`、`buildClientSystemPrompt`、`sanitizeEnv`、`createMemoryDatabase`、`TICK_INTERVAL_MS`）。

**为什么不能直接删**：该包是 workspace 公共契约（`@mtbot/agent-runtime`），未来可能被 Linux 客户端等新消费方使用。详见 [Linux 客户端移植设计](../../design/Linux客户端移植/)。

**建议**：分两步 ——
1. 先标注 `@internal`，观察一个迭代周期
2. 确认无消费方后再删

**风险**：中。删除会破坏公共 API 表面，需同步 `packages/agent-runtime/package.json` 的 `exports` 字段。

---

### B2. 恒定默认值的 feature flag

| flag | 位置 | 现状 |
|---|---|---|
| `ENABLE_SKILL_ACTIVATION` | `packages/agent-runtime/src/config/feature-flags.ts:71` | 默认 `false` |
| `ENABLE_ASK_USER_QUESTION` | 同上 | 默认 `false` |
| `ENABLE_BUILTIN_SUB_AGENTS` | 同上 | 默认 `false` |
| `ENABLE_COORDINATOR_ENGINE` | 同上 | 默认 `false` |
| `ENABLE_PLAN_ONLY_MODE` | 同上 | 默认 `false` |

**证据链**：
- `createFeatureFlags()`（`feature-flags.ts:90`）以 `DEFAULT_FEATURE_FLAGS` 为基线
- 运行时唯一改写入口是 `bridge.setFeatureFlags()`（`bridge.ts:1694`），经 IPC `runtime:featureFlags:set`（`ipc/agent-runtime/runtime-commands.ts:22`）
- preload 暴露了 `setFeatureFlags`（`preload/api/agent-runtime-api.ts:21`），但 **renderer 中无任何调用方**

**结论**：`ENABLE_SKILL_ACTIVATION` 的 true 分支（`bridge-prompt-dispatcher.ts:291`）在当前构建中实际不可达。

**为什么不能直接删**：这是**产品决策**而非技术债 —— 五个 flag 代表未启用的 v12 功能（技能激活、AskUser、内置子 Agent、协调器引擎、Plan-Only 模式）。请确认：

- [ ] 这些功能是否计划在近期启用？
- [ ] 若不启用，是否连同对应 IPC / preload API 一并移除？

---

### B3. `api-ipc.ts` 中的桩 handler

| handler | 位置 | 现状 |
|---|---|---|
| `api:uploadSkillFile` | `main/ipc/api-ipc.ts:260` | 直接返回错误 |
| `api:getChatModels` | `main/ipc/api-ipc.ts:287` | 返回空 |
| `api:setChatModel` | `main/ipc/api-ipc.ts:294` | no-op |

preload 已在 `api-server-api.ts:38-47`、`api-server-http-api.ts:181-227`、`index.ts:668-736` 三处暴露，但 **renderer 中无调用方**。

**需确认**：是保留为外部 HTTP API 的兼容表面，还是随闭源版 API Server 能力一并移除？

---

### B4. 仅测试引用的 autonomous 模块

`packages/agent-runtime/src/autonomous/` 下 6 个模块（`conflict-detector` / `coordinated-scheduler` / `memory-evolution` / `pareto-frontier` / `skill-evolution` / `tool-evolution`）仅被测试引用，`autonomous-wiring.ts` 未接线，且 `autonomous.enabled` 默认关闭。

**需确认**：属预留能力还是闲置代码？（关联 [自主进化接线状态](../../design/自主进化Agent/)）

---

### B5. `segment-memory-service.ts` 灰度开关

灰度环境变量 `MTBOT_SEGMENT_MEMORY` 全仓无设置点，该服务恒为 no-op。

**需确认**：保留灰度能力还是移除？

---

## C 级 · 勿删（命名陷阱，避免误判）

| 路径 | 为什么不能删 |
|---|---|
| `apps/windows/src/main/coding-dev-backends-stub/` | **名字含 stub，实为真实实现**。被 6 处引用：`coding-dev-acp-run.ts:15-20`、`channel/acp-backend-manager.ts:14-19`、`weixin`/`feishu` channel adapter、`ipc/agent-runtime/coding-dev-commands.ts:8-9`、`slash-commands/{switch-backend,backend}.ts`、`main/index.ts:1312`（动态 import） |
| `apps/windows/src/main/stubs/qrcode-terminal.ts` | bare alias，被 `@tencent-connect/qqbot-connector` 间接依赖 |
| `apps/windows/src/renderer/stubs/util.ts` | `:309` 处为必需依赖 |
| `packages/agent-runtime/dist/` | 构建产物，`.d.ts` 会干扰引用统计，分析时需排除 |

> `coding-dev-backends-stub/` 内部有 9 个零用导出（`normalizeCodingDevBackendId`、`isImplementedCodingDevBackendId`、`ResolvedCodingDevBackend` 等，见 `contracts.ts`），属闭源 gateway 对齐预留 —— 可清，但**须先确认无动态引用**。

---

## D 级 · 重复实现（批次 2 处理，此处仅登记）

| 重复项 | 处数 | 位置 |
|---|---|---|
| `formatBytes` | 5 | `ScreenRecordPanel.tsx:63`、`useSystem.ts:163`、`PluginCard.tsx:16`、`StorageInfo.tsx:32`、`VoiceModelsPanel/index.tsx:14` |
| `truncate` | 4 | — |
| `sleep` / `delay` | 2 | — |
| `ensureDir` | 2 | — |
| `vendor/ports-inspect.ts` vs `browser-control/src/lib/ports-inspect.ts` | 2 | 111 行 vs 296 行 |
| `pcm-processor.js` vs `pcm-processor-source.ts` | 2 | 手工同步双份 |

---

## 执行检查清单

- [x] 删除前记录基线：`pnpm typecheck` 通过
- [x] A1 嵌套脏拷贝目录（2 文件）
- [x] A2 `main/stubs/` 4 文件 + `electron.vite.config.ts` 死 alias 4 条
- [x] A3 零引用源文件 5 个
- [x] A4 CronPage 死组件簇（10 文件 + 3 个失效类型定义）
- [x] A5 `registerAgentRuntimeIPC` 死导出
- [x] 全量验证：`pnpm typecheck` ✅ + `pnpm build` ✅ + agent-runtime 1832 用例 ✅ + apps/windows 无新增失败 ✅
- [ ] B 级各项逐个确认后再动

## 实际执行结果（2026-09-12）

| 项 | 文件数 | 删除行数 |
|---|---|---|
| A1 嵌套脏拷贝 | 2 | 253 |
| A2 stubs + 死 alias 配置 | 4 文件 + 1 配置 | 98 + 6 = 104 |
| A3 零引用源文件 | 5 | 561 |
| A4 CronPage 死组件簇 | 13 | 1640 |
| A4 失效类型定义 | — | 27 |
| A5 死导出 | — | 29 |
| **合计** | **24 文件 + 6 处配置/类型** | **2614** |

> 净变化：`24 个文件删除 + 5 个文件修改`，`-2592 行`（含修改文件中的少量新增行）。A4 因执行期发现额外同簇文件（`PipelineGraph.tsx`、`pipeline-utils.ts`、两个 `.module.css`）而大于原计划，详见 A4 章节。

**验证结论**：`pnpm build` 通过；`@mtbot/agent-runtime` 1832 个用例全绿；`lumii-windows` 的 39 个失败用例经 stash 对照证明为**既有失败**（见 [README 执行记录](./README.md#七执行记录)）。

## 预期收益

| 项 | 文件数 | 行数 |
|---|---|---|
| A1 嵌套脏拷贝 | 2 | 253 |
| A2 `main/stubs/` + 死 alias | 4 | 98 |
| A3 零引用源文件 | 5 | 561 |
| A4 CronPage 死组件 | 6 | 661 |
| A5 死导出 | 0 | ~10 |
| **A 级合计** | **17** | **~1,583** |
| A4 连带项（`usePipelines.ts` + `CreatePipelineModal.tsx` + `.module.css`） | 3 | 406 |
| **合计（含连带）** | **20** | **~1,989** |

> - B 级（barrel 裁剪 + feature flag 相关分支）若全部执行，预期再减 1,000–3,000 行，取决于产品决策。
> - A3 的 `execute-skill-tool.ts` 与 `formatCreditDescription.ts` 删除后，需同步清理 `packages/agent-runtime/dist/` 中的陈旧产物。
