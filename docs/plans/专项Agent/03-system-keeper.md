# C · system-keeper 闭环（实施计划）

> 前置：A 片（A1 归属 / A2 遍历 / A3 会话）。对应设计 §6。
> 定位：**Lumii 的资产维护者与客户端代办**——维护 Wiki / 记忆 / 用户指南，代用户操作客户端。
> 特点：以新增定义、技能文件与提示词为主；**唯一的代码改动是「自主档工具面」**（C1），其余为手册 + 演练验收。风险低。

## C0 · 总览

| 步 | 内容 | 载体 | 类型 |
|---|---|---|---|
| C1 | `system-keeper` 定义 + 交互/自主两档工具面 | definitions / prompts / goal-executor / bridge | 代码 |
| C2 | 运维手册技能 | `bundled-skills/系统维护/system-keeper-handbook/SKILL.md` | 内容 |
| C3 | 记忆精炼闭环 | 手册章节 + 演练验收 | 内容 |
| C4 | Wiki 策展闭环 | 手册章节 + 演练验收 | 内容 |
| C5 | 用户指南同步闭环 | 手册章节 + 演练验收 | 内容 |
| C6 | 客户端自动化 | 手册章节 + 演练验收 | 内容 |
| C7 | 报告送达 | 零代码（cron `notify_targets` + A5） | — |

---

## C1 · 定义与两档工具面

### 1. 定义（`packages/agent-runtime/src/agent/builtin/definitions.ts`）

`SYSTEM_KEEPER_DEF`（追加进 `BUILTIN_AGENT_DEFINITIONS`）：

- `id: 'system-keeper'`、`name: '灵栖维护'`、`sourceType: 'system'`、`selectable: true`、`isActive: true`
- `systemPrompt`（放 `prompts.ts`，新条目 `SYSTEM_KEEPER_PROMPT`）：角色与边界——
  - 职责：维护 Wiki / 记忆 / 用户指南；代用户操作客户端（改设置、开关工具、界面导航与截图）
  - **红线**：删除类操作与设置变更需用户在场确认；自主运行只出建议；不得凭空描述系统机制（先读手册）
  - 开场指引：「遇到机制问题，先 `skill_invoke` 加载《系统维护手册》」
- **交互档** `tools` 白名单：
  `bash`（lumii-ui 设置读写、`pnpm sync:guides`）、`file_read/file_write/file_edit/list_dir/glob/grep`（`docs/guide`）、
  `cron_create/cron_list/cron_delete/cron_guide`、`wiki_overview/wiki_search/wiki_read`、
  `memory_search/memory_read/memory_manage/profile_memory/scene_memory`、
  `skill_list/skill_search/skill_invoke`、`todo_write`、
  `app_screenshot/app_goto/app_act/app_fill_form/app_scroll_to_text/app_scroll_to_bottom/app_goto_and_screenshot`
- `canSpawnSubAgents: false`、`memory: { scope: 'user', autoExtract: true }`、`modelTier: 'balanced'`

### 2. 自主档工具面（唯一的代码改动）

**问题**：自主执行路径（目标执行 / `agent-self:*` cron）现在统一走 `getGoalToolAllowlist(type)`，其白名单包含 `file_write/file_edit` 等写类工具——对 system-keeper 而言过宽（它是"只建议"的维护者）。

**改动**：

1. `packages/agent-runtime/src/autonomous/goal-executor.ts` 旁增：
   ```ts
   /** 按执行者选择自主档工具白名单（缺省沿用 getGoalToolAllowlist） */
   export function getAutonomousToolsForAgent(agentId: string, goalType: GoalType): string[] {
     if (agentId === 'system-keeper') return [...SYSTEM_KEEPER_AUTONOMOUS_TOOLS]
     return getGoalToolAllowlist(goalType)
   }
   export const SYSTEM_KEEPER_AUTONOMOUS_TOOLS = [
     'cron_list', 'cron_create', 'cron_delete', 'cron_guide',
     'wiki_overview', 'wiki_search', 'wiki_read',
     'memory_search', 'memory_read', 'memory_manage', 'profile_memory',
     'skill_list', 'skill_search', 'skill_invoke',
     'todo_write',
   ] as const   // 无 bash / 无 file_write / 无 app_*
   ```
2. `apps/windows/src/main/agent-runtime/bridge.ts` 两处接线改为按 agentId 取白名单：
   - `createRestrictedInstanceById`（`:1113-1122`，`agent-self:*` cron 执行路径）；
   - `executeGoal`（`:1296-1300`，目标执行路径）。

**测试**：单测——`getAutonomousToolsForAgent('system-keeper')` 不含 `bash/file_write/app_*`，含 `profile_memory/cron_*`；其他 agentId 与现状一致。

**验收**：system-keeper 的自主目标执行实例尝试调 bash 被拒（工具不在列表）；交互会话里 bash 正常。

---

## C2 · 运维手册技能

新建 `apps/windows/bundled-skills/系统维护/system-keeper-handbook/SKILL.md`（frontmatter 参照现有技能：`name` / `description`），内容四块：

