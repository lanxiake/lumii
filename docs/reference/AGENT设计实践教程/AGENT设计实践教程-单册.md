# Agent 设计实践教程（单册）

> 合并生成自 chapters/ 目录，2026-09-16。分章文件与动手实验见原目录。

---

# Agent 设计实践教程

一套从真实调研沉淀出来的 Agent 工程教程：8 章正文 + 7 章全部离线可跑的动手实验。覆盖 Agent 系统的六个部件——总体架构、记忆、提示词、工具面、多 Agent 协作、自我进化——以及一套可以带走的证据质检方法。

**来源**：改编自内部调研文档《一级公民的积累与演化》（2026-09-16，三路并行网络调研的记忆架构 / 专家 Agent 与提示词进化 / 领域 Agent 成熟实现三个技术域）。每章由独立研究者在原文基础上做二次网络核验、深化并配可复现实验；核验不过的数字一律降级标注，不悄悄保留。

**适合谁**：写过 LLM 应用、正在或准备给系统加"记忆 / 工具 / 多 Agent / 自我改进"的工程师。不需要机器学习背景，所有实验只需 Python 3.8+。

---

## 怎么读

| 路径 | 章节 | 时长 |
|---|---|---|
| 快速路径（先建立判断力） | ch01 → ch04 → ch05 → ch08 | 约 2 小时 |
| 完整路径（按顺序） | ch01 → ch02 → ch03 → ch04 → ch05 → ch06 → ch07 → ch08 | 约 4 小时，实验另加约 4 小时 |
| 带着问题来 | 见下表"这章回答什么"，直达对应章 | — |

## 目录

| 章 | 文件 | 这章回答什么 | 动手实验 |
|---|---|---|---|
| 1 | `chapters/ch01-Agent系统演化全景.md` | 2022-2026 每一步演化在修补什么问题；agent = model + harness 这一共识从哪来 | 最小 Agent Loop（桩模式零依赖可跑） |
| 2 | `chapters/ch02-Agent记忆架构.md` | 为什么"写了记忆却用不上"是必然；要不要上向量库；台账和原始日志的关系 | JSON 台账 + 检索打分演示（复现"该检索的检索不到"） |
| 3 | `chapters/ch03-人设与提示词进化.md` | "你是资深专家"有没有用（没有）；自动提示词优化何时值得上（大多数时候不值得） | 失败案例→few-shot 流水线；人设 A/B 测试模板 |
| 4 | `chapters/ch04-工具设计与工具面治理.md` | 30-50 个工具警告的实底；收敛为什么是"正交化"不是"变少"；省 token 靠什么 | 40 工具选择混淆实验 + 工具描述 10 项 lint |
| 5 | `chapters/ch05-多Agent系统.md` | 多 Agent 何时值得（读多写少可并行）何时是债；协调税多大 | 单 Agent vs orchestrator-worker 对照（实测 +42% token 换 9/10 对 6/10 覆盖） |
| 6 | `chapters/ch06-反思与自我进化.md` | 为什么"让 Agent 总结教训"可能固化错误；可靠的积累为什么必须可验证、可计数 | 失败分类学 + RRR 毒记忆定位；被污染的解释时间线 |
| 7 | `chapters/ch07-领域Agent工程实践.md` | 去重/偏好规则/来源评分/内容治理——生产系统已写好的答案，直接抄 | 事件级去重（阈值权衡扫描）+ 规则引擎命中集预览 |
| 8 | `chapters/ch08-证据方法论与阅读指南.md` | 书里的数字怎么来的、写作中抓到哪四类"数字变质"；离书后的自查六问 | — |

## 运行实验

**全部 7 章实验默认离线可跑、只用 Python 标准库、不需要任何 API Key。** 少数脚本提供 `--real`/api 模式（读 `OPENAI_API_KEY`/`OPENAI_BASE_URL`，OpenAI 兼容接口），纯为进阶观察，不跑不影响理解。

> ⚠️ **Windows 注意**：Windows 自带的 `python` 命令常是 Microsoft Store 空壳（执行后无输出、退出码非零）。本书实验在 Windows 上的实测环境为 `C:\Users\<你>\.lumii\runtimes\bin\python`（3.11.9）；请换成你自己真实安装的解释器（`where python` 里非 WindowsApps 的那一个）。

各章实验均附 `README.md`（运行命令、预期输出、"你应该观察到什么"）。已逐一实测通过：

| 目录 | 入口 | 实测演示的现象 |
|---|---|---|
| `hands-on/ch01/` | `agent_loop.py` | 桩模型跑通 3 次工具调用后自然终止 |
| `hands-on/ch02/` | `ledger.py`、`retrieval_demo.py` | 偏近期权重下 gold 记忆跌出 top-5；改权重回到第 1 |
| `hands-on/ch03/` | `fewshot_pipeline.py runlog_sample.json` | top-3 错误类覆盖 73% 失败，自动生成纠正卡 |
| `hands-on/ch04/` | `tool_confusion_experiment.py` | 收敛后同簇混淆归零；省 token 靠按需加载而非合并 |
| `hands-on/ch05/` | `single_vs_multi.py --stub` | 多 Agent +42% token、协调税 >30%，要点覆盖 9/10 vs 6/10 |
| `hands-on/ch06/` | `failure_taxonomy.py` | RRR 指标精确定位预埋毒记忆（12 次引用/11 次失败）且不误杀健康记忆 |
| `hands-on/ch07/` | `event_dedup.py`、`rule_engine.py` | 阈值 0.5→0.8 时事件数 23→32 的漏并/误并权衡；盲选规则与预览规则在 30 条中产生 6 条不同决策 |

## 证据标注约定

每章参考文献逐条标级：**A** = 同行评审或大厂一手工程文档（含本书自测）；**B** = 厂商自报基准 / 生产系统线上参数；**C** = 预印本或未核验转引。正文中核不到的数字一律就地标注「源自内部文档·未核验」。方法与抓包案例见第 8 章。

### 各章核验状态（诚实披露）

| 章 | 外部核验情况 |
|---|---|
| ch01 | 关键论文/博客已核验（ReAct、CoALA、Anthropic 两篇工程博客）；个别标注未核验 |
| ch02 | 核心数字核验到论文 PDF 原表；发现并修正一对跨论文拼接数字（见 ch08 案例 1） |
| ch03 | 经 alphaXiv 镜像 + OpenAlex + 官方文档核验（写作环境无法直连 arXiv） |
| ch04 | Anthropic 警告原文、Tool Search、RAG-MCP 数字已核验 |
| ch05 | Anthropic/Cognition 四篇逐句核验；MAST 经镜像与仓库交叉核验（子模式占比按 C 级引用） |
| ch06 | 全部摘要级核验；两处勘误（Voyager 编号、Honest Lying 口径）已写入正文 |
| ch07 | **本书自测数字均可复现（A·自测）；但写作时会话内网络工具故障，外部来源（NewsBlur 参数、GDELT/Ground News/NewsGuard 等）未能在线复核**，已逐条标注，引用前请按 ch08 六问自行复核 |

## 目录结构

```
AGENT设计实践教程/
├── README.md                 ← 本文件
├── AGENT设计实践教程-单册.md  ← 全书合并版（单文件阅读/打印）
├── chapters/                 ← ch01–ch08 八章正文
└── hands-on/ch01…ch07/       ← 各章实验代码 + 样例数据 + 运行说明
```

## 三条使用提醒

1. 书中 arXiv 26xx 编号论文多为未同行评审预印本（尤其 Honest Lying、Schema-Grounded Memory、MAGE），方向可信、数字别当定论。
2. 厂商基准互不可比（第 2、8 章有专门讨论）；你场景的数字请用 ch03/ch06 的流水线自己测。
3. 产品状态类说法（"某产品会自动整理知识库"等）过时极快，引用即复核。


---

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


---

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


---

# 第 3 章 · 人设的幻觉与提示词进化：什么时候值得自动优化

> **本章解决什么问题**：给 Agent 加一句"你是资深专家"到底有没有用？自动提示词优化（OPRO、DSPy、GEPA 这一族）什么时候值得上、什么时候是负收益？读完你会得到一个分层决策框架：绝大多数团队应该停在"失败案例 → 错误分类学 → 少量 few-shot"这一层，而不是急着开优化器。
> **预计阅读时长**：25–30 分钟。**前置知识**：第 1 章（Agent 循环与系统提示词的位置）、第 2 章（运行日志与台账）；不需要机器学习背景，本章所有实验用纯 Python 标准库。
> **证据声明**：本章关键论文编号与数字均经核验（核验方式：alphaXiv 镜像摘要 + OpenAlex DOI 元数据 + 厂商官方文档/博客全文；作者本机网络无法直连 arxiv.org，正文引用的 arXiv 链接均为官方编号）。核验不了的数字一律标注「源自内部文档·未核验」。证据分级：**A**=同行评审或大厂一手工程文档；**B**=厂商自报；**C**=预印本/未核验。

## 一、为什么这件事重要

打开任何一份 Agent 系统提示词模板，几乎第一眼就能看到这样的句子："你是一位拥有二十年经验的资深数据工程师……"。给 Agent 封一个专家头衔，成本为零，听起来还能"激活"模型的专业知识。另一个同样流行的说法是：提示词不该人肉改，应该像训练模型一样"自动进化"，让程序自己搜索最优提示词。

本教程的内部调研（《一级公民的积累与演化》§2.2）在评估两个专职 Agent 时，正好撞在这两个问题上：要不要给它们配专家人设？要不要给每个 Agent 开独立的提示词进化通道？调研给出的答案都是否定的，而且否定得比直觉更彻底。本章把支撑这个结论的技术域完整展开——因为它直接决定你接下来半年把工程时间花在哪。

先给结论，后面再论证：

1. **人设改变风格与行为分布，不带来领域能力**。在客观题任务上，没有任何人设被证明稳定地带来统计显著的提分；想靠"资深律师"头衔提高法律问答准确率，方向就是错的。
2. **自动提示词优化是有数据量门槛的搜索过程**。数据不够时，优化器会把提示词"优化"得比手写脚手架更差——这不是比喻，是有人在 N=30 的实测里观察到的现象。

## 二、核心概念与框架

### 2.1 人设（persona）是什么

Zheng et al.（Findings of EMNLP 2024，arXiv:2311.10054）把系统提示词里的人设操作化为两类模板：**给模型指定身份**（"You are a/an {role}, {question}"）和**给读者指定身份**（"You are talking to a/an {role}, {question}"）。他们从职业词典和人际关系分类里构造了 162 个人设（112 个职业角色 + 50 个人际角色，覆盖 8 个专业领域、6 类人际关系），在 9 个指令微调模型（FLAN-T5、Llama-3、Mistral、Qwen2.5 四个家族）× 2,410 道 MMLU 题目上做了穷举式对照。这是目前规模最大的人设有效性研究，后面所有讨论都绕不开它。

### 2.2 什么才算"提示词优化器"

提示词优化器（prompt optimizer）是一个**带外部评价的搜索循环**，三条判据缺一不可：

1. **生成候选**：按某种机制（LLM 生成、编辑、进化）产出若干新提示词；
2. **外部评价**：在一批带标准答案的数据上跑分，分数由代码判定而不是模型自评；
3. **持久回写**：赢家提示词成为可部署的正式产物，替换旧版本。

用这三条判据立刻能分清两类常被混为一谈的东西。Self-Refine（arXiv:2303.17651）是"生成→自评→修改"的任务内循环，论文明确说自己"不需要任何监督训练数据、额外训练或强化学习"——它不产出新提示词，三条判据一条都不满足。Reflexion（arXiv:2303.11366）让 agent 把失败反思写成文字存进 episodic memory buffer，供**同一任务的下一轮尝试**使用，任务结束这份反思就没了——它反思的是"这次怎么答"，不是"提示词该怎么改"。所以两者都**不是**提示词优化器，把它们引作"提示词自动进化"的证据属于误引。这一族方法的真实能力边界（包括自我修正为什么会失败）在第 6 章详细展开，本章只需要你记住这个区分。

### 2.3 改进阶梯与决策流程

把提示词的改进方式按"数据门槛/成本"排成一个阶梯，绝大多数项目应该站在第一级：

```
你的任务有机械可判定的对错记录吗（代码能判 pass/fail）？
├─ 没有 → 先去建评测器和运行日志（第 7 章）。没有这个地基，
│         人设玄学和自动优化都无从谈起。
└─ 有 → 可判定的失败样本够 200 条吗？
    ├─ 不够 → 失败案例 → 错误分类学 → 3–5 条 few-shot 纠正卡（本章实验 A）。
    │         此时上优化器，过拟合风险大概率大于收益（见 §四 MAGE 行）。
    └─ 够 → 手工纠正卡迭代两三轮后，top 错误类收益 <1pp（经验值，无文献背书）？
        ├─ 还没到 → 继续失败驱动的手写循环，它便宜且可控
        └─ 到了，且能切分 train/val、接受千次级 metric 调用的预算
            → 上优化器：几百条规模优先反思系（GEPA/ETGPO 路线）；
              数据更多、要同时调示例选 MIPROv2；每次动完都跑留出集
人设：归入"风格 / 格式契约 / 安全行为"的箱子，永远不要归入"能力"的箱子；
      团队里每有人新增一段人设，跑一次实验 B 那样的 A/B 测试再说。
```

## 三、研究与工程演化线

按时间顺序走一遍这个领域，每个方法讲清"机制 + 适用边界"，以及它给实操留下了什么教训。

### 3.1 2023-05 · ProTeGi：用自然语言当"梯度"

ProTeGi / APO（Microsoft，arXiv:2305.03495，发表于 EMNLP 2023）的机制是把梯度下降翻译进文本空间：拿一批训练样本跑当前提示词，把错误案例喂给一个 LLM 让它写"文本梯度"（当前提示词错在哪的批评文字），再沿"反方向"编辑提示词；候选用 beam search 维护，打分用 bandit 算法分配预算以省评测次数。论文报告对初始提示词最高提升 31%。

**边界**：它开启了"从执行反馈中学习"的传统，但每一步都要跑评测，token 和时间开销都不小；小训练集上迭代多了会过拟合训练样本（内部文档称"约 3 步后开始过拟合"，具体步数未能核验，方向见 §四 train/test gap 行）。

### 3.2 2023-09 · OPRO：把 LLM 本身当优化器

OPRO（Google DeepMind，arXiv:2309.03409）取消了"梯度"，只给 LLM 看**优化轨迹**——一串历史提示词和它们的准确率，按分数升序排列（利用近因偏好，最好的放最后），让它直接生成"分数更高的新指令"。代表作是用 PaLM 2-L 在 GSM8K 上优化出 80.2% 准确率的提示词，比"Let's think step by step"高约 8 个百分点。

**边界**：OPRO 只看聚合分数、不看具体错误——论文自己在 limitation 里承认应当引入 instance-level 的误差分析。这个缺口就是后来 ProTeGi 系与反思系（§3.5）存在的理由。一个 2026 年的对照实验（MAGE，见 §3.6）直接给出判决：只喂分数不喂错误的 OPRO 在它的实验设置里"fails to improve prompts"。另外，OPRO 优化和选择提示词用的是同一份训练集，内部文档转述其"训练比测试高 5%–20%"，具体范围未能核验，但"优化分数虚高"这个机制性问题在它自己的评测协议里就存在。

### 3.3 2024 · DSPy / MIPROv2：框架化，以及"200 条"说法的真相

DSPy 把提示词工程框架化：你写声明式的 Signature 和 Module，优化器替你生成最终提示词。其中的 MIPROv2（论文发表于 EMNLP 2024 主会，"Optimizing instructions and demonstrations for multi-stage language model programs"）对**指令和 few-shot 示例联合搜索**，用贝叶斯优化在"提议指令 × 引导示例"的组合空间里找高分组合。

关于"官方建议 ≥200 条数据、推荐 20% 训练 / 80% 验证"这两条在社区里广泛流传的数字，本章按任务要求直接核验了当前（2026-09）的 DSPy 官方文档与源码，结果是：

- **没有"≥200 条"的硬性门槛**。官方文档只给预算档位（`auto=light/medium/heavy`），文档里一个具体换算例子：2 个 predictor、100 条数据的任务，light 档约 1,330 次 metric 调用、medium 约 1,740、heavy 约 2,045——这才是"跑优化有多贵"的官方口径。
- **"20% 训练 / 80% 验证"在现行文档中不存在，且方向相反**。现行 GEPA 优化文档原文是"There is no universal split ratio"，建议 trainset 尽量大、valset 用"刚好够匹配任务分布的最小样本"。内部文档那条转述很可能出自 2025 年某版文档，无法核验存档，**以现行文档为准**。
- 现行文档明确警告：省略 valset 会让优化器"deliberately allows prompts to overfit"到训练样本上。

这条核验经历本身就是本章的一个实操示范：**二手转述的"官方建议"要回源核验**——它是本章 §五要拆的误解的最佳注脚。"≥200 条才值得开优化器"作为工程经验仍然成立，但它是经验，不是官方门槛。

### 3.4 2025-07 · GEPA：反思式进化 + Pareto 前沿

GEPA（arXiv:2507.19457，UC Berkeley/Stanford/MIT 等，Omar Khattab 等 DSPy 作者参与）把 ProTeGi 的"看错误写批评"升级为完整的**反思式进化**：采样完整执行轨迹（推理步骤、工具调用、反馈），让反思 LLM 从失败和成功中提取文字教训、提出指令变异，小批量验证后进入候选池；选择用 **Pareto 前沿**——保留"在至少一道训练题上拿到最好成绩"的所有候选（而不只是平均分最高的），刻意维持多样性避免早熟。

论文主张（摘要核验）：在六个任务上平均比 RL 方法 GRPO 高 6%（最高 20%），而 rollout 用量少至 1/35；比 MIPROv2 高 10% 以上（AIME-2025 上 +12%）。它已被吸收为 DSPy 的官方优化器 `dspy.GEPA`。**边界**：它的省样本是相对的——机制仍然需要跑评测的反馈数据，且下一节会看到，在极小数据下它照样输给一个写得好的人肉脚手架。

### 3.5 2026 · 低数据的现实检验：MAGE 与 ETGPO

**MAGE**（arXiv:2607.11944，单作者预印本，C 级）系统研究了"多组件提示词优化器"的稳定性。摘要里已核验的关键结论：失败驱动的反思是核心——只喂分数的 OPRO 和只做抽象批评的 Self-Refine 都无法改进提示词；在 GSM8K-Hard 上 GEPA 优化到 34.0%，而 MAGE 46.4%（5 seeds，gpt-4o-mini）；多样性提升均值的同时放大方差（POCE 现象）。对实操最重要的一句是摘要原话：*"in low-data regimes (N_train=30), well-designed fixed prompts outperform all reflective optimizers, indicating that scaffold choice dominates optimizer choice"*——N=30 时，**脚手架选择压倒优化器选择**。内部文档引用的"62.4%→34.0%"起点值和"手工脚手架 70.0%"未能对正文核验，方向与摘要一致，数字请当作量级参考。

**ETGPO**（arXiv:2602.00997，2026-02 预印本，C 级）给出了低预算下的另一条路：**自顶向下**。先用 K 次采样收集失败轨迹，让优化 LLM 把错误归并成**错误分类学**（丢弃只出现一次的类别，按频次排序取 top-G），再为每类生成一段"错误描述 + 错误例 + 正例 + 建议"的纠正文字贴回提示词。摘要核验的核心数字：精度与 GEPA/MIPROv2 相当或更好，**优化阶段 token 与评测预算约为 GEPA 的 1/3**（对 MIPROv2 约 1/6）。它的消融还发现：把错误"归并成体系"这一步本身就有增益——原始错误散样直接塞给模型的版本更差。这就是本章实验 A 的方法学出处。

## 四、关键实证数据

