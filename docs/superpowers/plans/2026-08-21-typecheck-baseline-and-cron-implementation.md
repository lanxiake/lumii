# Typecheck Baseline And Cron IPC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every workspace typecheck pass and repair cron IPC against its current bridge contract.

**Architecture:** Correct contracts at their defining boundary instead of weakening TypeScript. The cron handler stays a thin translator over `AgentRuntimeBridge`; it generates task IDs locally, delegates execution to the scheduler, and maps scheduler history rows into the shared IPC response. A native npm `prebuild` hook makes the existing typecheck script a mandatory build prerequisite.

**Tech Stack:** TypeScript 5, pnpm workspaces, Vitest, Electron Vite.

**Spec:** `docs/superpowers/specs/2026-08-21-typecheck-baseline-and-cron-design.md`

## Global Constraints

- Do not weaken compiler options, use `any`, or add TypeScript suppressions.
- Do not add dependencies for the build gate.
- Preserve unrelated uncommitted IPC extraction work.
- Verify each workspace with its own existing `pnpm --filter <package> typecheck` command before the final root check.

---

### Task 1: Repair Browser-Control Type Contracts

**Files:**
- Modify: `packages/browser-control/src/browser/{bridge-server,server,client-fetch,profiles-service}.ts`
- Modify: `packages/browser-control/src/browser/{chrome,server-context,pw-tools-core.interactions,pw-tools-core.storage}.ts`
- Modify: `packages/browser-control/package.json` only if a currently imported direct dependency is absent from its declared dependencies.
- Test: existing browser-control tests nearest each modified module.

**Interfaces:**
- Consumes: exports actually present in `config.ts` and `control-service.ts`.
- Produces: `pnpm --filter @mtbot/browser-control typecheck` exits 0.

- [ ] **Step 1: Record the failing browser-control check**

Run: `pnpm --filter @mtbot/browser-control typecheck`

Expected: errors identify stale route/config imports, missing DOM globals in browser-evaluated callbacks, and optional numeric values.

- [ ] **Step 2: Restore imports from current module owners**

Replace stale imports with the names actually exported by their owner modules. If routes were intentionally removed, delete the unused server entry points rather than recreating an obsolete route layer. Declare `express` only if the retained code directly imports it.

- [ ] **Step 3: Make browser-evaluated callbacks self-contained and typed**

Pass browser globals through Playwright evaluation callbacks or use local DOM callback types; do not add DOM types to Node-wide compilation merely to hide the errors.

- [ ] **Step 4: Handle optional ports at their validation boundary**

Validate ports before passing them to functions requiring `number`; retain the existing defaulting semantics in `chrome.ts` and `server-context.ts`.

- [ ] **Step 5: Run the package check**

Run: `pnpm --filter @mtbot/browser-control typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit the browser-control repair**

```powershell
git add packages/browser-control
git commit -m "fix(browser-control): restore type-safe browser contracts"
```

### Task 2: Repair Agent-Runtime Message Typing

**Files:**
- Modify: `packages/agent-runtime/src/compact/strategies/micro-compact.ts:307`
- Test: existing compact strategy test file, if present.

**Interfaces:**
- Consumes: `AgentMessage` discriminated union from the runtime package.
- Produces: a valid assistant message construction without an unsafe assertion.

- [ ] **Step 1: Write or extend a compact-strategy test**

Cover the branch which reconstructs an assistant message with tool calls and assert the output retains the tool-call identifiers and arguments.

- [ ] **Step 2: Run the focused test and confirm its current failure**

Run the colocated Vitest file with `pnpm --filter @mtbot/agent-runtime exec vitest run <file>`.

Expected: the current reconstructed message is rejected by TypeScript or fails its expected output assertion.

- [ ] **Step 3: Construct the union member with its real discriminator**

Build the appropriate assistant-message type rather than asserting the full object as `AgentMessage`; retain only fields supported by that member.

- [ ] **Step 4: Run focused and package verification**

Run: `pnpm --filter @mtbot/agent-runtime typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit the agent-runtime repair**

```powershell
git add packages/agent-runtime
git commit -m "fix(agent-runtime): type compacted tool-call messages"
```

### Task 3: Repair Windows Application Type Baseline

**Files:**
- Modify only files reported by `pnpm --filter lumii-windows typecheck` after Tasks 1-2.
- Test: colocated tests already named in the error output.

**Interfaces:**
- Consumes: current controller, bridge, Electron, renderer, and shared command declarations.
- Produces: `pnpm --filter lumii-windows typecheck` exits 0 without changing public command semantics.

