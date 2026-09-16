---
name: system-keeper-handbook
description: Lumii 系统维护手册——Wiki / 记忆 / 用户指南三类资产的地图、整理流程、客户端自动化操作方法与红线。当需要整理资料库、清理记忆、更新用户指南、检查系统配置一致性，或需要修改客户端设置时使用。
---

# 系统维护手册（灵栖维护）

本手册是「灵栖维护」Agent 的领域知识地基：动手前先读对应章节，不要凭印象描述系统机制。

## 0. 例行体检：固定顺序与判据

体检是**读 + 判断**，不改任何东西。分两步走：

**第一步：机械项交给 `asset_checkup`**（一次调用，确定、零成本、每轮一致）

`asset_checkup({ scope: 'memory' })` 返回逐项结论，每项带 `key` / `status`（ok / issue / skipped）/ `detail` / `candidates[]`：

| key | 查什么 | 什么算问题 |
|---|---|---|
| `memory:profile-budget` | 偏好层字符数 vs 2400 注入预算、空章节 | 超预算 = 截断线外的重要信息**每轮都读不到** |
| `memory:working-duplicates` | 内容逐字相同的工作记忆 | 同一条事实存了两份 |
| `memory:json-residue` | 正文以 `"}]` / `!}]` 结尾 | 提取链路把 JSON 片段截进了正文 |
| `memory:instruction-residue` | 含「只回复…」这类指令式话术 | 被注入后续会话可能压制真实回复 |
| `memory:stale` | 30 天未用且重要度 < 0.5 | 过期条目 |
| `memory:tiny-entries` | 正文不足 6 字 | 提取噪声 |

**第二步：机械项判不了的交给你**

- **互相矛盾**：两条记忆说法冲突（如「默认用 npm」vs「默认用 pnpm」）；
- **层级错放**：跨项目的通用习惯记在工作记忆里，本该进偏好层；
- **语义重复**：措辞不同但说的是同一件事（机械项只抓逐字相同）；
- **归并判断**：哪些该保留、哪些该删、哪些该合并成一条。

四类资产按「谁影响面最大」排序，每次巡检按此顺序走一遍：

| 序 | 资产 | 看什么 | 依据从哪来 |
|---|------|--------|-----------|
| 1 | 用户偏好层 | 是否超过注入预算、章节是否重复/矛盾、是否混入一次性信息 | `asset_checkup` 的预算项 + `profile_memory read_memory` 全文 |
| 2 | 工作记忆 | 矛盾、层级错放、语义重复 | `asset_checkup` 的机械项 + `memory_manage action=window` 看细节 |
| 3 | Wiki | 重复页（`content_hash` 相同）、空页、孤儿页、主题错位 | `wiki_overview` 看分类分布与最近条目；`wiki_search` 抽检 |
| 4 | 用户指南 | 与最近功能变更是否脱节 | 对照仓库最近提交 / 用户提到的新功能 |

**没有问题的项也要一句话交代**（「工作记忆 228 条，未发现重复」），否则用户无法判断你是查过了还是漏了。
`asset_checkup` 的 ok 项直接可以当这份交代用。

## 1. 资产地图

### 1.1 Wiki（资料库）

- 数据在本地 SQLite：`wiki_sources`（资料层，正文可存库内 `native` 或引用外部文件 `ref`/`materialized`）、`wiki_pages`（遗留，勿再写入）、`wiki_inbox`（自动摄入的待整理文件）、`wiki_organize_runs`（自动分类审计）。
- **自动整理流程已存在**：`wiki-organizer` 是**事件驱动**的串行队列（新文件入队即触发，失败按退避阶梯重试），不是定时轮询；你不需要重复实现分类。
- **去重检测已存在但只出建议**：`wiki-cleanup` 按 `content_hash` 标记 `duplicate_content`。
- **命令总线里没有「合并」原语**。所谓合并只能拆成：确认后归档旧页（`wiki source archive`）+ 保留/新建一份完整页。别承诺做不到的动作。
- 你的职责是**策展**：重复合并建议、主题错位归位、空页与孤儿页归档、坏链清理。写入通过 `bash` 调用 `lumii-ui`（命令总线白名单含 wiki 写操作）。

### 1.2 记忆（三层）

- **用户偏好层**：`~/.lumii/data/user-memory.md`。每轮对话自动注入，预算 2400 字符（按 `## ` 章节边界截断）——**超出部分每轮都读不到**，是整理的第一优先级。经 `profile_memory` 工具读写（read_memory/update_memory/append/remove_section），写入路径自带 `.bak` 备份。
- **工作记忆（per-agent）**：`agent_memories` 表，经 `memory_search` / `memory_read` / `memory_manage`（list/window/add/update/delete/archive/clear）读写。**你读的是全用户视图**（所有 Agent 写的条目都看得到，每条带 `agent_id` 与 `created_at`）；写仍记在你名下。维护时清理：重复表述、一次性信息、已被更高层记忆覆盖的条目。
- **场景记忆**：项目记忆在 `<项目>/.lumii/memory.md`；渠道记忆在 `~/.lumii/data/scene-memory/`。经 `scene_memory` 工具维护（**无 .bak 备份**，改写前先 `read` 存一份原文）。

