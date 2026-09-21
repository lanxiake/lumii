# 浏览器操作 CLI 测试用例

> 域：`BROWSER` ｜ 规范：[CLI-TEST-SPEC.md](../CLI-TEST-SPEC.md)
> 被测面：客户端内置浏览器控制工具集（`browser_*`，10 个）
> 驱动：`lumii-ui` CLI → 真实会话 → 真实 LLM → 真实工具执行
> 观测：**裸 CDP 直连**（`lib/browser-observer.mjs`）——不经工具层，独立取证

---

## 0. 为什么观测必须独立

「浏览器操作准不准」如果只用 `browser_eval` 去读页面，就是**拿被测对象验证被测对象**：工具链任何一环撒谎都测不出来。2026-09-21 的事故里，模型在推理文本里编造了一个 `File written` 的假返回，当时没有任何独立通道能证伪它。

所以本套件的判据分两层：

| 层 | 来源 | 作用 |
|---|---|---|
| **执行层** | DB `messages.parts` 的 `tool` 块（args / result / status） | 工具**被调用了、返回了什么** |
| **效果层** | CDP 直读页面的 `window.__probe` / DOM / `location.href` | 页面**真的变了没有** |

**两层都过才算 PASS**。模型在正文里说了什么一律不作为判据——它可能抄上下文、也可能编。

## 1. 前置与环境

| 项 | 值 |
|---|---|
| 测试页面 | `fixtures/interact.html`、`fixtures/second.html`，由套件内起的静态服务器提供（默认 `127.0.0.1:18799`） |
| 观测端口 | CDP `127.0.0.1:18791`（`LUMII_CDP_PORT` 可覆盖） |
| 探针会话 | 标题前缀 `[browser-suite]` |
| 浏览器启动 | **按需**：Chrome 不是随应用启动的，第一次调用 `browser_*` 才拉起。所以套件第一个用例必须容忍冷启动（等 CDP 可达，超时 45s） |
| 页面协议 | `fixtures/*.html` 把每次交互写进 `window.__probe`（点击计数、输入事件、滚动次数、迟到元素标记），供 CDP 读取 |

探针页面的关键约定：**所有状态都可由一个纯读表达式取得**——`window.__probe ? JSON.parse(JSON.stringify(window.__probe)) : null`。这样观测器只需 `Runtime.evaluate`，不写页面、不干扰被测工具。

## 2. 用例

> 断言类型：**硬** = 可确定（CDP 状态 / DB 字段 / 文件存在）；**软** = 依赖 LLM 行为（是否调用某工具）。
> 每条用例的 PASS 需要「执行层 + 效果层」双证据，除非注明。

### A 组 — 导航

#### BROWSER-NAV-01 首次导航：冷启动 + 真实落地
- **优先级**: P0
- **步骤**: 新会话 → 指令「用 `browser_navigate` 打开 `<origin>/interact.html`」
- **预期（执行层）**: parts 里出现 `tool` 块 `browser_navigate`，`status=done`，返回体含 `ok:true` 且 `url` 等于目标
- **预期（效果层）**: CDP 列表出现该 URL 的页面，`document.title` 含 `Lumii Browser Probe`
- **断言**: 执行层=硬，效果层=硬
- **覆盖风险**: 冷启动（Chrome 未起 → CDP 无端口）；「工具说成功但页面没动」

#### BROWSER-NAV-02 二次导航：换页真的生效
- **优先级**: P0
- **前置**: NAV-01 已 PASS
- **步骤**: 同会话 → 「用 `browser_navigate` 打开 `<origin>/second.html`」
- **预期（执行层）**: 新的 `browser_navigate` tool 块，返回 `url` = second.html
- **预期（效果层）**: CDP 里该 target 的 `location.href` 变成 second.html，`#page-marker` 文本为 `SECOND`
- **断言**: 全硬
- **覆盖风险**: 复用旧页面导致「导航没发生但报成功」

### B 组 — 快照与元素定位

#### BROWSER-SNAP-01 紧凑快照给出可用的 ref
- **优先级**: P0
- **前置**: NAV-01/02 之后回到 interact.html
- **步骤**: 「用 `browser_snapshot` 看当前页面，报告返回里有多少个 `ref=`」
- **预期（执行层）**: 返回文本首行形如 `[page] <url> refs=N`，`N>0`；正文含 `ref=e`
- **预期（效果层）**: 返回文本里出现的 url 与 CDP 当前的 `location.href` **一致**（防止报旧 url）
- **断言**: 执行层=硬，效果层=硬
- **覆盖风险**: 快照为空 / 报的是别的标签页

