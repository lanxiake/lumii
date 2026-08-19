# 技能统计入库 + 渠道消息回执错误回传 + 系统提示词注入诊断信息 设计与实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Date:** 2026-08-19

**Goal:**
1. **技能/工具/MCP 使用次数入库**：修复"技能用了很多次却显示未用过"的 Bug；工具调用统计（含 MCP）从 JSON 文件迁移到 SQLite，避免重启/升级丢失；兼容旧 JSON 数据一次性迁移。
2. **渠道消息即时回执 + 错误回传**：微信/企微/飞书三渠道主代理路径收到消息后立即回复"✅ 已收到，正在处理…"；处理过程中报错（如模型不可用、API key 无效等）时将中文友好错误信息返回给渠道用户，而非仅打日志。
3. **系统提示词注入客户端诊断信息**：在 System Prompt 动态 Runtime section 中追加三项信息：① 客户端日志路径 + 说明；② lumii CLI help 命令 + 说明；③ CPU/内存/磁盘使用状态（带阈值建议），数据采集 5 秒缓存避免每轮重复查。

**Tech Stack:**
TypeScript strict、better-sqlite3 / 现有 SQLite wrapper、`os` Node.js 内置模块、`diskusage`（若项目已依赖；否则用 `driveInfo` 类库或仅 `os.fs` 估算）。

**验收基线：**
- 基线 A：技能页面用 `skill_search` → `skill_invoke` 加载某技能 3 次，刷新页面后该技能卡片使用次数显示 ≥3；重启应用后数字不变。
- 基线 B：故意禁用/填错模型 API key，从微信/企微/飞书任一渠道发一条对话消息，应先收到"✅ 已收到，正在处理…"，随后收到"❌ 处理失败：xxx（中文友好文案）"；非渠道侧（Windows 桌面端）正常不变。
- 基线 C：在 Windows 端发起对话，打开调试面板查看 System Prompt 末尾，应能看到三行新注入的诊断信息（日志路径、CLI 命令、系统状态）；连续发 2 条消息间隔 <5s，系统状态数值相同（命中缓存）；>5s 后再发数值更新。
- 基线 D：升级前有旧 `tool-usage.json` 的用户，启动后 SQLite `tool_usage_stats` 表中出现相同计数（count / error_count / last_used_at）；旧文件被重命名为 `tool-usage.json.bak`。

---

## 架构总览（三个需求的数据流）

### 需求1数据流
```
Agent 调用 skill_invoke → skill-tools.ts execute 成功返回 SKILL.md
    → context.recordSkillExecution(skillId) 回调（ToolContext 新增可选方法）
    → 宿主层 bridge-tool-registrar.ts 注入回调实现
    → skillStore.recordExecution(skillId)
    → ~/.lumii/skills/index.json（现有机制，无需改存储，只修触发时机）

Agent 调用任意工具 → tool-usage-hook.ts afterExecute / onError
    → recordToolUsage(toolName, isError)（原有接口）
    → 内存 Map 计数 + 2s debounce
    → SQLite tool_usage_stats 表 UPSERT（原 JSON 写盘改为 SQLite 写）
    → 应用退出时 flushToolUsage() 强制 UPSERT
```

### 需求2数据流
```
渠道 LoginService 收到消息 → Adapter.startListening() → handleMessage()
    ├─ ensureConversation / notifyIncoming / 斜杠命令（已有）
    ├─ [NEW] sendTextReply("✅ 已收到，正在处理…")
    ├─ getOrCreateInstance / saveMessage / registerCallback（已有）
    └─ try { sessionManager.prompt(...) }
            catch (err) {
              log.error(...)                       // 已有
    └─ [NEW]  sendTextReply("❌ 处理失败：" + friendlyMsg(err))
```

### 需求3数据流
```
每轮用户消息到达
  → BridgePromptDispatcher.prompt()
    → BridgePromptComposer.buildPromptWithMemory()
      ├─ [NEW] collectClientDiagnostics()（5s 缓存：os.loadavg / os.totalmem-os.freemem / 磁盘）
      ├─ [NEW] 把 clientDiagnostics 对象塞给 buildPrompt() 的 params
      → assembleSystemPrompt 闭包 → buildClientSystemPromptStructured()
        → buildRuntimeSection() 末尾
          ├─ [NEW] buildClientDiagnosticsSection(params.clientDiagnostics)
          └─ 拼接为完整 Runtime section
    → instance.setSystemPrompt()（已有）
```

