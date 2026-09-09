# 云同步v3实施计划

**基于设计文档**：`docs/superpowers/specs/2026-09-09-lightweight-cloud-sync-design.md`

**核心原则**：简单、实用、稳定 - 个人2-3设备同步场景

---

## 一、总体规划

### 1.1 实施阶段

| 阶段 | 任务 | 工作量 | 依赖 |
|------|------|--------|------|
| Phase 1 | Schema改动 + 数据迁移 | 0.5天 | 无 |
| Phase 2 | 导出器重构（jsonl + 锁） | 1天 | Phase 1 |
| Phase 3 | 导入器重构（统一merge） | 1天 | Phase 1 |
| Phase 4 | 同步流程调整（fetch→import→export） | 1天 | Phase 2, 3 |
| Phase 5 | 冲突解决简化 | 0.5天 | Phase 4 |
| Phase 6 | 旧格式迁移 | 0.5天 | Phase 2, 3 |
| Phase 7 | 测试验证 | 1天 | 全部 |

**总工作量**：约5.5天

---

## 二、Phase 1：Schema改动 + 数据迁移

### 2.1 目标

为4个表添加 `deleted_at` 字段，支持统一的软删除机制。

### 2.2 文件清单

**主文件**：
- `packages/agent-runtime/src/storage/schema.ts`
- `packages/agent-runtime/src/storage/migrations/` (新增迁移文件)

### 2.3 具体任务

#### 2.3.1 修改schema定义

```typescript
// schema.ts

// wiki_entities 表
export const wikiEntities = sqliteTable('wiki_entities', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  content: text('content'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
  deleted_at: integer('deleted_at', { mode: 'timestamp' }), // 新增
});

// wiki_relations 表
export const wikiRelations = sqliteTable('wiki_relations', {
  id: text('id').primaryKey(),
  source_id: text('source_id').notNull(),
  target_id: text('target_id').notNull(),
  relation_type: text('relation_type').notNull(),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
  deleted_at: integer('deleted_at', { mode: 'timestamp' }), // 新增
});

// wiki_syntheses 表
export const wikiSyntheses = sqliteTable('wiki_syntheses', {
  id: text('id').primaryKey(),
  entity_id: text('entity_id').notNull(),
  content: text('content'),
  status: text('status').notNull(), // 'pending' | 'completed'
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  finished_at: integer('finished_at', { mode: 'timestamp' }),
  deleted_at: integer('deleted_at', { mode: 'timestamp' }), // 新增
});

// agent_memories 表
export const agentMemories = sqliteTable('agent_memories', {
  id: text('id').primaryKey(),
  content: text('content').notNull(),
  importance: integer('importance').notNull(),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
  deleted_at: integer('deleted_at', { mode: 'timestamp' }), // 新增
});
```

#### 2.3.2 创建迁移脚本

```typescript
// packages/agent-runtime/src/storage/migrations/20260909_add_deleted_at_fields.ts

export async function up(db: Database) {
  // 添加 deleted_at 字段（默认NULL）
  await db.exec(`
    ALTER TABLE wiki_entities ADD COLUMN deleted_at INTEGER;
  `);
  
  await db.exec(`
    ALTER TABLE wiki_relations ADD COLUMN deleted_at INTEGER;
  `);
  
  await db.exec(`
    ALTER TABLE wiki_syntheses ADD COLUMN deleted_at INTEGER;
  `);
  
  await db.exec(`
    ALTER TABLE agent_memories ADD COLUMN deleted_at INTEGER;
  `);
  
  console.log('Migration: Added deleted_at fields to 4 tables');
}

export async function down(db: Database) {
  // SQLite不支持DROP COLUMN，需要重建表（生产环境慎用）
  console.warn('Rollback not supported for ALTER TABLE ADD COLUMN in SQLite');
}
```

#### 2.3.3 更新业务逻辑

**软删除方法**：

