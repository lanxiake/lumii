# 第 2 章 · Agent 记忆架构：从上下文窗口到台账

> **本章解决什么问题**：Agent"写了记忆"却在要用的时候想不起来、或者想起来的是错的——本章拆解这件事为什么必然发生在没有读取路径和写入纪律的系统里，以及从论文到生产系统给出的工程解法。**预计阅读 20–25 分钟**。**前置知识**：第 1 章（Agent 循环与上下文窗口）；动手实验需要 Python 3.8+，无需任何 API Key。

## 一、为什么这件事重要

先看一组来自真实系统的数字（出自本教程的内部调研，2026-09 实测）：一个负责资讯策展的 Agent，长期记忆库里躺着 **5 条**经验。其中一条是相当值钱的领域知识——"搜索结果被日历和导航类页面严重污染，直接抓新闻源列表页才可靠"。这是通用模型靠自身永远攒不出来的东西。但下一轮执行时，这 5 条经验**一条也没被用到**。

为什么？三个叠加的机制性原因：

1. **执行实例是无状态的。** 定时触发的执行走"创建实例 → 注入提示词 → 执行 → 销毁"，历史消息根本不会进上下文。能跨执行传递的，只有被显式存下来、并且在下一轮被显式注入的东西。
2. **写入没有确定通道，读取更没有。** 那 5 条经验靠提示词命令写入；读取则指望模型"自己想起来去搜"——在全库两百多条记录里碰运气。写和读之间没有任何必然联系。
3. **巩固产垃圾，没人把关。** 同一库中还混着一条被截断的残缺记录（半句话加一个悬空的 `"}]`）。写路径上没有 schema 校验，垃圾进了库，读路径就得替它买单。

这三条拼出本章的主线判断：

> **对多数 Agent 而言，"记忆没起作用"不是存得不够多，而是写得不可寻、读了没通道。** 本章先给分类框架（§二），再走一遍 2023–2026 的研究与工程演化（§三），核对关键数字（§四），然后列出反模式和一套可直接抄的台账设计清单。

## 二、核心概念与框架

### 2.1 CoALA 四分法：记忆的分类，以及"反思"到底在哪一层

CoALA（*Cognitive Architectures for Language Agents*，arXiv:2309.02427，Sumers et al., Princeton，发表于 TMLR，**A 级**）是目前引用最多的分类框架。它把一个 Agent 的记忆分为：

| 记忆类型 | 存什么 | 语言 Agent 里的典型实现 |
|---|---|---|
| **working memory**（工作记忆） | 当前决策周期活跃的信息 | 上下文窗口 / prompt 本身 |
| **episodic memory**（情景记忆） | 具体经历与交互轨迹 | 历史消息库、日志、检索得到的旧对话 |
| **semantic memory**（语义记忆） | 关于世界和用户的概括知识 | 向量库、知识库、事实表、本文说的"台账" |
| **procedural memory**（程序性记忆） | "怎么做"的能力 | 模型权重、提示词、代码化的技能/工具 |

CoALA 还有一个容易被引用者漏掉的建模决定：**"反思"不是一层记忆，而是 learning action**——即"向长期记忆写入"的动作。与之对称，retrieval 是"从长期记忆读入工作记忆"的动作。这个视角转换很值钱：

- 争论"要不要反思"是虚的；
- 该问的是：反思产生的**写操作**，写了什么形态的东西（semantic？procedural？）、写进哪条通道、下游哪段代码会消费它。

第 4 节会看到，反思这个写动作要是没人管，会写出"自信而错误"的记忆并被反复引用（Honest Lying 论文实测 121 条反思 0 条命中，**C 级预印本**，见 §四）。

### 2.2 管道的三段：写路径、存储、读路径

把记忆当管道看，几乎所有设计争论都会自动归位：

```
观察/结论 ──写路径──> 存储形态 ──读路径──> 工作记忆（上下文窗口）
   ↑ 谁决定存什么、以什么结构存    ↑ 台账/向量/图/日志      ↑ 谁保证该回来的回来
```

