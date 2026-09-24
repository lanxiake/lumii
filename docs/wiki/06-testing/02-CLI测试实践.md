# CLI 测试实践

## 1. Lumii CLI 测试架构

本项目采用「Node 脚本执行器 + JSONL evidence 留痕 + Markdown 报告」三件套架构，实现真实环境下 CLI 命令的自动化全链路验证。

### 1.1 架构分层

| 层级 | 组件 | 职责 |
|------|------|------|
| 执行层 | `run-*-suite.mjs` | 逐条执行用例、超时控制、重试退避、结果记录 |
| 留痕层 | `*-evidence.jsonl` | 每条用例结构化记录（输入/输出/断言/耗时） |
| 报告层 | `*-test-report.md` | 人类可读的执行概览、失败分析、改进建议 |
| 定义层 | `*-test-cases.md` | 用例前置条件、输入、预期、断言方式说明 |

### 1.2 核心设计原则

- **真实链路优先**：所有测试经 `lumii-ui.mjs` → 控制口 HTTP → IPC → 数据库完整路径，不绕过任何层
- **可复现**：evidence.jsonl 完整记录每次运行的输入输出，失败可单独复现
- **可续跑**：中途中断后可从断点继续，不重跑已 PASS 的用例
- **防污染**：默认不删除业务数据，仅清理带探针前缀（`wiki-cli-*` / `autonomous-test-*`）的测试数据

---

## 2. 测试套件目录结构

每个 CLI 测试套件由 4 个标准文件组成：

```
docs/test/lumii-cli/
├── wiki-p0-test-cases.md          # 用例定义文档
├── run-wiki-cli-suite.mjs         # 执行器脚本
├── wiki-cli-evidence.jsonl        # 逐条证据（运行时生成）
└── wiki-cli-test-report.md        # 测试报告（运行时生成）
```

| 文件 | 必选 | 说明 |
|------|------|------|
| `*-test-cases.md` | 是 | 用例说明：前置条件、输入、预期输出、断言逻辑 |
| `run-*-suite.mjs` | 是 | Node 可执行脚本，内置用例数组、断言、记录函数 |
| `*-evidence.jsonl` | 运行生成 | 每行一条 JSON，含 ts/id/status/note/extra |
| `*-test-report.md` | 运行生成 | 汇总统计 + 明细表 + 结论 |

**带辅助资源的套件**：标准四件套之外，套件可以自带 `lib/`（**本套件专用**的库，与共享的 `lib/cli-harness.mjs` 区分）与 `fixtures/`（探针素材）。目前只有 `browser/` 用到——它的裸 CDP 观测通道与确定性探针页面不适合塞进共享库，理由见 [CLI-TEST-SPEC.md §10](../../test/lumii-cli/CLI-TEST-SPEC.md)。

---

## 3. run-suite.mjs 执行器模式

### 3.1 执行器标准骨架

```javascript
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const LUMII_UI = path.join(ROOT, 'apps/windows/resources/app-ui-cli/lumii-ui.mjs')
const EVID = path.join(__dirname, 'xxx-evidence.jsonl')
const REPORT = path.join(__dirname, 'xxx-test-report.md')

const results = []

function ui(args, input, { retries = 6 } = {}) {
  let last = { code: 1, out: '', json: null }
  for (let i = 0; i <= retries; i++) {
    const r = spawnSync(process.execPath, [LUMII_UI, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      input,
      maxBuffer: 20 * 1024 * 1024,
    })
    const out = (r.stdout || '') + (r.stderr || '')
    let json = null
    try { json = JSON.parse((r.stdout || '').trim()) } catch {}
    last = { code: r.status ?? 1, out, json }
    if (json?.error !== 'rate_limited' && !/rate_limited/.test(out)) return last
    sleep(Math.min(20000, 5000 * (i + 1)))
  }
  return last
}

function record(id, status, note, extra = {}) {
  const row = { ts: new Date().toISOString(), id, status, note, ...extra }
  results.push(row)
  fs.appendFileSync(EVID, JSON.stringify(row) + '\n', 'utf8')
  console.log(`[${id}] ${status} — ${note}`)
}

function main() {
  fs.writeFileSync(EVID, '', 'utf8')
  const ping = ui(['wiki', 'page', 'list'])
  if (ping.code === 3 || /connection_failed/.test(ping.out)) {
    console.error('控制口不可达，请先启动应用（pnpm dev）')
    process.exit(3)
  }
  runAllCases()
  writeReport()
}
```