---

## Task 1: SQLite schema V13 + 工具使用统计迁移

**Files:**
- Modify: `packages/agent-runtime/src/storage/schema.ts`（SCHEMA_VERSION 12→13，新增 `tool_usage_stats` 表 + migration V13）
- Modify: `apps/windows/src/main/tool-usage-store.ts`（JSON 读写改为 SQLite；兼容旧 JSON 一次性迁移；debounce 逻辑保留；flush 改为 UPSERT）
- Modify: `apps/windows/src/main/ipc/agent-runtime-ipc.ts`（`tools:list` 命令读取改为从 SQLite 读，不再从 tool-usage-store.ts 的 JSON 直接读 —— 若 tool-usage-store 已封装则改 store 内部）

**Step 1: schema 升级**

`SCHEMA_VERSION = 13`，MIGRATIONS 追加：

```sql
-- V13: 工具累计使用统计（替代 tool-usage.json，避免升级/重启丢失）
CREATE TABLE IF NOT EXISTS tool_usage_stats (
  tool_name     TEXT PRIMARY KEY,
  count         INTEGER NOT NULL DEFAULT 0,
  error_count   INTEGER NOT NULL DEFAULT 0,
  last_used_at  INTEGER   -- epoch ms，NULL 表示未用过
);
```

**Step 2: tool-usage-store.ts 改造**

原结构：
```typescript
// 旧：读 JSON → this.map: ToolUsageMap
// 新：启动时读 SQLite tool_usage_stats → this.map: ToolUsageMap
```

- 启动 `init()` 流程：
  1. 从 SQLite `SELECT tool_name, count, error_count, last_used_at FROM tool_usage_stats` 装载到内存 Map
  2. 若检测到 `~/.lumii/usage/tool-usage.json` 存在且非空：
     - 读取 JSON，合并入内存 Map（JSON 中 count/errorCount/lastUsedAt 比 SQLite 新的用 JSON 值，或直接以 JSON 为准（因 JSON 是老方案的运行时真值））
     - 合并结果立刻写 SQLite（一次性 `BEGIN IMMEDIATE` 批量 UPSERT）
     - 将旧文件重命名为 `tool-usage.json.bak`（不删，防回滚）
  3. 若 `~/.lumii/usage/` 目录不存在，跳过迁移
- 写盘 `flush()` 改为：对内存 Map 每个条目 `INSERT INTO tool_usage_stats (tool_name, count, error_count, last_used_at) VALUES (?, ?, ?, ?) ON CONFLICT(tool_name) DO UPDATE SET count=excluded.count, error_count=excluded.error_count, last_used_at=excluded.last_used_at`，用事务包批量
- 2s debounce 逻辑保留，退出前 flush 也保留
- `getToolUsage()` 方法签名与返回值保持不变，上层 IPC 无需改类型

**Step 3: tools:list IPC 读取来源验证**

确认 `agent-runtime-ipc.ts` 的 `tools:list` 是调 `getToolUsage()` 从 tool-usage-store 拿值——保持不变即可，数据源已由 store 内部透明切换。若有其他代码直接读 JSON 文件路径（grep 确认），改为走 store 暴露的 `getToolUsage()`。

**Step 4: 验证**
```bash
pnpm typecheck
```
无类型错误后，手动模拟：启动前造一份 tool-usage.json，启动后看 DB 中数据是否出现，.bak 是否生成。

---

## Task 2: skill_invoke 加载成功后触发技能执行次数统计