Schema-Grounded Memory（arXiv:2604.27906，**C 级预印本**，2026-05 提交）给出了这条轴上最有工程味的一句话：生产的记忆需求是**精确事实、当前状态、更新与删除、聚合、关系、否定查询、显式未知**——这些操作要求记忆"**less like search, more like a system of record**"（更像记录系统，而不是更像搜索）；其做法是把解释工作从读路径搬到写路径，"reads become constrained queries over verified records"。这两句都是论文摘要原文（已核验）。写路径辛苦一次，读路径才能廉价且确定地正确。

第二个关键观念：**派生视图不是记录源**。台账、摘要、反思，都是从原始记录（episode 日志）派生出来的视图；派生必然有损（§四会用数字说明损到什么程度），所以**原始日志必须无损保留**，派生层只负责"让该被看见的被看见"。

### 2.3 台账设计清单

把散在各论文和工程文档里的机制收拢，得到一张可以直接抄走的表（出处与等级在 §三、§四展开）：

| # | 纪律 | 要点 | 出处与等级 |
|---|---|---|---|
| 1 | **用 JSON，不用 Markdown** | 模型改坏/整段覆盖 JSON 文件的倾向显著低于 Markdown | Anthropic 工程博客原话，**A** |
| 2 | **每条带可判定的状态字段** | 如 `passes: true/false`、`state: open/done/blocked/rejected/superseded` | Anthropic harness（feature list 的 passes 字段），**A** |
| 3 | **agent 只准改状态字段** | `id`、`created_at`、`ns`、失效时间戳等结构字段由 harness 独占；越权写=代码拒绝，不靠提示词恳求 | Anthropic（"edit this file only by changing the status of a passes field"），**A** |
| 4 | **计数语义管理"可信度"** | ADD / UPVOTE / DOWNVOTE / EDIT，净票触底降级为 rejected，**不删除** | ExpeL insight 池，**B**（论文自述机制） |
| 5 | **非破坏性失效** | 新事实取代旧事实：旧条目只写 `superseded_at` 时间戳；随时可回放"当时为什么那么认为" | Zep/Graphiti 边失效（置 `t_invalid`），**B** |
| 6 | **结论挂证据指针** | 反思/概括必须带"因为 1、2、8、15"式的被引编号，能跳回原始记录 | Generative Agents 反思格式，**A** |
| 7 | **命名空间隔离** | `/agent/{id}/...` 式路径树 + 按 scope 检索；CrewAI 的 scope 树与 agent 私有视角为**一手文档，A**；内部文档给的"深度 ≤3"未独立核验 | CrewAI 文档 |
| 8 | **尺寸门槛决定要不要检索栈** | 数据小就全部放上下文（Letta：<50k 字符 / <20 块，原文核验，**A**）；大了才分文件/归档/外置 | Letta 文档 |
| 9 | **写入触发器是事件，不是轮数** | 新证据入库即重算相关条目；按"每 N 轮反思一次"写会漏关键时点 | Generative Agents（重要性累计过阈值触发反思）+ Anthropic，**A/B** |
| 10 | **字段准入门槛** | "每个新增字段必须有代码路径消费它；证明不了下游效用就不加"——内部调研的自我修正，**工程原则（源自内部文档）** | — |

第 3、5、10 条值得多说一句：它们的共同点是**把纪律交给代码而不是交给模型**。提示词里写"请不要删除旧记录"是许愿；写路径上"删除请求一律改写为失效时间戳，越权字段直接抛异常"才是架构。实验 A（§六）会用不到 300 行标准库代码把这两道闸门立起来。

## 三、研究与工程演化线（按发表时间）

> 内部调研给的组织顺序偏主题（MemGPT→Letta→GA→…），本节按论文实际发表时间重排，方便看出因果。

**2023-04 · Generative Agents（arXiv:2304.03442，UIST '23，A）**。Smallville 25 个智能体，给后世留下三件遗产。第一，检索打分公式：`score = α·recency + β·importance + γ·relevance`，三成分 min-max 归一化后线性加权，论文实现里 **α=β=γ=1**；recency 按上次被访问后的沙盒游戏小时做指数衰减（**衰减因子 0.995**），importance 由 LLM 在写入时打 1–10 分（论文例子："打扫房间"=2，"约 crush 出去"=8），relevance 是嵌入余弦相似度。第二，反思机制：当最近感知事件的重要性总和越过阈值（**实现里 150**，约每天反思两三次），就检索相关记忆、提炼高层洞察、**连同被引记忆编号**写回记忆流；反思之上还能再生反思，形成论文 Figure 7 的反思树。第三，也是最扎心的一条：论文摘要原话——跨评测最常见的错误是 *"the agent failed to retrieve relevant memories"*（检索不到该检索的记忆），其次才是编造润色。（以上全部从 UIST 原文 PDF 核验，**A**。）

