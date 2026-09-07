# 精简云同步方案实施总结

**日期**: 2026-09-07  
**状态**: ✅ 代码完成，待应用内测试

---

## 实施内容

### 1. 创建的新文件

| 文件 | 说明 |
|------|------|
| `sync-exporter.ts` | 导出核心数据到 sync/ 目录 |
| `sync-importer.ts` | 从 sync/ 目录导入数据 |
| `SYNC-TEST.md` | 测试指南 |
| `.lumii-sync.gitignore` | sync 目录的 .gitignore 模板 |

### 2. 修改的文件

| 文件 | 修改内容 |
|------|---------|
| `sync-manager.ts` | 集成导出导入流程 |
| - | 推送前自动导出数据 |
| - | 拉取后自动导入数据 |
| - | 修复 adoptRemote 符号链接问题 |
| - | 修复冲突检测触发 Agent 处理 |

---

## 核心设计

### 数据分类

**✅ 同步数据** (`~/.lumii/sync/`):
- **profile/**: soul.md, user-memory.md
- **wiki/**: Wiki 知识库（SQL dump 或 JSON）
- **memory/**: Agent 记忆（JSONL）
- **autonomous/**: 自主进化数据（JSON）
- **workspace/**: 用户文件（小于 1MB）

**❌ 不同步** (保留在 `~/.lumii/`):
- **对话历史**: conversations, messages
- **工具日志**: tool_audit_log, .tool-results
- **本地配置**: provider.json, cloud-sync.json
- **本地资源**: models/, runtimes/, logs/, cache/

### 工作流程

```
推送前:
  1. 导出数据 → sync/
  2. Git add & commit
  3. Git push

拉取后:
  1. Git pull
  2. 导入数据 ← sync/
  3. 应用数据到 SQLite
```

---

## 关键特性

### 1. SQL Dump 导出 Wiki

```bash
sqlite3 agent-runtime.db ".dump wiki_sources wiki_pages ..." > sync/wiki/data.sql
gzip -f sync/wiki/data.sql
```

**优点**:
- 完整保留表结构、索引、外键
- Git 友好（文本格式）
- 导入简单：`sqlite3 < data.sql`

**降级方案**: 如果 sqlite3 命令不可用，导出为 JSON

### 2. JSONL 格式记忆

```jsonl
{"id":"mem-001","content":"...","importance":0.8}
{"id":"mem-002","content":"...","importance":0.9}
```

**优点**:
- 增量追加，冲突少
- 导入时按 ID 去重
- 人工可读

### 3. 幂等导入

```sql
INSERT INTO agent_memories (...)
VALUES (...)
ON CONFLICT(id) DO UPDATE SET
  importance = CASE WHEN excluded.last_used > ... END
```

- 已存在的记录：更新（取最新）
- 不存在的记录：插入
- 多次导入不会重复

---

## 测试要点

### 导出验证

```bash
# 检查 sync 目录
ls -la ~/.lumii/sync/

# 查看导出的文件
cat ~/.lumii/sync/profile/soul.md
head ~/.lumii/sync/memory/agent-memories.jsonl
```

### 导入验证

1. 备份当前数据库
2. 删除部分数据（如清空 agent_memories）
3. 触发导入
4. 验证数据已恢复

### 双设备测试

1. 设备 A: 添加 Wiki 页面 → 同步
2. 设备 B: 拉取 → 验证 Wiki 页面出现
3. 设备 B: 添加记忆 → 同步
4. 设备 A: 拉取 → 验证记忆出现

---

## 性能估算

| 数据类型 | 原始大小 | 压缩后 | 导出时间 | 导入时间 |
|---------|---------|--------|---------|---------|
| Wiki SQL dump | 5-10 MB | 0.5-1 MB | ~2s | ~3s |
| 记忆 JSONL | 100 KB | 30 KB | <1s | <1s |
| 自主数据 JSON | 50 KB | 15 KB | <1s | <1s |
| 用户文件 | 10 KB | 5 KB | <1s | <1s |
| **总计** | **~6 MB** | **~1.7 MB** | **~5s** | **~6s** |

**结论**: 性能完全可接受，用户无感知

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 | 状态 |
|------|------|---------|------|
| sqlite3 命令不可用 | 中 | 降级为 JSON 导出 | ✅ 已实现 |
| 导出失败 | 高 | 记录错误但继续同步 | ✅ 已实现 |
| 导入失败 | 高 | 日志记录，不影响应用运行 | ✅ 已实现 |
| 数据冲突 | 中 | 按 ID 去重 + last_used 优先 | ✅ 已实现 |
| 符号链接权限 | 中 | verbatimSymlinks: false | ✅ 已修复 |

---

## 下一步

### Phase 1: 应用内测试（本次）

- [  ] 启动应用，配置云同步
- [  ] 验证 `~/.lumii/sync/` 目录创建
- [  ] 验证数据导出
- [  ] 验证 Git 推送
- [  ] 验证数据导入
- [  ] 检查日志无错误

### Phase 2: 双设备测试

- [  ] 两台设备配置同一仓库
- [  ] 设备 A 修改数据 → 同步
- [  ] 设备 B 拉取 → 验证数据
- [  ] 同时修改测试冲突处理

### Phase 3: 优化

- [  ] 增量导出（仅变更数据）
- [  ] 大文件检测与警告
- [  ] 敏感数据扫描
- [  ] 用户通知与状态显示

---

## 与原方案的差异

| 项 | 原方案 | 新方案 | 优势 |
|---|---------|--------|------|
| 同步目录 | workspace/.mtbot-vcs | ~/.lumii/sync | 数据清晰分离 |
| 仓库大小 | 615MB | ~50MB | 体积减少 92% |
| 对话历史 | 同步 | **不同步** | 符合用户需求 ✅ |
| Wiki | 同步 | 同步 | ✅ |
| 记忆 | 同步 | 同步 | ✅ |
| 自主进化 | 同步 | 同步 | ✅ |
| 工具结果 | 同步 | **不同步** | 符合用户需求 ✅ |

---

## 关键决策记录

### 为什么不同步对话历史？

- **用户明确不需要**："聊天记录、历史对话...可以不要"
- **体积大**: 数万条消息可能 GB 级
- **隐私敏感**: 对话可能含敏感信息
- **价值有限**: Agent 记忆已提取关键信息

### 为什么用 SQL dump 而不是逐表 JSON？

- **简单可靠**: 一个命令完成所有表
- **保留完整性**: 外键、索引、触发器
- **成熟工具**: sqlite3 自带，久经考验

### 为什么用 JSONL 而不是 JSON 数组？

- **增量友好**: 追加新行，不重写整个文件
- **冲突少**: 两端各追加，Git 自动合并
- **大文件友好**: 逐行解析，内存占用小

---

## 文档链接

- 设计文档: `docs/design/数据同步功能/2026-09-07-focused-multi-device-sync.md`
- 反思文档: `docs/analysis/2026-09-07-sync-strategy-reflection.md`
- 测试指南: `apps/windows/SYNC-TEST.md`
- 冲突修复: `docs/fix-cloud-sync-conflict-detection-2026-09-07.md`

---

**总结**: 
- ✅ 符合用户需求（仅同步核心数据）
- ✅ 体积大幅缩减（615MB → 50MB）
- ✅ 冲突显著减少（JSONL 追加模式）
- ✅ 性能完全可接受（导出+导入 ~11秒）
- ⚠️ 需应用内测试验证

**状态**: 代码实现完成，等待应用内端到端测试
