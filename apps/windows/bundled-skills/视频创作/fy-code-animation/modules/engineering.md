# 实现契约与运行边界

可接入的纯时间实现见 [motion-core](../implementations/motion-core.mjs) 与 [Canvas接口](../implementations/canvas-contract.mjs)；接线与失败案例见 [接缝与seek](../recipes/seams-and-seek.md)。它们不自动生成媒体。

输入：task.json、相对素材清单、fps/画幅、风格模块、实际依赖版本。输出：模块接口、时间函数、可追溯源文件、逻辑/构建/媒体各自证据。

## 时基与确定性

- 项目时间以秒为交换单位；Remotion组件在边界frame/fps转秒，老复用组件若吃帧须在适配层显式命名frame。不把两者混用。
- 一个frame的输出由props、固定资源、seed、frame决定。禁止渲染路径中Date.now、无seed随机、累计x+=v或上一帧画布残留。复杂物理可以离线固定步长预计算，随机seek读取相同缓存。
- Sequence内部useCurrentFrame是局部帧；音乐特征/全片事件必须加回offset，禁止同一offset加两次。
- 秒区间采用半开[start,end)，重叠转场明确标注；最终duration包括尾部可见/可听内容。端点取整只在转换层一次完成。
- seek检查顺序0→末→中→0→中，比较相同时间状态；读不到Canvas像素必须报不可验证，不能把两个“unreadable”当相等。

## 三类实现路线

**纯Canvas/SVG**：适合几何、粒子、路径、像素、纸面。入口render(t)每帧重置画布和上下文，离屏缓存只缓存与t无关的形状/字体资源；随机按对象id。动画预览用RAF调用render，静态/导出入口暂停RAF。浏览器的真实时钟不能偷偷驱动子动画。

**Remotion React/Three**：见 [适配说明](../adapters/remotion.md)。非阻塞载入用delayRender，成功continueRender，失败cancelRender，清理资源；组件挂载时刻不同不能改输出。CubeStage等三维层的尺寸、贴图色空间、环境光、资源释放必须检查。TS语法通过不能证明依赖类型兼容或WebGL运行成功。

**HTML/GSAP/Hyperframes**：明确一个外部时间源。GSAP显式fromTo、paused、seek；混合CSS transform时用独立包装层。Hyperframes剪辑窗口data-start/duration为秒，track只是轨道归属，不自动等于z-index；timeline在创建完后注册，音视频由运行时控制，不在自定义回调里随意play/pause。部署/导出前再核实际版本，本包不附该运行时。

## 执行前清单

锁定工程版本、使用的包版本与API存在性；源技能标4.0.539不代表本机4.0.537全部兼容。只读package.json与类型声明确认接口，缺包列明，不自动安装。素材用相对路径；环境配置显式传root；路径不存在早报错。当前重建不运行渲染/音频/浏览器动画。

## 重复与复用

完整参考与实现以一个正本供多模块调用，避免把同一缓动和QA表抄八份。完全相同哈希保留别名映射；近似重复核变更和上下文，不能因为文件名相同就视作一致。抽取成熟模块保留许可、来源提交、修改点和必要依赖，不抽成几句口号，也不携带整仓品牌素材/缓存/凭据。

返修由具体缺陷触发：先确认是时间、布局、资源、数值、运行时还是审美。性能不足先测实例数、绘制段数、解码路数、采样数，减少不可见工作；不通过把低清/少帧结果叫“完成”。

## v2.1 深层入口

[Remotion骨架](../implementations/remotion-kit/README.md)；[接入指南](../adapters/remotion.md)。按实际问题加载；本次源码未运行。