**Files:**
- Modify: `packages/agent-runtime/src/tools/tool-adapter.ts`（ToolContext 类型新增可选方法 `recordSkillExecution?: (skillIdOrName: string) => Promise<void> | void`）
- Modify: `packages/agent-runtime/src/tools/built-in/skill-tools.ts`（`skillInvokeToolConfig.execute` 成功返回 SKILL.md 路径后调用 `context.recordSkillExecution?.(skill.name 或 skill.id)`）
- Modify: `apps/windows/src/main/agent-runtime/bridge-tool-registrar.ts`（注册工具时注入 `recordSkillExecution` 回调，实现为 `skillStore.recordExecution(skillId)`）
- Verify: `apps/windows/src/main/skill-store.ts`（`recordExecution` 方法已存在，签名是否接受 skillId 或 skillName——若只接受 skillId 需做一次 id 反查或放宽参数做兼容查找）

**Step 1: ToolContext 扩展**

在 MtBotToolConfig 的 execute 第三个参数 context 的 interface（即 ToolCallContext / MtBotToolContext，具体定义在 tool-adapter.ts）上追加可选方法：

```typescript
recordSkillExecution?: (skillIdOrName: string) => Promise<void> | void;
```

不强制实现，通用层代码在无此方法时静默（用 `?.` 调用）。

**Step 2: skill_invoke 回调调用点**

在 `skillInvokeToolConfig.execute` 的成功分支：成功读出 SKILL.md 并构造好返回 JSON 之后、`return { content: [...] }` 之前，插入：

```typescript
await context.recordSkillExecution?.(skill.id ?? skill.name);
```

（`skill.id` 优先，因为 skillStore.recordExecution 按 id 匹配；没有 id 时用 name 做兼容）

**Step 3: 宿主层注入回调**

bridge-tool-registrar.ts 在构造每个工具的 context 时（或 agent-runtime 暴露的 tool context factory 中）追加：

```typescript
recordSkillExecution: async (skillIdOrName) => {
  try {
    const store = localSkillStore; // 或 skillRuntime.getSkillStore()
    // 如果 store.recordExecution 只接受 id，做一次 name→id 反查
    let skillId = skillIdOrName;
    if (!store.hasSkillId(skillIdOrName)) {
      const byName = store.findSkillByName(skillIdOrName);
      if (byName) skillId = byName.id;
      else return; // 找不到就跳过，不报错
    }
    await store.recordExecution(skillId);
  } catch (e) {
    log.warn('recordSkillExecution failed', { skillIdOrName, error: String(e) });
  }
},
```

**Step 4: 适配 skillStore.recordExecution 参数**

若现有 `recordExecution(skillId)` 在传入 name 时找不到匹配，在 skill-store.ts 内做兼容：传入值优先按 id 精确匹配，找不到再按 name 不区分大小写匹配第一个，都找不到就 return void（不抛错）。

**Step 5: 验证**
```bash
cd apps/windows
pnpm typecheck
```
用例：通过桌面端对话，让 Agent 调 `skill_search` + `skill_invoke` 加载 3 次同一个技能 → 看 Skills 页对应技能卡片的 executionCount 显示是否增加。

---

## Task 3: 渠道适配器 handleMessage 加即时回执 + 错误回传

**Files:**
- Modify: `apps/windows/src/main/channel/adapters/weixin-channel-adapter.ts`（handleMessage 普通消息分支 + 语音转录分支 + ACP 分支确认 catch 已有错误回复）
- Modify: `apps/windows/src/main/channel/adapters/wecom-channel-adapter.ts`（handleMessage 主代理路径）
- Modify: `apps/windows/src/main/channel/adapters/feishu-channel-adapter.ts`（handleMessage 主代理路径 + ACP 路径检查）
- Optional: Create helper `apps/windows/src/main/channel/channel-error-friendly.ts`（错误映射函数 `toFriendlyChannelError(err): string`，三个适配器共用；若函数很简单也可直接 inline 在某个 adapter 中 export）

**Step 1: 错误友好映射函数**

新建 `channel-error-friendly.ts`（或在某 adapter 中作为 util）：