| # | 结论 | 关键数字 | 出处 | 等级 | 注意事项 |
|---|---|---|---|---|---|
| 1 | 人设不提升客观任务性能 | 162 人设 × 2,410 题 × 9 模型，加人设与不加无统计差异 | Zheng et al., arXiv:2311.10054, Findings of EMNLP 2024 | A | 仅开源模型、仅客观题；领域匹配的人设"统计上略好但效应量极小"；自动选人设≈随机选 |
| 2 | 人设效应基本是随机的 | oracle 逐题选人设能显著提分，但任何自动选人策略不比随机好 | 同上 | A | "最优人设"不可预知 → 加人设等于掷骰子 |
| 3 | 专家人设：对齐↑、能力↓ | Qwen2.5-7B：MMLU 专家人设 69.0% vs 基线 71.7%；MT-Bench/安全拒绝率提升 | PRISM, arXiv:2603.18507（USC, 2026-03） | C | 内部文档引用的 68.0/71.6 与"更长人设 66.3%"未能对照正文核验；此处为镜像摘要中 Qwen 行数字，方向一致 |
| 4 | "无关人设细节可致性能下降近 30 个百分点" | — | **源自内部文档·未核验**（出处不明） | C | 数字与 MAGE 的 −28.4pp 高度接近，推测可能是把优化器实验的数字错记到了人设文献头上（见 §五误解 6） |
| 5 | 反思进化省样本、胜 RL | GEPA vs GRPO：平均 +6%、最高 +20%，rollout 少 35×；vs MIPROv2：+10% 以上 | GEPA, arXiv:2507.19457 | C | 论文自报数字；Pareto 选择维持多样性是其关键机制 |
| 6 | 小数据下手工脚手架压倒优化器 | N_train=30 时固定提示词胜一切反思优化器；GEPA 优化后 34.0% | MAGE, arXiv:2607.11944 | C | 单作者预印本，−28.4pp 别当定论，**方向可信** |
| 7 | 失败分类学路线省 2/3 预算 | ETGPO ≈ GEPA 的 1/3 token/评测预算（≈ MIPROv2 的 1/6），精度相当 | ETGPO, arXiv:2602.00997 | C | 预印本；其流程=实验 A 的方法学原型 |
| 8 | 优化器很贵，有官方换算 | 100 条数据、2 predictor 任务：MIPROv2 light≈1,330 次 metric 调用，heavy≈2,045 | DSPy 官方文档（2026-09 现行版） | A | "≥200 条官方门槛"与"20/80 切分"均不在现行文档中，见 §3.3 |
| 9 | 优化分数 ≠ 线上分数 | DSPy 文档：省略 valset 会"deliberately"过拟合训练集；Anthropic：靠 held-out test set 确认改进真实存在 | dspy.ai；Anthropic 工程博客 | A | ProTeGi"约 3 步后过拟合"与 OPRO"训高 5%–20%"均未核验，机制方向有多处独立支撑 |
| 10 | 用 Agent 迭代重写工具/提示词，Anthropic 内部长此做法 | "改进工具描述后 Claude 在 SWE-bench Verified 达 SOTA""超出专家手写实现"；具体"任务完成时间 −40%"在该博客全文中不存在，**未核验** | Anthropic: Writing effective tools for agents (2025-09-11) | A（做法）/ 数字未核验 | 内部文档给的方法描述属实且可抄：eval → 读轨迹 → 让 Claude Code 重写 → 留出集验证 |

## 五、反模式与常见误解

**误解 1：给 Agent 加专家头衔能买到领域能力。** Zheng et al. 的 2,410 道题没找到任何稳定提分的人设；PRISM 更进一步——专家人设在判别类任务上**系统性掉分**（模型是听人设话的，越听话的表演型任务越像专家、知识型任务越分心）。人设真正的用处是买**风格、格式合规和安全行为**：写作语气、拒答模式、输出纪律。把预算花在人设的能力词上，不如花在领域约束、输出契约、检查清单和专属工具上（第 4、7 章）。

**误解 2：Self-Refine / Reflexion 是提示词优化器。** 见 §2.2：一个不回写提示词，一个反思随任务销毁。引用它们论证"agent 会自我进化提示词"是范畴错误。第 6 章会展开这族方法的真实边界。

**误解 3：数据不够时先上优化器。** MAGE 在 N=30 的判决、DSPy 文档的过拟合警告、ETGPO 存在的理由，三方形成了同一证据链：评测数据不足时，优化器在拟合噪声。先把手工纠正卡循环跑起来，它同时还在为你积累训练数据。

**误解 4：优化集上的分数涨了就上线。** 提示词优化的本质是在小样本上搜索离散文本，train/test gap 是这个领域的重力。Anthropic 的整套做法（held-out test set）和 DSPy 的 valset 机制都是为此存在的。任何"优化后 +X%"没有留出集数字前，按无效处理。

**误解 5：人设越长越专业。** 长度是实验变量，不是美德。PRISM 把 persona 长度列为独立研究维度；其对 reasoning-distilled 模型的观察也值得警惕：DeepSeek-R1 类模型对"长而结构化的上下文"有长度偏好，**无关内容的长文也能让它提分**——长人设提供的是噪声+位置偏置，不是信息。

**误解 6：二手数字的传染性。** 本章核验过程中发现的具体案例："DSPy 官方推荐 20% 训练/80% 验证"与现行文档相反；"人设细节致降近 30pp"查无出处，其数值与 MAGE 优化器实验的 −28.4pp 几乎相同——一个优化器的失败模式被转述成了人设文献的结论。这不能证明内部文档的作者粗心的唯一原因，因为这类"数字漂移"在每个团队的 wiki 里都在发生。对策只有一个：**引用前花五分钟回源**。这也是本教程第 8 章证据方法论要系统解决的。

**两条明确的证据空白**（内部文档 §八，本章确认同样成立）：CrewAI 式 `backstory` 字段的严格消融实验**不存在**——框架文档里的人设字段没有实证背书；"二元通过/失败 vs 细粒度分数哪种反馈更适合提示词优化"**没有头对头 RCT**。前者说明人设流行的底色是营销，后者的空白意味着 §六实验 A 用 pass/fail 日志起步是当前唯一务实的选择，别指望有人替你验证过反馈形态。

## 六、动手实践

代码在 `hands-on/ch03/`，纯标准库，离线可跑。实验 A 是本章主线（便宜替代路径的可复制流水线），实验 B 帮你把"人设该测"变成三十秒的事。

### 实验 A：失败案例驱动的 few-shot 流水线

```bash
cd hands-on/ch03
python fewshot_pipeline.py runlog_sample.json
```

对样例日志（工单字段抽取 Agent，36 条记录）做失败聚类、输出错误分类学、为 top-3 错误类生成纠正卡。真实运行输出：

```text
总样本 36 | 通过 14 | 失败 22（失败率 61%）

错误分类学（按失败占比排序）
错误类                     条数   占失败   样本ID
日期格式/时区口径错误         6     27%   T-015 … T-020
输出不是合法 JSON            5     23%   T-026 … T-030
金额单位/精度错误             5     23%   T-021 … T-025
字段遗漏或置空               3     14%   T-031, T-032, T-033
抽取了原文没有的内容（幻觉）    2      9%   T-034, T-035
不该拒绝时拒绝               1      5%   T-036

提示：top-3 错误类覆盖了 73% 的失败样本——few-shot 卡只需先解决它们。
```

每张纠正卡的结构是"规则一句话 + 错误例（含校验器反馈）+ 正例 + 可粘贴片段"，对应 ETGPO 的 guidance generation。**你应该观察到**：(a) 22 条失败里三类格式性错误占了 73%，三条纠正卡就是当前 ROI 最高的提示词改动——不需要优化器、不需要 200 条数据；(b) 聚类这一步把"改提示词"从玄学变成了排序问题：先修覆盖率最高的类。这正是 §五误解 3 的操作化反驳。

### 实验 B：人设 A/B 测试模板

```bash
python persona_ab.py            # 桩模式：不调 API，先看懂实验设计
python persona_ab.py --mode api # 环境变量 OPENAI_API_BASE / OPENAI_API_KEY / OPENAI_MODEL
```

同一批 12 道客观题，跑三组系统提示词（无 persona / 专家 persona / 超长 persona），温度 0、逐题判分、报告相对基线的差值和逐题明细。桩模式用查表函数模拟三种人设的答题结果（数字是编造的，脚本里印着醒目警告），让你先看清报表形态：三组提示词长度 34 / 81 / 319 字符，桩模拟的准确率 100% / 91.7% / 75.0%，外加一张"基线对而人设错"的逐题对照表。**你应该观察到**：结论的重点在明细表而不是总表——人设的伤害总是藏在"基线本来会做对"的题里；以及真实实验必须自己跑——文献说人设效应是随机的（Zheng 的 oracle-vs-random 实验），你的模型、你的任务上到底加不加、加多少，只有你自己的评测集说了算。

## 七、本章小结

1. **人设买的是行为，不是能力。** 专家头衔改善风格、格式合规、拒答模式（PRISM 对齐维度），在客观题上不带来统计显著提分（Zheng, 162 人设 × 2,410 题 × 9 模型，A 级证据）。
2. **最优人设不可预知。** 人设逐题效应近乎随机，oracle 选人有空间但没有任何自动选人策略显著超过随机——所以每次加人设都要 A/B 测试，测不起就别加。
3. **提示词优化器 = 生成候选 + 外部评测 + 持久回写**。Self-Refine 无回写、Reflexion 的反思随任务销毁，两者都不是优化器（第 6 章见）。
4. **演化主线**：ProTeGi（文本梯度）→ OPRO（轨迹+分数）→ MIPROv2（指令×示例联合贝叶斯搜索）→ GEPA（反思进化+Pareto）；反馈信息量逐级上升，省样本能力逐级增强。
5. **小数据是优化器的坟场。** N=30 时手写固定脚手架胜一切反思优化器（MAGE，C 级但方向与多方证据一致）；优化器跑一次动辄上千次 metric 调用（DSPy 官方换算）。
6. **200 条是经验门槛不是官方门槛**——DSPy 现行文档没有这条，所谓"20/80 反常切分"与现行文档相反；但"机械可判定的评测记录先攒够再开优化器"这个实操纪律依然成立。
7. **最便宜的主线**：失败案例 → 错误分类学 → 按覆盖率排序 → 每类一张 few-shot 纠正卡（ETGPO 证明这条线花 1/3 预算能打平主流优化器）；Anthropic 把同样的循环用在工具描述上并以此超过专家手写实现。
8. **守住留出集与溯源纪律。** 没有 held-out 验证的"+X%"等于没测；本章对内部调研文档纠出的两处数字漂移（DSPy 切分建议、30pp 人设降幅）提醒我们：你自己的 wiki 也等着同样的回源核验。

## 八、参考文献

> 核验状态说明：下列 arXiv 论文均通过 alphaXiv 镜像（`alphaxiv.org/abs/<编号>`）核验了标题、作者、编号与摘要原文；元数据经 OpenAlex DOI 交叉确认。arxiv.org 链接为论文官方地址（作者本机网络不可达，未用于核验）。

1. Zheng, Pei, Logeswaran, Lee, Jurgens. *When "A Helpful Assistant" Is Not Really Helpful: Personas in System Prompts Do Not Improve Performances of Large Language Models*. Findings of EMNLP 2024（DOI: 10.18653/v1/2024.findings-emnlp.888）。https://arxiv.org/abs/2311.10054 —— **A 级；已核验**（标题/编号/摘要/实验规模）。注：内部文档引句 "none of the personas lead to statistically better model performance" 未见于摘要原文，语义与摘要一致，字句**未核验**。
2. Hu, Rostami, Thomason. *Expert Personas Improve LLM Alignment but Damage Accuracy: Bootstrapping Intent-Based Persona Routing with PRISM*. 2026-03 预印本。https://arxiv.org/abs/2603.18507 —— **C 级；已核验**（镜像摘要含 Qwen2.5-7B：专家人设 69.0% vs 基线 71.7%）；内部文档的 68.0/71.6/66.3 **未核验**。
3. Madaan et al. *Self-Refine: Iterative Refinement with Self-Feedback*. 2023-03。https://arxiv.org/abs/2303.17651 —— **C 级（发表状态未核验）；已核验**（摘要明示无训练、无 RL，任务内循环）。
4. Shinn et al. *Reflexion: Language Agents with Verbal Reinforcement Learning*. 2023-03。https://arxiv.org/abs/2303.11366 —— **C 级（发表状态未核验）；已核验**（摘要：反思文本存于 episodic memory buffer，服务同任务后续尝试）。
5. Pryzant et al. *Automatic Prompt Optimization with "Gradient Descent" and Beam Search*. EMNLP 2023。https://arxiv.org/abs/2305.03495 —— **A 级**（EMNLP 2023 发表信息经 ETGPO 论文参考文献条目对照）；**已核验**（机制、"最高提升 31%"）。"约 3 步后过拟合" **未核验**。
6. Yang et al. *Large Language Models as Optimizers* (OPRO). 2023-09。https://arxiv.org/abs/2309.03409 —— **C 级（常被标注 ICLR 2024，未核验）；已核验**（机制、GSM8K 80.2%、较人工提示词最高 +8%）。"训练比测试高 5%–20%" **未核验**。
7. Opsahl-Ong et al. *Optimizing instructions and demonstrations for multi-stage language model programs* (MIPROv2). EMNLP 2024 main. https://aclanthology.org/2024.emnlp-main.525/ —— **A 级；已核验**（该条目完整引文出现于 ETGPO 参考文献）。
8. DSPy 官方文档（2026-09 现行版）：*GEPA optimization / Choosing an optimizer / GEPA in depth / MIPROv2 API*。https://dspy.ai/getting-started/gepa-optimization/ 、https://dspy.ai/diving-deeper/choosing-an-optimizer/ 、https://dspy.ai/diving-deeper/gepa-in-depth/ —— **A 级（厂商官方文档）；已核验**。"≥200 条官方门槛"与"20% 训练/80% 验证"**未在现行文档中找到，且 split 建议方向相反**。
9. Agrawal et al. *GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning*. 2025-07（v2 2026-02）。https://arxiv.org/abs/2507.19457 —— **C 级；已核验**（vs GRPO +6%/最高 +20%/rollout 省 35×；vs MIPROv2 +10%，AIME-2025 +12%）。
10. Singh, P. *MAGE: Understanding Stability-Performance Trade-offs in Multi-component Prompt Optimization*. 2026-07，单作者预印本。https://arxiv.org/abs/2607.11944 —— **C 级；摘要已核验**（GEPA 34.0%、N_train=30 时固定提示词胜所有反思优化器、scaffold 压倒 optimizer 原话）；"62.4%→34.0%"起点与"手工脚手架 70.0%" **未核验**。
11. Singh, Yadav, Blanco. *Error Taxonomy-Guided Prompt Optimization* (ETGPO). 2026-02 预印本。https://arxiv.org/abs/2602.00997 —— **C 级；已核验**（分类学流程、约 1/3 token/评测预算、代码开源 https://github.com/mayanks43/etgpo ）。
12. Anthropic Engineering. *Writing effective tools for agents — with agents*. 2025-09-11。https://www.anthropic.com/engineering/writing-tools-for-agents —— **A 级（大厂一手工程文档）；已核验（全文抓取）**。"任务完成时间 −40%"在该文全文中不存在，**未核验**；"让 agent 反复试坏工具→重写工具描述→留出集验证"的做法描述属实。
13. 内部调研文档《12 · 一级公民的积累与演化》（2026-09-16，未公开发表）—— **C 级**；本章对其 §2.2/§3/§八 逐条回源，核验结果与两处纠偏见 §3.3 与 §五误解 6。


---

# 第 4 章 · 工具设计与工具面治理：Agent 的 API 层

> **本章解决什么问题**：给 Agent 挂工具不是"接上线就跑"的工程——工具选择的错误率、工具定义的 token 开销、工具返回结果的上下文污染，是生产级 Agent 最常见的三个隐性故障源。本章把"工具面"当作 API 设计问题来处理：给出证据、收敛策略和一套可以直接抄的审计清单。
> **预计阅读时长**：25 分钟（动手实验另需 30–60 分钟）
> **前置知识**：第 1–2 章（Agent 循环与上下文窗口基础）；读过任意一种 function calling 的 schema 定义

---

## 一、为什么这件事重要：从"挂了 30 个工具后它开始选错"说起

一个很常见的现场：你做了一个内部助手，第一版挂 5 个工具，跑得很好。之后每个团队都来"加一个"：搜索三兄弟（搜网页、搜新闻、搜内部文档）、文件五件套（读、写、改、追加、看头尾）、消息全家桶（微信、邮件、短信、群发）……三个月后工具数悄悄爬到 31 个。然后故障开始出现：

- 用户说"看看 app.log 最后 50 行报了什么"，它调了 `read_file` 把 40MB 日志整个读进上下文；
- 用户说"往今天笔记里追加一条待办"，它调了 `note_update` 把整篇笔记覆盖了；
- 用户说"查一下昨天发布会内容"，它在四个搜索工具之间反复横跳，最后选了知识库——因为"里面好像存过相关内容"。

注意故障的共同形状：**没有一个是"模型能力不行"**。每个工具的说明单独看都写清楚了；错在把三十个语义互相重叠的工具同时摆在模型面前。本章的核心论点就一句话：

> **工具选择的主要错误源是语义相近的工具互相干扰，以及检索/披露层的失误——工具数量只是这两者的放大器。**

由此推出两条工程结论：工具要像 API 一样被设计（描述、契约、错误信息都是接口的一部分）；工具面要像依赖树一样被治理（收敛、分层披露、定期审计）。

## 二、核心概念与框架

### 2.1 工具是 Agent 的 API（ACI）

社区把工具层叫 Agent-Computer Interface（ACI，对应 HCI 的构词），但真正把"怎么设计"讲透的是 Anthropic 的工程博客《Writing tools for agents》（2025-09-11）［证据 A，已核验］。它给工具下了一个很准的定义：

> "Tools are a new kind of software which reflects a contract between deterministic systems and non-deterministic agents."（工具是一类新型软件：它反映的是确定性系统与**非确定性** Agent 之间的契约。）

传统函数调用是确定性系统之间的契约：`getWeather("NYC")` 每次都以完全相同的方式执行。而 Agent 调工具之前可能发生三件事：它可能不调工具直接答、可能先去追问用户、也可能根本没看懂你的描述。这决定了工具设计与普通 API 设计的三个不同：

1. **描述文本是运行时的一部分**，不是注释——模型选择器和参数填充器都在推理时"读"它；
2. **调用方会误读**，所以要为"被误用"设计防线（Anthropic 称之为 poka-yoke，防呆）；
3. **返回值的读者也是模型**，返回结构和错误信息直接影响它下一步能不能自我纠正。

更早的《Building effective agents》（2024-12-19）［A，已核验］已经给出方向：从最简单的方案做起，"only increase complexity when needed"，并强调给 LLM 的能力要提供 "easy, well-documented interface"。多 Agent 研究系统那篇则补了负面证据："Bad tool descriptions can send agents down completely wrong paths, so each tool needs a distinct purpose and a clear description"［A，已核验］。

### 2.2 工具面的解剖学

把"工具面"拆开，一次工具调用要闯三关，每一关都有独立的故障模式：

| 关卡 | 发生了什么 | 主要故障 | 治理手段（本章） |
|---|---|---|---|
| 暴露面 | 哪些工具定义进了上下文 | token 膨胀；挤占任务上下文 | 渐进披露、按需加载 |
| 选择面 | 模型从暴露集里挑一个（或不挑） | 语义干扰、选错兄弟工具 | 收敛正交化、描述工程 |
| 执行面 | 工具返回结果进入上下文 | 长结果污染、错误不可行动 | 截断/分页、可行动错误契约 |

大多数团队只盯着"选择面"骂模型，但实验（§6）会显示：暴露与执行两层的成本经常更高。

### 2.3 "收敛"不是"越少越好"，是正交化

内部调研文档（§2.2）给出的判断值得原样继承：错误主因是语义相近的工具互相干扰，不是数量本身。这意味着收敛的判据不是数量指标，而是**正交性**：任意两个工具之间，能否用一句人话讲清"什么时候用 A、什么时候必须用 B"？讲不清，就是同一个工具的两条腿。

反过来说，**数量安全的正交通常也便宜**：一个 `calendar_create` 一个 `web_search`，摆三十对也不互相干扰。所以下文所有"收敛手段"的目标函数是：减少"说不清差别"的工具对，同时把 token 和披露成本降下来——而不是把工具数砍到某个魔法数字。

## 三、研究与工程演化线

这条线大致三年，节奏和 MCP 的爆发完全咬合：

| 时间 | 事件 | 意义 |
|---|---|---|
| 2023-10 | API-Bank（arXiv:2304.08244）把"检索并调用正确 API"做成 73 工具、753 次调用的基准［C，已核验］ | 工具选择第一次成为可测量问题 |
| 2023-12 | MetaTool（arXiv:2310.03128）区分"要不要用工具"与"用哪个工具"，并构造"相似工具区分"场景［C，已核验］ | 证明语义相近工具是准确率重灾区 |
| 2024-11-25 | Anthropic 发布 MCP（开放标准）［A，已核验］ | 工具接入标准化，**生态大爆炸的起点** |
| 2024-12-19 | 《Building effective agents》：简单优先、工具即文档接口［A，已核验］ | ACI 设计观的奠基文 |
| 2025-03 | ToolRet（arXiv:2503.01763，ACL 2025）：7,615 任务 / 43,215 工具的检索基准［A（同行评审），数字经镜像核验］ | 揭示"用检索层治工具面"的引入新故障：检索模型不懂工具 |
| 2025-05 | RAG-MCP（arXiv:2505.03275）：检索 top-K 工具再喂给 GPT-4o，准确率 13.62%→43.13%［C，已核验］ | "先检索后选择"路线的代表性数字 |
| 2025-09-11 | 《Writing tools for agents》：ACI 方法论成型（何时用/何时不用、防呆、可行动错误、token 效率、用 Agent 反向重写工具描述）［A，已核验］ | 工具描述从玄学变成可评测工程 |
| 2025-11 | advanced-tool-use：Tool Search Tool 等 beta 进 API（按需发现工具）；code-execution-with-mcp：工具定义与中间结果两类 token 的解法［A，已核验］ | "渐进披露"平台化 |
| 2025-12-09 | MCP 捐给 Linux Foundation 旗下 Agentic AI Foundation（Anthropic、Block、OpenAI 共同创立，Google/Microsoft/AWS/Cloudflare 支持）［A 事件本身；生态数字为厂商自报 B，已核验］ | 工具面爆炸从"Anthropic 的问题"变成"全行业的问题" |

