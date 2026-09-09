# 轻量云同步设计方案（简化版 v3）

- 日期：2026-09-09（v3简化版）
- 状态：待评审
- 设计原则：**简单、实用、稳定** — 个人2-3设备场景，够用就好，不追求完美

---

## 1. 核心原则

**定位**：个人多设备间的轻量级数据同步，不是分布式系统。

**简化策略**：
- ✅ 全量导出：每次导出完整数据，不做增量和分割
- ✅ 统一合并：记录级时间戳覆盖，接受字段级修改可能丢失
- ✅ 标记删除：所有删除都用字段标记，不做物理删除
- ✅ 简单冲突：只处理文本文件冲突，结构化数据自动合并
- ✅ 锁保护：export时锁数据库，避免窗口期不一致

**接受的限制**：
- 同时修改同一记录的不同字段，后同步的会覆盖先同步的（记录级覆盖）
- export期间数据库写入会阻塞（通常<1秒）
- 时钟偏移可能导致错误合并（假设设备时钟基本准确）
- 旧版本设备需尽快升级，不保证长期共存

---

## 2. 同步范围

### 2.1 必须同步

| 用户侧路径 | sync交换路径 | 格式 |
|------------|--------------|------|
| `~/.lumii/data/soul.md` | `profile/soul.md` | 文本 |
| `~/.lumii/data/user-memory.md` | `profile/user-memory.md` | 文本 |
| `agent-runtime.db` → `agent_memories` | `memory/memories.jsonl` | jsonl全量 |
| `agent-runtime.db` → wiki表 | `wiki/sources.jsonl`, `wiki/entities.jsonl`, `wiki/observations.jsonl`, `wiki/relations.jsonl`, `wiki/syntheses.jsonl` | jsonl全量 |
| `~/.lumii/workspace/skills/**` | `skills/**` | 目录镜像 |

### 2.2 不同步

- `agent-runtime.db` 其他表（autonomous、工具演化等）
- workspace的 `files/`、`outputs/`
- wiki的 embedding、index、organize_runs

### 2.3 schema简化要求

**需要添加deleted_at字段**（软删除支持）：
- `wiki_entities`：添加 `deleted_at TIMESTAMP`
- `wiki_relations`：添加 `deleted_at TIMESTAMP`
- `wiki_syntheses`：添加 `deleted_at TIMESTAMP`
- `agent_memories`：添加 `deleted_at TIMESTAMP`

已有软删除字段的表：
- `wiki_sources`：`archived_at`
- `wiki_observations`：`retired_at`

---

## 3. 导出（Export）

### 3.1 流程

```
1. 对数据库加读锁（阻止写入）
2. 读取所有表数据
3. 按表生成jsonl文件（包含deleted/archived/retired非空的行）
4. 每个jsonl内按id稳定排序
5. 释放数据库锁
6. 写入文件到sync交换层
```

### 3.2 文件格式

**jsonl格式**（一行一条记录）：
- `memory/memories.jsonl`：每行一个memory对象，按id排序
- `wiki/sources.jsonl`：每行一个source对象，按id排序
- `wiki/entities.jsonl`：每行一个entity对象，按id排序
- 其他同理

**排序规则**：按id字典序升序，保证稳定输出（减少git diff噪音）

**删除标记**：
- deleted_at/archived_at/retired_at非空的记录照常导出
- import时看到这些字段非空，就标记本地记录为已删除

### 3.3 去掉的复杂设计

- ❌ 不按需分割（每个id一个文件）
- ❌ 不生成快照文件
- ❌ 不做差异删除
- ❌ 不做写入后删除的原子性处理

---

## 4. 导入（Import）

### 4.1 统一合并规则

所有表使用同一规则：**时间戳大者胜**

| 表 | 时间戳字段 | 删除字段 |
|----|-----------|---------|
| agent_memories | updated_at | deleted_at |
| wiki_sources | created_at | archived_at |
| wiki_entities | updated_at | deleted_at |
| wiki_observations | created_at | retired_at |
| wiki_relations | updated_at | deleted_at |
| wiki_syntheses | created_at（finished_at仅状态展示用） | deleted_at |

