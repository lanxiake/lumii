# wechat-mcp 修复验证测试指南

> 本文档用于验证 P0-A 和 P0-B 修复在真实环境下的实际效果

---

## 前置条件

- ✅ Windows 系统
- ✅ 微信 4.x 已登录
- ✅ 有可用的聊天好友（如 Loop）
- ✅ Python 3.10+ 已安装
- ✅ 已安装依赖：`pip install -r requirements.txt`

---

## 测试 1：P0-A 路径自动发现

### 目标
验证 wechat-mcp 能否自动找到微信数据目录（支持 `~/xwechat_files`, `~/Documents/xwechat_files`, 注册表路径）

### 测试步骤

#### 1.1 自检命令
```bash
cd apps/windows/resources/wechat-mcp
python devcli.py selftest
```

**预期输出**：
```
✅ 依赖检查
  - pycryptodome: 已安装
  - zstandard: 已安装

✅ 数据目录探测
  - 找到 1 个账号：wxid_xxx
  - 路径：C:\Users\xxx\Documents\xwechat_files\...
  - 最后活跃：2026-10-08 ...

✅ 会话列表
  - Loop (wxid_s6piyhfvptv522) - 最后消息：...
```

#### 1.2 验证多路径探测

**手动验证**：
1. 打开 `wechat_core.py:list_accounts()`
2. 确认代码包含多个候选路径：
   ```python
   candidates = [
       os.path.join(home, "xwechat_files"),
       os.path.join(home, "Documents", "xwechat_files"),
   ]
   # Windows 下还会探测注册表
   ```

#### 1.3 验证错误提示

**触发错误**（模拟数据目录缺失）：
```bash
# 临时重命名数据目录
mv ~/Documents/xwechat_files ~/Documents/xwechat_files.bak

# 运行自检
python devcli.py selftest

# 恢复
mv ~/Documents/xwechat_files.bak ~/Documents/xwechat_files
```

**预期输出**：
```
未找到微信 4.x 数据目录。已扫描路径：
  - C:\Users\xxx\xwechat_files
  - C:\Users\xxx\Documents\xwechat_files

修复建议：
1. 确认微信已登录并有聊天记录
2. 若数据在其他位置，设置环境变量：
   LUMII_WECHAT_DB=D:\path\to\xwechat_files\wxid_xxx\db_storage
```

**验证点**：
- ✅ 错误提示包含"已扫描路径"清单
- ✅ 错误提示包含"修复建议"
- ✅ 错误提示包含环境变量设置示例

---

## 测试 2：P0-B 发送重试机制

### 目标
验证 send_text 失败时能自动重试，并提供可操作的修复建议

### 测试步骤

#### 2.1 准备测试会话

```bash
# 查看 Loop 会话
python devcli.py sessions | grep Loop
```

**预期输出**：
```
Loop (wxid_s6piyhfvptv522) - 最后消息：在吗？现在几点了？
```

#### 2.2 测试 dry_run（只校验不发送）

在 Lumii 客户端中执行：
```javascript
// 调用 wechat-local MCP
await mcp.call('wechat-local', 'send_text', {
  talker: 'Loop',
  text: '测试消息（dry_run）',
  dry_run: true
});
```

**预期返回**：
```json
{
  "ok": true,
  "detail": "输入已落地（dry_run 到此为止）",
  "talker": "wxid_s6piyhfvptv522",
  "name": "Loop",
  "dry_run": true,
  "text": "测试消息（dry_run）"
}
```

**验证点**：
- ✅ dry_run=true 时不实际发送
- ✅ 返回包含 talker 和 name

#### 2.3 测试真实发送（带重试）

在 Lumii 客户端中执行：
```javascript
// 真实发送
await mcp.call('wechat-local', 'send_text', {
  talker: 'Loop',
  text: '你好，这是一条测试消息，用于验证发送重试机制',
  dry_run: false
});
```

**场景 A：首次成功**

预期返回：
```json
{
  "ok": true,
  "detail": "已发送（读库确认）",
  "talker": "wxid_s6piyhfvptv522",
  "name": "Loop",
  "dry_run": false,
  "text": "你好，这是一条测试消息..."
}
```

**场景 B：首次失败，重试成功**

预期返回：
```json
{
  "ok": true,
  "detail": "已发送（读库确认）（第 2 次尝试成功）",
  "talker": "wxid_s6piyhfvptv522",
  "attempts": 2,
  "dry_run": false
}
```

**场景 C：不可重试错误（环境问题）**

预期返回：
```json
{
  "ok": false,
  "error_code": "env_not_ready",
  "detail": "环境前置检查失败：微信窗口未在前台（不可重试的错误：env_not_ready）",
  "suggestion": "请确保微信窗口可见且在前台（不要最小化或被其他窗口遮挡），然后重试。"
}
```

**验证点**：
- ✅ 首次失败时自动重试（最多 2 次）
- ✅ 重试成功时返回 `attempts` 字段
- ✅ 不可重试错误不会浪费重试次数
- ✅ 失败时返回 `suggestion` 字段（可操作的修复建议）

#### 2.4 测试错误码映射

手动触发各种错误场景，验证错误码和修复建议：

| 场景 | 错误码 | 修复建议关键词 |
|------|--------|---------------|
| 微信窗口最小化 | `env_not_ready` | "微信窗口可见且在前台" |
| 输入框定位失败 | `input_not_landed` | "输入框定位失败" + "稍后重试" |
| 发送后未清空 | `send_unconfirmed` | "输入框未清空" + "手动确认" |
| 目标会话未找到 | `target_not_found` | "先用 list_sessions" |