```typescript
// packages/agent-runtime/src/storage/wiki-repository.ts

export class WikiRepository {
  // 软删除entity
  async softDeleteEntity(id: string): Promise<void> {
    await this.db
      .update(wikiEntities)
      .set({ 
        deleted_at: new Date(),
        updated_at: new Date() 
      })
      .where(eq(wikiEntities.id, id))
      .execute();
  }
  
  // 查询时默认过滤已删除
  async getActiveEntities(): Promise<WikiEntity[]> {
    return this.db
      .select()
      .from(wikiEntities)
      .where(isNull(wikiEntities.deleted_at))
      .execute();
  }
  
  // 类似方法应用到 relations, syntheses, memories
}
```

### 2.4 验收标准

- [ ] Schema定义包含4个表的 `deleted_at` 字段
- [ ] 迁移脚本执行成功，现有数据库更新字段
- [ ] UI删除操作改为软删除（设置deleted_at）
- [ ] 查询默认过滤 `deleted_at IS NULL`
- [ ] 已删除数据在UI中不可见

---

## 三、Phase 2：导出器重构

### 3.1 目标

1. 从整包 `wiki/data.json` 改为分表 `*.jsonl` 格式
2. 实现 `exportWithLock()` - 数据库事务锁保护
3. 支持导出已删除记录（deleted_at非空）
4. 按id排序，保证稳定输出

### 3.2 文件清单

**主文件**：
- `apps/windows/src/main/cloud-sync/sync-exporter.ts`

### 3.3 具体任务

#### 3.3.1 删除旧的整包导出

```typescript
// sync-exporter.ts

// ❌ 删除这些旧代码
// export async function exportWikiData() {
//   const data = {
//     entities: await getEntities(),
//     relations: await getRelations(),
//     // ...
//   };
//   await fs.writeFile('wiki/data.json', JSON.stringify(data));
// }
```

#### 3.3.2 实现jsonl生成器

```typescript
// sync-exporter.ts

interface JsonlFile {
  path: string;      // 相对于sync根目录，如 'wiki/entities.jsonl'
  content: string;   // jsonl格式内容
}

/**
 * 生成jsonl文件内容
 */
function generateJsonlFiles(data: {
  memories: AgentMemory[];
  sources: WikiSource[];
  entities: WikiEntity[];
  observations: WikiObservation[];
  relations: WikiRelation[];
  syntheses: WikiSynthesis[];
}): JsonlFile[] {
  const files: JsonlFile[] = [];
  
  // memory/memories.jsonl
  const sortedMemories = data.memories.sort((a, b) => a.id.localeCompare(b.id));
  files.push({
    path: 'memory/memories.jsonl',
    content: sortedMemories.map(m => JSON.stringify(m)).join('\n')
  });
  
  // wiki/sources.jsonl
  const sortedSources = data.sources.sort((a, b) => a.id.localeCompare(b.id));
  files.push({
    path: 'wiki/sources.jsonl',
    content: sortedSources.map(s => JSON.stringify(s)).join('\n')
  });
  
  // wiki/entities.jsonl
  const sortedEntities = data.entities.sort((a, b) => a.id.localeCompare(b.id));
  files.push({
    path: 'wiki/entities.jsonl',
    content: sortedEntities.map(e => JSON.stringify(e)).join('\n')
  });
  
  // wiki/observations.jsonl
  const sortedObservations = data.observations.sort((a, b) => a.id.localeCompare(b.id));
  files.push({
    path: 'wiki/observations.jsonl',
    content: sortedObservations.map(o => JSON.stringify(o)).join('\n')
  });
  
  // wiki/relations.jsonl
  const sortedRelations = data.relations.sort((a, b) => a.id.localeCompare(b.id));
  files.push({
    path: 'wiki/relations.jsonl',
    content: sortedRelations.map(r => JSON.stringify(r)).join('\n')
  });
  
  // wiki/syntheses.jsonl
  const sortedSyntheses = data.syntheses.sort((a, b) => a.id.localeCompare(b.id));
  files.push({
    path: 'wiki/syntheses.jsonl',
    content: sortedSyntheses.map(s => JSON.stringify(s)).join('\n')
  });
  
  return files;
}
```

#### 3.3.3 实现带锁的导出

