# 09 · 平台事实与 SDK

> 来源：`models`、`api`、`sdk`、`sdk/python`、`sdk/javascript`、`agent-skill`、`legal`、
> `introduction/quickstart`、`materials/sources`、`demos/smart-home`。

---

## 9.1 端点与模型

**所有模型由同一个端点服务**：

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TYPESAFE_API_KEY>
Content-Type: application/json
```

`model` 字段选择由哪个模型处理调用。

### 当前模型

| 项 | 值 |
| --- | --- |
| 模型 | **Jev 1.13** (`jev-1.13.0`) |
| 价格 | **$42 / Btok**（≈ **$0.042 / Mtok**）**输入**；**输出 token 免费** |
| 速率限制 | **250,000 token/秒**；**1,200 请求/分钟** |
| 上下文 | **每请求 64k token**；`state` + **单个最长的问题** ≤ **32k token** |
| 输入 | **仅文本**。字符串、JSON 对象或文本值数组。**不支持图像、音频或视频** |

**计价口径**：按**输入 token**计费，输出 token 免费。1 Btok = 十亿 token，1 Mtok = 一百万 token。

**上下文口径**（容易误读）：

> Jev **只读取一次 state，并针对它并行评估每个问题**。
> **64k 预算涵盖 state + 所有问题的总和**；
> **32k 预算适用于 state + 单个最长的问题**。

> ⚠️ 官方警告：**速率限制正在动态调整**
> ——「我们正在服务非常大量的需求……上述限制可能随时更改而不另行通知」。
> 自定义版和企业版可提供更高限制。

---

## 9.2 别名与版本漂移

| 别名 | 指向 | 含义 |
| --- | --- | --- |
| `jev-latest` | `jev-1.13.0` | 最近的**稳定官方版本**。SDK 默认值 |
| `jev-preview` | `jev-1.13.0` | 最近的版本，**无论它是否为官方版本** |

> ⚠️ **`jev-preview` 目前指向与 `jev-latest` 相同的模型。当前没有可用的预览构建。**

### ⚠️ 这是集成时最容易踩的坑

> 新版本发布时**别名会随之前移**，因此**即使你这边没有任何改动，它背后的答案也可能变化**。
>
> 响应的 `model` 字段会报告**实际作答的带版本 ID**，方便你记录每个结果由哪个模型产生。
>
> **如果你已针对特定版本调好了置信度阈值，请固定使用该版本的 ID 而不是别名**，
> 并按自己的节奏迁移到新版本。

> **实践建议**：Lumii 这类需要稳定评测基线的项目，
> 应**固定 `jev-1.13.0`**，并在响应里断言 `model` 字段与预期一致。

---

## 9.3 怎么"定制"Jev

> **Jev 不会用客户数据做微调或 LoRA 适配。**
> 它通过 **RLCD** 训练以返回经过校准的判断，**所有账户共用同一套权重**。

三条定制途径：

1. **把专有内容、数据记录和参考资料放进 `state` 字段**
2. **在每个问题的 `instructions` 和 `criteria` 中编码你的领域规则和边界情况**
3. **把宽泛的判断拆解为原子问题，并在代码中组合输出**

### 官方三条禁令（原文）

> - 向模型询问**代码可以精确计算**的问题。
> - 在**一个问题中隐藏多个判断**。
> - 在 `state` 中提供**超出问题所需**的上下文。

---

## 9.4 语言支持与数据处理

### ⚠️ 中文处理的真实情况

> Jev 接受自然语言文本。**英语是主要训练语言，也是目前准确率最高的语言。**
> **其他语言（包括中日韩文字）可以处理但效果不一**；
> 在把 Jev 用于非英语工作负载之前，**请先在自己的内容上测试**，
> 并在路由时**密切关注 `Confidence`**。

> **对本项目而言这是**：Lumii 的输入以中文为主。
> **"可以处理但效果不一"意味着任何性能数字都不能从英文材料外推。**

### 数据处理

> **Jev 不会在客户请求或响应上训练。**
> 数据处理协议、隐私政策以及面向企业客户的**零数据留存（ZDR）**详情见 Legal。

`legal` 页本身只是索引，列三份文件：数据处理协议（数据留存）、
主客户协议（通用条款）、隐私政策。ZDR 需联系 `sales@typesafe.ai`。

---

## 9.5 列出模型

```bash
curl https://api.typesafe.ai/v1/models -H "Authorization: Bearer $TYPESAFE_API_KEY"
```

```python
# Python
client.models.list().models        # 每项有 name / release_date / description
```

```ts
// JavaScript
import { TypeSafeClient } from "@typesafe-ai/sdk";
const models = await client.models.list();
```

> `GET /v1/models` 返回你的账户可以在 `model` 字段中填写的名称。
> **它目前列出的是别名**；
> **像 `jev-1.13.0` 这样的带版本 ID 无论是否出现在列表中，`model` 字段都接受。**

---

## 9.6 SDK

### Python

```bash
uv add typesafe-sdk          # 或 pip install typesafe-sdk
export TYPESAFE_API_KEY=...
```

要求 **Python ≥ 3.10**。

```python
from typesafe_sdk import (
    AsyncTypeSafeClient, TypeSafeClient,
    Choice, Noul, NoulCriteria, Score,
)

