# 浏览器操作套件 测试报告

- **生成时间**: 2026-09-21T03:43:56.394Z（开始 2026-09-21T03:36:27.329Z）
- **驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/context 等），真实客户端 + 真实 LLM，无 SQL 播种
- **数据库**: C:\Users\75791\.lumii\data\agent-runtime.db
- **被测对象**: 客户端浏览器控制工具集（browser_* × 10）
- **驱动**: lumii-ui CLI → 真实会话 → 真实 LLM → 真实工具执行
- **观测**: 裸 CDP 直连 127.0.0.1:18791（不经工具层）
- **探针页面**: http://127.0.0.1:18800

## 概要

| 指标 | 值 |
|---|---|
| 总数 | 19 |
| 通过 | 19 |
| 失败 | 0 |
| 跳过 | 0 |
| 通过率 | 100.0% |

## 逐条结果

| ID | 状态 | 说明 | 耗时 |
|---|---|---|---|
| BROWSER-NAV-01 | ✅ | 冷启动+落地成功，title="Lumii Browser Probe — interact" | - |
| BROWSER-NAV-02 | ✅ | 换页生效，marker=SECOND，返回 ok=true | - |
| BROWSER-SNAP-01 | ✅ | refs=3，url 与 CDP 一致 | - |
| BROWSER-SNAP-02 | ✅ | full 模式读到标题正文（487 字符） | - |
| BROWSER-CLICK-01 | ✅ | ref=e1 → __probe.clicks=1，DOM 同步 | - |
| BROWSER-CLICK-02 | ✅ | 连点递增 → __probe.clicks=2（args={"ref":"e1"}） | - |
| BROWSER-TYPE-01 | ✅ | 输入事件与 DOM 值双向确认："lumii-probe-42" | - |
| BROWSER-SCROLL-01 | ✅ | scrollY 0 → 500 | - |
| BROWSER-WAIT-01 | ✅ | selector 等待命中，元素已插入 DOM | - |
| BROWSER-EVAL-01 | ✅ | 1+1=2；url 字段在；clicks 交叉一致（2） | - |
| BROWSER-EVAL-02 | ✅ | 空白页求值带导航提示：「当前标签停在空白页，页面上没有任何脚本与变量——先用 browser_n…」 | - |
| BROWSER-HIST-01 | ✅ | history.back() 落到 interact.html | - |
| BROWSER-HIST-02 | ✅ | history.forward() 回到 second.html | - |
| BROWSER-SHOT-01 | ✅ | 两次均产出有效图（9.7KB / 9.7KB） | - |
| BROWSER-PERF-01 | ✅ | 回合耗时：首次 6.4s → 第二次 6.3s（含模型往返，比值 1.0x；首帧唤醒成本） | - |
| BROWSER-STAB-01 | ✅ | 连续 3 次均成功，长度 74/74/74 | - |
| BROWSER-ERR-01 | ✅ | 可读报错：Error: Unknown ref "e99999". Run a new snapshot and use a ref from tha | - |
| BROWSER-ERR-02 | ✅ | 可读报错且浏览器存活（CDP 直连确认）：Error: page.goto: net::ERR_UNSAFE_PORT at http://127.0.0.1:1 | - |
| BROWSER-ERR-03 | ✅ | 可读报错且求值能力未受损（2+2=4）：Error: page.evaluate: Error: Invalid evaluate function: Unex | - |

## 失败与跳过明细

无。

## 流畅性（工具耗时，取自 `[ToolRunner] ← ... durationMs=`，日志近 2 万行）

| 工具 | 次数 | 中位耗时 | 最大耗时 |
|---|---|---|---|
| browser_click | 9 | 257ms | 312ms |
| browser_snapshot | 7 | 144ms | 208ms |
| browser_type | 1 | 178ms | 178ms |
| browser_eval | 8 | 97ms | 112ms |
| browser_scroll | 1 | 90ms | 90ms |
| browser_wait | 1 | 2737ms | 2737ms |
| browser_navigate | 7 | 136ms | 171ms |
| browser_back | 1 | 65ms | 65ms |
| browser_forward | 1 | 79ms | 79ms |
| browser_screenshot | 2 | 140ms | 140ms |


