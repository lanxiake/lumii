import { describe, expect, it } from 'vitest'
import { BackgroundTaskManager } from './background-task-manager'
import {
  interpretComfyNote,
  reportBackgroundToolEnd,
  reportBackgroundToolStart,
  reportComfyEnqueued,
  reportComfyNote,
  reportTaskFailure,
  reportTaskSuccess,
} from './background-task-progress'

function makeManager(): BackgroundTaskManager {
  return new BackgroundTaskManager({
    emit: () => {},
    deliver: () => {},
    now: () => 1_000,
  })
}

describe('background-task-progress', () => {
  it('把排队和渲染文案映射到不同进度', () => {
    expect(interpretComfyNote('ComfyUI 排队中').progress).toBe(35)
    expect(interpretComfyNote('ComfyUI 渲染中')).toMatchObject({ progress: 70, active: '渲染' })
    expect(interpretComfyNote('其他').progress).toBe(15)
  })

  it('通用工具开始和成功结束会写进度、日志和里程碑', () => {
    const manager = makeManager()
    const taskId = manager.start({ toolName: 'mcp__demo__run', label: 'demo' })
    reportBackgroundToolStart(manager, taskId, 'mcp__demo__run')
    expect(manager.get(taskId)).toMatchObject({ progress: 10, currentStep: '执行中' })
    expect(manager.get(taskId)?.logs?.[0]?.message).toBe('开始执行 mcp__demo__run')

    reportBackgroundToolEnd(manager, taskId, true)
    expect(manager.get(taskId)?.progress).toBe(100)
    expect(manager.get(taskId)?.milestones?.every((milestone) => milestone.status === 'completed')).toBe(true)
  })

  it('ComfyUI 入队后按渲染文案推进，失败打在进行中的步骤上', () => {
    const manager = makeManager()
    const taskId = manager.start({ toolName: 'mcp__comfyui__enqueue_workflow', label: 'comfy' })
    reportBackgroundToolStart(manager, taskId, 'mcp__comfyui__enqueue_workflow')
    reportComfyEnqueued(manager, taskId, 'prompt-1')
    reportComfyNote(manager, taskId, 'ComfyUI 渲染中')
    expect(manager.get(taskId)?.progress).toBe(70)
    expect(manager.get(taskId)?.milestones?.find((milestone) => milestone.step === '渲染')?.status).toBe('in-progress')

    reportTaskFailure(manager, taskId, '渲染失败')
    const failed = manager.get(taskId)?.milestones?.find((milestone) => milestone.step === '渲染')
    expect(failed).toMatchObject({ status: 'failed', error: '渲染失败' })
    expect(manager.get(taskId)?.logs?.at(-1)?.level).toBe('error')
  })

  it('ComfyUI 成功结束把四段里程碑都标完成', () => {
    const manager = makeManager()
    const taskId = manager.start({ toolName: 'mcp__comfyui__enqueue_workflow', label: 'comfy' })
    reportComfyEnqueued(manager, taskId, 'prompt-2')
    reportTaskSuccess(manager, taskId)
    expect(manager.get(taskId)?.progress).toBe(100)
    expect(manager.get(taskId)?.milestones?.map((milestone) => milestone.status)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
    ])
  })
})
