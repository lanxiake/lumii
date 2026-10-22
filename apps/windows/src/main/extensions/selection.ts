import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../kernel/events'
import type { AgentRuntimeBridge } from '../agent-runtime'

/**
 * 划词动作扩展（翻译/解释/总结/润色）。
 *
 * ## 架构定位
 *
 * 内建插件,可禁用。禁用后:
 * - 划词动作 IPC (`selection:run` / `selection:abort`) 不可用
 * - 渲染层划词浮层应隐藏或禁用
 * - 右键菜单不显示划词相关选项
 *
 * ## 依赖与时序
 *
 * - **Agent Runtime Bridge**: 需要 `resolveSelectionChatStream()` 获取模型配置
 * - **激活时机**: IPC 注册器初始化时调用（`ipc-handlers-registry.ts`）
 *
 * ## 核心逻辑
 *
 * 1. **划词 LLM 服务** (`selection-llm.ts`):
 *    - 单轮非流式调用（首字节之前排队，流式治不了排队）
 *    - 支持按 requestId 取消在飞的请求
 *    - 不记录 prompt 或输出到日志（选中文本是用户隐私）
 *
 * 2. **IPC 注册** (`selection-ipc.ts`):
 *    - `selection:run`: 一次调用拿完整结果
 *    - `selection:abort`: 按 requestId 取消请求
 *
 * 3. **渲染层集成**:
 *    - 划词浮层：`renderer/components/Selection/SelectionPopup.tsx`
 *    - 右键菜单：context menu 中的划词动作项
 *
 * ## P1 vs P2
 *
 * - **P1**（包装式）：只声明插件，IPC 注册仍在 `ipc-handlers-registry.ts` L169
 * - **P2**（IPC 迁移式，当前实现）：IPC 注册逻辑迁移到插件内，导出 `registerSelectionIpc` 函数
 *   - 禁用插件 = 不注册 IPC，划词动作不可用（真正的热插拔）
 *   - 原调用点（`ipc-handlers-registry.ts` L169）**必须删除**，否则重复注册
 *
 * ## 迁移检查清单
 *
 * - [x] 创建插件文件（`extensions/selection.ts`）
 * - [x] 导出 `registerSelectionIpc` 函数，迁移 IPC 注册逻辑
 * - [x] 复用 `ipc/selection-ipc.ts` 的注册函数
 * - [ ] 删除原调用点（`ipc-handlers-registry.ts` L54, L169）
 * - [ ] 验证：禁用插件后划词动作不可用
 * - [ ] 验证：启用插件后划词动作正常工作
 */
export const selectionExtension = {
  manifest: {
    id: 'com.lumii.selection',
    name: '划词动作',
    version: '0.2.0',
    description: '选中文本后的快捷动作（翻译/解释/总结/润色）',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.selection',
    provides: ['selection'],
    apply(ctx) {
      ctx.log.info('划词动作插件已启动')
    },
  }),
}

/** Selection IPC 注册依赖 */
export interface SelectionIpcDeps {
  getAgentRuntimeBridge: () => AgentRuntimeBridge | null
}

/**
 * 注册划词动作 IPC（从 ipc-handlers-registry.ts 迁移）。
 *
 * 由 IPC 注册器在初始化时调用。
 */
export function registerSelectionIpc(deps: SelectionIpcDeps): void {
  const { registerSelectionIpcHandlers } = require('../ipc/selection-ipc')
  registerSelectionIpcHandlers(deps)
}
