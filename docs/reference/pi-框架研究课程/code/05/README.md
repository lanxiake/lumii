# 第 05 篇实验：会话树与上下文工程

三个零依赖 `.mjs`（Node ≥ 20），对应文章《05 · 会话与上下文工程》§2.3/§3、§5、§7。

```bash
node 01-session-tree.mjs          # 会话树解析 + 活跃路径 + 压缩窗口 + context_edit 投影
node 02-toy-compactor.mjs         # 玩具压缩器：切点/双摘要/累积账本/append-only
node 03-skills-disclosure.mjs     # 技能渐进披露 token 账 + prompt 模板替换
```

`01` 支持传真实文件：`node 01-session-tree.mjs ~/.pi/agent/sessions/<dir>/<file>.jsonl`（本机 `~/.pi/agent/sessions` 当前为空，样例模式已覆盖同一套解析路径）。

## 01-session-tree.mjs —— 实测输出（节选树与投影，全文 42 行）

```
header: v3 id=sess0001 cwd=/home/dev/demo
entry 总数: 19   类型分布: message×15  model_change×1  label×1  compaction×1  context_edit×1

会话树（● = 活跃路径，○ = 其他分支）：
● e1 [message] user: 重构 auth 模块
  ...
                    ● c1 [compaction] compaction → keep e5
                      ● e9 [message] user: 继续第二段
                        ● e10 [message] assistant: 第二段完成 ✅
                          ● b1 [message] user: 补测试
                            ● b2 [message] assistant: [toolCall write tests/auth.t
                              ● ce1 [context_edit] context_edit → e7
                                ● b3 [message] assistant: 测试 12 passed ✅（叶子）
                        ○ a1 [message] user: 算了，先试 OAuth
                          ○ a2 [message] assistant: [toolCall read src/oauth.ts]

压缩窗口（最新 compaction=c1, firstKeptEntryId=e5, tokensBefore=4123）
  活跃路径 17 条 → 进上下文 12 条；被裁掉 5 条: e1,e2,e3,e3b,e4
  注意：被裁掉的 entry 在文件里一行未少（append-only），label/model_change 也不投影。

投影后的模型消息序列（11 条参与）：
  [compactionSummary] ## Goal …
  [user] 开工
  [assistant] [toolCall edit src/auth.ts]
  [toolResult] [edit 细节已确认，长结果省略]  ←(context_edit 覆盖)
  [assistant] auth.ts 第一段拆完
  [user] 继续第二段
  [assistant] 第二段完成 ✅
  [user] 补测试
  [assistant] [toolCall write tests/auth.test.ts]
  [assistant] 测试 12 passed ✅（叶子）

context_edit 生效数: 1；原始文件行数不变: 20
```

验证正文：§2.3（叶子回溯/分支共存）、§3（compaction 切窗口、非投影 entry 类型、context_edit 后写覆盖、原始行数不变）。

## 02-toy-compactor.mjs —— 实测输出（全文）

```
消息数 40，估算 3450 tok，窗口 2000，阈值 1400
shouldCompact = true

[压缩 1] splitTurn=true
  摘要(79 tok) 尾部: Read: src/mod3.ts | Modified: 
  全文件估算: 3450 → 投影窗口 1141 tok（含已被前轮裁掉的段，故只作量级参考）
  压缩段 30 条，firstKeptEntryId=m27
  append-only 校验: 追加前 41 行 → 追加后 42 行（本轮净增 1 行；前缀逐字节一致 = true ← append-only 的铁证）

[压缩 2] splitTurn=true
  摘要(113 tok) 尾部: Read: src/mod0.ts, src/mod1.ts, src/mod2.ts, src/mod3.ts | Modified: src/mod0.ts, src/mod1.ts, src/mod2.ts
  全文件估算: 4756 → 投影窗口 1325 tok（含已被前轮裁掉的段，故只作量级参考）
  压缩段 2 条，firstKeptEntryId=m42
  append-only 校验: 追加前 42 行 → 追加后 53 行（本轮净增 11 行；前缀逐字节一致 = true ← append-only 的铁证）

迭代验证: 第 2 条摘要含 <previous-summary> = true
账本累积: readFiles=5 个, modifiedFiles=5 个（第 1 条 compaction 的清单已并入）
原始文件总行数: 53（40 条消息 + 追加的 compaction 全部共存）
```

说明：阈值与不等式和 `compaction.ts` 同源（`contextTokens > contextWindow - reserveTokens`、反向累加 `keepRecentTokens`、绝不切 toolResult），但数值按玩具比例缩小；`摘要尾部` 显示的是 split-turn 前缀段的清单，主段账本在摘要正文里；文件写在系统临时目录，仓库零污染。验证正文 §5.1-§5.5（触发、切点、split turn 双摘要、previousSummary 迭代、文件账本跨压缩累积、append-only）。

## 03-skills-disclosure.mjs —— 实测输出（全文）

```
技能数: 12（skills.md 限制: name≤64, description≤1024 字符）
常驻索引（name+description+path ×12）: 3050 字符 ≈ 763 tok
pdf-lite 全文: 6926 字符 ≈ 1732 tok
单技能全文/常驻 比值: 27.2×
→ 100 个技能的常驻成本 ≈ 6358 tok；若全部全文加载 ≈ 173200 tok
渐进披露的本质：为『可能用到』付费，而不是为『一定用到』付费。

模板: Review $1 (focus: ${2:-correctness, security}). Full request: $@. Extra: ${@:2}

  输入: (空，走默认值)
  参数: []
  展开: Review  (focus: correctness, security). Full request: . Extra: 

  输入: "API compatibility" perf
  参数: ["API compatibility","perf"]
  展开: Review API compatibility (focus: perf). Full request: API compatibility perf. Extra: perf

  输入: auth "input validation" sql-injection trailing
  参数: ["auth","input validation","sql-injection","trailing"]
  展开: Review auth (focus: input validation). Full request: auth input validation sql-injection trailing. Extra: input validation sql-injection trailing

断言通过：默认值、$1/$2 位置参数、$@ 全参、${@:N} 切片均符合 prompt-templates.md 语义表。
```

验证正文 §7：技能"常驻索引 vs 全文加载"约 27× 的成本比、prompt 模板替换语义（含 shell 式引号切分）。技能目录生成于系统临时目录。
