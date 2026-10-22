import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../../../main/kernel/events'
import { S } from '../../../main/kernel/services'
import { injectEvolutionGuidanceIntoResult } from './prompt-injector'
import type { SkillEvolutionService } from './service-api'

/**
 * 技能自进化扩展（已停用但保留）。
 *
 * ## 架构定位
 *
 * 内建插件，**默认禁用**。当前已停用但保留代码（9 个文件），等待产品决策是否重启。
 *
 * 禁用状态下：
 * - 技能自进化引擎不初始化
 * - 对话分析与技能草稿生成不触发
 * - 用户反馈与技能改进流程不可用
 *
 * ## 核心逻辑（当前未激活）
 *
 * 1. **对话观察器** (`conversation-observer.ts`):
 *    - 规则预筛（毫秒级，快速排除不值得提取的对话）
 *    - LLM 深度判断（只在预筛通过后调用）
 *
 * 2. **技能草稿器** (`skill-drafter.ts`):
 *    - 从对话中提取可复用的工作流
 *    - 生成 SKILL.md frontmatter + 步骤说明
 *    - 质量检查门禁（score 过低的草稿不询问用户）
 *
 * 3. **反馈管理器** (`feedback-manager.ts`):
 *    - 询问用户技能是否有用
 *    - 记录正向/部分/负向反馈
 *    - 累积负向反馈触发废弃建议
 *
 * 4. **技能改进器** (`skill-evolver.ts`):
 *    - 根据用户反馈生成改进方案
 *    - 自然语言 diff + 代码 patch
 *    - 用户确认后应用 patch
 *
 * 5. **技能写入器** (`skill-writer.ts`):
 *    - 将草稿写入 `~/.claude/skills/<category>/<name>.md`
 *    - 保存待审批草稿（`pending-drafts/`）
 *    - 技能元信息（version / trustScore / feedbackStats）
 *
 * ## 停用原因（2026-09）
 *
 * - 自主进化流程与当前 Agent 交互模式不匹配
 * - 询问用户是否保存技能的时机经常误触
 * - LLM 判断准确性不足，生成的技能草稿质量不稳定
 *
 * ## 重启路径（如果需要）
 *
 * 1. 移除 manifest 的 `disabled: true` 字段
 * 2. 恢复 `index.ts` 中的 `SkillEvolutionEngine` 构造点
 * 3. 恢复 bridge 的两个集成点：
 *    - `onTurnComplete()`：对话轮次结束后调用
 *    - `onUserMessage()`：用户消息到达时调用
 * 4. 全量回归测试（尤其是对话拦截逻辑，容易误伤正常对话）
 *
 * ## P1 vs P2
 *
 * - **P1**（包装式，当前实现）：只声明插件，标记 `disabled: true`，不激活任何功能
 * - **P2**（激活式，未实现）：移除 `disabled` 标记，恢复引擎初始化与事件订阅
 *
 * ## 迁移检查清单
 *
 * - [x] 创建插件文件（`extensions/skill-evolution.ts`）
 * - [x] 声明插件 manifest，设置 `disabled: true`
 * - [ ] 验证：守卫不对 `disabled: true` 的插件报告"代码不可达"
 * - [ ] 重启路径验证（如果产品决策重启）
 */
export const skillEvolutionExtension = {
  manifest: {
    id: 'com.lumii.skill-evolution',
    name: '技能自进化',
    version: '0.1.0',
    description: '自动从对话中提取可复用技能，收集反馈并改进（当前已停用）',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
    disabled: true,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.skill-evolution',
    provides: ['skill-evolution'],
    apply(ctx) {
      ctx.provide(S.skillEvolution, {
        injectInto: injectEvolutionGuidanceIntoResult,
      } satisfies SkillEvolutionService)

      ctx.log.info('技能自进化插件已声明（disabled=true，不初始化）')
      // 不初始化 SkillEvolutionEngine
      // 不订阅任何事件
      // 不注册任何 IPC
    },
  }),
}
