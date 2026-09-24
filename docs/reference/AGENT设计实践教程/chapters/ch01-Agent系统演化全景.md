# 第 1 章 · Agent 系统演化全景：从 Prompt 工程到 Agent Harness

> **本章解决什么问题**：把 2022–2026 年散落的一地术语——CoT、ReAct、function calling、RAG、harness、上下文工程、多智能体——放回同一张地图上，弄清每一步演化是在修补什么问题；并给出全书的组织框架（CoALA 认知架构 + 最小 Agent 循环），让后面六章各自知道自己在装哪个零件。
> **预计阅读时长**：30–40 分钟（不含动手实验）
> **前置知识**：调用过一次 LLM API（任何一家都行）；不需要机器学习背景。

---

## 一、为什么这件事重要

先看一组真实故障（源自内部项目实测，见文末参考文献 [18]）：

一个团队做"智能运维 Agent"，按 2023 年最流行的做法搭了架子：用某框架拆出规划、检索、执行三个 Agent，接上 31 个工具，演示效果不错。上线两个月后暴露的问题全都不在模型上——

- **计划任务没有历史**。定时触发的每次执行都是全新实例，上一轮得出的结论这一轮完全看不见。"会话记录"是给用户看的界面产物，Agent 执行时读不到。积累的通路只有一条：显式存下来、显式注入回去。
- **31 个工具里没人说得清哪些真的在用**。模型选错工具的事故复盘下来，几乎都是语义相近的工具互相干扰，而不是单个工具本身有问题。
- **子 Agent 之间"传话走样"**。规划 Agent 说"清理过期数据"，执行 Agent 理解成了另一个意思，两边各自做了没写在任务书里的决定。

这三个故障分别对应后来业界命名的三件事：**状态外部化、工具面治理、上下文工程**。它们没有一个能靠"换个更强的模型"解决。

这就是本章要建立的视角：**Agent 的能力 = 模型能力 × 模型之外那套系统的可靠性**。过去四年，行业注意力从前者逐步转移到后者——这条注意力的迁移线，就是本章的时间线。读懂它，你至少获得两个判断力：给手上的 Agent 问题时，知道它属于哪一层；看到新技术名词时，知道它在补哪个洞、值不值得投入。

---

## 二、核心概念与框架

### 2.1 先分清两种系统：workflow 与 agent

Anthropic 在 2024 年 12 月的《Building effective agents》[7]（发布 2024-12-19，一手工程文档）里给了目前业界引用最多的区分，原文定义：

> **Workflows** are systems where LLMs and tools are orchestrated through **predefined code paths**.
> **Agents**, on the other hand, are systems where LLMs **dynamically direct their own processes** and tool usage, maintaining control over how they accomplish tasks.

区分标准只有一条：**下一步做什么，由谁决定**。代码提前写死路径的是 workflow；模型自己决定调哪个工具、还要不要继续的是 agent。这个区分不是文字游戏——它直接决定了成本模型（agent 用延迟和 token 换灵活性）、错误模式（agent 的错误会复利式累积）和评估方法（workflow 测路径，agent 测轨迹分布）。

同一篇文章还给出了常被引用的一句告诫：*"finding the simplest solution possible, and only increasing complexity when needed. This might mean not building agentic systems at all."* 注意这句话写于 2024 年 12 月——正是多 Agent 炒作最热的时候，而作者是卖 Agent 能力最强的厂商。这个反差到 2026 年变成了明确结论，§三详述。

### 2.2 最小 Agent Loop 解剖

剥掉所有框架的抽象，一个 agent 循环只做五件事：

```
初始化 messages = [system(说明书), user(任务)]
重复:
  ① 上下文组装   决定这一轮把哪些 token 放进 messages
  ② 模型调用     messages → assistant 回复
  ③ 工具调用     回复里若带 tool_calls，逐个执行
  ④ 结果回填     把每个工具结果作为 tool 消息追加进 messages
  ⑤ 终止判断     无工具调用 → 采纳回答；步数超限 → 强制停止
```

两个设计决策值得单独说。

**终止条件不是兜底，是产品设计。**《Building effective agents》[7] 在描述 agent 时专门提到要 *"include stopping conditions (such as a maximum number of iterations) to maintain control"*。没有终止条件的循环，就是 2023 年春天烧光无数 API 额度的那批自主 Agent 的直接死因（见 §三）。

