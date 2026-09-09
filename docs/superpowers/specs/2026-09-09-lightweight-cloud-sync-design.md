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
    elif remote_ts < local_ts:
        return local   # 本地更新，保持本地
    else:
        # 时间戳相同时，处理删除标记
        local_deleted = local.get(delete_field)
        remote_deleted = remote.get(delete_field)
        
        if remote_deleted is not None and local_deleted is None:
            return remote  # 优先传播删除操作
        return local   # 否则保持本地
```

**删除处理**：
- 如果导入的记录中删除字段非空，执行软删除（更新该字段）
- 时间戳相同时，优先采纳有删除标记的版本（传播删除）
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
- 所有 `.jsonl` 文件：通过"先import再export"避免git冲突（详见§6流程）

**需要解决的冲突**：
- `profile/*.md`：文本文件，git merge时可能产生冲突
- `skills/**`：脚本文件，git merge时可能产生冲突

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

### 6.1 核心流程（修正版）

```
START
  ↓
1. 检查异常状态
   - 有MERGE_HEAD？ → git merge --abort → 重启
   ↓
2. fetch远端
   - git fetch origin
   - 失败？ → 记录错误，结束（网络问题）
   ↓
3. import远端数据
   - 读取远端 .jsonl 文件
   - 按时间戳规则merge到本地数据库
   - 此步骤后，数据库已包含远端+本地的合并结果
   ↓
4. export完整状态
   - 基于当前数据库状态（已含远端数据）重新导出
   - 加锁：在数据库事务中读取数据，防止写入竞争
   - 生成 .jsonl 文件
   ↓
5. 提交和推送
   - git add .
   - git commit -m "sync: merge and export at <timestamp>"
   - git push origin main
   - 被拒绝？ → 回到步骤2（别人刚推送了，重新merge）
   ↓
6. 检测冲突（仅文本文件）
   - 如果步骤5的merge产生冲突（profile/*.md, skills/**）
   - 调用Agent解决冲突
   - git add .
   - git commit -m "sync: resolve conflicts"
   - git push origin main
   ↓
END
```

### 6.2 为什么这个顺序？

**关键洞察**：先import再export，避免jsonl文件产生git冲突

**旧方案问题**（export → fetch → merge）：
```
设备A: export [e1'] → commit → push
设备B: export [e1, e2] → commit → fetch → merge冲突！
```
两个设备的jsonl内容不同，git会检测到冲突。

**新方案优势**（fetch → import → export）：
```
设备A: fetch → import(无) → export [e1'] → push
设备B: fetch → import(拉到e1') → merge到DB → export [e1', e2] → push
```
设备B的export已经包含了远端的e1'，所以文件内容是远端的超集，不会冲突。

**唯一可能的冲突**：两设备同时在push前的窗口期，都基于旧的远端状态export。解决方案：push被拒后重新执行fetch → import → export。

### 6.3 去掉的复杂设计

- ❌ 不检查本地ahead状态（统一走fetch → import → export流程）
- ❌ 不单独处理commit后push失败的状态
- ❌ 不做push失败的指数退避（简单重试，最多3次）
- ❌ 不做import崩溃恢复（依靠数据库事务）

---

## 7. 窗口期保护

**问题场景**：
```
export(加锁读取DB) → 释放锁 → 写文件 → commit → push(2秒网络延迟)
                      ↑ 这期间用户修改数据库成功
```

**分析**：
- 锁释放后到push完成期间，用户可以修改数据库
- 这些修改不会包含在本次export的文件中
- 但这些修改仍在数据库中，下次sync会导出

**结论**：✅ 不是问题
- 用户修改会在下次sync时导出
- 不会丢失数据
- 不需要额外保护

**export期间的保护**：使用数据库事务锁

```typescript
async function exportWithLock() {
  await db.transaction(async (tx) => {
    // 在事务中读取所有数据（阻止其他写入，时间<1秒）
    const memories = await tx.query('SELECT * FROM agent_memories WHERE deleted_at IS NULL OR deleted_at > ?', [now - 30days]);
    const sources = await tx.query('SELECT * FROM wiki_sources WHERE archived_at IS NULL');
    // ...
    
    // 生成jsonl内容（内存操作，快速）
    const files = generateJsonlFiles({memories, sources, ...});
    
    // 事务结束，锁释放
    return files;
  });
  
  // 写文件到磁盘（事务外，不阻塞数据库）
  await writeFilesToDisk(files);
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

---

## 13. 场景验证

### 13.1 场景1：正常A→B单向同步

**初始状态**：
- 设备A：entity e1 (updated_at=T1)
- 设备B：无数据
- 远端：空

**操作序列**：
1. 设备A sync: fetch(无) → import(无) → export [e1] → push成功
2. 设备B sync: fetch [e1] → import到DB → export [e1] → push(无改动)

**结果**：✅ B成功获得e1

---

### 13.2 场景2：AB同时修改不同记录

**初始状态**：
- A和B都有 e1 (updated_at=T1)
- 远端：e1 (T1)

**操作**：
- A修改e1 → e1' (T2)
- B创建e2 (T3)

**推演**：
1. A先sync: fetch → import(无变化) → export [e1'] → push成功
   - 远端: [e1']
2. B后sync: 
   - fetch拉到 [e1']
   - import: e1'(T2) > e1(T1) → 更新本地e1为e1'
   - 本地DB现在有 [e1', e2]
   - export [e1', e2]
   - push成功

**结果**：✅ 远端和两设备都有 [e1', e2]

**关键**：B的export已包含远端数据，不会产生jsonl冲突

---

### 13.3 场景3：AB同时修改同一记录

**初始状态**：
- A和B都有 e1 (name="old", updated_at=T1)

**操作**：
- A修改: e1 (name="A-modified", updated_at=T2)
- B修改: e1 (name="B-modified", updated_at=T3, T3>T2)

**推演**：
1. A先sync: fetch → import → export [e1(name="A-modified", T2)] → push
2. B后sync:
   - fetch拉到 [e1(T2)]
   - import: T2 < T3 → 保持本地 (name="B-modified", T3)
   - export [e1(name="B-modified", T3)]
   - push成功
3. A再sync:
   - fetch拉到 [e1(T3)]
   - import: T3 > T2 → 更新为 (name="B-modified", T3)

**结果**：✅ 时间戳大的胜出，A的修改被覆盖（符合预期）

---

### 13.4 场景4：删除传播

**初始状态**：
- A和B都有 e1 (updated_at=T1, deleted_at=null)

**操作**：
- A删除e1: 设置 deleted_at=T2

**推演**：
1. A sync: fetch → import → export [e1(T1, deleted_at=T2)] → push
2. B sync:
   - fetch拉到 [e1(deleted_at=T2)]
   - import: 
     - 比较updated_at: T1 = T1
     - 时间戳相同，检查deleted_at
     - remote.deleted_at=T2, local.deleted_at=null
     - 采纳远端（传播删除）
   - 本地e1现在 deleted_at=T2

**结果**：✅ 删除成功传播

---

### 13.5 场景5：窗口期写入保护

**操作**：
```
设备A:
1. sync开始
2. fetch → import
3. export加锁（事务开始）
4. 读取数据: [e1, e2]
5. 生成jsonl内容（内存）
6. 事务结束（锁释放）
7. 写文件到磁盘
8. commit + push（网络2秒）

用户在步骤6之后修改:
9. 创建e3 → 写入数据库成功（锁已释放）

10. push完成，本地DB有 [e1, e2, e3]
11. 下次sync会export [e1, e2, e3]
```

**结果**：✅ e3被保护，下次sync导出

---

### 13.6 场景6：push被拒绝（竞争）

**操作**：
```
设备A和B同时sync:
1. A: fetch(远端v1)
2. B: fetch(远端v1)
3. A: import → export → push成功（远端v2）
4. B: import → export → push失败（远端已是v2）
```

**B的处理**：
```
5. B检测到push被拒
6. 重试（最多3次）:
   - fetch拉到v2
   - import v2数据到DB（merge）
   - export新状态（包含v2+B的merge）
   - push成功
```

**结果**：✅ 重试机制有效

---

### 13.7 场景7：文本文件冲突

**操作**：
- A修改soul.md添加"爱好编程"
- B修改soul.md添加"爱好阅读"

**推演**：
1. A sync: fetch → import → export + commit soul.md → push
2. B sync:
   - fetch远端
   - git merge检测到soul.md冲突:
     ```
     <<<<<<< HEAD
     爱好阅读
     =======
     爱好编程
     >>>>>>> origin/main
     ```
   - 调用Agent: cloud_sync_read_file("profile/soul.md")
   - Agent调用: resolve_sync_conflict("keep-remote", ["profile/soul.md"])
   - git add + commit
   - push成功

**结果**：✅ 冲突解决，B采用了A的版本

---

### 13.8 场景8：export崩溃恢复

**操作**：
```
1. fetch → import
2. export加锁 → 读取 → 生成jsonl → 释放锁
3. 写文件到一半 → 崩溃！（entities.jsonl损坏）
```

**下次启动**：
```
1. sync开始
2. fetch（可能无变化）
3. import（可能跳过或重新应用）
4. export重新生成完整文件（覆盖损坏文件）
5. commit + push
```

**结果**：✅ 自动恢复，数据从DB重新导出

---

### 13.9 场景9：旧格式迁移

**设备A（旧版）**：
```
sync生成 wiki/data.json (整包)
push成功
```

**设备B（新版v3）**：
```
1. fetch拉到 wiki/data.json
2. 检测到data.json存在
3. 读取并转换为 wiki/*.jsonl
4. git rm wiki/data.json
5. git add wiki/*.jsonl
6. commit "migrate: split wiki"
7. push
```

**设备A（旧版）再sync**：
```
1. fetch发现data.json被删，多了*.jsonl
2. 旧版不识别 → 需要升级
```

**结果**：⚠️ 旧设备需尽快升级（可接受限制）

---

### 13.10 验证总结

| 场景 | 状态 | 说明 |
|------|------|------|
| A→B单向 | ✅ | 基础同步正常 |
| 不同记录 | ✅ | 无冲突，自动合并 |
| 同一记录 | ✅ | 时间戳规则生效，记录级覆盖 |
| 删除传播 | ✅ | deleted_at特殊处理正确 |
| 窗口保护 | ✅ | export锁有效，后续修改不丢失 |
| push竞争 | ✅ | 重试机制有效 |
| 文本冲突 | ✅ | Agent解决流程正常 |
| 崩溃恢复 | ✅ | 基于DB重建，自动修复 |
| 旧格式 | ⚠️ | 需升级，可接受 |

**结论**：修正后的v3方案通过所有核心场景验证，可以实施。
