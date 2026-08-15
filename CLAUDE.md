# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

灵栖 Lumii —— 本地优先的 Windows 桌面 AI 伙伴（Electron + React + TypeScript）。对话、Agent/技能执行、定时任务、语音、Live2D 桌宠、浏览器自动化全部跑在本机，无自建后端、无登录，模型服务商在客户端直连（direct-stream）。

pnpm workspace monorepo，唯一应用是 `apps/windows`，其余为 `packages/*` 共享库（源码直出 `.ts`，不预编译）。

## 常用命令

根目录：

```bash
pnpm install              # postinstall 会为 Electron 重建 better-sqlite3 / sharp
pnpm dev                  # 前台开发（electron-vite dev）
pnpm dev:start            # 后台起 dev，日志写 .lumii-dev.log，PID 写 .lumii-dev.pid
pnpm dev:stop             # 停止后台 dev
pnpm dev:restart          # = start-dev.ps1 -Force
pnpm typecheck            # 全 workspace 递归类型检查
pnpm build                # electron-vite build
pnpm dist                 # 打包 Windows 安装包，产物在 apps/windows/release/
```

`apps/windows` 内：

```bash
pnpm lint                 # eslint . --ext .ts,.tsx
pnpm typecheck            # tsc --noEmit
pnpm test                 # vitest run src/test
npx vitest run src/test/components/ChatPage.test.tsx   # 单文件
npx vitest run -t "会话切换"                            # 单用例
pnpm test:e2e             # playwright（当前只指向 e2e/memory/memory-management.spec.ts）
pnpm lab                  # 桌宠 Live2D 调试沙盒（pet-lab/）
pnpm package:nsis | package:portable | package:zip     # 单独打包目标
```

注意 `vitest.config.ts` 的 include 是 `src/**/*.test.ts(x)`，而 `pnpm test` 只跑 `src/test`。`src/main/**` 下的同目录测试（如 `coding-dev-env.test.ts`）需显式 `npx vitest run src/main`。`packages/*` 各自有 `pnpm test`。

## 架构

### 三进程边界

- `apps/windows/src/main` — Electron 主进程。所有能力（文件、shell、SQLite、渠道登录、技能执行、浏览器）都在这里。`main/index.ts` 是巨型入口（3000+ 行）：窗口/托盘/IPC 注册全在其中。
- `apps/windows/src/preload/index.ts` — 唯一 contextBridge 出口，导出 `ElectronAPI` 接口（1700+ 行）。**新增一条 IPC 必须三处同步**：main 侧 handler、preload 的 `ElectronAPI` 方法与类型、renderer 调用点。
- `apps/windows/src/renderer` — React 18 + Vite。按页面组织（`pages/ChatPage`、`AgentsPage`、`SkillsPage`、`CronPage`、`MemoriesPage`、`SettingsPage`、`PluginCenterPage`、`FilesPage`、`DashboardPage`），无 Redux，靠 contexts + hooks。
- `apps/windows/src/shared` — 双侧共用的类型与命令/事件常量（`agent-runtime-commands.ts`、`agent-runtime-events.ts`、`pet-mode.ts`、`voice-*.ts`）。

### Agent 运行时（核心）

`packages/agent-runtime` 在客户端本地驱动 `@mariozechner/pi-agent-core` 的 Agent 循环，包含 LLM 路由（`llm/`，direct-stream 直连服务商）、工具（`tools/`）、技能（`skill/`）、记忆（`memory/`）、上下文压缩（`compact/`）、权限与沙箱（`security/`、`shell/`）。对外只从 `src/index.ts` 导出。

`apps/windows/src/main/agent-runtime/` 是这个包与 Electron 的桥接层，按 `bridge-*.ts` 切分职责（`bridge-instance-factory` 建实例、`bridge-tool-registrar` 注册工具、`bridge-prompt-dispatcher` 派发、`bridge-agent-instance-events` 事件流、`bridge-context-compactor` 压缩、`cron-scheduler` croner 定时任务）。renderer 通过 `src/main/ipc/agent-runtime-ipc.ts` 与之通信。

改 Agent 行为前先判断层次：模型/工具/记忆等通用逻辑进 `packages/agent-runtime`，只与 Electron/桌面相关的进 `main/agent-runtime`。

### 其他包

- `packages/protocol` — gateway 协议类型门面（TypeBox/AJV），`packages/client-sdk` 的请求-响应关联依赖它。
- `packages/client-sdk` — 传输无关的 gateway 客户端原语（`gateway-client.ts`、`request-registry.ts`）。gateway 是可选的远程通道，本地模式不需要。
- `packages/pet-core` — 纯 TS 桌宠逻辑（状态机、表情/动作策略、口型同步、模型配置），**不得引入 react/electron/pixi/DOM 依赖**。渲染在 `apps/windows/src/renderer/pet`（pixi.js 6 + pixi-live2d-display 0.4，版本锁死）。

### 技能系统

技能是磁盘上的 `SKILL.md` + 脚本目录。`apps/windows/bundled-skills/` 为随包内置技能，首启由 `bundled-skills-seeder.ts` 播种到用户数据目录；`apps/windows/skills/` 是开发期技能源。运行链路：`skill-store` → `skill-parser`/`skill-md-frontmatter` → `skill-runtime` → `skill-sandbox`，执行器有 `python-runner`/`ts-runner`/`shell-runner`，`skill-watcher` 负责热更新。策略见 [BUNDLED_SKILLS_STRATEGY.md](apps/windows/docs/BUNDLED_SKILLS_STRATEGY.md)。

### 渠道接入

`src/main/channel/adapters/` 下的飞书、企业微信、微信适配器均为可选，各自有 `*-login-service.ts` + `*-session-store.ts`。微信适配器体量最大（`weixin-login-service.ts` 50KB+），改动前先读完整流程。

## 需要留意的约定

- **数据根目录**：代码里是 `~/.lumii`（`src/main/client-data-root.ts`，可用 `LUMII_CLIENT_DATA_DIR` 覆盖）。README 与 `.env.example` 仍写着旧的 `~/.mtbot-client`/`MTBOT_*`，属遗留文案，以代码为准。
- **workspace 包不外部化**：`electron.vite.config.ts` 用绝对路径 alias 把 `@mtbot/*` 指向包内 `src/index.ts` 并从 externalize 名单里排除，这样才能直接打 TS 源码。加新包时两处都要改。
- **Electron 兼容补丁**：`electronCompatPlugin` 处理 undici 的 `require("node:sqlite")` 与缺失的全局 `File`。碰到打包期 `node:sqlite` / `File is not defined`，先看这个插件。
- **依赖锁版本**：`pnpm.overrides` 钉住 `@mariozechner/pi-ai@0.50.7` 并打了补丁（`patches/`），升级需同步重做补丁。`playwright-core` 在 app 与 browser-control 中必须同版本。
- **原生模块**：改动 better-sqlite3 / sharp 相关依赖后跑 `pnpm rebuild:native`。
- **Windows 控制台编码**：dev 入口 `scripts/run-dev.cjs` 与 `scripts/*.ps1` 都会切 UTF-8 代码页，PowerShell 脚本注释保持 ASCII（PS 5.1 无 BOM 解析问题）。
- **路径别名**：`@/`、`@main/`、`@renderer/`、`@shared/`，在 tsconfig、electron.vite.config、vitest.config 三处各自声明。
- 代码注释与文档以中文为主，沿用现有风格。

## 计划文档

`docs/plans/` 存放带日期的设计与实施文档（如 `2026-08-05-ui-tech-refresh-client-implementation.md`），做多阶段改动前先看是否已有对应计划。
