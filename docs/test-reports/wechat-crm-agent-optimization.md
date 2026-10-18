# wechat-crm-mcp Agent 使用优化指南

**优化日期**: 2026-10-18  
**目标**: 让 Agent 能流畅、正确地使用 wechat-crm-mcp 的 7 个工具

---

## 一、Agent 使用决策树

### 决策树 1: 用户问"谁久没联系"

```
用户: "哪些人很久没联系了？"
    ↓
判断: 是否指定了会话？
    ↓
NO → 使用 silence_ladder(scope="friend", days=[30,60,90])
    ├─ 返回分层结果（30天内/31-60天/61-90天/90天+/从没聊过）
    └─ 告诉用户每层的人数和代表人物
    
YES → 使用 contact_stats(talker="张三")
    ├─ 返回单个会话的沉默天数
    └─ 结合 customer_brief 看详细情况
```

**关键点**:
- `silence_ladder` 按**人**统计，能看到"通讯录有但从没说话"的人
- `interaction_rank(sort="recent")` 按**会话**统计，看不到从没私聊的人
- **区别**: silence_ladder 能找到"只在群里说过话、从没私聊"的人

---

### 决策树 2: 用户问"某人最近情况"

```
用户: "张三最近什么情况？"
    ↓
步骤 1: customer_brief(talker="张三", scan=5000)
    ├─ 获取: 消息条数、谁主动、回复速度、高频词、没回的问句
    ├─ 如果 truncated=true → 告知用户"超过5000条，只看了最近的"
    └─ 如果 count=0 → "你和张三没有聊天记录"
    ↓
步骤 2: 根据 customer_brief 结果决定是否深入
    ├─ 有 unanswered（没回的问句）→ 重点提醒用户
    ├─ hot_pairs（高频词）有特定主题 → 可能需要 search_messages
    └─ 用户要看原文 → read_messages(talker="张三", limit=200)
```

**关键点**:
- **先用 customer_brief**，不要直接 read_messages（太多原文）
- customer_brief 的 `unanswered` 是**行动项**，必须重点提示
- `hot_pairs` 是**线索不是结论**，不要说"他最近只聊这个"

---

### 决策树 3: 用户搜索关键词

```
用户: "谁提到过'报价'？" 或 "张三说过'报价'吗？"
    ↓
判断: 是否指定了会话？
    ↓
NO → search_messages(keyword="报价", limit=50)
    ├─ 全库搜索，返回所有会话的命中
    ├─ 告诉用户: 找到N个会话，共M条消息
    └─ 列出前几个会话和代表性消息
    
YES → search_messages(keyword="报价", talker="张三", limit=50)
    ├─ 单会话搜索
    ├─ 告诉用户: 在张三的会话里找到M条
    └─ 显示这些消息（时间+原文）
```

**关键点**:
- 不指定 `talker` = 全库搜索
- `truncated=true` → 告知用户"命中很多，只返回了前50条"
- **不要省略 talker 参数再补充过滤**，让工具直接筛选

---

### 决策树 4: 用户要列通讯录/群成员

```
用户: "我有哪些客户群？" 或 "XX群里都有谁？"
    ↓
判断: 要列群还是群成员？
    ↓
列群 → list_contacts(scope="group", keyword="客户", limit=0)
    ├─ scope="group" 只返回群
    ├─ keyword 过滤名字
    └─ limit=0 返回全部（不分页）
    
列群成员 → list_contacts(room="XX企业群", limit=0)
    ├─ room 参数触发群成员模式
    ├─ 返回 contacts（成员列表）
    ├─ 每个成员有 name（全局显示名）和 name_in_room（群昵称）
    └─ name_in_room 为空 = 该成员在这个群没设昵称（不是错误）
```

**关键点**:
- **群昵称是稀疏的**（本机9.6%），空就是空，别说"查不到"
- 群成员列表**包含用户自己**（is_me=true）
- 返回的 total 和微信里的群成员数应该一致

---

## 二、常见错误和正确用法

### 错误 1: 过度读取原文