### 3.2 核心能力

| 能力 | 实现方式 |
|------|----------|
| **逐条运行** | try-catch 包裹单条用例，任何一条失败不影响后续 |
| **超时控制** | `spawnSync` 自带 `timeout` 选项；模型调用默认 120s |
| **PASS/FAIL 记录** | `record()` 函数统一写入 JSONL + stdout 同步输出 |
| **断点续跑（continue 模式）** | 执行前读取已有 evidence.jsonl，跳过已 PASS 的用例 |
| **rate_limited 重试** | 遇控制口限流自动退避重试（5s→10s→15s→20s 封顶） |
| **播种-清理对** | 用 SQL 直接插入探针数据，跑完按 id/前缀清理 |

### 3.3 执行器清单

| 执行器文件 | 用途 |
|------------|------|
| `run-lumii-cli-suite.mjs` | 通用 CLI：UI、Agent、Cron、Memory |
| `run-wiki-cli-suite.mjs` | Wiki P0/P1/P2 全部子命令 + IPC GAP |
| `run-wiki-real-materials-suite.mjs` | 真实文档（PDF/DOCX/MP4）摄入→归档→检索端到端 |
| `run-agent-capability-suite.mjs` | Agent 能力 A-H 八大套件主执行器 |
| `run-agent-capability-suite-continue.mjs` | Agent 能力中断后续跑 |
| `run-agent-capability-skipped.mjs` | Agent 能力 SKIP 项 + abort CLI 补跑 |
| `run-autonomous-cli-suite.mjs` | 自主进化 CLI（P0 功能） |
| `run-autonomous-e2e.mjs` | 自主进化 CLI 基础 E2E |
| `run-autonomous-life-e2e.mjs` | 自主生命 E2E（心跳、状态机） |
| `run-autonomous-planning-e2e.mjs` | 自主规划 E2E（目标生成、执行） |
| `run-autonomous-full-e2e.mjs` | 自主进化全链路 E2E（生命+规划+CLI） |
| `run-ui-cli-suite.mjs` | UI 操作 CLI（screenshot、goto、click） |

---

## 4. evidence.jsonl 结构

每行一条 JSON 记录，换行分隔（JSONL 格式）。

### 4.1 标准字段

| 字段 | 类型 | 必选 | 说明 |
|------|------|------|------|
| `ts` | string | 是 | ISO 时间戳 |
| `id` | string | 是 | 用例 ID（如 `P0-A01`、`B-03`） |
| `status` | string | 是 | `PASS` / `FAIL` / `SKIP` / `BLOCKED` |
| `note` | string | 是 | 人类可读的说明或失败消息 |
| `durationMs` | number | 否 | 单条耗时毫秒 |
| `code` | number | 否 | CLI 退出码 |
| `exitCode` | number | 否 | 同步记录 |
| `extra` | object | 否 | 任意附加字段（返回数、命中数、version 等） |

### 4.2 示例

```json
{"ts":"2026-08-27T02:27:23.312Z","id":"P0-A01","status":"PASS","note":"n=28"}
{"ts":"2026-08-27T02:27:25.001Z","id":"P1-E04","status":"SKIP","note":"危险路径导出未强制实现"}
{"ts":"2026-08-27T02:28:01.123Z","id":"C-02","status":"FAIL","note":"双 async 投递缺失 delivered 日志: expected 2 got 1","durationMs":3812}
```

---

## 5. 测试报告标准模板

### 5.1 报告结构

```markdown
# <套件名称> 测试报告

- 日期：<ISO 时间戳>
- 环境：<运行环境说明>
- 数据库：<DB 路径>
- 汇总：**PASS X** / **FAIL Y** / **SKIP Z** / 合计 N

## 结论

<一句话结论 + PASS/FAIL 门槛判断>

## 执行概览

| 指标 | 值 |
|------|-----|
| 通过率 | X/N = Y% |
| 总耗时 | mm:ss |
| 阻塞项数量 | Z |
| 新发现缺陷 | # |

## 明细

| ID | 状态 | 说明 |
|----|------|------|
| ... | ... | ... |

## 失败分析

### FAIL-01: <用例 ID>

- **失败消息**：<note 原文>
- **根因推测**：<代码位置/模块>
- **严重度**：高/中/低
- **建议修复**：<最小改动方向>

## 覆盖说明

<按套件分述覆盖的命令/功能点>

## 本轮代码修复（如适用）

1. <修复 1 描述>
2. <修复 2 描述>

## 环境信息

| 项 | 值 |
|----|-----|
| 操作系统 | <os.type()> <os.release()> |
| Node 版本 | process.version |
| 应用启动方式 | pnpm dev / 正式包 |
| 模型配置 | <主要模型 ID> |

## 下次改进建议

1. <建议 1>
2. <建议 2>
3. <建议 3>

证据：<evidence.jsonl 相对路径>
```

