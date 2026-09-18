# 工具面治理验证（TC）测试用例

> 领域：工具设计与工具面治理
> 执行器：[`run-tool-contract-e2e.mjs`](./run-tool-contract-e2e.mjs)
> 规范：[`../CLI-TEST-SPEC.md`](../CLI-TEST-SPEC.md)
> 背景：[`../../../plans/Agent协作与提示词/2026-09-18-工具面治理执行计划与场景推演.md`](../../../plans/Agent协作与提示词/2026-09-18-工具面治理执行计划与场景推演.md)
> 探针前缀：`[tc-suite]`；探针文件目录：`~/.lumii/workspace/temp/`

## 这套件在验什么

2026-09-18 的工具面复盘发现：**治理的射程按「层」切，而病灶长在「接缝」上**。其中两条已实施：

| 改动 | 内容 | 本套件怎么验 |
|---|---|---|
| ① | 修 5 处失效引用（`old_string` ×3 / `read_file` / `skill_list`） | TC-02（行为面）、TC-03（行为面） |
| ② | 工具失败审计回填 `duration_ms` | TC-01（数据面） |

**文本本身**（schema 描述、错误文案里引用的工具名）由单测
`packages/agent-runtime/src/tools/__tests__/tool-name-references.test.ts` 守——
它能精确到"哪个文件的哪段文本引用了谁"，且做过变红验证（注入失效名即失败）。
**两层分工：单测守文本，CLI 守行为。**

---

## TC-CONTRACT-01 工具失败审计带 duration_ms

- **优先级**：P0
- **层**：L2（数据链路）
- **前置**：客户端已 `dev:restart`（改动 ② 在主进程与 packages 两侧）
- **真实数据**：`tool_audit_log` 表；探针路径指向一个不存在的文件
- **步骤**：
  1. 记录当前 ISO 时间戳作为 baseline
  2. 新建探针会话，要求 agent 用 `file_read` 读一个不存在的文件
  3. 等回合完成，查 `tool_audit_log` 中该时间戳之后的 `file_read` 记录
- **预期**：新增记录数 > 0，且**全部** `duration_ms IS NOT NULL`
- **断言**：**硬**（计数与空值判定都是确定的）
- **为什么用 `file_read`**：它是只读免确认工具，`checkPermission` 返回 allowed 时**不写**权限审计
  （只有 denied / needs_confirmation 才写），所以这张表里查到的 `file_read` 记录必然来自工具执行出口。
  且它读不到文件时是**让宿主异常自然抛出**（源码里既无 `details.success:false` 也无捕获），
  正好走 `onError` 分支——两条出口都要验。
- **基线**：改动前 `tool_audit_log` 非 LLM 记录 **4158 条，`duration_ms` 无一有值**（LLM 记录是 9873/9873 有值）
- **预计回合**：1

## TC-CONTRACT-02 file:// 场景不得调用不存在的 read_file

- **优先级**：P0
- **层**：L3（真实聊天模拟）
- **前置**：日志通道可用；套件会**临时切 detailed 档**（结束恢复）
- **真实数据**：探针文件 `temp/tc-fileurl-probe.txt`（内容 `PROBE-OK-20260918`）
- **步骤**：
  1. 切 `promptStyle.style = detailed`
  2. 写探针文件，新建会话，让 agent 读取 `file:///<探针路径>`
  3. 等回合完成，从日志游标后的 `tool:end` 事件里取工具序列
- **预期**：**不出现** `toolName=read_file`
- **断言**：工具序列 = **硬**；`file_read` 是否被调用 = 不判（模型直接说明 file:// 不可用也算合理行为）
- **为什么必须切 detailed**：minimal 档下简单工具的 schema 描述会被
  `tool-definition-style.ts` 裁掉（`web_fetch` 只有 3 个参数 < 5），
  而 `web-fetch-tool.ts:30` 的失效引用正在那段描述里——**只有 detailed 档才把这句话发给模型**。
  生产实测 minimal 621 次 / terse 18 次，所以这个用例的失败面在生产里其实更小；
  它守的是"这句话存在时会不会误导模型"。
