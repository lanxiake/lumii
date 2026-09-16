# CK · 灵栖情报 / 灵栖维护 专项用例

> 执行器：[`run-agent-curation-e2e.mjs`](./run-agent-curation-e2e.mjs)
> 规范：[CLI-TEST-SPEC.md](../CLI-TEST-SPEC.md) · 计划：[专项 Agent 片 11](../../../plans/专项Agent/11-情报与维护深化.md)
> 覆盖两件事：**归属与可见性**（这两位名下的任务要出现在侧栏对应分组）、
> **职责能力**（它们是否真拿得到干活所需的材料）。

## 一、为什么需要这个套件

现有 AT 套件（`docs/test/lumii-cli/agent-team/`）对这两位的覆盖只有 AT-S9 一条
（「news-pipeline 由 info-curator 执行」），且它是**按预置 id 断言**的——
用户自建的资讯任务、手动抓取路径、维护的取数能力都不在覆盖范围内。
2026-09-16 排查「情报/维护名下一条任务都没有」时发现的三处缺口，就是这个盲区漏掉的：

1. 概览页「立即抓取」写死 `assistant` + `cron:news-pipeline`，与定时路径分裂成两条记录；
2. 用户自建的资讯任务不会被按 id 认领的迁移覆盖；
3. 维护的记忆读视图是缺省 `own`，而它自己不干活、名下为空——「记忆体检」无从下手。

## 二、分层

| 层 | 用例 | 是否需要 LLM | 说明 |
|---|---|---|---|
| L1/L2 数据链路 | CK-01 ~ CK-04 | 否 | 查库断言归属与任务定义，秒级 |
| L3 真实对话 | CK-05 ~ CK-09 | 是 | 建指定 Agent 的会话跑真回合/真任务 |

`CK_SKIP_LLM=1` 可离线跑 L1/L2。`CK_ONLY=CK-05,CK-08` 选择性运行。

## 三、用例

### L1/L2

| id | 断言 | 为什么这么判 |
|---|---|---|
| CK-01 | 全部启用中的资讯任务（`task_text LIKE '%dashboard_feed_write%'`）执行者都是 `info-curator` | 判定依据取「指令里调用了资讯卡工具」而不是任务名或 id——任务名用户随手可改，id 更是 |
| CK-02 | `seed-workspace-tidy` 的执行者是 `system-keeper` | 维护的活归维护 |
| CK-03 | 资讯任务会话的参与者是 `info-curator` | **这正是侧栏分组的输入**（侧栏按会话参与者归组） |
| CK-03b | `cron:seed-workspace-tidy` 会话归属 `system-keeper` | 维护侧同理；任务没跑过时会话尚未建立，SKIP |
| CK-04 | `wiki-purge-*` 仍是 `agent_id = null` | 守住边界：它们是确定性 companion 通道，不该被归属迁移改成 LLM 任务 |

### L3（真实 LLM）

| id | 步骤 | 断言 | 备注 |
|---|---|---|---|
| CK-05 | 建 **system-keeper** 会话，让它用 `memory_manage list` 报告读到的条目来自哪些 agent | 命中了库里除自己以外的写入者，且没有报「为空」 | 「记忆体检」的前提：读不到全用户记忆就等于在量空气 |
| CK-06 | 建 **info-curator** 会话，问它资讯卡上有多少条、最新一条标题 | 调用了 `dashboard_feed_read`，且报出**总数或最新条目标题** | 断言标题比断言条数强：总数会随抓取漂移，标题必须真读到才说得出 |
| CK-07 | 真跑一轮资讯任务（`cron run <jobId>`） | 资讯卡**新增一期**，条目数 > 0、综述非空 | 不断言消息级 `agent_id`（流式落库不带该字段，属既有缺口）；归属的正确载体是会话参与者与期上的 source |
| CK-08 | 建 **system-keeper** 会话，让它做一次记忆体检并用 `maintenance_report_write` 落库 | `maintenance_reports` 新增一行，`agent_id=system-keeper`、summary 非空、findings 是数组 | 报告「看得见」是这一片的全部意义 |
| CK-09 | 让它跑 `asset_checkup` 并原样列出返回项 | 调用了工具，且报出 ≥5 个代码约定的 key（`memory:profile-budget` 等） | 那几个 key 是代码里的字面量，模型编不出来——命中即证明机械项真由代码跑出 |

> **建会话必须指定 Agent**：`conversation create` 子命令不带 agentId（默认建主助手会话）。
> 本套件走命令总线 `command conversation:create --data '{"agentId":"…"}'`。
> 传错 Agent 会让整个用例变成在测主助手——CK-05 首轮就是这么误报的。

## 四、副作用与恢复

- 只新建 `[agent-curation]` 前缀的探针会话，保留不删（人工排查时可回看）；
- CK-07 会真实抓取资讯并追加卡片条目（该任务的正常产出，不做回滚）；
- 不修改任何用户配置；CK-05/CK-08 在指令里明确要求「只读、不要修改」。

## 五、未纳入自动化的项

| 项 | 原因 |
|---|---|
| 概览页「立即抓取」走同一个会话与执行者 | 该 IPC（`dashboard-feed:refresh`）不在命令总线白名单里，CLI 触发不到；由 `apps/windows/src/main/news-feed-job.test.ts` 的定位单测守（会话 id / 标题 / 执行者三个取值与调度器同口径） |
| 资讯卡期刊渲染的视觉呈现 | 渲染断言由 `NewsFeed.test.tsx` 覆盖（默认只展开最新一期、折叠期仍显示时间/来源/条数/综述、点期头展开），截图回归成本高于收益 |
| 资产体检卡的渲染与跳转 | 由 `AssetCheckup.test.tsx` 覆盖（三段式、差分条、点条目预填追问） |
