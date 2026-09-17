# 第 2 章动手实验：台账记忆 + 检索打分

两个实验都**只用 Python 标准库、完全离线**（不调任何 API、不需要嵌入模型），Python ≥ 3.8 直接运行。

```
hands-on/ch02/
├── ledger.py             # 实验 A：文件台账记忆系统
├── retrieval_demo.py     # 实验 B：Generative Agents 检索打分离线复刻
├── sample_memories.json  # 实验 B 的 20 条样例记忆（NOW 固定，输出可复现）
└── README.md
```

## 实验 A：文件台账记忆系统

```bash
python ledger.py demo              # 跑内置演示（会在当前目录生成 ledger.json）
python ledger.py validate ledger.json   # 全量 schema 校验
```

演示覆盖第 2 章的全部台账纪律，按输出小标题对号入座：

| 演示步骤 | 对应机制 | 证据出处 |
|---|---|---|
| ADD 三条领域经验 | 写入即带 `evidence` 编号指针 | Generative Agents（反思带被引记忆编号） |
| agent 改 `passes`/`state` | agent 只准改状态字段 | Anthropic harness（feature list JSON + passes） |
| 改 `id`/`text` 被拦截 | 越权字段 = 抛错，不靠提示词恳求 | Anthropic harness（"只准改 passes"） |
| 整本删行被拦截 | 结构闸门：失效必须走 supersede | Anthropic harness（JSON 比 Markdown 难改坏） |
| UPVOTE/DOWNVOTE 到阈值标 `rejected` | 计数语义、否决不删除 | ExpeL insight 池 |
| `supersede` 只写 `superseded_at` | 非破坏性失效（双时间线） | Zep/Graphiti（设 `t_invalid`，不删边） |
| `active_view` 只含活跃条目 | 台账是派生视图，不是原始日志 | MemGPT/Letta DMR 数据链（见章内 §四 提醒） |

**你应该观察到什么**：
1. 两类"越权写"（改字段、删条目）都被**代码**拒绝，提示词里根本不需要出现"请不要改 id"；
2. 失效后的条目仍在账上——`cat ledger.json` 能看到完整历史；
3. `passes=true` 而 `evidence` 为空时，校验器给出警告（状态必须可被证据支撑）。

## 实验 B：检索打分演示

```bash
python retrieval_demo.py                    # 内置三组对照（推荐先跑这个）
python retrieval_demo.py "数据库 迁移"        # 任意查询，论文默认权重 alpha=beta=gamma=1
python retrieval_demo.py "微信 回复 短" --wr 0.3 --wi 1.5 --wg 2.5 --topk 3
python retrieval_demo.py "推送 太浅" --half-life 3   # 缩短 recency 半衰期
```

打分公式复刻 Generative Agents（arXiv:2304.03442 §4.1）：
`score = α·recency + β·importance + γ·relevance`，三个分量先在本批次内 min-max 归一化再线性加权（论文里 α=β=γ=1，recency 衰减因子 0.995，importance 由 LLM 写入时打 1–10 分）。本实验的三处离线近似：recency 用半衰期指数衰减（按天）、relevance 用词元重叠 Jaccard（中文按二元组切分）、importance 直接读样例字段。

内置演示对 3 个 gold 查询各跑三档权重：

| 档位 | 权重 | 隐喻 |
|---|---|---|
| A 论文默认 | wr=1, wi=1, wg=1 | 论文的原始配置 |
| B 近期偏好 | wr=2.5, wi=0.7, wg=0.7 | 多数聊天框架的默认倾向 |
| C 事实优先 | wr=0.3, wi=1.5, wg=2.5 | 台账/档案型系统 |

**你应该观察到什么**：
1. 查询「微信 渠道 回复 简短 偏好」的 gold（M01，75 天前写的用户偏好，重要性 9）：A 档第 2 名，**B 档跌到第 14 名——top5 截断后就是"该检索的检索不到"**，C 档回到第 1；
2. 查询「MySQL PostgreSQL 迁移」的 gold（M02，40 天前）同样在 B 档消失（第 13 名）——注意 B 档挤进 top5 的全是重要性 0–2 的"今天推了什么"式噪音；
3. 对照查询（M03，新+相关+重要）在三档全部第 1——**检索失败从不发生在"新鲜"的记忆上，专杀"老而重要"**；
4. 自己调权重做交易：把 `--wr` 调大，旧记忆消失；把 `--wg` 调大到压过一切，则会召回无关但关键词巧合的条目。不存在一组权重让新旧通吃——这就是论文把 "failed to retrieve relevant memories" 列为最常见错误来源的原因，也是"读取路径要先于存储设计"的原因。

## 排障

- Windows 控制台报编码错：`set PYTHONIOENCODING=utf-8` 后再运行（脚本内已尽力自适配，个别老终端仍可能出问题）。
- 找不到 `python`：Windows 上从 python.org 装完整版，或用 `winget install python`。
