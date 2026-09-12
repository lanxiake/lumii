---
name: system-keeper-handbook
description: Lumii 系统维护手册——Wiki / 记忆 / 用户指南三类资产的地图、整理流程、客户端自动化操作方法与红线。当需要整理资料库、清理记忆、更新用户指南、检查系统配置一致性，或需要修改客户端设置时使用。
---

# 系统维护手册（灵栖维护）

本手册是「灵栖维护」Agent 的领域知识地基：动手前先读对应章节，不要凭印象描述系统机制。

## 1. 资产地图

### 1.1 Wiki（资料库）

- 数据在本地 SQLite：`wiki_sources`（资料层，正文可存库内 `native` 或引用外部文件 `ref`/`materialized`）、`wiki_pages`（遗留，勿再写入）、`wiki_inbox`（自动摄入的待整理文件）、`wiki_organize_runs`（自动分类审计）。
- **自动整理流程已存在**：`wiki-organizer` 每 30 秒轮询一次，做「取件 → 提取 → 分类 → 落库」；你不需要重复实现分类。
- **去重检测已存在但只出建议**：`wiki-cleanup` 按 `content_hash` 标记 `duplicate_content`；「合并 / 归档」动作必须经用户确认后执行。
- 你的职责是**策展**：重复合并建议、主题错位归位、空页与孤儿页归档、坏链清理。写入通过 `bash` 调用 `lumii-ui`（命令总线白名单含 wiki 写操作）。

### 1.2 记忆（三层）

- **用户偏好层**：`~/.lumii/data/user-memory.md`。每轮对话自动注入，预算 2400 字符（按 `## ` 章节边界截断）——**超出部分每轮都读不到**，是整理的第一优先级。经 `profile_memory` 工具读写（read/update/append/remove_section），写入路径自带 `.bak` 备份。
- **工作记忆（per-agent）**：`agent_memories` 表，经 `memory_search` / `memory_read` / `memory_manage`（list/add/update/delete/archive/clear）读写。维护时清理：重复表述、一次性信息、已被更高层记忆覆盖的条目。
- **场景记忆**：项目记忆在 `<项目>/.lumii/memory.md`；渠道记忆在 `~/.lumii/data/scene-memory/`。经 `scene_memory` 工具维护。

### 1.3 用户指南

- 源文件：`docs/guide/*.md`（+ `assets/` 截图）；生成脚本 `pnpm sync:guides`（apps/windows），产物写入 `apps/windows/resources/user-guides/` 并随安装包分发。
- 应用内展示入口：资料库抽屉经 `app:guides:list/read` 读取；manifest 预留 `seedToWiki` 字段（未来可作为 Wiki 种子）。
- 你的职责：功能变更后同步指南文案（改 `docs/guide` → 跑脚本 → 校验 manifest 的 `updatedAt`），不做大规模重写。

## 2. 操作手册（客户端自动化）

- **设置读写**：`lumii-ui settings get <key.path>` 读取；`lumii-ui settings set <key> <value>` 写入（经本机 HTTP 控制面 + Bearer）。只允许操作白名单键；拿不准的键先 `get` 再决定。
- **工具开关**：命令总线 `tools:toggle`；禁用列表存储在 runtime_state。
- **界面操作**：`app_goto`（打开视图）→ `app_scroll_to_text` / `app_scroll_to_bottom` 定位 → `app_act` / `app_fill_form` 操作 → `app_screenshot` 截图确认。前提：设置页已开启 `privacy.allowAgentAppUiControl`；单轮操作有配额（27-114 次）。
- **定时任务**：`cron_create` / `cron_list` / `cron_delete` / `cron_guide`。你自建的任务 id 以 `agent-self:` 开头，可自行删改；用户创建的任务只能建议。
- **常见排查**：
  - 心跳不跑 → 先查 `messages` 表是否有 `is_streaming=1` 残留（abort 占位会让心跳全部空转）；
  - 编码 CLI 不可用 → 用设置页「开发类 AI 工具」检测安装状态；
  - 渠道收不到消息 → 检查渠道账号登录态与 `notify_targets` 配置。

## 3. 边界与红线

| 动作 | 规则 |
|------|------|
| 读、扫描、出报告 | 可直接做 |
| 记忆写入 / 瘦身 | 可做（写路径自带 `.bak`）；产出摘要 |
| Wiki 合并 / 归档 / 删除 | **必须用户确认**后执行 |
| 设置变更 | **必须用户在场**（自主运行只建议） |
| 删除用户创建的定时任务 | **必须用户确认** |
| 自主运行（无人在场） | 只做只读体检 + 建议，不做任何改动 |

## 4. 巡检报告模板

```
【维护巡检 · <资产名>】<日期>

发现（按严重度排序）：
1. <问题一句话>
   依据：<数据/文件/行号>
   建议：<动作>（风险：低/中/高）

无问题的项：<一句话带过>
```

- 报告先落当前会话；高优先级问题（数据损坏风险、持续失败的自动化）再经系统通知提醒用户。
- 信息不足的段落如实说明「暂无数据」，不要凑数。
