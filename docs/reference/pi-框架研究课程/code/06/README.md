# 第 06 篇实验：pi-tui 差分渲染与输入解析

三个零依赖 `.mjs`（Node ≥ 20），全部 `node <file>` 直接跑，无需 TTY/终端。
它们用简化但语义对齐的方式复刻 `packages/tui/src/tui-main-screen.ts`、
`tui-alt-screen.ts`、`stdin-buffer.ts`、`keys.ts` 的核心逻辑（简化处见各脚本头注释）。

| 脚本 | 验证正文哪个论断 |
|---|---|
| `01-diff-renderer.mjs` | §4：firstChanged..lastChanged 行带重写；流式帧的写盘量 ∝ 变化行宽而非文档长度；宽度变化/改动高于视口两条全量重绘退化路径；帧字节与屏幕状态逐帧一致 |
| `02-sync-output.mjs` | §5：一帧 = `ESC[?2026h` … `ESC[?2026l`；未变行零字节；不支持终端忽略序列优雅降级 |
| `03-input-probe.mjs` | §7：序列完整性三态（complete/incomplete/not-escape）、拆包拼包、legacy+Kitty CSI-u 语义表 |

## 实跑输出（2026-09-23，Windows / Node v24）

### `node 01-diff-renderer.mjs`

```text
=== 场景 1：流式追加（终端 24 行 × 58 列）===
frame  mode  firstChanged  rewroteLines  diffBytes  fullRedrawBytes  diff/full
  1   full (first render)             0      11      649        649  1.00
  4   diff                           10       1      151        669  0.23
  8   diff                           11       1       36        701  0.05
 10   diff                           11       1       43        712  0.06
逐帧落屏一致性校验: PASS

=== 场景 2：cols 58 -> 48（折行全变）===
mode = full (width changed), rewroteLines = 13, bytes = 723

=== 场景 3：内容远超视口后，改动第 0 行（视口之上）===
首帧: mode 应为 first render（上面已建新基线），viewportTop = 36
改动视口之上: mode = full (firstChanged above viewport), firstChanged = 0
改动视口之内: mode = diff, firstChanged = 59, bytes = 37
```

读表：流式追加帧的写盘量稳定在 36~43 字节（≈当前行宽 + 控制序列），
而全量重绘随行数增长到 700+；比值 0.05 就是"差分让边际成本恒定"的直译。
场景 3 对照 pi 源码 `firstChanged < prevViewportTop → fullRender(true)` 的同款决策。

### `node 02-sync-output.mjs`

```text
非 TTY 环境 → 打印每帧将发出的原始序列（ESC=\x1b）：

--- frame 1: 41 字节, 重写 1 行 ---
ESC[?2026hESC[HESC[1;1HESC[2Kpi> 流式回答中...ESC[?2026l

--- frame 2: 40 字节, 重写 1 行 ---
ESC[?2026hESC[HESC[2;1HESC[2K差分只重写变化的那一行ESC[?2026l

--- frame 3: 41 字节, 重写 1 行 ---
ESC[?2026hESC[HESC[3;1HESC[2K同步输出保证整帧原子可见ESC[?2026l

说明：
- 每帧以 ESC[?2026h 开始、ESC[?2026l 结束。
- Ghostty/iTerm2/Kitty 等终端在 end 之前缓冲写入，一次性重绘 → 看不到中间态（无撕裂）。
- 老终端不认识 ?2026 私有模式，直接忽略这对序列：帧仍然正确，
  只是失去原子性——这正是 pi-tui 博客里 (almost) flicker-free 的由来。
```

### `node 03-input-probe.mjs`

```text
非 TTY 环境 → 用内置样例跑同一套解析器：

输入(转义)                        | 完整性            | 解析结果
------------------------------------------------------------------------------
"A"                               | not-escape        | text "A"   ← 普通字符
"\e[A"                            | complete          | up   ← 方向键(PPA)
"\eOB"                            | complete          | down   ← 方向键(SS3)
"\e[3~"                           | complete          | delete   ← Delete
"\e[5~"                           | complete          | pageUp   ← PageUp
"\e[1;5C"                         | complete          | ctrl+right   ← Ctrl+Right
"\e[13;2u"                        | complete          | shift+enter   ← Kitty shift+enter
"\e[200~"                         | complete          | bracketed paste START   ← bracketed paste
"\x03"                            | not-escape        | ctrl+c   ← Ctrl+C(控制字符)
"\x7f"                            | not-escape        | backspace   ← Backspace(DEL)
"\e[<35;20;5m"                    | incomplete→complete | mouse sgr btn=35 @(20,5) release   ← 鼠标SGR被拆包
"\e[999Q"                         | complete          | unknown \e[999Q   ← 未知CSI
"\e"                              | incomplete        | escape   ← 裸ESC→超时判Esc

关键点：\x1b[<35;20;5m 分两个 chunk 到达时，第一层判定 incomplete 并缓冲，
拼完整后才交给第二层——半个序列永远不会被误读成按键。
```

## 与真实实现的差异（有记录的精简）

- 01 未实现 kitty 图像行扩带（`expandChangedRangeForKittyImages`）与 `clearOnShrink` 选项；
  全量重绘用 `\x1b[2J\x1b[H`（pi 还加 `\x1b[3J` 清 scrollback）。
- 02 帧首用绝对 `\x1b[H` 简化；真实主屏渲染器用相对移动（`\x1b[nA/B`）跟踪 `hardwareCursorRow`。
- 03 的超时值未在演示中真实等待（真实为 ESC 10ms/序列 50ms），TTY 分支逻辑与演示共用同一解析器。