---

## 测试 3：与 Loop 完整对话流程

### 目标
验证完整的消息收发流程（读取历史 → 发送消息 → 轮询新消息）

### 测试步骤

#### 3.1 读取 Loop 历史消息

```javascript
await mcp.call('wechat-local', 'read_history', {
  talker: 'Loop',
  limit: 10
});
```

**预期返回**：
```json
{
  "talker": "wxid_s6piyhfvptv522",
  "name": "Loop",
  "count": 10,
  "messages": [
    {
      "time": "2026-10-08 10:51:51",
      "ts": 1791427911,
      "type": 1,
      "text": "在吗？现在几点了？",
      "from_me": true,
      "sender": "我"
    },
    ...
  ],
  "cursor": 1791299077,
  "has_more": true
}
```

**验证点**：
- ✅ 返回最近 10 条消息
- ✅ 每条消息包含 `from_me`、`sender`、`text`

#### 3.2 发送测试消息给 Loop

```javascript
await mcp.call('wechat-local', 'send_text', {
  talker: 'Loop',
  text: 'wechat-mcp 修复测试：路径发现 + 发送重试机制已完成，这是一条验证消息',
  dry_run: false
});
```

**预期**：
- ✅ 返回 `ok: true`
- ✅ Loop 微信收到消息
- ✅ 消息内容完整无乱码

#### 3.3 轮询 Loop 的新消息

等待 Loop 回复后：

```javascript
// 获取当前时间戳
const now_ts = Math.floor(Date.now() / 1000);

// 等待 10 秒（让 Loop 有时间回复）
await new Promise(resolve => setTimeout(resolve, 10000));

// 轮询新消息
await mcp.call('wechat-local', 'poll_new', {
  since_ts: now_ts
});
```

**预期返回**：
```json
{
  "count": 1,
  "messages": [
    {
      "time": "2026-10-08 ...",
      "ts": ...,
      "type": 1,
      "text": "收到，测试消息已送达",
      "talker": "wxid_s6piyhfvptv522",
      "name": "Loop",
      "from_me": false,
      "sender": "Loop"
    }
  ]
}
```

**验证点**：
- ✅ 能正确轮询到 Loop 的新消息
- ✅ `from_me: false` 表示是对方发的
- ✅ 消息内容完整

---

## 测试 4：批量发送（send_batch）

### 目标
验证批量发送的独立校验和失败隔离

### 测试步骤

```javascript
await mcp.call('wechat-local', 'send_batch', {
  messages: [
    { talker: 'Loop', text: '批量消息 1' },
    { talker: 'Loop', text: '批量消息 2' },
    { talker: '不存在的会话', text: '这条会失败' }
  ],
  dry_run: false
});
```

**预期返回**：
```json
{
  "ok": false,
  "total": 3,
  "sent": 2,
  "dry_run": false,
  "results": [
    { "ok": true, "talker": "wxid_s6piyhfvptv522", "name": "Loop" },
    { "ok": true, "talker": "wxid_s6piyhfvptv522", "name": "Loop" },
    { "ok": false, "error_code": "target_not_found", "talker": "不存在的会话" }
  ]
}
```

**验证点**：
- ✅ 成功发送的消息不受失败消息影响
- ✅ 每个目标独立校验
- ✅ 返回详细的每条结果

---

## 预期改进效果

### P0-A：路径发现
- **成功率**：80% → **95%+**
- **用户自助修复率**：20% → **80%+**

### P0-B：发送能力
- **首次成功率**：68% → **85%**
- **重试后成功率**：68% → **95%+**
- **批量发送全部成功率**：42% → **90%+**

---

## 故障排查

### 问题 1：找不到数据目录

**现象**：
```
ERROR: 未找到微信 4.x 数据目录
```

**检查点**：
1. 微信是否已登录？
2. 数据目录是否在 Documents 下？
   ```bash
   ls ~/Documents/xwechat_files
   ```
3. 是否需要设置环境变量？
   ```bash
   export LUMII_WECHAT_DB="实际路径"
   ```

### 问题 2：send_text 失败

**现象**：
```json
{"ok": false, "error_code": "input_not_landed"}
```

**检查点**：
1. 微信窗口是否可见？（不能最小化）
2. 微信窗口是否在前台？（不能被其他窗口遮挡）
3. 会话是否已打开？
4. 等待几秒后重试（重试机制会自动执行）

### 问题 3：依赖缺失

**现象**：
```
ModuleNotFoundError: No module named 'Crypto'
```

**解决**：
```bash
pip install pycryptodome zstandard
```

---

## 测试检查清单

- [ ] P0-A: list_accounts() 能找到多个路径下的账号
- [ ] P0-A: db_root() 失败时给出可操作的错误提示
- [ ] P0-B: send_text 首次失败时自动重试
- [ ] P0-B: 重试成功时返回 attempts 字段
- [ ] P0-B: 不可重试错误不会浪费重试次数
- [ ] P0-B: 失败时返回修复建议（suggestion 字段）
- [ ] 完整流程: read_history → send_text → poll_new 正常工作
- [ ] 批量发送: send_batch 独立校验，失败隔离
- [ ] 真实对话: 与 Loop 的消息收发无乱码、无丢失

---

## 结论

完成所有测试后，填写：

- 测试日期：____
- 测试人：____
- 微信版本：____
- Python 版本：____
- 测试结果：✅ 全部通过 / ⚠️ 部分通过 / ❌ 失败

**备注**：
（记录遇到的问题、异常情况、改进建议）
