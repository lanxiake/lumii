import type { BackgroundToolConfig, BackgroundToolRunner } from '@mtbot/agent-runtime'

import { agentRuntimeLog as log } from '../bridge-utils'
import { followComfyJob, parseEnqueuedPromptId, resolveComfyBaseUrl } from '../comfyui-job-follower'
import type { McpManager } from '../mcp-manager'
import type { BackgroundTaskManager } from '../background-task-manager'

/** 后台任务看门狗上限：超过判定失败（一个回合不可能等这么久） */
const BACKGROUND_TASK_MAX_MS = 60 * 60 * 1000

/**
 * 后台工具配置的构造依赖。
 *
 * 从 `AgentRuntimeBridge` 里抽出来：这段逻辑只用这五个成员，却和 4500 行的门面
 * 绑在一起，既不能单独测，也没法被别的宿主复用。
 */
export interface BackgroundToolConfigDeps {
  /** MCP 管理器（未就绪时为 null） */
  getMcpManager: () => McpManager | null
  /** 后台任务管理器（惰性创建） */
  getBackgroundTaskManager: () => BackgroundTaskManager
  /**
   * 当前正在执行工具的实例 ID。
   * ToolExecutionContext 是共享的、不带 instanceId，真实调用者靠这个引用标记。
   */
  currentToolExecutorInstanceIdRef: { value: string | undefined }
  /** 实例 ID → 根会话 key */
  instanceToRootSessionKey: Map<string, string>
  /** taskId → 中断控制器（取消与看门狗共用） */
  backgroundTaskAborts: Map<string, AbortController>
}

/**
 * 构造后台工具策略与执行器。
 *
 * 语义要点（迁自 bridge，未改动）：
 * - 只有 MCP 声明的「后台工具」才走 detach 路径，其余同步执行；
 * - 每个后台任务独立 AbortController + 看门狗，任务活过回合结束；
 * - ComfyUI「入队即返回」时继续跟进到真正出片，再终结任务并唤醒 Agent；
 * - 用户中断/看门狗触发时，顺手撤掉 ComfyUI 侧任务（尽力而为）。
 */
export function buildBackgroundToolConfig(deps: BackgroundToolConfigDeps): BackgroundToolConfig {
  const policy = {
    shouldBackground: (toolName: string): boolean =>
      deps.getMcpManager()?.getBackgroundToolNames().has(toolName) ?? false,
  }

  const runner: BackgroundToolRunner = {
    run: ({ toolName, label, instanceId, execute }) => {
      const manager = deps.getBackgroundTaskManager()
      const ownerId = instanceId ?? deps.currentToolExecutorInstanceIdRef.value
      const sessionKey = ownerId ? deps.instanceToRootSessionKey.get(ownerId) : undefined
      const taskId = manager.start({ instanceId: ownerId, sessionKey, toolName, label })

      // 每个后台任务一个独立中断控制器：任务活过回合结束，可单独取消，看门狗兜底
      const controller = new AbortController()
      deps.backgroundTaskAborts.set(taskId, controller)
      const watchdogMs = BACKGROUND_TASK_MAX_MS
      const watchdog = setTimeout(() => {
        if (!deps.backgroundTaskAborts.has(taskId)) return
        log.warn(`[background-task] 看门狗超时，判定失败 task=${taskId}`)
        deps.backgroundTaskAborts.delete(taskId)
        controller.abort()
        manager.fail(taskId, `后台任务超过 ${Math.round(watchdogMs / 60000)} 分钟未返回，已中止`)
      }, watchdogMs)

      const settle = (apply: () => void): void => {
        clearTimeout(watchdog)
        deps.backgroundTaskAborts.delete(taskId)
        apply()
      }

      // detached：真实执行不阻塞本轮；结束后回填任务并（终态）唤醒 Agent
      void (async () => {
        let comfyJob: { promptId: string; serverName: string } | undefined
        try {
          const result = await execute(controller.signal)
          const text = extractToolResultText(result)
          log.info(`[background-task] 执行返回 task=${taskId} isError=${result.isError ?? false}`)

          const promptId = result.isError ? null : parseEnqueuedPromptId(text)
          const server = promptId ? deps.getMcpManager()?.findServerForTool(toolName) : undefined
          if (promptId && server) {
            comfyJob = { promptId, serverName: server.name }
            log.info(`[background-task] 跟进 ComfyUI 任务 task=${taskId} prompt_id=${promptId}`)
            manager.update(taskId, `ComfyUI 已入队（prompt_id=${promptId}）`)
            const outcome = await followComfyJob({
              promptId,
              callTool: (tool, args) => deps.getMcpManager()!.callTool(server.name, tool, args),
              signal: controller.signal,
              baseUrl: resolveComfyBaseUrl(server.env),
              onProgress: (note) => manager.update(taskId, `${note}（prompt_id=${promptId}）`),
            })
            settle(() => {
              log.info(
                `[background-task] ComfyUI 任务结束 task=${taskId} ok=${outcome.ok} outputs=${outcome.outputs.length}`,
              )
              if (outcome.ok) manager.complete(taskId, outcome.text || text, { outputs: outcome.outputs })
              else manager.fail(taskId, outcome.text)
            })
            return
          }

          settle(() => {
            if (result.isError) manager.fail(taskId, text || '工具执行失败')
            else manager.complete(taskId, text)
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // 用户中断 / 看门狗：顺手撤掉 ComfyUI 侧的任务（排队中撤队列、渲染中打断），尽力而为
          if (controller.signal.aborted && comfyJob) {
            const { promptId, serverName } = comfyJob
            for (const action of ['cancel_queued', 'cancel'] as const) {
              void deps
                .getMcpManager()
                ?.callTool(serverName, 'queue', { action, prompt_id: promptId })
                .catch(() => {})
            }
          }
          settle(() => {
            log.warn(`[background-task] 执行异常 task=${taskId}: ${message}`)
            manager.fail(taskId, message)
          })
        }
      })()
      return taskId
    },
  }

  return { policy, runner }
}

/** 从工具结果里抽纯文本（后台任务的产出摘要来源） */
function extractToolResultText(result: {
  content?: readonly { type?: string; text?: string }[]
}): string {
  return (result.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
    .trim()
}
