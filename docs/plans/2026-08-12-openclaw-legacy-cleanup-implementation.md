# OpenClaw 遗留信息清理实施计划

日期：2026-08-12
分支：`feat/ui-tech-refresh`

## 背景

代码库中残留 99 处 `openclaw` 引用（21 个文件）。逐个核查后并非同一性质，
不能一刀切替换或删除 —— 其中一类是真实上游出处，删掉会丢失「为什么这么写」；
另一类是路径指错，属于静默失效的功能缺陷。

## 现状分类

### A 类：活代码标识符（在跑，需改名）

`openclaw` 是默认 coding-dev 后端 ID（`coding-dev-backends-stub/contracts.ts:6`），
会泄漏到用户与模型可见的面：

| 位置 | 泄漏面 |
|------|--------|
| `packages/agent-runtime/src/tools/built-in/client-command-tools.ts:118,126` | 工具 schema 描述，发给 LLM |
| `packages/agent-runtime/src/prompt/system-prompt-builder.ts:390` | 系统提示词 |
| `contracts.ts:25` | 后端标签 `"OpenClaw / MtBot 主代理"` |
| `ChatInput/index.tsx:889` | 输入框 badge `title="当前后端: openclaw"` |

且字面量到处硬编码、未走常量，这是改名会漏的根因：
`weixin-channel-adapter.ts:144,262`、`feishu-channel-adapter.ts:179`、
`agent-runtime-ipc.ts:622`、`ChatInput/index.tsx:888,1030`、
`slash-command-executor.ts:306,307,316`。

### B 类：路径指错（真 bug，非文案）

skillnet 技能指引 agent 往 `~/.openclaw/workspace/skills` 下载技能，
实际技能目录是 `~/.lumii/workspace/skills`（`directory-manager.ts:77`）。
下载物落在错目录，`skill-watcher` 不可见，等于静默失效。共 45 处：

- `bundled-skills/技能管理/skillnet/SKILL.md`（38）
- `bundled-skills/技能管理/skillnet/references/workflow-patterns.md`（12）
- `bundled-skills/技能管理/skillnet/scripts/create_skill.py:24`
- `bundled-skills/技能管理/skillnet/scripts/search_and_download.py:6,24`

同一技能另有两处不存在的机制：
- `openclaw.json` 注入凭据（`SKILL.md:337,371`）—— 真机制是 `skill-env.json`（`skill-runtime.ts:644`）
- frontmatter `metadata.openclaw` 键（`SKILL.md:15`、`tencent-docs/SKILL.md:7`）—— 解析器只认 `mtbot.requires`（`skill-md-frontmatter.ts:139`），该键从不被读取

### C 类：上游出处注释（保留）

`weixin-login-service.ts:4` 的 `github.com/pzx521521/openclaw-weixin-cli` 是真实上游仓库；
`:135`、`:1103` 解释了 aes_key 那段非直觉编码的来由。
`wecom-login-service.ts:4`、`feishu-app-registration.ts:4,111` 同理。
删除等于删掉「为什么」，后续易把兼容代码改坏。

### D 类：死代码（删除）

`apps/windows/scripts/diagnose-device-token.js` —— 已废弃 Gateway 设备 token 流程，
使用 `OPENCLAW_API_BASE_URL`，全仓零引用、package.json 无脚本入口。

## 实施顺序

先修唯一在坏功能的 B 类，再清死代码，最后做改名。

### 阶段 1：修 skillnet 路径 bug

1. 4 个文件 `~/.openclaw/workspace/skills` → `~/.lumii/workspace/skills`
2. `SKILL.md:337,371` 的 `openclaw.json` → `skill-env.json`
3. 删 `SKILL.md:15` 与 `tencent-docs/SKILL.md:7` 的 `metadata.openclaw` 键（解析器不读，留着只误导 agent）
4. `tencent-docs/setup.sh:3` 去掉「内部 OpenClaw 版本」

### 阶段 2：删死代码

删 `apps/windows/scripts/diagnose-device-token.js`。

### 阶段 3：后端 ID 改名 `openclaw` → `lumii`

1. `contracts.ts:6` 常量改值；`:25` 标签改 `"灵栖主 Agent"`；`:22,:102` 类型与判断跟改
2. 6 个文件硬编码字面量改为引用 `DEFAULT_CODING_DEV_BACKEND_ID`。
   renderer 不能 import main，在 `slash-command-executor.ts` 导出常量供 `ChatInput` 复用
3. `normalizeCodingDevBackendId`（`contracts.ts:114`）反向：`openclaw` 保留为别名映射到 `lumii`
4. `client-command-tools.ts:118,126`、`system-prompt-builder.ts:390` 描述文字同步

存量数据处理：
- `backend-selection.json` 无需迁移 —— 加载时 `isCodingDevBackendId` 丢弃不识别 ID 并回退默认值（`backend-selection.ts:69,101`）
- renderer 的 `localStorage['mtbot:acp-backend']` 会残留 `openclaw`，读取处（`slash-command-executor.ts:316`）需加归一化，否则老用户被路由到不存在的 ACP 子进程

### 阶段 4：C 类注释措辞

保留上游 URL 与协议兼容说明，仅将「对齐 OpenClaw」补明为历史参考实现。

## 验证

- 阶段 1/3 后：`pnpm typecheck`、`npx vitest run src/main`
- 阶段 3 后手动验：`/lumii` 与 `/claude` 切换、输入框 badge 显示

## 已知无关漂移（未纳入本次范围）

`slash-command-executor.ts:293` 的 `BACKEND_INFO` 列 13 个后端
（gemini/qoder/qwen/kimi/copilot/auggie/hermes），`contracts.ts:8` 仅实现 5 个，
用户切到未实现项会失败。待单独决策。