- **基线**：日志里实测出现过 `tool:end toolName=read_file isError=true` × 1
  （`Tool read_file not found`），且该名字在全仓库的唯一出处就是那行描述
- **预计回合**：1

### 对照实验（2026-09-18 实测，结论与预期不符）

**做法**：把 `web-fetch-tool.ts:30` 的描述临时改回失效的 `read_file` → `dev:restart` → 连跑 3 次 TC-02。

**结果**：

| 样本 | 描述里写的是 | 模型实际调用 | 结果 |
|---|---|---|---|
| 改动后 ×2 | `` `file_read` `` | `file_read` | PASS |
| **改动前（注入失效引用）×3** | `` `read_file` `` | **`file_read`** | **PASS** |
| | | | **3/3 未被误导** |

**结论：这处失效引用在当前模型上不产生可观测的行为差异。**

**由此修正本文先前的一处归因**：日志里那 1 次 `Tool read_file not found`，
先前被归因给 `web-fetch-tool.ts:30` 的描述引用（理由是"该名字在代码库里唯一"）。
对照实验说明这个推理不成立——**更可能来自模型自身的先验**（`read_file` 在训练语料里极常见），
而不是这行文字的诱导。**那是过度归因。**

**修复仍然保留**，理由是成本与风险不对称：改动是 1 行文本、零行为风险，
消除的是一个"万一被模型当真"的误导源；但**不应把它计入"已获得的行为收益"**。

**这也给守卫的价值重新定了位**：`tool-name-references.test.ts` 抓的是**文本一致性**，
不是"能观测到的行为改善"。同类失效引用的真正危害场景应逐个实测，不要凭名字推断。

## TC-CONTRACT-03 真实文件编辑一次成功、无参数校验失败

- **优先级**：P0
- **层**：L3
- **前置**：日志通道可用
- **真实数据**：探针文件 `temp/tc-edit-probe.md`（内容含「原始内容 A」）
- **步骤**：
  1. 写探针文件，新建会话，要求 agent 把「原始内容 A」改成「修改后的内容 B」
  2. 等回合完成，取工具序列与 `Validation failed` 计数
  3. 回读文件内容
- **预期**：至少一次成功的 `file_edit`；**无** `Validation failed`；文件里出现新内容且旧内容消失
- **断言**：工具序列与文件内容 = **硬**；无参数校验失败 = **硬**（日志正则）
- **这条守的是什么**：`file-edit-tool.ts` 的两处错误文案曾把参数名写成 `old_string`
  （schema 里是 `oldString`）。错误文案在 `content` 里、**全档位可见**——
  minimal 档也躲不掉。模型照着错的参数名重试时，那次失败会走参数校验路径，
  而校验在 `tool.execute` 之前抛错，**不进 hook 链**，所以在统计里完全不可见。
  这条用例是少数能在事件层抓到它的地方。
- **预计回合**：1

## TC-CONTRACT-04 提示词分组现状（INFO）

- **优先级**：P2
- **层**：L2
- **真实数据**：最近一次 `[llm-prompt:full]` 转储里的 `Groups:` 行
- **预期**：记录 `Other Tools` 与 `Desktop Control` 的数量
- **断言**：**INFO，不是 PASS/FAIL**
- **为什么不做成断言**：0.3「扩守卫射程」尚未实施，`Other Tools` 非零是**已知待办**。
  把它算成失败会掩盖"本套件验证的两项改动其实都通过了"这个事实。
  它的作用是给 0.3 提供施工前后的对照数字。
- **基线**：`Other Tools (9)` + `Desktop Control (18)`，共 27 个工具在任何正式分组之外
- **预计回合**：0（复用前序回合的日志）

## TC-CONTRACT-05 工具面与守卫射程的覆盖率