**错误字符串应该回填，而不是抛异常。** 工具失败时把 `ERROR: ...` 当作工具结果塞回上下文，模型下一轮"看得见"失败，才有机会换路径。这一行代码的差别，就是"能自愈的 agent"和"一崩就全崩的脚本"的差别——第六章会把这点推广成"程序化失败信号优于模型自我反思"的一般原则。

**上下文组装是循环里最不显眼、却最贵的一步。** Anthropic 2025-09-29 的《Effective context engineering for AI agents》[9] 给出了这套方法论的核心论据：上下文是**边际收益递减的有限资源**。他们引用 Chroma 的 "context rot" 研究（第三方技术报告，未见同行评审，证据等级 C）：随上下文 token 数增加，模型从中提取信息的能力下降，且这一现象在所有模型上出现。机理上，transformer 的 n² 全注意力被长序列"拉薄"，模型因此存在一个"注意力预算"（attention budget），每个新 token 都在消耗它。推论很直接：**往上下文里塞东西是有账本的**——工具定义要算账、历史轨迹要压缩、外部记忆要按需检索而不是全量注入。这句话是第二章和第四章的理论地基。

### 2.3 agent = model + harness：一个正在成共识的公式

harness（也叫 scaffold，脚手架/线束）指**模型之外、让模型能持续干活的一切**：提示词与上下文的组装逻辑、工具注册与执行、沙箱与护栏、重试与超时、状态持久化、评估钩子。这个公式式表述不是某篇文章的修辞，而是几方独立说到了同一件事：

| 来源 | 表述 | 证据等级 |
|---|---|---|
| Anthropic《Effective harnesses》[10]（2025-11-26） | 直接把 Claude Agent SDK 称为 *"a powerful, general-purpose agent harness"*，并指出核心难题是"跨多个上下文窗口持续干活" | A（一手工程文档，定性） |
| Anthropic《Building effective agents》[7] | agent *"typically just LLMs using tools based on environmental feedback in a loop"*；并自述做 SWE-bench 时"花在优化工具上的时间比优化整体提示词更多" | A（定性）/ B（轶事数字） |
| OpenAI《A Practical Guide to Building Agents》[16] | 把 agent 拆解为 model + tools + instructions 的组合说明书（经 Cognition 文章 [12] 引用核实存在，**间接核验**） | B |
| MAGE 论文 [6]（2026-07，单作者预印本） | 低数据量（N=30）时 *"scaffold choice dominates optimizer choice"*——固定脚手架胜过一切迭代优化器 | C（未复现） |

为什么公式成立，有三条互相独立的理由：

1. **模型可替换，循环不可省略。** 第六章动手实验里，把 `call_openai` 换成一个纯规则桩，`agent_loop()` 一行不改照样跑完——"决定下一步"和"执行、回填、判终止"是可分离的两层，后者才是你真正拥有的资产。
2. **错误集中在协调层。** MAST [5] 对 1600+ 条多 Agent 轨迹标注出的 14 种失败模式，三大类是系统设计缺陷、Agent 间失调、任务验证不足（A，摘要数字已核验）——大部分失败模式在单模型基准测试里根本观察不到。
3. **模型升级的红利要经 harness 兑现。** 同一个新模型接到 31 个语义重叠的工具上，和接到 15 个边界清晰的工具上，得到的完全是两个产品。

需要诚实标注的边界：这是个**有用的工程近似**，不是物理定律。模型足够强之后，一部分 harness 职责（如上下文管理）会被模型厂商吸进产品里——Anthropic 2024 年那篇《Building effective agents》在 2026 年重发时顶部加了一条注，大意是"文中描述的很多工具层格局已经变化，最新做法见 Managed Agents"——连"哪层归模型、哪层归 harness"的分界线本身都在移动 [7]。公式的价值在于帮你提问：**这个 bug 该怪模型，还是怪我递给模型的上下文？**

### 2.4 CoALA：给全书用的解剖图

