# Lumii 源码重构瘦身分析报告

> 核对时间：2026-09-12
> 核对分支：`main`
> 核对提交：`f0cf09d105ae994880814eb36750225a367c103e`
> 统计范围：`apps/windows` + `packages/*` 下所有 `.ts` / `.tsx`
> 行数口径：**含空行与注释**（与 [`../大文件重构分析处理/README.md`](../大文件重构分析处理/README.md) 的"排除纯空行"口径不同，两者数值不可直接比较）
> 关联文档：[死代码清理清单](./dead-code-cleanup-list.md)、[大文件重构分析处理](../大文件重构分析处理/README.md)、[Gateway 遗留代码分析](../gateway遗留代码处理/gateway-legacy-code-analysis.md)

---

## 一、总体统计

| 指标 | 数值 |
|---|---|
| 生产代码（排除 `*.test.*` / `*.d.ts`） | **1181 文件 / 233,546 行** |
| 全量（含测试） | 1742 文件 / 297,554 行 |
| 单文件 >1500 行 | **8 个** |
| 单文件 800–1500 行 | **25 个** |
| 单文件 400–800 行 | 105 个 |
| 测试文件 | 392（apps/windows 200、agent-runtime 183、pet-core 9、**browser-control 0**） |
| ESLint / Prettier / CI | **全无**（`.githooks/pre-commit` 内容为 `exit 0`，根 `prepare` 为 `echo skip githooks`） |

---

## 二、核心结论：上一轮重构已部分失效

[`大文件重构分析处理`](../大文件重构分析处理/README.md)（2026-08-21）的方案本身是合理的，但**执行后缺少门禁，文件重新膨胀**：

| 文件 | 2026-08-21 | 2026-09-12 | 变化 |
|---|---|---|---|
| `apps/windows/src/main/agent-runtime/bridge.ts` | 1483 行 | **2717 行** | +83% |
| `apps/windows/src/shared/agent-runtime-commands.ts` | 1087 行 | **2358 行** | +117% |
| `apps/windows/src/main/index.ts` | 2980 行 | 1670 行 | -44%（拆分生效） |

同一份计划里，"保留 facade、暂不重复拆已有职责"的文件在 3 周内翻倍；已实际拆分的文件则明显下降。

**结论：拆分方案不是瓶颈，"拆完没有东西阻止它长回去"才是。** 因此本方案的批次顺序不可颠倒 —— 先清库、再立门禁、后抽象、最后拆大文件。

---

## 三、问题清单（六类，按修复成本排序）

### 3.1 脏数据与死代码（可直接删，零行为变更）

| 项 | 证据 | 状态 |
|---|---|---|
| 嵌套脏拷贝目录（**已被 git 跟踪**） | `apps/windows/apps/windows/src/main/ipc/autonomous-ipc.ts`、`packages/agent-runtime/packages/agent-runtime/src/tools/built-in/bing-search-tool.ts` | ✅ 已复核 |
| `main/stubs/` 4 个文件零 import | 仅被 `electron.vite.config.ts:258-261` 指向；alias key 为绝对路径（`resolve(ROOT, 'src/logging/subsystem.js')`），全仓无 import 说明符能命中 → **死配置** | ✅ 已复核 |
| 零引用源文件 | `channel/html-report-template.ts`、`cloud-sync/sync-v3-test.ts`、`wiki-batch-classifier.ts`、`execute-skill-tool.ts`、`formatCreditDescription.ts` | ✅ 已复核 |
| CronPage 死组件簇 | `PipelinesTab.tsx`、`ScheduleTab.tsx`、`shared/CreateJobModal/` 下的 `CronBuilder` / `DateTimePicker` / `IntervalPicker` / `SchedulePresets` | ✅ 已复核 |
| 死导出 | `ipc/agent-runtime-ipc.ts:805 registerAgentRuntimeIPC`（仅被 barrel `agent-runtime/index.ts:3` 再导出，无调用方） | ✅ 已复核 |
| barrel 虚胖 | `packages/agent-runtime/src/index.ts` 505 个导出中 267 个无外部 importer | ⚠️ 需逐个复核 |
| IPC 桩 | `api-ipc.ts:260/287/294`（`api:uploadSkillFile` 直接报错、`getChatModels` 返回空、`setChatModel` no-op），preload 已暴露但 renderer 从未调用 | ⚠️ 需产品确认 |
| 恒默认值的 feature flag | `feature-flags.ts:70-74` 五个 flag 默认 `false`，`runtime:featureFlags:set` IPC 存在但 renderer 从不调用，导致 `bridge-prompt-dispatcher.ts:291` 等 true 分支实际不可达 | ⚠️ 需产品确认 |

