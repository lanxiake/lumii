# 提示词风格实验 P2 实施计划（terse 极致覆盖 + 结构重排 + 缓存安全）

> 日期：2026-09-13（与 P1 同分支 `feat/prompt-style-experiment`）
> 前置：`docs/design/AGENT优化/2026-09-13-prompt-style-experiment-design.md`（§7 P2 范围、§5 段表）
> P1 实施记录：`2026-09-13-prompt-style-experiment-implementation.md`
> 本会话拍板：① 结构按五块重排（两风格共用新顺序，detailed 文案逐字节不变，只搬家）；② 修复 Router 逐轮改静态区导致的缓存失配；③ terse 目标"极简"，全部走 guide 兜底。

---

## 1. 缓存机制事实（2026-09-13 实勘，`apps/windows/out/main/index.js`）

- bundled LLM 客户端把**整份 systemPrompt 作为单个 `cache_control: {type:"ephemeral"}` 块**（另在消息末尾一个断点）。
- 推论：缓存命中条件 = **整份系统提示词逐字节稳定**。段序重排 = 一次性重建（用户显式操作，可接受）；真正的破坏源是**逐轮变化**混入提示词。
- 既存违规：Router 高置信时 `routerFilteredSkills/Agents` **每轮改静态区**（任务回合与闲聊回合字节不同 → 整份失配；且 topSkills 为空时 Skills 段会整体消失）。今天日志未触发仅因样本都是问候语。
- **P2 修复**：静态区列表恒定且完整；路由建议只留在动态 `routingRationale`（已存在）。属行为变化，独立提交可回退。

## 2. 结构重排（新顺序 = builder emit 顺序，两风格共用）

```
① 身份     identity → permissionMode
② 规则     systemRules → operatingPrinciples → progressUpdates → verification
           → toolNamingContract(detailed) → safety → language → taskCompletion
           → silentReplies → fileOutput
③ 能力索引  tooling → toolPreference → progressiveLoading → mcp → skills
           → bundledCapabilities → selfLearning → browser → wiki
④ 协作     taskOrchestration → subagentRole | agentCollaboration → deviceControl
⑤ 渠道     messaging
```

- 块内顺序对齐 registry `group`；identity 恒为首；**dynamic 区顺序不动**（单断点缓存下无收益，Hermes 借鉴项记档）。
- 快照"仅搬家"校验：重生成后按 `## ` 切块比较旧/新 snapshot 正文**多重集相等**（新增 guide 行除外）。
- 红线语义不变：safety/verification/language/taskCompletion 等 terse:false 段照旧渲染完整文案。

## 3. terse 覆盖清单（新增批次；预估基于真实抓取体量）

| 段 | detailed 体量 | terse 处理 | 预估 |
|---|---|---|---|
| tooling | 4574 | 折叠为「组名 + 数量」；组注保留极简一行；`prompt_guide("tooling")` | ~1.0k |
| toolPreference | 含上 | 并入 tooling terse 一行（信息获取优先级链） | — |
| skills | 4371 | MUST 句 + **top-12 名称（去描述）** + "N more via `skill_search`" | ~0.6k |
| agentCollaboration | 2373 | Agent 列表保留（索引本体）；委派话术/结果处理正文移 guide | ~1.0k |
| taskOrchestration | 1496 | 3 行（batch_create / async 完成时序 / 收尾）+ guide | ~0.35k |
| wiki | 1497 | 读序一行保留；folder import CLI 流程移 guide | ~0.2k |
| systemRules | 561 | 保留 2 条 MUST 句 + 条件行（本就短，压缩有限） | ~0.35k |
| selfLearning | 471 | 一行 | ~0.12k |
| deviceControl | — | 单行（设计 §5「compact 单行」原案） | 一行 |
| contextManagement（动态） | 408 | 一行（保留持久化契约） | ~0.15k |
| userDevices（动态） | — | 压缩说明行，列表保持 | 略 |

预计 terse 整份 28.8k → **~16.5k**（相对 detailed ~-50%）。

## 4. 实施步骤

| 步 | 内容 | 校验 |
|---|---|---|
| P2-1 | 结构重排（纯搬家，逐字节内容不变） | 快照重生成 + 仅搬家多重集校验；agent-runtime 全量 |
| P2-2 | Router 静态过滤修复（独立提交） | builder/dispatcher 测试同步；快照不变 |
| P2-3 | terse 批次1：tooling 折叠 + toolPreference 并入 + guide 正文 | 段级字面量断言；字符计量 |
| P2-4 | terse 批次2：skills / agentCollaboration / taskOrchestration | 同上 |
| P2-5 | terse 批次3：wiki / systemRules / selfLearning / deviceControl + contextManagement / userDevices | 同上 |
| P2-6 | 注册表 terse 标记、stale `cron` id 清理、守卫测试覆盖、实验页文案核对 | 守卫测试全绿 |
| P2-7 | 真实双档转储实测（chars 对照）+ 测试文档归档 + 提交 | 转储对比表 |

## 5. 验收

- `@mtbot/agent-runtime` 全量测试绿（P1 基线 1863 用例）；
- apps/windows 定点复跑无新增失败（既有基线 20 失败/6 文件）；
- 快照仅搬家校验通过（detailed 内容多重集不变）；
- 守卫：红线段 terse:false 恒定、terse 段必带 expandVia、guide 字面量可发现（含新段）；
- 真实日志双档对照：terse 相对 detailed 的整份与段级降幅达标。
