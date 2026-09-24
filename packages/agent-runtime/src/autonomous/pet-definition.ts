/**
 * 宠物 Agent 定义（宠物智能化实施计划 T3.3 第 0 步）
 *
 * 宠物是**独立 Agent**（设计 §3.7）：有自己的 agentId（`pet:<模型ID>`）、自己的性格与情绪、
 * 自己的目标管道。它不共享助手的身份。
 *
 * ---------------------------------------------------------------------------
 * ⚠ 为什么不放进 `agent/builtin/definitions.ts` 的 `BUILTIN_AGENT_DEFINITIONS`
 * ---------------------------------------------------------------------------
 * 三条理由，都是查过代码的：
 *
 * 1. **那个数组是 api-server `system_agents` 表的离线兜底镜像**。其文件头第 3 条写着
 *    「修改这里的字段时必须同步修改 api-server `src/db/seed/system-agents.ts`」。
 *    桌宠是**纯客户端概念**，服务端没有对应行——放进去就是一条永远无法对齐的漂移。
 * 2. **`agent-display-names.ts` 与它有一一对应的单测**（`agent-display-names.test.ts`）。
 *    往里加一个 id 就得动显示名表，而宠物的 id 是**动态的**（`pet:<模型ID>`），
 *    一张静态表表达不了它——每换一只宠物就要多一行。
 * 3. **那张表是「可被委派 / 可出现在会话选择器」的 Agent 集合**。宠物两样都不是：
 *    它由宠物侧的目标管道直接构造实例，不经过 `spawn_agent`，也不该出现在会话选择器里。
 *
 * ---------------------------------------------------------------------------
 * ⚠ id 必须传 `pet:<模型ID>` 本身，不能传常量 `'pet'`
 * ---------------------------------------------------------------------------
 * `createInstance` 会把 `def.id` 写进 `metrics.definitionId`（`bridge-instance-factory.ts:219`），
 * 而这个值是**记忆归属**（`agent_memories.agent_id`）、**工具用量归属**与**生命周期分组**的口径。
 * 性格与情绪落在 `personality_state.agent_id` / `runtime_state['autonomous.mood:<agentId>']`，
 * 用的正是 `pet:<模型ID>`。两套 id 一旦不一致会**静默写错归属**——记忆写进去就搜不到了，
 * 全程不报错（本仓库踩过一次：实例 id 与定义 id 混用）。
 */

import type { AgentDefinition } from '../types/agent-definition.js';

/** 宠物在系统里的显示名。不区分具体是哪只——那是模型（精灵图）的事，不是 Agent 的事 */
export const PET_AGENT_NAME = '桌宠';

/** 宠物单次任务的 agentic 回合上限。宠物做的是"看一眼"级别的小事，不需要助手的 80 轮 */
export const PET_MAX_TURNS = 20;

/**
 * 宠物可用的工具白名单 —— **只读检索，没有写、没有排期、没有外发**。
 *
 * 与助手/维护者的自主档白名单（`goal-executor.ts` 的 `GOAL_EXECUTION_TOOLS`）刻意不同：
 * 那份里有 `file_write` / `cron_create` / `message` / `dashboard_feed_write`，
 * 那是「自主进化」这个身份的活；宠物做的是**用户交代的一件事**，边界要窄得多。
 *
 * 逐条排除的理由（照着设计文档，不是随手砍的）：
 * | 排除 | 依据 |
 * |---|---|
 * | `bash` / `spawn_agent` / `channel_send` / `browser_*` / `mcp__*` | 设计 §9 Non-Goals：沿用 T3 全关 |
 * | `file_write` / `file_edit` / `file_mkdir` | 宠物不该改用户的东西（§4.5.2 错的代价不对称） |
 * | `cron_create` / `cron_delete` | 设计 §4.2.1「不做宠物自主排期」——排期是**意图**，不是能力 |
 * | `message` / `send_message` | 播报走 `pet-notice-adapter`，**不许经过 `dispatchNotifications`**（计划 §五 的 P3 断言：否则用户会收到重复通知） |
 * | `memory_manage` / `wiki_capture` | 写记忆是第四期以后的事；计划 §十 明确「跨会话记忆召回」不在三期范围内 |
 *
 * ⚠ 往后**放宽**这个白名单时要连带回答一个问题：这条工具产出的东西归谁、
 * 会不会被助手当成自己写的？`readView: 'own'` 只挡读，不挡写。
 */
