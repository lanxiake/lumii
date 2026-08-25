# 记忆重构 P0 CLI 自测指南（Task 8）

> **前置条件**：应用已启动，控制口可达（`~/.lumii/runtime/app-ui.json`）。
> **隔离建议**：先用 `LUMII_CLIENT_DATA_DIR` 指向真实库的拷贝执行全流程，确认无破坏性后再对主库操作。

---

## 1. 基线确认

验证记忆总数与温度分布符合预期（与迁移后 §3 基线一致）。

```bash
# 显示温度分布（hot/warm/cold）+ 总数
lumii-ui memory stats

# 预期输出示例：
# {
#   "hot": 15,
#   "warm": 42,
#   "cold": 18,
#   "total": 75
# }
```

---

## 2. FTS5 索引健康 + 全量重建

验证老数据被正确索引，重建后总数不变（索引是派生物，不应丢数据）。

```bash
# 重建 FTS5 派生索引（全量从主表重新分词灌入）
lumii-ui memory rebuild-index

# 预期输出：
# { "rebuiltCount": 75 }

# 再次统计，总数应与步骤 1 一致
lumii-ui memory stats
```

---

## 3. 中文召回实测（Task 2 核心验证）

测试 FTS5 + bigram 分词对中文 2 字词的召回能力。对比改造前 LIKE 的结果（若有记录）。

```bash
# 测试 1：常见 2 字词
lumii-ui memory search "爬山" --limit 5

# 预期：
# - 目标记忆出现在 top-3（如 "用户喜欢周末骑车去龙泉山爬山"）
# - 人工评估误配率（bigram 可能误召回"山上爬行"等噪音）

# 测试 2：多字词组合
lumii-ui memory search "项目部署" --limit 5

# 预期：包含 "项目" 或 "部署" 的记忆，按 BM25 相关性排序

# 测试 3：特殊字符不崩溃
lumii-ui memory search '"引号 AND 测试"'

# 预期：不抛异常，正确转义 FTS5 查询语法
```

**人工评估点**：
- 召回率：目标记忆是否在结果列表内（前 5 条）
- 精确率：前 3 条结果中有几条相关
- 对比改造前 LIKE：如有记录，对比召回差异

---

## 4. 温度流转与冷归档

验证冷记忆归档逻辑（> 30 天未用 且 非 `user`/`feedback` 类）。

```bash
# 列出所有记忆，找一条确认的冷记忆 ID（可选，用于手动验证）
lumii-ui memory list | grep "project"

# 执行冷归档（需 --yes 确认）
lumii-ui memory archive-cold --yes

# 预期输出：
# { "archivedCount": 18 }

# 再次统计，cold 应为 0（已被归档）
lumii-ui memory stats

# 预期：
# {
#   "hot": 15,
#   "warm": 42,
#   "cold": 0,
#   "total": 57
# }

# 恢复一条归档记忆（可选，验证 unarchive 功能）
lumii-ui memory unarchive <memory-id>

# 预期：
# { "success": true }
```

**验证点**：
- 归档条数与 `cold` 分档一致
- `user` / `feedback` 类记忆不被归档（即使 > 30 天未用）
- 恢复后记忆重新可见

---

## 5. 来源溯源（Provenance）

验证工作记忆可回溯到原始段落 + 宫殿片段（诉求 A）。

```bash
# 列出记忆，找一条有 sourceSegmentId 的记忆 ID
lumii-ui memory list | head -20

# 溯源到来源段 + 原文区间
lumii-ui memory provenance <memory-id>

# 预期输出（若有来源）：
# {
#   "memoryId": "<id>",
#   "sourceSegmentId": "<segment-id>",
#   "sourceMessageId": "<msg-id>",
#   "palaceDrawerId": "<drawer-id>",
#   "originalText": "...(原文区间)...",
#   "segment": { "id": "...", "conversationId": "...", ... }
# }

# 若无来源（规则提取产出的记忆），返回 null
```

**验证点**：
- `originalText` 与记忆内容语义一致
- `segment` 可回溯到对话历史

---

## 6. 边界与异常用例

```bash
# 空查询词（应拒绝）
lumii-ui memory search ""
# 预期：exit 2 (usage error)

# 不存在的记忆 ID
lumii-ui memory provenance "nonexistent-id"
# 预期：返回 null

# 重复重建索引（幂等性）
lumii-ui memory rebuild-index
lumii-ui memory rebuild-index
# 预期：两次返回相同 rebuiltCount
```

---

## 7. 自测通过标准

- [ ] 基线确认：`memory stats` 总数与迁移后基线一致
- [ ] 索引重建：`rebuild-index` 后总数不变
- [ ] 中文召回：2 字词测试目标记忆在 top-3 内
- [ ] 冷归档：归档条数与 `cold` 分档一致，personal 类不受影响
- [ ] 溯源：带来源的记忆可回溯到原文区间
- [ ] 边界用例：特殊字符、空查询、不存在 ID 不崩溃

---

## 附录：故障排查

- **`memory search` 返回空**：检查 FTS5 索引健康（`rebuild-index`），确认分词结果（`tokenizeBigram` 单测）
- **`archive-cold` 归档 0 条**：检查时间戳（`Date.now()` vs `last_used`），确认数据库有 > 30 天未用记忆
- **`provenance` 返回 null**：正常，该记忆可能由规则提取产出，无 segment 来源
- **控制口不可达**：确认应用已启动，`~/.lumii/runtime/app-ui.json` 文件存在且端口正确

---

**执行时间估算**：完整自测约 10-15 分钟（含手动验证）。隔离测试需额外 5 分钟准备拷贝库。