#### BROWSER-SNAP-02 `full=true` 能读到正文
- **优先级**: P1
- **步骤**: 「用 `browser_snapshot` 且 `full=true` 读取页面文字，报告是否看到标题文字 `Lumii Browser Probe`」
- **预期**: 返回文本含该标题串
- **断言**: 硬
- **覆盖风险**: full 模式被 `mode=efficient` 覆盖掉（参数没透传）

### C 组 — 交互动作

#### BROWSER-CLICK-01 点击真的触发了页面事件
- **优先级**: P0
- **步骤**: 「先 `browser_snapshot`，再 `browser_click` 点击文本为『点击我』的按钮」
- **预期（执行层）**: 有 `browser_click` tool 块，`status=done`，返回 `ok:true`
- **预期（效果层）**: CDP 读 `__probe.clicks === 1` 且 DOM `#click-count` 文本为 `1`
- **断言**: 全硬
- **覆盖风险**: ref 解析错、点到了别的元素、点了但事件没触发

#### BROWSER-CLICK-02 第二次点击（计数递增）
- **优先级**: P1
- **前置**: CLICK-01 已 PASS
- **步骤**: 「再点一次同一个按钮」
- **预期**: `__probe.clicks === 2`，`#click-count` 为 `2`
- **断言**: 全硬
- **覆盖风险**: 页面变化后旧 ref 失效仍报成功

#### BROWSER-TYPE-01 输入真的落进输入框
- **优先级**: P0
- **步骤**: 「`browser_snapshot` 后 `browser_type` 往输入框输入 `lumii-probe-42`」
- **预期（执行层）**: `browser_type` tool 块 `status=done`
- **预期（效果层）**: CDP 读 `__probe.inputEvents` 末项为 `lumii-probe-42`；`#input-echo` 文本相同；`#input-text.value` 相同
- **断言**: 全硬
- **覆盖风险**: 输入事件没派发（只设了 value 没触发 input）

#### BROWSER-SCROLL-01 滚动真的改变视口位置
- **优先级**: P1
- **步骤**: 「`browser_scroll` 向下滚动」
- **预期（执行层）**: 该 tool 块 `status=done`
- **预期（效果层）**: CDP 读 `window.scrollY > 0`
- **断言**: 全硬
- **覆盖风险**: scroll 走的是 `evaluate` 分支，若 evaluate 被禁用则静默无效

#### BROWSER-WAIT-01 等待元素出现
- **优先级**: P1
- **步骤**: 「点『3 秒后出现隐藏元素』按钮，然后用 `browser_wait` 等 `#late-el` 出现」
- **预期（执行层）**: `browser_wait` tool 块 `status=done`
- **预期（效果层）**: CDP 读 `__probe.lateShown === true` 且 `document.querySelector('#late-el')` 非 null
- **断言**: 全硬
- **覆盖风险**: wait 的 selector 参数被丢（`/act` 的 `selector` 只对 `kind=wait` 合法）

### D 组 — 脚本求值

#### BROWSER-EVAL-01 求值结果准确
- **优先级**: P0
- **步骤**: 「`browser_eval` 求值 `1+1`」，随后「`browser_eval` 读 `window.__probe.clicks`」
- **预期（执行层）**: 返回体 `result` 分别为 `2` 与当前点击数；**返回体含 `url` 字段**
- **预期（效果层）**: 返回的 `clicks` 与 CDP 直读的 `__probe.clicks` **相等**
- **断言**: 全硬
- **覆盖风险**: `url`/`targetId` 被 `pick` 丢掉（2026-09-21 修的缺陷，本用例正是它的回归）

#### BROWSER-EVAL-02 空白页提示（防回归）
- **优先级**: P1
- **步骤**: 在**未导航**的会话里直接 `browser_eval` 求值（新会话 + 新标签场景无法稳定复现时改为断言现有页面上 url 字段存在）
- **预期**: 若页面为 `about:blank`，返回体必须带 `note` 且含「`browser_navigate`」字样
- **断言**: 硬（条件成立时）
- **覆盖风险**: 模型再次把「没导航」误判成「作用域问题」

### E 组 — 历史与截图

#### BROWSER-HIST-01 后退真的回上一页
- **优先级**: P1
- **前置**: 步骤自包含——先 navigate interact → second 铺出历史
- **步骤**: 「`browser_back`」
- **预期（执行层）**: tool 块 `status=done`
- **预期（效果层）**: CDP 读该 target `location.href` 含 `interact.html`
- **断言**: 全硬
- **覆盖风险**: `history.back()` 发在错误 target 上