```typescript
// sync-exporter.ts

import { db } from '@agent-runtime/storage';

/**
 * 导出完整状态（带数据库锁保护）
 */
export async function exportWithLock(syncRootPath: string): Promise<void> {
  // 在事务中读取所有数据（阻止写入，时间<1秒）
  const files = await db.transaction(async (tx) => {
    // 查询所有表（包含已删除记录）
    // 注意：软删除记录也要导出，用于同步删除标记
    const memories = await tx.query.agentMemories.findMany({
      // 不过滤 deleted_at，全部导出
    });
    
    const sources = await tx.query.wikiSources.findMany({
      // archived_at 也全部导出
    });
    
    const entities = await tx.query.wikiEntities.findMany();
    
    const observations = await tx.query.wikiObservations.findMany({
      // retired_at 也全部导出
    });
    
    const relations = await tx.query.wikiRelations.findMany();
    
    const syntheses = await tx.query.wikiSyntheses.findMany();
    
    // 生成jsonl（内存操作，快速）
    return generateJsonlFiles({
      memories,
      sources,
      entities,
      observations,
      relations,
      syntheses
    });
  });
  
  // 事务结束，锁释放
  
  // 写文件到磁盘（事务外，不阻塞数据库）
  for (const file of files) {
    const fullPath = path.join(syncRootPath, file.path);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, file.content, 'utf-8');
  }
  
  console.log(`Exported ${files.length} jsonl files to ${syncRootPath}`);
}
```

### 3.4 验收标准

- [ ] 生成6个jsonl文件（memories, sources, entities, observations, relations, syntheses）
- [ ] 每个文件按id字典序排序
- [ ] 已删除记录（deleted_at非空）也被导出
- [ ] export期间数据库写入被阻塞（<1秒）
- [ ] 多次export输出稳定（相同数据生成相同文件）

---

## 四、Phase 3：导入器重构

### 4.1 目标

1. 从整包 `wiki/data.json` 改为分表 `*.jsonl` 读取
2. 实现统一的 `mergeByTimestamp()` 规则
3. 支持删除标记传播
4. 包在数据库事务中，保证原子性

### 4.2 文件清单

**主文件**：
- `apps/windows/src/main/cloud-sync/sync-importer.ts`

### 4.3 具体任务

#### 4.3.1 删除旧的整包导入

```typescript
// sync-importer.ts

// ❌ 删除这些旧代码
// export async function importWikiData() {
//   const data = await fs.readFile('wiki/data.json', 'utf-8');
//   const parsed = JSON.parse(data);
//   // INSERT OR REPLACE ...
// }
```

#### 4.3.2 实现统一merge规则

```typescript
// sync-importer.ts

interface MergeConfig {
  timestampField: string;  // 'updated_at' | 'created_at' | 'archived_at' | 'retired_at'
  deleteField: string;     // 'deleted_at' | 'archived_at' | 'retired_at'
}

/**
 * 统一的时间戳merge规则
 */
function shouldUseRemote(
  local: any | null,
  remote: any,
  config: MergeConfig
): boolean {
  if (!local) {
    return true;  // 本地无数据，采用远端
  }
  
  const localTs = new Date(local[config.timestampField]).getTime();
  const remoteTs = new Date(remote[config.timestampField]).getTime();
  
  if (remoteTs > localTs) {
    return true;  // 远端更新
  } else if (remoteTs < localTs) {
    return false; // 本地更新
  } else {
    // 时间戳相同，检查删除标记
    const localDeleted = local[config.deleteField];
    const remoteDeleted = remote[config.deleteField];
    
    if (remoteDeleted && !localDeleted) {
      return true;  // 优先传播删除
    }
    return false;   // 保持本地
  }
}
```

#### 4.3.3 实现jsonl导入