一个值得注意的因果链：**MCP 的初衷是标准化"怎么接工具"，结果顺手解决了"谁来接工具"——于是没人对工具面的总量负责。** 官方公告给出的现状数字：活跃的公开 MCP 服务器超过 10,000 个，ChatGPT、Cursor、Gemini、Microsoft Copilot、VS Code 等均已采纳 MCP（以上均出自 Anthropic 2025-12-09 公告原文）［B，已核验］。当一个 Agent 同时挂 8 个 MCP server、每个 server 20 个工具时，工具选择问题就从"注意事项"升级成了主要矛盾。这正是本章要治理的对象。

## 四、关键实证数据

| # | 结论 | 数字 | 出处 | 等级 | 注意事项 |
|---|---|---|---|---|---|
| 1 | 大工具库下按需发现显著提升正确率 | Opus 4 在 MCP 评测 **49%→74%**；Opus 4.5 79.5%→88.1% | Anthropic《Advanced tool use》2025-11-24（内部测试） | B（一手工程文档，但为内部评测） | 评测集与设置未公开，不可与论文数字互比 |
| 2 | 工具定义 token 大头来自全量暴露 | 按需加载工具定义时 **token 降 85%** | 同上 | B | 省的是"未使用工具的定义"；合并描述本身不省这么多 |
| 3 | 全量工具定义在千级工具下直接不可行 | 数千工具时读请求前要先处理"数十万 token"；只加载所需定义 **150,000→2,000 token（−98.7%）** | 《Code execution with MCP》2025-11-04 | B | 同一问题的另一条技术路线（代码执行侧） |
| 4 | 工具选择可被检索显著改善 | 准确率 **13.62%→43.13%**（提升 >3 倍）；prompt token **降 >50%** | RAG-MCP，arXiv:2505.03275（2025-05） | C（预印本） | 基线绝对值很低，说明大工具池下全量提示近乎失效 |
| 5 | 检索层本身不可靠 | 7,615 任务 / 43,215 工具；在工具检索上，部分强 IR 模型**不如 BM25**；指令微调把 NDCG@10 从 33.83 提到 42.71 | ToolRet，arXiv:2503.01763，ACL 2025 | A | oracle 检索 vs 真实检索的差距直接传导为任务成功率差距 |
| 6 | 相似工具干扰是首要失效模式 | "相似工具区分"场景正确选择率仅 **44%–73%**（跨模型；ChatGPT 最好也只有 70–73%，few-shot 帮助有限） | MetaTool，arXiv:2310.03128 | C | 内部文档所引"Top-5 相似工具命中率近 50%"未查到原句，**源自内部文档·未核验**；本表以论文可见数据为准 |
| 7 | 好描述直接换执行时间 | 用 Agent 反复试错并**重写工具描述**后，后续 Agent 任务完成时间 **−40%** | Anthropic《How we built our multi-agent research system》 | B | 厂商自报内部实践；方向与 #1/#4 互证 |
| 8 | 工具数量警告线 | 官方文档称"degrades once you exceed 30–50 available tools"；产品博客称"when an agent has 15-20+ tools…" | docs.claude.com / platform.claude.com（Tool Search 及 Agent SDK 相关文档页） | B/未核验 | 原文页面在本次网络环境下因区域限制无法直读，**措辞与页码未核验**，转引自内部文档；"工具多了会退化"方向有 #1–#4 交叉佐证 |

两条元观察。其一，#1/#4 这类提升数字共同说明：**在足够大的工具池上，全量暴露 + 直接选择的基线差到接近随机**（#4 基线 13.62%），所以任何工程上的披露/收敛改进都容易"显著提升"——读这类数字时先看基线。其二，#5 给所有"用 RAG 治工具面"的方案泼冷水：**检索层会把你原来"选错"的毛病换成"漏掉"**，这是 ToolRet 标题的讽刺（Retrieval Models Aren't Tool-Savvy）——所以下文的收敛手段必须配 fallback。

## 五、反模式与常见误解

1. **"工具越多能力越强"**。能力的上限是模型，工具只是把能力投影到可执行域；投影面互相重叠时，每加一个近似工具都在给兄弟工具的选择正确率投反对票。
2. **"合并 = 减少数量"**。把 20 个工具无脑塞进一个 `do_everything(action)`，选择面只是从 20 个工具挪进了 20 个 action——模型照样选错，而且参数 schema 变成巨型联合类型，错误信息更难写。判断标准仍是正交性：`broadcast_message` 就算和 `send_message` 语义很近，也值得独立存在，因为群发需要确认闸门。
3. **"用统一前缀假装正交"**。`asana_search / jira_search` 这类前缀确有澄清作用——Anthropic 明确推荐按服务/资源命名空间划界，同时提醒："selecting between prefix- and suffix-based namespacing to have **non-trivial effects** on our tool-use evaluations. Effects vary by LLM"。也就是说前缀不是免费午餐：它把区分责任押在命名的词面顺序上，换模型可能失效，得用自己的评测选边。同族前缀（`app_screenshot / app_goto / app_act…`）在语义上照样可能互相干扰。
4. **"描述写得文艺就行"**。"搜索信息，处理数据"这种描述在 5 个工具里没事，在 30 个里就是事故现场。描述的核心字段是**边界**：何时用、何时**不**用、以及"何时不用"要**点名兄弟工具**。
5. **"收敛完就可以上渐进披露了"**。渐进披露（低频工具延迟加载、按需搜索注入）会引入新故障类：gold 工具没被检索进候选就直接失败（#5）。高频工具必须常驻，检索层要有兜底直通；这就是"收敛有代价，必须配 fallback"（内部调研对 ToolRet/API-Bank 的结论句，原始表述未逐字核验［源自内部文档］）。
6. **"30 个工具是安全线"**。把各家阈值（15–20+、30–50）当魔法数字。真正该问的是：最大的语义簇有多大、簇内描述能不能让新人分清、你的评测里混淆发生在哪一对工具上。

## 六、工程手册

### 6.1 工具描述怎么写（描述即接口）

一份可以直接抄的模板（依据《Writing tools for agents》与多 Agent 系统复盘提炼）：

```text
name:        send_im_message          # 动词_对象；不用 stuff/data/misc
description: 向已知联系人或群发送一条即时消息（微信/企微/飞书）时使用，单次一个接收方。
             邮件请用 send_email，短信请用 send_sms；
             向 10 人以上群发是高风险操作，请改用带确认闸门的 broadcast_message，
             不要循环调用本工具。
parameters:
  peer:  联系人/群 ID，格式 wx:<id> 或 grp:<id>；不接受昵称——先调 search_contacts 解析
  text:  消息正文，最长 2000 字符，纯文本
examples:  [{ "peer": "wx:zhanglaosan", "text": "路上堵车，晚到十分钟" }]
returns:   message_id + 送达状态；文本超限整体报错，不静默截断
errors:    peer '老王' 不是合法 ID（格式 wx:<id>）。请先用 search_contacts(name='老王') 取得 ID。
```

要点逐条对应：何时用（第一句）、何时不用＋点名兄弟工具（防同族误选）、参数格式/单位/上限显式声明、至少一个真实形状的示例、错误信息自带下一步动作。最后一条值得单独强调——**错误信息是写给模型读的，可读的错误信息等于免费给模型加了一次自我修正机会**；干巴巴的 `An error occurred` 通常换来的是模型再犯一次同样的错，或者干脆开始瞎编参数。

进阶做法来自 Anthropic 的内部实践：让 Agent 拿着坏工具反复试跑，把失败模式喂回去让它**重写工具描述**——重写后后续 Agent 的任务完成时间降了 40%［B，已核验］。描述不是写完就冻结的，它应该有 eval、有版本、有回归测试（`Writing tools for agents` 整篇就是教你搭这套 eval 的）。

### 6.2 收敛手段三件套

**(1) 带 action 的合并**。把"同族不同动词"的工具面收成 `domain(action=...)`。内部调研 §六附表给过一个真实治理案例（维护 Agent 31 个工具 → 目标 <20），摘录如下——它同时展示了"什么该并、什么不该并"：

| 组 | 现状 | 处置 | 理由 |
|---|---|---|---|
| `memory_search / memory_read / memory_manage` | 3 个 | 合并为带 action 的 `memory` | 同族三兄弟，描述难分 |
| `wiki_overview / wiki_search / wiki_read` | 3 个 | 合并为带 mode 的 `wiki` | 同上 |
| `app_screenshot / app_goto / app_act / app_fill_form / app_scroll_to_text / app_scroll_to_bottom / app_goto_and_screenshot` | 7 个 | 收成 `app_goto + app_act + app_screenshot` 三个；滚动/填充并入 act | 高频的保留独立，低频动作降为 action |
| `cron_create / cron_list / cron_delete / cron_guide` | 4 个 | **保持** | 语义不重叠，且有硬防线依赖 |
| `skill_list / skill_search / skill_invoke` | 3 个 | 合并为 `skill` | 同族 |
| `file_read / file_write / file_edit / list_dir / glob / grep` | 6 个 | 保留读写三件；`list_dir` 并入 `glob` | 维护场景真要用，正交部分不动 |

注意 `cron_*` 一行：收敛的否决理由是"语义本来就不重叠＋有外部契约依赖"，而不是"数量还没超"。

**(2) 渐进披露**。高频工具常驻上下文；低频工具不定义进 schema，而是通过一个搜索入口按需加载——Anthropic 的 Tool Search Tool 就是这个模式的产品化：常驻一个约 500 token 的搜索入口，按查询注入 3–5 个相关工具（约 3K token），内部报告整体工具定义开销约降 85%，MCP 评测 Opus 4 从 49% 提到 74%［B，已核验］。平台不支持时，自建版本也不难：维护一张"工具名 + 一句话描述"的轻量索引，让 Agent 先 `tool_search(query)` 再被注入具体 schema。

**(3) fallback 设计**。披露层和检索层都是新的故障源，三条硬规矩：高频工具永不延迟加载；检索入口失败时降级为全量列表（宁可 token 浪费，不可静默漏工具）；"是否需要调工具"本身允许模型回答"都不合适"——MetaTool 专门测这个，因为强迫模型在错误候选里硬选，比让它空手而归更糟。

### 6.3 工具面审计清单

建议每季度（或工具数每 +5）跑一次，全程约半天：

1. **数一数**。按语义簇分组列出全部工具（不是按前缀！），标出频率（高/中/低）与单次返回的典型大小。
2. **画相似度**。拿 20–30 条真实用户请求过一遍当前工具面，统计每个错误案例里"gold 与误选工具"是否同簇；同簇占比高 → 优先收敛，跨簇占比高 → 优先改描述。没有真实日志时，用本章实验 A 的合成数据练手。
3. **找合并候选**。同簇 ≥2 即候选；逐个过三问：返回形状是否兼容？权限/风险级别是否一致（不一致的如群发、删除类，保留独立闸门）？合并后 action 参数能否覆盖全部原语义？
4. **验证错误率**。收敛前后各跑同一评测集：工具级 top-1、参数级正确率、错误信息导致的重试次数。合并没提升就别合并——收敛是手术，不是减肥。
5. **量执行面**。抽查最长的一次工具返回：是否截断？模型是否被长结果带偏？（见 §6.4）

### 6.4 工具结果的上下文卫生

选择面之外，执行面同样在决定成败。Anthropic 的量化：一份 2 小时会议转录经由"结果直接入上下文"的客户端，会被完整穿过模型**两次**，约 50,000 token；取回 10,000 行的表格，模型真正需要的可能是"pending 的行有几条"［B，已核验］。对策按成本从低到高：

- **截断与分页**：返回带 `truncated: true` 与 `cursor`，并在描述里写明续取方式。"静默截断"是最坏的选项——模型不知道数据不完整，会基于残缺结果下结论。
- **冗余控制**：给结果加 verbosity 参数（如 `ResponseFormat: detailed|concise`），让调用方按需取全量或摘要。
- **先过滤再入上下文**：能在工具侧过滤/聚合的绝不让模型在上下文里做；再进一步就是 code execution 路线——把中间结果留在执行环境里，只把结论送进上下文（150,000→2,000 token 即此路线）。
- **错误可行动**：执行面的错误契约同 6.1——写出"缺什么、合法值、下一步"，模型才能就地修正而不是换一条更离谱的路径。

## 七、动手实践（hands-on/ch04/）

两个实验都是纯 Python 标准库，无第三方依赖，`python tool_confusion_experiment.py` / `python description_lint.py` 即可运行（Python 3.8+）。

**实验 A：工具选择混淆离线实验**。内置 40 个合成工具定义（含搜索、文件、笔记、消息、日历等九个语义簇，每簇 2–7 个近似工具）与 30 条带标准答案的请求。三个配置——`full`（40 全量暴露）、`converged`（按语义簇收敛到 18 个，deep_research 与 broadcast_message 因成本/风险语义不同刻意不并）、`lazy`（高频常驻＋每题检索 top-6 注入的渐进披露模拟）；选择器默认用 TF-IDF 词面重叠离线模拟（**这是对 LLM 行为的粗糙模拟，用来观察"语义干扰"现象，不是复现论文**；配了 `LLM_API_KEY` 可切换真实模型选择）。本机实测（Python 3.12.10）：

| 配置 | 工具数 | 工具块 token（估算） | top-1 | top-1 错误中同簇混淆 |
|---|---|---|---|---|
| full | 40 | 1,443 | 83% | 3 例 |
| converged | 18 | 1,478（**未降**） | 87% | **0 例** |
| lazy | 40（平均每题只注入子集） | 622（**−57%**） | 83% | 3 例 |

你应该观察到三件事：同簇混淆从 3 归零——收敛治的是干扰本身；converged 的 token 不降反微升——**词面合并不是省 token 的手段，省 token 的是按需加载**（lazy 列 −57%，对应 Anthropic 报告的 85% 同一机制）；lazy 的准确率与 full 持平且干扰原样保留——渐进披露与收敛是两个正交杠杆，要一起用。另外 converged 的 +4pp 里有"gold 变成工具族"的机械成分，README 里有诚实拆解；把脚本里 `_short_desc` 的压缩长度从 44 改到 24 再跑，能看到描述压太狠时收敛自己也会翻车（实测会掉到 70%）——这就是 6.2 所说"收敛有代价"的微型复现。

**实验 B：工具描述重写工作坊**。三个刻意写坏的 schema（`process_data`：上帝工具；`search_stuff`：描述只有"搜索。"；`notify`：渠道不明＋"等等。"＋错误信息只有 `error`），对照十项 checklist 静态打分，再给出重写版（`transform_csv`、`search_web`、`send_im_message`）。本机实测：坏版合计 4/30，重写版 30/30，逐项诊断会列出每条 ✗ 的修复建议。建议玩法：先 `--bad-only` 盲打分自己判一遍，再对答案；然后删掉重写版里"何时不用"那半句，看第 3 项如何塌掉——那就是 6.1 里同族工具互相指路的意义。

## 八、本章小结

1. 工具层是 Agent 的 API（ACI）：描述、参数契约、错误信息都是运行时接口，读者从人换成了模型。
2. 选错工具的主因是语义相近工具互相干扰（MetaTool：相似工具场景各家模型只有 44–73%），数量只是放大器——所以收敛的判据是正交性，不是数量魔法线。
3. 大工具池全量暴露的基线差到接近随机（RAG-MCP：13.62%），任何披露改进都"显著提升"——读提升数字前先看基线和评测归属。
4. 三件武器各治一段：带 action 合并治选择面（混淆 3→0），渐进披露治暴露面（token −57%/−85% 同机制），可行动错误＋截断分页契约治执行面。
5. 合并本身不省 token（实验 A：1,443→1,478）；省 token 的从来是"不加载不用的定义"。
6. 用检索层治工具面会引入新故障（ToolRet：检索模型甚至不如 BM25）——高频常驻、失败降级全量、允许"不调用"，fallback 是设计的一部分。
7. 好描述是可以用工程方法炼出来的：Anthropic 让 Agent 试错重写工具描述，换来任务完成时间 −40%；描述应当有 eval、有版本，而不是注释级的即兴发挥。
8. MCP 赢下了生态（10,000+ 服务器、ChatGPT/Gemini/Copilot 采纳、捐给 Linux 基金会），也因此把"工具面治理"从 Anthropic 的烦恼变成了全行业的必修——这正是它值得单独成章的原因。

## 九、参考文献

| # | 文献 | URL | 等级 | 核验状态（2026-09-16） |
|---|---|---|---|---|
| 1 | Anthropic, Building effective agents (2024-12-19) | https://www.anthropic.com/engineering/building-effective-agents | A | ✅ 已核验 |
| 2 | Anthropic, Writing tools for agents (2025-09-11) | https://www.anthropic.com/engineering/writing-tools-for-agents | A | ✅ 已核验 |
| 3 | Anthropic, How we built our multi-agent research system | https://www.anthropic.com/engineering/multi-agent-research-system | A/B（40% 为厂商自报） | ✅ 已核验 |
| 4 | Anthropic, Advanced tool use: Tool Search Tool 等 beta（2025-11-24） | https://www.anthropic.com/engineering/advanced-tool-use | B（内部评测） | ✅ 已核验（49→74 / 85% / Opus 4.5 79.5→88.1） |
| 5 | Anthropic, Code execution with MCP (2025-11-04) | https://www.anthropic.com/engineering/code-execution-with-mcp | B | ✅ 已核验（150k→2k / 50k 转录） |
| 6 | Anthropic, Introducing the Model Context Protocol (2024-11-25) | https://www.anthropic.com/news/model-context-protocol | A | ✅ 已核验 |
| 7 | Anthropic, Donating MCP to the Agentic AI Foundation (2025-12-09) | https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation | A（事件）/B（生态数字） | ✅ 已核验（10,000+ 服务器；ChatGPT/Cursor/Gemini/Copilot/VS Code；97M+ 月 SDK 下载） |
| 8 | Claude Docs, Tool search tool 页 | https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool | B | ⚠️ URL 存在，但页面因网络区域限制无法直读；"30–50"与"15-20+"两处措辞**未核验**，转引自内部文档 |
| 9 | Gan & Sun, RAG-MCP (arXiv:2505.03275, 2025-05) | https://arxiv.org/abs/2505.03275 | C | ✅ 摘要经 alphaXiv 镜像核验（13.62%→43.13%，token 降 >50%；arXiv 直连在本环境不可达） |
| 10 | Huang et al., MetaTool Benchmark (arXiv:2310.03128) | https://arxiv.org/abs/2310.03128 | C | ✅ 编号与相似工具数据（44–73%）经镜像核验；"Top-5 近 50%"**源自内部文档·未核验** |
| 11 | Li et al., API-Bank (arXiv:2304.08244) | https://arxiv.org/abs/2304.08244 | C | ✅ 摘要经镜像核验（73 API / 314 对话 / 753 调用） |
| 12 | Liu et al., ToolRet: Retrieval Models Aren't Tool-Savvy (arXiv:2503.01763, ACL 2025) | https://arxiv.org/abs/2503.01763 | A | ✅ 数字经搜索快照与镜像核验（7,615/43,215；33.83→42.71） |
| 13 | 内部调研：《12·一级公民的积累与演化》§2.2/§六附表/§八 | workspace uploads/2026-09-16/ | 内部材料 | 31→<20 收敛案例出自该文档 |

> 核验方法备注：#4/#5/#7 直接抓取 anthropic.com 原文；#9/#10/#11 因 arXiv 在本网络环境不可达，改用 alphaXiv 摘要镜像与 OpenReview/DBLP 快照交叉核对；#12 经搜索引擎快照（含 arxiv.org 摘要、官方 GitHub、ACL 论文页）交叉核对。证据等级沿用原调研约定：A=同行评审或大厂一手工程文档；B=厂商自报；C=预印本/未核验。


---

# 第 5 章 · 多 Agent 系统：什么时候值得，什么时候是债

> 本章解决一个问题：怎么判断手头的任务是否真的需要多个 Agent；如果需要，哪种形态是被验证过的。不教你搭"数字员工团队"，先教你什么时候不该搭。
> 预计阅读时长：约 30 分钟 · 前置知识：第 1 章（Agent 循环：模型 + 工具 + 上下文）、第 2 章（上下文管理）、第 3 章（提示词与工具设计）

---

## 一、为什么这件事重要

两个真实到发霉的场景。

**场景 A**：领导看完"AI 员工分工协作"的演示视频，让你两周内出一个方案——需求 Agent、开发 Agent、测试 Agent，像一家小公司一样互相汇报，最好下周就上轨道。

