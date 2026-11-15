---
name: pdoom-mv
description: 用 pdoom-video 的确定性渲染引擎做音乐视频 / 歌词可视化 / 节拍驱动的动态图形片。核心是「每一帧是时间的纯函数」——同一秒渲两次像素完全相同，浏览器预览与离线导出逐像素一致。流程：音频分析 → 写场景代码 → 逐帧渲染 → ffmpeg 成片。适合需要帧级可复现、4K 真渲染、无缝循环的片子；不适合剪辑实拍素材或用 AI 生成画面。
version: v1.0（2026-11-01，来源：pdoom-video 23248 行源码全量实测 + 《广东爱情故事》MV 实做）
---

# pdoom 音乐视频引擎

> **定位：不是剪辑软件，是「把画面写成代码」的渲染器。**
> 你交付的不是素材，是场景模块。创作者要能读 TypeScript 和 GLSL。
> 换歌不用改引擎，但要重写场景——这是全部成本所在。

## 1. 什么时候用 / 不用

| ✅ 用 | ❌ 别用 |
|---|---|
| 音乐视频、歌词可视化 | 剪辑实拍 / 素材拼接 |
| 无限循环背景（0→N 秒无缝） | 导入视频、图片、3D 模型 |
| 节拍/数据驱动的动态图形 | AI 生成画面 |
| 需要 4K 逐像素一致 | 半小时内要出片 |
| 卡拉 OK 逐字擦除 | 音频合成 / 混音 |

**判断标准**：如果需求里出现「精确到帧」「渲一万次结果不变」「4K 真分辨率」「无缝循环」，用它。如果出现「把这几个视频拼起来」「加个转场」，别用。

## 2. 引擎能力清单（全部实测过）

**时间与数据层**
- `AudioData`：`beats[]` / `downbeats[]` / `sections[]` / `beatAt(t)` / `barAt(t)` / `timeOfBeat(i)`
- 8 条包络：`env('rms'|'low'|'mid'|'high'|'vocal'|'drums'|'bass'|'other', t)`，线性插值
- 脉冲：`hit('kick'|'snare'|'hat'|'vocal', t, halfLife)`，指数衰减
- `Frame` 每帧自带 `f.a.{rms,kick,snare,hat,vonset...}`、`f.beat`、`f.barPhase`
- `Lyrics`：词级时间（可选，纯节拍驱动时给 `{"lines":[]}` 即可）

**渲染层**
- `FSPass(frag, uniforms)`：GLSL3 全屏 pass，自动注入 `GLSL_COMMON`（hash / snoise / fbm / SDF / hatch / heat）
- `Layer2D`：1920×1080 逻辑 Canvas2D → sRGB 纹理，中文用系统字体
- `Compositor.draw()`：`normal|add|screen|multiply|max|replace` + opacity / tint / uvXform
- `LineBatch`：GPU 线条批次（粒子、轨迹、雨丝）
- 后期 `PostParams`：`exposure, bloom, bloomThreshold, halation, ca, grain, vignette, fade, flash, shake, zoom, invert, hud`

**输出层**
- `still(t, samples, shutter)` → 单帧，返回子帧数
- `png()` → 全分辨率 PNG base64（4K 用）
- `stream({from,to,fps,ws,samples,shutter,inflight})` → rgb24 原始帧 over WebSocket
- 模式：`stills` / `sheet` / `perf` / `video` / `plates`

## 3. 复用五步（照抄即可）

**① 起项目**（不要改原仓库，复制出来）
```bash
cp -r <pdoom>/app/src/engine  <new>/app/src/engine
cp <pdoom>/app/{index.html,vite.config.ts,tsconfig.json,package.json} <new>/app/
cp -r <pdoom>/app/public/fonts <new>/app/public/     # ← 漏了会报 Invalid font data
cd <new>/app && bun install && npm i ws --no-save    # ws 只有 video 模式需要
```
目录约定：`<new>/{app, audio, data}`，`vite.config.ts` 的 `repoRoot` 是 `app` 的父目录。

**② 音频分析与切片**
```bash
ffmpeg -ss <起点> -t <时长> -i song.mp3 -c:a libmp3lame -q:a 2 clip.mp3
python analyze.py clip.mp3 data/audio.json     # librosa，见本 skill 的 analyze.py
```
输出必须是引擎的 `AudioJSON`：`{duration,bpm,fps,beats,downbeats,sections,features,onsets}`，`fps=100`，包络按 P95 归一化到 0..1。

