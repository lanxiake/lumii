# Lumii 项目测试扫描报告

扫描日期：2026-08-21  
扫描范围：`apps/windows`、`packages/agent-runtime`、`packages/pet-core`、`packages/browser-control`

## 结论

当前项目不能通过统一提交门禁 `pnpm verify`。主要阻塞来自：

1. `packages/agent-runtime` 类型检查失败，且有 1 个测试文件无法加载。
2. `packages/browser-control` 存在缺失依赖、缺失源码模块和多处类型错误。
3. `apps/windows` 类型检查失败，构建因此在 `prebuild` 阶段停止。
4. `apps/windows` 全量测试有 4 个失败测试和 12 个未处理异步错误。
5. Windows lint 找不到 `eslint` 可执行文件。
6. `packages/pet-core` 类型检查通过，但测试因 Vitest/Vite 版本导出不兼容无法启动。

## 命令结果

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter ./packages/agent-runtime typecheck` | 失败 |
| `pnpm --filter ./packages/agent-runtime test` | 失败：83 个文件中 1 个 suite 无法加载，636 个测试通过 |
| `pnpm --filter ./packages/pet-core typecheck` | 通过 |
| `pnpm --filter ./packages/pet-core test` | 失败：`ERR_PACKAGE_PATH_NOT_EXPORTED`（Vitest 4 与 Vite） |
| `pnpm --filter ./packages/browser-control typecheck` | 失败 |
| `pnpm --filter lumii-windows typecheck` | 失败 |
| `pnpm --filter lumii-windows lint` | 失败：找不到 `eslint` |
| `pnpm --filter lumii-windows test:all` | 失败：4 failed / 121 passed / 51 skipped，12 errors |
| `pnpm --filter lumii-windows test:e2e` | 失败：No tests found |
| `pnpm --filter lumii-windows build` | 失败：`prebuild` 的 typecheck 失败 |
| `pnpm --filter ./packages/pet-core build` | 通过 |

## 问题清单

### P0：阻塞构建和提交

#### 1. Windows 类型检查失败

文件集中在 `apps/windows/src`，主要问题包括：

- `bridge-app-ui-tools.test.ts`、`app-ui-control/controller.ts`、`app-ui-control/server.test.ts`：`AppUiController` 接口与实现/测试 fake 不一致，缺少 `gotoAndScreenshot`、`scrollToText`、`fillForm` 等方法，错误联合类型也不一致。
- `bridge-context-compactor.test.ts`、`dashboard-feed-tool.test.ts`、`feishu-login-service.test.ts`、`ffmpeg-runner.test.ts`：对空 tuple 或空 mock 参数访问不存在的索引。
- `bridge-instance-factory.ts`：`sessionId` 推断为 `{}`，`reasoning` 联合类型包含底层不支持的 `max`/`xhigh` 等值。
- `bridge-tool-registrar.ts`：`LocalDatabase` 没有 `prepare` 方法。
- `bridge-utils.ts`：将 `{}` 作为字符串参数传入。
- `permission-native-dialog.ts`：`BrowserWindow | undefined` 传给要求 `BaseWindow` 的 API。
- `storage-commands.ts`：返回值缺少要求的 `ok` 字段。
- `user-commands.ts`：可选字符串未收窄后传入字符串参数。
- `mempalace-mcp-client.ts`：当前 TypeScript `lib` 不包含 `String.prototype.toWellFormed`。
- `screen-record/burn-subtitles-service.ts`、`narrate-service.test.ts`：音频片段缺少必需的 `endMs`。
- `renderer/App.tsx`、`useAgentRuntime.ts`、`PetDebugOverlay.tsx`：回调泛型和 `ImportMeta` 扩展类型缺失。
- `PdfJsPreview.tsx`、`useVoiceCall.ts`：Vite query/raw 模块缺少类型声明。
- `useConversationReplay.ts`：`Float32Array<ArrayBufferLike>` 与 `Float32Array<ArrayBuffer>` 不兼容。
- `useSettings.ts`：`SystemConfig` 缺少 `showSplashOnStartup`。
- `CronPage/components/PipelinesTab.tsx`：调用参数数量与 hook 定义不一致。

`agent-runtime-ipc.ts` 中本轮发现的 4 个错误已修复，当前扫描未再报告该文件错误。

#### 2. browser-control 包不完整

文件：`packages/browser-control/src/browser/*`

- 缺少 `express` 及其类型声明。
- 缺少 `routes/index.js`、`routes/types.js`、`routes/dispatcher.js`。
- `control-service` 未导出 `startBrowserControlServiceFromConfig`。
- `config` 未导出 `resolveBrowserConfig`。
- `loadConfig`、`writeConfigFile`、`MtBotConfig`、`BrowserProfileConfig`、`deriveDefaultBrowserCdpPortRange` 未定义或未导入。
- 浏览器 DOM 类型未配置，导致 `window`、`document`、`Element` 报错。
- 多处 `number | undefined` 未收窄。

#### 3. agent-runtime 类型错误

文件：`packages/agent-runtime/src/compact/strategies/micro-compact.ts:307`

对象带有 `toolCalls`，但被断言为不支持该字段的 `AgentMessage` 联合成员。

### P1：测试失败或测试基础设施失效

#### 4. agent-runtime 测试 suite 无法加载

文件：`packages/agent-runtime/src/compact/transform-context-phase1.test.ts`

测试导入 `../transform-context.js`，但对应文件不存在。

#### 5. Windows 全量测试失败

- `src/main/coding-dev-cli-install.test.ts:54`：qoder 脚本被错误判定为可自动卸载。
- `src/main/coding-dev-jsonl-parsers.test.ts:118`：无解析器后端的纯文本回落返回 `null`，预期为 message。
- `src/main/agent-runtime/cron-e2e.test.ts:198`：预置任务 `seed-focus-check` 的 `enabled` 为 `0`，预期为 `1`。
- `src/test/components/useComposerDraft.test.ts`：外部清空草稿后仍得到 `hello`。
- `src/test/components/ChatPage.test.tsx` 相关测试产生未处理异步错误：`window.electronAPI.system.getUserPaths`、`window.electronAPI.skills.listLocalInstalled` 未配置 mock。

#### 6. pet-core 测试无法启动

错误：`ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './module-runner' is not defined by "exports"`。当前 `vitest@4.1.10` 与项目使用的 Vite 版本不兼容，或依赖安装状态不一致。

#### 7. E2E 配置指向不存在的测试文件

脚本：`apps/windows/package.json:test:e2e`  
目标：`e2e/memory/memory-management.spec.ts`  
结果：Playwright 报 `No tests found`。

### P2：工具链和维护问题

#### 8. Windows lint 不可执行

`apps/windows/package.json` 声明了 `eslint` 脚本，但 workspace 依赖中没有可解析的 `eslint` 命令。

#### 9. pnpm 配置警告

每次 pnpm 命令都报告根 `package.json` 中的 `pnpm.overrides` 与 `pnpm.patchedDependencies` 不再读取，应迁移到 pnpm 新配置文件格式。

## 建议修复顺序

1. 先修复 `browser-control` 缺失文件/依赖和 `agent-runtime` 类型错误，恢复 workspace typecheck。
2. 修复 Windows 类型错误，使 `prebuild` 和提交门禁可运行到 lint/test 阶段。
3. 修复 4 个确定失败的 Windows 测试及 ChatPage 的 Electron API mock。
4. 对齐 pet-core 的 Vitest/Vite 版本或锁定兼容版本。
5. 修正 agent-runtime 失效测试导入、E2E 路径和 eslint 依赖。
