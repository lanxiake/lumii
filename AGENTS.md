# 仓库协作与代码规范

本文是 Lumii 的贡献者总纲。所有提交、代码审查和自动化代理都应遵循本文件；专题细节见 [`docs/standards/`](docs/standards/README.md)。若规范与现有实现冲突，先确认运行时行为和测试，再在变更说明中记录取舍。

## 规范大纲

1. **项目结构**：按 `apps/windows`（Electron 应用）与 `packages/*`（共享库）划分职责；主进程、preload、renderer 通过明确边界通信。
2. **代码编写**：使用 TypeScript，2 空格缩进；变量、函数使用 `camelCase`，类型、类、React 组件使用 `PascalCase`；文件名沿用所在目录的命名风格。优先复用现有工具，避免无必要的抽象和依赖。
3. **架构边界**：通用 Agent、记忆、工具逻辑放入 `packages/agent-runtime`；Electron 专属逻辑放入 `apps/windows/src/main`。`packages/pet-core` 必须保持纯 TypeScript，不得依赖 React、Electron、Pixi 或 DOM。
4. **组件与界面**：组件保持单一职责；页面必须处理加载、空数据、错误和成功状态；UI 变更遵循可访问性、键盘操作和现有设计令牌。
5. **功能开发**：新增 IPC 必须同步更新 main handler、preload `ElectronAPI` 类型/方法和 renderer 调用方；跨层变更先写清数据流和错误处理。
6. **测试与验证**：单元/集成测试使用 Vitest，端到端测试使用 Playwright；测试文件命名为 `*.test.ts(x)`，与被测代码就近放置。提交前至少运行相关包测试与类型检查——**动过 `src/main/**` 就必须跑 `apps/windows` 全量**（`test:all`；默认的 `test` 只覆盖 `src/test/`，全绿是假象）。
7. **文档与提交**：多阶段工作先查 [`docs/README.md`](docs/README.md)（文档中心：目录导航、文档产出规范、按任务找文档）与 `docs/plans/`；提交使用简洁的 Conventional Commit 风格，如 `refactor(agent-runtime): ...`、`chore: ...`。PR 需说明影响、验证命令和配置/Windows 特殊要求，UI 改动附截图或录屏。

## 常用命令

```bash
pnpm install       # 安装依赖并重建原生模块
pnpm dev           # 启动 Electron 开发环境（Windows / Linux；Linux 自动处理沙箱，见下）
pnpm typecheck     # 全 workspace 类型检查
pnpm build         # 构建应用
pnpm dist:win      # 打包 Windows（NSIS / portable / zip）
pnpm dist:linux    # 打包 Linux（AppImage + deb，须在 Linux 上执行）
pnpm --filter ./apps/windows test        # 单测：只覆盖 src/test/（快，改渲染层够用）
pnpm --filter ./apps/windows test:all    # 全量：含 src/main/** 与 src/renderer/**，改主进程必跑
pnpm --filter ./packages/agent-runtime test
pnpm --filter ./packages/pet-core test
```

## Linux 构建

**必须在 Linux 上构建**（原生模块按目标平台编译，不能交叉打包），且**固定 Node 22**（`engines: >=22.5`；仓库 CI 基线为 22）。

```bash
node -v             # 必须是 22.x
pnpm install
pnpm dist:linux     # 产物在 apps/windows/release/
pnpm --filter ./apps/windows package:linux:deb   # 只要 deb
```

**运行产物的三个前提**：

- **AppImage 需要 FUSE**：Ubuntu 24.04 默认不装 `libfuse2`，直接运行会报 `dlopen(): error loading libfuse.so.2`。
  装 `sudo apt install libfuse2t64`，或临时用 `./Lumii-*.AppImage --appimage-extract-and-run`。
- **deb 已自带沙箱修复**：`postinst` 会把 `chrome-sandbox` 设为 `root:root 4755`。这是 Ubuntu 24.04 必需的一步
  （默认 `kernel.apparmor_restrict_unprivileged_userns=1`，Chromium 只能走 setuid sandbox）。
