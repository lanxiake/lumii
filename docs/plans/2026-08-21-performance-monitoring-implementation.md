# 性能监控与调用耗时统计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改动全量 IPC、不复制现有日志路径逻辑、不影响业务启动和退出的前提下，为 Lumii 建立“采集 -> 独立落盘 -> 主进程查询 -> 设置页展示 -> 手动采集/复制/打开目录”的第一阶段性能观测闭环，覆盖启动阶段、精选高耗时 IPC、主进程及 Electron 子进程内存。

**Architecture:** 在 `apps/windows/src/main/performance/` 增加一个轻量 `PerformanceMonitor`。它只在主进程运行，使用内存聚合和异步 JSONL 写入；正常精选 IPC 只更新聚合，慢调用和异常调用即时写事件，60 秒写聚合与内存快照。主进程通过三个独立 IPC handler 返回结构化报告，preload 暴露同名 `performance` namespace，设置页复用现有“设置 > 隐私与数据”区域展示诊断信息。性能监控所有失败均降级为健康状态，不得阻塞业务。

**Tech Stack:** Electron main/preload, React, TypeScript, Vitest, JSONL, Node `fs/promises`/`createWriteStream`, Electron `app.getAppMetrics()`, existing `resolveClientStateDir()` and existing Settings Toast/clipboard/open-path patterns.

**Spec:** `docs/design/性能优化/性能监控与调用耗时统计方案.md`

## Global Constraints

- 只观测以下精选 IPC：`agent-runtime:command`、`voice:command`、`screen-record:start`、`screen-record:stop`、`screen-record:narrate`、`provider:listModels`、`provider:testConnection`。
- 不修改 `ipcMain.handle` 全局行为，不 monkey patch `ipcMain`，不包装未列出的 IPC。
- 不修改 `apps/windows/src/main/file-logger.ts` 的 console 拦截和业务日志格式；性能日志单独写入 `logs/performance/`。
- 性能日志目录必须由 `resolveClientStateDir()` 派生，并沿用 `PORTABLE_EXECUTABLE_DIR` 便携版规则；性能模块不得复制一套数据根目录判断逻辑。
- 监控默认启用；`LUMII_PERF_LOG=0` 仅作为开发/故障排查开关，不新增应用设置项。关闭时不得创建性能目录或性能文件。
- 事件只记录计时、计数、状态和固定枚举；禁止记录 Token、Key、Cookie、Prompt、消息正文、模型响应、命令参数、文件内容、URL 查询参数、异常 message 和完整路径以外的业务数据。
- 正常 IPC 不逐条写盘；慢调用阈值固定为 `200 ms`，仅写 `ipc.slow`；异常仅写 `ipc.error`，只记录错误类型。
- 聚合窗口固定为 `60_000 ms`，内存采样间隔固定为 `60_000 ms`，队列上限 `200` 条，单条 JSONL 上限 `16 KB`，单文件上限 `20 MB`，保留最近 `14` 个日文件，报告最多读取最近 `7` 个文件。
- p95 使用最多 `128` 个耗时样本的有界样本计算，报告必须标记 `approximate: true`，不得把近似 p95 表述为精确统计。
- 写入、读取、解析、采样、打开目录失败都只能更新 `PerformanceHealth` 和业务 logger 的低频告警；不得让启动、IPC 返回、设置页渲染或退出流程失败。
- 不引入数据库、图表库、远程上报、后台常驻上传、全量调用明细、命令行查看器或新的设置分类。
- 所有新增公共类型只定义在 `performance-types.ts`；preload 和 renderer 直接引用该类型，不得复制同名接口。
- 每个实现任务先补充/调整失败测试，再写实现；每个任务完成后只提交与该任务相关的文件。

---

## 1. Scope and File Map

### 1.1 Must-have behavior

- 每次启动生成唯一 `runId`，记录 `app-ready`、窗口创建/可见、目录配置、技能运行时、技能 watcher、Agent Runtime、浏览器服务、渠道服务和启动完成阶段。
- 重点 IPC 返回值和异常行为保持不变；只额外增加计时和聚合。
- 业务正常调用进入内存聚合；慢调用和错误调用即时写入 JSONL；每 60 秒写一次 `ipc.aggregate`。
- 每 60 秒记录主进程 `process.memoryUsage()`，并通过 `app.getAppMetrics()` 记录 Renderer/GPU/Utility 等子进程内存；用户点击“立即采集”时立即采集一次。
- 主进程可返回当前运行及最近 7 天的结构化报告，损坏行跳过并在健康状态中增加 `readErrorCount`。
- 设置页显示监控健康状态、最近一次启动、重点 IPC、内存摘要，并提供刷新、立即采集、复制脱敏报告、打开性能日志目录四个动作。

