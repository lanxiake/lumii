# 第 03 篇实验：agent loop 与事件流

三个零依赖 `.mjs`（Node ≥ 20），全部用内置 faux provider 演示协议，无需 API key。均已实跑，输出见下。

| 文件 | 验证什么 |
|---|---|
| `01-mini-agent-loop.mjs` | 约 200 行手写迷你 agent loop：`agent_start→turn_start→message_*→tool_execution_*→turn_end→agent_end` 完整事件流；并行工具下 `tool_execution_end`（完成序）与 `toolResult` 消息（源序）的顺序差异；场景 B 演示 bash 执行中 `abort()` 的传播链（工具 reject → isError toolResult → 下一轮 provider 直接返回 `aborted`，已流出的部分文本保留在 transcript） |
| `02-tool-validation.mjs` | 工具调用失败三态（参数校验失败 / 未知工具 / 执行抛错）全部收敛为 `isError:true` 的 toolResult；模型在下一轮请求里看到错误文本并逐轮修正；另演示 `prepareArguments` 兼容垫片在校验前把 `file_path` 归一化为 `path` |
| `03-steering.mjs` | 运行中向队列注入消息：steering（`turn_end` 后 drain）与 follow-up（自然停止点 drain）；`one-at-a-time` 模式如何把两条排队 steering 拆到两个不同 turn 注入 |

```bash
node 01-mini-agent-loop.mjs
node 02-tool-validation.mjs
node 03-steering.mjs
```

概念对应关系：事件名/字段名对齐 `packages/agent/src/types.ts` 的 `AgentEvent` 与 `packages/ai` 的 `AssistantMessageEvent`；循环骨架对齐 `packages/agent/src/agent-loop.ts` 的 `runLoop`；队列对齐 `packages/agent/src/agent.ts` 的 `PendingMessageQueue`。为聚焦主题做了删减：校验器只查 required 与 string 类型（pi 真实实现是 TypeBox/AJV 全量校验 + `Value.Convert` 强制）、hooks（`beforeToolCall`/`afterToolCall`/`finishTurn`）未模拟、场景 A 只演示 parallel 模式。

## 01 真实输出

```text
=== 场景 A：文本 + 并行双工具（注意 tool_execution_end 与 toolResult 消息的顺序差异） ===
  A [   0ms] agent_start
  A [   1ms] turn_start
  A [   1ms] message_start                               user
  A [   1ms] message_end                                 user
  A [   2ms] message_start                               assistant(stop)
  A [   2ms] message_update
  ...（5 个 text_delta，中间 3 个略）
  A [  29ms] message_end                                 assistant(toolUse)
  A [  34ms] tool_execution_start                        bash#tc_bash
  A [  34ms] tool_execution_start                        read#tc_read
  A [  34ms] tool_execution_update                       bash#tc_bash
  A [  71ms] tool_execution_update                       read#tc_read
  A [ 111ms] tool_execution_end                          read#tc_read isError=false
  A [ 112ms] tool_execution_update                       bash#tc_bash
  A [ 112ms] tool_execution_end                          bash#tc_bash isError=false
  A [ 112ms] message_start                               toolResult bash#tc_bash isError=false
  A [ 113ms] message_end                                 toolResult bash#tc_bash isError=false
  A [ 113ms] message_start                               toolResult read#tc_read isError=false
  A [ 113ms] message_end                                 toolResult read#tc_read isError=false
  A [ 113ms] turn_end                                    toolResults=2
  A [ 113ms] turn_start
  A [ 113ms] message_start                               assistant(stop)
  ...（9 个 message_update 略）
  A [ 301ms] message_end                                 assistant(stop)
  A [ 301ms] turn_end                                    toolResults=0
  A [ 301ms] agent_end                                   transcript=5 new msgs

=== 场景 B：bash 执行中 abort（工具 reject + 下一轮 provider 直接 aborted） ===
  B [   0ms] agent_start
  B [   1ms] turn_start
  ...（user prompt 与 assistant 流式文本略，assistant 共流出 4 个 delta）
  B [  40ms] message_end                                 assistant(toolUse)
  B [  40ms] tool_execution_start                        bash#tc_long
  B [  40ms] tool_execution_update                       bash#tc_long
  >>> 用户按下 abort()
  B [ 189ms] tool_execution_end                          bash#tc_long isError=true
  B [ 190ms] message_start                               toolResult bash#tc_long isError=true
  B [ 190ms] message_end                                 toolResult bash#tc_long isError=true
  B [ 191ms] turn_end                                    toolResults=1
  B [ 191ms] turn_start
  B [ 191ms] message_start                               assistant(aborted)
  B [ 191ms] message_end                                 assistant(aborted)
  B [ 191ms] turn_end                                    toolResults=0
  B [ 191ms] agent_end                                   transcript=4 new msgs
  结束：最后一条 assistant stopReason=aborted errorMessage="Request was aborted"
  transcript 保留的部分文本: [开始跑长命令]
```

看点：场景 A 中 `read`（源序第 2）先完成，`tool_execution_end` 按完成序先 read 后 bash；而落 transcript 的 `toolResult` 消息按 assistant 源序先 bash 后 read。场景 B 中 abort 不是异常：loop 沿正常路径关闭，事件序列完整走到 `agent_end`。

## 02 真实输出