**场景 B**：你已经这么干过了。按职能拆了三个 Agent，结果更糟：需求 Agent 的产出转述给开发 Agent 时丢了一半语义；开发 Agent 的实现和测试 Agent 的预期对不上；每天光是"互相交接总结"烧掉的 token，比直接写代码还多。

场景 B 不是你手艺差。Anthropic 在 2026 年 1 月的官方博客里写得很直接：

> "teams invest months building elaborate multi-agent architectures only to discover that improved prompting on a single agent achieved equivalent results."
> （团队花数月搭建精巧的多 Agent 架构，最后发现把单 Agent 的提示词改一改就达到了同等效果。）[5]

学术侧更早画出了难看的底牌：MAST 团队统计 7 个主流多 Agent 框架，**失败率在 41%–86.7% 之间**[6]。也就是说，多数被端到端跑通演示过的多 Agent 系统，离"可靠"还差一个数量级。

所以本章的问题顺序是反的：不是"怎么搭"，而是**"这个任务配不配得上多 Agent 的协调成本"**。对绝大多数任务，诚实的答案是"不配"。但少数任务确实配，而且形态已经被验证——把祛魅做透之后，我们会把那条例外通道画清楚。

---

## 二、核心概念与框架

### 2.1 先把 workflow 和 agent 分开

起点还是那份被引用最多的工程文档：Anthropic《Building effective agents》（2024-12-19）[1]。它用两句话划了线：

- **Workflow**：LLM 和工具沿**预先写定的代码路径**被编排；
- **Agent**：LLM **动态决定**自己的流程和工具使用。

这个区分对"多 Agent"尤其要紧，因为"多 Agent"实际上是两种东西的混称：**固定管线里调多次 LLM**（workflow，可控、可调试、便宜），和**多个自主循环互相传消息**（agent 团队，2026 年了仍然接近于债）。同一篇文章的第一原则依旧是那句最无聊的话：**找最简单的可行方案，只在它明确不够用时才加复杂度**——很多场景甚至根本不需要 agentic 系统，一次检索增强的单调用就够了。

### 2.2 五种 workflow 模式：一句话 + 一张小图

来自 [1]，这是所有"多 Agent 编排"的原子词汇表。先记住它们，因为后文所有"值得多 Agent"的场景，本质上都是这五种模式的组合。

**1）Prompt chaining（链式）**：把任务切成固定流水线，每次调用处理上一次的输出，中间可以加程序化校验。

```
输入 → [LLM 起草] → 检查 → [LLM 翻译] → 输出
```
适合：任务能干净地拆成固定子步骤，用延迟换准确率。

**2）Routing（路由）**：先分类，再分发给专门的下游提示词/模型。

```
输入 → [分类器] →┬→ [专业提示 A]
                └→ [专业提示 B]
```
适合：输入类型分明、分类本身可靠（客服分流；简单问题走小模型、难问题走大模型）。

**3）Parallelization（并行）**：两种变体——**sectioning**（拆独立子任务并行跑）与 **voting**（同一任务多跑几次取共识）。

```
输入 →┬ [LLM a] ┐
      ├ [LLM b] ├ → [程序化合并/投票]
      └ [LLM c] ┘
```
适合：子任务天然独立，或需要多视角提升置信（漏洞审查多个提示各查各的）。

**4）Orchestrator-workers（调度者-工作者）**：中央 LLM **动态**拆解任务、派给 worker、汇总结果——与 parallelization 的区别是子任务不可预先写定，由 orchestrator 按输入现场决定。

```
        ┌→ [worker 1]
[orch] ─┼→ [worker 2] → [orch 汇总]
        └→ [worker 3]
```
适合：改哪些文件、查哪些方向事先说不清的任务（多文件编码、多源检索）。

**5）Evaluator-optimizer（评审-优化）**：一个 LLM 生成，另一个按明确标准评审反馈，循环改进。

```
[生成] → [评审] → 不达标? → [修改] ↺ 达标 → 输出
```
适合：有清晰评审标准、且迭代确实能带来可测提升的任务（文学翻译、多轮检索的"还要不要再查"判断）。

### 2.3 orchestrator-worker 到底在买什么

把这五种模式里的 orchestrator-worker 展开到生产级，就是 Anthropic 的 Research 功能（《How we built our multi-agent research system》，2025-06-13）[2]：一个 lead agent 理解问题、制定策略、**并行**孵化 3–5 个 subagent，subagent 各自带独立上下文窗口去搜索，把压缩后的结论交回 lead，最后由 CitationAgent 统一挂引用。

这篇一手工程文档里最有解释力的一句话是：**"搜索的本质是压缩"**（the essence of search is compression）。多 Agent 在信息检索型任务上的收益不是"人多力量大"的玄学，而是两个具体的机制：

1. **并行扩大总上下文与总 token 预算**——每个 subagent 一个独立上下文窗口，读得下超出单窗口极限的资料量；
2. **subagent 作为"智能过滤器"**——只回传浓缩结论，lead 的上下文不被原始材料污染。

注意：这两个机制都发生在**写之前**、发生在**读**上。记住这一点，它是本章后半程的钥匙。

---

## 三、研究与工程演化线：高光 → 反思 → 当前共识

| 时间 | 文献 | 立场 | 一句话概括 |
|---|---|---|---|
| 2024-12 | Anthropic《Building effective agents》[1] | 克制 | 最简单的方案优先；workflow 与 agent 分清 |
| 2025-03 | MAST（arXiv:2503.13657）[6] | 泼冷水 | 7 个主流框架失败率 41%–86.7%，瓶颈在协调与验证 |
| 2025-06 | Anthropic 多 Agent 研究系统[2] | 高光 | 内部评测多 Agent 比单 Opus 4 高 90.2%，但 token 约为聊天 15 倍 |
| 2025-06 | Cognition《Don't Build Multi-Agents》[3] | 唱反调 | 并行 subagent 各自做隐含决策，互相冲突，系统必然脆弱 |
| 2026-01 | claude.com《Building multi-agent systems: When and how to use them》[5] | 收敛 | 三种场景值得多 Agent，其余场景协调成本大于收益 |
| 2026-04 | Cognition《Multi-Agents: What's Actually Working》[4] | 自我修正 | 写路径单线程时，多 Agent 确实开始起作用 |

**高光（2025-06，[2]）**。Anthropic 报告：以 Claude Opus 4 为 lead、Sonnet 4 为 subagent 的多 Agent 系统，在其内部研究评测上比单 Agent Opus 4 **高出 90.2%**；对最难的"找得到难找信息"类评测（BrowseComp），**token 用量单独解释了 80% 的性能方差**（加上工具调用次数与模型选择共解释 95%）。同月给出的价签同样明确：**agent 比普通聊天多用约 4 倍 token，多 Agent 系统约 15 倍**——"任务价值付得起这个性能账单"才值得做。这篇文档的好在于它连冷水一起给：多 Agent 擅长的是**高价值、可大幅并行、信息量超过单上下文窗口**的任务；而多数编码任务可真正并行的部分少、agent 间实时协调又弱，"不是好的多 Agent 场景"。

**反思（同月，[3]）**。Cognition 的《Don't Build Multi-Agents》把问题拉到原理层，提出上下文工程两原则：**① 共享上下文，而且要共享完整行动轨迹而非单条消息；② 行动隐含决策**（actions carry implicit decisions）。第二条是全文最锋利处：两个并行 subagent 各自开工时，会在风格、边界条件、代码模式上做出没人显式约定的隐含决策——Flappy Bird 克隆的例子：一个 agent 造出马里奥风的背景，另一个造出不像游戏素材的小鸟，最后的合并是一场灾难。他们的替代方案朴素得反常识：单线程线性 agent + 一个专门压缩历史的小模型。文中还举了一个行业级教训：2024 年流行"大模型出修改说明、小模型改文件"的 edit-apply 两段式，后来被证明不可靠，改回单一模型一次完成——**把决策拆给两个执行者，接口吃掉的就是可靠性**。

**数据（2025-03 挂出、2025-10 修订 v3，[6]）**。MAST 团队（Berkeley 等，作者含 Keutzer、Klein、Zaharia、Stoica 等）对 7 个主流多 Agent 框架的 1600+ 条执行轨迹做人工+LLM 标注（人工标注一致性 κ=0.88），得到 14 种失败模式、3 大类。数字见下节，结论先说：**死因排前列的不是"角色不听话"，而是"步重复"与"想一套做一套"**。

**收敛（2026-01，[5]）**。Anthropic 产品博客给出目前最完整的共识表述：多 Agent **只在三种情况下持续胜过单 Agent——上下文污染损害性能、任务可真正并行、专职化工具/提示确实提升选择质量**；除此之外，"协调成本通常超过收益"。他们实测多 Agent 完成同等任务通常消耗**单 Agent 的 3–10 倍 token**；在一个"按开发职能拆 agent"（planner / implementer / tester / reviewer）的实验里，**subagent 花在协调上的 token 比花在干活上的还多**，每次交接都在玩"传话游戏"。拆分方法论只有一条：**按上下文边界拆（context-centric），不按工作类型拆（problem-centric）**——懂某功能的 agent 应该连它的测试一起写，因为上下文已经在他手里；只有当上下文能被真正隔离时才拆。

**自我修正（2026-04，[4]）**。同一位作者 Walden Yan 写续篇《Multi-Agents: What's Actually Working》，开篇承认："10 个月前我说不该建多 Agent……现在我们部署了一些真正work的多 Agent 系统。"但立场变化不是打脸，而是划界收窄：**写路径保持单线程（writes stay single-threaded），额外的 agent 贡献智能而非行动（contribute intelligence rather than actions）**。两条原则一条没改，改的是前提：模型更 agentic 了、企业用量半年涨约 8 倍带来成本压力（于是出现"快模型干活 + 贵模型规划"的 Smart Friend 搭配）、以及一批只读形态跑通了。跑通的样本恰好都是本章要交付的形态：

- **代码评审循环**：让"另一个 agent"评审 Devin 自己的 PR，平均每个 PR 抓到 2 个 bug、其中约 58% 是严重的（逻辑错误/边界缺失/安全）；反直觉的发现是**评审 agent 与编码 agent 不共享上下文时效果最好**——干净上下文让它从实现反推规格、敢质疑被指令带偏的编码 agent，而且短上下文本身更聪明（Context Rot：上下文越长，注意力摊薄，决策越钝）。写动作仍然只有编码 agent 一个。
- **只读子 agent 作为"高级工具调用"**：Deepwiki 代码检索子 agent 只回答上下文问题。作者坦承这"更像工具调用而非真正的多 agent 协作"——诚实，也正是本章的判断基准：先承认这类成功其实是并行检索 + 上下文隔离。

**这两篇 Cognition 文章的立场变化本身就是本章最好的教材**：判断没有过时，判断的**输入**变了。读工程博客的正确姿势，是把每篇文章拆成"原则 / 结论 / 当时的前提"三层——原则往往长寿，结论跟随前提。

---

## 四、关键实证数据

| # | 结论 | 数字 | 出处 | 证据等级 | 注意事项 |
|---|---|---|---|---|---|
| 1 | 多 Agent 研究系统在 breadth-first 检索型任务上大幅超单 Agent | 内部评测 +90.2%（lead=Opus 4，sub=Sonnet 4，对照单 Opus 4） | [2] | B（厂商自报内部评测） | 内部评测集，未公开样本量与题目 |
| 2 | 多 Agent 有效的主因是"花得起 token" | token 用量单独解释 BrowseComp 性能方差 80%；三因素共解释 95% | [2] | B | 分析基于其内部数据 |
| 3 | 多 Agent 的 token 账单 | agent≈聊天的 4 倍；多 Agent≈聊天的 15 倍 | [2] | B | 注意基准是 chat 而非单 agent |
| 4 | 多 Agent vs 同等单 Agent 的任务开销 | 3–10 倍 token；"协调花掉的比干活多" | [5] | B | 厂商产品博客自报 |
| 5 | 按职能拆 agent 的专门实验 | planner/implementer/tester/reviewer 四角色：协调 token 多于干活 | [5] | B | 实验细节未展开 |
| 6 | 主流框架失败率 | 41%–86.7%（7 个框架） | [6] | C | 预印本；框架版本与任务分布影响大 |
| 7 | 失败分类 | 14 种失败模式 / 3 大类（系统设计 44.2%、agent 间错位 32.3%、任务验证 23.5%） | [6] | C | v3 数字；v1/v2 首类曾称"规格问题" |
| 8 | 最高频失败 | step repetition 15.7%；reasoning-action mismatch 13.2% | [6] | C | 均为全部轨迹中占比 |
| 9 | **最不起眼的失败** | disobey role specification 仅 **1.5%** | [6] | C | 反直觉结论的关键证据 |
| 10 | 多 Agent 研究系统的提速来源 | 并行 3–5 subagent + 每 subagent 并行 ≥3 工具：复杂查询时间降最多 90% | [2] | B | 是 IO 型检索的并行，不是"agent 多=快" |
| 11 | 评审循环的独立收益 | Devin Review 平均 2 bug/PR，约 58% 严重 | [4] | B | 厂商自报，且自家代码 |
| 12 | 并行收益的本质 | "并行化的主要收益是彻底性，不是速度"；总计算暴增使端到端常更慢 | [5] | B | 与 #10 不矛盾：场景不同 |

**表里最该带走的是 #8 和 #9 的组合**。MAST 的分类统计里，把每个角色的提示词写到极致，能挽回的失败上限就是 1.5%；而"重复已完成步骤"（15.7%）、"推理说一套、行动做一套"（13.2%）、"不知道何时终止"（12.4%）这些**协调与验证类**失败加起来超过四成。内部调研文档由此提炼的那句话值得抄在墙上——**"把每个专家的提示词写得更好"几乎从来不是瓶颈，协调与验证才是**（措辞源自内部文档·结论与 [6] 数据方向一致）。

---

## 五、反模式与常见误解

### 5.1 按职能拆 Agent（"写作 agent / 测试 agent / 审核 agent 各一个"）

最直觉、最像人类公司、证据最差的拆法。[5] 给了名字：problem-centric decomposition，并观察到它是多 Agent 项目失败的首要设计错误——每次交接丢一段上下文（telephone game），角色间的信息传递成本随角色数上升。正确做法是 **context-centric**：按"完成这件事需要什么上下文"分组，一个功能的实现和它的测试给同一个 agent，因为它们需要的上下文是同一份。有效的边界只有三类：独立的检索路径、接口干净（有 API 合同）的独立组件、只需要跑测试报结果的**黑盒验证**。

### 5.2 用多 Agent 弥补"单 Agent 提示词没写好"

[5] 那句"数月白干不如改提示词"的引言专治此症。MAST 给了数据版：角色不服从仅 1.5%——失败不是因为"专家不够专业"，而是因为专家之间不协调、做完没人验。**加角色 ≠ 加能力**；先把单 Agent 的提示词、工具、验证做扎实，是本章所有建议的地基。

### 5.3 并行写同一份状态

[3] 的核心：行动隐含决策，并行写必然产生决策冲突，合并即灾难。当前被验证的多 Agent 形态无一例外遵守：**写路径单线程**，其他 agent 最多贡献"评审意见/检索结论/规划建议"这类智能输出[4]。要让 reviewer 直接改代码，就让它排队，别让它并行。

### 5.4 把并行当成"更快"

[5] 的原话："The primary benefit of parallelization is thoroughness, not speed."多 Agent 的总计算暴增（3–10 倍 token），端到端常常反而更慢；[2] 的 90% 提速来自把本可并发的检索请求（IO 等待）并发化，是同一笔计算换了排布，不是凭空变快。**买多 Agent，买的是"读得全"，不是"下班早"。**

### 5.5 worker 回传全文

worker 把原文段落直接贴回来，等于把上下文污染从 worker 转嫁到 orchestrator——隔离白做了。被验证的接口是：**worker 只回结论**（结构化、短、带出处指针），orchestrator 永远不读原始语料（本章实验就是这么实现的）。

### 5.6 设计守则清单

| # | 守则 | 依据 |
|---|---|---|
| 1 | 永远先建单 Agent 基线，并**持续优化它的提示词与工具**，让它成为被比较的对象而不是弃子 | [1][5]；[5]：改提示词常等价于换架构 |
| 2 | 上多 Agent 前过**三问**（见 5.7），任何一问答"否"就回到单 Agent | [5] 三条件；[2] "高价值+可并行" |
| 3 | 按上下文边界拆 agent，不按职能拆 | [5] context-centric |
| 4 | 写路径单线程；并行只允许出现在读上 | [3] 原则二；[4] writes stay single-threaded |
| 5 | worker 只回结论（结构化、短、带指针），不回全文 | [2] 压缩过滤；[4] 评审 diff 不回实现史 |
| 6 | orchestrator 的派工单必须四件套：目标、输出格式、工具指引、边界 | [2] "teach the orchestrator to delegate" |
| 7 | 给 orchestrator 写**力度档位**（简单问题 1 个 agent 3–10 次调用；复杂才多 worker），防止为简单任务开大会 | [2] scale effort |
| 8 | 把验证当一等公民：终点要有独立验证点/终止判据 | [6] 验证类失败合计 23.5% |
| 9 | 监控里加"协调税"指标：协调 token / 干活 token 的比值，超阈值就回退架构 | [5]；本章实验第 6 节实现 |

### 5.7 收益判断三问

1. **任务可并行吗？**——子任务之间不需要实时对话（市场研究分地区、多文件检索可以；一边改 schema 一边写迁移不行）。
2. **各子任务是"读多写少"吗？**——多 Agent 的收益几乎全部来自并行读取 + 上下文隔离（[2] 的核心机制）；写型子任务请单线程。
3. **合并结果的接口清晰吗？**——orchestrator 能否只凭 worker 的短结论完成汇总？如果汇总需要读原文，说明接口没设计好，或者根本不该拆。

再加一条经济账的直觉：**单 Agent 基线越强，多 Agent 越可能亏**（源自内部文档的提炼判断，与 [5] 的实验观察一致）——基线强意味着"基线做不到的部分"少，而协调税按结构照收。

---

## 六、动手实践：orchestrator-worker 最小实现与单 Agent 对照

代码在 `hands-on/ch05/`：`single_vs_multi.py`（纯标准库）、`corpus/`（10 篇虚构但逼真的报道）、`README.md`（含桩模式局限，务必先读）。

**任务**：汇总"青云地铁 12 号线首月客流争议"中官方/媒体/社区三方来源的**口径差异**（51.2 万客运量 vs 38.4 万进站量 vs "预测 65 万到底是日均还是高峰日"……）。内置 10 条要点 rubric 做覆盖打分。

**两种架构**：

```
A. 单 Agent 基线                       B. orchestrator + 2 worker
loop:                                 1) orchestrator 规划（只见语料索引）
  prompt = 任务 + 累计笔记 + 新批次语料   2) 2 个只读 worker 各领一个语料阵营，
  笔记超出容量上限 → 旧笔记被挤出上下文       只回结构化要点，不回全文
final = 幸存的笔记                     3) orchestrator 合并 worker 结论 → 终稿
```

**运行**（无需 API key）：

```bash
python single_vs_multi.py --stub
```

桩模式参考输出（本机实测）：

| 指标 | 单 Agent | orchestrator+worker |
|---|---|---|
| LLM 调用步数 | 3 | 4 |
| 总 token（估算） | 4170 | 5931（+42%） |
| 协调开销占比（指令重发+状态交接） | 27.7% | 33.4% |
| rubric 覆盖 | 6/10 | 9/10 |

**你应该观察到**：① 多 Agent 更贵——每个 worker 重领任务说明、结论要回传合并，都是协调税，数字被单独统计出来了；② 单 Agent 的早期材料要点被笔记预算挤出，官方阵营事实在最终答复里消失——这正是单 Agent 长任务丢信息的机制演示；③ orchestrator 全程没读过任何一篇语料原文（读代码验证）——这就是"只回结论不回全文"的信息流；④ 多 Agent 并非自动满分：worker 额度用满后，财经账本照样被裁掉——信息丢失没有消失，只是从"主上下文"搬到了"接口额度"。改 `SINGLE_NOTES_CAP`、改 worker `quota`、或配好 `OPENAI_API_KEY` 用 `--real` 跑真实模型，观察数字如何移动（练习见 README）。

---

## 七、本章小结

1. **多 Agent 是上下文与并行度的管理手段，不是"模拟员工"的架构美学**。被验证的收益机制只有两个：并行扩大读取规模、用独立上下文做隔离与过滤[2]。
2. 判断顺序永远反过来：**先有单 Agent 基线，先优化它**。"数月白干不如改提示词"是厂商自述，MAST 的 1.5% 是学术旁证[5][6]。
3. 值得多 Agent 的三个场景：上下文污染、真正可并行、专职化工具选择[5]；且任务价值要付得起 3–10 倍（相对聊天可达 15 倍）的 token 账单[2][5]。
4. **按职能拆 agent 是头号反模式**；按上下文边界拆，写路径单线程，worker 只回结论[3][4][5]。
5. 并行买的是**彻底性**不是速度[5]；把"多 Agent"和"并发请求"混为一谈是最贵的误会。
6. 失败统计的真瓶颈是**协调与验证**（step repetition 15.7%、reasoning-action mismatch 13.2%），不是角色提示词（1.5%）[6]——预算优先花在终止判据、验证点和派工单质量上。
7. Cognition 十个月的立场变化示范了正确的演化观：**原则（上下文共享、行动隐含决策）长寿，结论随模型能力与成本结构移动**[3][4]。每季度重估一次边界，而不是忠于某个架构。
8. 给系统装上"协调税"监控：当协调 token 逼近干活 token，就是架构该回退的警报[5]。