### 1.2 New files

```text
apps/windows/src/main/performance/
  performance-types.ts
  performance-aggregator.ts
  performance-monitor.ts
  performance-ipc.ts
  performance-aggregator.test.ts
  performance-monitor.test.ts
  performance-ipc.test.ts

apps/windows/src/renderer/pages/SettingsPage/components/PerformanceDiagnostics/
  PerformanceDiagnostics.tsx
  PerformanceDiagnostics.module.css
  PerformanceDiagnostics.test.tsx
  index.ts
```

### 1.3 Modified files

```text
apps/windows/src/main/index.ts
apps/windows/src/main/ipc/agent-runtime-ipc.ts
apps/windows/src/main/voice/voice-ipc.ts
apps/windows/src/main/screen-record/screen-record-ipc.ts
apps/windows/src/preload/index.ts
apps/windows/src/renderer/pages/SettingsPage/SettingsPage.tsx
```

### 1.4 Explicitly unchanged files

`apps/windows/src/main/file-logger.ts`、`apps/windows/src/main/paths.ts` 的已有行为不改。`paths.ts` 只作为性能目录解析的依赖；如果现有导出不足，优先调用已有 `resolveSharedLogsDir()`，只有确实缺少公共能力时才新增一个最小路径导出，并为其补测试，不得在 monitor 内复制 portable 判断。

---

## 2. Task 1: Lock the Data Contract and Pure Aggregation Rules

**Files:**

- Create `apps/windows/src/main/performance/performance-types.ts`
- Create `apps/windows/src/main/performance/performance-aggregator.ts`
- Create `apps/windows/src/main/performance/performance-aggregator.test.ts`

**Dependencies:** None.

### 2.1 Define the shared types first

- [ ] Define `PerformanceEventName` with exactly: `startup.phase`, `startup.complete`, `ipc.slow`, `ipc.error`, `ipc.aggregate`, `memory.snapshot`.
- [ ] Define `MeasuredIpcChannel` as a literal union containing exactly the seven channels in `Global Constraints`.
- [ ] Define `StartupPhaseName` as: `app-ready`, `create-window`, `ready-to-show`, `directory-config`, `skill-runtime`, `skill-watcher`, `agent-runtime`, `browser-service`, `channel-services`.
- [ ] Define the common event fields: `schemaVersion: 1`, `ts`, `event`, `runId`, `appVersion`, `pid`, `process: 'main'`.
- [ ] Define event-specific payloads without `unknown` maps for business data. IPC event payloads may contain only `channel`, `durationMs`, `errorType`, `count`, `errorCount`, `slowCount`, `sumMs`, `maxMs`, `p95Ms`, `approximate`, and `windowMs`.
- [ ] Define `PerformanceHealth` with `enabled`, `writable`, `logPath: string | null`, `lastEventAt`, `lastMemorySampleAt`, `droppedEvents`, `readErrorCount`, and a sanitized `lastWriteError` enum (`mkdir-failed`, `append-failed`, `rotate-failed`, `read-failed`, or `null`). Do not expose exception message text.
- [ ] Define `StartupSummary`, `IpcSummary`, `MainMemorySummary`, `ChildMemorySummary`, `MemorySummary`, and `PerformanceReport` exactly as consumed by preload and renderer. `PerformanceReport` must contain `generatedAt`, `runId`, `health`, `startup.current`, `startup.recent`, `ipc`, and `memory`.
- [ ] Define `PerformanceCaptureReason` as `manual | startup | interval | shutdown`.

### 2.2 Implement pure aggregation