```typescript
// sync-importer.ts

import { db } from '@agent-runtime/storage';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * 导入远端数据到本地数据库
 */
export async function importFromJsonl(syncRootPath: string): Promise<void> {
  await db.transaction(async (tx) => {
    // 1. 导入 memories
    await importMemories(tx, syncRootPath);
    
    // 2. 导入 sources
    await importSources(tx, syncRootPath);
    
    // 3. 导入 entities
    await importEntities(tx, syncRootPath);
    
    // 4. 导入 observations
    await importObservations(tx, syncRootPath);
    
    // 5. 导入 relations
    await importRelations(tx, syncRootPath);
    
    // 6. 导入 syntheses
    await importSyntheses(tx, syncRootPath);
  });
  
  console.log('Import completed');
}

/**
 * 导入memories表
 */
async function importMemories(tx: Transaction, syncRootPath: string): Promise<void> {
  const filePath = path.join(syncRootPath, 'memory/memories.jsonl');
  
  if (!await fileExists(filePath)) {
    console.log('memories.jsonl not found, skip');
    return;
  }
  
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());
  
  for (const line of lines) {
    const remote = JSON.parse(line);
    
    // 查询本地记录
    const local = await tx.query.agentMemories.findFirst({
      where: eq(agentMemories.id, remote.id)
    });
    
    const config: MergeConfig = {
      timestampField: 'updated_at',
      deleteField: 'deleted_at'
    };
    
    if (shouldUseRemote(local, remote, config)) {
      // 使用远端数据
      if (local) {
        // 更新
        await tx.update(agentMemories)
          .set(remote)
          .where(eq(agentMemories.id, remote.id))
          .execute();
      } else {
        // 插入
        await tx.insert(agentMemories)
          .values(remote)
          .execute();
      }
    }
    // 否则保持本地不变
  }
  
  console.log(`Imported ${lines.length} memories`);
}

/**
 * 导入entities表（类似逻辑）
 */
async function importEntities(tx: Transaction, syncRootPath: string): Promise<void> {
  const filePath = path.join(syncRootPath, 'wiki/entities.jsonl');
  
  if (!await fileExists(filePath)) {
    return;
  }
  
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());
  
  for (const line of lines) {
    const remote = JSON.parse(line);
    const local = await tx.query.wikiEntities.findFirst({
      where: eq(wikiEntities.id, remote.id)
    });
    
    const config: MergeConfig = {
      timestampField: 'updated_at',
      deleteField: 'deleted_at'
    };
    
    if (shouldUseRemote(local, remote, config)) {
      if (local) {
        await tx.update(wikiEntities)
          .set(remote)
          .where(eq(wikiEntities.id, remote.id))
          .execute();
      } else {
        await tx.insert(wikiEntities)
          .values(remote)
          .execute();
      }
    }
  }
  
  console.log(`Imported ${lines.length} entities`);
}

// 类似实现 importSources, importObservations, importRelations, importSyntheses
// 注意各表的 timestampField 和 deleteField 不同：
// - sources: created_at, archived_at
// - observations: created_at, retired_at
// - relations: updated_at, deleted_at
// - syntheses: created_at, deleted_at
```

### 4.4 验收标准

- [ ] 能读取6个jsonl文件并解析
- [ ] 时间戳merge规则正确：远端新则更新，本地新则保持
- [ ] 删除标记正确传播（时间戳相同时优先远端删除）
- [ ] 整个导入在事务中，失败回滚
- [ ] 导入完成后UI显示最新数据

---

## 五、Phase 4：同步流程调整

### 5.1 目标

将sync流程从"export → fetch → merge → push → import"改为"fetch → import → export → push"

### 5.2 文件清单

**主文件**：
- `apps/windows/src/main/cloud-sync/sync-manager.ts`

### 5.3 具体任务

#### 5.3.1 修改syncInner流程