---

## 八、参考文献

1. Anthropic Engineering. *Building effective agents*. 2024-12-19. https://www.anthropic.com/engineering/building-effective-agents ——【A·已核验】workflow/agent 区分与五种模式原文出处。
2. Anthropic Engineering. *How we built our multi-agent research system*. 2025-06-13. https://www.anthropic.com/engineering/built-multi-agent-research-system ——【A，其中评测与用量数字为厂商自报（B）·已核验】90.2%、15×token、80% 方差、并行提速 90%。
3. Yan, W. (Cognition). *Don't Build Multi-Agents*. 2025-06-12. https://cognition.ai/blog/dont-build-multi-agents ——【A（一手工程观点文档）·已核验】上下文工程两原则。
4. Yan, W. (Cognition). *Multi-Agents: What's Actually Working*. 2026-04-22. https://cognition.com/blog/multi-agents-working ——【B（含 Devin Review 2 bug/PR、58% 等厂商自报数字）·已核验】"writes stay single-threaded / contribute intelligence rather than actions" 原文；内部文档所引 slug 为 multi-agents-working，页面实际标题带 "What's Actually"。
5. Anthropic (claude.com Blog). *Building multi-agent systems: When and how to use them*. 2026-01-23. https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them ——【一手产品博客，其中 3–10×、协调>干活 等为厂商自报（B）·已核验】三场景、context-centric、telephone game 实验。
6. Cemri, M., Pan, M.Z., Yang, S., et al. *Why Do Multi-Agent LLM Systems Fail?* arXiv:2503.13657（v3，2025-10-26 修订）. https://arxiv.org/abs/2503.13657 ——【C·预印本；NeurIPS 收录情况未查到（检索通道受限，不作断言）】核验方式说明：本机直连 arxiv.org 失败，经官方 GitHub 仓库（github.com/multi-agent-systems-failure-taxonomy/MAST，作者与 arXiv 号吻合）与 alphaXiv 镜像的摘要+正文概述交叉核验；v3 三大类百分比（44.2/32.3/23.5）与 14 个子模式百分比在镜像内部自洽。
7. MAST 官方仓库与 MAST-Data 数据集（HuggingFace `mcemri/MAD`）. https://github.com/multi-agent-systems-failure-taxonomy/MAST ——【C·已核验（GitHub API）】
8. 内部调研文档《一级公民的积累与演化》§2.2、§3.2、§八 ——【源自内部文档】本章的问题框架与其全部关键引用（含"单 agent 基线越强，多 agent 越可能亏"的提炼句）；其中外部引文均已按上述条目逐条核验。


---

# 第 6 章 · 反思的陷阱与可靠的自我进化

> **本章解决什么问题**：让 Agent 在每次任务后"总结经验教训"听起来天经地义，但实证数据表明：一旦反思被存进长期记忆并复用，它可能系统性地把错误固化下来。本章讲清三件事——经典反思方法到底做到哪一步、自我修正为什么常常失效、什么样的积累机制才是可靠的。
> **预计阅读时长**：30–35 分钟（不含动手实验）
> **前置知识**：第 1 章的 Agent 循环（特别是"观察→行动→再观察"里的反馈信号）；第 2 章的记忆分层（episodic / semantic / procedural）。

---

## 一、为什么这件事重要

几乎每个做 Agent 的人都写过这样的提示词："任务失败时，把教训写进记忆，下次别再犯。"直觉无可指摘：人类就是这么学习的。

但如果你真在生产环境里这么做了，过几周回去检查记忆库，大概率会看到第 1 章那种现场——情报 Agent 的记忆里躺着一条截断的垃圾（`的「少推」有哪些。"}]`），维护 Agent 的记忆库空空如也，而唯一一条真正的领域经验（"web_search 被导航页污染，改抓列表页"）是靠人写进提示词才存在的。

更隐蔽的问题不是"没写"，而是**写进去的东西是错的，而且错得很自信**。本章的核心证据来自一篇 2026 年的预印本（Honest Lying，arXiv:2605.29463，C 级证据，下文详述）：在 ALFWorld 的 16 个"卡死"环境里，Agent 一轮轮地写反思、一轮轮地依据反思行动，**121 条反思中没有一条提到正确的目标物体**。环境每天重置、任务从未改变，错的只是 Agent 对任务的解释——而解释一旦入库，就获得了跨任务的指挥权。

这就引出了本章的张力：**反思作为一次性的纠错手段是有效的，作为持久学习机制是危险的**。把这两件事混为一谈，是过去三年 Agent 文献被误读最多的地方。把"总结经验"从一句提示词变成一条有准入门槛的工程流水线——这是本章要交付的东西。

---

## 二、核心概念与框架

### 2.1 先拆掉一个含混的词：反思 ≠ 自我修正 ≠ 持久学习

把三件事摆到一张表上，很多误引会自动消失：

| | Self-Refine | Reflexion | 持久学习（本章讨论对象） |
|---|---|---|---|
| 改进发生在 | **单次生成内**：生成→自评→改写，循环几轮 | **同一任务的多次尝试之间** | **跨任务**，写入长期记忆 |
| 改了什么 | 这一份输出本身 | 后续尝试的提示词上下文 | 记忆库 / 技能库 / 提示词 / 工具 |
| 任务结束还留下什么 | 什么都没有 | **什么都没有**（缓冲随任务销毁） | 经验本身必须存活 |
| 代表编号 | arXiv:2303.17651 | arXiv:2303.11366 | ExpeL、Voyager、本文流水线 |

Self-Refine 的摘要把边界写得很清楚：同一个模型"作为生成器、精炼者和反馈提供者"迭代改进**初始输出**，"不需要监督训练数据、额外训练或强化学习"（[2]，摘要原文核验）。它没有"更新"这一步，改进随交付结束。

Reflexion 常被当成"语言化强化学习 = 会积累"的证据，但看它对记忆的原始定义：反思文本维持在**"an episodic memory buffer"**（情景记忆缓冲，[1] 摘要逐字核验）里，用于"subsequent trials"——同一个任务的后续尝试。它像考试时草稿纸上的演算复盘：对眼前这道题有效，交卷即弃。内部调研文档据此写"Reflexion 任务结束即丢弃，不是持久学习"；摘要能核验到的是 episodic buffer 与 subsequent trials 两处措辞，跨任务不持久是论文的机制设定（源自内部文档表述，本次未核到全文原句）。

**为什么这个区分值钱**：如果你的系统里反思真的跨越了任务边界（大多数生产系统都这么设计，因为第 1 章讲过——计划任务每次执行都是全新实例，唯一的连续性通路就是显式存下来再显式注入），那你就不是在跑 Reflexion，你是在做一个 Reflexion 论文**没有声称做过**的事。论文的 91% HumanEval pass@1（对比 GPT-4 基线 80%，摘要核验）是任务内反思的成绩单，不是持久学习的验收报告。

### 2.2 自我修正的前提：外部信号，而不是意志力

Huang et al.《Large Language Models Cannot Self-Correct Reasoning Yet》（arXiv:2310.01798，Google DeepMind 与 UIUC 团队，[3]）是这一领域的冷水碑。其核心概念"intrinsic self-correction"定义为：不借助外部反馈、仅凭模型自身能力修正初始回答。论文的结论（摘要逐字核验）：**在推理任务上，LLMs 没有外部反馈时无法自我修正，某些情况下修正后性能反而下降**。

把它翻译成设计语言：

- 自我修正有效的前提是存在一个**比模型可信的裁判**——单元测试、schema 校验器、编译器、能对错的规则引擎；
- Reflexion 恰是这个规律的注脚而非例外：它在 HumanEval 上的大幅提升靠的是测试通过与否这种二值客观信号（其摘要自述"verbally reflect on **task feedback signals**"）；
- 让模型"再想想、检查一遍"而没有裁判，等于让被告兼任法官。

一个常被忽略的推论：很多自我修正实验的"成功"，其实是"给定了正确答案来源之后的重答"。把裁判拿掉，方法就不成立。

### 2.3 记忆虚构（memory confabulation）与 RRR

Honest Lying 论文（[4]，作者 Prakhar Dixit、Sadia Kamal、Tim Oates，2026-05-31 提交，cs.LG 预印本）给反思入库的失效模式起了名字：**memory confabulation**——"agent 存储对任务的自信但错误的解释，并跨尝试持续依据它行动，即使环境每次都重置回正确任务"（摘要核验）。摘要还定义了一个配套指标：**Reflection Repetition Rate（RRR）**，一个基于日志的、度量"对错误反思内容的重复倚重"的指标。

论文的对照数字（全部经 abstract 逐字核验）：

- 16 个卡死的 ALFWorld 环境中，**0 / 121** 条反思提到正确目标物；HumanEval 上有 4 个类似案例；
- 把"开放式自我诊断"换成"**程序化提取轨迹级失败信号**"后，正确目标物被提及的比例从 **0% → 86%**，RRR 从 **0.64 → 0.10**，16 个卡死环境中解开了 **3** 个。

这里必须做一次精确化纠偏：内部调研文档把 0%→86% 记成了"正确率"，**原义是"正确目标被提及的比例"**—— mitigation 让 Agent 重新看见了对的目标，但离稳定解出任务还很远（3/16）。这个差别恰恰是本章的论点所在：程序化信号解决的是"不再被假解释蒙蔽"，不包治百病；但反过来，没有它，一切免谈。

为什么错误解释杀不死？演示脚本（实验 B）里看得最清楚：**失败本身不构成反证**。Agent 查不到数据→解释"今天没数据"→下一次还是查不到（因为窗口还是错的）→解释得到"验证"。错误的解释通过制造符合自己预期的证据而永生。环境重置、任务不变，唯一变化的——也是唯一携带错误的那部分——是记忆。

### 2.4 本章的判据：经验凭什么活着

给"一条经验能否进入长期记忆"定一个可操作标准，后文所有机制都围绕它展开：

> **可执行、可验证、可计数。**
> 可执行：经验最终落成参数、规则、工具描述或代码，而不是一段感想；
> 可验证：存在机械可判定的方式判断这条经验下次是帮忙还是帮凶；
> 可计数：置信度用引用次数×结果计数来表达，不用模型的自信语气来表达。

---

## 三、研究与工程演化线

### 3.1 2023：反思的黄金半年，和它的两篇"被误读"论文

Reflexion（NeurIPS 2023，经 Semantic Scholar 核验）与 Self-Refine（编号与摘要核验，会议收录记录本次未核到，通说 NeurIPS 2023）在 2023 年相继出现，两者共同塑造了"语言化反思 = 廉价强化学习"的叙事。叙事的一半是对的：**作为任务内、带外部信号的纠错循环，它们确实有效**（91%/80%、约 20% 绝对提升，均摘要核验）。另一半——"所以 Agent 能从经验中持续变聪明"——两篇论文都没有做过，也都没有声称。此后大量文章把这两篇引作"自我进化"的证据，属于典型的**引用漂移**：每转引一次，误读就固化一层。

### 3.2 2023 同期：真正的持久学习长什么样

同年出现的两个系统做了"反思入库"这件事，但给入库加了本章 §2.4 的判据：

**ExpeL**（arXiv:2308.10144，清华 LeapLab，AAAI 2024 Oral，官方仓库与 AAAI 论文集页核验，pp. 19632–19642，DOI 10.1609/aaai.v38i17.29936）的做法：用 Reflexion 式重试收集**成功与失败两类轨迹**进入经验池；再用一个指令模型对"同任务成败对 / 跨任务成功集"提炼 insight，但 insight 库是带**计数的民主**——对每条 insight 执行 ADD / EDIT / **UPVOTE / DOWNVOTE** 操作调整重要度分数，**得分为零的 insight 被移除**（操作集合经论文页 AI 概述核验，与官方代码一致）。没有任何一条经验靠"模型说它很重要"而存活；一条经验活下来的唯一理由，是被后续证据一次次投了赞成票。这正是把置信度从"自信语气"改写成"可数信号"。

**Voyager**（arXiv:2305.**16291**——注意：内部文档与常见误记写作 2305.16414，那个编号是一篇 H I 天文学论文，本书经官方 GitHub 仓库与 alphaXiv 双重核验纠正此编号）的"经验"根本不是自然语言，而是**一个不断增长的可执行代码技能库**；其迭代提示机制显式使用"环境反馈、执行错误与自我验证"（摘要核验）。技能入库的标准只有一条：**跑得过**。代码是比反思文本诚实一万倍的经验载体——它不会用自信的措辞掩盖错误，它要么运行成功要么抛异常。

两个系统指向同一个结论：**持久的经验要么可验证地可执行（Voyager），要么被计数投票驯化（ExpeL）**。纯粹的"感想入库"两者都不占，恰好落在危险区。

### 3.3 2024：冷水碑

Huang et al. 的论文（§2.2）把"无外部信号的自我修正"从默认假设降格为需要证据支持的例外。这一节的影响是回溯性的：回看 §3.1 的误读，问题不在反思本身，而在**默认把"生成反馈的模型"同时当作"验证反馈的裁判"**。Huang 之后，严肃的 agent 系统在设计自我改进闭环时，裁判都必须来自模型之外——测试、校验器、规则引擎，或者人。

### 3.4 2025–2026：工程共识成型

Anthropic 的工程师在《Writing effective tools for agents — with agents》（2025-09-11，[8]）里把"进化"放到了一个非常具体的位置：让 Claude 反复拿坏工具做任务、分析失败、**重写工具自己的描述**——改进的对象是工具规格这个文本工件，循环的骨架是"先建评测、再对着评测优化"（文中"Building an evaluation...optimize your tools against this evaluation"，原文核验；内部文档转述的"任务完成时间 −40%"在本次抓取段落未见，**源自内部文档·未核验**，不采信为事实）。

《Demystifying evals for AI agents》（2026-01-09，[7]）把前置条件说透了，引原文：

> "Good evaluations help teams ship AI agents more confidently. Without them, it's easy to get stuck in reactive loops—catching issues only in production, where fixing one failure creates others."

**没有机械可判定的评测，"进化"只是"随机扰动 + 事后解释"**。你无法区分"这次改动变好了"和"这次运气好"，于是记忆库里攒下的不是经验，是幸存者偏差。

Honest Lying（2026-05，[4]）补上最后一块拼图：即便你做了记忆库、做了反思复用，只要入库的仍是"自由发挥的自然语言解释"，上面 0/121 的剧本就会在你机器上重演；而 mitigation 也已经在论文层面给出——程序化提取轨迹级失败信号。

### 3.5 工程版路径与三条设计守则

把 §3.2–3.4 压缩成一条可以直接抄进架构文档的流水线：

```
失败日志 ──► 错误分类学（人/代码定义类目）──► 纠正物生成 ──► 回归测试 ──► 通过才入库
                    │                              │
                    └── 监控：RRR 风格指标 ◄───────┘
```

1. **分类学由人定义，不由模型自由发挥。**类目的定义、边界和名字是工程师写死的常量（见实验 A 的 `TAXONOMY`）。让模型自己归纳"错误有哪几类"，等于允许它每轮重新发明分类——统计意义消失，毒记忆获得了自由叙事空间。
2. **纠正物是规则、few-shot 或工具描述，不是感想。**每条纠正物固定三件套：一个真实错误例（带 run_id 指针）、一个同任务族正例、一条祈使句规则。内部调研文档给的量级是 3–5 条 few-shot 就够，不必上提示词自动优化（后者有数据量门槛，参见第 3 章 MAGE 与 DSPy ≥200 条的告诫）。
3. **回归测试是准入门，也是防复发机制。**改完必须重跑同一批失败任务：目标类目下降、其他类目不新增上升，才允许入库；原始轨迹无损保留，纠正卡只存结论与证据指针。

对应的三条设计守则（可以直接贴进团队的 memory schema 评审清单）：

- **守则一（门）**：反思可以随意生成候选，但写入长期记忆必须过**程序化验证或人工确认**。自由反思的产物默认是临时草稿，谁主张入库谁出证据。
- **守则二（指针）**：写入的经验必须带**证据指针**——源自哪些 run/trace/测试编号。不能指回证据的经验，就是都市传说。
- **守则三（底片）**：原始轨迹无损保留。台账、insight、反思都是派生视图，随时可以从底片重做；底片不可为了"整理"而删。内部文档引用的巩固实验数字（递归摘要 35.3% vs 全上下文 98.0%）**源自内部文档·未独立核验**，但方向与 §六实验里"截断垃圾入库"的现场一致：加工必然有损，所以底片必须留在。

### 3.6 RRR 类监控：怎么发现 Agent 在反复依赖一条错误经验

论文给了 RRR 的名字和思想（对错误反思内容的重复倚重，基于日志），但没有替你定义生产指标。一个可直接落地的**联合监控**（这是本书的工程化外推，非论文原文）：

> 对每条记忆/规则 m：**RRR 分数 = 被引用次数(m) × 引用期间关联任务失败率(m)**
> 判定示例阈值：被引 ≥4 次且失败率 ≥60% 且分数 ≥4 → 标为疑似毒记忆，自动下线并转人工复核。

单看引用次数会误杀高频好经验，单看失败率会被小样本噪声骗走，两个乘起来再配下限，噪声和经验同时被压住。实验 A 的输出就是这张表。配套的告警语义是"**同一条记忆：被倚重在涨 ∧ 关联失败率在涨**"——这个组合模式比任何单指标都更早地暴露 memory confabulation。

---

## 四、关键实证数据

| 结论 | 数字 | 出处 | 证据等级 | 注意事项 |
|---|---|---|---|---|
| 任务内反思 + 客观反馈可大幅提升 | HumanEval pass@1 91% vs GPT-4 基线 80% | Reflexion, arXiv:2303.11366（NeurIPS 2023） | A（摘要+收录核验） | 反思存活于单任务内，勿外推为持久学习 |
| 自我迭代精炼的单任务收益 | 平均约 +20% 绝对值 | Self-Refine, arXiv:2303.17651 | C（摘要核验；收录未核到） | 无跨任务更新、无外部裁判时收益来自任务本身可验证度 |
| 无外部信号的自我修正常失效甚至变差 | "performance even degrades after self-correction"（定性） | Huang et al., arXiv:2310.01798 | C（摘要核验；通说 ICLR 2024，收录记录本次未核到） | 本章理论支点；"变差"幅度依任务而异，无统一数字 |
| 反思入库会固化自信的错误解释 | 16 个卡死环境，121 条反思 **0** 条提及正确目标物 | Honest Lying, arXiv:2605.29463 | **C（预印本，摘要逐字核验）** | ALFWorld 单一环境系；未同行评审，勿当定论 |
| 程序化失败信号替代自由反思 | 正确目标提及 0%→86%；RRR 0.64→0.10；解开 3/16 | 同上 | C | **0→86% 是"提及率"不是"正确率"**；内部文档旧表述需按此修正 |
| 经验池靠投票而非自信存活 | ADD/EDIT/UPVOTE/DOWNVOTE，0 分移除 | ExpeL, arXiv:2308.10144, AAAI 2024 Oral（DOI 10.1609/aaai.v38i17.29936） | A（官方论文集核验） | 论文未给"民主 vs 自信"的头对头消融 |
| 经验可以=可执行代码，跑得通才算学会 | 技能库持续增长 + 执行反馈迭代（定性） | Voyager, arXiv:2305.**16291** | C（官方仓库+摘要核验；TMLR 收录之说未核） | **编号 2305.16414 是错的**（天文学论文），注意传播链 |
| 进化必须先有机械评测 | "Without them...reactive loops"（定性） | Anthropic《Demystifying evals for AI agents》2026-01-09 | A（大厂一手工程文档） | 厂商经验陈述，非受控实验 |
| 让模型对着评测重写工具描述是划算的进化 | −40% 完成时间（**源自内部文档·未核验，不采信**） | Anthropic《Writing effective tools for agents — with agents》2025-09-11 | A（文章本身）；数字未核到 | 可核验的是方法与流程，具体幅度引用前需回原文确认 |

---

## 五、反模式与常见误解

**反模式 1：把 Self-Refine / Reflexion 当"自我进化"的证据。**识别特征：方案 PPT 里引用 Reflexion 论文来论证"Agent 会越用越聪明"。它们证明的是"带反馈的任务内重试有效"。验证方法：翻两篇论文的记忆定义——一个没有记忆，一个随任务销毁。

