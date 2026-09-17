# Lumii 精简多设备同步方案（聚焦核心数据）

**日期**: 2026-09-07  
**原则**: 同步 Agent 的"大脑"与"能力"，不同步"对话历史"与"临时状态"

---

## 1. 用户需求明确化

### 1.1 ✅ 应该同步的数据（核心价值）

**知识与记忆**:
- ✅ Wiki 知识库（所有 wiki_* 表）
- ✅ 记忆宫殿（memory/palace/）
- ✅ Agent 记忆（agent_memories 表，但不含对话来源）
- ✅ 实体、观察、关系（wiki_entities, wiki_observations, wiki_relations）

**能力与配置**:
- ✅ 用户自定义技能（workspace/skills/）
- ✅ Agent 人格定义（data/soul.md）
- ✅ 用户记忆文档（data/user-memory.md）
- ✅ 通用配置（app.json, agents.json）

**自主进化数据**:
- ✅ 自主目标（autonomous_goals）
- ✅ 满意度评分（autonomous_satisfaction_scores）
- ✅ 批准设置（autonomous_approval_settings）
- ✅ 日记（autonomous_diaries - 反思记录）

**用户文件**:
- ✅ 工作空间文件（workspace/files/）
- ✅ 技能产出（workspace/outputs/ - 如果小）

### 1.2 ❌ 不应该同步的数据（临时/隐私）

**对话与历史**:
- ❌ conversations（对话元数据）
- ❌ messages（聊天记录）
- ❌ conversation_participants（参与者）

**工具与审计**:
- ❌ tool_audit_log（工具调用日志）
- ❌ workspace/.tool-results/（工具结果缓存）
- ❌ local_cron_runs（定时任务执行历史）

**本地状态**:
- ❌ runtime_state（运行时 KV）
- ❌ logs/（日志文件）
- ❌ cache/（缓存）
- ❌ temp/（临时文件）

**设备特定**:
- ❌ provider.json（含 API 密钥）
- ❌ cloud-sync.json（含 Git 令牌）
- ❌ models/（本地嵌入模型）
- ❌ runtimes/（Python/Node 运行时）

---

## 2. 数据导出策略（SQLite → 文本）

### 2.1 Wiki 知识库导出

**核心价值**: Wiki 是 Agent 的外部知识系统，必须跨设备共享

**导出方案 A: 完整 SQLite dump（推荐）**

```bash
# 导出 Wiki 相关表为 SQL 脚本
sqlite3 agent-runtime.db <<EOF
.output sync/wiki/schema.sql
.schema wiki_inbox wiki_sources wiki_pages wiki_page_revisions \
        wiki_links wiki_page_attachments wiki_syntheses \
        wiki_entities wiki_observations wiki_relations \
        wiki_organize_runs wiki_index_meta
.output sync/wiki/data.sql
.dump wiki_inbox wiki_sources wiki_pages wiki_page_revisions \
      wiki_links wiki_page_attachments wiki_syntheses \
      wiki_entities wiki_observations wiki_relations \
      wiki_organize_runs wiki_index_meta
.quit
EOF
```

**优点**:
- SQL dump 包含完整的 DDL + 数据
- 导入简单：`sqlite3 new.db < data.sql`
- 保留外键、索引、触发器
- Git 友好（文本格式，可 diff）

**缺点**:
- Wiki 数据量大时文件会大（但可压缩）
- 全量导出，非增量

**优化**:
```bash
# 压缩导出（SQL → gzip）
gzip -c sync/wiki/data.sql > sync/wiki/data.sql.gz
# 体积减少 80-90%
```

---

**导出方案 B: JSON 分表导出（灵活）**

```typescript
// 按表导出为 JSON
async function exportWikiToJson() {
  const tables = [
    'wiki_sources',
    'wiki_pages', 
    'wiki_entities',
    'wiki_observations',
    'wiki_relations',
  ]
  
  for (const table of tables) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all()
    await writeFile(
      `sync/wiki/${table}.json`,
      JSON.stringify(rows, null, 2)
    )
  }
}
```

**优点**:
- 可选择性导出（比如不导出 wiki_page_revisions 历史版本）
- JSON 更易人工查看
- 可以按需分片（如按 wiki_sources.id 分文件）

