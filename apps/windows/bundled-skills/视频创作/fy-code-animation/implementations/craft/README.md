# 线描、手绘、像素和动态字组件

来源Renoise MIT，抽取已逐行阅读的11个组件文件；每个源ID/hash/修改记录在项目研究目录的工艺复用映射.json。运行依赖：React、remotion；lineart/handdrawn还需@remotion/paths。未附字体、媒体或完整工程。

| 路径 | 接口与单位 | 约束 |
|---|---|---|
| lineart/index.tsx | Stroke(d,u)、penAt(d,u)、Oneline(segs,t)、chainPen；a/b/t为帧 | 空链/零时长拒绝，路径长度cache限512；多滤镜ID隔离 |
| handdrawn/index.tsx | onTwos(frame,hold)、BoilDefs、Rough、Hatch、Sparkle、Smear | hold=2指输出帧不是固定12fps；全画面只挂一套固定ID滤镜 |
| pixel/index.tsx | PixelStage(t,draw,w,h,outW,outH)、sprite、pixText、cycle | t由调用者统一；整数等比缩放；Latin字库缺汉字明确报错 |
| type/VarType.tsx | at/stagger/dur为帧；rise为em、blur为px、axes真实字体轴 | 默认tracking改0；中文按意群组织，不默认每字都动 |
| type/OutlineFill.tsx | writeAt/writeDur/fillAt/fillDur为帧 | unique useId裁切，正时长；默认1920×1080需画幅适配 |
| type/HandReveal.tsx | cps为字符/秒，at为帧 | 已按useVideoConfig().fps换算；横向显现不是真笔顺 |
| type/TrackIn.tsx | dur帧、from/to字距em | 默认blur；像素/安静需求可不选 |
| type/Decode.tsx | perChar/settle为帧 | 固定hash字符扰动；字素组合需额外分词 |
| type/fonts.ts | public/fonts/fonts.json→Face[] | HTTP失败/缺指定ID报错；ids调用期间保持稳定；调用者验证cmap |
| motion.ts | 独立expo.out/power3.inOut数值适配 | 不再额外依赖GSAP时间线 |

与原版相比还修了非法sprite、空调色板、字体请求失败及时间输入等边界。没有把本轮TS语法通过称作浏览器像素一致性通过。复用前运行目标工程类型/构建和该阶段允许的视觉检查。