《Cognitive Architectures for Language Agents》（CoALA，arXiv:2309.02427，TMLR 2023，已核验 [4]）不是当年引用最高的论文，却是最好用的**组织框架**：它借用 Soar/ACT-R 这一支认知科学的传统，把语言 Agent 拆成"记忆分层 + 决策循环 + 动作类型"三块。后面六章的内容全部能挂到这张图上。

**四类记忆**：

| 记忆类型 | 装什么 | Agent 里的对应物 | 本书章节 |
|---|---|---|---|
| working | 当前正在处理的信息 | 上下文窗口内的 messages | ch01（本章）+ ch02 边界讨论 |
| episodic | 自身经历 | 轨迹日志、会话档案、失败案例库 | ch02 |
| semantic | 关于世界的事实 | 知识库、用户画像、台账 | ch02 / ch07 |
| procedural | 怎么做事的规则 | **系统提示词、工具定义、技能库** | ch03 / ch04 |

把系统提示词和工具归类为 procedural memory，是这张图最有穿透力的一个视角：**提示词和工具就是 Agent 的程序性记忆**，它们和执行历史（陈述性记忆）性质不同——前者改变行为方式，后者只提供可检索的事实。后面讲提示词进化（ch03）和工具治理（ch04）时，你会反复看到这个区分的作用。

**决策循环**：每一轮从记忆中检索相关信息 → 推理与规划 → 从动作空间里选型。CoALA 把动作分成**内部动作**（推理、检索、学习）和**外部动作**（与世界交互、向人沟通），执行结果再写回记忆。

**学习动作——这份框架最重要的建模选择**：CoALA 不把"反思"设为记忆的一个层，而是建模为**学习动作**：对长期记忆执行写操作的行为。这个选择值得讲透，因为三个工程后果都从中推出：

- **反思不写进记忆，就不算学习。** 任务结束时丢弃的反思（Reflexion 的反思不跨任务，见 [18] §2.2 的辨析）在 CoALA 框架里不构成学习动作——Agent 什么都没获得。这一条直接戳穿了"加了反思环节 = Agent 会变聪明"的流行幻觉。
- **写记忆是动作，就有失败模式和审计问题。** 写错了会污染后续行为（ch02 会讲到"自信但错误的解释被持续倚重"的实证），所以写入需要像写数据库一样讲准入、讲回滚。
- **动作可以由模型做，也可以由代码做。** "从轨迹里提取经验"不必是 LLM 的自由发挥，可以是确定性的程序化提取——第六章的主张在此已埋下伏笔。

---

## 三、研究与工程演化线（2022–2026）

先给总表，再讲故事。已核验项均给出来源编号；未独立核验项显式标注。