**缺点**:
- 外键关系需要手动处理
- 导入时需要按顺序（父表 → 子表）
- 冲突合并复杂

---

**推荐方案**: 
- **Phase 1**: 方案 A（SQL dump + gzip）- 简单可靠
- **Phase 2**: 如果数据量增长，考虑增量同步（仅同步变更的 wiki_sources）

---

### 2.2 记忆宫殿导出

**当前结构**: Chroma 向量数据库（SQLite + HNSW 索引）

```
memory/palace/
├── chroma.sqlite3                [184KB - 元数据]
└── 4ea7db47-d9d1-4973-9610.../   [170KB - 向量索引]
    ├── data_level0.bin
    ├── header.bin
    ├── length.bin
    └── link_lists.bin
```

**问题**: 二进制格式，Git 无法 diff，难以合并

**方案 A: 直接同步（简单但不完美）**

```gitignore
# sync/.gitignore
# 允许同步记忆宫殿
!memory/palace/**
```

**优点**:
- 简单，无需导出/导入
- 保留完整向量索引（性能好）

**缺点**:
- 二进制文件，Git 每次 commit 会存完整副本
- 两个设备同时添加记忆 → 冲突无法自动合并
- .bin 文件冲突只能选边站

---

**方案 B: 导出为 JSON + 重建索引（推荐）**

```typescript
async function exportMemoryPalace() {
  const chromaDb = new ChromaDB('memory/palace/chroma.sqlite3')
  const collections = chromaDb.listCollections()
  
  for (const collection of collections) {
    const records = chromaDb.query(collection.id, {})
    
    // 导出为 JSONL（增量友好）
    const output = records.map(r => JSON.stringify({
      id: r.id,
      embedding: r.embedding,  // 向量
      metadata: r.metadata,
      document: r.document,
    })).join('\n')
    
    await writeFile(`sync/memory/${collection.name}.jsonl`, output)
  }
}

async function importMemoryPalace() {
  const chromaDb = new ChromaDB('memory/palace/chroma.sqlite3')
  
  const files = await readdir('sync/memory/')
  for (const file of files) {
    const lines = (await readFile(`sync/memory/${file}`)).split('\n')
    const records = lines.map(l => JSON.parse(l))
    
    // 重建集合与索引
    const collection = chromaDb.getOrCreateCollection(file.replace('.jsonl', ''))
    for (const record of records) {
      collection.upsert({
        id: record.id,
        embedding: record.embedding,
        metadata: record.metadata,
        document: record.document,
      })
    }
  }
}
```

**优点**:
- JSONL 格式，Git 友好
- 增量追加：新记忆 append 到文件末尾
- 冲突少：两设备各追加一段，合并时保留两端
- 可读：人工可以查看记忆内容

**缺点**:
- 需要重建向量索引（耗时）
- 首次导入慢（但后续增量快）

**优化**:
```typescript
// 仅导出增量变更
async function exportMemoryPalaceIncremental(since: Date) {
  const records = chromaDb.query({
    where: { created_at: { $gt: since.toISOString() } }
  })
  // 追加到 JSONL
  await appendFile('sync/memory/palace.jsonl', records.map(JSON.stringify).join('\n'))
}
```

---

### 2.3 Agent 记忆导出

**agent_memories 表结构**:
```sql
CREATE TABLE agent_memories (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  user_id TEXT,
  category TEXT,      -- user/feedback/project/reference
  content TEXT,
  importance REAL,
  tags TEXT,
  source_message_id TEXT,  -- ⚠️ 关联对话消息
  created_at TEXT,
  last_used TEXT,
  use_count INTEGER,
  is_archived INTEGER
)
```

**问题**: `source_message_id` 关联到 messages 表，但 messages 不同步 → 引用断裂

**方案**: 导出时移除引用，仅保留记忆内容

```typescript
async function exportAgentMemories() {
  const memories = db.prepare(`
    SELECT id, agent_id, user_id, category, content, 
           importance, tags, created_at, last_used, 
           use_count, is_archived
    FROM agent_memories
    WHERE is_archived = 0
    ORDER BY created_at ASC
  `).all()
  
  // JSONL 格式（增量友好）
  const output = memories.map(m => JSON.stringify(m)).join('\n')
  await writeFile('sync/memories/agent-memories.jsonl', output)
}
```