**2023-08 · ExpeL（arXiv:2308.10144，清华，B）**。不动参数，让 Agent 从经验池里学：成功/失败轨迹对比提炼自然语言 insight，池子用 **ADD / EDIT / UPVOTE / DOWNVOTE** 维护，归零出局；推理时 insight + 最相似的若干条成功轨迹（FAISS 检索）一起进 prompt。相对 ReAct 基线的成功率：HotpotQA 39% vs 28%、ALFWorld 59% vs 40%、WebShop 41% vs 35%。消融还埋了一个后面要用的伏笔：**哪个学习模式赢，取决于任务**——HotpotQA 靠 insight（36% vs 31%），ALFWorld 靠检索原始轨迹（55% vs 50%）。

**2023-09 · CoALA（arXiv:2309.02427，TMLR，A）**。见 §2.1。它把当时四散的 agent 工程收进一个坐标系，并给出"反思=learning action、检索=retrieval action"的动作切分。

**2023-10 · MemGPT（arXiv:2310.08560，UC Berkeley，数字按 B 级——本页核验未见同行评审记录）**。核心类比：LLM 上下文 = 物理内存，外部存储 = 磁盘，**虚拟内存分页**由 LLM 自己用函数调用管理。主上下文分三区（系统指令 / working context / FIFO 队列），外部上下文两类（recall 可搜索的历史消息、archival 通用归档），外加中断（memory pressure 告警触发压缩搬家）。它同时提出了 **DMR（Deep Memory Retrieval）**基准——后文所有"35.3%""94.8%"之争的舞台就是它。论文 Table 2（GPT-4 Turbo）：固定上下文基线只允许看"过去五个会话的有损摘要"（即递归摘要范式），**35.3%**；套上 MemGPT（分页检索全量历史）**93.4%**（GPT-4 上是 32.1%→92.5%，GPT-3.5 是 38.7%→66.9%）。（从 arXiv v2 PDF 原文核验。）

**2024–2025 · Letta：MemGPT 产品化**。论文团队把系统做成开源有状态 Agent 平台（MemGPT 更名 Letta），并把"该用什么记忆形态"写成了工程文档。Context hierarchy 页的原文判据（当前路径 `docs.letta.com/v1-sdk/memory/context-hierarchy/`，内部文档引用的 `/guides/agents/context-hierarchy` 为旧路径，已核验）：

> "For smaller amounts of data, it is best to simply place everything into the context window with memory blocks. For larger amounts of data, you may need to store data externally and retrieve it."

配套表格给的推荐上限：**memory block 总量 <50k 字符、单 Agent <20 块**；文件 <100 个（单个 5MB）；archival 无限但每段约 300 token。这是全领域唯一给出了具体尺寸的"要不要上检索栈"判据（一手工程文档，**A**；注意它是工程建议而非基准结论）。

**2025-01 · Zep / Graphiti（arXiv:2501.13956，Zep 厂商论文，B）**。时间知识图谱引擎 Graphiti，两件事值得一提。其一，**bi-temporal 双时间线**（论文原文）：时间线 T 记录事实本身的起止有效期，时间线 T′ 记录系统摄入/失效的事务时间；每条边带四个时间戳（`t_created`、`t_expired`、`t_valid`、`t_invalid`）。新知识与旧边矛盾时，LLM 判定后**把旧边的 `t_invalid` 置为新边的 `t_valid`——失效而非删除**（从 PDF 原文核验）。其二，DMR 复测：full-conversation 基线 94.4%（gpt-4-turbo）/ 98.0%（gpt-4o-mini）、会话摘要基线 88.0%、Zep 94.8% / 98.2%、MemGPT 93.4%——但 Zep 自己承认这些结果"must be contextualized"，DMR 区分度有限（详见 §4.2 的数字侦探课）。LongMemEval 上"最高提升 18.5%、延迟降 90%"为厂商自报（**B**）。