```typescript
const MODEL_PROVIDER_PATTERNS: ReadonlyArray<{ re: RegExp; msg: string }> = [
  { re: /(api ?key|invalid.*key|401|unauthorized)/i,
    msg: "模型服务鉴权失败，请在客户端【设置 > 模型服务】检查 API Key 是否正确填写并已启用。" },
  { re: /(insufficient|quota|exceeded|rate.?limit|429)/i,
    msg: "模型服务额度不足或触发限流，请稍后重试，或在【设置 > 模型服务】切换到备用模型。" },
  { re: /(model not found|no such model|model.*not.*available|404)/i,
    msg: "当前模型不可用或已下架，请在【设置 > 模型服务】重新选择一个可用模型。" },
  { re: /(connect|timeout|econnrefused|network|eai_again|fetch.?failed)/i,
    msg: "无法连接到模型服务，请检查网络连接，或确认模型本地服务（如 Ollama/LM Studio）是否已启动。" },
  { re: /(context.*length|too many tokens|max tokens|content length|413|431)/i,
    msg: "对话过长超出模型上下文上限，请使用 /new 开启新会话后重试。" },
];

export function toFriendlyChannelError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "未知错误");
  for (const { re, msg } of MODEL_PROVIDER_PATTERNS) {
    if (re.test(raw)) return msg;
  }
  // 兜底：显示消息，但不超 200 字（防堆栈泄露）
  const snippet = raw.length > 180 ? raw.slice(0, 180) + "…" : raw;
  return `${snippet}\n（请在客户端【设置】检查模型与网络，或稍后重试）`;
}
```

**Step 2: 三渠道主代理路径修改**

每个 adapter 的 handleMessage 主代理路径：

1. **即时回执**：`notifyIncomingMessage` 完成后、`getOrCreateInstance` 之后，或在 try 块的最开头插入：
   ```typescript
   await this.sendTextReply(session, "✅ 已收到，正在处理…");
   ```
   注意：**斜杠命令路径不插入**（已自己回复结果）；**媒体纯文件路径不插入**（已有"📎 已收到文件…"回复）。

2. **错误回传**：原 catch 块改为：
   ```typescript
   } catch (err) {
     log.error(`[handleMessage] Agent 处理异常: ${err instanceof Error ? err.message : String(err)}`);
     try {
       const reply = `❌ 处理失败：${toFriendlyChannelError(err)}`;
       // 优先用 activeSession（有 instanceId），没有就用 session（同样能 reply，replyContext 已在 session 内）
       await this.sendTextReply((activeSession ?? session) as ChannelSession, reply);
     } catch (e2) {
       log.error(`[handleMessage] 错误回复也发送失败: ${e2 instanceof Error ? e2.message : String(e2)}`);
     }
   }
   ```

3. **语音转录分支**（微信独有 L160-233）：独立的 try/finally/catch 结构，同样插入即时回执 + catch 回传。

4. **ACP 路径**（三渠道都有）：检查现有 catch 是否已有错误回复——微信 handleAcpPrompt L487-501 已有超时/取消/失败的三分支回复；企微/飞书 handleAcpPrompt 如有遗漏比照微信补齐。

**Step 3: 企微/飞书 ACP 路径检查**

- 飞书 L235-293 `handleAcpPrompt`：末尾有 `errorText` 判断后回复，看起来完整——确认无误后不改。
- 企微如有 `handleAcpPrompt`（可能没有，因企微目前仅 reply_only），有则对齐飞书模式；如没有则跳过。

**Step 4: 验证**
```bash
pnpm typecheck
```
手动：禁用模型 key → 从渠道发消息 → 收到"✅ 已收到…" + 随后"❌ 处理失败：模型服务鉴权失败…"。

---

## Task 4: 系统提示词注入客户端诊断信息（日志路径 + CLI help + 系统状态）

**Files:**
- Modify: `packages/agent-runtime/src/prompt/system-prompt-builder.ts`（`ClientSystemPromptParams` 新增 `clientDiagnostics?`；`buildRuntimeSection()` 末尾调用新 `buildClientDiagnosticsSection()`；或拆独立 section 追加到 dynamicLines 数组末尾 —— 更清晰，推荐在 Runtime 段内追加子段落）
- Modify: `packages/agent-runtime/src/host-kit/types.ts`（如 PromptContextProvider 里需要透传相关字段，检查是否要新增获取方法；如不需要则略过）
- Modify: `apps/windows/src/main/agent-runtime/bridge-prompt-composer.ts`（新增 `collectClientDiagnostics()` + 5s 缓存；调用 Node `os` / `diskusage` 采集数据；塞入传给 `buildClientSystemPromptStructured` 的 params 对象）
- Modify: `apps/windows/src/main/client-data-root.ts`（如需要导出日志目录路径常量，已存在 `getClientDataRoot()` 直接用；logs 目录应为 `${getClientDataRoot()}/logs`）
- Check: `apps/windows/package.json` 是否有 `diskusage` 依赖；如无，优先用 `os` + `node:fs` 的 `statfs`（Node 19+ 内置）；或改用纯 `driveInfo`/`wmic` 查 Windows 盘。