**导入逻辑**:
```typescript
async function importAgentMemories() {
  const lines = (await readFile('sync/memories/agent-memories.jsonl')).split('\n')
  
  for (const line of lines) {
    const memory = JSON.parse(line)
    
    // 幂等插入：已存在则更新（按 importance 和 last_used）
    db.prepare(`
      INSERT INTO agent_memories (id, agent_id, user_id, category, content, 
                                   importance, tags, created_at, last_used, 
                                   use_count, is_archived)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        importance = CASE 
          WHEN excluded.last_used > agent_memories.last_used 
          THEN excluded.importance 
          ELSE agent_memories.importance 
        END,
        last_used = MAX(excluded.last_used, agent_memories.last_used),
        use_count = agent_memories.use_count + excluded.use_count
    `).run(Object.values(memory))
  }
}
```

---

### 2.4 自主进化数据导出

**需要同步的表**:
- `autonomous_goals` (目标)
- `autonomous_satisfaction_scores` (满意度)
- `autonomous_approval_settings` (批准设置)
- `autonomous_diaries` (日记/反思)

**导出策略**: 按表导出为 JSON

```typescript
async function exportAutonomousData() {
  const tables = {
    'autonomous_goals': 'WHERE status != "completed" AND status != "failed"',  // 仅未完成目标
    'autonomous_satisfaction_scores': 'ORDER BY created_at DESC LIMIT 100',   // 最近 100 条
    'autonomous_approval_settings': '',                                        // 全部
    'autonomous_diaries': 'ORDER BY created_at DESC LIMIT 50',                // 最近 50 篇
  }
  
  for (const [table, filter] of Object.entries(tables)) {
    const rows = db.prepare(`SELECT * FROM ${table} ${filter}`).all()
    await writeFile(
      `sync/autonomous/${table}.json`,
      JSON.stringify(rows, null, 2)
    )
  }
}
```

**合并策略**:
- **goals**: 按 ID 合并，取 `updated_at` 最新的
- **satisfaction_scores**: 两端追加，按 `created_at` 去重
- **approval_settings**: 取最新的（单条配置）
- **diaries**: 两端追加，按 `created_at` 去重

---

## 3. 最终目录结构

### 3.1 精简同步目录（~/.lumii/sync/）

```
~/.lumii/sync/                    [新建，仅此目录同步到 Git]
├── .git/                         [Git 仓库]
├── .gitignore
├── profile/                      [用户配置与人格]
│   ├── soul.md
│   ├── user-memory.md
│   └── preferences.json          [从 app.json 提取通用配置]
├── agents/                       [用户自定义 Agent]
│   └── custom-agents.json        [从 config/agents.json 复制]
├── wiki/                         [Wiki 知识库]
│   ├── data.sql.gz               [压缩的 SQL dump]
│   ├── last-export.txt           [导出时间戳]
│   └── .wiki-sync-meta.json      [元数据：版本、checksum]
├── memory/                       [记忆数据]
│   ├── palace.jsonl              [记忆宫殿向量 + 文档]
│   └── agent-memories.jsonl      [Agent 记忆]
├── autonomous/                   [自主进化数据]
│   ├── goals.json
│   ├── satisfaction_scores.json
│   ├── approval_settings.json
│   └── diaries.json
├── skills/                       [用户自定义技能]
│   └── （从 workspace/skills/ 复制）
├── workspace/                    [用户工作文件]
│   ├── files/                    [用户文件]
│   └── outputs/                  [小于 1MB 的输出]
└── .sync-manifest.json           [同步清单：版本、文件列表、校验和]
```

### 3.2 保留不同步的本地数据（~/.lumii/local/）

```
~/.lumii/local/                   [不同步]
├── db/
│   └── agent-runtime.db          [SQLite 主库]
├── config/
│   ├── provider.json             [API 密钥]
│   ├── cloud-sync.json           [Git 令牌]
│   └── device.json               [设备 ID、名称]
├── cache/
├── logs/
├── models/
├── runtimes/
└── temp/
```

### 3.3 向后兼容软链接