**合并逻辑**（针对每条记录）：
```python
def merge_record(local, remote, timestamp_field, delete_field):
    if local is None:
        return remote  # 新记录，直接插入
    if remote is None:
        return local   # 远端删除，保持本地
    
    local_ts = local[timestamp_field]
    remote_ts = remote[timestamp_field]
    
    if remote_ts > local_ts:
        return remote  # 远端更新，覆盖本地
    else:
        return local   # 本地更新或同时，保持本地
```

**删除处理**：
- 如果导入的记录中删除字段非空，执行软删除（更新该字段）
- 不做物理DELETE，保持记录在数据库中

### 4.2 去掉的复杂设计

- ❌ 不做字段级冲突检测
- ❌ 不做差异删除（快照对比）
- ❌ 不做工作文件回写
- ❌ 不做syntheses的status特殊处理（统一用created_at）

---

## 5. 冲突处理

### 5.1 冲突分类

**自动合并**（不产生冲突）：
- 所有 `.jsonl` 文件：按时间戳规则自动合并，不会产生git冲突

**需要解决的冲突**：
- `profile/*.md`：文本文件，git检测到冲突
- `skills/**`：脚本文件，git检测到冲突

### 5.2 Agent辅助解决

**工具**：
- `cloud_sync_read_file(path)`：读取冲突文件的local/remote/base版本
- `resolve_sync_conflict(strategy, files)`：解决冲突

**策略**（简化为3种）：
- `keep-local`：保留本地版本
- `keep-remote`：保留远端版本
- `per-file`：逐文件指定，格式 `{"profile/soul.md": "local", "skills/deploy.md": "remote"}`

**去掉的复杂设计**：
- ❌ 不提供 `cloud_sync_write_file`（安全风险）
- ❌ 不支持 `as-is`策略（不允许保留冲突标记）
- ❌ Agent必须明确选择local或remote

### 5.3 超时处理

- 冲突解决超时（2分钟）→ 自动选择 `keep-remote`（假设远端是最新的其他设备）
- 持久化冲突状态到 `sync-state.json`，下次sync重试
- 最多重试3次，之后强制keep-remote

---

## 6. 同步流程（syncInner）

```
START
  ↓
1. 检查异常状态
   - 有MERGE_HEAD？ → git merge --abort → 重启
   - 本地ahead of remote？ → 直接跳到步骤5
   ↓
2. 检查本地改动
   - git status有改动？
     ↓ 是
     - export（加锁）
     - git add .
     - git commit -m "sync: export at <timestamp>"
   ↓
3. fetch远端
   - git fetch origin
   - 失败？ → 记录错误，结束（网络问题）
   ↓
4. 检测冲突
   - git merge origin/main
   - 有冲突？
     ↓ 是
     - 调用Agent解决
     - git add .
     - git commit -m "sync: resolve conflicts"
   ↓
5. 推送
   - git push origin main
   - 被拒绝？ → 回到步骤3（别人刚推送了）
   ↓
6. 导入
   - import（应用远端改动到数据库）
   ↓
END
```

### 6.1 去掉的复杂设计

- ❌ 不单独处理commit后push失败的状态（统一用ahead检测）
- ❌ 不做push失败的指数退避（简单重试，最多3次）
- ❌ 不做import崩溃恢复（依靠数据库事务）

---

## 7. 窗口期保护

**问题**：export到push之间，数据库可能被修改，导致：
- export的文件不包含新改动
- push后import会覆盖这些新改动

**简化方案**：在export期间锁数据库

```typescript
async function exportWithLock() {
  await db.transaction(async (tx) => {
    // 在事务中读取所有数据（其他写入会等待）
    const memories = await tx.query('SELECT * FROM agent_memories');
    const sources = await tx.query('SELECT * FROM wiki_sources');
    // ...
    
    // 生成jsonl内容（内存操作）
    const files = generateJsonlFiles({memories, sources, ...});
    
    // 返回文件内容
    return files;
  });
  
  // 事务结束后，写入文件到磁盘
  await writeFilesToSync(files);
}
```

**效果**：
- export期间，UI的写操作会短暂等待（通常<1秒）
- export完成后立即释放锁，用户无感知
- 避免了快照机制的复杂性

---

## 8. 旧格式迁移

### 8.1 检测与转换

