# Lumii CLI 完整测试用例

## 测试目标

验证 lumii-ui CLI 的核心功能在真实环境下可正常工作，确保：
1. 命令能正确执行并返回预期结果
2. 参数解析正确
3. 错误处理符合预期
4. 与实际用户体验一致

## 测试环境

- **CLI 路径**: `apps/windows/resources/app-ui-cli/lumii-ui.mjs`
- **控制口端口**: 默认 3333
- **测试数据**: docs/test/lumii-cli/测试材料/

## 测试分组

### A. 基础命令测试（Layer UI）

#### A1. screenshot - 截图功能
- **目的**: 验证能否成功截取当前界面
- **步骤**:
  1. 执行 `lumii-ui screenshot`
  2. 检查返回包含 `jpeg` 字段（Base64 编码）
  3. 检查返回包含 `elements` 数组
- **预期**: 返回 JSON，包含截图数据和可交互元素列表

#### A2. screenshot --annotate - 标注截图
- **目的**: 验证 SoM (Set-of-Mark) 标注功能
- **步骤**:
  1. 执行 `lumii-ui screenshot --annotate`
  2. 检查返回的截图包含标注编号
  3. 验证 `snapshotId` 存在
- **预期**: 截图上有元素编号标注

#### A3. goto - 页面导航
- **目的**: 验证能否导航到不同页面
- **步骤**:
  1. 执行 `lumii-ui goto --view dashboard`
  2. 执行 `lumii-ui goto --view settings`
  3. 执行 `lumii-ui goto --view settings --category agents`
- **预期**: 成功切换页面，返回 `{ success: true }`

#### A4. click - 点击元素
- **目的**: 验证能否点击界面元素
- **步骤**:
  1. 先执行 `screenshot --annotate` 获取 ref
  2. 选择一个可点击元素的 ref
  3. 执行 `lumii-ui click --ref <ref> --snapshot-id <id>`
- **预期**: 成功点击，返回 `{ success: true }`

### B. Wiki 功能测试（Layer A）

#### B1. wiki overview - 知识库概览
- **目的**: 验证能获取知识库统计信息
- **步骤**:
  1. 执行 `lumii-ui wiki overview`
  2. 检查返回包含 `sources`, `entities`, `relations` 等字段
- **预期**: 返回知识库统计数据

#### B2. wiki search - 搜索资料
- **目的**: 验证全文搜索功能
- **步骤**:
  1. 执行 `lumii-ui wiki search --q "测试关键词"`
  2. 检查返回结果数量
  3. 验证结果包含 `title`, `content`, `score` 字段
- **预期**: 返回相关搜索结果

#### B3. wiki read - 读取资料
- **目的**: 验证能读取指定资料
- **步骤**:
  1. 先通过 search 获取一个 source_id
  2. 执行 `lumii-ui wiki read --id <source_id>`
  3. 检查返回完整内容
- **预期**: 返回资料的完整 Markdown 内容

#### B4. wiki capture - 捕获网页
- **目的**: 验证网页捕获功能
- **步骤**:
  1. 执行 `lumii-ui wiki capture --url "https://example.com" --title "测试页面"`
  2. 等待捕获完成
  3. 检查返回的 source_id
- **预期**: 成功捕获网页，返回 source_id

### C. Agent 功能测试（Layer B）

#### C1. agent list - 列出 Agent
- **目的**: 验证能获取 Agent 列表
- **步骤**:
  1. 执行 `lumii-ui agent list`
  2. 检查返回的 agents 数组
  3. 验证每个 agent 包含 `id`, `name`, `type` 字段
- **预期**: 返回 Agent 列表

#### C2. agent info - Agent 详情
- **目的**: 验证能获取 Agent 详细信息
- **步骤**:
  1. 先获取一个 agent_id
  2. 执行 `lumii-ui agent info --id <agent_id>`
  3. 检查返回的详细信息
- **预期**: 返回 Agent 配置和状态信息