# 同步
with TypeSafeClient() as client:
    response = client.system_one(state=..., questions={...})

# 异步
async with AsyncTypeSafeClient() as client:
    response = await client.system_one(state=..., questions={...})
```

问题构造函数：

```python
Noul(instructions=...)                                    # criteria 可选
Noul(instructions=..., criteria=NoulCriteria(true=..., false=...))
Choice(instructions=..., criteria={"calm": None, "frustrated": None, "angry": None})
Score(instructions=..., criteria=["can wait", "this week", "today"])
```

**重试**：SDK 提供类型化的问题与答案，并**用各自默认重试策略自动处理重试**，
在响应携带 `retry-after` 头时遵循它。可显式配置：

```python
TypeSafeClient(
    api_key=...,
    base_url=os.environ.get("TYPESAFE_ENDPOINT"),   # 各 cookbook 里环境变量名不统一
    timeout=120.0,
    retry=RetryPolicy(max_retries=5, backoff_initial=1.0, backoff_max=20.0),
)
```

> ⚠️ **环境变量名在官方 cookbook 里不统一**：
> 出现过 `TYPESAFE_ENDPOINT` 和 `TYPESAFE_BASE_URL` 两种。
> `base_url` 的默认值是 `https://api.typesafe.ai/`。

### JavaScript / TypeScript

```bash
npm install @typesafe-ai/sdk       # 需 Node.js 20+
```

```ts
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient();
const response = await client.systemOne({ state, questions });

choice("What is this ticket about?", { billing: null, technical: null, other: null });
response.answers.category.choice;
```

> **答案类型按定义的问题自动推断**；包含 **ESM、CommonJS 与 TypeScript 声明文件**。
>
> **本项目是 TS/Electron 栈，这个 SDK 可直接用。**

### ⚠️ 答案访问方式的不一致（照实记录）

| 出处 | 写法 |
| --- | --- |
| `primitives` / `primitives/choice` / `primitives/score` / `confidence` / `quickstart` | `response.answers["id"].noul` / `.choice` / `.score` |
| `sdk/python` | `response.nouls["billing"].noul`、`response.choices["tone"].choice`、`response.scores["urgency"].score` |
| `model-jaggedness/jev-1.13` | `result.nouls[f"item_{i}"].noul` |

**两种写法并存于官方文档**，本笔记不判定哪个正确——
实际集成时**以装上的 SDK 版本的类型声明为准**。

---

## 9.7 错误码与限流

| 码 | 含义 | 处理 |
| --- | --- | --- |
| `401` | Unauthorized：缺 / 无效 key | — |
| `422` | Unprocessable Entity：请求体校验失败（**响应体详述出错字段**） | 修请求 |
| `429` | Too Many Requests：超速率限制 | **退避重试** |
| `520` | （在 JevBench 快照中出现过一次） | — |
| `529` | Overloaded：TypeSafe 过载 | **延迟重试** |