```typescript
// sync-manager.ts

export class SyncManager {
  async syncInner(): Promise<SyncResult> {
    try {
      // 1. 检查异常状态
      await this.checkAndCleanupMergeState();
      
      // 2. fetch远端
      console.log('Step 1: Fetching remote...');
      const fetchResult = await this.gitFetch();
      if (!fetchResult.success) {
        return { success: false, error: 'Fetch failed: ' + fetchResult.error };
      }
      
      // 3. import远端数据到数据库
      console.log('Step 2: Importing remote data to database...');
      await importFromJsonl(this.syncRootPath);
      
      // 4. export完整状态（已包含远端+本地merge结果）
      console.log('Step 3: Exporting merged state...');
      await exportWithLock(this.syncRootPath);
      
      // 5. 提交和推送
      console.log('Step 4: Committing and pushing...');
      await this.gitAdd();
      await this.gitCommit(`sync: merge and export at ${new Date().toISOString()}`);
      
      const pushResult = await this.gitPush();
      if (!pushResult.success) {
        if (pushResult.rejected) {
          // push被拒，说明远端有新提交，重试
          console.log('Push rejected, retrying...');
          return this.retrySync();
        }
        return { success: false, error: 'Push failed: ' + pushResult.error };
      }
      
      // 6. 检查是否有冲突（文本文件）
      const conflicts = await this.detectConflicts();
      if (conflicts.length > 0) {
        console.log(`Step 5: Resolving ${conflicts.length} conflicts...`);
        await this.resolveConflictsWithAgent(conflicts);
        await this.gitAdd();
        await this.gitCommit('sync: resolve conflicts');
        await this.gitPush();
      }
      
      return { success: true };
      
    } catch (error) {
      console.error('Sync failed:', error);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * 重试sync（最多3次）
   */
  private retryCount = 0;
  private async retrySync(): Promise<SyncResult> {
    if (this.retryCount >= 3) {
      return { success: false, error: 'Max retry reached' };
    }
    
    this.retryCount++;
    console.log(`Retry sync (${this.retryCount}/3)...`);
    
    // 回到步骤1重新开始
    return this.syncInner();
  }
  
  /**
   * 检查并清理MERGE_HEAD状态
   */
  private async checkAndCleanupMergeState(): Promise<void> {
    const mergeHeadPath = path.join(this.gitDir, 'MERGE_HEAD');
    if (await fileExists(mergeHeadPath)) {
      console.log('Detected MERGE_HEAD, aborting previous merge...');
      await this.gitExec('merge --abort');
    }
  }
  
  /**
   * Git操作封装
   */
  private async gitFetch(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.gitExec('fetch origin');
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  private async gitAdd(): Promise<void> {
    await this.gitExec('add .');
  }
  
  private async gitCommit(message: string): Promise<void> {
    await this.gitExec(`commit -m "${message}"`);
  }
  
  private async gitPush(): Promise<{ success: boolean; rejected: boolean; error?: string }> {
    try {
      await this.gitExec('push origin main');
      return { success: true, rejected: false };
    } catch (error) {
      if (error.message.includes('rejected')) {
        return { success: false, rejected: true };
      }
      return { success: false, rejected: false, error: error.message };
    }
  }
  
  private async gitExec(command: string): Promise<string> {
    // 执行git命令
    const { stdout, stderr } = await exec(`git -C "${this.syncRootPath}" ${command}`);
    if (stderr && !stderr.includes('Already up to date')) {
      throw new Error(stderr);
    }
    return stdout;
  }
}
```

### 5.4 验收标准

- [ ] sync流程按新顺序执行：fetch → import → export → push
- [ ] push被拒时自动重试（最多3次）
- [ ] 检测到MERGE_HEAD时自动abort
- [ ] export的jsonl已包含远端数据，不产生冲突
- [ ] 日志清晰显示每个步骤

---

## 六、Phase 5：冲突解决简化

### 6.1 目标

1. 删除 `cloud_sync_write_file` 工具
2. 删除 `as-is` 策略
3. 简化为3种策略：keep-local / keep-remote / per-file
4. 添加超时和重试

### 6.2 文件清单

**主文件**：
- `apps/windows/src/main/agent-runtime/bridge-tool-registrar-sync.ts`

### 6.3 具体任务

#### 6.3.1 删除write工具