**2025-04 · Mem0（arXiv:2504.19413，Mem0 厂商论文，B）**。两阶段管道：**抽取**（新消息 + 最近 m=10 条消息 + 滚动摘要 → LLM 抽候选事实）、**更新**（对 top-s=10 相似旧记忆逐个判定 **ADD / UPDATE / DELETE / NOOP**，工具调用形式）。LOCOMO 基准（10 段长对话，平均 600 轮 / 2.6 万 token）：LLM-as-a-Judge 总分 Mem0 66.88、带图变体 Mem0g 68.44（摘要自述"图约高 2%"），全上下文 72.90 最高但按厂商自己的说法"算力不可接受"；效率侧宣称 p95 延迟比全上下文低 91%、token 成本省 90%+，自家每对话约 7k token 对 Zep 的 ">600k"（互有利害，都按 **B** 读）。**分类别的关键数字见 §4.3**——那是"结构化 vs 自然语言"之争里最重要的反例。

**2026 上半年 · 基准与反思的警钟**。
- **MemoryAgentBench**（arXiv:2507.05257，UCSD，C——第三方中立、但预印本）：提出记忆 Agent 的四项核心能力——**准确检索 AR、测试时学习 TTL、长程理解 LRU、选择性遗忘 SF**（新增 FactConsolidation 数据集专测旧事实被推翻），把长上下文数据改造成增量多轮格式。结论一句话：现有系统**没有任何一家四项全过关**。
- **Schema-Grounded Memory**（arXiv:2604.27906，xmemory 厂商预印本，C）：§2.2 的 system-of-record 论点出处。写路径分解为对象检测→字段检测→字段值抽取，配校验门、局部重试、有状态 prompt 控制。自报端到端记忆功能 F1 **97.10%**（对比第三方基线 80.16–87.24%）、应用层任务 95.2%。自家产品自家基准，谨慎读，但**架构论证与查询类型清单是三年来对"台账该长什么样"最清楚的表述**。
- **Honest Lying**（arXiv:2605.29463，C）：给"反思的危险"提供了实测——reflexion 式 Agent 会**存储对任务自信但错误的解释**并持续据此行动（作者命名 memory confabulation）。ALFWorld 中筛出 16 个卡死环境，**121 条反思没有一条提到正确目标物**；换成"从轨迹里程序化提取失败信号"后，正确目标提及率 0%→86%，RRR（Reflection Repetition Rate，同一条错误反思被反复倚重的比率）0.64→0.10，解卡 3/16。机械可判定的结论，让代码去得，别让模型反思。

**一条主线**：2023 年大家在解决"塞不下"（MemGPT 分页、GA 检索），2025 年重心移到"读得出"（Letta 的尺寸判据、MAB 的读侧基准），2026 年的新话术是"写得诚实"（写路径 schema、双时间线、RRR）。三层每一层都有了自己的证据，但**跨厂商的基准至今没有一个能互相换算**——下一节用数字说明这句话有多重要。

## 四、关键实证数据

### 4.1 证据总表