> 429 / 529 用**指数退避**；**客户端 SDK 默认自动处理**。

### ⚠️ 一个真实的限流经验

来自 `17_自动研究特征发现`：

> **`ThreadPoolExecutor(max_workers=8)` 已足以在共享密钥上触发速率限制。**

其他 cookbook 用的并发数：

| cookbook | 并发 | 备注 |
| --- | --- | --- |
| 重排序 | `max_workers=12` | 1,200 次调用 |
| 实体对齐 | `MAX_WORKERS = 6` | 注释：**public endpoint 在约 8 以上会限速** |
| 自动研究 | `max_workers=8` | 已触发限速 |
| 技能推荐 | `WORKERS = 8` | 488 calls |
| RAG 段落分类 | `max_workers=4` | — |

> **经验值：6 是安全线，8 就开始踩线。**
> 大规模批处理需要**自建退避 + 并发上限**，不能只靠 SDK 重试。

---

## 9.8 Agent 技能（给编码智能体用的上下文）

官方提供了一个把 TypeSafe 知识装进编码智能体的 skill。

**Claude Code**：

```bash
claude plugin marketplace add typesafe-ai/skills
claude plugin install typesafe@typesafe-ai
```

**其他 agent**：

```bash
npx skills add typesafe-ai/skills --skill typesafe-ai     # 默认装项目本地
npx skills add typesafe-ai/skills --skill typesafe-ai -g  # 全局
```

**更新**：

```bash
claude plugin marketplace update typesafe-ai
claude plugin update typesafe@typesafe-ai
# 然后重启或 /reload-plugins
# 自动更新：/plugin → Marketplaces → typesafe-ai → Enable auto-update
```

**手动安装**：复制整个 `skills/typesafe-ai` 目录到智能体技能目录。
> ⚠️ **只用一种安装方式，避免重复副本。**

**SKILL.md**：
`https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md`

### FAQ（官方给的）

| 症状 | 处理 |
| --- | --- |
| 技能没加载 | 调 `/typesafe:typesafe-ai`，或明确要求 "use the TypeSafe skill"；确认装对 agent 并重启 |
| 路由不符预期 | **检查问题与阈值**——**过高 = 假阴性、过低 = 假阳性** |
| 到处用置信度阈值 | **若只关心最佳选项，选置信度最高的选项即可**（或用概率） |
| 代码难审阅 | **问题与阈值常量应定义在单个代码文件** |
| **智能体虚构请求/响应字段** | **技能版本过旧**——更新后重试 |

### 良好的 vibe coding 原则（官方）

- 聊透想法
- **实现前审阅计划**
- **常量（问题和阈值）放单一位置**
- **不照单全收智能体断言，鼓励验证**

---

## 9.9 演示：智能家居（`demos/smart-home`）

**主模式**：推测式扇出。

示例请求「**关掉房子里所有的灯**」只关心四问：
请求类别 = 智能家居命令、领域 = 整栋房子、设备类型 = 灯、对灯的操作 = 关闭。

> **「操作」问题在还不知道请求什么时已假设是灯**——**这是推测性问题**，
> 先问、再事后由代码过滤无关结果。

**错误做法**：顺序 API 调用（先问类别 → 知道后再问领域/设备 → 再问操作）。
> **以最少问题数优化，但比一次性批量慢得多、成本高得多。**

**TypeSafe 与 LLM 的搭配分工**：

| 任务 | 谁做 |
| --- | --- |
| 拆分复合请求 | 一个 Noul 判断是否要求多个不同操作；**为真则用 LLM 拆成原子命令列表**，再由 TypeSafe 逐个评估 |
| 回退对话式回复 | TypeSafe 判定为**一般信息/对话**时，调 LLM 生成自由回复 |

> TypeSafe 初始响应非常快，**给系统增加的延迟可忽略**。

> 实现：Vite/React 单页应用。**3D 房间是模拟器，不是实际家居设备控制器。**

