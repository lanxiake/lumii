# 第 09 篇实验：durable 运行时迷你复刻

三个零依赖 `.mjs`（Node ≥20），全部实跑通过（exit 0）。对应文章《09 · durable 运行时 Pico 与全课程演进总结》§2、§3。
API 名为教学用简化版（harness.md 语义的迷你复刻，非真实导出名）。

```bash
node 01-crash-recover-store.mjs   # intent/效果/settlement 三段记账 + 孤儿恢复（会在 ./01-run/ 写临时文件，跑完自删）
node 02-entry-tree-ledger.mjs     # 四部分状态 + 原子事务 + corruption 拒收
node 03-doc-archaeology.mjs [仓库路径]  # 对本地 pi 克隆跑只读统计（默认 C:\Users\75791\.lumii\workspace\temp\pi-course-research\pi）
```

## 01-crash-recover-store.mjs —— 实测输出

```
══ pass 1（崩溃前）══
  [run] op-1 写报告头 → settled
  [run] op-2 发送 HTTP → settled
  ☠ OOM killer：效果已发生，settlement 未落盘
  副作用账本现有 3 行: ["op-1: report header written","op-2: HTTP POST sent","op-3: rm executed"]

══ pass 2（重启后，仅凭 oplog 判定）══
  [skip] op-1 已 settled，不重放
  [skip] op-2 已 settled，不重放
  [orphan] op-3 replay=never → 绝不重执行；合成 interrupted（保留进度 "已删 3/5 个文件" + 警告）
  [run] op-4 跑测试（只读） → settled

══ 账本核对 ══
  op-1 副作用行数（崩溃后→重启后）: 1 → 1
  op-2 副作用行数（崩溃后→重启后）: 1 → 1
  op-3 副作用行数（崩溃后→重启后）: 1 → 1
  op-4 副作用行数（崩溃后→重启后）: 0 → 1
  never 类操作零重复执行: true

  oplog 全文：
    {"seq":1,"type":"intent","opId":"op-1","replay":"safe"}
    {"seq":2,"type":"settled","opId":"op-1"}
    {"seq":3,"type":"intent","opId":"op-2","replay":"never"}
    {"seq":4,"type":"settled","opId":"op-2"}
    {"seq":5,"type":"intent","opId":"op-3","replay":"never"}
    {"seq":6,"type":"checkpoint","opId":"op-3","content":"已删 3/5 个文件"}
    {"seq":7,"type":"settled","opId":"op-3","synthetic":"interrupted: 最新已提交进度=已删 3/5 个文件；更新的输出可能缺失，外部结果未知"}
    {"seq":8,"type":"intent","opId":"op-4","replay":"safe"}
    {"seq":9,"type":"settled","opId":"op-4"}
```

要点：第二趟**只读 oplog** 重建认知（真文件，模拟进程重启）；op-3 的副作用在崩溃前已发生（3 行账本），重启后既没重跑也没有假装成功——按 harness.md §4.5 合成带警告的 interrupted 结算；op-4（replay:"safe"、未受理）在重启趟正常执行。

## 02-entry-tree-ledger.mjs —— 实测输出

```
=== 分支树 ===
e1 ── e2 ─┬─ a1   (alpha tip = a1 )
          └─ b1   (beta  tip = b1 )
alpha 聚合: {"input":1200,"output":90}  beta 聚合: {"input":800,"output":60}
stats 投影 == ledger 求和: true {"input":2000,"output":150,"messageCount":4}

=== corruption 拒收（整笔作废）===
  拒收: corruption: entry id 复用 a1（seq 未动: true）
  拒收: corruption: 缺失父 ghost（seq 未动: true）
  拒收: corruption: value:pi.branch.tip/alpha 类型不符（entryId vs number）（seq 未动: true）

删光操作自有值后：树完整 = true ，账本行数 = 2 （永不删除）
```

要点：entry 树 write-once（id 复用/缺父被拒，不变量 1/11）；bound value 地址带类型标签（同址改类型被拒，§1.3）；两分支共享 `e1─e2` 前缀但 usage 按各自 parent 链聚合互不污染（§2.3 分支共享不复制）；`getStats` 维护式投影 == 账本求和（§1.6 conformance 断言）；删光操作自有值后树与账本完好（不变量 8）。

## 03-doc-archaeology.mjs —— 实测输出（节选，全量见运行）

```
=== pico 系列设计文档（标题 / 行数）===
   2937  # Pico handoff v2                      packages/agent/docs/pico/pico-handoff-v2.md
   2654  # Pico v1 implementation specification packages/agent/docs/pico/pico-simple-handoff.md
   2577  # pico v3                              packages/agent/docs/pico/pico-v3.md
   2491  # pico v2                              packages/agent/docs/pico2.md
   2212  # Pico5 specification                  packages/durable/docs/pico-v5.md
   2113  # pico v3                              packages/agent/docs/pico-v3.md
   ...
  合计 19703 行；harness.md 参照: 1468 行

=== packages/durable/src 结构与 LOC ===
  （16 个 .ts，TOTAL 4794）

=== durable 包提交时间线（最近 12 条）===
  2026-09-23 b313731b feat: add JSONL sidecar reclamation
  2026-09-23 898ab804 feat: add durable JSONL storage backend
  2026-09-22 5901c9b9 feat: add durable SQLite storage backend
  ...

=== 关键锚点 ===
  harness.md 首现 : 2026-07-28 e8f9c071 docs(agent): durable AgentHarness design (harness.md)
  durable 包首现  : 2026-09-18 08016016 feat(durable): move Pico into dedicated package
  chord 包首现    : 2026-08-28 28b49a6b feat: add Chord runtime foundation
  durable 相关提交总数: 21
  版本: v0.87.1-7-gb313731b ; tag 数: 319
```

要点：文章 §3 的所有数字（文档规模、v4 缺位、src LOC、提交时间线、版本锚点）都可用本脚本在任意时刻复验；脚本对仓库只读。
