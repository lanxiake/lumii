# 第 12 片 · canvas 与宠物色层收敛 — 实施计划

> 创建：2026-09-20 · 状态：**规划中**
> 范围：`WindowEdgeGlow` / `pet/` 系列 / `click-fireworks` 的 canvas 绘制取色，4 文件 / ~100 处
> 上位文档：[主题色系切片总览](./README.md)
> 前置：[08 片](./08-主题令牌契约.md)（本片依赖"令牌保证存在"）

---

## 一、目标

渲染层里有三处颜色走的是**非 CSS 路径**：canvas 手绘、独立的宠物浮层、以及一个共用窗口的光晕。它们比 CSS 难处理，需要逐个想清楚语义再动。

本片的核心不是"把它们改成令牌"，而是**给每一层确定"该不该跟主窗主题变"**——这是第 7 片没涉及、也最容易做错的判断。

## 二、技术前提：canvas 不解析 `var()`

Canvas 2D 的 `fillStyle` / `strokeStyle` 赋值走的是 **CSS 颜色解析**，但 **canvas 上下文不参与 CSS 级联**——`ctx.fillStyle = 'var(--mt-accent-500)'` 是**无效值**，会被静默忽略并保留上一个值（不报错、不生效，最难查的那种）。

唯一正确路径：**先读计算值**。

```ts
getComputedStyle(document.documentElement).getPropertyValue('--mt-accent-500').trim()
```

仓库已确立这个模式，四处先例：

- `components/CapabilityRadar/CapabilityRadar.tsx:28-29` 的 `readToken()`
- `components/SatisfactionChart/SatisfactionChart.tsx:42`
- `pages/ChatPage/components/VoiceCallPanel/WaveformVisualizer.tsx:26`
- `components/layout/WindowEdgeGlow/WindowEdgeGlow.tsx:56/96`

**性能注意**：`getComputedStyle` 会强制样式重算，**不能在动画帧里调用**。正确做法是在主题变化 / resize 时读一次并缓存——`WindowEdgeGlow` 已经是这个模式（:247 在 resize 时重读）。

## 三、现状与逐项判断（2026-09-20 实测）

### 3.1 `WindowEdgeGlow` —— 应该跟主题，且改造有价值

**文件**：`components/layout/WindowEdgeGlow/WindowEdgeGlow.tsx`（2 处 hex + 8 处 rgba）

| 位置 | 现状 | 问题 |
|---|---|---|
| `:95-101` `readAccent()` | 从 `--mt-accent-400/500` 读实值 | **读法正确**，但写了 `\|\| '#60a5fa'` / `\|\| '#3b82f6'` 兜底——令牌已定义，是死代码 |
| `:187-201` 5 档径向渐变 | `147,197,253` / `96,165,250` / `59,130,246` / `37,99,235` / `224,242,254` / `125,211,252` | 硬编码的字面 RGB 三元组 |

**判断：应该跟主题。** 这是主窗边缘的光晕，让它在护眼主题下泛琥珀光、在浅色主题下用提饱和后的蓝，是本片最自然的收益。

**改造方式**：把 6 个色相改为按档位读取 `--mt-accent-300/400/500/600/700` + `--mt-sky-300/400`，再用一条 `hexToRgb()` 工具把读到的 hex 转成 `r, g, b` 拼进渐变字符串。

> **需要新增一个小工具 `hexToRgb()`**：现有 `--mt-accent-rgb` 只覆盖 accent-500 一个档位，拿不到 300/400/600/700 的三元组。工具放 `WindowEdgeGlow` 同目录即可（仅此一处使用）。

**顺带修一个真实缺陷**（08 片发现）：`readAccent()` 读的是 `--mt-accent-400/500`，这两个令牌在**全局固定区**有定义（`design-system.css:19-20`，值 `#93c5fd` / `#60a5fa`）→ 但在 light / eye-care 主题块里有覆盖。宠物窗若不设 `data-theme`，会读到 `:root` 的值 → 与主窗颜色不一致。**若 `WindowEdgeGlow` 只在主窗使用则无影响**，执行前先 grep 确认使用点。

### 3.2 `pet/` 系列 —— 不该跟主题，但该收口

**文件**：`pet/components/PetControlDock.tsx`（20 hex + 30 rgba）、`pet/PetModeShell.tsx`（3 hex + 3 rgba）、`pet/components/click-fireworks.ts`（7 hex）、`pet/components/PetDebugOverlay.tsx`（1 hex）

**判断：不该跟主题。** 宠物是**独立的透明浮层窗口**，显示在用户桌面上，不跟随主窗主题是**刻意的设计**——用户用深色主题工作时，桌面宠物不该突然变成米黄色。这个判断需要写进代码注释，否则下一轮重构还会有人想"顺手统一"。

**但要收口**：30 处 `rgba(255,255,255,α)` / `rgba(0,0,0,α)` 散在文件里，改一个"坞的暗度"要改 30 处。**建议做法**：

在 `PetModeShell` 根节点注入一组局部变量：

```css
--pet-dock-bg-rgb: 0, 0, 0;
--pet-dock-fg-rgb: 255, 255, 255;
```