- **优先级**：P2
- **层**：L2
- **真实数据**：日志里的 `tools=N/M` 行
- **预期**：报告本次请求暴露了多少工具，以及守卫射程（68）的覆盖率
- **断言**：`tools=N/M` 行存在 = **硬**；覆盖率数字 = 观察值
- **基线**：`tools=116/116`（含 MCP）；不含 MCP 的分组合计为 94，守卫射程 68 → 覆盖 **72.3%**
- **预计回合**：0

---

## 不在本套件覆盖范围内的

| 项 | 为什么不在 | 在哪验 |
|---|---|---|
| 描述文本里的工具名引用 | CLI 没有工具定义转储通道（只有 `tools=N/M` 计数与 system prompt 转储） | 单测 `tool-name-references.test.ts` |
| 参数校验失败是否入库 | 事件层已可见（日志），入库是**观察项**（执行计划 §三 1.3 明确不立即做） | 执行计划 §四 A6 |
| `isError` 契约统一（批次 1） | **尚未实施** | 执行计划 §三 批次 1 |
| 扩守卫射程（0.3） | **尚未实施** | 执行计划 §三 0.3；本套件 TC-04/05 提供基线 |
| 云同步超时保持 `isError:false` | 属回归断言，需真实同步冲突场景 | 执行计划 §四 A6 的回归断言 |

## 运行方式

```bash
cd <repo root>
node docs/test/lumii-cli/tool-contract/run-tool-contract-e2e.mjs

# 只跑某条
TC_ONLY=TC-CONTRACT-01 node docs/test/lumii-cli/tool-contract/run-tool-contract-e2e.mjs

# 保留现场（不恢复 promptStyle、不删探针文件）
TC_NO_RESTORE=1 node docs/test/lumii-cli/tool-contract/run-tool-contract-e2e.mjs
```

**副作用与恢复**：套件会临时改 `promptStyle.style`（TC-02 需要 detailed），结束时恢复原值；
探针文件写在 `~/.lumii/workspace/temp/` 下，结束时删除；不触碰任何用户业务数据。

---

## 本套件开发中踩到的两个坑（2026-09-18）

### 1. 恢复动作必须挂在 `process.on('exit')`，不能只写在末尾

**症状**：一次对照实验后，用户的 `promptStyle` 被静默改成了测试用的 `detailed`，
此后每次运行都把 detailed 当成"原始值"再"恢复"成 detailed——**用户的设置就这样被测试吃掉了**。

**根因**：恢复代码写在主流程末尾，而主流程在「连续 3 个用例失败」时会 `process.exit(1)`
（`runCase` 的行为，见 `CLI-TEST-SPEC.md` §2.4），**那会跳过末尾的恢复**。

**修法**：把恢复包进 `restoreAll()` 并注册到 `process.on('exit')` 上——任何退出路径
（正常结束 / 提前终止 / 未捕获异常）都会触发。`exit` 钩子里只能做同步操作，
而 harness 的 `ui()` 是 `execFileSync`，满足条件。另加 3 次重试应对应用忙。

**通用性**：**任何会改全局设置（`promptStyle` / 模型 / 开关）的套件都要这么做**。
prompt-style 套件用的是末尾恢复，同样有这个风险。

### 2. `dev:restart` 后立刻跑会全线 `connection_failed`

**症状**：重启后马上跑套件，三条用例连续以 `conversation create 退出码 3: connection_failed` 失败，
套件按「连续 3 个失败即终止」提前退出。

**根因**：应用还没起来，控制口不可达。这是**环境问题不是产品缺陷**（`CLI-TEST-SPEC.md` §8 分类）。

**修法**：主流程开头加 `preflight()` 预检，不通过直接 `exit(3)` 并打印可读提示
（"若刚 dev:restart 过，等约 20 秒再跑"）。**比让三条用例依次报错强**——
后者会被误读成产品缺陷。