> 明细与逐项复核记录见 [死代码清理清单](./dead-code-cleanup-list.md)。

**命名陷阱（勿误删）**：`apps/windows/src/main/coding-dev-backends-stub/` 名字含 "stub"，但**是真实实现**，被 `coding-dev-acp-run.ts`、`channel/acp-backend-manager.ts`、`ipc/agent-runtime/coding-dev-commands.ts`、`slash-commands/{switch-backend,backend}.ts`、`main/index.ts:1312` 动态 import 共 6 处引用。同理 `stubs/qrcode-terminal.ts`、`renderer/stubs/util.ts` 为构建必需。

### 3.2 结构性重复（设计模式的直接靶子）

| 重复项 | 处数 | 建议模式 |
|---|---|---|
| 渠道 session store（feishu / wecom / weixin） | 3 份，67 / 72 / 69 行逐行同构 | 泛型 `JsonSessionStore<T>` |
| 渠道适配器同构方法（`notifyIncomingMessage` / `notifyNavigateToSession` / `getContextStrategy` / `setActiveSessionKey`） | 4 份（feishu:140 / qbot:99 / wecom:123 / weixin:137） | 模板方法 `BaseChannelAdapter` |
| 登录服务（status / session / startLogin / logout / 四事件） | 4 份，各 453–647 行 | `BaseLoginService<TStatus, TSession>` |
| `maskAppId` / `maskBotId` | 3 处重写 | 下沉 shared |
| fetch / https 调用无统一封装 | **114 处 / 58 文件**（主进程 34 处 / 14 文件） | `HttpClient`（超时 / 重试 / UA / 错误分类） |
| repo 手写 SQL 样板（row→entity 映射、分页、ID 生成） | 9 个 repo + wiki-repo + memory-repo + autonomous 4 个 | `BaseRepo` + `rowMapper` + `paginate()` |
| IPC 命令分发 `switch` | `agent-runtime-ipc.ts:849`，**178 个 case** | `CommandRouter` 注册表（`Map<type, Handler>`） |
| `inferPreviewMimeFromFileName` / `shouldReadPreviewAsUtf8` / `expandTildePath` / `isAllowedPreviewPath` | 3 份拷贝（35 处引用） | 下沉 `preview-path-acl.ts` |
| `formatBytes` / `truncate` / `sleep` / `ensureDir` | 5 / 4 / 2 / 2 处 | 公共 util |

### 3.3 分层破损（结构稳定性问题）

- `ipc/agent-runtime/user-commands.ts:116` 直接 `bridge.conversationRepo['db'].prepare()` 写库 —— IPC 层穿透至存储层
- `ipc/agent-runtime-ipc.ts`（1577 行 / 40 import）内 `new Cron`、操作宠物窗口、构造 `AcpBackendManager` —— IPC 层持有业务逻辑而非薄转发
- `wiki-commands.ts`（1460 行）直接 `import node:fs` + 使用 `electron.shell` 做文件业务
- `agent-runtime/bridge.ts` 被 **27 个非测试文件**依赖（全部渠道适配器 + 13 个 IPC 命令模块）—— 上帝模块
- 日志：主进程 + agent-runtime 共 **452 处 `console.*`**，仅 34 个文件使用 `createLogger`

### 3.4 大文件与拆分半途而废