```text
=== 校验失败 / 未知工具 / 执行抛错：三种 isError，模型逐轮修正 ===
  [  4ms] agent_start
  [  5ms] turn_start
  [faux] 第 1 次请求，模型可见 0 条 toolResult：
  [  6ms] message_start                             assistant(toolUse)
  [  6ms] message_end                               assistant(toolUse)
  [  6ms] tool_execution_start                      write_file#t1
  [  7ms] tool_execution_end                        write_file#t1 isError=true
  [  7ms] message_start                             toolResult write_file isError=true
  [  7ms] message_end                               toolResult write_file isError=true
  [  8ms] turn_end
  [  8ms] turn_start
  [faux] 第 2 次请求，模型可见 1 条 toolResult：
    - write_file isError=true → "Validation failed for tool "write_file":"
  [  8ms] message_start                             assistant(toolUse)
  [  8ms] message_end                               assistant(toolUse)
  [  8ms] tool_execution_start                      write_file#t2
  [  8ms] tool_execution_end                        write_file#t2 isError=false
  [  8ms] message_start                             toolResult write_file isError=false
  [  8ms] message_end                               toolResult write_file isError=false
  [ 17ms] tool_execution_start                      write_file#t3
  [  9ms] tool_execution_end                        write_file#t3 isError=true
  [  9ms] message_start                             toolResult write_file isError=true
  [  9ms] message_end                               toolResult write_file isError=true
  [  9ms] turn_end
  [  9ms] turn_start
  [faux] 第 3 次请求，模型可见 3 条 toolResult：
    - write_file isError=true → "Validation failed for tool "write_file":"
    - write_file isError=false → "wrote 8 bytes"
    - write_file isError=true → "EACCES: permission denied, open '/protected'"
  [ 18ms] message_start                             assistant(toolUse)
  [ 18ms] message_end                               assistant(toolUse)
  [ 18ms] tool_execution_start                      delete_file#t4
  [ 18ms] tool_execution_end                        delete_file#t4 isError=true
  [ 18ms] message_start                             toolResult delete_file isError=true
  [ 18ms] message_end                               toolResult delete_file isError=true
  [ 18ms] turn_end
  [ 18ms] turn_start
  [faux] 第 4 次请求，模型可见 4 条 toolResult：
    - write_file isError=true → "Validation failed for tool "write_file":"
    - write_file isError=false → "wrote 8 bytes"
    - write_file isError=true → "EACCES: permission denied, open '/protected'"
    - delete_file isError=true → "Tool delete_file not found"
  [ 18ms] message_start                             assistant(stop)
  [ 18ms] message_end                               assistant(stop)
  [ 18ms] turn_end
  [ 18ms] agent_end

=== 落盘结果 ===
  fakeFs: { 'notes.txt': 'hello pi' }
  transcript roles: system → user → assistant → toolResult(err) → assistant → toolResult → toolResult(err) → assistant → toolResult(err) → assistant
```

看点：三种失败（t1 缺 required 参数、t3 执行抛 EACCES、t4 未知工具）事件序列完全同构——`tool_execution_start` 照常先发（校验失败也发），然后 `tool_execution_end isError=true` + `isError` 的 toolResult 消息；模型下一轮在请求里逐字看到错误文本来修正。

## 03 真实输出

```text
=== steering + follow-up：队列在三个 drain 点被消费（one-at-a-time） ===
  [loop] agent_start
  [drain] 启动时 polling steering → 0 条
  [loop] turn_start
  [loop] message_start/end user: "统计项目文件数"
  [loop] assistant(toolUse): "开始统计文件 [toolCall bash]"
  [loop] tool_execution_start bash#b1
      steer() 入队 "改用 *.ts 统计"（steering 队列=1）
      steer() 入队 "结果按数量排序"（steering 队列=2）
      followUp() 入队 "最后给我一段总结"（follow-up 队列=1）
  [loop] tool_execution_end bash#b1
  [loop] turn_end toolResults=1
  [drain] turn_end 后 polling steering(one-at-a-time) → 注入 1 条 "改用 *.ts 统计"，队列剩 1
  [loop] turn_start
  [loop] message_start/end user: "改用 *.ts 统计"
  [loop] assistant(stop): "收到，改按后缀统计"
  [loop] turn_end toolResults=0
  [drain] turn_end 后 polling steering(one-at-a-time) → 注入 1 条 "结果按数量排序"，队列剩 0
  [loop] turn_start
  [loop] message_start/end user: "结果按数量排序"
  [loop] assistant(stop): "顺手把结果排序"
  [loop] turn_end toolResults=0
  [drain] turn_end 后 polling steering(one-at-a-time) → 注入 0 条，队列剩 0
  [drain] 自然停止点 polling follow-up(one-at-a-time) → 注入 1 条 "最后给我一段总结"
  [loop] turn_start
  [loop] message_start/end user: "最后给我一段总结"
  [loop] assistant(stop): "最终总结：共 42 个文件，已排序输出。"
  [loop] turn_end toolResults=0
  [drain] turn_end 后 polling steering(one-at-a-time) → 注入 0 条，队列剩 0
  [drain] 自然停止点 polling follow-up(one-at-a-time) → 注入 0 条
  [loop] agent_end

=== transcript（模型看到的完整序列） ===
  user       "统计项目文件数"
  assistant  "开始统计文件 [toolCall bash]"
  toolResult "42 files"
  user       "改用 *.ts 统计"
  assistant  "收到，改按后缀统计"
  user       "结果按数量排序"
  assistant  "顺手把结果排序"
  user       "最后给我一段总结"
  assistant  "最终总结：共 42 个文件，已排序输出。"
```

看点：两条 steering 被 `one-at-a-time` 拆到两个 turn 注入；follow-up 直到"没有工具调用、也没有 steering"的自然停止点才被消费。pi 的 runLoop 里还有第三个（更靠前的）steering poll——循环启动时先捞一次，本实验里它返回 0 条。