### 5.2 报告样例（Wiki CLI 报告摘要）

| 统计项 | 值 |
|--------|-----|
| 日期 | 2026-08-27T02:27:23.312Z |
| 汇总 | PASS 67 / FAIL 0 / SKIP 8 / 合计 75 |
| P0 覆盖 | inbox organize/discard/retry/逃逸、金标检索、索引、page CRUD |
| P1 覆盖 | wikilink 反链、回滚、清理归档、导出三选项、unresolved/concept GAP |
| P2 覆盖 | synthesis accept/reject、graph 约束、hybrid、vector/ero、status:scan |

---

## 6. 现有 CLI 测试套件索引

### 6.1 Wiki CLI 套件

| 套件 | 优先级 | 覆盖范围 | 用例数示例 |
|------|--------|----------|------------|
| P0 收件箱闭环 | P0 | inbox organize/discard/retry、路径逃逸防护、收件箱计数一致性 | 25+ |
| P1 双链与修订 | P1 | wikilink 反链、未解析保留、修订回滚、清理导出、归档检索观察 | 20+ |
| P2 综述与检索 | P2 | synthesis create→accept/reject、hybrid 搜索 | 10+ |
| 真实材料套件 | 真实场景 | 小学教材 PDF + 技术 DOCX + 教学 MP4 的摄入→归档→检索→打开 | 8+ |

### 6.2 Agent 能力测试（A-H 八大套件）

| 套件 | 名称 | 核心内容 |
|------|------|----------|
| A | 冒烟 | CLI↔运行时可用、会话创建、工具可列 |
| B | 基础对话 | 短指令遵循、多轮上下文保持、诚实性拒绝编造 |
| C | 子 Agent 调度 | sync/async 模式、投递分流（prompt-internal / followUp）、混合调度 |
| D | 打断与恢复 | 父任务 abort、级联 abort 子 Agent、abort 后恢复可聊 |
| E | 单项工具能力 | skill/memory/wiki/search/file/bash 各工具、工具开关可观测 |
| F | 复杂编排 | 多工具流水线 + 子 Agent、计划-执行-校验、未知 agentType 错误恢复 |
| G | 边界护栏 | 并发上限拒绝、深度护栏、stale monitor |
| H | 会话运维 | context usage、context messages、（可选）手动 compact |

### 6.3 自主进化 CLI 套件

| 套件 | 优先级 | 覆盖范围 |
|------|--------|----------|
| P0 自主 CLI | P0 | 表结构、help 暴露、status 空数据降级、满意度计算、目标 CRUD、能力维度 |
| P1 自主生命 E2E | P1 | 心跳 tick、状态机运转、内在目标生成、人格事件落库 |
| P1 自主规划 E2E | P1 | 目标批准流转、执行调度、反思记录、变体成功率计算 |
| 全链路 E2E | P1 | 自主生命 + 自主规划 + CLI 查询贯通 |

### 6.4 上下文压缩测试

| 维度 | 内容 |
|------|------|
| 边缘场景 | 空会话压缩幂等、极低 token 窗口地板、极长参数截断、大结果摘要阈值 |
| 真实用户场景 | 从日志抽取真实长对话回放、token 预算溢出回归、重复注入去重 |
| CLI 冒烟（A 套件） | 应用未运行退出码、白名单两道闸、认证失败 |
| 真实模型主套件（B 套件） | 建会话→收发→usage→手动压缩→messages 校验摘要 |
| Phase 1/2/3 各阶段 | 微压缩常量核对、Idle 轮询存活、ProgressFence 双预算、事务原子性、冷却落库 |

### 6.5 浏览器控制套件（2026-09-21 新增）

| 套件 | 优先级 | 覆盖范围 | 用例数 |
|------|--------|----------|--------|
| 浏览器控制（BROWSER） | P0/P1 | 10 个 `browser_*` 工具的准确性 + 稳定性 + 错误处理 | 19（全通过） |

