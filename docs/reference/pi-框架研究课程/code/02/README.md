# 实验 02 · pi-ai 统一事件流 / handoff / token 计量

零依赖 Node（≥20）纯 JS，无需任何 API key。事件名与字段名对齐
`packages/ai/src/types.ts`（AssistantMessageEvent 联合类型）与
`packages/ai/src/api/transform-messages.ts` 的行为。

| 文件 | 验证什么 | 运行 |
|---|---|---|
| `01-faux-stream.mjs` | 复刻 faux provider 的事件协议形状（start/thinking_*/text_*/toolcall_*/done/error + 活 `partial` + `result()`）。同一事件源 tee 给“终端渲染器”和“JSONL 记录器”两个互不相识的消费者，演示统一事件流如何解耦 UI 与 provider；`abort` 模式演示中途取消后 `result()` 保留部分结果 | `node 01-faux-stream.mjs`；`node 01-faux-stream.mjs abort` |
| `02-handoff.mjs` | 跨 provider handoff：A 的回合（thinking 独立字段 + `thinkingSignature` 签名 + Responses 风格超长 toolCall id）转换成可安全喂给只认文本的 B；对照同 provider 重放（签名保留）。打印转换前后 JSON、丢弃/改写清单、以及违规重放的后果 | `node 02-handoff.mjs` |
| `03-token-meter.mjs` | token 上报时机矩阵：head 式（Anthropic `message_start` 流首报）与 tail 式（OpenAI 最终 chunk / Google `usageMetadata` 流尾报）在正常完成与中途 abort 下的可计费性对照，复现博客 L83 的 best-effort 结论 | `node 03-token-meter.mjs` |

以下输出为 2026-09-23 实际运行结果（Windows / Node 20+）。

## 01-faux-stream.mjs

```text
== 终端渲染器 ==
[stream: faux/faux-1]
[thinking] 用户要时间。先调 get_time。
[text] 正在查询时间…
[toolcall] get_time({"timezone":"UTC"})
[done] reason=toolUse usage=21 tokens
== JSONL 记录器（同一条流的另一路消费，用于会话持久化）==
{"ev":"thinking_delta","i":0,"delta":"用户要时间。"}
{"ev":"thinking_delta","i":0,"delta":"先调 get_time。"}
{"ev":"text_delta","i":1,"delta":"正在"}
{"ev":"text_delta","i":1,"delta":"查询"}
{"ev":"text_delta","i":1,"delta":"时间…"}
{"ev":"toolcall_delta","i":2,"delta":"{\""}
{"ev":"toolcall_delta","i":2,"delta":"timezone"}
{"ev":"toolcall_delta","i":2,"delta":"\":"}
{"ev":"toolcall_delta","i":2,"delta":"\"UTC\""}
{"ev":"toolcall_delta","i":2,"delta":"}"}
{"ev":"done","reason":"toolUse"}

主循环最终 result(): stopReason=toolUse, content blocks=thinking,text,toolCall
```

`abort` 模式：

```text
### 中途 abort 演示（第 2 个 text_delta 后取消）

== 终端渲染器 ==
[stream: faux/faux-1]
[thinking] 用户要时间。先调 get_time。
[text] 正在查询[error] reason=aborted: Request was aborted

result() 保留部分产出: stopReason=aborted
保留的 content: [{"type":"thinking","text":"用户要时间。先调 get_time。"},{"type":"text","text":"正在查询"}]
```

要点：两个消费者都只 switch `ev.type`、用 `contentIndex` 定位块，完全不知道“provider”是谁；abort 后 `error` 事件与 `result()` 都带部分内容，可直接 push 回 context 续写（pi-ai README “Continuing After Abort” 的形状）。

## 02-handoff.mjs

```text
=== 转换前（provider A 原始上下文，节选 content）===
[
  {
    "type": "thinking",
    "thinking": "用户要 25*18。拆成 25*20-25*2=450。",
    "thinkingSignature": "A_SIG_encrypted_reasoning_v2__opaque__"
  },
  { "type": "text", "text": "25 × 18 = 450。" },
  {
    "type": "toolCall",
    "id": "resp_item_00|fc_9f3a....(OpenAI Responses 风格 450+ 字符含 '|')....b71e",
    "name": "verify",
    "arguments": { "expr": "25*18", "expected": 450 }
  }
]

=== 转换后（可安全喂给 provider B）===
[
  { "type": "text", "text": "<thinking>\n用户要 25*18。拆成 25*20-25*2=450。\n</thinking>" },
  { "type": "text", "text": "25 × 18 = 450。" },
  {
    "type": "toolCall",
    "id": "tc_42_515caa8",
    "name": "verify",
    "arguments": { "expr": "25*18", "expected": 450 }
  }
]

toolCall 对应的 toolResult.toolCallId 已同步改写: tc_42_515caa8

丢弃/改写清单:
  - thinking -> text（B 只认文本，思考过程以文本形式留在上下文中）
  - thinkingSignature（仅 A 可解，不可重放给 B，随降级一并丢弃）
  - toolCall id 归一化 -> tc_42_515caa8

=== 对照：同 provider 重放（签名保留，thinking 原样，丢弃清单为空）===
thinking block: {"type":"thinking","thinking":"用户要 25*18。拆成 25*20-25*2=450。","thinkingSignature":"A_SIG_encrypted_reasoning_v2__opaque__"}
丢弃清单: []

=== 若违规重放（把 A_SIG 原样发给 B）===
providerB POST /v1/chat/completions -> 400 {"error":"unknown field 'thinkingSignature' / cannot decrypt reasoning item"}
结论：签名 blob 是『发给原主的回执』，不是上下文内容；handoff 时删除是唯一正确动作（transform-messages.ts isSameModel 分支）。
```

（上面两段 JSON 为省篇幅对缩进做了折叠，实际输出为完整 pretty-print，内容一致。）

要点：`isSameModel`（provider+api+model 三坐标）决定一切分叉；`<thinking>` 标签是否拼接对应 `compat.requiresThinkingAsText`；toolCall id 归一化会同步改写配对的 toolResult。

## 03-token-meter.mjs

```text
=== token 上报时机 × abort：可计费性对照 ===

- head 报首 + 正常完成
    实际消耗: 100 in + 48 out（模型真的算了）
    计量器已知: 100 in + 48 out
    可结算: 是 $0.00102
    偏差: 无

- tail 报尾 + 正常完成
    实际消耗: 100 in + 48 out（模型真的算了）
    计量器已知: 100 in + 48 out
    可结算: 是 $0.00102
    偏差: 无

- head 报首 + 第 3 delta 后 abort
    实际消耗: 100 in + 24 out（模型真的算了）
    计量器已知: 100 in + 0 out
    可结算: 否
    偏差: 少计 output：24 tokens（流首值未修正）

- tail 报尾 + 第 3 delta 后 abort
    实际消耗: 100 in + 24 out（模型真的算了）
    计量器已知: （一无所知）
    可结算: 否
    偏差: 无

=== 结论（对应博客 L83 / pi-ai 的 best-effort 立场）===
1) 同一次 abort，head 式至少知道输入成本，tail 式颗粒无收——而 GPU 周期已经消耗。
2) 就算 head 式，流首报的 output 是估值，abort 后没有修正机会 → 只能『约等于』。
3) 没有可注入的自有 request id 去对账账单 API，误差无法事后弥合。
   pi-ai 因此把 Usage 定义为 best-effort：个人用量够了，做面向用户的精确计费不行。
```
