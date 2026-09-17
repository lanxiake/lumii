# Wiki P0 CLI 自测指南（Task 10）

> **前置条件**：应用已启动，控制口可达（`~/.lumii/runtime/app-ui.json`）。
> **隔离建议**：先用 `LUMII_CLIENT_DATA_DIR` 指向真实库拷贝执行全流程，确认无破坏性后再对主库操作。

---

## 1. 摄入与归档流程验证

验证四路自动摄入→后台归档的完整闭环。

### 1.1 上传文件摄入

```bash
# 准备测试文件（3 个不同类型）
echo "这是一份关于架构设计的技术文档。" > /tmp/test-doc.txt
# 手动上传该文件到 Lumii（通过界面拖拽或上传功能）

# 等待 1-2 秒后查看收件箱
lumii-ui wiki inbox list --status pending

# 预期输出：
# {
#   "items": [
#     {
#       "id": "<inbox-id>",
#       "itemType": "upload",
#       "title": "test-doc.txt",
#       "contentPreview": "这是一份关于架构设计的技术文档。",
#       "mediaType": "document",
#       "status": "pending",
#       "createdAt": "..."
#     }
#   ],
#   "total": 1
# }
```

### 1.2 后台自动归档

```bash
# 等待归档管线处理（正常应在 5-10 秒内完成）
# 可通过运行日志监控进度
lumii-ui wiki runs list

# 预期输出：
# {
#   "runs": [
#     {
#       "id": "<run-id>",
#       "status": "succeeded",
#       "inboxIds": ["<inbox-id>"],
#       "resultSummary": "classified 1 items to sources/...",
#       "createdAt": "..."
#     }
#   ]
# }

# 确认收件箱条目已标记 organized
lumii-ui wiki inbox list --status organized
# 预期：包含刚才的条目，status 变为 organized

# 确认生成了页面
lumii-ui wiki page list --category sources
# 预期：包含新生成的摘要页
```

---

## 2. 中文检索精度验证（Task 0 核心验证在真实数据上的延续）

测试 FTS5 + bigram 分词对真实中文内容的召回能力。

```bash
# 测试 1：多字词（"架构设计"应分为"架构 构设 设计"三个 bigram）
lumii-ui wiki search "架构设计" --limit 5

# 预期：
# - 目标页面出现在 top-3
# - 人工评估误配率：是否误召回"构建设施"等不相关页面
# - 记录精确率：前 3 条中有几条真正相关

# 测试 2：单字与组合
lumii-ui wiki search "上传" --limit 5

# 预期：包含上传相关文档

# 测试 3：特殊字符不崩溃
lumii-ui wiki search '"引号测试"' --limit 5

# 预期：不抛 SQL 异常，正常返回结果或空列表

# 测试 4：英文混合
lumii-ui wiki search "Wiki 功能" --limit 5

# 预期：中英混合检索正常，bigram 只对 CJK 生效，拉丁词整词匹配
```

**人工评估清单**：

| 查询词 | top-3 命中目标 | 前 3 条精确率 | 误配情况 |
|--------|---------------|-------------|---------|
| "架构设计" | 是/否 | _ / 3 | 是否有"构建设施"类误配 |
| "上传" | 是/否 | _ / 3 |  |
| "Wiki 功能" | 是/否 | _ / 3 |  |

**精度通过标准**：3 个查询的 top-3 命中率 ≥ 2/3，误配率 <30%。

---

## 3. 批量效率验证

验证批量分类调用合并生效（LLM 调用次数远小于文件数）。

```bash
# 准备 10 个测试文件
for i in {1..10}; do
  echo "测试文档 $i：关于项目部署与配置的说明。" > /tmp/test-$i.txt
done

# 批量上传这 10 个文件（通过界面多选上传）

# 等待归档完成后，查看运行日志
lumii-ui wiki runs list

# 预期输出分析：
# - 1 条或 2-3 条运行记录（而非 10 条），说明批量合并生效
# - 每条记录的 inboxIds 是数组，包含多个条目 ID

# 确认 10 个文件都已归档
lumii-ui wiki inbox list --status organized
# 预期 total ≥ 10
```

**验证点**：运行日志条数 << 上传文件数，证明批量合并调用生效。

---

## 4. 失败可见不丢数据

验证 LLM 失败或断网时，条目保持 pending 且错误可见。

```bash
# 模拟失败场景：断开网络或停止 LLM 服务（手动操作）
# 然后上传一个文件

# 查看收件箱
lumii-ui wiki inbox list --status pending

# 预期输出：
# {
#   "items": [
#     {
#       "id": "<inbox-id>",
#       "status": "pending",
#       "attemptCount": 1,  # 或更高，取决于重试次数
#       "lastError": "LLM request timeout" # 或类似错误信息
#     }
#   ]
# }

# 恢复网络后，手动重试
lumii-ui wiki inbox retry <inbox-id>

# 预期：重试成功，条目变为 organized
```

