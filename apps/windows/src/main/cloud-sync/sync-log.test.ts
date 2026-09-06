/**
 * sync-log 单元测试：环形缓冲（最多 100 条）、持久化、非法数据容错。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { _resetWindowsClientDataRootCacheForTest } from '../client-data-root'
import { appendSyncLog, loadSyncLogs, MAX_SYNC_LOGS } from './sync-log'

describe('sync-log', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-sync-log-'))
    process.env.LUMII_CLIENT_DATA_DIR = tmpDir
    _resetWindowsClientDataRootCacheForTest()
  })

  afterEach(() => {
    delete process.env.LUMII_CLIENT_DATA_DIR
    _resetWindowsClientDataRootCacheForTest()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('缺文件时返回空数组', () => {
    expect(loadSyncLogs()).toEqual([])
  })

  it('追加后可读回，状态与消息一致', () => {
    appendSyncLog('idle', '首次推送完成')
    appendSyncLog('error', '同步失败')
    const logs = loadSyncLogs()
    expect(logs).toHaveLength(2)
    expect(logs[0]).toMatchObject({ state: 'idle', message: '首次推送完成' })
    expect(logs[1]).toMatchObject({ state: 'error', message: '同步失败' })
  })

  it(`超过 ${MAX_SYNC_LOGS} 条时丢弃最旧`, () => {
    for (let i = 0; i < MAX_SYNC_LOGS + 20; i++) {
      appendSyncLog(i % 2 === 0 ? 'idle' : 'syncing', `msg-${i}`)
    }
    const logs = loadSyncLogs()
    expect(logs).toHaveLength(MAX_SYNC_LOGS)
    expect(logs[0].message).toBe('msg-20')
    expect(logs[logs.length - 1].message).toBe(`msg-${MAX_SYNC_LOGS + 19}`)
  })
})