关于第五章的 3D 实验：Notebook 展示**一次**投机调用；浏览器应用支持实时追踪。
**具体概率、耗时和费用会随模型版本、网络及配置变化，
查看时请同时记录运行日期和所用端点。**

### 第五章的理论补充（与模型无关但很实用）

**依赖图**：把多条动作看成有向图——若 B 必须等 A 完成，写入边 A → B；
互不依赖的动作才可并行。**它定义的是动作之间的部分顺序，不必把所有操作一律串行。**

四个并发陷阱：

| 陷阱 | 说明 |
| --- | --- |
| **竞态** | 两个动作同时读取旧状态并写入冲突结果 |
| **幂等** | 重试同一动作时避免重复开锁、重复扣款或重复创建任务。RFC 9110 §9.2.2 用"多次相同请求的预期效果等同于一次请求"定义 HTTP 方法幂等性；**业务动作也应设计可安全重试的语义，但日志等附带副作用仍可能重复** |
| **过期状态** | 判断和执行之间设备状态可能已变化；**执行前重新读取关键状态，或通过版本号条件更新** |
| **失败恢复** | 记录已完成步骤，并定义补偿、回滚或人工介入方式 |

> 配套的复合指令执行清单（官方给的控制清单）：
> 执行前检查权限 + 读设备版本；执行中按依赖顺序、失败时记录已完成动作**不盲目重放整条指令**；
> 重试时**沿用同一 `action_id`** 防重复副作用；执行后读新状态并写入追踪记录。

---

## 9.10 素材来源与许可（`materials/sources`）

**打包日期 2026-09-23**，共 **40 个来源目录**（**编号跳过 22**，从 21 直接到 23）。

### 收录原则（官方原文要点）

- **Markdown 全收**：README、docs/、research/、categories/ 等文档目录整目录收录
- **代码只收核心**：能体现「状态 → 问题 → 概率 → 动作」决策链路的实现文件；
  **测试、脚手架、构建产物、依赖锁、数据集、模型权重一律不收**
- **原样保留**：文件内容与上游逐字节一致，未做任何改写；仅重排目录结构
- **例外**：飞书研究报告从飞书云文档导出为 Markdown，公式图片本地化到 `media/`

### 全部 40 个来源