❌ **错误示例**:
```python
# 用户问"张三最近怎么样"
messages = read_messages(talker="张三", limit=5000)  # 一次读5000条
# 然后让 LLM 总结...
```

✅ **正确用法**:
```python
# 先用 customer_brief 获取摘要
brief = customer_brief(talker="张三")
# brief 已经包含:
# - 消息条数、谁主动、回复速度
# - 高频词（客户在聊什么）
# - 没回的问句（行动项）

# 只有用户明确要看原文时才 read_messages
if user_wants_detail:
    messages = read_messages(talker="张三", limit=50)
```

**为什么**: customer_brief 已经做了汇总，直接用。读5000条原文浪费 token 且慢。

---

### 错误 2: 混淆 silence_ladder 和 interaction_rank

❌ **错误示例**:
```python
# 用户问"哪些人很久没联系了"
rank = interaction_rank(sort="recent", top=20)
# 返回了20个会话，但漏掉了"通讯录有、从没私聊"的2000+人
```

✅ **正确用法**:
```python
# 用 silence_ladder，它按"人"统计
ladder = silence_ladder(scope="friend", days=[30,60,90], top=20)

# 结果包含:
# - within_30: 30天内有互动的人
# - 31_60: 31-60天没联系的人
# - 61_90: 61-90天没联系的人
# - 90_plus: 90天以上没联系的人
# - never: 通讯录里有、全库从没说话的人（重点！）
```

**为什么**: 
- `interaction_rank` 只看**有消息的会话**，看不到"从没聊过的人"
- `silence_ladder` 能看到"只在群里说过话、从没私聊的人"

---

### 错误 3: 忽略 truncated 标记

❌ **错误示例**:
```python
result = search_messages(keyword="报价", limit=50)
# result["count"] = 50, result["total"] = 500
# 告诉用户: "找到50条消息"  ← 错误！实际有500条
```

✅ **正确用法**:
```python
result = search_messages(keyword="报价", limit=50)

if result["truncated"]:
    print(f"找到 {result['total']} 条消息，显示前 {result['count']} 条")
    print("要看更多可以缩小范围（指定会话或时间段）")
else:
    print(f"找到 {result['count']} 条消息")
```

**为什么**: `truncated=true` 说明命中很多，只返回了一部分。

---

### 错误 4: 把 hot_pairs 当结论

❌ **错误示例**:
```python
brief = customer_brief(talker="张三")
hot_pairs = brief["hot_pairs"]  # [{"text": "模型", "count": 15}, ...]

# 告诉用户: "张三最近只在聊模型"  ← 错误！hot_pairs 是线索
```

✅ **正确用法**:
```python
brief = customer_brief(talker="张三")
hot_pairs = brief["hot_pairs"][:5]  # 取前5个

# 告诉用户: "张三最近常提到: 模型、报价、发货..."
# 或: "从高频词看，张三最近可能在关注: ..."
# 强调这是"线索"，不是"他只聊这个"
```

**为什么**: hot_pairs 是 2-gram，会包含碎片词（"的时"），是**线索不是主题清单**。

---

### 错误 5: 忽略双口径（last_msg vs last_spoke）

❌ **错误示例**:
```python
ladder = silence_ladder(scope="friend")
person = ladder["31_60"]["contacts"][0]

# 告诉用户: "李四31-60天没联系了"
# 但实际上 last_msg 是60天前（私聊），last_spoke 是5天前（群里说过话）
```

✅ **正确用法**:
```python
ladder = silence_ladder(scope="friend")
person = ladder["31_60"]["contacts"][0]

if person["last_msg_ts"] != person["last_spoke_ts"]:
    print(f"李四: 你俩私聊是 {person['silent_days']} 天前，")
    print(f"但他 {person['last_spoke']} 在群里说过话")
else:
    print(f"李四: {person['silent_days']} 天没联系")
```

**为什么**: 两个口径不同是正常的。"群里活跃但从不私聊"的人很常见。

---

## 三、完整使用流程示例

### 场景 1: 客户跟进提醒