```bash
# Windows: mklink（需要管理员）或硬链接（无需权限）
mklink /H ~/.lumii/data/soul.md ~/.lumii/sync/profile/soul.md
mklink /H ~/.lumii/data/user-memory.md ~/.lumii/sync/profile/user-memory.md

# 或者代码中路径解析：优先读 sync/，回退到旧路径
```

---

## 4. 同步工作流

### 4.1 导出流程（推送前）

```typescript
async function exportForSync() {
  console.log('1. 导出 Wiki 知识库...')
  await exportWikiToSql()
  await compressFile('sync/wiki/data.sql', 'sync/wiki/data.sql.gz')
  
  console.log('2. 导出记忆宫殿...')
  await exportMemoryPalace()
  
  console.log('3. 导出 Agent 记忆...')
  await exportAgentMemories()
  
  console.log('4. 导出自主进化数据...')
  await exportAutonomousData()
  
  console.log('5. 复制用户文件...')
  await syncUserFiles()
  
  console.log('6. 生成同步清单...')
  await generateSyncManifest()
  
  console.log('导出完成，准备推送')
}
```

### 4.2 导入流程（拉取后）

```typescript
async function importFromSync() {
  console.log('1. 校验同步清单...')
  const manifest = await validateSyncManifest()
  if (!manifest.valid) {
    throw new Error('同步数据不完整或已损坏')
  }
  
  console.log('2. 导入 Wiki 知识库...')
  await decompressFile('sync/wiki/data.sql.gz', '/tmp/wiki.sql')
  await importWikiFromSql('/tmp/wiki.sql')
  
  console.log('3. 导入记忆宫殿...')
  await importMemoryPalace()
  
  console.log('4. 导入 Agent 记忆...')
  await importAgentMemories()
  
  console.log('5. 导入自主进化数据...')
  await importAutonomousData()
  
  console.log('6. 同步用户文件...')
  await syncUserFiles()
  
  console.log('导入完成')
}
```

### 4.3 完整同步周期

```
设备 A (工作电脑):
  1. 用户使用 Agent，积累新知识/记忆
  2. [自动触发] 每 30 分钟检查变更
  3. 如果有变更 → exportForSync()
  4. git add . && git commit -m "sync: $(date)"
  5. git pull --rebase
  6. 如果有冲突 → 调用 Agent 处理（见 §5）
  7. git push

设备 B (家里电脑):
  1. [定时] 每 15 分钟 git fetch
  2. 如果远程有更新 → git pull
  3. importFromSync()
  4. 用户看到最新的知识/记忆
```

---

## 5. 冲突处理策略

### 5.1 文件级冲突处理