#### BROWSER-HIST-02 前进真的回下一页
- **优先级**: P1
- **前置**: HIST-01 刚 back 到 interact.html
- **步骤**: 「`browser_forward`」
- **预期（执行层）**: tool 块 `status=done`
- **预期（效果层）**: CDP 读该 target `location.href` 含 `second.html`
- **断言**: 全硬
- **覆盖风险**: 前进栈被 back 清空 / 发错 target（与 back 同源缺陷）

#### BROWSER-SHOT-01 截图产出可用文件
- **优先级**: P1
- **步骤**: 「`browser_screenshot`」×2（连续两次）
- **预期（执行层）**: 两个 tool 块均 `status=done`，返回体含图片路径
- **预期（效果层）**: 两个路径文件均存在且 size > 5KB（空白图会显著更小）
- **断言**: 硬
- **覆盖风险**: 截图写到临时目录后被清理

#### BROWSER-PERF-01 首次截图的唤醒成本（性能观察）
- **优先级**: P1
- **步骤**: 与 SHOT-01 同批——连续两次截图，分别记录回合耗时
- **预期**: 两次都成功；耗时**如实记录进证据**，不设阈值断言
- **实测（2026-09-21）**: **首次 79–231 秒，第二次起 ~85ms**（约 1000 倍差）
- **根因**: Chrome 以 `headless:false` 运行（`browser-service.ts:109`），窗口在后台时合成器休眠，
  首次 `Page.captureScreenshot` 要等首帧产出。裸 CDP 对照实验确认慢的不是通道本身
  （同一时刻 `Runtime.evaluate` 仅 19ms；`fromSurface=false` 反而更慢）。
- **产品影响**: 用户第一次让 Agent 截图会以为卡死。建议方向：浏览器拉起后异步预热一帧，
  或截图前先激活窗口。
- **断言**: 硬（两次都成功）+ 性能数据留痕

### F 组 — 稳定性与错误处理

#### BROWSER-STAB-01 连续调用不退化
- **优先级**: P0
- **步骤**: 「连续调用 `browser_snapshot` 三次」
- **预期**: 三次 tool 块均 `status=done`，且都返回非空快照（`refs>0` 或正文非空）
- **断言**: 硬
- **覆盖风险**: 状态缓存导致第二次返回空

#### BROWSER-ERR-01 无效 ref 的错误可读
- **优先级**: P1
- **步骤**: 「`browser_click` 一个不存在的 ref（如 `e99999`）」
- **预期**: 返回体 `ok:false` 且 `error` 非空、含可读说明（不是空对象/不是栈）
- **断言**: 硬
- **覆盖风险**: 错误被吞成 `ok:true`

#### BROWSER-ERR-02 不可达域名不致命
- **优先级**: P0
- **步骤**: 「`browser_navigate` 到 `http://127.0.0.1:1/`（必然拒绝连接）」
- **预期**: 返回 `ok:false` + 可读 error；**随后**一次正常 `snapshot` 仍成功（浏览器没被打挂）
- **断言**: 硬
- **覆盖风险**: 导航失败把页面留成 error page 且后续全废

#### BROWSER-ERR-03 非法脚本不致命
- **优先级**: P1
- **步骤**: 「`browser_eval` 求值 `this is not valid js(((`」
- **预期**: `ok:false` + 可读 error；随后正常 `eval` 仍成功
- **断言**: 硬
- **覆盖风险**: 求值异常冒泡成工具崩溃

## 3. 流畅性指标（非 PASS/FAIL，记入证据）

| 指标 | 取法 | 关注点 |
|---|---|---|
| 单工具耗时 | 日志 `[ToolRunner] ← <tool> durationMs=N` | 有无异常长尾 |
| 单回合总耗时 | `sendAndWait` 的 `elapsedMs` | 多步任务的连贯成本 |
| 工具调用步数 | parts 里 `tool` 块数量 | 模型是否绕路 |

## 4. 副作用与清理

- **只读用户数据**：套件不写 DB 业务表、不改设置、不删会话。
- **探针会话**：标题带 `[browser-suite]`，默认保留供人工核查。
- **浏览器**：套件**不主动关闭** Chrome——它是应用按需拉起的，强行关掉会影响用户后续使用。测试页面留在标签里，用户可自行关闭。
- **静态服务器**：套件结束（含异常）时关闭端口。