- [ ] Implement `createIpcAccumulator(channel, now)` and `addIpcSample(accumulator, durationMs, outcome)`; preserve count, error count, slow count, total, max, and a ring buffer capped at `128` samples.
- [ ] Implement `getApproximateP95(accumulator)` with a deterministic nearest-rank rule over the retained samples and `approximate: true` whenever a p95 is present.
- [ ] Implement `mergeIpcAggregateEvent` and `mergeStartupPhaseEvent` for history loading; a malformed or unsupported event must return a skip result and never throw out of the report build.
- [ ] Implement `summarizeMemorySnapshots` for main RSS/heap fields and child process records. Missing Electron metric fields must become `null`, not `0`, so unavailable data is distinguishable from zero.
- [ ] Implement `redactReportForClipboard(report)` as a pure function that removes `logPath`, `pid`, and any raw error field while preserving counts and timings.

### 2.3 Tests before implementation and acceptance

- [ ] Test a successful fast call: count increases, error/slow remain zero, and no per-call event is requested by the pure layer.
- [ ] Test a successful call at exactly `200 ms` as not slow and one at `200.1 ms` as slow.
- [ ] Test failed fast and failed slow calls: both increment error count, and the slow failed call increments both error and slow counts.
- [ ] Test p95 with fewer than 128 samples, more than 128 samples, deterministic retained samples, and empty samples.
- [ ] Test startup phase grouping by run ID and incomplete phases; incomplete data must not fabricate a successful duration.
- [ ] Test memory delta when startup baseline exists and `null` when it does not.
- [ ] Test malformed history event skip and clipboard redaction; assert no token-like or path-like fields are returned.
- [ ] Run `pnpm --filter ./apps/windows exec vitest run src/main/performance/performance-aggregator.test.ts` and keep the expected failing result until implementation is added in this task.
- [ ] Implement the smallest code needed to make the tests pass, then rerun the same command and record the passing result in the task notes.

**Task acceptance:** All public types are defined once, aggregation has no Electron/file-system dependency, p95 is explicitly approximate, and pure tests cover success/error/slow/history/memory/redaction paths.

---

## 3. Task 2: Implement the Low-Overhead Monitor, JSONL Writer, and History Loader

**Files:**

- Create `apps/windows/src/main/performance/performance-monitor.ts`
- Create `apps/windows/src/main/performance/performance-monitor.test.ts`
- Use types from `performance-types.ts` and pure functions from `performance-aggregator.ts`

**Dependencies:** Task 1.

### 3.1 Define the monitor boundary

- [ ] Export `PerformanceMonitor` and one main-process singleton `performanceMonitor`.
- [ ] Expose these methods only: `initialize(): Promise<void>`, `startStartupPhase(phase): PerformanceSpan`, `measureIpcHandler(channel, handler)`, `capture(reason): Promise<PerformanceReport>`, `getReport(): Promise<PerformanceReport>`, `flush(): Promise<void>`, `shutdown(): Promise<void>`, and `getLogDirectory(): string | null`.
- [ ] Define `PerformanceSpan.end(ok?: boolean, errorType?: string): void`; ending twice must be harmless and must not throw into business code.
- [ ] Inject clock, app-version getter, file operations, and enabled flag through an internal constructor options object so tests never write the real user directory. Production construction uses existing path resolution.
- [ ] Use `performance.now()` for durations and `Date.toISOString()` only for event timestamps. Never use wall-clock subtraction for elapsed time.

### 3.2 Implement initialization and event queueing

- [ ] Generate `runId` once per monitor instance using a non-sensitive local identifier; do not include user, workspace, URL, or command data.
- [ ] Read `LUMII_PERF_LOG`; only the exact value `0` disables the monitor. Disabled monitor methods return no-op spans and empty disabled reports without creating directories.
- [ ] Make `initialize()` create `logs/performance/`, select `performance-YYYY-MM-DD.jsonl`, rotate files older than the newest 14, and set `health.writable` based on actual directory/file access.
- [ ] Keep a bounded in-memory queue of at most 200 events while initialization or a previous write is pending. On overflow, increment `droppedEvents` and discard the lowest-priority normal event first; never grow the queue.
- [ ] Ensure startup spans created before asynchronous initialization are queued and flushed after initialization. `getReport()` and `capture()` await the monitor readiness promise, while ordinary instrumentation never awaits file I/O.

### 3.3 Implement JSONL write policy

