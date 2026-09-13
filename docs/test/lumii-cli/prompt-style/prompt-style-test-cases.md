# 提示词风格实验（PS）CLI 场景化验收用例

> 所属：提示词风格实验 P1-T5 场景化验收
> 设计依据：`docs/design/AGENT优化/2026-09-13-prompt-style-experiment-design.md` §6.2（评审已确认的用户旅程）
> 执行器：[run-prompt-style-e2e.mjs](./run-prompt-style-e2e.mjs)；产物：`prompt-style-suite-evidence.jsonl` + `prompt-style-suite-report.md`
> 规范：CLI-TEST-SPEC.md（L3 真实聊天模拟；软/硬断言；探针命名空间）

## 验收目的

1. **编排正确性（硬断言）**：真实回合的完整提示词转储（`[llm-prompt]` + `[llm-prompt:full:begin/end]`，2026-09-13 新增观测）显示 two 档各自渲染符合设计（terse 带展开引导、detailed 带完整细则）。
2. **任务实施差别（软断言 + 指标）**：同一真实任务分别在 detailed / terse 下执行，记录完成情况、展开引导调用、提示词体量与回合耗时，作为两档对照数据。

## 场景来源与裁剪说明（重要）

场景取自设计 §6.2 评审确认的旅程。其中**微信渠道**两场景（建定时提醒、微信发文件）依赖真实微信会话上下文，`lumii-ui` CLI 无法注入渠道会话，故：

- 「定时提醒」取其**主聊天等价路径**（同一 cron 能力链路，主 Agent 会话）；
- 「微信发文件（weixin_send_guide）」保留为**人工验证项**（随 P1-T5 清单在真实微信会话中执行），不在本套件内。

## 探针与副作用

- 探针会话标题前缀 `[ps-suite]`，运行后保留供人工核查。
- 定时提醒用例创建真实 cron 行（taskText 含唯一短语「给物业打电话确认快递」）；用例在 `finally` 中按该短语删除探针行（含 runs），失败也会清理。
- 代码任务写入 `outputs/` 下的新任务目录（按 mtime 定位新增文件）；用例结束删除本次新增文件/目录并在证据中记录路径。
- 运行期间会**临时切换全局提示词风格**（真实设置写入），套件结束恢复运行前取值；`PS_NO_RESTORE=1` 可跳过恢复便于人工观察。

## 用例

#### PS-LOG-01 详细档真实提示词转储形态（编排正确性）
- **优先级**: P0
- **前置**: 应用运行；日志通道可用；`settings set promptStyle.style detailed`
- **步骤**: 1) 切 detailed 并回读确认 2) 新建探针会话 3) 发送真实请求：「帮我把这句话润色一下：周五之前把方案发给老王」
- **预期**: 日志出现 `[llm-prompt] … style=detailed`；full 块含 `### Disk-Index Pattern` 与 `## Tool Naming Contract`；不含 `prompt_guide(section:`
- **断言**: 日志=硬
- **预计回合**: 1

#### PS-LOG-02 简要档真实提示词转储形态（编排正确性）
- **优先级**: P0
- **前置**: 同 PS-LOG-01；`settings set promptStyle.style terse`
- **步骤**: 1) 切 terse 并回读确认 2) 新建探针会话 3) 同上真实请求
- **预期**: 日志出现 `[llm-prompt] … style=terse`；full 块含 `prompt_guide(section: "operatingPrinciples")` 与 `prompt_guide(section: "fileOutput")`；不含 `### Disk-Index Pattern`
- **断言**: 日志=硬
- **预计回合**: 1

#### PS-TASK-01 定时提醒（真实任务，双档各一遍）
- **优先级**: P0
- **前置**: 对应档位已切换
- **真实口吻话术**: 「明天早上九点提醒我给物业打电话确认快递」
- **步骤**: 新建会话 → sendAndWait
- **预期**: 回合完成；`local_cron_jobs` 新增含该短语的行（硬）；回复体现已创建提醒（软）；terse 档下应观察到 `cron_guide` 调用或等价行为（软，记入对照指标）
- **断言**: DB=硬；语义/引导=软
- **预计回合**: 1

#### PS-TASK-02 代码小任务（真实任务，双档各一遍）
- **优先级**: P0
- **前置**: 对应档位已切换
- **真实口吻话术**: 轮1「帮我写个 Python 小脚本，运行后打印今天的日期，放到工作区 outputs 里」；轮2「再加一下，把星期几也打印出来」
- **步骤**: 新建会话 → sendAndWait（轮1）→ sendAndWait（轮2）
- **预期**: outputs 下新增 `.py` 文件（硬，按运行前 mtime 基线定位）；轮2 后该文件被修改且含星期相关逻辑（硬）；terse 档下应观察到 `prompt_guide` 调用或等价行为（软）
- **断言**: 文件=硬；行为=软
- **预计回合**: 2

#### PS-TASK-03 会话内连续性（真实任务，双档各一遍）
- **优先级**: P1
- **前置**: 对应档位已切换
- **真实口吻话术**: 轮1「记住一个事：我们项目代号叫『青竹』，以后我说青竹就是指这个项目」；轮2「青竹是什么项目来着？」
- **步骤**: 同会话两轮 sendAndWait
- **预期**: 轮2 回复含「青竹」（软）；两轮的 `[llm-prompt]` chars 接近（terse 下会话延续不跳变，软指标）
- **断言**: 语义=软
- **预计回合**: 2

#### PS-CMP-01 双档对照汇总（报告节）
- **说明**: 非独立回合；执行器在报告「双档对照」表汇总各任务的：完成（硬断言结果）/ 回合耗时 / 提示词字符数（`[llm-prompt]` chars）/ 展开引导命中（terse）/ 细则在场（detailed）

## 人工验证补充（不在本套件内）

- 微信渠道：建定时提醒（观察 `cron_guide`）、发文件（观察 `weixin_send_guide`）——需真实微信会话；
- 实验页开关手动切换 + `system_prompt` 工具读回形态；
- 长对话 + 记忆保存回归（记忆注入链路）。
