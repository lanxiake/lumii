import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../kernel/events'

/**
 * VCS（版本控制）扩展。
 *
 * ## 架构定位
 *
 * 内建插件,可禁用。禁用后:
 * - VCS IPC (`vcs:ensureInit` / `vcs:commit` / `vcs:log` / `vcs:statusDiff` / `vcs:diff` / `vcs:restore`) 不可用
 * - 工作空间快照功能不可用
 * - 渲染层 VCS 相关 UI（版本历史/差异查看）应隐藏或禁用
 *
 * ## 依赖与时序
 *
 * - **工作空间目录**: VCS 操作需要 `getWorkspaceDir()` 定位工作空间根目录
 * - **日志系统**: 用于输出 VCS 操作的警告和错误
 * - **激活时机**: IPC 注册器初始化时调用（`ipc-handlers-registry.ts`）
 *
 * ## 核心逻辑
 *
 * 1. **VCS 快照** (`workspace-vcs/vcs-snapshot.ts`):
 *    - 基于 isomorphic-git 的 Git 仓库管理
 *    - 自动初始化工作空间 Git 仓库
 *    - 支持提交、日志查询、状态差异、文件还原
 *
 * 2. **IPC 注册** (`ipc/vcs-ipc.ts`):
 *    - `vcs:ensureInit`: 确保 Git 仓库已初始化
 *    - `vcs:commit`: 提交当前工作空间状态
 *    - `vcs:log`: 查询提交历史
 *    - `vcs:statusDiff`: 查询当前状态与指定提交的差异
 *    - `vcs:diff`: 查询两个提交之间的差异
 *    - `vcs:restore`: 从指定提交恢复文件
 *
 * 3. **渲染层集成**:
 *    - 工作空间管理页面调用 VCS IPC 查询版本历史
 *    - 差异查看器调用 VCS IPC 获取文件差异
 *
 * ## P1 vs P2
 *
 * - **P1**（包装式）：只声明插件，IPC 注册仍在 `ipc-handlers-registry.ts` L164
 * - **P2**（IPC 迁移式，当前实现）：IPC 注册逻辑迁移到插件内，导出 `registerVcsIpc` 函数
 *   - 禁用插件 = 不注册 IPC，VCS 功能不可用（真正的热插拔）
 *   - 原调用点（`ipc-handlers-registry.ts` L164）**必须删除**，否则重复注册
 *
 * ## 迁移检查清单
 *
 * - [x] 创建插件文件（`extensions/vcs.ts`）
 * - [x] 导出 `registerVcsIpc` 函数，迁移 IPC 注册逻辑
 * - [x] 复用 `ipc/vcs-ipc.ts` 的 setDeps + register 函数
 * - [ ] 删除原调用点（`ipc-handlers-registry.ts` L106-109, L164）
 * - [ ] 验证：禁用插件后 VCS IPC 不可用
 * - [ ] 验证：启用插件后 VCS 功能正常工作
 */
export const vcsExtension = {
  manifest: {
    id: 'com.lumii.vcs',
    name: 'VCS 版本控制',
    version: '0.2.0',
    description: '工作空间 Git 版本控制（快照/历史/差异/还原）',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.vcs',
    provides: ['vcs'],
    apply(ctx) {
      ctx.log.info('VCS 插件已启动')
    },
  }),
}

/** VCS IPC 注册依赖 */
export interface VcsIpcDeps {
  getWorkspaceDir: () => string
  log: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
  }
}

/**
 * 注册 VCS IPC（从 ipc-handlers-registry.ts 迁移）。
 *
 * 由 IPC 注册器在初始化时调用。
 */
export function registerVcsIpc(deps: VcsIpcDeps): void {
  // 直接复用原有的注册逻辑
  const { setVcsIpcDeps, registerVcsIpcHandlers } = require('../ipc/vcs-ipc')
  setVcsIpcDeps(deps)
  registerVcsIpcHandlers()
}