| 文件 | 冲突策略 | 原因 |
|------|---------|------|
| soul.md | Last-write-wins | 用户在一个设备上定义人格 |
| user-memory.md | 三方合并 | Markdown 文本，Git 自动合并 |
| wiki/data.sql.gz | Agent 介入 | 需要解压 → 对比差异 → 智能合并 |
| memory/palace.jsonl | 两端追加 | JSONL 追加模式，按 ID 去重 |
| autonomous/goals.json | Agent 合并 | 结构化 JSON，智能合并 |
| workspace/files/* | Last-write-wins | 用户明确文件所有权 |

### 5.2 Wiki 冲突处理（最复杂）

**场景**:
```
设备 A: 添加了 wiki_sources #123 + wiki_pages #456
设备 B: 添加了 wiki_sources #124 + wiki_pages #457
```

**处理流程**:
1. Git 检测到 `wiki/data.sql.gz` 冲突
2. 解压两侧：`data-local.sql` 和 `data-remote.sql`
3. 差异提取：
   ```sql
   -- 设备 A 的新增
   INSERT INTO wiki_sources VALUES (123, ...);
   INSERT INTO wiki_pages VALUES (456, ...);
   
   -- 设备 B 的新增
   INSERT INTO wiki_sources VALUES (124, ...);
   INSERT INTO wiki_pages VALUES (457, ...);
   ```
4. 合并策略：**两端都保留**（无冲突，ID 不同）
5. 生成合并后的 `data-merged.sql`
6. 压缩并提交

**Agent 工具**:
```typescript
{
  name: 'merge_wiki_dump',
  description: '智能合并两个 Wiki SQL dump 文件',
  parameters: {
    localDump: string,
    remoteDump: string,
    strategy: 'union' | 'local-priority' | 'remote-priority'
  },
  execute: async (params) => {
    const localInserts = parseInserts(params.localDump)
    const remoteInserts = parseInserts(params.remoteDump)
    
    // 按 ID 去重，合并两端
    const merged = unionBy([...localInserts, ...remoteInserts], 'id')
    
    return generateSqlDump(merged)
  }
}
```

### 5.3 记忆宫殿冲突处理

**JSONL 追加模式** → 自动合并

```bash
# 设备 A 的 palace.jsonl
{"id":"mem-001","content":"..."}
{"id":"mem-002","content":"..."}

# 设备 B 的 palace.jsonl
{"id":"mem-001","content":"..."}
{"id":"mem-003","content":"..."}

# Git 合并后（保留两端）
{"id":"mem-001","content":"..."}
{"id":"mem-002","content":"..."}
{"id":"mem-001","content":"..."}  # 重复
{"id":"mem-003","content":"..."}

# 导入时去重
import 时按 ID 去重 → 最终只有 mem-001, mem-002, mem-003
```

**如果内容不同**:
```jsonl
{"id":"mem-001","content":"旧内容","updated_at":"2026-09-07T10:00:00Z"}
{"id":"mem-001","content":"新内容","updated_at":"2026-09-07T11:00:00Z"}
```

导入逻辑：取 `updated_at` 最新的

---

## 6. 体积估算与优化

### 6.1 预估同步仓库大小

| 数据类型 | 原始大小 | 压缩后 | 说明 |
|---------|---------|--------|------|
| Wiki SQL dump | 5-10 MB | 0.5-1 MB | gzip 压缩 90% |
| 记忆宫殿 JSONL | 358 KB | 100 KB | JSON 压缩良好 |
| Agent 记忆 | 100 KB | 30 KB | |
| 自主进化数据 | 50 KB | 15 KB | |
| soul.md + user-memory.md | 3 KB | 1 KB | |
| 用户文件 | 10 KB | 5 KB | |
| **总计** | **~6 MB** | **~1.7 MB** | |

**Git 历史膨胀**:
- 每次同步 commit ~1.7 MB 变更
- 每天 3 次同步 × 30 天 = 90 次 commit ≈ 150 MB
- 使用 `git gc --aggressive` 压缩 → ~50 MB

**结论**: 可接受范围，无需 Git LFS

### 6.2 增量优化

**仅导出变更**:
```typescript
async function exportWikiIncremental(since: Date) {
  // 仅导出新增/修改的 wiki_sources
  const newSources = db.prepare(`
    SELECT * FROM wiki_sources 
    WHERE created_at > ? OR updated_at > ?
  `).all(since.toISOString(), since.toISOString())
  
  // 追加到 wiki/incremental.jsonl
  await appendFile(
    'sync/wiki/incremental.jsonl',
    newSources.map(JSON.stringify).join('\n')
  )
}
```

**定期全量快照**:
- 每周一次全量导出 → `wiki/snapshot-YYYY-MM-DD.sql.gz`
- 日常增量追加 → `wiki/incremental.jsonl`
- 导入时：加载最近快照 + 重放增量

---

## 7. 安全与隐私

### 7.1 敏感数据过滤

**导出前扫描**:
```typescript
async function scanForSensitiveData(file: string) {
  const content = await readFile(file, 'utf-8')
  
  const patterns = [
    /api[_-]?key[:\s]*['"]?([a-zA-Z0-9-_]{20,})/gi,
    /password[:\s]*['"]?([^'"\s]{8,})/gi,
    /token[:\s]*['"]?([a-zA-Z0-9-_.]{20,})/gi,
  ]
  
  for (const pattern of patterns) {
    const matches = content.match(pattern)
    if (matches) {
      console.warn(`⚠️  ${file} 可能包含敏感信息: ${matches[0].substring(0, 20)}...`)
      return true
    }
  }
  return false
}

// 推送前检查
beforePush(async () => {
  const files = await glob('sync/**/*')
  for (const file of files) {
    if (await scanForSensitiveData(file)) {
      const confirm = await askUser(`${file} 可能含敏感数据，是否继续推送？`)
      if (!confirm) throw new Error('用户取消推送')
    }
  }
})
```

### 7.2 Git 仓库加密（可选）

**使用 git-crypt**:
```bash
# 安装 git-crypt
brew install git-crypt  # macOS
apt install git-crypt   # Linux