**Step 1: system-prompt-builder.ts 类型与 section 构建**

`ClientSystemPromptParams` 追加：

```typescript
clientDiagnostics?: {
  logsDir?: string;
  cliHelpCommand?: string;   // 默认 "lumii --help"
  systemStatus?: {
    cpuPercent: number;       // 0-100
    memUsedGB: number;        // 小数 1 位
    memTotalGB: number;
    memPercent: number;       // 0-100
    diskDrive?: string;       // "C:"
    diskUsedGB: number;
    diskTotalGB: number;
    diskPercent: number;      // 0-100
    diskFreeGB?: number;      // 用于阈值提示
  };
};
```

新函数 `buildClientDiagnosticsSection(diag?: ClientDiagnostics): string[]`：只在 diag 非空（即 Windows 宿主）时输出：

```typescript
function buildClientDiagnosticsSection(diag?: ClientDiagnostics): string[] {
  if (!diag) return [];
  const lines: string[] = [];
  if (diag.logsDir) {
    lines.push(`- **客户端日志目录**：\`${diag.logsDir}\`（main.log 主进程、renderer.log 渲染进程，按日期滚动。排查问题时可用 \`file_read\` 查看最近的日志）。`);
  }
  if (diag.cliHelpCommand) {
    lines.push(`- **客户端 CLI 命令**：在终端执行 \`${diag.cliHelpCommand}\` 查看所有命令（模型配置、技能管理、日志清理等）。Agent 可通过 \`bash\` 工具直接执行相关命令完成自我修复或配置调整。`);
  }
  if (diag.systemStatus) {
    const { cpuPercent, memUsedGB, memTotalGB, memPercent, diskDrive, diskUsedGB, diskTotalGB, diskPercent, diskFreeGB } = diag.systemStatus;
    const cpuTip = cpuPercent > 85 ? "（>85% 偏高，建议减少同时进行的任务数）" : "";
    const memTip = memPercent > 90 ? "（>90% 偏高，建议关闭重型任务或切换到轻量模型）" : "";
    let diskTip = "";
    if (diskFreeGB !== undefined && diskFreeGB < 10) diskTip = `（剩余仅 ${diskFreeGB.toFixed(1)}GB，建议清理磁盘空间）`;
    else if (diskPercent > 90) diskTip = "（使用率 >90%，建议清理磁盘）";
    const diskLine = diskDrive
      ? `  - 磁盘 ${diskDrive}：${diskUsedGB.toFixed(1)}/${diskTotalGB.toFixed(1)}GB (${diskPercent}%)${diskTip}`
      : "";
    lines.push(
      "- **系统资源状态**：",
      `  - CPU：${Math.round(cpuPercent)}%${cpuTip}`,
      `  - 内存：${memUsedGB.toFixed(1)}/${memTotalGB.toFixed(1)}GB (${Math.round(memPercent)}%)${memTip}`,
      diskLine,
    ).filter(Boolean);
  }
  if (lines.length === 0) return [];
  return ["", "**客户端诊断信息（你可以直接用工具来查看/修改配置或排查问题）：**", ...lines];
}
```

在 `buildRuntimeSection()` 返回数组的末尾（`clientContextLines` 之后）**展开插入** `buildClientDiagnosticsSection(params.clientDiagnostics)`。

**Step 2: bridge-prompt-composer.ts 采集器**

新增：

```typescript
// 5s 缓存
let _diagCache: { value: ClientDiagnostics; at: number } | null = null;
const DIAG_CACHE_MS = 5000;

