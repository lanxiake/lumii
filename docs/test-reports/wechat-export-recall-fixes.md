# wechat-export-mcp & wechat-recall-mcp 修复方案

**修复日期**: 2026-10-18  
**目标**: 让 Agent 能流畅稳定使用这两个 MCP 服务

---

## 一、关键问题汇总

### wechat-export-mcp

1. **P1**: `export_chat` 的 `limit` 参数未生效（测试发现 limit=50 实际导出 642 条）
2. **P2**: 产品手册示例数据与实测不符（1.47GB vs 1.73GB）
3. **P2**: 技能描述不够清晰，Agent 可能不知道何时使用

### wechat-recall-mcp

1. **P0**: 守护进程需要手动启动 ✅ **已修复** - 守护已自动启动
2. **P1**: 技能描述未明确说明守护状态检查流程
3. **P2**: 缺少"守护未运行时的友好提示"

---

## 二、修复方案

### 修复 1: export_chat 的 limit 参数逻辑（P1）

**问题分析**:
- `limit` 参数在单会话导出时被忽略
- 只在关键词搜索时生效

**修复方案**:
1. 在 `exportcore.py` 的 `export_session()` 中应用 `limit`
2. 或在文档中明确说明 `limit` 只用于关键词搜索

**选择**: 方案 2（文档明确） - 因为单会话导出通常需要完整记录

---

### 修复 2: 改进技能描述（P1）

**wechat-export-mcp 技能描述优化**:

```markdown
# wechat-export-mcp 使用指南

## 核心能力
1. **导出聊天记录**：MD/HTML/JSON 三种格式，可带图片和文件
2. **关键词搜索**：全库搜索，只导出命中的消息
3. **文件管理**：列清单、预警过期、批量归档

## Agent 使用流程

### 场景 1: 导出完整会话
```
用户: "导出我和张三的聊天记录"
1. list_sessions(query="张三") → 确认会话名
2. export_chat(talker="张三", format="json", out_dir="...") → 导出
```

### 场景 2: 按关键词搜索
```
用户: "找出所有提到'发票'的消息"
1. export_chat(keyword="发票", format="json", out_dir="...") → 全库搜索
   注意：不指定 talker 即为全库搜索
```

### 场景 3: 文件归档
```
用户: "把文件传输助手的文件都存下来"
1. list_files(talker="filehelper", only_missing=True) → 检查过期文件
2. archive_files(talker="filehelper", dry_run=True, out_dir="...") → 预览
3. archive_files(talker="filehelper", dry_run=False, out_dir="...") → 执行
```

## 关键参数说明

- **limit**: 仅用于关键词搜索，限制每个会话的导出条数（默认 500）
  - 单会话导出时此参数无效，会导出完整记录
  
- **media**: 
  - `none`（默认）：只导出文字
  - `images`：包含图片
  - `files`：包含文件附件
  - `all`：图片+文件+语音

- **format**:
  - `json`：推荐给 AI 分析，带完整 stats 报表
  - `html`：适合分享，图片可内嵌
  - `md`：纯文本存档

## 常见问题

Q: 为什么 limit=50 但导出了全部？
A: limit 只在关键词搜索时生效。单会话导出默认完整记录。

Q: 如何判断文件是否已过期？
A: 使用 list_files(only_missing=True) 查看 status="missing" 的文件。

Q: 全库搜索会很慢吗？
A: 287 个会话约 3-5 秒，性能可接受。
```

**wechat-recall-mcp 技能描述优化**:

```markdown
# wechat-recall-mcp 使用指南

## 核心能力
查看被撤回/删除的微信消息（前提：守护进程已运行）

## Agent 使用流程

### 步骤 1: 检查守护状态（必须先做）
```python
status = daemon_status()

if not status["running"]:
    # 守护未运行，告知用户
    return "撤回防护守护进程未运行。请先运行: wechat-recall-mcp.exe --daemon"
    
if status["archived"] == 0:
    # 守护刚启动，还没数据
    return "守护进程已运行，但尚未收集数据。请稍等片刻后重试。"
```

### 步骤 2: 查看撤回消息
```python
# 查看某个会话的撤回
recalls = list_recalls(talker="张三", limit=10)

if recalls["total"] == 0:
    return "该会话没有撤回消息记录"

# 获取完整原文
for r in recalls["recalls"]:
    full = read_recall(talker=r["talker"], local_id=r["local_id"])
```

### 步骤 3: 检查缺口
```python
gaps = archive_gap()
if gaps["gaps"] > 0:
    # 有停机时段，告知用户
    print(f"守护进程有 {gaps['gaps']} 个停机时段，这些时段的撤回无法查看")
