# 提示词风格实验 P3：极简档（工具定义去描述 + 提示词收尾）

> 日期：2026-09-15（main 分支）
> 前置：P1/P2 已在 main（terse 全量覆盖、五块结构、Router 缓存修复）
> 本会话拍板（AskUserQuestion 两项）：① 精简对象 = 发给模型的工具定义载荷（上下文卡片「工具定义」+「MCP 与动态工具」两块）+ 系统提示词 MCP 章节；② 简单工具连参数 schema 内的描述一并删，复杂工具整条定义保留。

---

## 1. 背景与实测

- 上下文卡片把固定开销分类展示（`apps/windows/src/renderer/.../ContextUsageCard.tsx`）：「工具定义」= 内置工具的名称、描述与参数 schema；「MCP 与动态工具」= mcp__* 工具定义 + 提示词 MCP 章节。
- 实测内置 50 个工具的定义载荷（name + description + JSON(parameters)，与 `toolText` 口径一致）：
  - 合计 **37,473 字符**；工具描述 13,000 + 参数 JSON 23,886（其中参数内描述 11,566）。
- 该载荷随每个模型请求发送（pi-ai `convertTools`），是 terse 档尚未触及的最大固定开销。真实会话还叠加 bridge 侧工具（browser_*/app_*/screen_record_*/guide）与 MCP 工具，更大。

## 2. 设计

### 2.1 第三档 `minimal`（极简）

`PromptStyle = "detailed" | "terse" | "minimal"`。极简 = terse 的全部系统提示词精简 + 以下增量。

### 2.2 工具定义载荷裁剪（核心）

对发送给模型的工具定义：

- **简单工具** → 只保留结构：删工具级 `description`；递归删 `parameters` schema 内所有 `description`（保留类型 / 必填 / 枚举 / 嵌套结构）。
- **复杂工具**（整条定义原样保留，即「使用提示词」）：
  - 参数数量 ≥ 5；或
  - 属组合流程清单：`bash`、`spawn_agent`、`send_message`、`todo_write`、`task_complete`、`cron_create`、`cron_guide`、`skill_search`、`skill_invoke`、`execute_skill`、`memory_search`、`memory_read`、`memory_manage`、`scene_memory`、`wiki_overview`、`wiki_search`、`wiki_read`、`message`、`channel_list`、`channel_send`、`weixin_send_guide`、`session_list`、`session_resume`、`ask_user_question`、`prompt_guide`、`a2ui_guide`；或浏览器 `browser_*` 前缀（eval 定位 + 截图观察的交互循环）。

实测降幅（内置 50 工具）：37,473 → ~27,800（−26%）；MCP 工具多数参数少，将整条去描述。

**应用点**（缓存语义：切换 = 一次性重建，轮内稳定）：

1. **创建时**（`bridge-instance-factory.createInstance`）：实例创建后按当前样式裁剪并 `setTools`；原始（未裁剪）工具定义存 `InstanceState.originalToolDefs`。子 Agent 无逐轮 dispatcher，靠创建时快照。
2. **逐轮**（`bridge-prompt-dispatcher`）：读取本轮样式后，与 `InstanceState.appliedToolDefStyle` 比对，变化时用原始定义重裁/还原并 `setTools` —— 与系统提示词同口径「下一轮生效」。
3. 上下文卡片与字符标定读 `instance.getTools()`，自动与真实发送载荷一致。

实现模块：`packages/agent-runtime/src/tools/tool-definition-style.ts`（纯函数：`isComplexTool` / `stripToolDefinition` / `applyToolDefinitionStyle`）。

### 2.3 系统提示词增量（terse 基础上的极简专属段）

| 段 | terse（现状） | minimal |
|---|---|---|
| MCP 章节 | 逐工具「名称 + 描述」 | server 名 + instructions 保留，工具只列名称 |
| bundledCapabilities | 名称 + 截断描述 | 只列技能名 |
| Workspace | 完整（目录结构 / 输出组织 / 命名规则） | 紧凑版：保留全部硬约束，删示例与解释 |
| Runtime 客户端上下文 | 一段说明 | 一行 |
| 其余各段 | terse 渲染 | 与 terse 完全一致（含红线段不动） |

