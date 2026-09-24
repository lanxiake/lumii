# 第 07 篇实验：扩展、技能包与 RPC 协议往返

对应《07 · 扩展系统、SDK 与 RPC》。三个实验目录，`.mjs` 零依赖（Node ≥ 20），
`node <file>` 直接跑；`.ts` 扩展是给真实 pi 加载的，本目录只做静态交付 + 文档对照。

| 目录/文件 | 验证正文哪个论断 |
|---|---|
| `01-rpc-transcript/rpc-server-sim.mjs` + `client-sim.mjs` | §5：JSONL over stdio 的帧语义——LF-only 分帧、id 关联、accepted≠completed、流式中 prompt 必须 `streamingBehavior`、`bash_execution_update` 复用命令 id、`agent_end`≠`agent_settled`、malformed JSON → 无 id parse response、关 stdin 有序关闭 |
| `02-hello-extension.ts` | §3：`defineTool`+`registerTool`/`registerCommand` 的真实形状、throw⇒isError 契约、`session_start` 生命周期规则——逐行注释标注 docs 出处 |
| `03-skill-package/` | §6+第 5 篇：pi-package 的 package.json manifest 形状 + 技能常驻 vs 全文的 token 账 |

> 诚实声明：`rpc-server-sim.mjs` 的**消息形状**逐项取自
> `packages/coding-agent/docs/rpc.md / rpc-commands.md / json.md`，但它**不是真实
> pi 进程**——没有模型和 agent loop，事件是脚本编排的。它能证明"按文档实现一个
> 客户端要处理哪些协议细节"，不能证明真实 pi 的行为（那需要 `pi --mode rpc` + API key）。

## 实跑（2026-09-23，Windows / Node v24）

### `cd 01-rpc-transcript && node client-sim.mjs`

往返轨迹 56 行（→ 发出 / ← 收到），节选关键帧：

```text
→ {"id":"req-2","type":"prompt","message":"Review this repository"}
← {"id":"req-2","type":"response","command":"prompt","success":true}          ← accepted，不是完成
← {"type":"agent_start"}
← {"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"已收到「Review "}}
→ {"id":"req-3","type":"steer","message":"重点看 packages/tui"}               ← 流式中注入
← {"id":"req-3","type":"response","command":"steer","success":true}
← {"type":"queue_update","steering":["重点看 packages/tui"],"followUp":[]}    ← 完整队列快照
→ {"id":"req-4","type":"prompt","message":"不带 streamingBehavior"}
← {"id":"req-4","type":"response","command":"prompt","success":false,
   "error":"Agent is streaming; specify streamingBehavior \"steer\" or \"followUp\""}
← {"type":"agent_end","messages":[...],"willRetry":false}
← {"type":"agent_settled"}                                                    ← settled 才是"不会再自己继续"
← {"type":"agent_start"}                                                      ← steer 的消息作为新一轮交付
  ...（第二轮 run 完整事件流）...
→ {"id":"req-5","type":"bash","command":"node --version"}
← {"id":"req-5","type":"bash_execution_update","delta":"v24.19.0\r\n"}        ← 流式输出复用命令 id
← {"id":"req-5","type":"response","command":"bash","success":true,
   "data":{"output":"v24.19.0\r\n","exitCode":0,"cancelled":false,"truncated":false}}
→ {"id":"req-7","type":"abort"}                                               ← 第三轮 run 中途
← {"type":"message_end","message":{...,"stopReason":"aborted"}}
← {"type":"agent_end","messages":[...],"willRetry":false}
← {"type":"agent_settled"}
← {"type":"response","command":"parse","success":false,
   "error":"Failed to parse command: invalid JSON"}                           ← 故意发的坏 JSON，无 id
[client] server exited code=0
[client] done
```

写客户端时踩到的真实协议坑（demo 里修过一遍）：`agent_end` 和 `agent_settled`
可能落在**同一个 stdout chunk** 里被同步解析——如果处理完 `agent_end` 才去注册
下一个事件的等待器，`agent_settled` 已经过去了。等待器必须在触发事件**之前**
预注册（`client-sim.mjs` 场景 7 的注释）。任何语言的 RPC 客户端都会遇到同款。

### `node 03-skill-package/count-skill-tokens.mjs`

```text
扫描 skills 下 1 个技能

skill        常驻注入(estimate)  全文加载(estimate)  节省
------------------------------------------------------------------
wordsmith    ≈    64 tok      ≈   182 tok     64.8%
------------------------------------------------------------------
合计         ≈64 tok      ≈182 tok      64.8%

结论：技能数量不敏感（常驻只随 name+description 增长）；
未命中的技能全文一个 token 都不进上下文——这就是分发单元粒度下的渐进披露。
```

支持脚本本身也跑通：`node skills/wordsmith/scripts/wordcount.mjs skills/wordsmith/SKILL.md`
→ `words=52 chars=417 lines=15`。

### `02-hello-extension.ts`（静态交付）

安装：放入 `~/.pi/agent/extensions/wc.ts`，或 `pi --extension ./02-hello-extension.ts`。
本实验环境没有安装 pi CLI（且 TS 需 jiti 装载），故**未在运行时加载验证**；
文件里每个 API 调用都注释了 `docs/extensions.md` 的对应小节，可与
`examples/extensions/hello.ts` 逐行对照。