**反模式 2：让模型自由反思后直接入库。**识别特征：提示词写着"把教训总结到记忆里"，没有任何入库门。这就是 0/121 剧本的开机键。特别危险的是**空结果场景**（见实验 B）：失败不反证解释，解释自证清白。

**反模式 3：没有评测就上自动优化。**识别特征：有"自动从失败中学习"的闭环，但没有能机械判对错的回归集。此时每次"学习"的效果都无法与噪声区分，长期效果只能靠用户投诉来感知——即 Anthropic 说的 reactive loops。配套门槛：攒不出 ≥200 条机械可判定的运行记录之前，别开提示词自动优化（量级出处与论证见第 3 章，源自内部文档转述 DSPy 官方建议）。

**反模式 4：让模型自己定义错误分类。**每轮自由归纳类目，等于让统计口径随模型心情漂移；分类学的第一属性是**可比性**，可比性来自人写死的定义。

**反模式 5：为"整洁"删除原始轨迹。**只留 insight 不留 trace，等于烧掉底片留一张过曝的照片：既无法复核每条经验的证据指针，也无法重跑巩固过程。守则三专防此项。

---

## 六、动手实践

目录：`hands-on/ch06/`，纯标准库，完全离线。

| 文件 | 作用 |
|---|---|
| `failure_taxonomy.py` | 实验 A：失败分类学 + RRR 排名 + 纠正卡生成 |
| `runs_sample.json` | 60 条内置运行记录（38 失败）+ 5 条记忆，**其中埋了一条由失败反思自动写入的毒记忆 mem_017** |
| `poisoned_reflection_demo.py` | 实验 B：错误解释被存入并复用 6 个任务的时间线，对照程序化失败信号版本 |
| `correction_cards.md` | 实验 A 运行后生成的纠正卡（候选、未验证） |

运行（Python ≥3.10）：

```bash
cd hands-on/ch06
python failure_taxonomy.py        # 同时写出 correction_cards.md
python poisoned_reflection_demo.py
```

**实验 A 你会观察到**（数字由内置数据确定性产出）：

1. 分类学报告里三个头部类目——空结果被静默接受 9 次、分页截断 8 次、时间窗误读 7 次——合计占失败的 63%，而且**三类都关联同一批记忆引用**；
2. RRR 排名里 `mem_017` 以 **12 次引用、11 次失败、失败率 92%、综合分 11.0** 高居第一，被自动标记下线。它的原文是："工单接口返回空列表说明当天没有新数据，直接按 0 条上报即可，不必翻页，也不必调整时间窗。"——由 r005 一次分页失败换来的自信解释，此后在三个不同错误类目里反复出现；
3. 对照组同样清楚：`mem_003`（"导出前先拉 1 条样本核对"，人写的）13 次引用、失败率 8%，高分高频但健康——单看引用次数会冤枉它，联合指标才分得清；
4. 唯一"侥幸成功"的记录 `r050` 值得多看一眼：错误记忆偶尔也能撞上对的结果（那次 total 真是 0），这正是"失败率"必须算进指标的原因。

**实验 B 你会观察到**：同一个错误（查询窗早于数据源每日更新时间），A 线反思入库后连续 6 个任务全灭且每次失败都"验证"了那条解释（RRR 计数器走到 6）；B 线没有任何自然语言解释入库，存活的只是一条代码生成的窗口对齐信号，第 2 个任务起全部通过。两条线里"模型"都同样笨——**变的不是模型，是入库物的形态**：感想 vs 可执行信号。

**建议延伸**：把 `correction_cards.md` 的规则注入你手上的真实 Agent，回归重跑一周，统计目标类目失败数变化——这就是守则一的门的最小可用版。

---

## 七、本章小结

1. **反思默认是任务内行为。**Reflexion 与 Self-Refine 都不产生持久学习；把它们当"自我进化"证据是引用漂移。
2. **没有外部信号的自我修正常常越修越差**（Huang et al.）。先回答"谁是裁判"，再谈改进闭环。
3. **入库的自由反思会把自信的错误固化**：121 条反思 0 条命中正确目标（预印本，C 级，方向性证据而非定论）。失败若不反证解释，解释就永生。
4. **引用"0%→86%"时请写全称**：它是"正确目标提及率"，且对应 mitigation 后也只解开 3/16 个环境。数字被转述时最容易死掉的半句话。
5. **可靠经验有两种形态**：可执行可验证的代码（Voyager），或被 ADD/UPVOTE/DOWNVOTE 计数驯化的 insight（ExpeL）。置信度要数出来，不要"说"出来。
6. **工程版进化路径**：人定义错误分类学 → 3–5 条纠正卡（错误例+正例+规则，带证据指针）→ 回归测试准入。在此之前，别开自动优化。
7. **评测先行不是口号是准入门**：攒不出机械可判定的回归集，就没有"进化"，只有噪声采样。
8. **监控用联合指标**：单条记忆的"被倚重次数 × 关联失败率"。毒记忆的信号不是"被引用多"，而是"被引用多且引用的地方在失败"。原始轨迹永远无损保留。

---

## 八、参考文献

（编号按首次出现；核验方式：web_fetch / web_search，2026-09-16）

1. Shinn, N. et al. *Reflexion: Language Agents with Verbal Reinforcement Learning.* https://arxiv.org/abs/2303.11366 —— **A 级**（NeurIPS 2023，经 Semantic Scholar 核验）。摘要与 91%/80% 数字经 alphaXiv 镜像逐字核验。
2. Madaan, A. et al. *Self-Refine: Iterative Refinement with Self-Feedback.* https://arxiv.org/abs/2303.17651 —— **C 级**。摘要（含 ~20% 绝对提升）经 alphaXiv 核验；通说 NeurIPS 2023 收录，本次**未核到**收录记录。
3. Huang, J. et al. *Large Language Models Cannot Self-Correct Reasoning Yet.* https://arxiv.org/abs/2310.01798 —— **C 级**（预印本；通说 ICLR 2024，本次**未核到**收录记录）。标题、作者（DeepMind/UIUC）与"intrinsic self-correction"结论经 alphaXiv 摘要核验。
4. Dixit, P., Kamal, S., Oates, T. *Honest Lying: Understanding Memory Confabulation in Reflexive Agents.* https://arxiv.org/abs/2605.29463 —— **C 级**（2026-05-31 提交，cs.LG 预印本，未同行评审；内部文档所称 "ICML 2026 Workshop" 本次**未核到**）。全部数字（16 环境、0/121、0%→86% 提及率、RRR 0.64→0.10、3/16）经 alphaXiv 页面 abstract 逐字核验。
5. Zhao, A. et al. *ExpeL: LLM Agents Are Experiential Learners.* https://arxiv.org/abs/2308.10144 ；AAAI 2024 论文集：https://ojs.aaai.org/index.php/AAAI/article/view/29936 （DOI 10.1609/aaai.v38i17.29936，pp. 19632–19642）—— **A 级**（官方仓库与论文集信息核验；ADD/UPVOTE/DOWNVOTE/EDIT 与 0 分移除经论文页概述核验，未读全文 PDF）。
6. Wang, G. et al. *Voyager: An Open-Ended Embodied Agent with Large Language Models.* https://arxiv.org/abs/2305.16291 —— **C 级**（预印本；部分场合称 TMLR，本次未核）。编号经官方仓库（MineDojo/Voyager README）与 alphaXiv 双源核验；**2305.16414 为错误编号**（对应一篇 H I 天文学论文）。
7. Anthropic. *Demystifying evals for AI agents.* https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents （2026-01-09）—— **A 级**（大厂一手工程文档，URL 与引文核验）。
8. Anthropic. *Writing effective tools for agents — with agents.* https://www.anthropic.com/engineering/writing-tools-for-agents （2025-09-11）—— **A 级**（URL 与"评测→优化"方法核验；内部文档转述的 −40% 完成时间**未在本次抓取段落核到**）。
9. 内部调研文档《12 · 一级公民的积累与演化》（2026-09-16）—— **C 级**（内部资料）：工程方案、MAGE/DSPy 门槛与 DMR 35.3%/98.0% 等数字以本书第 2、3 章标注为准，本章引用处均已就地标"源自内部文档·未核验"。


---

# 第 7 章 · 领域工程的现成答案：去重、规则、来源与治理

> 本章解决一个问题：当你的 Agent 要做的不是"聊天"，而是"信息聚合 + 规则执行 + 长期维护"时，答案早就被跑了多年的生产系统写好了，你不需要重新发明。四类模式：事件级去重、用户偏好规则、来源质量评估、维护与治理。
> 预计阅读时长：约 35 分钟 · 前置知识：第 2 章（记忆架构）、第 4 章（工具设计）。不需要任何论文背景——本章的结论全部来自生产系统，不是学术 SOTA。

**关于证据等级的说明**（本章比前几章更依赖工程现场，先把标尺交代清楚）：

- **A** = 同行评审论文，或一手工程文档／官方文档；
- **B** = 厂商、项目自报（包括"我们线上跑的是这个值"）；
- **C** = 预印本或未核验转述。

本章绝大多数参数是 **B 级**。B 级不是贬义：阈值 0.7、时间窗 18 小时这类数字是**线上存活值**——它的意思是"这个数在真实用户手里没被骂死"，而不是"这个数在数据集上最优"。存活值对工程师比 SOTA 有用，但迁移时必须重标（§2.1 会让你亲眼看到为什么）。

另外要诚实交代一件事：**本章写作时联网核验工具不可用**（网页抓取被网关重写、检索服务退化为词典返回）。因此除本教程自己实验产生的可复现数字（标 A·自测）外，外部来源一律按"未在本次会话在线复核"标注；内部调研文档给出的原始出处已尽量列出，请在能联网时按 §八 逐条复核后再对外引用。

---

## 一、为什么这件事重要

几乎每个做信息聚合 Agent 的人，都会在某个下午自己发明一遍去重。

需求长得很普通：订阅 180 个信息源，把同一件事的多篇稿子合成一条，别让用户的 feed 里出现五条"某公司发布某模型"。于是你写了一个函数：标题转小写、算 embedding、余弦相似度超过某个阈值就合并。阈值定多少？0.9 看着挺严。跑三天，用户来问："我关注的三件不同的事怎么变成一条了？"你把阈值调到 0.98，第二天 feed 里同一篇稿子出现四次。

这不是算法问题，是**数据模型问题**：你的系统里只有"文章"这一层，而这件事需要三层。

三个互不相干、目标完全不同的系统，各自独立收敛到了同一个结构：

- **GDELT**（全球事件数据库，学术／公益项目，跑了近二十年）：给每个事件一个 `GlobalEventID`，稿件通过事件号挂上去[1]；
- **Event Registry**（商业新闻聚合 API，服务大量企业客户）：`storyUri`／`articleUri`（稿件层）+ `eventUri`（事件层）+ `isDuplicate`（重复标记）[2]；
- **NewsBlur**（开源 RSS 阅读器，单人维护的付费服务，公开披露过约 $100/月、180+ 源的运行配置）：文章 → 故事组（story group）[3][4]。

字段名不同，结构一模一样：**原始记录层 / 事件层 / 线索层**。而它们共享的最重要那条设计原则，恰好是最容易被忽略的：

> **去重的产出是"一个事件带着 N 个来源"，不是"删掉 N−1 篇"。**

本章只讲这种活下来的模式。四条，全部有生产系统背书，可以直接抄：

| 模式 | 一句话 | 抄谁 |
|---|---|---|
| 事件级去重三层模型 | 合并的不是文章，是事件；事件挂着所有来源 | GDELT / Event Registry / NewsBlur |
| 偏好规则四件套 | 规则必须能预览命中集，否则用户在盲选 | NewsBlur 个性化规则 |
| 来源质量外包 | 别自建媒体可信度评分，聚合外部评分取平均 | Ground News / AllSides / Ad Fontes / MBFC |
| 维护三级流程 + 写操作四不变式 | 先标记、再合并、可恢复；写操作先出计划 | MediaWiki / BCA / Terraform / ArgoCD |

---

## 二、四大模式逐个展开

### 2.1 事件级去重：三层数据模型

#### 为什么必须有三层

| 层 | 解决什么 | 典型判据 | 生产系统里的标识符 | 自己发明时最常犯的错 |
|---|---|---|---|---|
| **L1 文档层**（story / article） | 同一篇稿被转载、被 CMS 改写 URL、被加了推广后缀 | URL 归一化、正文指纹（SimHash／MinHash）、标题归一化后全等 | Event Registry `storyUri`/`articleUri`；NewsBlur 的 story | 把 L1 当全部：只做 URL 去重，转载一来就重复 |
| **L2 事件层**（event） | 不同记者写同一件事，措辞完全不同 | 语义／词面相似 + **时间窗** + 实体一致 | GDELT `GlobalEventID`；Event Registry `eventUri` + `isDuplicate` | 没有事件这个实体：合并结果只存在于一次批处理的返回值里，第二天无法追加 |
| **L3 线索层**（topic / timeline） | 多天多事件串成一条线（"降准"→"央行答记者问"→"LPR 下调"） | 实体／主题相似度 + 时间衰减，**不能**用同一条相似度阈值 | 各系统叫法不同（topic、timeline、cluster chain） | 把 L3 和 L2 用一套阈值：要么把一周的事糊成一团，要么永远串不起来 |

三层的关键差别是**时间尺度**：L1 是毫秒级字面判同，L2 是小时到天级（所以有存活窗口），L3 是天到周级。用同一套相似度、同一个阈值跨层使用，是自建去重塌掉的第一大原因。

#### 事件层必须是"实体"，不是"分组结果"

`GlobalEventID` 和 `eventUri` 都是**可指认的 ID**：它有自己的记录，可以被后续文章追加、可以被查询、可以在页面上作为一条新闻的链接。如果"事件"只是聚类函数返回的一个数组，你就无法回答"这条新闻的另外三个来源是谁"，也无法在三天后把新稿追加进去。这一条对 Agent 的直接含义见 §六。

#### NewsBlur 的线上参数（B 级：线上存活值）

NewsBlur 公开写过它做故事匹配的参数与做法[3]（本次未能在联网状态下复核原话，以下按内部调研文档记录，标注为待复核）：

| 参数 | 值 | 为什么是这个数 |
|---|---|---|
| 相似度阈值 | **0.7** | 再低会误并（把两件事写成一条），再高 feed 里全是重复 |
| 文章与事件的时间差 | **≤ 18 小时** | 超过半天，新稿多半是"后续报道／评论"，属于另一件事 |
| 事件存活窗口 | **≤ 36 小时** | 之后不再接受新成员，避免事件无限膨胀 |
| 事件向量 | **只对最近 3 篇滑动平均** | 早期稿件的字面噪声不该永远投票 |
| 聚类策略 | **两遍**：先尝试吸收进已有事件（吃掉约 70–80% 流量），剩余部分两两建边取连通分量作为新事件 | 增量场景下 90% 的稿件属于已有事件，全量重聚类成本不可接受 |

两遍聚类这个结构值得单独说：它把**增量匹配**（便宜、覆盖大多数）和**批量建簇**（贵、只处理少数）分开。稳态下第一遍吸收掉 70–80% 的稿件，意味着第二遍只在小集合上跑 O(n²) 的两两比较——这就是 $100/月 的预算能扛住 180+ 个源的原因，而不是因为算法多聪明。

#### 已知失效边界：宁可漏并

NewsBlur 记录过的失败案例是**强本地语境新闻**：一件在通稿里叫"11 号线开通"的事，在本地号里叫"出小区步行 8 分钟到地铁站"——字面重合极低，向量也拉不近。作者的选择是**宁可漏并，也不降阈值换误并**[3]。

这个选择背后是一个通用的成本不对称判断，值得抄进你的设计文档：

- **漏并**（该合的没合）→ 用户看到两条重复。烦，但信息完整。
- **误并**（不该合的合了）→ 用户**丢了一条新闻**，而且两条新闻的来源、时间、措辞被混在一个簇里，事后无法追溯哪条是哪条。

漏并是体验问题，误并是数据事故。所以阈值永远偏向漏并。

#### 跨语言陷阱：MinHash + LSH 只适用同语言

这是本章最硬的一条原理性结论，而且是**可以自己复现**的（实验 A 里有对照表）：

MinHash + LSH 的工作原理是把文本表示成 **n-gram 集合**，用 MinHash 签名近似估计两个集合的 Jaccard 相似度，再用 LSH 分桶做候选召回。字符 n-gram 在**同语言**内工作得很好，但跨语言时两个集合**几乎不相交**：

- "央行降准" 的字符 3-gram 是 `央行降`、`行降准`；
- "central bank cuts RRR" 的 3-gram 是 `cen`、`ent`、`ntr`……

两个集合交集为空，Jaccard 恒等于 0，无论阈值怎么调都不会合并。这不是参数问题，是表示问题。要做跨语言事件对齐，只有三条路：① 先翻译成同一语言再去重；② 换**跨语言表示**（多语言 embedding、跨语言主题模型）；③ 走**实体锚定**（同一事件里的时间、地点、金额、机构这些结构化字段一致）。GDELT 走的是第 ③ 条（事件抽取到 CAMEO 编码 + 地理时间），这条路最贵也最稳。

**顺带把阈值可移植性这件事说透。** 实验 A 在本机实测（A 级·自测，45 条模拟标题，阈值统一 0.7）：

| 相似度表示 | 产生的事件数 | 合并的对数 | 应合并对的召回 |
|---|---|---|---|
| 词级重合系数（本实验默认） | 29 | 28 | 0.61 |
| 字符 3-gram **Jaccard** | 43 | 2 | 0.04 |
| 字符 3-gram **重合系数** | 40 | 6 | 0.13 |

同一批数据、同一个 0.7，三种表示给出 29 / 43 / 40 个事件。**0.7 是 NewsBlur 在它自己的英文表示（词干化 + 它自己的向量空间）上的存活值，不是一个可以复制粘贴的常数。** 换语言、换 n、换 Jaccard 还是重合系数，阈值必须重新标定。这是本章最容易踩的坑，也是实验 A 存在的理由。

### 2.2 用户偏好规则的四件套

信息聚合 Agent 迟早要接受用户指令："AI 的推送给我留着，科技区的其它先静音。"绝大多数实现做到"能解析成一条规则并存下来"就结束了——那正是半成品。

NewsBlur 的个性化教训（内部文档记录的原文思想，未在线复核原话[4]）：

> 用户过去是在**盲选**：只能训练完之后看整体 feed 的分数变化，去猜刚加的那条规则到底生效没有。这是规则被训歪的唯一来源。

这句话值得逐字拆开看。假设你有 6 条规则，用户新加一条，然后看 feed 变好还是变坏：

- 反馈信号是**十几条规则叠加后的整体输出**，一次只能改一条，改完还看不出因果；
- 更糟的是**遮蔽**：一条宽规则（"科技类静音"，2026 年 7 月建的）会把后来那条精确规则（"这几个 AI 源要推"，8 月建的）吞掉。用户看到的结果是"我加了规则没反应"，于是又加一条更狠的，规则库越训越极端。

四件套就是为了让反馈信号和规则之间出现**可归因的通路**：

**① 规则对象化。** 规则是可校验的结构化对象，不是拼进 prompt 的一句话。最小 schema：`{id, field, op, value, action, priority, log}`。校验必须在入库时做：字段不存在、操作符拼错、`gt` 的 value 给了字符串——**要当场拒绝，不能静默降级成"永远不命中"**。静默降级是最坏的失效形态：用户以为规则生效了，其实从没生效（实验 B 的 `demo-invalid` 专门演示这一点）。

**② 落库前预览命中集。** 保存规则之前，先回答："这条规则会命中最近 N 条里的哪几条？"这一步是纯计算，零副作用。有了它，遮蔽（命中 5 条、生效 0 次）和平局（两条规则同优先级判相反动作）都变成**能看见的东西**，而不是要靠用户体验去猜。

**③ 显式冲突优先级链。** 优先级必须是显式全序（数字越小越优先），冲突时按链裁决；**同优先级且动作相反时不要自动裁决**——落兜底动作并显式上报"这条需要人看一眼"。用创建时间或插入顺序当隐式优先级，就是盲选模式（实验 B 的 `blind` 子命令实测：同一份规则，按插入顺序首条命中即生效，与按优先级裁决相比 30 条里有 6 条决策不同，且差异完全不可见）。

**④ 规则日志。** 每次执行追加一条不可改的记录：命中了什么、由哪条规则决定、裁决轨迹是什么。它同时承担三件事：向用户解释"这条为什么没推"、事后复盘是哪条规则造成的、以及（§2.4）作为"执行的是被审过的那一份"的凭据。

> **只做①是最常见的半成品。** 把规则从 prompt 里搬进 JSON，然后依然没有预览、没有优先级、没有日志——用户依然在盲选，只是盲选的东西变成了结构化数据。

### 2.3 来源质量评估：别自建评分

想给"来源"打个可信度分的团队，通常会先花两周设计一套自己的评分表（是否署名、是否有更正政策、标题是否党……），然后发现两个问题：这套分和别人的分对不上，用户不信；以及这套分需要持续人工维护，做不动。