| 时间 | 里程碑 | 修补了什么问题 | 暴露了什么新问题 |
|---|---|---|---|
| 2020-05 | RAG 论文 [3]（NeurIPS 2020，已核验） | 生成模型缺最新/私有知识 | （当时是预训练检索增强，LLM 时代才工程化） |
| 2022-01 | CoT [1]（arXiv:2201.11903，已核验） | 模型不输出中间步骤就容易答错推理题 | 只改"怎么说"，模型仍碰不到外部世界 |
| 2022-10 | ReAct [2]（arXiv:2210.03629，ICLR，已核验） | 推理与行动分离：让思考指导行动、行动反哺思考 | 手工解析文本式行动输出，脆弱 |
| 2023 上半年 | AutoGPT 类自主循环流行（GitHub 仓库存在已核验；2023-05 已有中文教程 [18]） | "模型可以连续自主干活"的想象验证 | 无终止条件、无验证、无预算控制 → 大面积失控烧钱 |
| 2023-06-13 | OpenAI function calling [14]（已核验） | 工具调用从解析 hack 变成 API 一等公民 | 工具多了怎么选（问题被推迟到 2024-2025） |
| 2023 下半年 | RAG 工程化与编排框架潮 | 检索接入、样板代码复用 | 框架抽象盖住了 prompt 与响应，难调试（[7] 点名批评） |
| 2023-09 | CoALA [4]（已核验） | 缺一个统一的概念框架 | —（框架论文，无部署负担） |
| 2024-11-25 | MCP 开源 [15]（已核验） | 每个数据源各写一套集成的 N×M 问题 | 工具面进一步膨胀 |
| 2024-12-19 | 《Building effective agents》[7]（已核验） | 行业被框架和复杂架构带偏 | —（此后"agent = LLM 在循环里用工具"成为默认定义） |
| 2025-03 | MAST [5]（发表信息已核验；失败率数字未核验） | 把"多 Agent 不好用"变成可分类的实证 | 14 种失败模式大多无快速解 |
| 2025-04 | OpenAI《A Practical Guide to Building Agents》[16]（间接核验） | 官方背书"单 Agent + 好工具"起步路线 | — |
| 2025-06 | 同一周的两篇文章：Anthropic 多 Agent 研究系统 [8]（2025-06-13）与 Cognition《Don't Build Multi-Agents》[12]（2025-06-12） | 见下文 | 见下文 |
| 2025-09-29 | 《Effective context engineering》[9]（已核验） | "上下文工程"正式取代"提示词工程"成为岗位语言 | 上下文成本账本如何量化仍靠手感 |
| 2025-11-26 | 《Effective harnesses for long-running agents》[10]（已核验） | 跨上下文窗口的长任务状态传递 | 状态外部化本身成了新的工程学科 |
| 2026-01-23 | Anthropic《Building multi-agent systems: when and how》[11]（已核验） | 给多 Agent 适用边界一个厂商官方口径 | 见 §四 |
| 2026-04-22 | Cognition《Multi-Agents: What's Actually Working》[13]（已核验） | 承认自己 10 个月前的结论需要收窄 | 边界仍在移动 |
| 2026-07-11 | MAGE [6]（存在性已核验，单作者预印本） | 提示词优化器在低数据下反噬的实证 | 未复现，数字当参考不当定论 |

三条叙事的暗线：

**（1）模型每获得一种"干活能力"，瓶颈就转移到对应的系统层。** CoT 给了推理，瓶颈在无法接触外部 → ReAct/function calling 给了工具，瓶颈在循环可靠性 → function calling + MCP 铺满工具，瓶颈在工具面治理和上下文预算（ch02、ch04）。

**（2）2025-06 那一周是多 Agent 争论的缩影，而且双方其实不矛盾。** Anthropic 报告其 Research 功能里 Opus 4 主 Agent + Sonnet 4 子 Agent 在内部评测上比单 Agent 高 90.2%，同时自曝多 Agent 系统 token 消耗约为聊天的 15 倍 [8]（均为厂商自报，B 级）——任务形态是**广度优先、可并行、只读检索**的研究型搜索。Cognition 说不要多 Agent，任务形态是**写代码、要合并产物、多轮对话**[12]——同一个决策在不同任务形态上得出相反结论，这恰恰说明"要不要多 Agent"不存在脱离任务的答案（ch05 展开）。

**（3）回落到哪一组共识。** 到 2026 年中，能同时被 Anthropic [11]、Cognition [13] 和 MAST [5] 印证的收敛形态是：**一个强单 Agent + 一套治理过的工具面 + 显式外部化状态**，多 Agent 只留给三类场景（上下文污染、真并行、工具集专精——[11] 原文口径），且"额外 Agent 应该贡献 intelligence 而非 actions、写入保持单线程"（[13] 原话 *"multiple agents contribute intelligence to a task while writes stay single-threaded"*）。注意这是**实践收敛，不是理论终点**：Anthropic 2025 与 2026 两篇文章的口径差 [8][11]，本身就提醒我们结论对模型代际高度敏感。

---

## 四、关键实证数据