- [ ] Serialize one event per line and reject/truncate any serialized event over `16 KB`; the truncation path must keep only the fixed event envelope and numeric summary fields.
- [ ] Serialize writes through one promise chain or one controlled stream so concurrent IPC completions cannot interleave lines.
- [ ] Flush normal queued events asynchronously. On a write failure set `writable=false`, set the sanitized `lastWriteError`, increment no business error, and emit at most one low-frequency warning through the existing `log` in a five-minute period.
- [ ] Track file size and stop normal aggregate/memory writes after `20 MB`. Continue retaining current in-memory report and allow startup completion, slow/error events, and one capacity marker if space remains.
- [ ] Write `ipc.aggregate` every `60_000 ms` for non-empty accumulators, then reset the window. Write `memory.snapshot` on the same interval. Clear both timers in `shutdown()`.
- [ ] Use `process.memoryUsage()` for the main process and normalize `app.getAppMetrics()` into child records with process type, pid, and available working-set/private bytes. Sampling errors produce a sanitized `memory.snapshot` failure state in memory, not a thrown error.

### 3.4 Implement report loading

- [ ] Load at most the newest seven `performance-YYYY-MM-DD.jsonl` files and at most `20 MB` from each file. Use line-oriented parsing or bounded tail reading; never pass raw log contents to renderer.
- [ ] Skip malformed JSON, unsupported schema versions, and invalid event shapes. Increment `readErrorCount` once per skipped line and keep valid events.
- [ ] Rebuild recent startup summaries by `runId`, merge `ipc.aggregate` into the current report, and keep recent memory samples capped at a fixed in-memory size.
- [ ] Return `PerformanceReport` with `source` semantics documented in the type or comments: current in-memory values override history for the current `runId`; history fills missing recent startup/memory data.
- [ ] `capture(reason)` must perform one main/child memory sample, flush queued events, write the capture event context through the normal queue, and then return the report. It must not block on an unbounded flush.

### 3.5 Tests before implementation and acceptance

- [ ] Test disabled mode: no filesystem calls, no directory creation, no timer side effects, and a health report that clearly says disabled.
- [ ] Test initialization failure: `initialize()` resolves, health becomes not writable, startup spans still end, and no exception reaches the caller.
- [ ] Test queue cap and priority: 200-event cap, dropped count, and retention of error/slow/startup events.
- [ ] Test serialized writes under concurrent event recording; assert each line is valid JSON and no line is interleaved.
- [ ] Test slow/error/normal IPC write policy: normal calls only affect aggregation, slow/error calls enqueue immediate events.
- [ ] Test 60-second aggregate and memory timers with a fake clock; assert timers are cleared by `shutdown()`.
- [ ] Test file-size limit, 14-file retention selection, seven-file history read limit, 20 MB/file read limit, and malformed-line tolerance.
- [ ] Test `getReport()` and `capture()` for both writable and unavailable storage; both must return structured health data.
- [ ] Test the injected `app.getAppMetrics()` adapter with missing fields and thrown errors.
- [ ] Run `pnpm --filter ./apps/windows exec vitest run src/main/performance/performance-monitor.test.ts` before and after implementation.

**Task acceptance:** Monitor instrumentation is non-blocking, writes only to the separate performance directory, survives storage/read failures, and provides a report even when no file can be written.

---

## 4. Task 3: Instrument the Actual Startup Lifecycle

**Files:**

- Modify `apps/windows/src/main/index.ts:2978` `initialize()` and `:342` `createWindow()`.
- Use `performanceMonitor` and `registerPerformanceIpc` from the new performance module.

**Dependencies:** Tasks 1-2.

### 4.1 Place initialization without adding a blocking startup dependency

- [ ] Instantiate/use the monitor before `app.whenReady()` only for in-memory timing; do not touch filesystem before Electron is ready.
- [ ] Start the `app-ready` span immediately before the existing `await app.whenReady()` and end it immediately after that await.
- [ ] Immediately after `app.whenReady()`, call `void performanceMonitor.initialize()` with an error boundary; do not make an initialization/storage error reject `initialize()`.
- [ ] Register `performance:*` handlers after monitor construction and before `createWindow()` so the renderer cannot observe a missing performance handler.

### 4.2 Add phase boundaries at existing lifecycle calls