```
if (存在 wiki/data.json) {
  1. 读取 wiki/data.json
  2. 按新格式写入 wiki/*.jsonl
  3. git add wiki/*.jsonl
  4. git rm wiki/data.json
  5. git commit -m "migrate: split wiki data.json to jsonl"
}
```

### 8.2 幂等性

- 依靠文件存在性判断（data.json删除后不再触发）
- 如果崩溃在步骤4之前，下次重启重新执行
- 依靠INSERT OR REPLACE去重，重复导入无害

---

## 9. 实现清单

### 9.1 schema改动

**文件**：`packages/agent-runtime/src/storage/schema.ts`

添加字段：
```sql
ALTER TABLE wiki_entities ADD COLUMN deleted_at TIMESTAMP;
ALTER TABLE wiki_relations ADD COLUMN deleted_at TIMESTAMP;
ALTER TABLE wiki_syntheses ADD COLUMN deleted_at TIMESTAMP;
ALTER TABLE agent_memories ADD COLUMN deleted_at TIMESTAMP;
```

### 9.2 导出器改动

**文件**：`apps/windows/src/main/cloud-sync/sync-exporter.ts`

改动：
1. 删除 `wiki/data.json` 整包导出逻辑
2. 实现 `exportWithLock()`：事务内读取数据
3. 实现 `generateJsonlFiles()`：生成按id排序的jsonl
4. 包含 deleted_at/archived_at/retired_at 非空的行

### 9.3 导入器改动

**文件**：`apps/windows/src/main/cloud-sync/sync-importer.ts`

改动：
1. 删除 `wiki/data.json` 整包导入逻辑
2. 实现统一合并规则：`mergeByTimestamp()`
3. 软删除处理：看到删除字段非空时更新该字段
4. 包在数据库事务中

### 9.4 冲突解决改动

**文件**：`apps/windows/src/main/agent-runtime/bridge-tool-registrar-sync.ts`

改动：
1. 删除 `cloud_sync_write_file` 工具
2. 删除 `as-is` 策略
3. 简化 `resolve_sync_conflict`：只支持 keep-local / keep-remote / per-file
4. 添加超时和重试逻辑

### 9.5 sync流程改动

**文件**：`apps/windows/src/main/cloud-sync/sync-manager.ts`

改动：
1. 简化状态检测：MERGE_HEAD / ahead / clean
2. 简化push重试：直接重新fetch，最多3次
3. 添加旧格式检测和迁移

---

## 10. 验证标准（简化）

只验证核心场景：

1. **单设备往返**：export → import 数据不丢失不变化
2. **A→B单向**：A改动 → push → B同步 → B数据更新
3. **不同记录**：A改memory1，B改memory2 → 双向同步 → 两边都有两个改动
4. **同一记录**：A改memory1，B也改memory1 → 双向同步 → 新的覆盖旧的（接受一方丢失）
5. **删除传播**：A删除entity1 → push → B同步 → B的entity1标记deleted_at
6. **冲突解决**：A改soul.md，B也改soul.md → 冲突 → Agent选择 → 解决成功
7. **export锁**：export期间UI写入会等待，不会丢失

---

## 11. 风险与限制

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 时钟偏移 | 错误合并 | 假设设备时钟基本准确（个人设备通常开NTP） |
| 记录级覆盖 | 字段级修改丢失 | 接受限制，个人使用很少同时改同一记录 |
| export阻塞 | UI写入短暂等待 | 通常<1秒，用户无感知 |
| 网络异常 | 同步失败 | 下次重试，数据不丢失 |
| Agent超时 | 冲突未解决 | 自动keep-remote，下次重试 |
| 旧设备共存 | 格式冲突 | 旧设备尽快升级，或手动解决冲突 |

---

## 12. 与v2的主要简化

| 方面 | v2设计 | v3简化 |
|------|--------|--------|
| 文件分割 | 按需分割（每id一文件） | 全量jsonl |
| 删除机制 | 快照+差异删除 | 统一软删除 |
| 合并规则 | 表级差异化 | 统一时间戳规则 |
| 窗口保护 | 快照白名单 | 数据库读锁 |
| Agent工具 | read + write | 仅read |
| 冲突策略 | 4种（含as-is） | 3种 |
| 异常恢复 | 多状态检测 | 简单重启 |
| 验证标准 | 8项 | 7项 |

**核心理念**：够用就好，简单可靠，快速实现。