function collectCpuPercent(): number {
  // 简单版：os.loadavg()[0] / os.cpus().length * 100；Windows loadavg 不准，可改为用 os.cpus() 抽样 100ms 差
  // 这里给实现：取两次 cpus times 差值计算 idle/total
  const cpus1 = os.cpus().map(c => c.times);
  // Node 同步 sleep 100ms
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  const cpus2 = os.cpus().map(c => c.times);
  let total = 0, idle = 0;
  for (let i = 0; i < cpus1.length; i++) {
    const t1 = cpus1[i], t2 = cpus2[i];
    const dIdle = t2.idle - t1.idle;
    const dTotal = (t2.user + t2.nice + t2.sys + t2.irq + t2.idle) - (t1.user + t1.nice + t1.sys + t1.irq + t1.idle);
    total += dTotal; idle += dIdle;
  }
  return total === 0 ? 0 : Math.max(0, Math.min(100, (1 - idle / total) * 100));
}

function collectDiskStatus() {
  // 以 APP 安装盘或 ~/.lumii 所在盘为准
  const root = getClientDataRoot();  // 从 client-data-root.ts
  try {
    // 方案 A：Node 19+ fs.statfs(root)
    const stats = fs.statfsSync(root);
    // bsize * bavail = free bytes; bsize * blocks = total bytes
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const usedBytes = totalBytes - freeBytes;
    const drive = root.match(/^([A-Za-z]:)/)?.[1] ?? os.platform() === 'win32' ? 'C:' : '/';
    return {
      diskDrive: drive,
      diskUsedGB: usedBytes / 1024 ** 3,
      diskTotalGB: totalBytes / 1024 ** 3,
      diskPercent: totalBytes === 0 ? 0 : usedBytes / totalBytes * 100,
      diskFreeGB: freeBytes / 1024 ** 3,
    };
  } catch {
    return null;
  }
}

