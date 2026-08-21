# Repository Guidelines

## Project Structure & Module Organization

Lumii is a pnpm workspace monorepo. The Windows Electron application lives in
`apps/windows/`: `src/main` contains the Electron main process, `src/preload`
contains the context-bridge API, and `src/renderer` contains the React UI.
Shared TypeScript libraries live under `packages/`, including `agent-runtime`,
`browser-control`, and `pet-core`. Tests normally sit beside their source files
as `*.test.ts` or `*.test.tsx`. Put design notes and implementation plans in
`docs/`; reusable bundled skills belong in `apps/windows/bundled-skills/`.

## Build, Test, and Development Commands

Run commands from the repository root unless noted otherwise:

- `pnpm install` installs workspace dependencies and rebuilds native modules.
- `pnpm dev` starts the Windows Electron development app.
- `pnpm typecheck` runs TypeScript checks across all workspaces.
- `pnpm build` builds the Windows application.
- `pnpm dist` creates the Windows distribution under `apps/windows/release/`.
- `pnpm --filter ./apps/windows lint` runs ESLint for the app.
- `pnpm --filter ./apps/windows test` runs the app's Vitest suite.
- `pnpm --filter ./packages/agent-runtime test` runs runtime package tests.
- `pnpm --filter ./packages/pet-core test` runs pet-core tests.

## Coding Style & Naming Conventions

Use TypeScript with 2-space indentation, semicolons, and the existing ESLint and
Prettier-compatible style. Use `camelCase` for variables/functions,
`PascalCase` for React components and classes, and descriptive kebab-case file
names where that matches the surrounding directory. Preserve the `@/`,
`@main/`, `@renderer/`, and `@shared/` aliases. Keep `packages/pet-core` free of
React, Electron, Pixi, and DOM dependencies.

## Testing Guidelines

Use Vitest for unit and integration tests and Playwright for end-to-end tests.
Name tests after the behavior under test, colocate them with source files, and
run the narrowest relevant package or file command before the full workspace
checks. Changes to IPC, preload APIs, or renderer contracts should include
coverage for both sides of the boundary.

## Commit & Pull Request Guidelines

Follow the repository's conventional history, for example
`refactor(agent-runtime-ipc): extract runtime handlers` or
`chore: update documentation`. Keep commits focused and use an imperative
subject. Pull requests should explain the user-visible or architectural impact,
link the relevant issue or plan in `docs/plans/`, list validation commands, and
include screenshots or recordings for UI changes. Call out native-module,
Windows-only, or configuration requirements explicitly.

## Security & Configuration Tips

Do not commit secrets, local databases, build output, or generated release
artifacts. Runtime data defaults to `~/.lumii`; use `LUMII_CLIENT_DATA_DIR` for
local overrides. Check existing dependency overrides and patches before
upgrading locked packages.