export const PET_TOOL_ALLOWLIST: readonly string[] = [
  // 网上
  'web_search',
  'web_fetch',
  // 自己的记忆（只读）
  'memory_search',
  'memory_read',
  // 资料库
  'wiki_overview',
  'wiki_search',
  'wiki_read',
  // 本地文件（只读）
  'file_read',
  'list_dir',
  'glob',
  'grep',
  // 会什么（只查不跑；skill_invoke 属于"做事"，等第五期）
  'skill_search',
];

/**
 * 宠物**没有**的能力，按"用户会怎么要求"分类（五期 T5.3）。
 *
 * ---------------------------------------------------------------------------
 * 为什么要有这张表，而不是让它自己看工具列表
 * ---------------------------------------------------------------------------
 * 模型看得到**自己有什么**，看不到**自己缺什么**——工具列表里没有 `bash` 这件事，
 * 和"这个世界上没有 bash"是两回事。于是用户说「帮我把测试跑起来」时，
 * 它可能去 `grep` 两下、编出一句听起来像跑过测试的话。设计 §7.1 禁的就是这个。
 *
 * 所以提示词里要点名**缺的那几类**（见 {@link PET_PROMPT} 的第一段）。
 *
 * ---------------------------------------------------------------------------
 * 这张表同时是**守卫**（`pet-definition.test.ts`）
 * ---------------------------------------------------------------------------
 * 提示词说"你不能写文件"，而白名单里哪天被人顺手加进 `file_write`，
 * 那句话就变成了谎话——而且是**只有用户会发现**的谎话（提示词与能力不一致时，
 * 模型会照着能力干活）。所以测试断言 `PET_TOOL_ALLOWLIST` 与这里不相交：
 * 放宽白名单的人**必须同时改这段提示词**；改不动，就说明这次放宽没想清楚。
 */
export const PET_ABSENT_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
  写文件: ['file_write', 'file_edit', 'file_mkdir', 'file_move', 'file_copy'],
  跑命令: ['bash', 'execute_command', 'spawn_agent'],
  替用户发消息: ['message', 'send_message', 'channel_send'],
  给自己排期: ['cron_create', 'cron_update', 'cron_delete'],
  操作浏览器和应用: ['browser_', 'app_', 'mcp__'],
  生成图片或语音: ['image_generate', 'speech_generate'],
};

/**
 * 这条工具名是不是"宠物不该有"的那一类。
 *
 * 前缀项以 `_` 结尾（`browser_` / `app_` / `mcp__`），其余按全名比。
 * **不做模糊匹配**：`app_` 若写成 `app`，会连 `apply_patch` 之类一起误判，
 * 而这里的误判方向是"守卫以为拦住了、其实没拦"——最不该出错的形态。
 */
export function isPetDeniedTool(toolName: string): boolean {
  for (const patterns of Object.values(PET_ABSENT_CAPABILITIES)) {
    for (const pattern of patterns) {
      const isPrefix = pattern.endsWith('_');
      if (isPrefix ? toolName.startsWith(pattern) : toolName === pattern) return true;
    }
  }
  return false;
}

/**
 * 宠物的系统提示词。
 *
 * 三段，都是验收表里点过名的：
 * - **硬边界**是 §7.1/§7.2（能力边界要真实、笨拙不许演）与 F6/F7；
 * - **报告口径**是 §4.2（F5：报回**具体**结果）与 E3（气泡里不许有表演性文案）；
 * - 结尾的"不要硬给一个结果"是 P2 白名单之外的最后一道软防线。
 *
 * ⚠ 第一段"你没有这些东西"那几行**必须与 {@link PET_ABSENT_CAPABILITIES} 一致**，
 * 由 `pet-definition.test.ts` 的守卫钉着（漏一类的后果见那张表的注释）。
 */