function collectClientDiagnostics(): ClientDiagnostics {
  const now = Date.now();
  if (_diagCache && now - _diagCache.at < DIAG_CACHE_MS) return _diagCache.value;

  const cpuPercent = collectCpuPercent();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const disk = collectDiskStatus();

  const value: ClientDiagnostics = {
    logsDir: join(getClientDataRoot(), 'logs'),
    cliHelpCommand: 'lumii --help',
    systemStatus: {
      cpuPercent,
      memUsedGB: usedMem / 1024 ** 3,
      memTotalGB: totalMem / 1024 ** 3,
      memPercent: totalMem === 0 ? 0 : usedMem / totalMem * 100,
      ...(disk ?? {}),
    },
  };
  _diagCache = { value, at: now };
  return value;
}
```

注意：`collectCpuPercent` 中 `Atomics.wait(100ms)` 阻塞主线程 100ms 每 5 秒一次——对桌面应用可接受；如嫌阻塞改用异步 Promise + setTimeout，但 `buildPromptWithMemory` 是异步函数就可以。优先改成**异步版**：`collectCpuPercentAsync()` 用 `new Promise(r => setTimeout(r, 100))` 代替 Atomics。

在 `buildPromptWithMemory()` 的开头（或 PromptComposer 组装 params 的位置）调用：

```typescript
const clientDiagnostics = collectClientDiagnostics();  // 如果 CPU 改成异步就 await
```

并把 `clientDiagnostics` 透传给 promptRebuilder / buildPrompt / buildClientSystemPromptStructured 的对应 `params.clientDiagnostics`。需要在 bridge-prompt-composer.ts 内查找当前如何把参数塞给 builder——可能是在 `bridge-instance-factory.ts:assembleSystemPrompt 调用点`，需要透传。

**Step 3: assembleSystemPrompt 与调用点参数透传**

检查 host-kit 的 `PromptContextProvider` / `PromptAssembleParams` 是否已经能扩展任意字段；如果 buildPrompt 闭包的参数在每轮调用时只是 `(hints, currentModelId, routerLite)` 三个——需要在 `bridge-prompt-dispatcher.ts` 的 promptRebuilder 调用处**额外包一层**，把 clientDiagnostics 固定到 params 里，例如：

```typescript
// 桥接层改：
const baseResult = baseRebuilder(hints, currentModelId, routerLite);
// 然后用 baseResult.staticPrompt + CACHE_BOUNDARY + (dynamicPrompt + buildClientDiagnosticsSection 的输出拼接)
```

因为 `baseRebuilder` 返回的是 static/dynamic/full 三段字符串，而不是重新跑一遍 buildClientSystemPromptStructured——这样最干净，不需要改 host-kit 闭包签名。**推荐此方案**：直接在 BridgePromptComposer 里把 clientDiagnostics section 追加到 dynamicPrompt 末尾，比改多层参数链更简单。

具体：
```typescript
// bridge-prompt-composer.buildPromptWithMemory():
const { staticPrompt, dynamicPrompt } = this.instanceStates.get(instanceId)!.basePrompt;
const diagLines = buildClientDiagnosticsSection(collectClientDiagnostics());
const diagBlock = diagLines.join("\n");
const augmentedDynamic = dynamicPrompt + (dynamicPrompt && diagBlock ? "\n" + diagBlock : diagBlock || "");
// 然后按原逻辑把 active tasks / memory / VH section 追加到 augmentedDynamic
const finalDynamic = [augmentedDynamic, taskSection, memorySection, vhSection].filter(Boolean).join("\n");
```

**buildClientDiagnosticsSection 函数需要在 bridge-prompt-composer.ts 内单独实现一份**（因为 buildPromptWithMemory 已经把 static/dynamic 切分好了，不需要回到 system-prompt-builder.ts 里去改——两种方式都行，推荐 bridge-prompt-composer 内追加，不需要动通用层的参数透传链）。

**Step 4: 日志目录验证**

确认 `getClientDataRoot() + '/logs'` 实际会生成 `main.log` / `renderer.log` 等文件——如果日志目录不同（如项目里用 `logs/` 而不是直接在 clientDataRoot 下），grep 找 `main.log` 写盘位置后修正 `logsDir` 路径。

**Step 5: 验证**
```bash
pnpm typecheck
```
在 Windows 端发一条对话，调试打印完整 system prompt（或加一条临时 info log 输出前 5000 字），检查末尾是否有「**客户端诊断信息**」段落，包含日志路径、lumii CLI 命令、CPU/内存/磁盘数值。间隔 <5s 再发一条数值相同，>5s 再发数值刷新。

---

## Task 5: 全量类型检查 + 基础测试

**Commands:**
```bash
# 根目录
pnpm typecheck

# 工具使用统计相关单测
cd apps/windows
npx vitest run src/main -t "tool-usage"  # 如果有相关测试文件；无则跳过
```

**手动验收 checklist：**
- [ ] Task 1 基线 D：旧 tool-usage.json → SQLite 迁移成功
- [ ] Task 2 基线 A：skill_invoke 3 次后 Skills 页卡片使用次数 ≥3
- [ ] Task 3 基线 B：模型 Key 失效时三渠道都收到「已收到」+「处理失败：xxx」
- [ ] Task 4 基线 C：Windows 端对话的 system prompt 含诊断段落；5s 缓存生效
- [ ] 桌面端（非渠道）会话不出现多余的"✅ 已收到，正在处理…"回执

---

## 风险与回滚点

| 风险 | 影响 | 缓解方案 |
|------|------|---------|
| SQLite UPSERT 批量事务失败 | 启动时内存计数缺失，对话中工具计数不更新但不阻塞对话 | 启动迁移失败时退化为内存 Map + 旧 JSON 文件（降级开关 `FORCE_LEGACY_TOOL_USAGE_JSON=1`） |
| 渠道回执发送失败（微信 context_token 24h 过期） | 回执/错误回复用户收不到，但会话与日志不受影响 | 回执发送失败 log.warn 不抛错；主路径正常继续 |
| CPU 采集阻塞 >100ms | 每 5 秒一次，但对话高峰期影响体验 | 改为异步采样 + 缓存；或直接用 os.loadavg（Windows 略不准但零阻塞） |
| fs.statfsSync 在 Node <19 不存在 | disk 采集失败，段落少一行磁盘信息 | try/catch 包 collectDiskStatus，失败时返回 null，不影响其他两项注入 |