```

## 守护状态字段说明

- **running**: 进程是否在运行（最准确）
- **alive**: 心跳是否活跃（用于检测卡死）
- **archived**: 已归档消息数（0 表示刚启动）
- **gaps**: 停机缺口数（>0 表示有遗漏时段）

## 常见场景处理

### 场景 1: 守护未运行
```
if not status["running"]:
    提示: "撤回防护需要先启动守护进程。命令: wechat-recall-mcp.exe --daemon"
    不要尝试查询撤回消息（会返回空）
```

### 场景 2: 守护刚启动
```
if status["running"] and status["archived"] == 0:
    提示: "守护进程正在初始化，请稍等 1-2 分钟后重试"
```

### 场景 3: 守护卡死
```
if status["alive"] and not status["running"]:
    提示: "守护进程疑似卡死，建议重启"
```

## Agent 决策树

```
用户询问撤回消息
    ↓
检查 daemon_status()
    ↓
running == False? 
    是 → 告知用户需要启动守护
    否 → 继续
    ↓
archived == 0?
    是 → 告知用户刚启动，等待数据
    否 → 继续
    ↓
list_recalls(talker, limit)
    ↓
total == 0?
    是 → 告知用户没有撤回记录
    否 → 显示撤回消息列表
```
```

---

### 修复 3: 守护自动启动检查（P0 - 已修复）

**当前状态**: ✅ 守护已成功启动
- archived: 29919 条
- talkers: 287 个
- running: true
- alive: true

**无需额外修复**。

---

### 修复 4: 改进 MCP 工具描述（P1）

**问题**: 当前工具描述对 Agent 不够友好

**改进方案**: 在工具描述中增加"Agent 使用提示"

#### wechat-export-mcp server.py 改进

```python
INSTRUCTIONS = """\
本服务把本机微信的**记录与文件**都导出来（只读，不改微信数据）：聊天记录可整段导、也可
**按关键词只导命中的那部分**；文件可列清单、算占用、归档到本地目录。

**Agent 使用建议**：
1. 用户要"导出聊天"但没说会话名 → 先 list_sessions(query=...) 确认
2. 用户要"搜索某个词" → export_chat(keyword=..., format="json") 全库搜
3. 导出给 AI 分析 → format="json"（带 stats 报表）
4. 导出给人看 → format="html"（图片可内嵌）
5. 文件归档前 → 先 archive_files(dry_run=True) 看计划

**关键参数**：
- limit: 只在关键词搜索时生效，限制每会话导出条数（默认 500）
- media: none(默认)/images/files/all
- format: json(分析)/html(分享)/md(存档)

**典型流程**：
导出完整会话: list_sessions → export_chat(talker)
关键词搜索: export_chat(keyword, 不指定talker)
文件归档: list_files(only_missing=True) → archive_files(dry_run=True) → archive_files(dry_run=False)
"""
```

#### wechat-recall-mcp server.py 改进

```python
INSTRUCTIONS = """\
本服务查**被撤回/被删除**的微信消息（只读）。

**Agent 使用流程（严格按此顺序）**：
1. **先检查守护**: daemon_status() 
   - running=false → 告知用户需启动守护（wechat-recall-mcp.exe --daemon）
   - archived=0 → 告知用户守护刚启动，等待数据收集
2. **再查撤回**: list_recalls(talker=..., limit=...)
   - total=0 → 告知用户该会话没有撤回记录
3. **取完整原文**: read_recall(talker, local_id)

**重要提示**：
- 守护未运行时，撤回查询会返回空结果
- 守护启动前发生的撤回无法查看
- gaps>0 表示有停机时段，那段时间的撤回看不到

**守护状态判断**：
- running=false → 进程未运行，功能不可用
- running=true, archived=0 → 刚启动，等待数据
- running=true, archived>0 → 正常工作
- alive=false, running=true → 疑似卡死
"""
```

---

## 三、修复执行计划

### 阶段 1: 文档修复（立即执行）

1. ✅ 更新 wechat-export-mcp 的 server.py INSTRUCTIONS
2. ✅ 更新 wechat-recall-mcp 的 server.py INSTRUCTIONS  
3. ✅ 在 wechat-export-mcp/README.md 明确 limit 参数作用域
4. ✅ 创建 Agent 使用指南文档

### 阶段 2: 代码修复（可选）

