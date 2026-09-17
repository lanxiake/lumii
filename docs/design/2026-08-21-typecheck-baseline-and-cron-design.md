# Typecheck Baseline And Cron IPC Design

## Goal

Make `pnpm typecheck` pass for every workspace, repair the extracted cron IPC
handlers against the current `AgentRuntimeBridge` contract, and make Windows
builds run typechecking first.

## Scope

1. Fix real TypeScript contract errors in the workspace packages and Windows
   application. Do not weaken compiler options, use `any`, or suppress errors.
2. Align `cron-commands.ts` with `CronScheduler` through the public bridge:
   create and update use the required single parameter objects; manual run uses
   `runCronJobManually`; history uses `listLocalCronRuns` and its actual row
   shape.
3. Add focused cron handler tests for create, update, manual run, and history.
4. Add a Windows `prebuild` lifecycle script which runs `pnpm typecheck`.

## Order

Fix shared workspace packages first, then Windows-only errors, then cron IPC.
The final checks are the focused cron tests, `pnpm typecheck`, and `pnpm build`.

## Constraints

Existing uncommitted IPC changes remain untouched except where necessary for
the requested cron and typecheck work. The build gate is deliberately a native
npm lifecycle hook; no CI framework or dependency is added.