## 主要发现

### 1. ⚠️ 首次截图极慢（79–231 秒），之后 ~85ms

上表 `browser_screenshot` 的 140ms 是**热状态**读数——本套件跑之前，Chrome 的合成器
已被其他调试活动唤醒过。**冷状态下的首次截图完全是另一回事**，裸 CDP 独立实验（不经工具层）：

| 连续第 N 次 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| 耗时 | **79648ms** | 79ms | 90ms | 76ms | 84ms |

套件首轮（浏览器刚被拉起）实测 `ToolRunner ← browser_screenshot durationMs=231641` ——**231 秒**。

**根因**：Chrome 以 `headless:false` 运行（`apps/windows/src/main/browser-service.ts:109`），
窗口在后台时合成器休眠，首次 `Page.captureScreenshot` 要等首帧产出；此后帧已在产就快了。

**已排除**（对照实验做的，别重复走弯路）：
- 不是 CDP 通道慢——同一时刻 `Runtime.evaluate` 只要 **19ms**
- 不是 `captureBeyondViewport` 的锅——置 false 反而更慢（120s 超时）
- 不是页面太大——`fromSurface:false` 同样超时；视口截图（15.3KB）与全页截图一样慢

**产品影响**：用户第一次让 Agent 截图会以为卡死。建议方向：浏览器拉起后**异步预热一帧**，
或截图前先激活窗口。

### 2. 工具执行本身很快（热状态）

除 `browser_wait`（本套件故意让它等 3 秒的延迟元素，2737ms 属预期）外，**全部工具中位耗时
都在 300ms 以内**：click 257ms / snapshot 144ms / navigate 136ms / eval 97ms / back 65ms。
端到端回合耗时的大头是模型往返，不是浏览器操作。

### 3. 能力边界：没有标签管理

工具集**没有**列标签 / 切标签的命令，且目标选择**粘在** `lastTargetId`
（`browser-control/src/browser/server-context.ts:403-412` 的 `pickDefault()`：
优先复用上次操作过的标签，否则取第一个 page）。后果：用户在 Chrome 里手动切到别的标签后，
Agent 仍会操作**上一个**标签。缓解是 `browser_snapshot` 返回首行的 `[page] <url> refs=N`
让模型能看见自己在哪一页（这正是 2026-09-21 补 `url` 字段的价值）。

### 4. 可靠性观察：模型会编造工具结果（不属浏览器工具缺陷）

套件第二轮的 ERR 步骤曾出现：模型在 thinking 里写 "Just one call."，正文直接给出
「工具原样返回内容如下：`- Page snapshot (1 nodes) / RootWebArea`」，但该消息 parts 里
**零 tool 块**、日志里**零 `tool:start`** —— 结果是编的。

判别只能靠日志（`grep "ToolRunner\] → <tool>"`）。这与 2026-09-21 修复的
「把 `<invoke>` XML 写进推理文本」是**同一类故障的另一个变体**，但那个检测器抓不到它
（模型没声称要调用，只给了一份"结果"）。已记录，未据此扩检测器——启发式误报面太大。

## 测试方法与边界

- **判据两层缺一不可**：执行层（DB `messages.parts` 的 `type==='tool'` 块）+ 效果层
  （裸 CDP 直读页面 `window.__probe`）。模型在正文里的自述**一律不作为判据**。
- **驱动只能走 LLM**：CLI 无浏览器命令、控制口白名单未收录、browser-control 的 dispatcher
  是进程内的（无 HTTP 服务器）。
- **未覆盖**：多标签切换（工具集不支持）、并发调用同一页面、浏览器长时间空闲后的行为、
  截图内容的像素级正确性（只验了文件非空且 > 5KB）。

## 证据

逐条原始证据见 [browser-suite-evidence.jsonl](./browser-suite-evidence.jsonl)。
