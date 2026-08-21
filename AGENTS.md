# 仓库协作与代码规范

本文是 Lumii 的贡献者总纲。所有提交、代码审查和自动化代理都应遵循本文件；专题细节见 [`docs/standards/`](docs/standards/README.md)。若规范与现有实现冲突，先确认运行时行为和测试，再在变更说明中记录取舍。

## 规范大纲

1. **项目结构**：按 `apps/windows`（Electron 应用）与 `packages/*`（共享库）划分职责；主进程、preload、renderer 通过明确边界通信。
2. **代码编写**：使用 TypeScript，2 空格缩进；变量、函数使用 `camelCase`，类型、类、React 组件使用 `PascalCase`；文件名沿用所在目录的命名风格。优先复用现有工具，避免无必要的抽象和依赖。
3. **架构边界**：通用 Agent、记忆、工具逻辑放入 `packages/agent-runtime`；Electron 专属逻辑放入 `apps/windows/src/main`。`packages/pet-core` 必须保持纯 TypeScript，不得依赖 React、Electron、Pixi 或 DOM。
4. **组件与界面**：组件保持单一职责；页面必须处理加载、空数据、错误和成功状态；UI 变更遵循可访问性、键盘操作和现有设计令牌。
5. **功能开发**：新增 IPC 必须同步更新 main handler、preload `ElectronAPI` 类型/方法和 renderer 调用方；跨层变更先写清数据流和错误处理。
6. **测试与验证**：单元/集成测试使用 Vitest，端到端测试使用 Playwright；测试文件命名为 `*.test.ts(x)`，与被测代码就近放置。提交前至少运行相关包测试、类型检查和 lint。
7. **文档与提交**：多阶段工作先检查 `docs/plans/`；提交使用简洁的 Conventional Commit 风格，如 `refactor(agent-runtime): ...`、`chore: ...`。PR 需说明影响、验证命令和配置/Windows 特殊要求，UI 改动附截图或录屏。

## 常用命令

```bash
pnpm install       # 安装依赖并重建原生模块
pnpm dev           # 启动 Windows Electron 开发环境
pnpm typecheck     # 全 workspace 类型检查
pnpm build         # 构建 Windows 应用
pnpm --filter ./apps/windows lint
pnpm --filter ./apps/windows test
pnpm --filter ./packages/agent-runtime test
pnpm --filter ./packages/pet-core test
```

## 专题规范

按任务阅读 [`docs/standards/README.md`](docs/standards/README.md) 中对应的结构、代码风格、组件/UI、页面模板、功能开发或架构文档。不要复制专题内容到本文件；新增规范先更新索引，再补充专题文档。

## 安全与配置

不得提交密钥、用户数据、数据库、构建产物或发布包。运行时数据默认位于 `~/.lumii`，本地调试可使用 `LUMII_CLIENT_DATA_DIR` 覆盖。升级依赖前检查 `pnpm.overrides` 与 `patches/`。
