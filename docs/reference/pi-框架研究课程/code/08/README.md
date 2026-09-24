# 第 08 篇实验：平台化转向（chord / protocol / telemetry 迷你复刻）

三个零依赖 `.mjs`（Node ≥20），全部实跑通过。对应文章《08 · 平台化转向》§2.2、§2.3、§3、§4。
API 名为教学用简化版（README/PLANNING 语义的迷你复刻，非 chord/telemetry 真实导出名）。

```bash
node 01-facet-container.mjs   # facet 容器：依赖图校验/拓扑激活/逆序释放/循环检测
node 02-rpc-boundary.mjs      # facet 进子进程：行协议桥 + replicated state 复制（会 spawn 子进程）
node 03-telemetry-contract.mjs # vendor-neutral 遥测契约 + conformance + 双 vendor 对比
```

## 01-facet-container.mjs —— 实测输出

```
=== 装配：worker + ui 共享 state-service ===
  [activate] state-service  provides=[state]
    agent-worker: harness 不跨进程边界，只写 state
  [activate] agent-worker  provides=[agent]
    ui: 渲染 1  条 transcript，prompt= echo: hi
  [activate] ui  provides=[]
  激活序: state-service -> agent-worker -> ui
  state 内容: ["hello from worker","hi"]
    ui: 渲染器已卸载
  [dispose] ui
    agent-worker: drive 已停止
  [dispose] agent-worker
    state-service: 存储已关闭
  [dispose] state-service

=== 装配：ui 需要不存在的 service ===
  按预期拒绝: missing services: lonely-ui -> nonexistent

=== 装配：a<->b 循环依赖 ===
  按预期拒绝: cycle: a -> b -> a
```

验证 README 三条生命周期语义：host 收齐声明后统一校验依赖图；providers before consumers（state-service → agent-worker → ui）；reverse dependency order 释放（ui → agent-worker → state-service）。

## 02-rpc-boundary.mjs —— 实测输出（transcript 逐条增长，中间两轮略重复格式）

```
  [replica] 快照 seq=0
  [event] replica(seq=0) = {"transcript":[],"status":"idle"}
ready=true
  [event] replica(seq=1) = {"transcript":[{"role":"user","text":"hello chord"}],"status":"running"}
  [event] replica(seq=2) = {"transcript":[{"role":"user","text":"hello chord"},{"role":"assistant","text":"worker(echo): HELLO CHORD"}],"status":"idle"}
  [event] replica(seq=3) = {"transcript":[{"role":"user","text":"hello chord"},{"role":"assistant","text":"worker(echo): HELLO CHORD"},{"role":"user","text":"第二条消息"}],"status":"running"}
  [event] replica(seq=4) = {"transcript":[...,"worker(echo): 第二条消息"],"status":"idle"}
  [event] replica(seq=5) = {"transcript":[...,"sanity"],"status":"running"}
  [event] replica(seq=6) = {"transcript":[...,"worker(echo): SANITY"],"status":"idle"}

一致性对比：
  worker 权威值 == 父进程 replica : true（都来自 seq=6 的原子修订）
  worker 退出后: ready=false, 旧值仍在内存但不作为当前值使用 = true
```

要点：权威 state 只在子进程（"Neither an open JavaScript Session nor a Harness crosses the process boundary"）；父进程只收 seq 递增的原子修订（快照基线 + 更新，断 seq 即 unready——PLANNING §8 第 8 条）；worker 退出 replica 进入 unready 但旧值保留。行协议（JSONL）是教学替身，真实系统是 4 字节长度 + CBOR（protocol README）。

## 03-telemetry-contract.mjs —— 实测输出

```
=== conformance suite ===
  vendor-A(OTel式): PASS（契约语义一致）
  vendor-B(Sentry式): PASS（契约语义一致）
  NOOP: PASS（契约语义一致）

=== 同一业务函数流经三个 vendor ===
  业务返回值三家一致: true "answer to: 什么是复制状态"
  A vs B 语义字段（name/parent/attributes/events/status）一致: true
  B 的 vendor 私有能力（_sentry.tx）只存在于 raw 层: "pi"

=== schema 守门演示（业务写错属性立刻炸）===
  按预期拒绝: schema: pi.ai.streaming 类型应为 boolean
```

验证 telemetry/README 的四个决定：回调式 span 生命周期（属性合并、last-write-wins、透传 resolve/reject 由 conformance 断言）；NOOP 不保留录制内容所以只跑透传断言；typed schema（形状照抄 telemetry-schema.md 的 `pi.ai.request`：起止属性分离 + 枚举 + 类型）在业务侧守门；换 vendor 业务函数一行不改。