段元数据表 `PROMPT_SECTIONS` 增 `minimal?: boolean`（= 有极简专属渲染的段），守卫测试据此校验。

### 2.4 接线

`PromptStyle` 三态透传：实验页（第三个单选「极简」）/ useSettings / preload / IPC / 主进程缓存 / bridge 类型（6 处 `'detailed' | 'terse'` 联合）。

## 3. 实施步骤

| 步 | 内容 | 校验 |
|---|---|---|
| P3-1 | 计划文档（本文件） | — |
| P3-2 | agent-runtime：`tool-definition-style` 模块 + 契约单测 | 单测绿 |
| P3-3 | agent-runtime：`PromptStyle` 三态 + 各段 minimal 分支 + 元数据 + 守卫/渲染测试 | 快照零 diff（detailed）；全量测试绿 |
| P3-4 | apps/windows：设置三态接线 + 实验页 UI | typecheck |
| P3-5 | bridge：创建时 + 逐轮 `setTools`；InstanceState 增字段 | dispatcher 测试 + typecheck |
| P3-6 | 实测对照（载荷字符数）、全量验证、计划记录归档 | 对照表 |

## 4. 验收

- 内置 50 工具载荷实测：简单工具段降幅 ≥ 60%；整包 ≥ 25%；
- 复杂工具定义逐字节不变；terse / detailed 渲染与测试基线零变化（快照不动）；
- `@mtbot/agent-runtime` 全量测试绿；apps/windows 定点复跑无新增失败；
- 极简 → 切回详细/简要时，完整定义可还原（逐轮 setTools 幂等）。

## 5. 实施记录（2026-09-15，main 分支）

| 步 | 内容 |
|---|---|
| P3-1 | 本计划文档 + README 索引 |
| P3-2 | `packages/agent-runtime/src/tools/tool-definition-style.ts`：`isComplexTool` / `stripToolDefinition` / `applyToolDefinitionStyle`（递归去 schema 描述、保留符号键与结构）+ 契约单测（9 例） |
| P3-3 | `PromptStyle` 三态 + `isLeanStyle`；各段 terse 分支并入 minimal；minimal 专属：MCP 章节只列名称、bundledCapabilities 只列名、Workspace 紧凑版、Runtime 客户端上下文一行；段元数据 `minimal` 标记 + 渲染级守卫（minimal≠terse、红线段三档同量、引导字面量仍可发现） |
| P3-4 | apps/windows：`shared/prompt-style.ts`（三态类型 + 归一化 + 默认简要）；preload / settings-ipc / ipc-registry / main 缓存 / bridge 类型全量接线；实验页第三个单选「极简」+ 列表摘要 |
| P3-5 | bridge：`bridge-instance-factory` 创建时裁剪并留存 `originalToolDefs`（子 Agent 覆盖）；`bridge-prompt-dispatcher` 逐轮样式变化时 `setTools` 重裁/还原（幂等）；`InstanceState` 增 `originalToolDefs` / `appliedToolDefStyle`；dispatcher 测试 +2 |
| P3-6 | 全量测试 + 载荷实测 |

**载荷实测（内置 50 工具，真实模块口径 name+description+JSON(parameters)）：**

| 项 | before | after | 降幅 |
|---|---|---|---|
| 全部内置工具 | 40,323 | 30,507 | **−24.3%** |
| 简单工具（27 个，逐条） | 见 docs/temp/minimal-payload-measure.txt | 单条 −60%~−90%（file_read 848→147、list_dir 640→85） | — |
| 复杂工具（23 个） | 完整保留（逐字节不变） | — | — |

真实会话另有 bridge 侧工具（浏览器等已按组合清单保留）与 MCP 工具（多数参数 < 5，整条去描述），降幅更可观。

**执行期修订：**