**Ground News 的做法值得抄，因为它的核心决定是"不自建"**[5]：把外部现成的媒体评分**聚合起来取平均**——AllSides（偏倚）、Ad Fontes Media（偏倚 + 可信度）、Media Bias Fact Check（偏倚 + 可信度 + 事实报告）——自己只维护**一件**真正有增量的东西：**媒体归属名单**，即"哪家媒体属于哪家集团、哪个站是哪家媒体的转载马甲"（内部文档记录该名单规模为 2,276 家；未在线复核[5]）。

这个分工的边界画得很准：

| 该外包的 | 该自建的 |
|---|---|
| 媒体级偏倚／可信度评分（人工评审劳动，别家已经做了十几年） | **归属关系**：马甲站、转载矩阵、内容农场与真媒体的对应关系（别人没有你这份上下文） |
| 评分的更新、申诉、复审流程 | **阈值与用法**：在你的场景里降到多少分才屏蔽 |

**两条硬约束**，比评分本身重要得多：

**硬约束一：评分是按出版物整体给的，只能用于降权，不能证明"这篇可信"。**
AllSides／Ad Fontes／MBFC 打的对象是**媒体**，不是**稿子**。一家整体优秀的媒体会发错稿，一家整体差的媒体偶尔也有一篇准确稿。把出版物级评分当成"这一篇可信"的证据，是**把先验当后验**。工程上正确的用法只有一个方向：分数低 → 降权、加提示、要求第二来源；分数高 → 不加分，或者最多免掉一次人工复核。任何"来源分高 → 直接进 feed 不打标"的设计，都是在给评分体系加它扛不起的责任。

**硬约束二：别让 LLM 当可信度评审。**
两条理由，都来自公开研究（本次未能在线复核，见 §八）：LLM 给出的媒体可信度打分与人类专家评分的相关性只有 **ρ ≈ 0.50**（C 级，未核验[6]）——也就是说一半以上的排序信息是噪声；以及**给 LLM 指派党派角色会让它的判断系统性偏斜**（C 级，未核验[6]）：你让它"扮演中立评判者"，它并不会变中立，只会把训练语料里对该媒体的刻板印象变成一个更像样的分数。

正确的用法是把 LLM 放在**它擅长的位置**：抽取（这篇文章引用了哪个原始来源？这是原创稿还是转载？）、归一化（这个站点属于哪家媒体？）、生成解释文案。**不要让它当裁判。**

**两家评分机构各自在做什么**（概括，措辞未在线复核[7][8]）：

- **NewsGuard**：九条编辑准则打**是／否**勾选（大意：不反复发布虚假标题、重要更正会显著标注、为内容署名、区分新闻与观点、不做误导性标题、忠实呈现事实、不鼓吹阴谋论、标注广告与赞助内容、达到基本网站标准），累计得分折成 0–100 的信用分，由专业新闻评审员执行。它的特点是**准则公开 + 逐条可解释**，缺点是覆盖以英语媒体为主。
- **MBFC（Media Bias/Fact Check）**：偏倚分五档（最左／左／中／右／最右）+ 可信度评级 + 事实报告率，人工评审、公开标准、允许被评媒体申诉。它是 Ground News 的输入之一，也是自建名单时最常引用的来源。

**一个必须纠正的过时引用**：还在写"用 Wikipedia 的 ORES 做质量评分"的教程已经过期了。Wikimedia 的机器评分服务层已被 **Lift Wing** 取代（wikimedia 工程博客，B 级，本次未复核[9]）。这条不只是版本号问题：**评分模型会换、会下线、会改口径**，所以你的系统里应该存"评分来源 + 评分时间 + 评分版本"，而不是只存一个分数——否则半年后你无法解释为什么某条新闻被降权。

### 2.4 维护／治理类 Agent 的成熟模式

另一大类领域 Agent 长得不像"聊天"，但工作量最大：知识库清理、笔记库整理、配置治理、依赖升级、过期内容归档。它们的共同点是——**它有写权限，而写错了不可逆**。

#### 内容维护的三级流程

三个跑了多年的内容系统（MediaWiki 生态、Obsidian 插件生态）独立收敛到同一套分级，值得整块抄走：

**级别 1：只加标记，不改内容。**
MediaWiki 的**数据库报告**类工具（孤儿页、死链页、短页面、缺分类页面）设计上**从不自动修改页面**，它只产出一份清单，改动由人来做[10]。这不是能力限制，是刻意的：发现问题和被允许改问题是两个权限，中间要有一个人（或一道明确的规则）。

**级别 2：攒够证据再合并／归档。**
Better Content Archiving（BCA）这类 MediaWiki 扩展的做法是：归档建议**先观察**（访问统计、长期无人维护、被引用情况），进入"待归档"列表攒证据，达到条件才提请处理[11]。对应到 Agent：一次判定"这条记忆／这篇文档过期了"不该立刻动手，要等重复证据（第二次被标记、或者被检索命中且用户跳过）。

**级别 3：可恢复窗口 + 清除前预告。**
BCA 提供恢复区（归档后一段时间可一键恢复）[11]；Obsidian 生态的 **Note Composer** 在合并笔记前做快照兜底，**Obsidian Janitor** 之类的清理插件把删除做成进回收站而不是物理删除[12]。

> **合并的技术门槛，是入链引用。** Obsidian 里合并两篇笔记，必须**改写所有指向被合并笔记的反链**，否则全库留下断链——Note Composer 最重的工作量就在这里[12]。自研 Agent 十有八九只做"内容合并 + 删掉旧文件"，一周后用户的库里有几十个死链接。记忆库、代码库的合并同理：合并一个抽屉，要改写所有引用它的索引／条目／prompt 片段。

**两个交互细节**（生产系统用血换来的，论文里不会写）：

- **跳过不丢。** 用户对某条维护建议点"跳过"，它必须**留在队列里**下次再来，而不是变成永久忽略。永久忽略是维护 Agent 最阴的 bug：三个月后用户发现某些脏东西"永远不再提醒"，只能自己全库重扫。
- **冷却期。** 同一类提示在 N 天内不重复出现（Obsidian／MediaWiki 生态里常见的默认值是 7 天量级；具体数值未在线复核[12]）。原因：**提示疲劳的后果是用户把整体静音**——那比完全不提醒更糟，因为你连"用户还关心里什么"这个信号都没了。

#### 建议 → 确认 → 执行：四条不变式

凡是有写权限的 Agent（改基础设施、改配置、改依赖、改库），行为协议可以直接从四套成熟工具里抄。**四条不变式**是从 Terraform `plan`/`apply`、CloudFormation change set、ArgoCD 的 diff/sync、Dependabot 的 PR 流收敛出来的共同点[13]–[16]：

| # | 不变式 | 各系统里的对应实现 | 违反之后的现场 |
|---|---|---|---|
| ① | **预览零副作用** | `terraform plan` 不创建任何资源；change set 只生成不执行；ArgoCD 的 diff 是只读比对 | "预览"时顺手调了一次写接口 → 预览本身成了事故源 |
| ② | **确认后执行的就是被审过的那一份** | `terraform apply plan.out` 执行计划文件；change set 有 id 并被显式执行；ArgoCD Sync 指定 revision | 用户点"确认"后系统**重新生成**一遍计划 → 审过的和执行的不是同一件事 |
| ③ | **结果写回同一条记录** | apply 结果回写 state／change set 状态 `CREATE_COMPLETE → EXECUTE_COMPLETE`；Dependabot 的更新结果回写到同一个 PR | 执行完产生一条新记录，用户找不到"我确认的那次执行到底成没成" |
| ④ | **可回滚或可追溯** | `terraform destroy`／state 回滚；ArgoCD 回滚到历史 revision；Dependabot 直接 revert PR | 只能"再改一次"来修，越修越乱 |

实验 B 把这四条做进了一个 30 条数据的规则引擎：`preview` 只打印、一个字都不落盘（①）；`plan` 把预览固化成带 `plan_hash` 的计划文件，`apply` 会**同时**校验计划文件自身指纹和规则／数据指纹，**篡改一个字符或规则被改过都拒绝执行**（②④）；执行结果按 `plan_hash` 追加进 `rule_log.jsonl`（③）。实测两种拒绝路径都返回退出码 2 并打印差异——这就是"确认后执行的是被审过的那一份"的最小可运行版本。

#### 台账的两种粒度

Agent 的执行记录有两种正交的形态，选错会让用户问不出问题：

| 形态 | 代表 | 结构 | 适合回答 |
|---|---|---|---|
| **节点级执行记录** | n8n：每次工作流执行按节点留记录，逐节点可看输入输出、可单独重跑[17] | 以"一次执行 × 一个节点"为粒度 | "这一步为什么输出是这个""只重跑这一步" |
| **按时间的事件流** | Home Assistant 的 **Logbook**：把所有实体状态变化按时间线摊平成一条人读的时间流[18] | 以"时间"为粒度，跨来源合并 | "**你今天都为我做了什么？**" |

"你今天都为我做了什么"这类问题，**天然属于后者**：用户要的不是你 37 次工具调用的输入输出，而是一条可扫读的时间线（09:12 整理了 4 条过期记忆、10:03 同步了工单数据、14:40 拦下一次重复推送）。两种都要有，但**面向用户的那一份必须是事件流**，节点级留给你自己排障。

---

## 三、关键实证与参数表

| 模式 | 数字或规则 | 出处 | 等级 | 迁移到你的系统时要注意 |
|---|---|---|---|---|
| 事件去重 | 相似度阈值 **0.7** | NewsBlur 匹配故事的线上配置[3] | B | 换表示／换语言必须重标；实验 A 实测同阈值下事件数 29 vs 43 |
| 事件去重 | 文章-事件时间差 **≤18h**、事件存活 **≤36h** | NewsBlur[3] | B | 中文增量抓取节奏不同（分钟级 vs 小时级），先统计你的稿件到达间隔分布再定 |
| 事件去重 | 事件向量只对**最近 3 篇**滑动平均 | NewsBlur[3] | B | 作用是让旧稿字面噪声失去投票权；簇内成员少于 3 时等价于全量 |
| 事件去重 | **两遍聚类**，第一遍吸收约 **70–80%** | NewsBlur[3] | B | 只在增量场景成立；一次性重建历史库时第一遍无内容可吸收 |
| 事件去重 | 漏并优于误并（不降阈值换召回） | NewsBlur 对强本地语境新闻的处理[3] | B | 先定义你所在场景里哪种错误是事故。新闻里误并是事故；记忆库去重时误删是事故，方向一致 |
| 跨语言 | 字符 n-gram 表示跨语言**交集为空** | 原理，实验 A 可复现 | A·自测 | MinHash/LSH/Jaccard 全部失效，需翻译／跨语言 embedding／实体锚定 |
| 个性化 | 反馈必须可归因到单条规则（命中集预览） | NewsBlur 个性化设计[4] | B | 这是四件套的动机，不是可选项；只做规则对象化＝半成品 |
| 来源质量 | 外部评分**取平均**，自建只维护归属名单（**2,276** 家） | Ground News[5] | B | 名单规模是副产品不是目标；别为了对齐规模去爬站 |
| 来源质量 | 出版物级评分**只能降权** | Ground News／评分机构方法论常识[5][7][8] | B | 任何"高分来源免复核"都是在加杠杆 |
| LLM 评分 | 与人类专家相关性 **ρ≈0.50** | 未核验研究[6] | C | 引用前务必复核原文；不要把 ρ 当可用性的证明 |
| LLM 评分 | 指派党派角色 → 系统性偏斜 | 未核验研究[6] | C | "扮演中立评审"无效；把 LLM 限定在抽取／归类 |
| 评分模型 | **ORES 已被 Lift Wing 取代** | Wikimedia 工程博客[9] | B | 系统里要存"评分来源+时间+版本"，不能只存分数 |
| 内容维护 | 标记 → 攒证据 → 可恢复窗口三级；标记阶段**从不自动改** | MediaWiki 数据库报告[10]、BCA[11] | B | 发现问题与允许修改是两个权限，别在同一个 Agent 里合并 |
| 内容维护 | 合并必须**改写所有入链引用** + 快照兜底 | Obsidian Note Composer[12] | B | 记忆库合并同理：改索引，否则留死引用 |
| 内容维护 | 跳过不丢；冷却期（**约 7 天**量级） | Obsidian／MediaWiki 生态实践[11][12] | B | 冷却期过短＝骚扰，过长＝遗忘；宁可留在队列别静音 |
| 写操作 | 四条不变式（零副作用预览／执行被审过的那一份／写回同一记录／可回滚） | Terraform、CloudFormation、ArgoCD、Dependabot[13]–[16] | A/B | 与模型无关，纯协议；建议在框架层实现一次，所有工具复用 |
| 台账 | 节点级记录 vs 按时间事件流 | n8n[17]、Home Assistant Logbook[18] | B | 面向用户的一律给事件流 |

---

## 四、反模式与常见误解

| 反模式 | 为什么错 | 生产系统的做法 |
|---|---|---|
| 一套阈值打三层 | L1 是字面判同、L2 是小时级事件、L3 是天级线索，尺度差两个量级 | 每层独立判据与阈值；跨层只用"是否属于同一事件"这种离散关系 |
| 事件只是聚类返回值 | 无法追加、无法引用、无法回答"这条的其它来源是谁" | 事件是一等实体：有 ID、有记录、有存活窗口（`GlobalEventID`/`eventUri`） |
| 删除式去重 | 合并后只剩一篇，来源被吞，出错无法追溯 | 产出"一个事件 + N 个来源"，原始稿一条都不删 |
| 把 0.7 当普适常数 | 换 n、换 Jaccard/重合系数、换语言，同一 0.7 的事件数从 29 变 43 | 阈值跟着表示走，用真实稿件标注集重标 |
| MinHash/LSH 做跨语言 | 字符 n-gram 跨语言**交集为空**，Jaccard 恒为 0 | 翻译后再去重、跨语言 embedding、或实体锚定（GDELT 路线） |
| 规则只做对象化 | 结构化之后用户仍然在盲选 | 预览命中集 + 显式优先级 + 日志，三件都要 |
| 用创建时间当隐式优先级 | 后来加的精确规则被更早的宽规则吞掉，且不可见 | 优先级是显式字段；平局不自动裁决，上报给人 |
| 自建媒体可信度评分表 | 重复别人的十年人工劳动，还得不到信任 | 聚合外部评分取平均，自己只做归属关系 |
| 高分来源免复核 | 出版物级评分当稿级证据，先验当后验 | 评分只用于**降权**与加提示，不用于背书 |
| 让 LLM 当可信度裁判（或"扮演中立评审"） | 与人类专家相关性约 ρ=0.50；指派角色会系统性偏斜 | LLM 只做抽取／归类／解释，不做裁决 |
| 维护 Agent 直接改内容 | 不可逆；一次误判毁掉用户内容 | 只加标记 → 攒证据 → 可恢复窗口 + 预告 |
| 合并时不改入链 | 全库留下死引用（Obsidian 用户最恨这个） | 合并 = 改内容 + 改写所有反链 + 快照兜底 |
| "跳过"＝永久忽略 | 三个月后用户只能自己全库重扫 | 跳过只推迟本轮，不改变队列状态；配冷却期 |
| 无冷却期的主动提醒 | 提示疲劳 → 用户整体静音 → 连偏好信号都没了 | 同类提示 N 天内不重复（7 天量级起步） |
| 确认后重新生成再执行 | 审过的和执行的不是同一件事 | 执行被审过的那一份；漂移或篡改就拒绝（`terraform apply plan.out`） |
| 只有节点级日志 | 用户问"你今天做了什么"，你只能甩 37 条 JSON | 节点级留给自己排障，面向用户给按时间的事件流 |

---

## 五、动手实践

代码在 `hands-on/ch07/`，两个实验**全部纯标准库、完全离线**（不需要 API key、不联网）。

> **本机解释器**：PATH 里的 `python` 是坏的空壳，请用
> `C:/Users/75791/.lumii/runtimes/bin/python`（本章所有数字都是它跑出来的，Python 3.11.9），
> 或你自己的 `python3`（3.8+）。详见 `hands-on/ch07/README.md`。

### 实验 A · 轻量事件去重（`event_dedup.py`）

**目标**：亲手看到三层模型里的 L1/L2 差别、两遍聚类的分工、阈值两侧的错误代价，以及"阈值不可移植"。

```bash
cd hands-on/ch07
C:/Users/75791/.lumii/runtimes/bin/python event_dedup.py            # 默认 tok 表示 / 阈值 0.7
C:/Users/75791/.lumii/runtimes/bin/python event_dedup.py --metric jac3
C:/Users/75791/.lumii/runtimes/bin/python event_dedup.py --threshold 0.5
```

数据是 45 条模拟中文标题：9 组同一事件的多来源变体（含 2 条归一化后全等的转载）、8 条主题相近但**不是同一件事**的干扰项（降准 vs 降准传闻澄清、台风登陆 vs 新台风将生成、财报 vs CEO 辞职、夺冠 vs 庆祝人群…），外加 2 条**强本地语境稿**（B04/B05：地铁开通的社区视角）和 2 条**故意晚到**的后续稿（A06 晚一天、A07 晚 40 小时）。

**你会看到的输出（本机实测值）**：

1. L1 同稿转载被单独识别：`A01↔A02`、`E01↔E04` 归一化后字面全等——文档层的活，不占事件层阈值。
2. 阈值扫描（`tok` 表示，46 个"应合并对"）：

| 阈值 | 事件数 | 已合并 | 漏并 | 误并 | 召回 |
|---|---|---|---|---|---|
| 0.50 | 23 | 38 | 8 | 0 | 0.83 |
| 0.60 | 27 | 30 | 16 | 0 | 0.65 |
| **0.70** | **29** | **28** | **18** | **0** | **0.61** |
| 0.80 | 32 | 19 | 27 | 0 | 0.41 |

3. 表示对照（阈值都固定 0.7）：`tok` 29 个事件 / `jac3` 43 个 / `ovl3` 40 个。
4. 聚类明细里每个事件都印着 N 个来源，**没有任何一篇文章被删**；B04/B05 单列成两个单来源事件（设计内漏并），A06/A07 被 18h/36h 时间窗拦在 GPT-5 事件之外。
5. 两遍聚类的分工：本轮模拟里第一遍吸收 9 篇（20%）、第二遍 7 篇并进新种子、29 篇成为新事件种子。第一遍占比远低于 NewsBlur 说的 70–80%，原因是这份模拟每轮只来 6 篇、事件还没"养肥"——**真实系统里事件越成熟、增量占比越小，第一遍吃掉的份额越高**。

**你应该观察到**：

- 阈值从 0.5 抬到 0.8，**漏并单调上涨，误并不涨**。继续往下压：`--threshold` 手动改成 0.30 时，误并出现（H01/H04、K01/K05 等 7 对）——庆祝人群被传递链并进了夺冠事件，这就是**链式串并**（连通分量的传递闭包效应），而生产系统正是用"事件侧只比最近 3 篇 + 存活窗口"来抑制它。
- 把 `--metric jac3` 打开：45 条只合出 2 对。**同一个 0.7，换表示就是另一个系统。** 这是本章最想让你亲手撞见一次的东西。
- 干扰项（不同事件但同主题）在所有阈值下都没被误并，是因为它们的字面差异本来就大；把 `news_sample.json` 换成你自己的真实标题，误并会立刻来找你——那时候你才会真正需要时间窗和实体一致性这两个约束。

### 实验 B · 规则引擎 + 命中集预览（`rule_engine.py`）

**目标**：把四件套跑成能碰的东西，并用同一份规则对照"没有预览"的实现会偏成什么样。

```bash
C:/Users/75791/.lumii/runtimes/bin/python rule_engine.py              # 完整演示：校验→预览→计划→应用→日志→盲选对照
C:/Users/75791/.lumii/runtimes/bin/python rule_engine.py preview      # 只打印，一个字都不落盘
C:/Users/75791/.lumii/runtimes/bin/python rule_engine.py blind        # 没有预览的世界
C:/Users/75791/.lumii/runtimes/bin/python rule_engine.py demo-invalid # 坏规则怎么被挡在门外
C:/Users/75791/.lumii/runtimes/bin/python rule_engine.py apply plan_preview.json
```

数据是 30 条资讯 + 6 条真实会打架的规则：`R3 科技类静音(p30)` 建得最早，`R1 AI 垂直源直接推(p10)`、`R2 高转发就推(p20)` 是后加的；`R4 医保必须推(p5)` 和 `R5 解读稿静音(p5)` 同优先级判相反动作；`R6 低质营销源静音(p40)`。

**你会看到的输出（本机实测值）**：

