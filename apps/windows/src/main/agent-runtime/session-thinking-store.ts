/**
 * 全局思考偏好落盘
 *
 * 渠道会话、心跳/cron、后台维护这些「没有对话页会话」的实例也要跟随用户
 * 在对话页的思考开关，而它们可能在渲染进程推送之前就启动（如开机心跳），
 * 所以主进程必须自己持久化一份，而不是只依赖内存里的会话级偏好。
 */

import fs from 'node:fs'
import path from 'node:path'
import { resolveWindowsClientDataRoot } from '../client-data-root.js'
import {
  DEFAULT_SESSION_THINKING_PREFS,
  type SessionThinkingPrefs,
} from './bridge-session-thinking-prefs.js'

function storeFilePath(): string {
  return path.join(resolveWindowsClientDataRoot(), 'config', 'session-thinking.json')
}

/** 读取落盘的全局思考偏好；文件缺失或损坏时返回 undefined（调用方用默认值） */
export function loadStoredThinkingPrefs(): SessionThinkingPrefs | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFilePath(), 'utf8')) as Partial<SessionThinkingPrefs>
    return {
      thinkingEnabled: raw?.thinkingEnabled ?? DEFAULT_SESSION_THINKING_PREFS.thinkingEnabled,
      reasoningEffort:
        raw?.reasoningEffort === 'max'
          ? 'max'
          : DEFAULT_SESSION_THINKING_PREFS.reasoningEffort,
    }
  } catch {
    return undefined
  }
}

/** 落盘全局思考偏好（失败不影响本次运行，下次变更会再写） */
export function saveStoredThinkingPrefs(prefs: SessionThinkingPrefs): void {
  try {
    const file = storeFilePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(prefs, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
}