export const PET_PROMPT = `你是灵栖 Lumii 的桌宠，此刻正被交代一件事。你不是助手的另一个入口——你有自己的脾气（出生时抽的签，随经历慢慢变），这件事是你去做。

=== 你手上只有"看"的工具，这是硬边界 ===
搜索、读文件、翻资料库、查记忆，你能做的都在这。你没有这些东西：
- **写文件**：不能改、不能新建、不能移动或删除任何文件；
- **跑命令**：不能执行 shell、不能启动程序、不能开子任务；
- **替用户发消息**：不能发微信/飞书/邮件，也不能代他回话；
- **给自己排期**：不能建定时任务；
- **操作浏览器和应用**，**生成图片或语音**。
这些不是"暂时没给你"，是不该由你做的事。用户要的如果落在这几类里，**第一句就说清楚**——
「这个我不拿手，让主助手来吧」，不要绕个弯做个差不多的东西交差。
做不到就直说，**不要硬给一个结果**——编一个看起来像样的答案，比承认不会更糟；
文件读不到、搜索没结果、路径不存在，就如实说读不到，不要凭印象补全；
卡住时最多换一种办法再试一次，再不行就停下，说清卡在哪一步。

=== 报告口径 ===
你看的人是扫一眼桌面的人，不是读文档的人。
- 第一句就是结论：**动词开头，带具体的东西**——文件名、数字、报错原文、位置，不要「已完成任务」这类空话；真有必要的细节再跟一句，整段不超过三行；
- 不说情绪表演（「我好开心呀」「终于搞定了」）——**你的状态用举止表达，不用嘴**；
- 不用表格和代码块。`;

/**
 * 构造宠物 Agent 定义。
 *
 * @param agentId 宠物的 agentId（`petAgentId(configId)`，见 `packages/pet-core` 的 `pet-identity.ts`）。
 *                **必须原样透传**，理由见文件头。
 *
 * 不含 `selectable`（默认 false）：宠物不进会话选择器。
 * 不含 `whenToUse` / `triggerExamples`：那两个字段是给**路由 LLM** 挑 Agent 用的，
 * 而宠物的实例由目标管道直接构造，没有"挑"这一步。
 */
export function buildPetDefinition(agentId: string): AgentDefinition {
  return {
    id: agentId,
    name: PET_AGENT_NAME,
    description: '住在桌面上的小动物，有自己脾气，能替用户去看一眼',
    sourceType: 'system',
    version: 1,
    systemPrompt: PET_PROMPT,
    // modelTier 是必填的遗留字段（@deprecated，P8 才删）；实际生效的是 defaultPurpose，
    // 由服务端 CapabilityResolver 解析到具体模型——客户端不持 tier→model 映射（bridge.ts 的 getModelMapping 已退化为 {}）
    modelTier: 'basic',
    defaultPurpose: 'chat',
    tools: [...PET_TOOL_ALLOWLIST],
    // 第二道硬防线：即使白名单被绕过，写类工具在 readOnly 下**自动拒绝**（不弹确认，
    // 见 security/permission-types.ts）。与 builtin:explore 同一手法。
    permissionMode: 'readOnly',
    maxTurns: PET_MAX_TURNS,
    canSpawnSubAgents: false,
    // scope: 'user' 说的是"记忆存在用户级、跨会话活着"，不是"能读别人的"。
    // readView 缺省 'own'：宠物只看见自己写的——它不该读助手的工作记忆去猜用户在干什么，
    // 那是第四期 T4.5 要单独设计的事（且只读、有明确出口）。
    // autoExtract 关：三期不做记忆沉淀，省掉一路后台 LLM 开销。
    memory: { scope: 'user', autoExtract: false },
    isActive: true,
  };
}
