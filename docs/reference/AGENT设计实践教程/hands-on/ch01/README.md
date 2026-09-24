# 第 1 章动手实验：最小可运行 Agent Loop

对应章节：《第 1 章 · Agent 系统演化全景》§二.4、§六。

## 文件清单

| 文件 | 作用 |
|---|---|
| `agent_loop.py` | 全部代码（222 行，纯标准库）：工具层 / 模型层 / 循环 |
| `sample_data/orders.md` | `read_file` 工具的样例数据（虚构） |
| `notes.md` | 运行后由 `append_note` 工具生成，演示“会话外留痕” |

## 运行方式

```bash
# 方式一：离线降级模式（推荐先跑这个，不需要任何 key）
python agent_loop.py
# 等价于：python agent_loop.py --offline

# 方式二：连真实的 OpenAI 兼容接口
set OPENAI_API_KEY=sk-...            # Windows；Linux/macOS 用 export
set OPENAI_BASE_URL=https://api.openai.com/v1   # 任何兼容网关均可
set MODEL_NAME=gpt-4o-mini            # 可选
python agent_loop.py "先计算 (128+64)*3，再读取 sample_data/orders.md，最后把结果记录为一条备注。"
```

> 注意：未设置 `OPENAI_API_KEY` 时程序自动落回离线桩模型，不会偷偷调 API。

## 预期输出（离线模式，实测于 Python 3.11 / Windows）

```
[模式] 离线桩模型（StubModel）——不调用任何 API，只为看清控制流

=== 任务 ===
先计算 (128+64)*3，再读取 sample_data/orders.md，最后把结果记录为一条备注。

--- 第 1 步 ---
assistant: (stub) 我决定调用 calculator。
[calculator]({'expr': '(128+64)*3'}) -> 576

--- 第 2 步 ---
assistant: (stub) 我决定调用 read_file。
[read_file]({'path': 'sample_data/orders.md'}) -> # 样例数据：orders.md
本季度订单概况（虚构数据，仅供实验）：
...（表格略）

--- 第 3 步 ---
assistant: (stub) 我决定调用 append_note。
[append_note]({'text': '任务[先计算 (128+64)*3，再读取 s…]的关键结果已由 stub 汇总'}) -> 已追加一条备注（40 字符）

--- 第 4 步 ---
assistant: (stub) 任务完成。已执行 3 次工具调用：...

[终止] 第 4 步无工具调用，采纳最终回答
```

## 你应该观察到什么

1. **循环与模型解耦**：`agent_loop()` 一行没改，只是把传给它的 `model` 从
   `call_openai` 换成 `StubModel`——这就是“agent = model + harness”的最小体现。
2. **两类终止条件各跑各的**：正常任务走“第 4 步无工具调用 → 采纳回答”；
   把 `MAX_STEPS` 改成 2 再跑，会走“达到最大步数，强制停止”。
3. **错误是上下文的一部分**：跑 `python agent_loop.py --offline "读取 missing.md"`，
   能看到 `ERROR: 文件不存在` 作为工具结果回填，下一轮模型基于它继续行动——
   工具失败时抛异常会炸掉整个循环，返回错误字符串才让 agent 有机会自救。
4. **每步打印的轨迹就是台账**：`--- 第 k 步 ---` 的打印不是 debug 装饰，
   生产系统里这份轨迹（trajectory）是评估、回放、计费的第一手材料。
5. **messages 列表就是上下文的全部**：在第 3 步给 `messages` 打个断点或打印
   长度，你会看到它逐步膨胀——第 1 章讲的“上下文是有限资源”在这里肉眼可见。

## 小实验（建议按顺序做）

| # | 改动 | 预期现象 | 对应概念 |
|---|---|---|---|
| 1 | `MAX_STEPS = 2` 跑演示任务 | 走最大步数终止，无最终回答 | 终止条件、成本控制 |
| 2 | 在 `TOOLS` 里新增第 4 个工具（如 `word_count`），`StubModel._plan` 不动 | 桩模型不会用它，但 API 模式下模型会发现并使用 | 工具面即能力面；工具是加出来的，不是练出来的 |
| 3 | 把 `tool_read_file` 的沙箱检查删掉，传 `../../etc/passwd` 或 `C:\Windows\win.ini` | 越界读取成功——这就是不加护栏的代价 | 沙箱与护栏（Anthropic 建议沙箱内测试） |
| 4 | 把 `MAX_RESULT_CHARS` 改成 40 再跑 | 回填内容变少，stub 的最终汇总随之变短 | 上下文工程：结果先压缩再回填 |
| 5 | （有 API 时）把 `SYSTEM_PROMPT` 里工具名删掉一个 | 模型大概率不再调该工具或调用报错 | ACI：模型只认识你写给它的那份接口说明书 |

## 代码结构导读

```
agent_loop.py
├─ 工具层    tool_calculator / tool_read_file / tool_append_note + TOOLS 注册表（schema+实现）
├─ 模型层    call_openai（真实 API，OpenAI 兼容）│  StubModel（离线桩，接口相同）
└─ 循环层    agent_loop：组装上下文 → 调模型 → 执行工具 → 回填结果 → 判终止
```

## 已知局限（教学简化，别当生产代码）

- 无流式输出、无并行工具调用、无重试与超时退避、无费用统计。
- `StubModel` 用正则猜任务，真实模型才是“决定下一步”的主体。
- 没有做上下文压缩：长任务会无限膨胀 `messages`，真实 harness 需要
  截断/摘要/外部化状态（第 2 章主题）。