| 文件 | 行数 | 同目录已有的拆分先例（说明路线正确、只是没走完） |
|---|---|---|
| `main/agent-runtime/bridge.ts` | 2717 | 同目录已有 20+ 个 `bridge-*.ts` |
| `shared/agent-runtime-commands.ts` | 2358 | 主进程已按域拆 15 个 `*-commands.ts` |
| `renderer/.../MemoriesPage/components/WikiTab.tsx` | 1932 | 同目录已抽 20+ 子组件 + 6 个 hook |
| `renderer/pages/ChatPage/ChatPage.tsx` | 1670 | 同页已有 `layout/` `hooks/` `utils/` `commands/` |
| `main/index.ts` | 1670 | `window/` `tray/` `ipc/` `channel/` 均已模块化 |
| `main/ipc/agent-runtime-ipc.ts` | 1577 | 同目录已拆 15 个域命令文件，本文件是遗留总调度 |
| `packages/agent-runtime/src/wiki/wiki-repo.ts` | 1566 | 同目录 `wiki-ero` / `wiki-vector` / `wiki-ref-store` 已是独立仓储 |
| `renderer/hooks/business/useAgentRuntime/event-handler.ts` | 1545 | 单函数 `handleRuntimeEvent` 1050 行 switch |
| `main/voice/model-manager.ts` | 1477 | `modelscope-downloader` / `asr-engine` 已独立 |
| `preload/index.ts` | 1487 | `preload/api/` 已拆 17 个模块，接口类型仍留在 index |

完整的 138 个 >400 行文件分级与拆分建议，见 [大文件重构分析处理/code-location-index.md](../大文件重构分析处理/code-location-index.md)。

### 3.5 工程基建缺失（防反弹的关键）

- 无 ESLint / Prettier / `.editorconfig`，但 `AGENTS.md` 第 6 条与项目命令表都写了 `pnpm --filter ./apps/windows lint` —— **该命令实际不存在**
- 无任何 CI（无 `.github/`）
- path alias 分散在 **4 处**需手工同步：`tsconfig paths`(5 条) / `vitest.config`(8 条) / `electron.vite.config`(8+ 条) / `pet-lab/vite.config`(1 条)
- 5 个 tsconfig **无一 extends `tsconfig.base.json`**（base 形同废弃）；模块体系分裂（NodeNext vs ESNext/bundler）
- `apps/windows/tsconfig.json` include 了不存在的 `../../src/coding-dev-backends/**/*.ts`
- 双测试树并存：`src/test/`（37 文件）与就近 `*.test.ts`（392 文件）；脚本分裂 —— `test` 只跑 `src/test`，`test:all` 才全量
- 近重复测试：`ipc/performance-ipc.test.ts` vs `perf/performance-ipc.test.ts`；`compact/__tests__/policy.test.ts` vs `compact/policy.test.ts`
- `packages/browser-control` 无 test 脚本，`pnpm -r test` 会失败
- 陈旧文档：`docs/standards/dual-connection-architecture.md` 描述的 Gateway 架构已在代码中删除

### 3.6 已建好但闲置的抽象（捡现成）

- `renderer/hooks/common/useQuery|useMutation|useAsync` 已实现，24 个业务 hook **仅 4 个采用**（`useDashboard` / `useFiles` / `useSkills` / `useSystem`），其余 20 个手写 `setLoading` / `try-catch` / `setError` 样板
- 业务 hook 中 180 处直调 `window.electronAPI`，40+ 处 `catch(err)` 手工转字符串

---

## 四、重构方案：四个批次

每批次独立可交付、可回滚、可验证。**顺序不可颠倒。**

### 批次 0 · 清库（纯删除，零行为变更）

- 删除 2 个嵌套脏拷贝目录
- 删除 `main/stubs/` 4 文件 + `electron.vite.config.ts` 5 条死 alias
- 删除零引用源文件（逐项按 [清单](./dead-code-cleanup-list.md) 人工确认）
- 裁剪 `agent-runtime/index.ts` barrel
- **预期减重 3000–5000 行，风险接近零**
- 验证：`pnpm typecheck` + `pnpm build` + 启动应用冒烟

### 批次 1 · 立门禁（防止再次反弹）

- 引入 ESLint + Prettier，**baseline 模式**：只开 `no-console`(warn)、`no-unused-vars`、`max-lines`(warn, 800)，不做全量 autofix（存量问题若一次全开会爆数千条，无法收场）
- 新增 CI（GitHub Actions）：`typecheck` + 各包 `test` + `lint`
- path alias 收敛到单一来源；tsconfig 统一 extends `tsconfig.base.json`
- 双测试树合并为就近放置；`browser-control` 补 test 脚本
- **这是"结构稳定性"的真正抓手，也是上一轮失败的直接原因**

### 批次 2 · 抽象落地（设计模式）

按收益/风险比排序，S/M 先做，L 压后：

