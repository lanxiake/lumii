/**
 * 权限类 Agent Runtime 事件转发到渲染进程。
 *
 * @mtbot/agent-runtime 的 AgentRuntimeEvent 联合类型可能未覆盖全部权限子类型，
 * 运行时仍可能收到这些事件，故在此用宽松结构按 type 字符串分发。
 */

import type { AgentRuntimeEvent } from '@mtbot/agent-runtime'
import type { AgentRuntimeEvent as IpcEvent } from '../../shared/agent-runtime-events'
import type { BridgeRendererIpcChannel } from './bridge-renderer-ipc'

/** 权限事件在运行时携带的公共字段（宽松结构） */
type LoosePermissionPayload = {
  type: string
  requestId?: string
  toolName?: string
  toolArgs?: unknown
  riskLevel?: string
  description?: string
  timeoutMs?: number
}

/**
 * 审批**有结果**后广播解除事件（用户响应 / 超时 / 自动放行 / 停止时批量拒绝）。
 *
 * 与上面那族不同：那些转发的是**内核**事件，这个由宿主在
 * `bridge-instance-factory` 的 `requestPermission` 出口主动发出——那条路径是
 * 全部审批出口的汇合点（自动放行 / 渠道回复 / 审批卡 / 原生对话框 / 超时）。
 * 消费方（宠物多会话记账、pet-core 的 L1 状态机）靠它解除 waiting，
 * 详见 `AgentPermissionResolvedEvent` 的注释。
 */
export function forwardPermissionResolved(
  ipc: BridgeRendererIpcChannel,
  input: {
    readonly requestId: string
    readonly toolName: string
    readonly instanceId?: string
    readonly rootSessionKey?: string
    readonly decision: 'allow-once' | 'allow-always' | 'deny'
  },
): void {
  ipc.forwardIpcEvent({
    type: input.decision === 'deny' ? 'agent:permission:denied' : 'agent:permission:granted',
    requestId: input.requestId,
    toolName: input.toolName,
    instanceId: input.instanceId,
    rootSessionKey: input.rootSessionKey,
  })
}

/**
 * 将权限相关事件按类型转发为 IPC 新格式事件
 */
export function forwardPermissionRuntimeToIpc(
  ipc: BridgeRendererIpcChannel,
  instanceId: string,
  event: AgentRuntimeEvent,
): void {
  const p = event as unknown as LoosePermissionPayload
  const t = p.type
  if (t === 'agent:permission:granted') {
    ipc.forwardIpcEvent({
      type: 'agent:permission:granted',
      instanceId,
      requestId: p.requestId!,
      toolName: p.toolName!,
      toolArgs: p.toolArgs,
    } as unknown as IpcEvent)
    return
  }
  if (t === 'agent:permission:denied') {
    ipc.forwardIpcEvent({
      type: 'agent:permission:denied',
      instanceId,
      requestId: p.requestId!,
      toolName: p.toolName!,
      toolArgs: p.toolArgs,
    } as unknown as IpcEvent)
    return
  }
  if (t === 'agent:permission:timeout') {
    ipc.forwardIpcEvent({
      type: 'agent:permission:timeout',
      instanceId,
      requestId: p.requestId!,
      toolName: p.toolName!,
      toolArgs: p.toolArgs,
    } as unknown as IpcEvent)
    return
  }
  if (t === 'agent:permission:cancelled') {
    ipc.forwardIpcEvent({
      type: 'agent:permission:cancelled',
      instanceId,
      requestId: p.requestId!,
      toolName: p.toolName!,
      toolArgs: p.toolArgs,
    } as unknown as IpcEvent)
    return
  }
  if (t === 'agent:permission:prompt') {
    ipc.forwardIpcEvent({
      type: 'agent:permission:prompt',
      instanceId,
      requestId: p.requestId!,
      toolName: p.toolName!,
      toolArgs: p.toolArgs,
      riskLevel: p.riskLevel,
      description: p.description,
      timeoutMs: p.timeoutMs,
    } as unknown as IpcEvent)
    return
  }
  if (t === 'agent:permission:prompt:cancelled') {
    ipc.forwardIpcEvent({
      type: 'agent:permission:prompt:cancelled',
      instanceId,
      requestId: p.requestId!,
      toolName: p.toolName!,
      toolArgs: p.toolArgs,
    } as unknown as IpcEvent)
    return
  }
  if (t === 'agent:permission:prompt:denied') {
    ipc.forwardIpcEvent({
      type: 'agent:permission:prompt:denied',
      instanceId,
      requestId: p.requestId!,
      toolName: p.toolName!,
      toolArgs: p.toolArgs,
    } as unknown as IpcEvent)
    return
  }
  if (t === 'agent:permission:prompt:granted') {
    ipc.forwardIpcEvent({
      type: 'agent:permission:prompt:granted',
      instanceId,
      requestId: p.requestId!,
      toolName: p.toolName!,
      toolArgs: p.toolArgs,
    } as unknown as IpcEvent)
    return
  }
  if (t === 'agent:permission:prompt:timeout') {
    ipc.forwardIpcEvent({
      type: 'agent:permission:prompt:timeout',
      instanceId,
      requestId: p.requestId!,
      toolName: p.toolName!,
      toolArgs: p.toolArgs,
    } as unknown as IpcEvent)
    return
  }
}