1. **资产地图**（它要维护的东西在哪）：
   - Wiki：表与整理流程（`wiki-organizer` 每 30s 自动整理、`wiki-cleanup` 的 content_hash 去重建议、`wiki_inbox` 待整理）
   - 记忆三层：`user-memory.md`（`~/.lumii/data/user-memory.md`，注入预算 2400 字符）、`agent_memories`（工作记忆）、`scene-memory`（项目/渠道记忆 `~/.lumii/data/scene-memory/`）
   - 用户指南：源 `docs/guide/*.md` → `pnpm sync:guides` → `apps/windows/resources/user-guides/`（随包分发；`seedToWiki` 字段预留进 Wiki）
2. **操作手册**：lumii-ui `settings get/set <key.path>`；`tools:toggle`；命令总线白名单（`command-allowlist.ts` 什么可发）；`app_*` 工具用法与配额（`privacy.allowAgentAppUiControl` 前置，单轮 27-114）
3. **边界与红线**：必须用户确认的动作清单（Wiki 合并/删除、设置变更、文件删除）；`user-memory` 写入自带 `.bak`；cron 删除有 `agent-self:*` 前缀守卫
4. **报告模板**：巡检摘要格式（问题 → 依据 → 建议动作 → 风险等级）

机制说明：bundled-skills 启动时 seed 到 workspace；Agent 经 `skill_list/skill_search/skill_invoke` **按需加载**（不占常驻上下文）。

**验收**：重启后 `skill_search 系统维护` 可命中；`skill_invoke` 能读到全文。

---

## C3 · 记忆精炼闭环（无新代码）

**交付 = 手册章节《记忆精炼》**，步骤：

1. `profile_memory` 读 `user-memory.md` 全文（不受 2400 截断限制）；
2. 检测：截断线之外是否有重要信息 / 重复条目 / 相互矛盾 / 过期项 / 章节结构是否规范；
3. 写回（`profile_memory` update/append/remove_section，写前自动 `.bak`）；
4. 场景记忆（项目 / 渠道 md）同理瘦身；
5. 产出修改摘要（增删改了什么、新字数）。

**演练验收**：

- [ ] 注入一段重复偏好 → 让它整理 → 摘要显示去重、字数下降、`~/.lumii/data/user-memory.md.bak` 存在
- [ ] 自主化：开启自主（A4）后由它自建每周 cron（`cron_create`，`agent-self:*`）；首次开启建议交互观察一轮（动作边界，设计 §6.3）

---

## C4 · Wiki 策展闭环（无新代码）

**交付 = 手册章节《Wiki 策展》**：

1. `wiki_overview` 扫描：重复页（对照已有 `duplicate_content` 检测）、空页 / 孤儿页、主题错位；
2. 生成「合并 / 归位 / 归档」建议清单（问题 → 依据 → 建议）；
3. 用户确认后经 `bash` + lumii-ui 命令总线执行（重命名 / 归档 / 合并）；
4. 不与 memory-wiki 的自动机制重复实现——它调用机制、补齐人工式策展。

**演练验收**：

- [ ] 构造两篇同内容页 → 建议清单命中 → 确认后执行归档/合并
- [ ] 未确认时不做任何写入

---

## C5 · 用户指南同步闭环（无新代码）

**交付 = 手册章节《用户指南同步》**：

1. 对照最近功能变更（git log / 对话上下文）定位受影响章节（如「设置页新增默认编码后端下拉」→ `docs/guide/Lumii-Desktop-User-Guide.md` 设置章节）；
2. `file_edit` 更新对应段落；
3. `bash` 跑 `pnpm sync:guides`（`apps/windows/scripts/sync-user-guides.mjs`），校验 `resources/user-guides/manifest.json` 的 `updatedAt`；
4. 产出 diff 摘要。

**演练验收**（在 B3 落地后做，有真实内容可写）：

- [ ] 编辑 → sync → manifest 更新；diff 摘要正确

---

## C6 · 客户端自动化（无新代码）

**交付 = 手册章节《客户端自动化》**（含一致性巡检规则）：

- 按需操作：改设置（lumii-ui `settings set`）→ 复验读回 → 截图确认（`app_goto` + `app_screenshot`）；开关工具（`tools:toggle`）；
- 一致性巡检（低频、只报告）：「开了自主但没配渠道」「选了 CLI 后端但未安装」类矛盾 → 报告。

**演练验收**：

- [ ] 让它把某个设置改掉 → 读回复验 → 截图确认；恶意路径（删设置）被自身红线拒绝

---

## C7 · 报告送达（零代码，说明性）

- 巡检类自主运行：结果落 `evolution:system-keeper` 会话；`notify_targets=system` 的任务由 cron 派发器推系统通知；
- 目标执行失败可见性由 A5 覆盖；
- 无需新增通道。

---

## C 片验收总表

- [ ] 「灵栖维护」出现在选择器，会话可正常对话
- [ ] 手册可被 `skill_invoke` 加载
- [ ] 记忆精炼演练通过（.bak + 摘要 + 字数下降）
- [ ] Wiki 策展建议命中构造的重复页；确认后可执行、未确认不写
- [ ] 指南同步演练产出 diff
- [ ] 客户端自动化演练通过（改设置 + 复验 + 截图）
- [ ] 自主档工具面断言：bash / file_write / app_* 不在其中（单测）
- [ ] 回归：assistant 的自主执行行为不变（life-e2e 23 例）