| 序 | 项 | 模式 | 规模 |
|---|---|---|---|
| 1 | 泛型 `JsonSessionStore<T>` 合并 3 套 session store | 泛型仓储 | S |
| 2 | 抽 `previewPath` helper，消 3 份拷贝 | 工具下沉 | S |
| 3 | 公共 util 收敛（`formatBytes` / `truncate` / `sleep` / `ensureDir`） | 工具下沉 | S |
| 4 | `CommandRouter` 注册表替换 178-case switch | 注册表 / 策略映射 | M |
| 5 | `HttpClient` 统一 114 处网络调用 | 门面 + 策略 | M |
| 6 | `AppError` + `console.*` → `createLogger` 清理 | 统一错误类型 | M |
| 7 | 业务 hook 迁移到 `useQuery`（20 个） | 复用既有抽象 | M |
| 8 | `BaseLoginService` 合并 4 个登录服务 + 4 套渠道存储 | 模板方法 | L |
| 9 | `BaseRepo` + `rowMapper` + `paginate()` | 仓储基类 | L |

> 模式使用原则：**已存在的抽象优先复用**（如 `useQuery`、`SlashCommandRegistry`、`ChannelRegistry`、`ContextStrategy` 均为正面样板）；类型穷举 switch、状态转换逻辑不机械改写为策略。

### 批次 3 · 大文件拆分

沿用 [大文件重构分析处理](../大文件重构分析处理/README.md) 的方案，按收益/风险比重排：

1. `shared/agent-runtime-commands.ts`（纯类型，barrel 保兼容）
2. `useAgentRuntime/event-handler.ts`（纯前端 store）
3. `ipc/agent-runtime-ipc.ts`（已有 15 个域模块 + 三份重复 helper）
4. `ipc/agent-runtime/wiki-commands.ts`（机械按域拆）
5. `main/agent-runtime/bridge.ts`（20+ 先例，需保 facade）
6. `WikiTab.tsx` / `ChatPage.tsx`（UI 回归需手测）
7. `main/index.ts`（bootstrap 外移）
8. `controller.ts` / `model-manager.ts` / `voice-service.ts`
9. `wiki-repo.ts`（有 1084 行测试，风险最高，最后动，先抽 facade）

---

## 五、风险与缓解

| 风险 | 缓解 |
|---|---|
| `bridge.ts` 被 27 个模块依赖，拆分可能断链 | 只迁移不重写，保留 facade，逐子域小提交 |
| `wiki-repo.ts` 有 1084 行测试，改动即回归 | 放最后；先抽仓储 facade 再搬实现 |
| ESLint 全量启用爆数千错误 | baseline 模式，仅 warn 级，不阻断 |
| 渠道 / 语音改动涉及外部 SDK 运行时行为 | 批次 2 的 L 级项延后；先做 S/M |
| 删除"看似无用"的代码导致运行时缺失 | 所有删除项必须先在 [清单](./dead-code-cleanup-list.md) 中登记证据并复核 |
| 历史文档与代码不一致（如 `dual-connection-architecture.md`） | 批次 1 顺带清理 stale 文档 |

---

## 六、验收标准

### 每批次通用门禁

```bash
pnpm typecheck                              # 全 workspace 零报错
pnpm --filter lumii-windows test:all
pnpm --filter @mtbot/agent-runtime test
pnpm build                                  # 批次 0/1 必跑
```

### 契约不变性

- IPC channel 名称、command 类型、返回值、NOT_READY 行为、错误传播不变
- `electronAPI` 属性结构、事件取消函数行为、`weixinService` / `wecomService` / `feishuService` / `channelService` 全局暴露不变
- Prompt 输出（section 顺序、标签、缓存边界）、初始化顺序不变

### 关键路径人工回归

发消息、调工具、语音通话、渠道发信、文件预览、设置保存、宠物窗口。

### 行数纪律

行数是**观察指标**，不是目标。禁止为降低行数制造空壳文件；拆分必须能说明职责边界。

---

## 七、执行记录

| 批次 | 状态 | 备注 |
|---|---|---|
| 批次 0 清库 | 未开始 | 清单见 [dead-code-cleanup-list.md](./dead-code-cleanup-list.md) |
| 批次 1 立门禁 | 未开始 | |
| 批次 2 抽象落地 | 未开始 | |
| 批次 3 大文件拆分 | 未开始 | 沿用既有计划 |
