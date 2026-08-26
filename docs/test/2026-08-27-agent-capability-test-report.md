# Agent 能力全面测试报告

- 日期：2026-08-27
- 用例文档：`docs/test/2026-08-27-agent-capability-test-cases.md`
- 证据文件：`docs/test/2026-08-27-agent-capability-evidence.jsonl`
- 执行器：
  - `docs/test/run-agent-capability-suite.mjs`
  - `docs/test/run-agent-capability-suite-continue.mjs`
  - `docs/test/run-agent-capability-skipped.mjs`
- 环境：`pnpm dev:start` + `lumii-ui` CLI；真实模型与真实本地数据（`~/.lumii`）
- 主日志：`.lumii-dev.log`

---

## 1. 总评

| 项 | 结论 |
|---|---|
| **能力可用（必须项门槛）** | **通过** |
| 去重后用例 | 30（含 D-ABORT-CLI；H-03/C-03 SKIP） |
| PASS | 28 |
| FAIL | 0 |
| SKIP | 2（C-03、H-03） |

必须项：A 全过；C-01/C-02/C-04；D-01/D-03；F-01；G-01 → **全部 PASS**。

---

## 2. 结果明细

### A 冒烟 — 全 PASS

| ID | 结果 | 说明 |
|---|---|---|
| A-01 | PASS | `tools list` 含 `spawn_agent` |
| A-02 | PASS | `conversation create` 返回 sessionKey |
| A-03 | PASS | `context messages` 可读 |
| A-04 | PASS | 未知命令 exit=2 |

### B 基础对话 — 全 PASS

| ID | 结果 | 说明 |
|---|---|---|
| B-01 | PASS | 短指令「测试通过」 |
| B-02 | PASS | 多轮复述 `ALPHA-42` |
| B-03 | PASS | 未调用工具的诚实回复 |

### C 子 Agent 调度

| ID | 结果 | 说明 |
|---|---|---|
| C-01 | PASS | sync `sync-1` register+finalize |
| C-02 | PASS | 双 async 投递 + 汇总 |
| C-03 | SKIP | 由 C-01+C-02 覆盖 |
| C-04 | PASS | `[Subagent] complete` ×2 |

### D 打断与恢复 — 全 PASS

| ID | 结果 | 说明 |
|---|---|---|
| D-01 | PASS | `Aborted agent` + `abortSession` |
| D-02 | PASS | abort 后可恢复（重试策略） |
| D-03 | PASS | 父子 cascade abort |
| D-ABORT-CLI | PASS | `send abort` 返回 `{ok:true}`（已修 CLI 瑕疵） |

### E 工具能力 — 全 PASS

| ID | 结果 | 说明 |
|---|---|---|
| E-01 | PASS | `skill_search` |
| E-02 | PASS | `memory_search` |
| E-03 | PASS | `wiki_*` |
| E-04 | PASS | `web_search` |
| E-05 | PASS | `bash` → `CAP_TEST_OK` |
| E-06 | PASS | `tools toggle` off→on 恢复 |

### F 复杂编排 — 全 PASS

| ID | 结果 | 说明 |
|---|---|---|
| F-01 | PASS | 多工具 + 子 Agent + DONE |
| F-02 | PASS | 计划—执行—校验 |
| F-03 | PASS | 并行子任务综合 |
| F-04 | PASS | 未知 agentType error → explore 恢复 |

### G 边界护栏 — 全 PASS

| ID | 结果 | 说明 |
|---|---|---|
| G-01 | PASS | 并发第 6 次拒绝 |
| G-02 | PASS | 深度护栏（registry `getDepth` + 复测） |
| G-03 | PASS | `startStaleMonitor` |

### H 会话运维

| ID | 结果 | 说明 |
|---|---|---|
| H-01 | PASS | `context usage` |
| H-02 | PASS | `context messages` |
| H-03 | SKIP | 手动 compact 可选 |

---

## 3. 本轮代码修复（随测试发现）

### 3.1 `send abort` CLI `command_failed`

- **根因：** `handleCommand('user:abort')` 返回 `undefined` → `JSON.stringify(undefined)` → `res.end(undefined)` TypeError。  
- **修复：** 返回 `{ ok: true }`；`user:abort` 加入 `QUEUE_BYPASS_COMMANDS`；`sendJson` 对 undefined 兜底。  
- **单测：** `server.test.ts` 新增免排队 + undefined body 用例（32 PASS）。

### 3.2 深度护栏（G-02，此前已修）

- `AgentRegistry.getDepth` + `resolveSpawnDepth`：子实例再 spawn 按父子链拒绝。

### 3.3 未知 `agentType` 静默回落（F-04）

- **根因：** `resolveDefinition` 对未知类型回落 `BUILT_IN_AGENTS[0]`，错误恢复测不通。  
- **修复：** 未知类型 `throw Error('Unknown agent type: ...')`，由 orchestrator 返回 `status:error`。  
- **复测：** 第一次 error，第二次 `builtin:explore` → `GOOD_OK`。

---

## 4. 仍可选 / 体验项

| 项 | 说明 |
|---|---|
| H-03 compact | 不阻塞能力结论 |
| C-03 混合调度 | 已被 C-01+C-02 覆盖 |
| abort 后指令遵循 | 模型偶发续跑旧任务；建议产品侧清计划提示 |
| `builtin:general` 等别名 | 修复后须存在于 store/builtin，否则报 Unknown（符合预期） |

---

## 5. 复现

```bash
pnpm dev:start
node docs/test/run-agent-capability-suite.mjs
node docs/test/run-agent-capability-suite-continue.mjs   # 可选续跑
node docs/test/run-agent-capability-skipped.mjs          # 补跑 SKIP + abort CLI
pnpm dev:stop
```

---

## 6. 结论

Agent 主路径与本轮补测项均已用真实 CLI E2E 验证通过；随测修复了 abort CLI 序列化、深度推导、未知 agentType 静默回落三处问题。当前 **FAIL=0**，必须项门槛通过。