| # | 目录 | 上游 / 版本 | 内容 | 许可 |
| --- | --- | --- | --- | --- |
| 01 | `01-official-docs-zh/` | Bald0Wang/jev-docs-zh（`9e0162b`，111 文件） | 官方文档**非官方社区中译** | 上游未附 LICENSE；文档版权归 TypeSafe AI |
| 02 | `02-nanojev/` | TianyuCodings/NanoJev（`618cea6`，77） | 小型应用的确定性引擎与判断接口模式 | MIT |
| 03 | `03-jev-trader/` | jarrodwatts/jev-trader（`b587759`，9） | 链上交易探针 | MIT |
| 04 | `04-fast-jev-compaction/` | tamaratran/fast-jev-compaction（`e3f262a`，10） | **Claude Code 上下文压缩**示例 | MIT |
| 05 | `05-awesome-jev/` | yibie/awesome-jev（`a42aea8`，17） | awesome 清单 | 上游未附 LICENSE |
| 06 | `06-typesafe-skills/` | typesafe-ai/skills（`65a39f3`，5） | SKILL.md 技能仓库 | MIT |
| 07 | `07-jev-ultrafast/` | browser-use/jev-ultrafast（`1231850`，12） | Browser Use 的 ultra-fast 前端 | MIT |
| 08 | `08-eve-decision-models/` | vercel/eve（仅 `research/jev-decision-models.md`） | Vercel 的决策模型研究 | Apache-2.0 |
| 09 | `09-typesafe-sdk-python/` | typesafe-ai/typesafe-sdk-python（`2ce5c65`，31） | Python SDK | MIT |
| 10 | `10-feishu-research/` | 飞书云文档（私有 wiki，18） | 飞书研究报告 | **请勿外传** |
| 11 | `11-typesafe-mario/` | fhshaik/typesafe-mario（`ca22449`，6） | Mario 模拟器复现 | 上游未附 LICENSE；**声明不含任何 Nintendo ROM 或游戏数据** |
| 12 | `12-wechat-article/` | 微信公众号「腾讯技术工程」（4） | — | 腾讯版权所有 |
| 13 | `13-feishu-cookbook-plan/` | 飞书云文档（私有 wiki，6） | 规划文档与技术报告（**引用 5 篇无权限未收录**） | **请勿外传** |
| 14 | `14-feishu-lecture/` | 飞书云文档（私有 wiki，6） | 讲座整理稿 | **请勿外传** |
| 15 | `15-jevbench/` | fstandhartinger/jevbench（`a83840b`，125） | **冻结题集**（公开数据集 MIT，held-out 未发布） | MIT |
| 16 | `16-wechat-agent-engineering/` | 腾讯技术工程（11） | — | 腾讯版权所有 |
| 17 | `17-wechat-silicon-grail/` | 腾讯技术工程（3） | — | 腾讯版权所有 |
| 18 | `18-wechat-rerank-experiment/` | 微信公众号「Zilliz」（13） | **重排序实验** | Zilliz 版权所有 |
| 19 | `19-wechat-laya-architecture/` | 「魔搭 ModelScope 社区」（21） | Laya 架构 | 版权所有 |
| 20 | `20-wechat-laya-oss-release/` | 「PaperAgent」（11） | Laya 开源发布 | 版权所有 |
| 21 | `21-wechat-laya-hf-trending/` | 「机器之心」（10） | Laya HF 榜单 | 版权所有 |
| 23 | `23-clef-decision-models/` | **Cloudflare Blog "Introducing Clef"**（4） | Cloudflare 的决策模型发布文 | © 2026 Cloudflare |
| 24 | `24-polydao-jev-engineering/` | X @polydao（10） | **「How to Cut Your Agent Bill by 90%」** | © @polydao |
| 25 | `25-vixhal-gero-rl/` | X @TheVixhal（1） | Gero-4B RL 训练平台 | © @TheVixhal |
| 26 | `26-akshay-jev-judge/` | X @akshay_pachaar（7） | Build a Jev Judge | © @akshay_pachaar |
| 27 | `27-avichawla-diy-jev/` | X @_avichawla（15） | **Build your own Jev (100% local)** | © @_avichawla |
| 28 | `28-pg-jev/` | 「AI工程化」+ realZachi/pg-jev | **PostgreSQL 扩展** | PostgreSQL License（README） |
| 29 | `29-wechat-startlux-decision/` | 「机器之心」（9） | StartLux 决策模型报道 | 腾讯/机器之心版权所有 |
| 30 | `30-wechat-jev-skeptic/` | 「数字生命情酱」（26） | **Jev 质疑实测**（马里奥/Minecraft 拆解） | 版权所有 |
| 31 | `31-avb-choice-invariance/` | X @neural_avb（6） | **训练选项顺序不变性** | © @neural_avb |
| 32 | `32-omarsar-jev-as-judge/` | X @omarsar0（5） | Jev-as-a-Judge | © @omarsar0 |
| 33 | `33-arena-jev-router-eval/` | X @arena（5） | **Arena 路由独立评测** | © @arena |
| 34 | `34-unsloth-train-decision-model/` | Unsloth 官方文档（7） | 用 Unsloth 训练自有决策模型 | 官方文档 |
| 35 | `35-llm2jev-paper/` | arXiv **2610.02076**（2） | **LLM2Jev: LLMs Are Already Jev-Style Decision Models** | 论文 |
| 36 | `36-llm2jev-code/` | GitHub Yinsongxu/LLM2Jev | 开源实现 | 见仓库 |
| 37 | `37-rsi-jev/` | GitHub Shanghua-Gao/RSI-Jev | **自我改进环路**（含 496 实验清单） | 见仓库 |
| 38 | `38-wechat-jev27b-vl/` | 「魔搭 ModelScope 社区」（8） | **JEV-27B-VL 多模态决策模型** | 版权所有 |
| 39 | `39-microsoft-decision-1/` | Microsoft Command Line（5） | **Introducing Microsoft-Decision-1**（含 3 段官方演示视频） | Microsoft |
| 40 | `40-embodied-jev/` | GitHub FBddcz/embodied-jev（6） | 具身决策工作台 | 见仓库 |
| — | `laya-model/` | NandhaKishorM/laya（8） | ModelScope 模型卡；**不收录约 2.2 GB 权重** | Apache-2.0 |