| 结论 | 关键数字 | 出处 | 等级 | 注意事项 |
|---|---|---|---|---|
| 反思/学习是写动作，不是记忆层 | 概念框架 | CoALA, TMLR | **A** | 概念性结论，无数字 |
| 检索失败是记忆系统头号死因 | "most common errors: failed to retrieve relevant memories"（定性） | Generative Agents, UIST'23 | **A** | 同行评审；定性结论 |
| 检索三因子与全部超参 | 衰减 0.995；重要性 1–10；阈值 150；α=β=γ=1 | 同上 | **A** | 超参是游戏沙盒调的，迁移需重调 |
| 反思要挂证据指针、可成树 | 反思带"因为 1,2,8,15"编号；Figure 7 | 同上 | **A** | — |
| 递归摘要丢信息（正确对照） | 固定上下文+5 会话有损摘要 35.3% → MemGPT 93.4%（GPT-4 Turbo，DMR） | MemGPT 论文 Table 2 | **B** | 论文自测；同模型同数据的合法对照 |
| DMR 上全上下文近天花板 | full-conversation 94.4%（gpt-4-turbo）/ 98.0%（gpt-4o-mini） | Zep 论文 §4.2 | **B** | 厂商复测；佐证"数据小直接全量进上下文" |
| 台账 <50k 字符不需要向量库 | <50k 字符 / <20 块 | Letta context hierarchy 文档 | **A**（一手文档） | 是建议不是实验结论 |
| 非破坏性失效可直接抄 | 四时间戳；置 `t_invalid` 不删边 | Zep 论文原文 | **B**（机制描述可靠） | 商用闭源实现细节以论文为限 |
| 文件台账优于复杂记忆工具 | Letta Filesystem 74.0%（GPT-4o-mini, LoCoMo）vs Mem0 自报最优 68.5% | Letta 博客（攻击方一手） | **A/B** | Letta 公开质疑 Mem0 的 MemGPT 基线复现方式，双方各执一词 |
| 计数语义 + 否决不删除 | ADD/UPVOTE/DOWNVOTE/EDIT，归零出局 | ExpeL | **B** | 机制自述；提升数字见下行 |
| 经验学习有效，且赢面随任务变 | 39/28、59/40、41/35；insights-only 36%>31%（HotpotQA）、retrieve-only 55%>50%（ALFWorld） | ExpeL | **B** | 论文自测 |
| 图记忆并非免费的 | single-hop：Mem0 67.13 为全表最优；multi-hop：Mem0 51.15 领先（图变体更低） | Mem0 论文 | **B** | 见 §4.3 的数字勘误 |
| 反思会写进自信的错误并被反复引用 | 121 条反思 0 命中；0%→86%；RRR 0.64→0.10 | Honest Lying | **C** | 预印本；方向比数值可信 |
| 记忆基准四项无人全过关 | AR/TTL/LRU/SF | MemoryAgentBench | **C** | 第三方中立；预印本 |
| 生产记忆=记录系统而非搜索 | 端到端 F1 97.10 vs 80.16–87.24 | Schema-Grounded/xmemory | **C** | 自家产品自家基准 |

### 4.2 数字侦探课：「35.3% vs 98.0%」的真身世

内部调研里"递归摘要 35.3% vs 全上下文 98.0%（DMR）"这组对仗非常流行，值得做一次完整的数字取证——本章写作时逐一回查了出处：

- **35.3%**：✅ 核验属实。MemGPT 论文 Table 2，**GPT-4 Turbo**，固定上下文基线（只许看 5 个会话的有损摘要）在 DMR 上的成绩；
- **98.0%**：✅ 数字属实，但它是 **Zep 论文复现里 gpt-4o-mini 跑全上下文**的成绩（gpt-4-turbo 是 94.4%）；
- 也就是说，这对数字是**两篇论文、两个模型、两套实现**的拼接，不是同一次实验的两臂。

拼起来看，结论对不对？对，而且比原句更有意思：

1. **"巩固有损"用最干净的对照即可成立**：同模型同数据，35.3%（摘要）→ 93.4%（MemGPT 分页），信息是被摘要程序吃掉的，不是模型笨。推论不变：**台账/摘要是派生视图，原始日志必须无损保留**。
2. **"数据量小别折腾"被独立佐证**：会话装得进上下文时，全上下文就是接近满分（94.4–98.0%）的答案——这正是 Letta <50k 判据的实证面。顺带这也说明 DMR 本身太弱（Zep 原文自己承认），后来 Mem0/Zep 都转战 LOCOMO 和 LongMemEval。
3. **最大的教训关于读数字的姿势**：Mem0、Zep、Letta 的每个百分比都产自**各自设定的基线、各自调的超参、各自版本的模型**。Letta 甚至公开质疑 Mem0 论文中 MemGPT 的 LoCoMo 跑法"无法复现且未获澄清"，并用"把对话放文件里让 Agent 自己 grep"这样土气的方案拿了 74.0%（GPT-4o-mini）反超 Mem0 自报最优 68.5%。三个记忆赛道的玩家互相拿对方的产品当基线、又互相拆台——**把任何一张厂商对比表当成绝对标尺，都是在拿别人的营销素材当自己的架构依据**。

