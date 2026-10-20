import type { AgentRuntimeBridge } from '../agent-runtime/bridge'

/**
 * 渠道模块**内部**几处消费者需要的 Agent Runtime 能力（结构化子集）。
 *
 * 为什么不用整份 `AgentRuntimeBridge`：这几处只用十二个成员，却把 4500 行、
 * 135 个方法的门面整体拖进类型依赖；测试造假对象时也得满足全部方法。
 *
 * 用 `Pick` 而不是手抄签名：签名由 `AgentRuntimeBridge` 单点派生，方法改名这里
 * 直接编译报错，不会静默漂移。类名只出现在本文件的 import 里。
 *
 * **为什么渠道适配器不在范围内**：四个 adapter 都把 `this.bridge` 原样转交给
 * ACP 执行器（`coding-dev-acp-run.ts` 的 `startRun({ bridge })`），那里要的是整份
 * 门面。只收窄 adapter 会当场编译失败——它们把 bridge 当管道用，不是消费者。
 * 要收窄它们，得先把 ACP 执行器那条链也收窄，那是另一片。
 */
export type ChannelAgentGateway = Pick<
  AgentRuntimeBridge,
  // 交互中枢：中断、权限/提问应答、回调注册
  | 'abortSession'
  | 'resolvePermission'
  | 'resolveAskUserQuestion'
  | 'setChannelInteractionNotifier'
  | 'setChannelTextPusher'
  // 上下文策略：记忆水位判断与历史恢复
  | 'getDbMessageCount'
  | 'hasEmptyInstanceMemory'
  | 'isInstanceMemoryRicherThanDb'
  | 'restoreHistoryForInstance'
  | 'clearInstanceMemory'
  // 会话管理：压缩、驱动、在场状态
  | 'compactContextAsync'
  | 'prompt'
  | 'setInstancePresence'
>