```typescript
// bridge-tool-registrar-sync.ts

export function registerSyncTools(bridge: AgentBridge) {
  // ❌ 删除这个工具
  // bridge.registerTool('cloud_sync_write_file', async (args) => {
  //   // ...
  // });
  
  // ✅ 保留read工具
  bridge.registerTool('cloud_sync_read_file', async (args) => {
    const { path } = args;
    
    // 读取冲突文件的三个版本
    const local = await readGitVersion(path, 'HEAD');
    const remote = await readGitVersion(path, 'origin/main');
    const base = await readGitVersion(path, 'merge-base');
    
    return {
      local,
      remote,
      base
    };
  });
}
```

#### 6.3.2 简化resolve工具

```typescript
// bridge-tool-registrar-sync.ts

type ConflictStrategy = 'keep-local' | 'keep-remote' | 'per-file';

interface ResolveConflictArgs {
  strategy: ConflictStrategy;
  files?: string[];  // 冲突文件列表
  perFileChoices?: Record<string, 'local' | 'remote'>;  // per-file策略时使用
}

bridge.registerTool('resolve_sync_conflict', async (args: ResolveConflictArgs) => {
  const { strategy, files, perFileChoices } = args;
  
  if (!files || files.length === 0) {
    throw new Error('files is required');
  }
  
  for (const file of files) {
    let choice: 'local' | 'remote';
    
    if (strategy === 'keep-local') {
      choice = 'local';
    } else if (strategy === 'keep-remote') {
      choice = 'remote';
    } else if (strategy === 'per-file') {
      if (!perFileChoices || !perFileChoices[file]) {
        throw new Error(`per-file strategy requires choice for ${file}`);
      }
      choice = perFileChoices[file];
    } else {
      throw new Error(`Unknown strategy: ${strategy}`);
    }
    
    // 执行git checkout
    if (choice === 'local') {
      await gitExec(`checkout --ours "${file}"`);
    } else {
      await gitExec(`checkout --theirs "${file}"`);
    }
  }
  
  return { resolved: files };
});
```

#### 6.3.3 添加超时机制

```typescript
// sync-manager.ts

private async resolveConflictsWithAgent(conflicts: string[]): Promise<void> {
  const timeoutMs = 2 * 60 * 1000;  // 2分钟
  
  try {
    await Promise.race([
      this.callAgentToResolve(conflicts),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('timeout')), timeoutMs)
      )
    ]);
  } catch (error) {
    if (error.message === 'timeout') {
      console.warn('Conflict resolution timeout, auto keep-remote');
      // 自动选择 keep-remote
      await this.autoResolveConflicts(conflicts, 'keep-remote');
    } else {
      throw error;
    }
  }
}

private async autoResolveConflicts(conflicts: string[], strategy: 'keep-local' | 'keep-remote'): Promise<void> {
  for (const file of conflicts) {
    if (strategy === 'keep-remote') {
      await this.gitExec(`checkout --theirs "${file}"`);
    } else {
      await this.gitExec(`checkout --ours "${file}"`);
    }
  }
}
```

### 6.4 验收标准

- [ ] `cloud_sync_write_file` 工具已删除
- [ ] `resolve_sync_conflict` 只支持3种策略
- [ ] `as-is` 策略调用会报错
- [ ] 冲突解决超时2分钟后自动keep-remote
- [ ] 最多重试3次，之后强制keep-remote

---

## 七、Phase 6：旧格式迁移

### 7.1 目标

检测旧版 `wiki/data.json` 并自动迁移为新版 `*.jsonl` 格式。

### 7.2 文件清单

**主文件**：
- `apps/windows/src/main/cloud-sync/migration.ts` (新建)
- `apps/windows/src/main/cloud-sync/sync-manager.ts`

### 7.3 具体任务

#### 7.3.1 实现迁移逻辑