### 4.3 结构化 vs 自然语言：正反证据都要摆

**支持结构化**的一方（按证据力排序）：Schema-Grounded 的查询类型清单——计数、聚合、时序、否定、当前状态、显式未知，这些恰是语义检索的天然盲区（C 级，但论证完整）；MemoryAgentBench 把"选择性遗忘/冲突更新"列为四大能力之一且无人过关（C 级，中立第三方）；Zep 在时序推理类问题上确实靠图结构回本（B 级，厂商自报，其 temporal 类 F1 51.55 高于纯文本变体）。

**反对"越结构越好"**的一方，最有分量的证据来自**正方自己的消融实验**：Mem0 论文里，加上图记忆（Mem0g）之后，**single-hop 是 Mem0（非图）的 67.13 分居全表之首，multi-hop 同样是非图的 Mem0 以 51.15 领先**——图结构在这两类问题上**输给了一句话一条的自然语言记忆**（Mem0 摘要明言图变体只在整体分和时序/开放域上回本）。内部文档给出的图变体具体分值（65.71 / 47.19）与上述方向一致，但**具体数值源自内部文档，本次未逐位核验**，按规矩标注。另有内部文档引用"IBM/VLDB 2026：重结构会把 token 预算花在下游检索栈根本不用的抽象上"——**本次未能核验到该出处**，保留原话、降低置信。

把两边放在一起，得出的不是"谁赢"，而是一个分治规则：

> **按查询类型分配存储形态。** 计数 / 聚合 / 时序 / 否定 / 当前状态 → 结构化记录（台账，写路径上完成解释）；叙事性回忆、主题联想、"上次我们聊到哪" → 自然语言条目 + 检索。ExpeL 的消融（HotpotQA 吃 insight、ALFWorld 吃原始轨迹）在任务维度上说了同一句话。**用一种记忆形态包打天下，才是被证据否定掉的那个选项。**

## 五、反模式与常见误解

1. **上来就上向量库/知识图谱。** 先问总量：低于 Letta 判据（<50k 字符 / <20 块）的记忆，直接进上下文窗口或 memory block，检索栈是纯负债——多一层检索就多一层"该检索的检索不到"。Letta 博客里"文件系统 + grep 反超专用记忆工具"（74.0 vs 68.5）是这条判据最扎眼的注脚。
2. **用递归摘要替代原始日志。** 35.3% vs 93.4% 的同臂对照说明巩固必然有损。正确姿势：原始 episode 永远保留（append-only），摘要是其上可随时重建的派生视图；摘要错了，改视图不改源。
3. **以为存了就能用上。** UIST'23 论文摘要点名的头号错误、MemoryAgentBench 的 AR 能力项、内部调研"5 条靠运气碰"都是它。设计顺序应当倒过来：**先定义"哪段代码在什么时机、用什么查询读取这条记忆"，再决定它怎么存**。没有预定读者的记忆条目，等于没有写。
4. **让模型反思出机械可判定的结论。** Honest Lying：121 条反思 0 命中，程序化提取失败信号后 0→86%。能对账的事（阈值、时间窗、计数、schema）交给代码；反思只留给真正模糊的模式归纳，且输出必须挂证据指针、受 RRR 类指标监控。
5. **把厂商基准表当标尺。** 同一个"记忆框架"，Mem0、Zep、Letta 互相报出的分数差出天际，且互相指控对方跑法不对（§4.2）。选型时只信两类数字：自己数据上自己跑的评测；以及一手文档里的工程判据。
6. **台账加字段不加门槛。** 内部调研的自我修正值得裱起来："每个新增字段都必须有代码路径消费它；证明不了下游效用就不加。"否则三个月后你会对着一张 20 列、只有 3 列有人读的 JSON 表发呆。

## 六、动手实践

代码在 `hands-on/ch02/`，纯标准库、离线、Python ≥ 3.8。跑法与完整预期输出见同目录 README.md，这里给目标与观察要点。

### 实验 A：文件台账记忆系统（`ledger.py`）

