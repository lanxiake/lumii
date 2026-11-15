# Remotion接入与版本

本轮原技能快照标4.0.539；已有工作室工程实装4.0.537。工程本地技能入口标4.0.538。以运行工程实际包和类型为准，不能用较新的文档替代兼容验证。

当前只读核验：remotion、media、captions、media-utils为4.0.537，three0.170.0，TypeScript5.9.3；未找到layout-utils、transitions、@remotion/three、@react-three/fiber。CanvasImage、Interactive和Easing.spring在本地声明中确实存在。版本信息是2026-10-30核验，不保证未来自动成立。

## 接入步骤

1. 在目标工程读package.json及锁文件，再查实际node_modules。只选择已安装且接口匹配的实现；缺依赖列明，安装需有当前授权。
2. 按下方实际目录路由读对应版本remotion-best-practices；不整套逐次加载。DSH包装与官方重复部分合并理解，包装层不能冒充新能力。
3. registerRoot→Composition定义fps/尺寸/duration；场景Sequence传明确from和durationInFrames。局部frame与全局frame分清；重叠转场改变总长，勿直接求各段总和。
4. 资源从staticFile相对public读取，图像/字体失败报错，delayRender句柄只完成一次。未知设备上先验证依赖，再做当前授权阶段的产物。
5. 媒体用实际版本支持的Video/Audio API；不要从旧教程直接替换OffthreadVideo，或把新media接口硬套旧工程。

## 特别接口

图片crop边为0..1，左右和/上下和均<1；不可与不兼容clipPath叠用。fitText/measureText需要真实字体加载及相同排版参数；layout-utils当前缺失，可用Canvas测量的显式方案，不偷称已用库。

字幕对象一般包含text、startMs、endMs、timestampMs/null、confidence/null等；以本地类型为准。ASR是候选，中文断句/专名/尾音要校对。没有音频时只能计划时间，不能伪造精确字级对齐。

3D组件需ThreeCanvas/R3F等包。specimen/craft的TS语法检查不代表这些运行依赖已满足。环境资源RoomEnvironment.dispose在本机three源码中存在；PMREM target、texture、geometry仍需按生命周期清理。

本包不附完整官方技能文本：该快照未发现明确根许可，保留原位路由和独立写的接口说明。安装、Studio、预览、渲染均由当前任务phase与授权控制；本轮没有执行。

## 从任务卡到场景

使用 [remotion-kit](../implementations/remotion-kit/README.md)：把分镜转为scenes/events绝对秒表，模板已用start/end/at；旧卡的at_seconds等显式映射。没有实际音轨保持planned。calculateMetadata从场景末端与应保留音尾计算duration。SceneStack支持两场重叠与统一presentation接口，不依赖未安装的transitions包。

场内顺序为背景、中景/主体、世界文字、前景；屏幕字幕和固定说明放根层，声音独立分轨。每层写空间归属，世界相机不带走字幕。对象共用eventAt('E_CONTACT')控制接触、形变与音效；不各自猜起点。Sequence局部frame加绝对from一次得到全局。

音轨选定后按hash、真实采样数与已听/测的乐句、强拍、词锚形成measured事件；替换、裁切、变速使相关事件失效。只对allow_snap事件按容差吸附，保留自然口播气口。AudioTracks用已有文件与voiceWindows平滑duck，sfxTrack用感知峰值偏移反推开始。音频trim是源文件起点，start是时间轴位置。

字幕cue显式一/两行，毫秒转秒；ASR是候选，专名、否定词、尾音需校对。没有音频时不声称精确字级同步。字体加载完再测量或采样字形，失败报错；measureCN只测布局，仍需核真实字形覆盖。

## 阶段与路线

card写分镜/四案/缺项，不生成媒体。still仅在授权时通过目标工程已有renderStill流程出指定时刻，不能证明连续运动/声音。audition在授权下本机生成音乐供作者选择。final按实测声音落实，并在授权范围观看聆听返修。phase是范围记录，不是命令执行沙箱。

Remotion适合React分层、明确帧与音轨。Canvas适合大量粒子/线条，按canvas-contract固定画幅、显式时间、异步资源就绪。HTML/GSAP适合已有DOM时间轴，但必须停在可seek时刻、禁止依赖真实时钟累计；参考Hyperframes时不能混用轨道与CSS z-index。路线由现有工程和效果需要决定，不因参考仓库用了某库就安装。

## 目标工程里的 Remotion 规则

若目标工程自带 Remotion 规则或技能目录（常见位置如 `.claude/skills/remotion-best-practices/`），按工程实际相对位置读取，先看版本声明；没有就跳过，不自动下载或安装。目录存在不代表语义全读。下表是这类规则常见的子文件划分，用来定位该读哪一类：

| 需求 | 相对位置 |
|---|---|
| Composition/参数时长 | remotion-markup/compositions.md、calculate-metadata.md、parameters.md |
| 秒帧/场景重叠 | remotion-markup/timing.md、timing-props.md、sequencing.md、multi-scene-video.md、transitions.md |
| 字体/测量/图片 | remotion-markup/local-fonts.md、measuring-text.md、images.md、cropping.md |
| 音频/音效/口播 | remotion-markup/audio.md、sfx.md、voiceover.md |
| 字幕导入/显示 | remotion-captions/REFERENCE.md、import-srt-captions.md、display-captions.md；转录另读transcribe-captions.md |
| 媒体时长/尺寸 | remotion-multimedia/get-audio-duration.md、get-video-duration.md、get-video-dimensions.md |
| 3D/Canvas/模糊 | remotion-markup/3d.md、html-in-canvas.md、motion-blur.md |
| 地图 | remotion-maps/techniques/static-map/TECHNIQUE.md；需要地图引擎再读maplibre/TECHNIQUE.md |
| 授权渲染/Studio | remotion-render/REFERENCE.md、remotion-studio/REFERENCE.md |
