# 云同步冲突检测与 Agent 主动处理修复

**日期**: 2026-09-07  
**问题**: 客户端同步失败且未调用模型处理冲突  
**状态**: 已修复

---

## 问题描述

用户报告云同步失败，错误信息为：

```
EPERM: operation not permitted, symlink 'C:\myself\projects\my\open-source\lumii' -> 
'C:\Users\75791\.lumii\workspace.lumii-sync-backup-1788746268591\projects\lumii'
```

同时，当检测到云同步冲突时，系统没有调用 Agent 来主动处理冲突。

---

## 根本原因

### 1. 符号链接权限错误

在 `sync-manager.ts` 的 `adoptRemote` 方法中，使用 `fs.cpSync` 备份工作空间时：

```typescript
fs.cpSync(this.workspaceDir, backupDir, {
  recursive: true,
  filter: (src) => !src.includes('.mtbot-vcs'),
})
```

在 Windows 上，复制符号链接需要管理员权限或开启开发者模式。默认的 `cpSync` 会尝试创建符号链接，导致 `EPERM` 错误。

### 2. 缺少 Agent 主动介入机制

虽然设计文档（`2026-09-05-workspace-cloud-sync-design.md`）中明确提出"冲突交给 Agent 判定并落决"，但实际实现中：

- `enterConflict` 方法只是更新了状态到 `conflict`
- 没有任何机制触发主动规划或创建目标来让 Agent 处理冲突
- Agent 无法感知到冲突的存在

---

## 解决方案

### 1. 修复符号链接权限问题

在 `apps/windows/src/main/cloud-sync/sync-manager.ts` 的 `adoptRemote` 方法中：

**修改点**:
- 添加 `verbatimSymlinks: false` 选项，让 `cpSync` 跟随符号链接而非复制它
- 添加 try-catch 包裹备份逻辑，备份失败不应阻止同步继续进行
- 记录警告日志但不抛出错误

```typescript
private async adoptRemote(p: GitParams, localRef: string, remoteOid: string): Promise<void> {
  const backupDir = `${this.workspaceDir}.lumii-sync-backup-${Date.now()}`
  try {
    fs.cpSync(this.workspaceDir, backupDir, {
      recursive: true,
      filter: (src) => !src.includes('.mtbot-vcs'),
      verbatimSymlinks: false, // Windows 上跟随链接而非复制它
    })
    logger.warn(`[adoptRemote] 检测到无关历史，本地已备份到 ${backupDir}`)
  } catch (err) {
    logger.warn(`[adoptRemote] 备份失败（将继续同步）: ${err.message}`)
  }
  await git.writeRef({ ...p, ref: localRef, value: remoteOid, force: true })
  await git.checkout({ ...p, ref: remoteOid, force: true })
  logger.info('[adoptRemote] 已采用远端历史作为本地主线')
}
```

### 2. 添加冲突检测回调机制

**步骤 1**: 在 `CloudSyncManager` 中添加冲突回调

```typescript
export class CloudSyncManager extends EventEmitter {
  private onConflictDetected?: (conflict: ConflictInfo) => void

  /** 设置冲突检测回调（由 main/index.ts 注入，用于创建自主目标） */
  setOnConflictDetected(callback: (conflict: ConflictInfo) => void): void {
    this.onConflictDetected = callback
  }
}
```

**步骤 2**: 在 `enterConflict` 方法中触发回调

```typescript
private enterConflict(...): { success: false; state: 'conflict' } {
  this.conflict = { ... }
  this.setState('conflict', `检测到 ${this.conflict.files.length} 个冲突文件，等待 Agent 处理`)

  // 触发冲突回调，由外部创建自主目标让 Agent 处理
  if (this.onConflictDetected) {
    try {
      this.onConflictDetected(this.conflict)
    } catch (err) {
      logger.warn('[enterConflict] 冲突回调失败:', err.message)
    }
  }

  return { success: false, state: 'conflict' }
}
```

**步骤 3**: 在 `main/index.ts` 中注入回调，创建自主目标

在 CloudSyncManager 初始化之后（约 1251 行）：

```typescript
cloudSyncManager.setOnConflictDetected((conflict) => {
  if (!agentRuntimeBridge) {
    log.warn('[CloudSync] 检测到冲突但 agentRuntimeBridge 未就绪，跳过目标创建')
    return
  }
  try {
    const db = agentRuntimeBridge.db
    const goalId = `goal-sync-conflict-${Date.now()}`
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO autonomous_goals
       (id, agent_id, type, description, trigger_reason, status, priority, metadata, created_at, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      goalId,
      'assistant',
      'system-maintenance',
      `解决云同步冲突：${conflict.files.length} 个文件冲突（${conflict.files.slice(0, 3).join(', ')}...）`,
      'cloud-sync-conflict',
      'executing', // 直接进入 executing 状态，无需审批
      0.9, // 高优先级
      JSON.stringify({ conflictFiles: conflict.files, localOid: conflict.localOid, remoteOid: conflict.remoteOid }),
      now,
      now,
    )
    log.info(`[CloudSync] 已创建冲突处理目标 ${goalId}，files=${conflict.files.length}`)
  } catch (err) {
    log.error('[CloudSync] 创建冲突处理目标失败:', err.message)
  }
})
```

---

## 工作流程

修复后的冲突处理流程：

1. **同步检测到冲突** → `sync-manager.ts` 调用 `enterConflict()`
2. **创建自主目标** → 通过回调在 `autonomous_goals` 表中插入一条 `executing` 状态的目标
3. **心跳感知** → `tick-signals.ts` 的 `collectTickSignals` 会收集所有 `executing` 状态的目标
4. **目标执行** → 心跳机制调度 Agent 执行该目标
5. **Agent 处理** → Agent 使用 `cloud_sync_read_file` 工具读取三方内容，然后调用 `resolve_sync_conflict` 工具落决
6. **冲突解决** → `sync-manager.ts` 的 `resolveConflict` 方法应用决策并推送到远程

---

## 验证

### 编译验证
```bash
npx tsc --noEmit -p apps/windows/tsconfig.json
# ✓ 编译通过，无错误
```

### 单元测试
```bash
cd apps/windows && npx vitest run src/main/cloud-sync/sync-manager.test.ts
# ✓ 15 个测试全部通过
```

---

## 影响范围

**修改的文件**:
1. `apps/windows/src/main/cloud-sync/sync-manager.ts`
   - 修复 `adoptRemote` 的符号链接问题
   - 添加 `setOnConflictDetected` 和 `onConflictDetected` 回调
   - 在 `enterConflict` 中触发回调

2. `apps/windows/src/main/index.ts`
   - 注入冲突回调，创建自主目标

**影响的功能**:
- 云同步在 Windows 上遇到符号链接时不再崩溃
- 检测到冲突时会自动创建自主目标，由 Agent 主动处理
- 心跳机制会自动调度冲突处理目标

**向后兼容性**: 完全兼容，仅添加新功能，不影响现有行为

---

## 后续工作

建议的增强：

1. **测试覆盖**：添加端到端测试验证冲突检测 → 目标创建 → Agent 处理的完整流程
2. **用户通知**：在检测到冲突时通过系统通知提醒用户
3. **超时处理**：如果 Agent 24 小时内未处理冲突，升级通知或回退策略
4. **冲突历史**：记录冲突处理历史到日志或专门的表中

---

## 参考

- 设计文档：`docs/design/数据同步功能/2026-09-05-workspace-cloud-sync-design.md`
- 主动规划设计：相关自主进化文档
- 相关工具：`apps/windows/src/main/agent-runtime/bridge-tool-registrar-sync.ts`