- [ ] In `createWindow()`, start `create-window` before `new BrowserWindow`, start `ready-to-show` immediately before waiting for the existing event, end `ready-to-show` inside the existing `ready-to-show` listener, and end `create-window` in a `finally` around the existing returned async flow.
- [ ] Wrap only the existing `await createWindow(isTestMode, isStartupLaunch)` call as the window phase owner; do not reorder window creation or splash behavior.
- [ ] Add `directory-config` around `directoryManager.initialize()` plus `ConfigManager` initialization and its required selection-base setup. Include the existing workspace temp layout in this phase only if it remains in the same synchronous section; do not move it.
- [ ] Add `skill-runtime` around `initSkillRuntime()` and `initScriptRuntimes()`; add `skill-watcher` around `seedBundledSkills()` and `initSkillWatcher()`.
- [ ] Add `agent-runtime` around `initAgentRuntime()`.
- [ ] Add `browser-service` around `startBrowserService()` and end it regardless of the returned boolean; the report records `ok=false` only when the call throws, while a normal `false` result is represented by a sanitized status field if the event type supports it.
- [ ] Add `channel-services` around the three login service initializations and channel adapter setup, ending it before the final startup log. Do not put IPC registration or service code inside the monitor module.
- [ ] Write one `startup.complete` event after the existing “Lumii startup complete” log, with total elapsed time and a success flag. If `initialize()` rejects, end the active phase as failed and write the failure event before rethrowing to the existing top-level catch.

### 4.3 Add shutdown handling

- [ ] In the existing `app.on('before-quit')` path around `index.ts:3316`, call `void performanceMonitor.shutdown()` behind the existing cleanup guard; do not turn Electron’s synchronous quit event into an awaited business dependency.
- [ ] Ensure signal/exception cleanup paths do not create a second monitor shutdown or duplicate `startup.complete`.

### 4.4 Tests and acceptance

- [ ] Add or extend a main lifecycle test with mocked monitor spans; assert each phase is started and ended once and in the intended order.
- [ ] Assert monitor initialization failure does not reject the existing startup promise and does not prevent `createWindow()`.
- [ ] Assert shutdown calls `flush/shutdown` once and does not delay the existing quit path beyond the monitor’s bounded flush behavior.
- [ ] Run the focused main tests and `pnpm --filter ./apps/windows typecheck`.

**Task acceptance:** A report contains a usable startup timeline with real existing lifecycle boundaries, and disabling or breaking performance storage cannot prevent the app from launching or quitting.

---

## 5. Task 4: Wrap Only the Seven High-Value IPC Handlers

**Files:**

- Modify `apps/windows/src/main/ipc/agent-runtime-ipc.ts:435`
- Modify `apps/windows/src/main/voice/voice-ipc.ts:106`
- Modify `apps/windows/src/main/screen-record/screen-record-ipc.ts:58-84`
- Modify `apps/windows/src/main/index.ts:2458-2465` for provider handlers
- Use the shared `measureIpcHandler` wrapper from `performance-monitor.ts`

**Dependencies:** Tasks 1-2.

### 5.1 Define wrapper behavior once

- [ ] Implement the wrapper signature with Electron’s `IpcMainInvokeEvent` followed by the handler arguments, so existing handler argument types remain visible to TypeScript.
- [ ] Start timing before invoking the original handler and end timing in a `try/catch/finally` path.
- [ ] Preserve the original resolved value and rethrow the original error object to Electron; do not replace or serialize result/error payloads.
- [ ] Record only `Error.name` or a fixed `unknown-error` value on failure; never record `error.message`, arguments, return values, or event sender data.
- [ ] Make wrapper overhead consist only of `performance.now()`, numeric accumulator updates, and conditional queueing for slow/error calls.

### 5.2 Apply wrappers at explicit registration sites

- [ ] In `installAgentRuntimeCommandIpc()`, wrap the existing `commandHandler` at the single `ipcMain.handle('agent-runtime:command', ...)` registration. Preserve the existing “already installed” guard.
- [ ] Wrap `voice:command` in `voice-ipc.ts` without changing its command dispatch or return type.
- [ ] Wrap only `screen-record:start`, `screen-record:stop`, and `screen-record:narrate`; leave source listing, recording listing, deletion, pause/resume/status and subtitle handlers unchanged.
- [ ] Wrap `provider:listModels` and `provider:testConnection` in `index.ts` without changing provider config validation or returned error behavior.
- [ ] Do not add instrumentation to preload calls or renderer hooks; one main-process wrapper is the source of truth for each selected channel.