**验证点**：失败时条目停留 pending，`lastError` 有明确错误信息，恢复后可重试成功。

---

## 5. 索引重建幂等性

验证 FTS5 索引可重建，且重建后检索结果一致。

```bash
# 记录重建前的页面总数
lumii-ui wiki page list | jq '.total'
# 假设输出 15

# 执行重建
lumii-ui wiki index rebuild

# 预期输出：
# { "rebuiltCount": 15 }

# 再次确认总数不变
lumii-ui wiki page list | jq '.total'
# 预期仍为 15

# 重复执行重建（幂等性测试）
lumii-ui wiki index rebuild
# 预期：再次返回 rebuiltCount: 15

# 验证检索结果不受影响
lumii-ui wiki search "架构设计" --limit 3
# 预期：与重建前搜索结果一致（可对比之前记录）
```

**验证点**：重建不丢数据，可多次执行，检索结果一致。

---

## 6. Agent 工具可用性

验证 Agent 通过工具可正常访问 Wiki。

```bash
# 在 Lumii 中启动一次对话，让 Agent 使用 Wiki 工具

# 示例对话：
用户: "帮我看看 Wiki 里有什么内容"
Agent: [调用 wiki_overview 工具]
# 预期 Agent 返回各分类的页面数和标题

用户: "搜索一下架构设计相关的内容"
Agent: [调用 wiki_search 工具]
# 预期 Agent 返回搜索结果并引用页面内容

用户: "读一下 sources/xxx 这个页面"
Agent: [调用 wiki_read 工具]
# 预期 Agent 返回完整页面内容

用户: "把我们刚才讨论的方案存到 Wiki"
Agent: [调用 wiki_capture 工具]
# 预期生成收件箱条目，等待归档
```

**验证点**：4 个 Wiki 工具（overview/search/read/capture）均可被 Agent 正常调用且返回预期结果。

---

## 7. 运行日志可追溯

验证归档产生的页面可通过运行日志追溯生成依据。

```bash
# 列出页面，记录一个页面路径
lumii-ui wiki page list --category sources | jq '.pages[0].path'
# 假设输出 "sources/test-doc"

# 查看该页面详情
lumii-ui wiki page get "sources/test-doc"

# 预期输出包含：
# {
#   "page": { ... },
#   "sources": [{ "id": "<source-id>", ... }],  # 来源资料
#   "organizeRunId": "<run-id>"  # 所属运行日志
# }

# 查看该运行日志
lumii-ui wiki runs list | jq '.runs[] | select(.id=="<run-id>")'

# 预期输出：
# {
#   "id": "<run-id>",
#   "inboxIds": ["<inbox-id>"],
#   "resultSummary": "classified 1 items...",
#   ...
# }
```

**验证点**：页面→来源资料→运行日志的追溯链完整，可回溯生成依据。

---

## 8. 边界与异常用例

```bash
# 空查询词（应拒绝）
lumii-ui wiki search ""
# 预期：exit 2 (usage error)

# 不存在的页面路径
lumii-ui wiki page get "nonexistent/path"
# 预期：返回 { "error": "Page not found" } 或类似错误信息

# 重复重建索引（幂等性，已在 §5 验证）

# 手动归档时指定不合法路径
lumii-ui wiki inbox organize <id> --path "../escape"
# 预期：归档失败或降级到 inbox/，不允许路径逃逸
```

---

## 9. 自测通过标准

- [ ] 四路摄入（上传/产物/搜索/沉淀）自动进收件箱
- [ ] 后台归档自动完成，生成页面可在 Wiki Tab 查看
- [ ] 中文检索：3 个测试用例 top-3 命中率 ≥ 2/3，误配率 <30%
- [ ] 批量效率：运行日志条数 << 文件数
- [ ] 失败可见：断网时条目保持 pending，`lastError` 有明确信息
- [ ] 索引重建：重建后总数不变，可多次执行，检索结果一致
- [ ] Agent 工具：4 个工具均可正常调用
- [ ] 可追溯：页面→来源→运行日志链完整
- [ ] 边界用例：特殊字符、空查询、不存在 ID 不崩溃

---

## 附录：故障排查

- **收件箱为空**：检查摄入钩子是否正确接入，查看应用日志是否有摄入错误
- **归档一直 pending**：检查 LLM 配置是否正常，查看 `wiki:runs:list` 是否有失败记录
- **检索返回空**：执行 `wiki index rebuild`，确认分词结果（参照 Task 0 单测）
- **Agent 工具调用失败**：确认工具已注册（`ToolRegistry.getAll()`），检查 IPC 白名单
- **控制口不可达**：确认应用已启动，`~/.lumii/runtime/app-ui.json` 文件存在

---

**执行时间估算**：完整自测约 15-20 分钟（含手动验证与 Agent 对话）。隔离测试需额外 5 分钟准备拷贝库。