实现一个 JSON 台账：条目含 `id / ns / text / state / passes / upvotes / downvotes / evidence / supersedes / superseded_at`，演示 ADD→合法状态写→越权写被拦→整本删行被拦→投票降级→supersede 失效→schema 校验→派生视图。

```bash
python ledger.py demo
```

你应该观察到：**两类越权（改 `id`/`text`、删除条目）都是被代码拒绝的**，报错信息直接指出违禁字段——"agent 只准改状态字段"不是一句 prompt，而是 `AGENT_MUTABLE_FIELDS` 白名单加一层结构 diff；失效的 L003 仍在 `ledger.json` 里带时间戳躺着，而注入用的 `active_view` 里只有活跃条目；`passes=true` 却没有证据会触发校验警告。

### 实验 B：检索打分演示（`retrieval_demo.py` + `sample_memories.json`）

离线复刻 Generative Agents 的 `α·recency + β·importance + γ·relevance`（relevance 用词元重叠近似，中文按二元组切分；recency 用半衰期衰减；分量先 min-max 归一化——与论文做法一致）。20 条带时间戳的样例记忆、3 个标注了 gold 条目的查询，各跑三档权重。

```bash
python retrieval_demo.py                    # 三组对照
python retrieval_demo.py "数据库 迁移" --wr 0.3 --wi 1.5 --wg 2.5
```

实际跑出来的关键现象（本机 3.12 验证过）：查询"微信 渠道 回复 简短 偏好"，gold 是 75 天前写的用户偏好（重要性 9）——论文默认权重（1/1/1）下排第 2；**换成偏近期的权重（2.5/0.7/0.7）跌到第 14 名，top-5 截断后就是一次教科书级的"该检索的检索不到"**，挤掉它的全是重要性 0–2 的日报噪音；改成事实优先（0.3/1.5/2.5）它回到第 1。对照组"mapper 表结构报错"（新鲜+相关+重要）在三档下全部第 1——**检索失败专杀"老而重要"，不碰"新而平庸"**。继续自己扫权重会体会更深的无奈：`--wg` 拉满则关键词巧合的无关条目开始混入。**不存在一组权重新旧通吃；能兜底的只有第 2.3 节那条纪律——重要的东西别指望"检索得到"，让它以状态字段的形式常驻派生视图。**

## 七、本章小结

1. **反思不是记忆层，是写动作**（CoALA）。评估任何"自我进化"方案，就问三件事：写进哪类记忆、什么形态、下游谁消费。
2. **写入触发用事件，不用轮数**：新证据入库即重算；重要性累计过阈值再反思（GA 的实现是 150）。
3. **先设计读取路径，再设计存储**——"写得进 ≠ 用得上"是 UIST'23 摘要级别的定论，也是 MemoryAgentBench 四项皆弱的根源。
4. **数据小别上检索栈**：<50k 字符 / <20 块（Letta）直接进上下文；"文件 + grep"经常打爆花哨的记忆中间件。
5. **巩固必有损**：递归摘要在同臂对照下 35.3% vs 93.4%。台账只是派生视图，原始 episode 日志不可回收地保留。
6. **失效要非破坏**：学 Graphiti，写 `superseded_at` / `t_invalid`，永远不删行——历史是审计和复盘的本钱。
7. **结构化按查询类型分治**：计数/聚合/时序/否定查询走 system-of-record，叙事回忆走自然语言检索；连 Mem0 自己的消融都承认图记忆在 single/multi-hop 上更差。
8. **厂商数字互不可比**：Mem0/Zep/Letta 各自定基线调超参，还互相指控对方跑错；"35.3% vs 98.0%"这种流行对仗句都可能是跨论文跨模型的拼接。自己数据上自己测。
9. **纪律交给代码**：JSON 而非 Markdown、agent 只准改状态字段、字段准入需有消费方——三道闸门共约 100 行，值得抄。

## 八、参考文献