| # | 结论 / 数字 | 出处 | 等级 | 注意事项 |
|---|---|---|---|---|
| 1 | 多 Agent（Opus 4 主 + Sonnet 4 子）比单 Agent Opus 4 高 **90.2%**（内部研究评测） | Anthropic 2025-06 [8] | B | 厂商内部 eval；广度优先检索任务；未公开发布 eval 集 |
| 2 | Agent 用 token ≈ 聊天 **4×**；多 Agent ≈ **15×**；token 用量单独解释 BrowseComp 表现方差的 **80%** | 同上 [8] | B | 自报生产数据；"多 Agent 赢"在相当程度上是"多花 token 赢" |
| 3 | 多 Agent 实现比单 Agent 用 **3–10×** token；"团队花几个月搭复杂多 Agent，最后发现给单 Agent 改提示词效果相当" | Anthropic 2026-01 [11] | B | 引用语已逐字核验；同文给出 20+ 工具选择困难、15-20+ 工具警戒线 |
| 4 | MAST：**1600+** 标注轨迹、**7** 框架、**14** 失败模式、**3** 大类、标注一致性 **κ=0.88** | arXiv:2503.13657 [5] | A | 摘要数字已核验；内部文档引用的"失败率 41%–86.7%、step repetition 15.7%"等**源自内部文档·未独立核验** |
| 5 | N=30 低数据下，固定提示词优于全部反思式优化器；GEPA 优化后 **34.0%**（GSM8K-Hard）；OPRO（仅分数信号）与 Self-Refine（抽象批评）**未能改进提示词** | MAGE [6] | C | 单作者预印本，未见复现。"62.4%→34.0% 降幅、手工脚手架 70.0%"为内部文档引用·未独立核验；方向可信、数字勿当定论 |
| 6 | context rot：模型从上下文中提取信息的能力随 token 数增加而下降，出现在所有被测模型上 | Anthropic [9] 引 Chroma 研究；**间接核验** | C | 第三方技术报告，未见同行评审；机制解释（n² 注意力、注意力预算）为 Anthropic 阐述 |
| 7 | SWE-bench Agent 案例：把文件工具参数改为强制绝对路径后，模型"完美地"使用该工具；团队自述优化工具花的时间超过优化提示词 | Anthropic [7] | B | 一手工程轶事，无样本量披露，但"工具接口值得专门工程化"的含义被后续大量实践重复 |
| 8 | 长任务 harness 两件套：initializer agent 建环境 + 每会话编码 Agent 增量推进并留下 `claude-progress.txt` / git 提交；不这么做时，Opus 4.5 在"build a clone of claude.ai"任务上要么一次做太多撑爆上下文，要么看到已有进展就提前宣布完工 | Anthropic [10] | A（定性）/ B（隐含对比） | 一手工程文档；失败模式描述极具体，可直接当自查清单用 |

**读这张表的姿势**：A 级给的是"存在性与结构"（论文编号、失败分类法），B 级给的是"量级感"（4×/15×/3-10×——分母各不同，别横向比较），C 级只能借"方向"。全书凡引数字，按此纪律标注。

---

## 五、反模式与常见误解

**1. 框架先行：还没跑通裸循环就上多 Agent 框架。**
Anthropic 的官方建议是先直接用 API，*"many patterns can be implemented in a few lines of code"*，用框架也必须理解底层，因为"对框架内部行为的错误假设是客户 bug 的头号来源" [7]。框架的默认行为（怎么截断历史、怎么渲染工具结果）本身就是你的架构决策，看不见不等于不存在。本章动手实验存在的意义就是让你 30 分钟内亲手拥有这"几行代码"。

**2. 工具堆砌：把"接了 31 个工具"当"有 31 种能力"。**
Anthropic 2026 口径：20+ 工具的选择已经困难，15-20+ 时模型要花可观的上下文和注意力去理解工具本身 [11]。更隐蔽的是错误结构——语义相近的工具互相干扰才是主因（ch04 展开）。你给模型的不是能力清单，是一份**需要它每次通读的接口说明书**（ACI 概念，[7]）。

**3. 把"多 Agent"当架构先进性的标志。**
成本口径见 §四 第 2、3 行：3–10× 乃至 15× 的 token 消耗 [8][11]，换来的常常是每次交接丢失上下文。[11] 给出的三条适用判据（上下文污染、可并行、工具集专精）之外，*"the coordination costs typically exceed the benefits"* 是原文结论。Cognition 补充的失败机理——每个行动都携带隐性决策，并行行动 = 隐性决策互相冲突 [12]——比任何指标都更能预判你的多 Agent 会不会翻车。

**4. 把"加了反思环节"当"Agent 在进化"。**
用 CoALA 的尺子量（§2.4）：反思没有产生对长期记忆的写入，就不是学习；即便写入了，MAGE 的证据显示抽象批评式反思（Self-Refine 型）不改进表现 [6]（C 级）。真实世界里"反思产出的记忆"还有污染风险，ch02/ch06 分别处理。