### 5.3 Tests and acceptance

- [ ] Test each wrapper with a fast success, slow success, fast rejection, and slow rejection.
- [ ] Assert the business result/error identity is preserved and only the expected event/aggregate counters change.
- [ ] Assert normal calls do not immediately write a JSONL event, while slow/error calls do.
- [ ] Assert all seven channel literals appear in the test coverage and no unlisted channel is wrapped.
- [ ] Run `pnpm --filter ./apps/windows exec vitest run src/main/performance src/main/ipc src/main/voice src/main/screen-record` with the repository’s existing test filters as applicable.

**Task acceptance:** The seven selected channels are observable with no global IPC interception and no business behavior change; the report can distinguish volume, errors, slow calls, p95 and max duration.

---

## 6. Task 5: Add Main-Process Query and Capture IPC

**Files:**

- Create `apps/windows/src/main/performance/performance-ipc.ts`
- Create `apps/windows/src/main/performance/performance-ipc.test.ts`
- Modify `apps/windows/src/main/index.ts` to call `registerPerformanceIpc()` once

**Dependencies:** Tasks 1-3.

### 6.1 Define the three handlers

- [ ] Export `registerPerformanceIpc(monitor: PerformanceMonitor, shellApi = shell): void` with an idempotent registration guard; duplicate initialization must not call `ipcMain.handle` twice.
- [ ] Register exactly:

```ts
performance:getReport(): Promise<PerformanceReport>
performance:capture(): Promise<PerformanceReport>
performance:openLogFolder(): Promise<{ success: boolean; path?: string; error?: string }>
```

- [ ] `performance:getReport` returns the current structured report and does not trigger a memory sample.
- [ ] `performance:capture` calls the monitor capture method with `manual`, then returns the report even when storage is unavailable.
- [ ] `performance:openLogFolder` obtains the path only from `monitor.getLogDirectory()`, rejects path arguments because there are none in the contract, and calls Electron `shell.openPath`/the existing equivalent. Return a sanitized error code/text suitable for a Toast, never an exception stack.
- [ ] Handler failures outside monitor health must resolve to the documented structured fallback or `{success:false}`, so renderer actions do not become unhandled rejected promises.

### 6.2 Tests and acceptance

- [ ] Test idempotent registration, report forwarding, manual capture forwarding, disabled monitor behavior, and open-folder success/failure.
- [ ] Test that no arbitrary renderer-provided path can reach `shell`.
- [ ] Run the focused IPC test and typecheck.

**Task acceptance:** The renderer has a stable, typed, non-file-parsing API for every operation required by the user-facing closed loop.

---

## 7. Task 6: Extend Preload Without Duplicating Contracts

**Files:**

- Modify `apps/windows/src/preload/index.ts:206` `ElectronAPI`, `:1170` implementation, and `:1980` global declaration area.

**Dependencies:** Tasks 1 and 5.

### 7.1 Add the API

- [ ] Import `PerformanceReport` from `@main/performance/performance-types` using the existing alias style.
- [ ] Add to `ElectronAPI`:

```ts
performance: {
  getReport: () => Promise<PerformanceReport>
  capture: () => Promise<PerformanceReport>
  openLogFolder: () => Promise<{ success: boolean; path?: string; error?: string }>
}
```

- [ ] Implement each method using `ipcRenderer.invoke` with exactly the three channel names from Task 5.
- [ ] Keep the API under `contextBridge.exposeInMainWorld('electronAPI', ...)`; do not expose filesystem, raw log text, shell, or arbitrary paths.
- [ ] Ensure the global `Window.electronAPI` declaration resolves to the same `ElectronAPI` type and does not introduce an `any` cast for performance methods.

### 7.2 Tests and acceptance

- [ ] Add a preload type/API test or extend the existing preload test setup to assert all three invoke channel names and return types.
- [ ] Run `pnpm --filter ./apps/windows typecheck` and the focused preload/main tests.

**Task acceptance:** Renderer code can call performance operations through one typed namespace, with no raw Electron or filesystem access.

---

## 8. Task 7: Build the Settings-Page Performance Diagnostics View

**Files:**