- **浏览器控制需要本机装 Chrome 系浏览器**：`BrowserService` 通过 CDP 控制**本机已有**的
  Chrome / Edge / Brave / Chromium（探测顺序见 `packages/browser-control/src/browser/chrome.executables.ts`，
  含 `/usr/bin/*` 与 `/snap/bin/*`）。**Ubuntu 桌面默认只装 Firefox，因此开箱不可用**——
  `browser_navigate` 会直接报 `No supported browser found`。
  装一个即可：`sudo snap install chromium`（24.04 上 chromium 只以 snap 分发）。
  应用另有一个 CloakBrowser 反检测浏览器兜底（`plugin-bootstrap.ts` 启动时后台下载），
  但它从 GitHub 镜像拉取，国内网络实测 0.02–0.08 MB/s，**不能当作可依赖的自动方案**。
  也可在浏览器配置里用 `executablePath` 手工指定任意 Chromium 系可执行文件。

**开发期（`pnpm dev`）不需要上述手工步骤**：`scripts/run-dev.cjs` 检测 `chrome-sandbox` 是否已正确配置，
未配置时自动追加 electron-vite 的 `--noSandbox` 并打印提示（仅开发期；发布产物由 deb 的 postinst 保证）。

**平台包声明注意**：`apps/windows` 有自己的 `node_modules`（electron-builder 的打包根），平台相关的
optional 包（`@img/sharp-*`、`sherpa-onnx-*`、`onnxruntime-node`）**必须显式声明为 `apps/windows` 的
`optionalDependencies`**——只在 `packages/*` 声明或被 pnpm hoist 到仓库根，打包时会静默丢失。

**测试基线（2026-09-15，Windows 口径）**：`test:all` 全量应**无失败**（此前 6 个既有失败已修正）。仅在满载跑序下有个别 30 秒超时/摆动位——`main/workspace-vcs/vcs-repo`（`diffCommits`）、`main/perf/performance-monitor`（日志轮转）、`main/perf/performance-ipc`（慢调用计时）、`test/components/WikiGraphView`（subtopic 点击）、`main/pet/pet-model-resolver`；**单跑这些文件通过即视为摆动**，不是新引入的问题。另：vitest 请在包目录下执行，在仓库根跑会命中 root 配置（缺 jest-dom setup），组件测试会以 `expect is not defined` 假失败。

**测试基线（2026-09-20，Linux 口径）**：Ubuntu 上 `test:all` = **1 failed / 2712 passed / 52 skipped**，唯一失败是 `test/main/qwen3-tts-client`（依赖 Windows 内嵌 Python，链路已由 Linux 移植 D15 移出范围）。**两个口径不矛盾，引用时须写明平台**。其余平台差异已在 T3.8 参数化处理。

**写 `main/**` 单测的两个坑**：
- mock **Node 内置模块**（`node:child_process` 等）时，仓库默认的 `environment: 'jsdom'` 会让
  `vi.mock` **对被测模块不生效**——spy 计数恒为 0，模块内跑的是真实实现，**测试静默假绿**。
  在该测试文件加 `/** @vitest-environment node */` 即恢复（见 `local-proxy.test.ts`、`shell-runner.test.ts`）。
  **判据**：mock 了内置模块就必须验证 mock 真命中（变异测试或断言调用次数非零）。
- 断言平台专属行为（Windows 路径、盘符、PowerShell 命令）时用「按平台取样例 / 按平台断言」，
  不要硬编码 `C:\...`——POSIX 上 `path.resolve` 会把盘符当相对路径，`path.delimiter` 也会串味。
  确实只在一端有意义的用例用 `it.skip`，**Windows 用例不要为了 Linux 变绿而删除**。

## 专题规范

按任务阅读 [`docs/standards/README.md`](docs/standards/README.md) 中对应的结构、代码风格、组件/UI、页面模板、功能开发或架构文档。不要复制专题内容到本文件；新增规范先更新索引，再补充专题文档。

## 安全与配置

不得提交密钥、用户数据、数据库、构建产物或发布包。运行时数据默认位于 `~/.lumii`，本地调试可使用 `LUMII_CLIENT_DATA_DIR` 覆盖。升级依赖前检查 `pnpm.overrides` 与 `patches/`。