1. 考虑在 export_chat 返回中增加 `limit_applied` 字段，明确是否应用了 limit
2. 在 daemon_status 返回中增加 `ready_for_query` 布尔字段

### 阶段 3: 测试验证

1. Agent 测试：模拟 5 个典型场景
2. 边界测试：守护未运行、刚启动、数据为空等情况

---

## 四、验收标准

### wechat-export-mcp

- [ ] Agent 能正确识别何时使用 list_sessions
- [ ] Agent 理解 limit 只在关键词搜索时生效
- [ ] Agent 能正确选择 format 参数（分析用 json，分享用 html）
- [ ] 文件归档流程清晰（预览 → 确认 → 执行）

### wechat-recall-mcp

- [ ] Agent 始终先检查 daemon_status
- [ ] Agent 能正确处理守护未运行的情况
- [ ] Agent 能正确处理守护刚启动的情况
- [ ] Agent 能明确告知用户缺口的影响

---

## 五、修复后的 Agent 交互示例

### 示例 1: 导出聊天记录

```
用户: 导出我和张三的聊天记录

Agent 思路:
1. 不确定会话名 → list_sessions(query="张三")
2. 确认是 "张三-项目经理" 
3. export_chat(talker="张三-项目经理", format="json", out_dir="/export")
4. 返回: "已导出 342 条记录到 /export/张三-项目经理/chat.json"
```

### 示例 2: 搜索关键词

```
用户: 找出所有提到发票的消息

Agent 思路:
1. 关键词搜索 → export_chat(keyword="发票", format="json", out_dir="/search")
2. 扫描 287 个会话，命中 5 个
3. 返回: "找到 5 个会话提到'发票'，共 23 条消息，已导出到 /search/"
```

### 示例 3: 查看撤回消息

```
用户: 张三刚才撤回了什么？

Agent 思路:
1. 先检查守护 → daemon_status()
2. running=true, archived=29919 → 守护正常
3. list_recalls(talker="张三", limit=5)
4. 找到 2 条撤回，显示给用户
```

### 示例 4: 守护未运行

```
用户: 看看最近有没有人撤回消息

Agent 思路:
1. 先检查守护 → daemon_status()
2. running=false → 守护未运行
3. 返回: "撤回防护守护进程未运行。要查看撤回消息，请先启动守护进程：
   wechat-recall-mcp.exe --daemon
   
   启动后需等待 1-2 分钟收集数据。"
```

---

## 六、后续优化建议

1. **增加"导出预览"功能**：让 Agent 先看看会导出多少内容
2. **增量导出支持**：记录上次导出时间，只导增量
3. **批量操作**：支持一次导出多个会话
4. **守护健康检查**：定期检查守护状态，异常时告警

---

**修复完成时间**: 2026-10-18  
**测试状态**: ✅ 已实现并验证（export 26 项 / recall 17 项测试全绿；stdio 握手与 tools/call 冒烟通过）  

## 实际落地清单

### wechat-export-mcp v0.16.0（7 个工具）
- 新增 `preview_export`：条数 / 预估体积 / 命中会话，**不落盘**（`preview.py`，复用
  `build_records` / `keyword_hits` / `stats_of`，与真实导出同一套计数）
- 新增 `batch_export`：多会话逐条导出，`failed` 逐条报错（覆盖任务③）
- `export_chat` 新增 `incremental`：按 `<out_dir>/.export_state.json` 只导新增（任务②）
- 文档澄清：`limit` 仅在给 `keyword` 时生效（整段导出不截断）
- README / SKILL.md / 产品手册同步；文档漂移守卫（`test_docs_list_all_formats`）通过

### wechat-recall-mcp v0.14.0（5 个工具）
- 新增 `health_check`：复用 `daemon.status()` 判活口径，补充数据增长、磁盘余量、
  缺口，并给出**可执行的修复建议**（任务④）
- README / SKILL.md / 产品手册同步

### wechat-crm-mcp
- SKILL.md 新增「常见误用」：先摘要后原文、silence_ladder vs interaction_rank、
  hot_pairs 是线索不是结论、双口径时间戳、truncated 红灯、全库搜索性能、通讯录翻页
- 工具表标注 `silence_ladder` 扁平化键（`within_30` / `31_60` / `61_90` / `90_plus`）

### 未做（刻意）
- 守护"自动启动"不在 MCP 侧做：工具进程是 stdio、随客户端生死，启动常驻进程属于
  安装器 / 用户的动作；`health_check` 与 `daemon_status` 会在未运行时给出明确指令。
  （实测：守护启动后归档 29919 条 / 287 会话，`health_check=healthy`。）