### 1.3 用户指南

- 源文件：`docs/guide/*.md`（+ `assets/` 截图）；生成脚本 `pnpm sync:guides`（apps/windows），产物写入 `apps/windows/resources/user-guides/` 并随安装包分发。
- 应用内展示入口：资料库抽屉经 `app:guides:list/read` 读取；manifest 预留 `seedToWiki` 字段（未来可作为 Wiki 种子）。
- 你的职责：功能变更后同步指南文案（改 `docs/guide` → 跑脚本 → 校验 manifest 的 `updatedAt`），不做大规模重写。

## 2. 操作手册（客户端自动化）

- **设置读写**：`lumii-ui settings get <key.path>` 读取；`lumii-ui settings set <key> <value>` 写入（经本机 HTTP 控制面 + Bearer）。只允许操作白名单键；拿不准的键先 `get` 再决定。`privacy.allowAgentAppUiControl` 是不可写字段，改不了自己。
- **工具开关**：命令总线 `tools:toggle`；禁用列表存储在 runtime_state。
- **界面操作**：`app_goto`（打开视图）→ `app_scroll_to_text` / `app_scroll_to_bottom` 定位 → `app_act` / `app_fill_form` 操作 → `app_screenshot` 截图确认。前提：设置页已开启 `privacy.allowAgentAppUiControl`。
- **单轮配额**（每分钟按固定速率续杯，上限封顶）：截图 base 40 / 续杯 20 / 封顶 300；操作 act base 120 / 续杯 60 / 封顶 900；导航 goto base 60 / 续杯 20 / 封顶 300；高层组合工具 base 30 / 续杯 20 / 封顶 300。配额按**轮**计，超限返回 `quota_exceeded` 并告知重试等待秒数——不要硬撞，改成先出结论再补图。
- **定时任务**：`cron_create` / `cron_list` / `cron_delete` / `cron_guide`。`cron_create` 只接受 `at`（时间戳）与 `every`（毫秒间隔）两种排期，**不接受 cron 表达式**；需要「每周日 20:00」这类周期，用 `every` 配 `7*24*3600*1000` 毫秒，或建议用户在定时任务页建。你自建的任务 id 以 `local-cron-` 开头（规划器落地的历史任务为 `agent-self:`），**只有这两类你能用 `cron_delete` 撤掉**；用户创建（UUID）与系统预置（`seed-*` / `news-pipeline`）的只能建议用户在任务页处理。
- **常见排查**：
  - 心跳不跑 → 先查 `messages` 表是否有 `is_streaming=1` 残留（abort 占位会让心跳全部空转）；
  - 编码 CLI 不可用 → 用设置页「开发类 AI 工具」检测安装状态；
  - 渠道收不到消息 → 检查渠道账号登录态与 `notify_targets` 配置。

## 3. 边界与红线

| 动作 | 规则 |
|------|------|
| 读、扫描、出报告 | 可直接做 |
| 记忆写入 / 瘦身 | 可做（写路径自带 `.bak`）；产出摘要 |
| 场景记忆改写 | 可做，但**无 .bak**：先 `read` 存原文再改 |
| Wiki 归档 / 删除 | **必须用户确认**后执行 |
| 设置变更 | **必须用户在场**（自主运行只建议） |
| 删除用户创建的定时任务 | **必须用户确认** |
| 自主运行（无人在场） | 只做只读体检 + 建议，不做任何改动 |

## 4. 报告的落库形态

体检结束时**必须调用 `maintenance_report_write`**——只把结论写在对话里，用户在概览页看不到，
也没法判断「上次发现的问题这次还在不在」：

```
maintenance_report_write({
  scope: 'memory' | 'wiki' | 'guides' | 'settings' | 'workspace' | 'full',
  summary: '一句话结论（直接显示在概览页卡片正面）',
  findings: [
    { key: 'memory:duplicate',        // 跨期稳定标识：系统靠它算「上期有、这期没了 = 已解决」
      severity: 'high' | 'medium' | 'low',
      title: '问题一句话',
      evidence: '判断依据：数据 / 文件 / 行号',
      suggestion: '建议动作' },
  ],
  checked: ['工作记忆：228 条，未发现重复'],   // 查过且没问题的项
})
```

要点：

- **key 必须跨期稳定**（形如 `<资产>:<问题>`）。写成每期不同的字符串，差分就失效，
  同一个问题会被反复算成「新发现」。**不要拿 title 当 key**——它每期措辞都会变。
- `checked` 不能省：只报「发现 3 项」而不说「另外 4 项查过没事」，用户无法判断是没查还是真没事。
- 开跑之前先 `maintenance_report_read`：上期的 key 与建议就是你这期的起点，
  对还在的问题直接沿用同一个 key，对已经消失的不必再报（系统会算作已解决）。
- 落库之后再在会话里回一句简短摘要（结论 + 待处理条数），细节以卡片为准。