- [ ] **Step 1: Categorize errors by defining API**

Group the Windows errors into stale test mocks, bridge/controller contract drift, Electron optional values, renderer import declarations, and feature-specific type mismatches. Read the defining types before changing call sites.

- [ ] **Step 2: Repair stale test mocks first**

Update mocks to satisfy required controller methods and correct Vitest call argument inspection. Keep test assertions behavioral; do not cast partial mocks to full production types.

- [ ] **Step 3: Repair production contract drift at its owner**

For each production error, align calls with current function signatures or make the producer return the documented union. Preserve nullability instead of coercing values to arbitrary defaults.

- [ ] **Step 4: Run affected focused tests after each owner change**

Run every modified colocated test with `pnpm --filter lumii-windows exec vitest run <file>`.

- [ ] **Step 5: Run the Windows check**

Run: `pnpm --filter lumii-windows typecheck`

Expected: exit 0 before starting the cron-specific task.

- [ ] **Step 6: Commit the Windows baseline repair**

```powershell
git add apps/windows
git commit -m "fix(windows): restore typecheck baseline"
```

### Task 4: Align Cron IPC With AgentRuntimeBridge

**Files:**
- Modify: `apps/windows/src/main/ipc/agent-runtime/cron-commands.ts`
- Create: `apps/windows/src/main/ipc/agent-runtime/cron-commands.test.ts`

**Interfaces:**
- Consumes: `AgentRuntimeBridge.createLocalCronJobRecord(params)`, `updateLocalCronJobRecord(params)`, `runCronJobManually(job)`, and `listLocalCronRuns(jobId, limit)`.
- Produces: handlers whose result shapes match `AgentRuntimeCommandResult` for every `cron:*` command.

- [ ] **Step 1: Write failing handler tests**

Create a typed fake bridge and cover: create supplies generated `id` and `createdAt`; update supplies one object containing `id`; run invokes `runCronJobManually` with the loaded row; runs maps `id`, `started_at`, `finished_at`, `duration_ms`, `summary`, and `error` to the shared `entries` shape.

- [ ] **Step 2: Run the focused test to verify failure**

Run: `pnpm --filter lumii-windows exec vitest run src/main/ipc/agent-runtime/cron-commands.test.ts`

Expected: current implementation fails because it calls missing bridge methods and returns mismatched run fields.

- [ ] **Step 3: Implement the smallest bridge-aligned handler changes**

Use `new Cron(...)`; generate `id` with `crypto.randomUUID()` and capture `createdAt`; call `updateLocalCronJobRecord({ id, ... })`; await `runCronJobManually`; call `listLocalCronRuns`; return the protocol's `entries` property and status model. Remove obsolete local run-record calls.

- [ ] **Step 4: Run focused cron verification**

Run: `pnpm --filter lumii-windows exec vitest run src/main/ipc/agent-runtime/cron-commands.test.ts`

Expected: pass.

- [ ] **Step 5: Commit the cron repair**

```powershell
git add apps/windows/src/main/ipc/agent-runtime/cron-commands.ts apps/windows/src/main/ipc/agent-runtime/cron-commands.test.ts
git commit -m "fix(agent-runtime-ipc): align cron commands with bridge"
```

### Task 5: Make Typechecking a Build Prerequisite

**Files:**
- Modify: `apps/windows/package.json`

**Interfaces:**
- Consumes: npm lifecycle `prebuild` and existing `typecheck` script.
- Produces: `pnpm --filter lumii-windows build` runs `tsc --noEmit` before Electron Vite.

- [ ] **Step 1: Add the native lifecycle hook**

Set `"prebuild": "pnpm typecheck"` beside the existing build script. Do not change the Electron Vite command or add a separate runner.

- [ ] **Step 2: Verify the build gate**

Run: `pnpm --filter lumii-windows build`

Expected: the output runs `typecheck` first, then completes Electron Vite build.

- [ ] **Step 3: Run full workspace verification**

Run: `pnpm typecheck`

Expected: every workspace check exits 0.

- [ ] **Step 4: Commit the build gate**

```powershell
git add apps/windows/package.json
git commit -m "build(windows): typecheck before bundling"
```

## Plan Self-Review

- Spec coverage: Tasks 1-3 clear the workspace baseline; Task 4 fixes every cron API mismatch with tests; Task 5 adds the native build gate.
- Placeholder scan: no deferred behavior or suppression-based workaround is proposed.
- Type consistency: Task 4 uses only public `AgentRuntimeBridge` methods and the shared `cron:runs` response property `entries`.