- 命中集预览：`R3` 命中 7 条、`R1` 4 条、`R2` 11 条、`R4` 4 条、`R5` 1 条、`R6` 3 条——每条规则命中**哪几条**逐条列出。
- 冲突裁决 7 条（N01/N02/N03/N04/N06/N22/N29）。其中 6 条由优先级链干净裁决（`R1/R2 push` 压过 `R3 mute`）；**N22 是平局**（R4 push vs R5 mute 同为 p5），程序**不自动裁决**，落兜底并打印"需要人看一眼"。
- 汇总：30 条 → 推 26 / 静音 4，10 条走兜底，1 条平局未决；`plan_hash=a1317e23fa046c21`。
- 四条不变式：`preview` 不写盘（①）；`apply` 前双重校验——改计划里一个字符 → 拒绝（实测退出码 2，报"按内容重算 = 1f7dfba1e2c59b17"）；只改规则优先级不重出计划 → 拒绝（报 rules 哈希不一致）（②）；执行结果按同一个 `plan_hash` 追加进 `rule_log.jsonl`，日志里能看到 `N22 push 由 R4,R5 决定 轨迹=R4:push->R5:mute <<< 平局未决`（③④）。
- `blind`：同一份规则、按插入顺序首条命中即生效 → **30 条里 6 条决策不同**（全是 `R3` 把 AI 稿静音了），N22 的平局静默消失，没有任何提示。
- `demo-invalid`：注入 3 条坏规则（未知字段 `words`、拼错的操作符 `startswidh`、非法动作 `hide` + `in` 给了字符串），全部当场拒绝。

**README 里那个问题，值得在这里正面回答：如果没有预览这一步，用户会怎样被盲选的规则训歪？**

1. 用户 7 月加了 `R3 科技类静音`，8 月加 `R1 这几个 AI 源要推`。盲选实现按插入顺序首条命中即生效，`R3` 赢了——**`R1` 一次都没生效**，而用户在 feed 里看到的现象只是"AI 稿还是没几条"。
2. 用户的归因能力被限制在"整体 feed 变好／变坏"，而整体分数是 6 条规则叠加的输出。他无法知道是哪条规则生效，于是**加一条更狠的**（"所有科技稿一律静音"），下一个月又加一条反向的（"OpenAI 的还是要推"）。规则库越训越极端、互相打洞，最后没人敢删。
3. 平局资讯（N22）静默落进 feed。用户看到的是"我明明设了不看的还推给我"——这条错误的代价是**用户对整个规则系统失去信任**，而它其实只需要一行"平局未决，请确认优先级"就能解释清楚。

预览的作用不是"方便"，而是**让反馈信号和规则之间出现可归因的通路**。这条对任何"从用户行为里学习"的 Agent 都成立。

---

## 六、映射回通用 Agent 设计

这四块模式看着是"新闻聚合／维基维护的领域知识"，但它们各自对应通用 Agent 的一个真实缺口。

### 6.1 事件层 → 记忆的聚合形态

第 2 章讲的记忆写入，最常见的坏味道是：同一件事被说三次，抽屉里就多三条。照 §2.1 的结构改造，写入路径应该是：

```
新记录进来
  ├─ L1：字面全等？ → 挂到同一条原始记录上（同稿转载）
  ├─ L2：匹配到存活窗口内的事件？ → 追加为"该事件的又一个来源"
  └─ L3：匹配到主题线索？ → 作为新事件挂进时间线
```

三条硬要求直接搬过来：**事件必须有 ID**（能被引用、能被追加）；**摘要/压缩不能删原始记录**（去重的产出是"一个事件带 N 个来源"，记忆同理——压缩后的摘要下面必须挂着原始转写）；**存活窗口**（三周前的事件不该再被新对话追加，否则一条记忆会长成无法解释的缝合怪）。相似度阈值请在**你自己的记忆语料**上重标，别照抄 0.7。

### 6.2 四件套 → 一切"用户偏好学习"的通用要求

把"规则"两个字换成**检索权重、摘要风格开关、工具白名单、主动打扰阈值**，四件套一个字都不用改：

| 件套 | 换成偏好学习就是 |
|---|---|
| 对象化 | 偏好是带类型的记录（作用域、生效条件、版本），不是 system prompt 里追加的一句话 |
| 命中集预览 | 保存前回答"按这个偏好，最近 20 次输出会怎么变"——**零副作用地展示影响面** |
| 优先级链 | 全局默认 / 项目级 / 渠道级 / 本次会话的覆盖关系必须显式，冲突要上报而不是靠"谁后写谁赢" |
| 规则日志 | 每条输出能回答"这次是哪个偏好起了作用"，否则用户只能整体打分 |

第 3 章（提示词进化）里"把用户反馈写进提示词"的那一步，同样要过这四关：一条改动的**命中集预览**＝"哪些历史输入会因这次改动而不同"。没有这个，提示词进化就是更大号的盲选。

### 6.3 四不变式 → 一切 Agent 写操作的通用协议

不要在每个工具里各写一遍。在**框架层**实现一次三段式，所有写操作复用：

```
preview(args) → Plan{plan_hash, diff, 影响面条数, 风险标注}     # ① 零副作用，不进事务
apply(plan_hash) → Result                                        # ② 只认被审过的那一份，漂移即拒绝
                                                                  # ③ 结果写回同一个 plan 记录
rollback(plan_hash) | 追溯：日志里能还原整条决策链                # ④
```

对照第 4 章的工具面治理：`preview` / `apply` 应该是**两个工具**，不是一个带 `--confirm` 参数的工具。分开之后，模型没法"顺手跳过预览"。

### 6.4 来源质量 → 记忆置信度；台账 → 用户可见时间线

同一套逻辑管住另外两件事：**给记忆／检索结果打分时，分数只用于降权，不用于背书**，且必须存"来源 + 时间 + 版本"（评分模型会换，正如 ORES → Lift Wing）；**面向用户的台账必须是按时间的事件流**，节点级日志留给自己。

还有一条属于所有会主动找你的 Agent：**冷却期**。任何"提醒—跳过—再提醒"的循环都要配冷却窗口，因为提示疲劳的终点是用户把整体静音，那时你连"用户在意什么"的信号都丢了。

---

## 七、本章小结

1. **去重的产出是"一个事件带 N 个来源"，不是删掉 N−1 篇。** 三个互不相干的生产系统（GDELT / Event Registry / NewsBlur）都收敛到这一条，它同时保住了可追溯和可追加。
2. **三层不是一把尺子。** 同稿转载、同一件事、多天线索，时间尺度差两个量级，判据和阈值必须各自独立；事件必须是**有 ID 的实体**，否则第二天你无法把新稿追加进去。
3. **0.7 不是常数，是存活值。** 同一份数据、同一个 0.7，换相似度表示，事件数从 29 变到 43（实验 A 实测）。任何阈值都要在你自己的语料和表示上重标。
4. **漏并和误并的代价不对称**：漏并是体验问题，误并是数据事故。所以阈值偏向漏并（NewsBlur 面对强本地语境稿就是这么选的），而不是去追召回率。
5. **MinHash+LSH 之类只适用同语言**：字符 n-gram 跨语言交集为空，Jaccard 恒为 0。跨语言要么翻译、要么跨语言 embedding、要么实体锚定（GDELT 路线）。
6. **只做规则对象化是半成品。** 用户过去在盲选——只能靠整体 feed 的分数变化反推哪条规则生效，这是规则被训歪的唯一来源。命中集预览、显式优先级链（平局不自动裁决）、规则日志，三件缺一件都等于没做。
7. **来源质量别自建**：聚合外部评分取平均，自己只维护媒体归属关系。两条硬约束不可让步——出版物级评分只能降权不能背书；不要让 LLM 当可信度裁判（ρ≈0.50，未核验；指派角色还会系统性偏斜）。
8. **有写权限的 Agent 必须守四条不变式**：预览零副作用、执行被审过的那一份、结果写回同一条记录、可回滚或可追溯。维护类任务再加三级流程（只加标记 → 攒证据 → 可恢复窗口），以及两个救命细节：跳过不丢、冷却期。

---

## 八、参考文献

**核验状态说明**：本章写作期间，本会话的网页抓取（被网关重写为不可达地址）与检索服务（退化为词典返回）均不可用。因此除 [4] 的 GitHub 仓库地址来自本次检索快照外，其余 URL 均为内部调研文档记录的地址或站点根域，**未在本次会话在线复核**，对外引用前请逐条打开核对。证据等级：A＝论文或一手工程文档；B＝厂商／项目自报；C＝预印本或未核验。

1. GDELT 项目（事件数据库、`GlobalEventID` 与 DOC 2.0 API）。 https://www.gdeltproject.org/ ｜ A/B ｜ 未在本次会话复核
2. Event Registry 文档（`eventUri` / `storyUri` / `articleUri` / `isDuplicate` 字段）。 https://eventregistry.org/ （Event/Article 对象字段页，具体路径未复核）｜ B ｜ 未在本次会话复核
3. NewsBlur 博客《Matching stories》（相似度阈值 0.7、文章-事件 18h、事件存活 36h、事件向量最近 3 篇滑动平均、两遍聚类吸收 70–80%、强本地语境稿宁可漏并、$100/月与 180+ 源运行规模）。 https://blog.newsblur.com/2026-09-15/matching-stories/ ｜ B ｜ **未核验**（内部文档提供 URL，本次会话未能访问）
4. NewsBlur 开源仓库（个性化训练 / story 相关实现的核对入口）。 https://github.com/samuelclay/NewsBlur ｜ B ｜ 本次检索快照确认存在（仓库描述与星标数在结果中可见）
5. Ground News 方法论（聚合 AllSides + Ad Fontes + MBFC 取平均；自建媒体归属名单 2,276 家）。 https://ground.news/ （方法论子页路径未复核）｜ B ｜ 未在本次会话复核
6. LLM 媒体可信度打分与人类专家相关性 ρ≈0.50；LLM 被指派党派角色后的系统性偏斜。**具体论文出处未确定。** ｜ C ｜ **未核验**（引用前必须复核，本章仅作方向性提示）
7. NewsGuard 九条编辑准则与评分方法。 https://www.newsguardtech.com/ ｜ B ｜ 未在本次会话复核
8. AllSides ／ Ad Fontes Media ／ MBFC 三家评分方法论。 https://www.allsides.com/ ｜ https://adfontesmedia.com/ ｜ https://mbfc.maticlab.org/ ｜ B ｜ 未在本次会话复核
9. Wikimedia 工程博客：机器评分服务层 **Lift Wing** 取代 **ORES**。 https://diff.wikimedia.org/ （具体文章路径未复核）｜ B ｜ 未在本次会话复核
10. MediaWiki 数据库报告类工具（孤儿页、死链页等，设计上不自动修改页面）。 https://www.mediawiki.org/ （Manual:Database reports 路径未复核）｜ A/B ｜ 未在本次会话复核
11. Better Content Archiving（BCA）：归档建议的观察—证据—提请流程、恢复区。官方文档站路径未复核 ｜ B ｜ 未在本次会话复核
12. Obsidian 插件 **Note Composer**（合并前快照、改写全部入链引用）、**Janitor** 类清理插件（回收站式删除、跳过与冷却）。插件社区页路径未复核 ｜ B ｜ 未在本次会话复核
13. Terraform `plan` / `apply`（预览零副作用；执行计划文件）。 https://developer.hashicorp.com/terraform/commands/plan ｜ A ｜ 未在本次会话复核
14. AWS CloudFormation Change Sets（生成→审查→执行、状态回写）。 https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-changesets.html ｜ A ｜ 未在本次会话复核
15. Argo CD（diff / sync / 历史 revision 回滚）。 https://argo-cd.readthedocs.io/ ｜ A ｜ 未在本次会话复核
16. GitHub Dependabot（版本更新以 PR 形式提出、人工合并、可 revert）。 https://docs.github.com/en/code-security/dependabot ｜ A ｜ 未在本次会话复核
17. n8n 执行记录（节点级输入输出与单节点重跑）。 https://docs.n8n.io/ ｜ B ｜ 未在本次会话复核
18. Home Assistant **Logbook**（按时间的实体事件流）。 https://www.home-assistant.io/ ｜ B ｜ 未在本次会话复核
19. 本教程自测数据：`hands-on/ch07/` 两个脚本的全部数字（阈值扫描、表示对照、冲突裁决、拒绝执行）。由 `C:/Users/75791/.lumii/runtimes/bin/python`（Python 3.11.9）在本机运行产生，可复现 ｜ A·自测 ｜ 已核验


---

# 第 8 章 · 证据方法论：这本教程如何对待自己的数字

> **本章解决什么问题**：这是一本讲 Agent 设计的书，书里出现了大量论文编号、实验数字和厂商参数。本章把全书写作时执行的证据规则摊开给你看——包括写作过程中抓到的四个真实案例——目的是让你离开本书后，面对任何一篇"论文说""官方说"也能自己完成同一套质检。
> **预计阅读时长**：15–20 分钟 · **前置知识**：无；但建议在读完任意一章、被某个数字说服之后回来读本章。

---

## 一、为什么一章专门讲证据

Agent 工程领域有一个结构性困难：**几乎所有关键数字都不可比**。Mem0 说自己在 LoCoMo 上 66.88%，Zep 说自己在同一基准上 94.8%——两边都是真的，两边都用了自己的方法和自己的超参数，甚至可能各自"调教"过评测脚本。Letta 还发博客公开质疑过 Mem0 的跑法（第 2 章有记录）。

在这种环境里，"看了哪篇论文"不重要，**"你怎么对待论文里的数字"才重要**。本书的立场：数字可以引，但每个数字必须带着它的来源等级、口径和适用边界一起出现。

## 二、全书的证据分级

| 等级 | 含义 | 阅读方式 |
|---|---|---|
| **A** | 同行评审论文（TMLR/UIST/AAAI/NeurIPS 等）、大厂一手工程文档（Anthropic/Cognition 官方博客）、**本书自测且可复现的数字** | 可以当依据用，仍要注意实验设定 |
| **B** | 厂商自报（Mem0/Zep/Letta/Anthropic 产品博客的评测数字）、生产系统的线上参数 | 当"存活值/上限参考"用，不当"预期效果"用；互不可比 |
| **C** | 预印本（尤其 arXiv 26xx 编号）、未核验转引、收录情况存疑的论文 | 当"方向提示"用，数字不要进你自己的方案文档 |

各章末尾的参考文献逐条带等级标注；正文中凡引用未能核验的数字，均就地标注「源自内部文档·未核验」。

## 三、四个抓包现场：流行数字是怎么变形的

以下四个案例全部发生在这本书的写作过程中。它们的价值不在于否定某个数字，而在于展示**四类典型的数字变质方式**——你在别处会反复遇到同样的模式。

### 案例 1：跨论文拼接的"对比"（第 2 章）

内部调研文档里流传着一对数字："递归摘要 35.3% vs 全上下文 98.0%（DMR 基准）"，用来论证"巩固会破坏信息"。乍看是一次干净的 A/B 对比。

取证结果：35.3% 出自 MemGPT 论文（arXiv:2310.08560）中 GPT-4-Turbo 的递归摘要基线；98.0% 出自 Zep 论文（arXiv:2501.13956）用 gpt-4o-mini 复测的全上下文臂。**两篇论文、两个模型、两个评测环境**，被某次转引拼成了一对。结论方向没错——同臂对照下 MemGPT 自己报告的是 35.3% → 93.4%，摘要确实掉了近 60 个百分点——但那对 98.0 是别人的数。

**迁移教训：凡是对比数字，先问"这是同一篇论文、同一个模型、同一份评测跑出来的两臂吗？"** 不是，就只能各信各的绝对值，不能信它们的差。

### 案例 2：传播链上的编号讹误（第 6 章）

写作任务书里给 Voyager 的编号是 arXiv:2305.16414。核验发现：这个编号对应一篇 H I 星系天文观测论文。Voyager 的正确编号是 **arXiv:2305.16291**（经官方 GitHub 仓库与 alphaXiv 双源确认）。

这个错误大概率源于某篇文章引用时打错了末两位，后来者复制粘贴，讹误就开始繁殖。

**迁移教训：核验一篇论文，正确顺序是"标题 + 作者 → 打开摘要页 → 顺便核对编号"，而不是"打开编号 → 看是不是眼熟"。** 只看编号等于没核验。

### 案例 3：同名指标换口径（第 6 章）

Honest Lying（arXiv:2605.29463）的"程序化失败信号后正确率 0% → 86%"在内部文档中被表述为任务正确率。逐字核对原摘要后发现：86% 是**"正确目标物在反思中的提及率"**—— mitigation 之后 16 个卡死环境实际只解开了 3 个。

方向依然成立（自由反思固化的错误解释是真实风险），但量级完全不同：一个接近"药到病除"，一个只是"不再自信地胡说目标"。

**迁移教训：任何"X% → Y%"都先查指标的原始定义。** 名字里带"rate/accuracy/正确率"的指标，定义域千差万别；预印本尤其容易出现对自己有利的口径。

### 案例 4：线上参数的可移植性幻觉（第 7 章）

"相似度阈值 0.7"是 NewsBlur 公开博客里线上存活的去重参数。本书实验环节照搬实现后实测：换成中文字符 3-gram Jaccard，同一事件的两条标题相似度普遍只有 0.10–0.40，0.7 阈值下 45 条新闻只合出 2 对——系统退化成"几乎不去重"。这个失败本身被做成了第 7 章实验的核心观察：换一种表示，同一阈值的产出从 29 个事件变成 43 个。

**迁移教训：别人论文/博客里的超参数是"那篇论文那个设定下的存活值"。** 抄参数必须连同表示、语言、数据分布一起抄，否则从第一天起就在错误的刻度上。

## 四、厂商基准的阅读方法

书中 B 级数字（Mem0 的 66.88/67.13、Zep 的 94.8、Anthropic 的 49%→74% 等）请统一这样读：

1. **谁在测**：厂商测自己，基线和超参都是自己的；
2. **测什么**：多数是自建/自选基准，与你的业务分布无关；Anthropic 产品页的"85% token 减少"是特定 MCP 评测集下的结果；
3. **缺什么**：几乎从不报告方差、成本、失败案例；
4. **怎么用**：把它们当"这个技术路线可能有效的证据"，而不是"你上线后能拿到的收益"。自己场景的数字只能用本书第 3/6 章的失败分类学流水线自己测出来。

## 五、不要引用的东西（动态勘误表）

内部调研文档 §八 整理过一批"已变更、别再当标杆"的产品状态（**以下整表源自内部文档，产品状态是易腐信息，引用前请自行复核当前状态**）：

| 常见说法 | 文档记录的状态 |
|---|---|
| Rewind / Limitless | Limitless 被 Meta 收购，独立产品叙事终结 |
| ChatGPT agent / Operator | 已下线/整合 |
| Artifact | 已停服（2024-01） |
| "Devin Wiki" | 不存在此产品名 |
| Notion AI 自动整理知识库 | 不成立，仅人工验证标记 |
| ORES 给维基条目打质量分 | 基础设施已被 Lift Wing 取代 |
| MinHash+LSH 做新闻去重 | 只适用同语言 |
| LLM 单独打来源可信度分 | 不可单独使用 |

这张表的正确用法不是背下来，而是体会一个频率：**关于"别人家的 Agent 产品怎么做"的流行说法，过时率非常高。** 引用产品能力前先打开当前官方文档。

## 六、给读者的六问

在你把本书（或任何文章）里的一个结论写进自己的方案之前：

1. 这个数字出自哪篇论文/哪篇官方博客？我打开原文了吗——还是只看到了转引？
2. 它是什么等级？A 可以当依据，B 只能当参考上限，C 只能当方向。
3. 对比的两臂同源吗？（案例 1）
4. 指标的原始定义是什么？（案例 3）
5. 参数/结论的适用边界（模型、语言、数据、任务）与我的场景一致吗？（案例 4）
6. 它是否已经过时？产品类说法查当前文档，预印本查是否已被后续工作或撤稿推翻。

六问全过，才把数字带进你的设计文档。

## 七、本章小结

1. Agent 领域的关键数字大量来自互不可比的自建基准，**证据素养先于技术选型**。
2. 数字变质的四种典型方式：跨论文拼接、编号讹误、口径漂移、参数不可移植——本书各抓到一个现行案例。
3. 厂商数字读法：谁测的、测什么、缺什么、怎么用，四步走完再归档为 B 级参考。
4. 产品状态是高腐信息，引用即复核。
5. 本书自身的核验状态逐章公开在 README 中；第 7 章的外部来源核验最弱（写作时网络工具故障），已逐条降级标注——这种公开本身就是本书要你学会的行为。

## 八、参考文献

1. MemGPT paper. https://arxiv.org/abs/2310.08560 —— A（第 2 章已核验 PDF 原表）。本章案例 1 的同臂数字 35.3→93.4 出自此文 Table 2。
2. Zep/Graphiti paper. https://arxiv.org/abs/2501.13956 —— A（v1 PDF 已核验）。案例 1 中 98.0 的出处。
3. Voyager paper. https://arxiv.org/abs/2305.16291 —— C（预印本；编号勘误见第 6 章）。
4. Honest Lying. https://arxiv.org/abs/2605.29463 —— C（未同行评审；案例 3 口径勘误依据其 abstract 逐字核对）。
5. 内部调研文档《12-一级公民的积累与演化》（2026-09-16）—— §八 证据质量说明，勘误表来源，源自内部文档。


---