**③ 写场景**（成本全在这）
```ts
export default class S extends Scene {
  bg = new FSPass(`uniform float t,kick,rms; void main(){...}`, {...});
  ui = new Layer2D();
  render(f: Frame, out) {
    this.bg.u.t.value = f.t; this.bg.render(this.ctx.renderer, out);   // 必须完全覆盖 out
    const c = this.ui.ctx; this.ui.clear(); /* Canvas2D 画字 */
    this.ctx.comp.draw(this.ctx.renderer, this.ui.upload(), out, { mode: 'normal' });
    return { hud: 0, bloom: 0.7, grain: 0.55 };   // hud:0 关掉 pdoom 自带的读数 HUD
  }
}
```
**硬约束**：`render()` 必须是 `f.t` 的纯函数（禁 `Math.random()` / `Date.now()`）；闪光/抖动用 `frameIdx(t)` 而不是 `Math.floor(t*60)`；有状态的场景设 `stateful = true` 并实现 `reset()`，且**不能用自适应采样**。

**④ 接时间轴**
```ts
export function makeTimeline(_ly: Lyrics, au: AudioData): TimelineEntry[] {
  const snap = (t) => au.downbeats.reduce((b,x)=>Math.abs(x-t)<Math.abs(b-t)?x:b, au.downbeats[0]);
  return [E('open','open',0,snap(8)), ...];   // 边界吸附到强拍
}
```

**⑤ 验证 → 出片**
```bash
bunx vite --port 5273          # 预览也靠它
node driver-stills.mjs         # 先渲 8 张静帧，看亮度/主色是否合设计
node video-test.mjs            # 再渲 6 秒片段验证运动
node video-test.mjs PD_FROM=0 PD_TO=<全片>
```

## 4. 性能预算（RTX 4060 Ti + Xeon E5-2680v4 实测）

| 档位 | 参数 | 1080p 吞吐 | 一分钟成片 |
|---|---|---|---|
| 纯渲染 | `samples=1`（无模糊） | **3–10 ms/帧** = 100+ fps | — |
| 端到端草稿 | `samples=1` + 编码 | 5.5–6.5 fps | **≈ 9 分钟** |
| 可接受 | `samples=12` | 1.0 fps | **≈ 58 分钟** |
| 生产 | `samples=auto`（12→324 自适应） | 0.15–0.5 fps | **≈ 5.6 小时** |
| 4K 生产 | `--scale 2` + auto | 最重场景 21 s/帧 | 别在本机想 |

**瓶颈在 CPU 不在 GPU**：自适应采样每轮要 `readRenderTargetPixels` 同步回读 + 2040 个 32×32 tile × 9 邻域的 JS 循环。弱单核机器上它吃掉 99% 时间。
**冷启动另算**：重场景首次编译 5–16 秒（paperclips 19.9s），不是每帧成本。

## 5. 六个必踩的坑（都踩过）

1. **`--use-angle=metal`** 是 macOS 专用，Windows 改 `--use-angle=d3d11`，否则 GPU 进程起不来。
2. **Bun + playwright-core 在 Windows 上握手必失败**（1.3.5 和 1.4.4 都试过，Node 22 只要 428ms）。`render.ts` 深度依赖 `Bun.spawn/Bun.serve`，**在 Windows 上直接跑不了**。绕法：用 Node 驱动 `window.__pdoom`，服务端用 `ws` 替代 `Bun.serve`——引擎 API 够干净，可以完全不解 Bun。
3. **`public/fonts` 必须一起复制**，否则启动即 `Invalid font data in ArrayBuffer`。
4. **`channel:'chrome'` 只认标准安装路径**，Edge 也会因 `--remote-debugging-pipe` 超时。
5. **CRF 16 + `-tune grain` 体积爆炸**：6 秒 1080p 能到 314 MB（420 Mbps）。交付用 `-crf 20`，或渲完再转码。
6. **重负载后性能不恢复**：同一页面跑过 `samples≥36` 之后，回到固定 12 子帧还是慢 20 倍（非过热、非泄漏、非上下文丢失，显存稳定 2.4GB）。长片**分段渲染，每段起新浏览器进程**。

## 6. 交付前自检

- [ ] 22 个（或 N 个）场景全部渲染成功，`__pdoom.errors` 为空
- [ ] 同一 `t` 连渲两次 PNG SHA1 相同（确定性）
- [ ] 抽帧亮度/对比符合设计（黑屏、纯色都是 bug）
- [ ] 音频段与画面段对齐，`-shortest` 生效
- [ ] 色彩标注 `bt709/bt709/bt709`
- [ ] 文件体积在交付预算内（1080p 60fps 建议 ≤ 15 Mbps）

## 7. 参考实现

- `temp/gd-mv/` — 本 skill 的完整实例：5 个场景（夜城 / 心跳 / 雨夜 / 副歌 / 收尾）+ librosa 分析 + Node 驱动，46 秒成片。
- `temp/pdoom-video-test/repo/` — 原项目，17 个场景 23248 行，可当高级写法的字典。