```typescript
// migration.ts

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * 检测并迁移旧格式
 */
export async function migrateOldFormat(syncRootPath: string): Promise<boolean> {
  const oldDataPath = path.join(syncRootPath, 'wiki/data.json');
  
  // 检查是否存在旧文件
  if (!await fileExists(oldDataPath)) {
    return false;  // 无需迁移
  }
  
  console.log('Detected old format wiki/data.json, migrating...');
  
  // 1. 读取旧文件
  const content = await fs.readFile(oldDataPath, 'utf-8');
  const oldData = JSON.parse(content);
  
  // 2. 转换为新格式并写入jsonl
  await writeJsonlFile(syncRootPath, 'wiki/sources.jsonl', oldData.sources || []);
  await writeJsonlFile(syncRootPath, 'wiki/entities.jsonl', oldData.entities || []);
  await writeJsonlFile(syncRootPath, 'wiki/observations.jsonl', oldData.observations || []);
  await writeJsonlFile(syncRootPath, 'wiki/relations.jsonl', oldData.relations || []);
  await writeJsonlFile(syncRootPath, 'wiki/syntheses.jsonl', oldData.syntheses || []);
  
  // 3. 删除旧文件（git rm）
  await gitExec(`-C "${syncRootPath}" rm wiki/data.json`);
  
  // 4. 提交
  await gitExec(`-C "${syncRootPath}" add wiki/*.jsonl`);
  await gitExec(`-C "${syncRootPath}" commit -m "migrate: split wiki/data.json to jsonl"`);
  
  console.log('Migration completed');
  return true;
}

async function writeJsonlFile(syncRootPath: string, relativePath: string, records: any[]): Promise<void> {
  const sorted = records.sort((a, b) => a.id.localeCompare(b.id));
  const content = sorted.map(r => JSON.stringify(r)).join('\n');
  const fullPath = path.join(syncRootPath, relativePath);
  await fs.writeFile(fullPath, content, 'utf-8');
}
```

#### 7.3.2 集成到sync流程

```typescript
// sync-manager.ts

export class SyncManager {
  async syncInner(): Promise<SyncResult> {
    try {
      // 0. 检查并迁移旧格式（在fetch之前）
      const migrated = await migrateOldFormat(this.syncRootPath);
      if (migrated) {
        // 迁移后直接push
        await this.gitPush();
      }
      
      // 1. fetch远端
      // ... 后续流程
    }
  }
}
```

### 7.4 验收标准

- [ ] 检测到 `wiki/data.json` 时自动迁移
- [ ] 生成对应的 `*.jsonl` 文件
- [ ] 删除 `wiki/data.json`
- [ ] 提交并推送迁移
- [ ] 幂等性：重复执行不报错

---

## 八、Phase 7：测试验证

### 8.1 目标

验证9个核心场景（详见设计文档§13）

### 8.2 测试清单

#### 8.2.1 场景1：A→B单向同步

**步骤**：
1. 设备A创建entity e1
2. 设备A sync
3. 设备B sync
4. 检查B是否有e1

**预期**：✅ B获得e1

---

#### 8.2.2 场景2：AB不同记录

**步骤**：
1. A和B都有e1
2. A修改e1为e1'
3. B创建e2
4. A sync → B sync
5. 检查远端和两设备

**预期**：✅ 都有[e1', e2]

---

#### 8.2.3 场景3：AB同一记录

**步骤**：
1. A和B都有e1 (T1)
2. A改为e1(T2), B改为e1(T3), T3>T2
3. A sync → B sync → A sync
4. 检查最终状态

**预期**：✅ 都是e1(T3)

---

#### 8.2.4 场景4：删除传播

**步骤**：
1. A和B都有e1
2. A删除e1（设置deleted_at）
3. A sync → B sync
4. 检查B的e1.deleted_at

**预期**：✅ B的e1标记为已删除

---

#### 8.2.5 场景5：窗口期保护

**步骤**：
1. A开始sync（export加锁）
2. 在export释放锁后，用户创建e2
3. sync完成
4. 再次sync
5. 检查e2是否同步

**预期**：✅ e2在第二次sync时导出

---

#### 8.2.6 场景6：push竞争

**步骤**：
1. A和B同时fetch
2. A先push成功
3. B push被拒
4. 检查B是否自动重试

**预期**：✅ B重试成功

---

#### 8.2.7 场景7：文本冲突

**步骤**：
1. A修改soul.md添加"爱好编程"
2. B修改soul.md添加"爱好阅读"
3. A sync → B sync（产生冲突）
4. 检查Agent是否解决冲突

**预期**：✅ 冲突解决

---

#### 8.2.8 场景8：崩溃恢复

**步骤**：
1. sync到一半崩溃（export完成，commit前）
2. 重启sync
3. 检查是否自动恢复

**预期**：✅ 自动重新export并commit

---

#### 8.2.9 场景9：旧格式迁移

**步骤**：
1. 准备旧格式 `wiki/data.json`
2. sync
3. 检查是否生成 `*.jsonl`
4. 检查 `data.json` 是否删除

**预期**：✅ 迁移成功

---

### 8.3 自动化测试

```typescript
// tests/cloud-sync-v3.test.ts

describe('Cloud Sync v3', () => {
  test('Scenario 1: A→B unidirectional sync', async () => {
    // 准备两个设备环境
    const deviceA = await setupDevice('A');
    const deviceB = await setupDevice('B');
    
    // A创建entity
    await deviceA.createEntity({ id: 'e1', name: 'test' });
    
    // A sync
    await deviceA.sync();
    
    // B sync
    await deviceB.sync();
    
    // 验证
    const e1 = await deviceB.getEntity('e1');
    expect(e1).toBeDefined();
    expect(e1.name).toBe('test');
  });
  
  // 类似实现其他8个场景测试
});
```

### 8.4 验收标准

- [ ] 9个场景测试全部通过
- [ ] 无数据丢失
- [ ] 无冲突残留
- [ ] 日志清晰可追踪
- [ ] 性能符合预期（export<1秒，sync<10秒）

---

## 九、风险与缓解

### 9.1 数据迁移风险

**风险**：现有用户数据在添加 `deleted_at` 字段时可能不兼容

**缓解**：
- 迁移脚本在启动时自动执行
- 新字段默认NULL，不影响现有数据
- 提供rollback指南（虽然SQLite不支持DROP COLUMN）

### 9.2 锁阻塞风险

**风险**：export加锁期间UI写入被阻塞

**缓解**：
- 优化查询，确保事务时间<1秒
- 在事务中只做读取和内存操作
- 文件写入移到事务外

### 9.3 旧版共存风险

**风险**：旧版设备和新版设备同时sync会冲突

**缓解**：
- 文档说明：所有设备需尽快升级
- 旧版检测到新格式后提示升级
- 迁移是单向的，不支持回退

### 9.4 时钟偏移风险

**风险**：设备时钟不准导致merge错误

**缓解**：
- 假设个人设备通常开启NTP
- 文档说明：时钟误差<1分钟可接受
- 极端情况接受数据覆盖（个人场景影响小）

---

## 十、上线计划

### 10.1 灰度发布

1. **内部测试**（1天）：开发者自测9个场景
2. **小范围测试**（2天）：2-3个早期用户
3. **全量发布**：发布到主分支

### 10.2 回滚预案

**如果发现严重问题**：
1. 紧急回退到旧版代码
2. 保留 `*.jsonl` 文件不删除
3. 修复后重新发布

**数据恢复**：
- Git历史保留所有版本，可回滚commit
- 数据库备份（用户自行备份）

### 10.3 文档更新

- [ ] 用户手册：说明新的同步机制
- [ ] 开发者文档：更新sync流程图
- [ ] Changelog：记录v3的主要变化

---

## 十一、总结

### 11.1 核心改进

1. **文件格式**：整包 → 分表jsonl，减少冲突
2. **同步顺序**：export-first → import-first，避免jsonl冲突
3. **删除机制**：统一软删除，简化逻辑
4. **窗口保护**：数据库事务锁，简单有效
5. **冲突策略**：简化为3种，移除安全风险

### 11.2 工作量评估

| 阶段 | 工作量 |
|------|--------|
| Phase 1-6 | 5天 |
| Phase 7 | 1天 |
| 文档 | 0.5天 |
| **总计** | **6.5天** |

### 11.3 成功标准

- ✅ 9个核心场景全部通过
- ✅ 无数据丢失、无冲突残留
- ✅ export<1秒，sync<10秒
- ✅ 代码简洁，易维护
- ✅ 用户无感知升级
