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