### 生态里值得注意的几个

从 40 个来源里挑出与本项目最相关的：

| 项目 | 为什么值得看 |
| --- | --- |
| **04 fast-jev-compaction** | **Claude Code 上下文压缩**——与本项目的 context 管理直接同类 |
| **07 jev-ultrafast**（browser-use） | **浏览器前端决策**——与本项目的 browser 套件同域 |
| **15 jevbench** | **独立冻结题集**，比厂商自报数据可信 |
| **23 Cloudflare Clef** | 另一家大厂的决策模型路线（⚠️ **厂商自报数据**，官方提示对照 JevBench 独立复测再引用） |
| **27 Build your own Jev (100% local)** | **本地自制决策模型**——数据不能出本机时的路线 |
| **28 pg-jev** | 在 **SQL 里做语义判断** |
| **31 choice-order invariance** | **训练选项顺序不变性**——直接关系到"选项排列会不会影响答案" |
| **33 Arena Jev Router 独立评测** | 独立第三方评测 |
| **34 Unsloth 训练决策模型** | 本地训练的现成路线 |
| **35 LLM2Jev 论文** | 主张"LLM 本身已是 Jev 式决策模型" |
| **38 JEV-27B-VL** | **多模态**决策模型（当前 Jev 只支持文本） |
| **39 Microsoft-Decision-1** | 大厂同名路线 |
| **laya-model** | **开源权重**路线（Apache-2.0，权重需另行下载） |

### ⚠️ 引用这些素材时的注意事项（官方逐条列了）

| 来源 | 警告 |
| --- | --- |
| 官方文档中译 | **非官方社区翻译**，接口变动时**核对官方文档** |
| 02 NanoJev | **示例不等于生产级模型基准** |
| 15 JevBench | 比较前**确认 v1.2.3 的计分、价格和延迟调整** |
| 23 Clef | **厂商自报数据**，对照 JevBench 的独立复测再引用 |
| 24、25、26、27、28 | **作者自报口径 / 单机自报，未见第三方复测**，**按案例看待** |
| 29 StartLux | **媒体报道**，引用前回 Decision Index 与模型卡复核 |
| 30 Jev 质疑实测 | **独立质疑视角、单作者自测口径**，可与 11 号 mario 复现的上游 bug 记录互相印证 |
| 31 选项顺序不变性 | **自述含半成品想法** |
| 10、13、14 飞书 | **私有 wiki，请勿外传** |

> **快照日期不代表资料仍是上游最新版本。**
> 私有文档或受版权保护的内容**不能因被收录就自由再分发**。

---

## 9.11 一页速查

```
端点       POST https://api.typesafe.ai/v1/systemone
模型       jev-1.13.0   ← 调好阈值就固定这个，别用别名
价格       $42/Btok 输入（$0.042/Mtok），输出免费
限速       250k tok/s、1200 req/min
上下文     64k/请求；state + 单个最长问题 ≤ 32k
输入       仅文本
Choice     ≤ 255 个选项
Score      2–10 档（11 档直接报服务器错误）
Noul       0–1，无 confidence 字段
错误       401 / 422 / 429（退避）/ 529（延迟重试）
并发       6 安全，8 开始踩线
语言       英语最好；中日韩"可以处理但效果不一"
JS SDK     @typesafe-ai/sdk（Node 20+）
```

---

上一篇：[08-短板与评测校准](08-短板与评测校准.md) ·
下一篇：[10-对 Lumii 的落地评估](10-对Lumii的落地评估.md)