- Create `apps/windows/src/renderer/pages/SettingsPage/components/PerformanceDiagnostics/PerformanceDiagnostics.tsx`
- Create `apps/windows/src/renderer/pages/SettingsPage/components/PerformanceDiagnostics/PerformanceDiagnostics.module.css`
- Create `apps/windows/src/renderer/pages/SettingsPage/components/PerformanceDiagnostics/PerformanceDiagnostics.test.tsx`
- Create `apps/windows/src/renderer/pages/SettingsPage/components/PerformanceDiagnostics/index.ts`
- Modify `apps/windows/src/renderer/pages/SettingsPage/SettingsPage.tsx:1030-1061`
- Reuse visual/interaction patterns from `SecurityLogViewer.tsx`, existing Button/Toast/clipboard utilities, and existing Settings CSS conventions

**Dependencies:** Tasks 1, 5, and 6.

### 8.1 Component state and data flow

- [ ] On mount, call `window.electronAPI.performance.getReport()` once; do not read files, poll continuously, or request raw events from renderer.
- [ ] Keep only `report`, `loading`, `capturing`, `error`, and a short-lived action status in component state; do not add global state or a new settings store entry.
- [ ] Add a `刷新报告` action that calls `getReport` and preserves the previous report while loading.
- [ ] Add an `立即采集` action that calls `capture`, disables itself during capture, and displays the returned sample time/result.
- [ ] Add a `复制脱敏报告` action that formats a compact JSON/summary from the report after removing path/pid/raw error fields. Use the existing clipboard pattern and show success/failure Toast.
- [ ] Add an `打开性能日志目录` action calling `openLogFolder`; use the existing Toast pattern for `{success:false}`.

### 8.2 Display requirements

- [ ] Show monitoring health: enabled/disabled, writable/not writable, log directory availability without exposing the full path in the main summary, dropped event count, and parse error count.
- [ ] Show the latest startup run: total duration, `ready-to-show`, backend completion, and each available startup phase with duration and failed status.
- [ ] Show one table for the seven selected IPC channels with count, errors, slow count, approximate p95, and max duration. Show an explicit “暂无数据” state for channels with no samples.
- [ ] Show main RSS/current delta and child-process memory grouped by process type. Show unavailable metrics as “不可用”, not zero.
- [ ] Show explicit loading, empty, disabled, not-writable, parse-warning, request-failure, capture-in-progress, and action-failure states. The panel must never render as an unexplained blank block.
- [ ] Do not show raw event JSON, error message, token/key/cookie, command content, prompt, response, URL query, or arbitrary filesystem path.
- [ ] Keep the component inside the existing “隐私与数据” category after `SecurityLogViewer` or the adjacent system log section; do not add a new settings category, route, tab, or chart dependency.
- [ ] Use stable compact layout, existing design tokens, and accessible labels/disabled states. Do not add decorative cards or a dashboard-style new page.

### 8.3 Component tests before implementation and acceptance

- [ ] Test initial loading and successful report rendering.
- [ ] Test empty report, disabled monitor, unwritable log, parse warning, and rejected `getReport` states.
- [ ] Test refresh, capture success/failure, copy success/failure, and open-folder success/failure actions.
- [ ] Test sensitive fields do not appear in rendered text or clipboard payload.
- [ ] Test the component is mounted under the existing privacy section and does not change the category list.
- [ ] Run `pnpm --filter ./apps/windows exec vitest run src/renderer/pages/SettingsPage/components/PerformanceDiagnostics`.

**Task acceptance:** A normal user can open the existing settings page, see whether monitoring works, inspect startup/IPC/memory data, trigger a fresh sample, copy a safe report, and open the exact performance log folder without manual JSONL parsing.

---

## 9. Task 8: Full Closed-Loop Verification and Performance Guardrails

**Files:**

- No new production files.
- Update only the relevant tests from Tasks 1-7 if verification exposes a contract defect.
- Do not modify the design document or unrelated application modules as part of verification.

**Dependencies:** Tasks 1-7.

### 9.1 Automated verification

- [ ] Run focused tests:

```powershell
pnpm --filter ./apps/windows exec vitest run src/main/performance src/renderer/pages/SettingsPage/components/PerformanceDiagnostics
```

- [ ] Run the broader Windows test suite:

```powershell
pnpm --filter ./apps/windows test
```

- [ ] Run type checking:

```powershell
pnpm --filter ./apps/windows typecheck
```

- [ ] Run the production build:

```powershell
pnpm --filter ./apps/windows build
```