# 初始化加密
cd ~/.lumii/sync
git-crypt init

# 配置加密文件
echo "wiki/*.sql.gz filter=git-crypt diff=git-crypt" >> .gitattributes
echo "memory/*.jsonl filter=git-crypt diff=git-crypt" >> .gitattributes

# 导出密钥（给其他设备使用）
git-crypt export-key ~/lumii-sync-key

# 其他设备解锁
git-crypt unlock ~/lumii-sync-key
```

**优点**:
- 透明加密：推送前自动加密，拉取后自动解密
- Git 提供商无法查看内容
- 密钥管理简单

**缺点**:
- 需要在所有设备配置密钥
- 密钥丢失 = 数据无法恢复

---

## 8. 实施计划

### Phase 1: 基础导出导入 (2 周)

**目标**: 手动导出 → Git 同步 → 手动导入

**任务**:
1. 创建 `sync/` 目录结构
2. 实现 `exportForSync()` 和 `importFromSync()`
3. Wiki SQL dump 导出/导入
4. 记忆宫殿 JSONL 导出/导入
5. 用户文件复制

**验证**:
```bash
# 设备 A
npm run sync:export
cd ~/.lumii/sync && git push

# 设备 B
cd ~/.lumii/sync && git pull
npm run sync:import
```

### Phase 2: 自动化同步 (1 周)

**任务**:
1. 集成到现有 `CloudSyncManager`
2. 推送前自动调用 `exportForSync()`
3. 拉取后自动调用 `importFromSync()`
4. 变更检测（仅在有数据变化时推送）

**验证**:
- 设备 A 添加 Wiki 页面 → 15 分钟后 → 设备 B 自动同步

### Phase 3: 冲突处理 (1 周)

**任务**:
1. 实现 `merge_wiki_dump` Agent 工具
2. JSONL 追加模式去重
3. JSON 结构化数据智能合并
4. 用户可配置冲突策略

**验证**:
- 两台设备同时添加 Wiki 页面 → 自动合并无丢失

### Phase 4: 优化与监控 (持续)

**任务**:
1. 增量导出（仅变更数据）
2. 定期快照 + 增量重放
3. 同步性能监控
4. 用户反馈迭代

---

## 9. 总结与关键决策

### 9.1 核心优势

1. **聚焦价值**: 仅同步 Agent 的"大脑"（知识、记忆、能力），不同步"对话记录"
2. **体积可控**: ~1.7 MB 压缩后，Git 历史 ~50 MB/月
3. **冲突少**: JSONL 追加模式 + 结构化合并
4. **易维护**: 文本格式，人工可读，易调试

### 9.2 关键权衡

| 决策 | 优点 | 缺点 | 接受理由 |
|------|------|------|---------|
| 对话不同步 | 体积小、隐私好 | 跨设备无对话历史 | 用户明确不需要 ✅ |
| SQLite → SQL dump | 简单可靠 | 全量导出 | Wiki 数据量不大，可接受 |
| 记忆宫殿 JSONL | Git 友好 | 需重建索引 | 增量追加快，值得 |
| 手动冲突处理 | 数据安全 | 偶尔需介入 | 高价值数据，谨慎为上 |

### 9.3 与用户需求对齐

✅ Wiki 知识库 → 完整同步  
✅ 记忆数据 → 完整同步  
✅ 通用配置 → 同步（排除密钥）  
✅ 技能 → 同步  
✅ 自主进化 → 同步（目标、日记）  
❌ 聊天记录 → 不同步（符合需求）  
❌ 历史对话 → 不同步（符合需求）  
❌ 工具结果 → 不同步（符合需求）

---

**下一步**:
1. Review 本方案，确认数据范围
2. 开发 Phase 1 原型
3. 双设备测试验证

**文档版本**: v1.0  
**维护者**: Kiro AI