#### C3. agent send - 发送消息
- **目的**: 验证能向 Agent 发送消息
- **步骤**:
  1. 执行 `lumii-ui agent send --id <agent_id> --message "测试消息"`
  2. 等待响应
  3. 检查返回的消息内容
- **预期**: Agent 正常响应

### D. Cron 功能测试（Layer B）

#### D1. cron list - 列出定时任务
- **目的**: 验证能获取定时任务列表
- **步骤**:
  1. 执行 `lumii-ui cron list`
  2. 检查返回的 crons 数组
  3. 验证每个任务包含 `id`, `schedule`, `enabled` 字段
- **预期**: 返回定时任务列表

#### D2. cron create - 创建定时任务
- **目的**: 验证能创建新的定时任务
- **步骤**:
  1. 执行 `lumii-ui cron create --schedule "0 9 * * *" --prompt "每日总结" --agent-id <id>`
  2. 检查返回的任务 ID
  3. 验证任务已创建
- **预期**: 成功创建任务，返回 cron_id

#### D3. cron delete - 删除定时任务
- **目的**: 验证能删除定时任务
- **步骤**:
  1. 先创建一个测试任务
  2. 执行 `lumii-ui cron delete --id <cron_id>`
  3. 验证任务已删除
- **预期**: 成功删除任务

### E. Memory 功能测试（Layer B）

#### E1. memory search - 搜索记忆
- **目的**: 验证记忆搜索功能
- **步骤**:
  1. 执行 `lumii-ui memory search --q "用户偏好"`
  2. 检查返回的记忆列表
  3. 验证结果相关性
- **预期**: 返回相关记忆

#### E2. memory read - 读取记忆
- **目的**: 验证能读取指定记忆
- **步骤**:
  1. 先通过 search 获取 memory_id
  2. 执行 `lumii-ui memory read --id <memory_id>`
  3. 检查返回内容
- **预期**: 返回记忆详细内容

### F. 错误处理测试

#### F1. 无效命令
- **步骤**: 执行 `lumii-ui invalid-command`
- **预期**: 返回错误信息，退出码 1

#### F2. 缺少必需参数
- **步骤**: 执行 `lumii-ui goto`（缺少 --view）
- **预期**: 返回参数错误，退出码 2

#### F3. 无效参数值
- **步骤**: 执行 `lumii-ui goto --view invalid-view`
- **预期**: 返回错误信息，退出码 1

#### F4. 控制口未启动
- **步骤**: 在程序未启动时执行任意命令
- **预期**: 返回连接错误

### G. Help 系统测试

#### G1. 主帮助
- **步骤**: 执行 `lumii-ui help`
- **预期**: 显示所有可用命令分组列表

#### G2. 命令帮助
- **步骤**: 执行 `lumii-ui help screenshot`
- **预期**: 显示 screenshot 命令的详细用法

#### G3. JSON 格式帮助
- **步骤**: 执行 `lumii-ui help --json`
- **预期**: 返回 JSON 格式的命令列表（供 Agent 使用）

## 测试优先级

### P0 (必须通过)
- A1, A3 (基础截图和导航)
- B1, B3 (Wiki 概览和读取)
- C1 (Agent 列表)
- D1 (Cron 列表)
- F1, F2 (错误处理)
- G1 (帮助系统)

### P1 (重要功能)
- A2, A4 (标注截图和点击)
- B2, B4 (Wiki 搜索和捕获)
- C2, C3 (Agent 详情和消息)
- D2, D3 (Cron 创建和删除)
- E1, E2 (Memory 搜索和读取)

### P2 (增强功能)
- F3, F4 (边界错误处理)
- G2, G3 (详细帮助)

## 测试数据要求

- 至少 1 个已存在的 Wiki 资料
- 至少 1 个已配置的 Agent
- 至少 1 个已创建的 Memory
- 测试 URL: https://example.com （用于 wiki capture）

## 成功标准

- P0 测试全部通过
- P1 测试通过率 ≥ 90%
- 无严重错误（程序崩溃、数据丢失）
- 响应时间合理（大部分命令 < 1s）