```python
# 用户: "帮我看看哪些客户该跟进了"

# 步骤 1: 沉默分层
ladder = silence_ladder(scope="friend", days=[30, 60, 90], top=10)

# 步骤 2: 重点关注 31-60 天这一档（即将流失）
at_risk = ladder["31_60"]["contacts"]

# 步骤 3: 对每个人快速看摘要
for person in at_risk[:5]:  # 只看前5个
    brief = customer_brief(talker=person["username"])
    
    # 判断是否值得跟进
    if brief["unanswered_count"] > 0:
        print(f"⚠️ {person['name']}: 有 {brief['unanswered_count']} 个问题没回")
    
    if brief["opened_by_them"] > brief["opened_by_me"] * 2:
        print(f"💡 {person['name']}: 他主动联系你的次数是你的2倍")

# 步骤 4: 告知用户决策建议
print("建议优先跟进有未回复问题的客户")
```

---

### 场景 2: 准备客户会面

```python
# 用户: "明天要见张三，帮我过一遍他的情况"

# 步骤 1: 客户简报（核心）
brief = customer_brief(talker="张三")

# 步骤 2: 提炼关键信息
print(f"张三 - 会面准备")
print(f"- 来往: {brief['segments']} 段对话，跨 {brief['span_days']} 天")
print(f"- 主动性: 他开场 {brief['opened_by_them']} 次，你 {brief['opened_by_me']} 次")
print(f"- 回复: 他回你 {brief['their_reply_s']}秒，你回他 {brief['my_reply_s']}秒")
print(f"- 最近沉默: {brief['silent_days']} 天")

# 步骤 3: 高频词（他最近在关心什么）
print(f"- 最近常提: {', '.join([p['text'] for p in brief['hot_pairs'][:5]])}")

# 步骤 4: 没回的问句（重点！）
if brief["unanswered_count"] > 0:
    print(f"\n⚠️ 注意: 有 {brief['unanswered_count']} 个问题你24小时内没回:")
    for q in brief["unanswered"]:
        print(f"  - [{q['time']}] {q['text']}")

# 步骤 5: 最近对话（可选）
recent = read_messages(talker="张三", limit=10)
print(f"\n最近10条对话:")
for msg in recent["messages"][-10:]:
    print(f"  [{msg['time']}] {msg['sender']}: {msg['text'][:50]}")
```

---

### 场景 3: 搜索特定话题

```python
# 用户: "谁和我聊过'大模型'？"

# 步骤 1: 全库搜索
result = search_messages(keyword="大模型", limit=100)

print(f"找到 {result['total']} 条消息，来自 {len(result['sessions'])} 个会话")

# 步骤 2: 按会话分组显示
for session in result["sessions"][:5]:  # 只显示前5个会话
    print(f"\n{session['name']}: {session['count']} 条")
    for msg in session["messages"][:3]:  # 每个会话只显示前3条
        print(f"  [{msg['time']}] {msg['text'][:100]}")

# 步骤 3: 提示
if result["truncated"]:
    print(f"\n💡 命中很多，只显示了前 {len(result['sessions'])} 个会话")
    print("可以指定会话或时间段缩小范围")
```

---

## 四、工具选择速查表

| 用户问题 | 使用工具 | 关键参数 |
|---------|---------|---------|
| 谁很久没联系了 | `silence_ladder` | scope="friend", days=[30,60,90] |
| 聊得最多的是谁 | `interaction_rank` | sort="count", top=20 |
| XX最近怎么样 | `customer_brief` | talker="XX", scan=5000 |
| 我有哪些群 | `list_contacts` | scope="group", limit=0 |
| XX群里都有谁 | `list_contacts` | room="XX", limit=0 |
| 谁提过XX（全库） | `search_messages` | keyword="XX", limit=50 |
| 张三说过XX吗 | `search_messages` | keyword="XX", talker="张三" |
| 看张三最近说的话 | `read_messages` | talker="张三", limit=50 |
| 张三我俩聊了多少 | `contact_stats` | talker="张三" |

---

## 五、返回结果关键字段说明

### customer_brief 返回（最常用）