**5. 把"上下文窗口更长"当"不需要上下文管理"。**
context rot 是无差别的 [9]（C 级但多方印证），128k/1M 窗口改变的只是预算总额，不改变"注意力是稀缺资源"这个事实。compaction 之类机制在 [11] 里被用来论证"单 Agent 能撑更久了"——注意它的言外之意：上下文管理成了模型产品的一部分，但**决定压缩什么、保留什么**仍然在你的 harness 里。

**6. 按人类组织架构图设计 Agent 架构。**
"我们需要一个架构师 Agent、一个初级开发 Agent、一个 QA Agent"——MAST 数据里"不服从角色设定"反而不是高频失败 [5]（具体占比 1.5% 为内部文档引用·未核验；但高频失败是重复步骤与推理-行动错位这一方向，摘要可证）。真正决定失败率的是交接处的信息损耗与验证缺失，而不是"员工"的岗位说明书。

**7. 认为"提示词工程已过时，现在是上下文工程"。**
两篇文章把关系说得很清楚：上下文工程是提示词工程的 *"natural progression"* [9]，不是替代——system prompt 仍是单个权重最高的上下文组件（ch03 讨论它的真实效力边界，那里有反直觉的证据）。

**8. Demo 驱动开发。**
演示里"Agent 跑了 40 步完成任务"是卖点；生产里它是账单、是故障半径、是不可复现的 bug。从第一天就记三本账：每次任务的 token 成本、轨迹可回放、终止条件是设计出来的 [7][8]。

---

## 六、动手实践

### 目标

跑通并读懂一个 222 行的最小 Agent Loop：3 个工具、两类终止条件、逐步打印轨迹；再用离线桩模型体会"换模型不换循环"。**不要求**你有 API key——降级模式就是为理解控制流设计的。

### 文件与运行

代码在 `hands-on/ch01/`（详见该目录 README）：

| 文件 | 说明 |
|---|---|
| `agent_loop.py` | 全部代码：工具层（calculator / read_file / append_note）+ 模型层（`call_openai` 与 `StubModel` 同接口）+ 循环层 |
| `sample_data/orders.md` | 样例数据 |
| `README.md` | 运行方法、完整预期输出、5 个观察点、5 个扩展实验 |

```bash
cd hands-on/ch01
python agent_loop.py                # 离线桩模型，无需 key
python agent_loop.py --offline "读取 missing.md"   # 观察错误字符串回填
# 有 key 时：设置 OPENAI_API_KEY / OPENAI_BASE_URL 后去掉 --offline 即可
```

核心循环只有约 25 行，值得逐行读懂：

```python
for step in range(1, max_steps + 1):
    msg = model(messages)            # ① 上下文组装(就是 messages 本身) ② 模型调用
    messages.append(msg)
    calls = msg.get("tool_calls") or []
    if not calls:                    # 终止条件二：模型不再要工具 == 认为已答完
        return msg.get("content") or ""
    for call in calls:               # ③ 工具执行
        result = TOOLS[call.fn](**call.args)   # 失败也返回 "ERROR: ..." 字符串
        messages.append(tool_msg(result[:MAX_RESULT_CHARS]))   # ④ 回填(带截断=朴素上下文工程)
return "(被最大步数终止)"              # 终止条件一
```

### 预期输出（离线模式，实测）

```
--- 第 1 步 ---  [calculator]({'expr': '(128+64)*3'}) -> 576
--- 第 2 步 ---  [read_file]({'path': 'sample_data/orders.md'}) -> # 样例数据：orders.md ...
--- 第 3 步 ---  [append_note](...) -> 已追加一条备注（40 字符）
--- 第 4 步 ---  assistant: (stub) 任务完成。已执行 3 次工具调用...
[终止] 第 4 步无工具调用，采纳最终回答
```

### 你应该观察到什么