| # | 文献 | URL | 证据等级 | 核验状态 |
|---|---|---|---|---|
| [1] | Sumers et al., *Cognitive Architectures for Language Agents* (CoALA), TMLR | https://arxiv.org/abs/2309.02427 | A | ✅ 已核验（Semantic Scholar：TMLR；alphaXiv 页面全文概述） |
| [2] | Park et al., *Generative Agents: Interactive Simulacra of Human Behavior*, UIST '23 | https://arxiv.org/abs/2304.03442 | A | ✅ 已核验（UIST'23 原文 PDF，数字逐条核对） |
| [3] | Zhao et al., *ExpeL: LLM Agents Are Experiential Learners* | https://arxiv.org/abs/2308.10144 | B | ✅ 已核验（alphaXiv 页面；同行评审状态未核验，数字按论文自测） |
| [4] | Packer et al., *MemGPT: Towards LLMs as Operating Systems* | https://arxiv.org/abs/2310.08560 | B（数字）/ 一手方法描述 | ✅ 已核验（arXiv v2 PDF Table 2：35.3/93.4/32.1/92.5/38.7/66.9） |
| [5] | Letta Docs, *Context Hierarchy* | https://docs.letta.com/v1-sdk/memory/context-hierarchy/ （旧路径 /guides/agents/context-hierarchy） | A（一手工程文档） | ✅ 已核验（页面原文含 <50k 字符 / <20 块） |
| [6] | Letta Blog, *Benchmarking AI Agent Memory* | https://www.letta.com/blog/benchmarking-ai-agent-memory/ | A（攻击方为一手；对 Mem0 的指控属 Letta 单方） | ✅ 已核验（74.0% / 68.5% / 质疑原文俱在） |
| [7] | Rasmussen et al., *Zep: A Temporal Knowledge Graph Architecture for Agent Memory* | https://arxiv.org/abs/2501.13956 | B（厂商自报） | ✅ 已核验（v1 PDF：bi-temporal、四时间戳、94.8/93.4/94.4/98.0/88.0） |
| [8] | Chhikara et al., *Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory* | https://arxiv.org/abs/2504.19413 | B（厂商自报） | ✅ 已核验（摘要 + 全文概述：66.88/68.44/72.90/67.13/51.15、ADD/UPDATE/DELETE/NOOP）；图变体 65.71、47.19 **源自内部文档·未逐位核验** |
| [9] | Hu et al., *Evaluating Memory in LLM Agents via Incremental Multi-Turn Interactions* (MemoryAgentBench) | https://arxiv.org/abs/2507.05257 | C（第三方，预印本） | ✅ 已核验（alphaXiv：四能力项、无系统全过关） |
| [10] | Petrov et al., *From Unstructured Recall to Schema-Grounded Memory* | https://arxiv.org/abs/2604.27906 | C（预印本 + 自家产品基准） | ✅ 已核验（摘要原文含 system of record / write path 表述与 97.10/80.16–87.24） |
| [11] | Dixit et al., *Honest Lying: Understanding Memory Confabulation in Reflexive Agents* | https://arxiv.org/abs/2605.29463 | C（预印本） | ✅ 已核验（摘要：0/121、0→86%、RRR 0.64→0.10、3/16；发表场所未核验） |
| [12] | Anthropic Engineering, *Effective Harnesses for Long-Running Agents* (2025-11-26) | https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents | A（大厂一手工程文档） | ✅ 已核验（passes 字段 JSON、只准改状态、JSON vs Markdown 原话） |
| [13] | CrewAI Docs, *Memory* | https://docs.crewai.com/en/concepts/memory | A（一手工程文档，未同行评审） | ✅ 已核验（复合打分 semantic+recency+importance、半衰期参数、scope 树）；"深度≤3"与"只读 slice" **源自内部文档·未核验** |
| [14] | 内部调研《一级公民的积累与演化》（2026-09-16） | 本地：uploads/2026-09-16/ | 内部文档 | 其引用数字凡未过本表核验的，正文均已就地标注 |
| [15] | "IBM/VLDB 2026 重结构浪费 token 预算"一说 | — | 未能核验 | ⚠️ 源自内部文档·未独立核验，正文已降级表述 |

> 证据分级：**A** = 同行评审论文或大厂一手工程文档；**B** = 厂商自报数据（基准与超参各自设定，互不可比）；**C** = 预印本 / 未核验。方法描述（"X 论文提出了 Y 机制"）以论文自身为一手来源；经验数字（百分比）则按上述等级打折读。