```json
{
  "count": 614,           // 总消息数
  "from_me": 248,         // 我发的
  "from_other": 366,      // 对方发的
  "segments": 127,        // 分成多少段对话
  "opened_by_me": 44,     // 我主动开场的段数
  "opened_by_them": 83,   // 对方主动开场的段数 ← 重要指标
  "my_reply_s": 52,       // 我回复对方的中位速度（秒）
  "their_reply_s": 50,    // 对方回复我的中位速度（秒）
  "silent_days": 15.2,    // 最后一条消息距今多少天
  "unanswered_count": 1,  // 对方提问、我24小时内没回的数量 ← 行动项
  "unanswered": [         // 没回的问句列表
    {"time": "...", "text": "..."}
  ],
  "hot_pairs": [          // 对方高频词（线索，不是结论）
    {"text": "模型", "count": 15}
  ]
}
```

**Agent 使用提示**:
- `opened_by_them` > `opened_by_me` → 对方更主动
- `unanswered_count` > 0 → **必须提醒用户**
- `hot_pairs` → 说"可能在关注..."，不说"只聊..."

---

### silence_ladder 返回

```json
{
  "total": 2712,              // 通讯录总人数
  "within_30": {              // 30天内有互动
    "count": 117,
    "contacts": [...]
  },
  "31_60": {                  // 31-60天没联系
    "count": 54,
    "contacts": [...]
  },
  "never": {                  // 通讯录有、从没说话
    "count": 2540,            // ← 注意这个数字通常很大
    "contacts": [...]
  }
}
```

**Agent 使用提示**:
- `never` 的人数通常很大，是正常的
- 每个 contact 有 `last_msg`（私聊）和 `last_spoke`（含群）两个时间

---

## 六、性能考量

| 操作 | 预期耗时 | 优化建议 |
|-----|---------|---------|
| list_contacts | < 100ms | limit=200 够用 |
| contact_stats | < 500ms | 单次调用无问题 |
| silence_ladder | < 1s | 2000+人也很快 |
| interaction_rank | < 1s | 70+会话无压力 |
| customer_brief | < 1s | scan=5000 够用 |
| read_messages | < 500ms | limit=200 合理 |
| search_messages（单会话） | < 500ms | 快 |
| search_messages（全库） | 3-10s | 能接受 |

**优化建议**:
1. **先用汇总工具**（customer_brief），再读原文
2. **全库搜索**加 limit，避免返回过多
3. **分批处理**：对多个人做分析时，每人单独调用

---

## 七、错误处理

### 错误码含义

| error_code | 含义 | Agent 应该怎么做 |
|-----------|------|----------------|
| `env_not_ready` | 微信未就绪 | 告知用户"请先登录微信" |
| `target_not_found` | 会话名不唯一 | 显示 candidates，让用户选择 |
| `bad_args` | 参数错误 | 检查参数，修正后重试 |

### 典型错误处理

```python
# 会话名不确定
result = contact_stats(talker="张三")

if not result.get("ok", True):
    if result["error_code"] == "target_not_found":
        candidates = result.get("candidates", [])
        print("找到多个'张三':")
        for c in candidates:
            print(f"  - {c['name']} ({c['talker']})")
        print("请说明具体是哪一个")
```

---

## 八、总结：Agent 的"黄金流程"

```
用户提问
    ↓
第1步: 判断意图（找人？看人？搜内容？）
    ↓
第2步: 选对工具（见速查表）
    ↓
第3步: 先汇总、后详情
    - silence_ladder → 找人
    - customer_brief → 看人
    - read_messages → 详情
    ↓
第4步: 解读结果
    - 区分"线索"和"结论"
    - 注意 truncated 标记
    - 重点提示 unanswered
    ↓
第5步: 给出建议（不替用户决策）
```

**核心原则**:
1. **工具只给事实，Agent 给建议，用户做决定**
2. **先摘要后原文**（省 token 也省时间）
3. **重视 unanswered**（这是最明确的行动项）
4. **不要忽略"从没说话的人"**（silence_ladder.never）

---

**文档版本**: v1.0  
**适用于**: wechat-crm-mcp v0.14.0+  
**更新日期**: 2026-10-18