1. **换模型不动循环**：`call_openai → StubModel` 只换了一个函数引用——§2.3 公式在你手上成立了一次。
2. **两类终止各触发一次**：默认任务走"无工具调用"终止；把 `MAX_STEPS` 改成 2 再跑，走"最大步数"终止。
3. **错误进入上下文**：读一个不存在的文件，`ERROR:` 字符串出现在下一轮输入里；对比"工具直接抛异常炸掉进程"，理解为什么错误回填是自愈的前提。
4. **轨迹即台账**：每一步的打印物就是生产系统该持久化的 trajectory——评估、计费、复盘全靠它（ch07 会把"留痕"做成规范）。
5. **上下文在肉眼可见地膨胀**：打印 `len(messages)` 观察其增长，配合 `MAX_RESULT_CHARS` 从 400 改到 40 再对比——§2.2 的资源账本就此具象化。

---

## 七、本章小结

1. **术语演化有统一解释**：每一步热点都在修补上一步暴露的系统层短板——推理（CoT）→ 行动（ReAct）→ 接口（function calling/MCP）→ 循环治理（harness/context engineering）→ 组织边界（多 Agent 争论）。看新闻时用"它在补哪个洞"提问，不会被名词带着跑。
2. **agent = model + harness** 正在成为共识：模型可替换、错误集中在协调层、红利要靠 harness 兑现——你自己的资产是后者。但分界线随模型代际移动，别把它当恒等式。
3. **workflow vs agent 的唯一分界是决策权归属**；从最简方案出发，复杂度要用评估证明，不是用架构图证明 [7]。
4. **循环只有五步**：组装上下文、调模型、执行工具、回填结果、判终止。终止条件是产品设计不是兜底补丁；错误字符串回填是自愈的前提。上下文是边际收益递减的有限资源，塞进去的每个 token 都记账 [9]。
5. **CoALA 给全书提供解剖图**：working/episodic/semantic/procedural 四类记忆 + 决策循环 + 学习动作；提示词与工具属于程序性记忆， episodic/semantic 归 ch02，procedural 归 ch03/ch04。
6. **"反思 = 学习动作（写长期记忆），而非记忆的一层"**——不写入不算学习，写入就有污染与审计问题，且写入未必要由模型完成（ch06 的工程主张由此展开）。
7. **多 Agent 的真实共识**不是"不用"，而是收窄：强单 Agent 打底，多 Agent 只留给上下文污染、真并行、工具专精三场景，且"贡献智能而非行动、写入单线程" [11][13]；厂商口径的代价是 3–10×/15× token [8][11]。
8. **证据纪律是这本教程的一部分**：大厂内部 eval（90.2%）与单作者预印本（MAGE）都只提供方向；引用数字前先看分母和发表状态。全书引用一律带 A/B/C 等级。

---

## 八、参考文献

证据等级：**A** = 同行评审论文或大厂一手工程文档；**B** = 厂商自报数字/轶事；**C** = 预印本或未核验二手来源。