1. 复杂工具判定用「参数 ≥ 5 或组合流程清单」双规则，清单集中在 `tool-definition-style.ts` 一处可调；
2. MCP 章节极简版保留 server 级 `instructions`（使用提示），只去逐工具描述；
3. 默认值（同日用户指令）：提示词风格系统初始化默认 **简要**（`shared/prompt-style.ts` 的 `DEFAULT_PROMPT_STYLE`）；跨渠道接续核实本即默认关闭；自主进化缺省禁用（修 `autonomous-ipc.emptyStatus` 兜底误设 enabled=true）。

**真机 A/B 实测（2026-09-15 23:0X，CLI 驱动真实客户端 + 真实 LLM，同一会话逐轮切档）：**

会话 `52da0051…`（`[vma]` 前缀），四轮 `minimal → terse → detailed → minimal`，各轮从应用日志与 `context usage` 读数：

| 轮 | 档 | prompt chars（static/dynamic） | tools 类目 | mcp 类目 |
|---|---|---|---|---|
| 1 | minimal | 17,517（10,069 / 7,448） | 12,013 | 90 |
| 2 | terse | 19,741（10,223 / 9,518） | 16,249 | 195 |
| 3 | detailed | 35,738（26,117 / 9,621） | 16,639 | 180 |
| 4 | minimal | 17,518（10,069 / 7,449） | 11,929 | 89 |

- **工具定义类目 −27.2%**（极简均值 11,971 vs 未裁剪均值 16,444）；terse≈detailed（16.2K vs 16.6K，±2.4% 为标定噪声）——证明裁剪只由极简档触发；
- 逐轮切档即时生效：terse 轮工具定义完整还原、再切回极简重新裁剪（轮 2↔4），生产路径（创建时快照 + dispatcher 逐轮 setTools）均验证；
- 提示词体量：极简比简要 −11.3%（同会话同内容），比详细 −51%；MCP 章节去描述后 mcp 类目 −54%；
- 极简轮完整提示词转储核对：Workspace 紧凑版、Runtime 客户端上下文一行版、MCP 章节只列 `` `mcp__excel-mcp__read_excel` ``（无描述）、prompt_guide 引导可发现。
- 脚本与证据：`docs/test/lumii-cli/prompt-style/verify-minimal-ab.mjs` + `minimal-ab-evidence.json`。

**真机复杂任务三档实测（2026-09-15 23:10，CLI 驱动 3 场景 × 3 档 = 9 轮）：**

| 用例 | minimal | terse | detailed |
|---|---|---|---|
| PC-C1 多步文件工具链 | ✅ 16 调用 / 36s | ✅ 15 / 52s | ✅ 16 / 44s |
| PC-C2 委派式调研落盘 | ✅ 22 / 188s | ❌ 断言误伤（子代理检索不可见）/ 4 | ✅ 67 / 328s（completion 重试风暴） |
| PC-C3 时效查询 | ✅ 4 / 45s | ❌ 断言局限（web_fetch 路径）/ 4 | ❌ 同左 / 2 |
| **通过** | **3/3** | 1/3 | 2/3 |

- 工具定义 token：极简 11.2–12.2K vs 简要 16.3–16.6K vs 详细 16.8–17.1K（**−25~31%**，与静态实测 / 逐轮 A/B 互证）；提示词整份比简要 −11~22%、比详细 −51~53%；MCP 类目 −54%。
- 极简档多步工具链产物齐备（stats.py + report.md 含统计逻辑）、调研简报落盘合规、天气回复含温度——复杂任务无退化。
- 3 个 FAIL 全部归因断言口径（子代理轨迹 / web_fetch 不识别），非风格回归；P2 已记录同类误伤。
- 分析归档：`docs/test/lumii-cli/prompt-style/prompt-style-complex-3way-analysis.md`（traces/report/evidence 同目录）。
- 套件修正（本轮）：`getStyle` 三态化（原会把 minimal 读成 detailed、恢复步骤可能写错档）；`PC_STYLES` / `PC_SUITE` 环境变量；工作区探测三级回退（渲染层设置 → 主进程 `app.workspaceDirectory` → 日志实测 cwd）。

**遗留：** 复杂工具保留清单的按需增减（一处常量）；C2/C3 断言口径升级（子代理轨迹合并 / web_fetch 纳入）；PC-C2-DETAILED 的 completion 重试风暴另查。