然后把 `PetControlDock` 的 30 处收敛成 `rgba(var(--pet-dock-fg-rgb), α)`。**注意命名用 `--pet-*` 前缀而不是 `--mt-*`**——`--mt-*` 是主题令牌命名空间，混进去会误导（第 7 片的守卫测试按 `--mt-accent-*` 前缀扫全仓，用 `--mt-pet-*` 会踩到）。

**`click-fireworks.ts` 的 7 色豁免**：canvas 每帧 `ctx.fillStyle = p.color`（:134）从数组随机取色。改成读令牌需要每帧 `getComputedStyle`（性能反模式）或缓存 + 失效重读（复杂度不成比例）；且"透明桌面背景上要够亮"是独立于主题的语义。**保留字面量**。

**`PetDebugOverlay` 的 `#0f0` 豁免**：调试 HUD 的终端绿，刻意的辨识色。

**可改的两个小点**（这两处确实是主窗语义）：
- `PetModeShell.tsx:713` 的 `#6366f1` → `var(--mt-accent-500)`
- `PetModeShell.tsx` 的降级提示卡暗底 / 白字 → 保留（它模拟的是"独立浮层的提示"，与坞同层）

### 3.3 `WaveformVisualizer` / `MoodAvatar` —— 已在第 7 片处理，仅复核

- `pages/ChatPage/components/VoiceCallPanel/WaveformVisualizer.tsx:35/50-51` — 第 7 片已改 `--mt-violet` / `--mt-accent-500`
- `pages/AutonomousPage/MoodAvatar.tsx:31-35` — 第 7 片已改走 `--mt-tone-*` / `--mt-accent-*`

本片只需在验证阶段确认这两处在**三主题下都正常重绘**（尤其 light ↔ eye-care 的切换——第 7 片为此加了 `useThemeAttr()`，需确认这两个组件用的是它而非 `useDataThemeColorMode`）。

### 3.4 `ScreenRecordCapture` —— 豁免

`screen-record/ScreenRecordCapture.ts:337/390` 的 `#000` 是采样画布在 `alpha:false` 上下文里的初始填充，是**亮度检测算法的输入**而非 UI 颜色。**保留字面量**。

## 四、任务拆分

| # | 任务 | 文件 | 方式 |
|---|---|---|---|
| 4.1 | `WindowEdgeGlow` 6 档色相改为读令牌 | 1 | 加 `hexToRgb()` + 扩 `readAccent()` 为 `readToken()`；去掉 2 处死 fallback |
| 4.2 | 先用 grep 确认 `WindowEdgeGlow` 的使用点 | — | 若被宠物窗使用，需处理 `data-theme` 缺失问题 |
| 4.3 | pet 坞色层收口到 `--pet-dock-*` | 2 | `PetModeShell` 根注入变量；`PetControlDock` 30 处替换 |
| 4.4 | `PetModeShell:713` 的 `#6366f1` | 1 | `var(--mt-accent-500)` |
| 4.5 | 复核 `WaveformVisualizer` / `MoodAvatar` 的取色钩子 | 2 | 确认用 `useThemeAttr` 而非 `useDataThemeColorMode` |
| 4.6 | 把"宠物层不跟主题"写成代码注释 | 2 | 防止下一轮重构反向统一 |

## 五、验证

1. `pnpm typecheck` + `pnpm test:all`。
2. **`WindowEdgeGlow` 是主窗可见的**——三主题各截一张主窗边缘，确认光晕颜色随主题变（light 冷蓝 / eye-care 琥珀 / dark 亮蓝）。
3. **宠物窗单独验证**：`pnpm dev:restart` 后打开宠物模式，确认：
   - 坞的颜色**没有**跟随主窗主题变化（这是期望行为）
   - 收口后 30 处叠加层的视觉与改动前一致
4. **主题切换无残留**：light → eye-care → dark 连续切换，确认 `WindowEdgeGlow` 与波形图在每次切换后都重绘（canvas 不会自动重绘）。
5. `probe-theme-colors.mjs` 三主题数值：`WindowEdgeGlow` 在窗口边缘、面积占比小，数值变化应在 ±1 内。

## 六、明确不做

- **不给宠物窗设 `data-theme`**——理由见 3.2，是刻意设计。
- **不改 `click-fireworks` 调色板**——见 3.2 豁免理由。
- **不改 `ScreenRecordCapture` 的采样底色**——见 3.4。
- **不改 `PetDebugOverlay` 的终端绿**。
- **不把 `--pet-*` 变量塞进主题块**——它是局部作用域变量，不是主题令牌。

## 七、预期视觉变更登记

| # | 变更 | 影响面 |
|---|---|---|
| 1 | `WindowEdgeGlow` 光晕随主题变 | 主窗四周光晕在 light / eye-care 下颜色变化 |
| 2 | `PetModeShell` 的 `#6366f1` → `var(--mt-accent-500)` | 若宠物窗无 `data-theme`，取 `:root` 值（= `#3b82f6`）→ **会有轻微变化**，需截图确认 |
| 3 | pet 坞 30 处收口 | **零变更**（`--pet-dock-*` 的初值就是原来的 `255,255,255` / `0,0,0`） |
| 4 | `WaveformVisualizer` / `MoodAvatar` | **零变更**（第 7 片已改） |