1. Wei, J. et al. *Chain-of-Thought Prompting Elicits Reasoning in Large Language Models.* arXiv:2201.11903. https://arxiv.org/abs/2201.11903 — 标题/作者已核验（alphaXiv 页面；年份按 arXiv 编号 2201 判定为 2022-01）。等级 A。✅已核验（编号与标题）
2. Yao, S. et al. *ReAct: Synergizing Reasoning and Acting in Language Models.* arXiv:2210.03629, ICLR（DBLP: conf/iclr/YaoZYDSN023）. https://arxiv.org/abs/2210.03629 — 经 Semantic Scholar/DBLP 核验。等级 A。✅
3. Lewis, P. et al. *Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks.* NeurIPS 2020, arXiv:2005.11401. https://arxiv.org/abs/2005.11401 — 经 Semantic Scholar 核验。等级 A。✅
4. Sumers, T., Yao, S., Narasimhan, K., Griffiths, T. *Cognitive Architectures for Language Agents (CoALA).* TMLR 2023, arXiv:2309.02427. https://arxiv.org/abs/2309.02427 — 经 Semantic Scholar 核验。等级 A。✅
5. Cemri, M. et al. *Why Do Multi-Agent LLM Systems Fail?* arXiv:2503.13657. https://arxiv.org/abs/2503.13657 — 编号/机构/摘要数字（1600+ 轨迹、14 模式、κ=0.88）已核验（Semantic Scholar + alphaXiv 摘要）；"失败率 41%–86.7%、step repetition 15.7%、disobey role 1.5%"等细分数字源自内部文档 [18]·未独立核验。等级 A（正文细分数字为 C）。
6. Singh, P. *MAGE: Understanding Stability-Performance Trade-offs in Multi-component Prompt Optimization.* arXiv:2607.11944, 2026-07-11. https://arxiv.org/abs/2607.11944 — 存在性、单作者身份、摘要关键句（GEPA 34.0%、Ntrain=30、"scaffold choice dominates optimizer choice"）已核验（alphaXiv）。**单作者预印本，未见任何复现。**"62.4% 起点、固定脚手架 70.0%"源自内部文档·未独立核验。等级 C。
7. Anthropic. *Building Effective Agents.* 2024-12-19. https://www.anthropic.com/engineering/building-effective-agents — 全文已抓取核验（workflows/agents 定义、简单优先、三原则含 ACI、"LLMs using tools… in a loop"、stopping conditions、SWE-bench 工具优化轶事、2026 年加挂"Managed Agents"更新注）。一手工程文档，定性结论 A，轶事数字 B。✅
8. Anthropic. *How we built our multi-agent research system.* 2025-06-13. https://www.anthropic.com/engineering/multi-agent-research-system — 全文已抓取核验（90.2%、4×/15× token、80% 方差）。等级 B（数字均为厂商内部评测/生产自报）。✅
9. Anthropic. *Effective context engineering for AI agents.* 2025-09-29. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents — 全文已抓取核验（context rot 引述、attention budget、n² 论证）。等级 A（定性）；其中 Chroma "context rot" 为第三方技术报告，**本文经 [9] 间接核验**，等级 C。✅
10. Anthropic. *Effective harnesses for long-running agents.* 2025-11-26. https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents — 全文已抓取核验（"general-purpose agent harness"、initializer/coding-agent 两段式、claude-progress.txt、两类失败模式）。等级 A。✅
11. Anthropic (Claude blog). *Building multi-agent systems: When and how to use them.* 2026-01-23. https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them — 全文已抓取核验（"teams invest months…"原句、3–10× token、三适用场景、20+/15-20+ 工具口径）。等级 B。✅
12. Yan, W. *Don't Build Multi-Agents.* Cognition, 2025-06-12. https://cognition.ai/blog/dont-build-multi-agents — 全文已抓取核验（Share context / Actions carry implicit decisions 两原则、Flappy Bird 例、对 OpenAI Swarm 与 Microsoft AutoGen 的批评、"context engineering 是工程师第一要务"）。一手工程观点文（定性 A，自报数据 B）。✅
13. Yan, W. *Multi-Agents: What's Actually Working.* Cognition, 2026-04-22. https://cognition.com/blog/multi-agents-working — 全文已抓取核验（"contribute intelligence … writes stay single-threaded"原句、只读子 Agent ≈ 工具调用、企业用量 ~8×——自报 B）。✅
14. OpenAI. *Function calling and other API updates.* 2023-06-13. https://openai.com/index/function-calling-and-other-api-updates/ — 已抓取核验（日期、功能范围）。✅
15. Anthropic. *Introducing the Model Context Protocol.* 2024-11-25. https://www.anthropic.com/news/model-context-protocol — 已抓取核验（日期、开源定位）。✅
16. OpenAI. *A Practical Guide to Building Agents*（PDF）. https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf — **间接核验**：URL 与存在性经 Cognition 文章 [12] 正文引用核实，本文未直接抓取全文。等级 B。
17. Chroma (技术报告). *context rot* 研究，经 [9] 引用；**本文未直接核验原文**，等级 C。
18. 内部调研文档《12 · 一级公民的积累与演化》（2026-09-16），本教程的选题来源。§1.2 实测案例、§2.2 部分引用数字（MAST 细分、MAGE 完整对比数字）在本章按"源自内部文档·未独立核验"处理。等级 C（按章节标注）。

> 未能核验清单：① MAST 论文的细分失败率数字（41%–86.7% 等）；② MAGE 论文中"62.4% 起点 / 70.0% 固定脚手架"具体数值（仅摘要级核验）；③ OpenAI 指南全文内容；④ Chroma context rot 原文；⑤ Toolformer（arXiv:2302.04761）编号未核验，故正文未引用。