**这一类套件与其余的都不同**：浏览器工具**没有命令面**（CLI 无浏览器命令，控制口白名单
`app-ui-control/command-allowlist.ts` 未收录，`browser-control` 的 dispatcher 是进程内的），
驱动**只能走真实 LLM 回合**。于是判据必须另开独立通道——套件用**裸 CDP** 直连
`127.0.0.1:18791` 读页面真实状态，要求「执行层（DB `messages.parts` 的 `tool` 块）
+ 效果层（CDP 直读）」**双证据**，模型在正文里的自述一律不作为判据。

**为什么不能只用工具层取证**：用 `browser_eval` 自读页面等于拿被测对象验证被测对象——
2026-09-21 的幻觉事故里模型编了一个 `File written` 的返回，当时没有任何独立通道能证伪它。

通用做法（判据结构、驱动批量化/判定细粒度、三条配套要求）见
[CLI-TEST-SPEC.md §10](../../test/lumii-cli/CLI-TEST-SPEC.md)。该套件跑出来的实测发现
——**首次截图 79–231 秒**、无标签管理等——见
[fix/2026-09-21-浏览器控制工具调查与修复.md](../../fix/2026-09-21-浏览器控制工具调查与修复.md)。

---

## 7. 真实材料测试的组织

### 7.1 材料多样化矩阵

| 类型 | 示例文件 | 验证重点 |
|------|----------|----------|
| 长 PDF 教材 | 小学 1 年级语文课本（上/下册） | 分页摄入、长文本切分、字符集兼容、目录索引 |
| 技术 DOCX | Claude Code 集成方案 | 标题层级保留、表格解析、代码块识别 |
| 教学视频 MP4 | 颠覆重力拍摄法、拍照姿势 | 音频提取转写、字幕对齐、视频元数据 |

### 7.2 端到端执行流程

```
播种真实材料
    ↓
wiki inbox ingest（或 CLI 摄入）
    ↓
等待异步摄入完成（轮询 inbox status）
    ↓
organize（归档到资料层）
    ↓
wiki search 验证可检索
    ↓
wiki page read 打开页面
    ↓
再次归档确认重复摄入幂等
    ↓
清理（仅删除带 wiki-real-materials-* 前缀页面）
```

---

## 8. 跳过项和失败项的分类处理与补跑策略

### 8.1 SKIP 分类表

| SKIP 原因 | 示例 | 补跑方式 |
|-----------|------|----------|
| 防污染保护 | synthesis confirm、source:delete（`WIKI_CLI_ALLOW_DELETE!=1`） | 设置环境变量后单独补跑 |
| 手工操作 | 四路摄入（文件拖拽 UI） | 人工验证清单勾选 |
| 模型未配合 | `WIKI_CLI_SKIP_AGENT=1` 跳过 Agent 搜索 | 关闭开关重跑 |
| 环境缺依赖 | web_search 未配置、bash 权限受限 | 配置后补跑或记录为条件通过 |
| 成本过高 | Idle 真实触发（>390K tokens / 6+ 分钟） | 单测覆盖 + 低阈值配置降成本回归 |

### 8.2 FAIL 分类处理流程

```
FAIL 出现
   ↓
分类：①测试基础设施问题 ②用例断言过严 ③真实业务缺陷
   ↓
① 基础问题 → 修复执行器/控制口白名单/环境
② 断言过严 → 调整断言为结构断言/关键词匹配 + 放宽数值容忍
③ 业务缺陷 → 写入报告「失败分析」节，关联 issue 或修复文档
   ↓
修复后补跑：run-*-suite-continue.mjs（只重跑 FAIL/SKIP）
   ↓
仍失败 → 降级为 BLOCKED，单独跟踪不纳入通过率
```

### 8.3 执行命令示例

```bash
# 主套件全量
node docs/test/lumii-cli/run-wiki-cli-suite.mjs

# 允许清理操作（慎用）
WIKI_CLI_ALLOW_DELETE=1 node docs/test/lumii-cli/run-wiki-cli-suite.mjs

# 跳过模型调用（只测数据层）
WIKI_CLI_SKIP_AGENT=1 node docs/test/lumii-cli/run-wiki-cli-suite.mjs

# Agent 能力主套件 + 续跑 + 补跑 SKIP
node docs/test/run-agent-capability-suite.mjs
node docs/test/run-agent-capability-suite-continue.mjs
node docs/test/run-agent-capability-skipped.mjs
```