- [ ] Run `git diff --check` and inspect the final diff for accidental edits to `file-logger.ts`, full IPC registrations, package dependencies, or unrelated settings categories.

### 9.2 Manual closed-loop verification

- [ ] Start a production-like Windows app with monitoring enabled and capture the startup logs directory path from the monitor report, not from assumptions.
- [ ] Open `设置 > 隐私与数据 > 性能诊断`; confirm the panel shows a completed or in-progress startup report and a writable health state.
- [ ] Trigger at least one `agent-runtime:command`, one provider action, and one screen-record or voice action available in the test environment; confirm the corresponding selected channel counters update.
- [ ] Use the “立即采集” action; confirm main and child memory values refresh and a `memory.snapshot` event appears in the separate JSONL file.
- [ ] Exercise one known failing selected IPC call; confirm the business error behavior remains unchanged and the performance report increases `errorCount` without exposing the error message.
- [ ] Use “复制脱敏报告”; paste into a temporary text area and verify it contains timings/counts but no Token, Key, Cookie, prompt, response, command content, URL query, pid, or log path.
- [ ] Use “打开性能日志目录”; confirm the OS opens the monitor directory and the current `performance-YYYY-MM-DD.jsonl` exists when monitoring is enabled and writable.
- [ ] Restart the app; confirm the report can load recent startup history from the newest seven files and a malformed line does not make the settings panel fail.
- [ ] Set `LUMII_PERF_LOG=0`, restart, and confirm no performance directory/file is created and the settings panel explicitly says monitoring is disabled.
- [ ] Make the performance directory unwritable or inject a writer failure in a test build; confirm app startup, selected IPC, settings rendering, and quit still work while health reports not writable.

### 9.3 Quantitative guardrails

- [ ] Compare enabled/disabled cold-start measurements over at least five runs using the same build and environment; the enabled median startup increase must be no more than `2%`.
- [ ] Compare enabled/disabled idle RSS after the same warm-up period; the enabled median increase must be no more than `10 MB`.
- [ ] Verify normal selected IPC calls do not create one JSONL line per call; only aggregate, slow, error, startup, memory, and health-capacity events are present.
- [ ] Verify shutdown does not wait indefinitely for the writer and no unhandled rejection is emitted by the monitor.

**Task acceptance:** The feature is accepted only when automated checks pass and the complete user-visible loop works: data is collected, independently persisted, queried by main IPC, displayed in Settings, manually captured, safely copied, and opened for follow-up analysis.

---

## 10. Implementation Order and Commit Boundaries

Execute tasks in this order because each later boundary consumes a contract from the previous one:

1. Task 1: types and pure aggregation.
2. Task 2: monitor, writer, history and memory adapters.
3. Task 3: startup lifecycle and shutdown integration.
4. Task 4: seven explicit IPC wrappers.
5. Task 5: main query/capture/open-folder handlers.
6. Task 6: preload API.
7. Task 7: Settings diagnostics UI.
8. Task 8: full verification and manual closed-loop acceptance.

After each task, create one focused commit with a message matching the task, for example `perf: add performance aggregation contract`, `perf: add resilient performance monitor`, `perf: instrument startup phases`, and so on. Do not combine renderer work with monitor internals or unrelated cleanup.

## 11. Drift Prevention Checklist

- [ ] Before implementation, confirm the seven channel names and phase names match this file and `docs/design/性能优化/性能监控与调用耗时统计方案.md`.
- [ ] Before every IPC edit, verify the target is an explicit `ipcMain.handle` registration listed in Task 4; no shared/global IPC helper may be changed.
- [ ] Before every path edit, verify the implementation calls existing `paths.ts` exports and does not reimplement portable path detection.
- [ ] Before every renderer edit, verify the new component remains under the existing privacy category and calls only `window.electronAPI.performance`.
- [ ] Before declaring completion, verify `readErrorCount` exists in the type, report, health UI, and malformed-line test; verify `openLogFolder` exists in main IPC, preload, renderer action, and manual check.
- [ ] Search the final diff for `console.log`, raw `error.message`, raw IPC args, prompt/response fields, arbitrary path parameters, `ipcMain.handle =`, and unbounded arrays in performance code.
- [ ] Search for unfinished markers, placeholder text, and copied duplicate performance interfaces; none are allowed in the completed implementation.
