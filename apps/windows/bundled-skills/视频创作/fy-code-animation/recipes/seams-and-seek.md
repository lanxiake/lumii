# 接缝、速度与可回放时间接口

接缝参考来源：Copyright 2026 HeyGen, Inc.，Apache-2.0。修改说明：重新组织说明与代码变量，纠正总时长、速度匹配和平均速度，补充确定性时间接口；许可见 [Apache 2.0](../LICENSES/HeyGen-Apache-2.0.txt)。

输入：前后场的共同对象、切点 C（秒）、世界/屏幕坐标、行程 d、过渡时间 T、可读区间。输出：每层的位置与透明度函数、挂载覆盖表、切点两侧速度、随机 seek 检查点。这里提供实现方法；尚未生成或观看媒体。

## 1. 在运动中切换对象

同方向离场与入场可以在切点保持速度。以向左、幂次 n 的一对曲线为例：

```js
// clamp 限制到 [0,1]；离场 t∈[C-Tout,C]，入场 t∈[C,C+Tin]
const exitX = (t) => -dout * Math.pow(clamp((t-C+Tout)/Tout), n);
const enterX = (t) => din * Math.pow(1-clamp((t-C)/Tin), n);
// 两侧导数：-n*dout/Tout 与 -n*din/Tin
// 同 n 时，连续速度要求 dout/Tout === din/Tin。
```

对象换了，位置可以通过匹配构图接管；这里的“速度连续”不代表两个不同对象的世界坐标也连续。用屏幕上的重心、文字基线或图形边界说明接管对象。若幂次不同，则比较 nout×dout/Tout 与 nin×din/Tin。GSAP 的 power4 是五次幂；不能按四次幂算速度。

1920 宽画幅可从行程 230 px、两侧各 0.33 s、幂次 5 起步，切点速度约 −3485 px/s。把入场改成 0.42 s 而行程不变，速度约 −2738 px/s；这已经不是严格匹配。修法有三种：把入场行程调成 292.73 px；保持 0.33 s；或明确允许速度变化，并实际看过接缝。固定 230 px 不适合所有尺寸，先按画幅比例换算再检查主体大小。

## 2. GSAP 包装层的确定性约定

```js
// 项目已有 GSAP 时使用；这里不安装、不启动预览。
const tl = gsap.timeline({paused: true});
gsap.set(oldWrap, {x: 0, opacity: 1});
gsap.set(newWrap, {x: din, opacity: 0});
tl.to(oldWrap, {x: -dout, duration: Tout, ease: 'power4.in'}, C-Tout);
tl.set(oldWrap, {opacity: 0}, C);
tl.set(newWrap, {opacity: 1}, C);
tl.fromTo(newWrap, {x: din},
  {x: 0, duration: Tin, ease: 'power4.out', immediateRender: false}, C);
const seek = (seconds) => tl.seek(seconds, true); // 抑制回调；状态由时间线本身表达
```

初始化在创建时间线时做一次，不能在每次 seek 先把已缓存的 tween 起点偷偷改掉。负时间区间要移入上一场或整体平移到非负时间。交互点击、声音播放和网络加载不能藏在需要被 seek 跳过的回调里。HTML 渲染前由统一 ready 等待字体、图像、贴图；失败必须给出错误。回放测试顺序 0→末→中→0→中，检查相同时间的属性及画面，而不只检查时间线数值。

## 3. 缩放穿越、瀑布与轻推分别处理

**缩放穿越**：文字离场可试 1→1.2、0.2 s，切入 0.75，再用 0.5 s 收到 1。总占用 0.7 s，不能写成 0.4 s。模糊 10 px 是文本示例参数，只有字已读完才适合；字幕/证据不必模糊。缩放方向表达深入或拉远，前后不能无意反向。以 log(scale) 的导数检查相对缩放速度，单看 scale 差值不够。

**瀑布进入**：第 i 个元素开始于 sᵢ，时长 Tᵢ，相邻间隔由 sᵢ₊₁=sᵢ+Tᵢ−overlapFrames/fps 定义；overlap 为负就是停顿。全组结束取 max(sᵢ+Tᵢ)，然后另算稳定阅读区间。若间隔为 g×rⁱ，累计开始偏移为 g(1−rⁱ)/(1−r)，r=1 用 i×g。不要把错峰的整组尾巴切在统一 C 上；需要逐元素切点或等最后一个离场后切层。中文按语义词组或整行分组，标点跟随其语义单位。

**轻推后拖尾**：原示例 270 px/0.57 s，前段 30 px/0.12 s、中段 180 px/0.10 s、末段 60 px/0.35 s。中段 1800 px/s，是平均约 474 px/s 的 3.8 倍；它不是“约两倍”。分段 easing 可能在接点产生速度跳变。需要顺滑时用 Hermite：位置端点 p0,p1 与已定速度 v0,v1，x(u)=(2u³−3u²+1)p0+(u³−2u²+u)T v0+(−2u³+3u²)p1+(u³−u²)T v1。相邻段共享同一个接点速度，另检过冲与停靠。

## 4. Canvas 接口与字体缓存

参考 [Canvas 时间适配器](../implementations/canvas-contract.mjs) 提供 duration、ready、error、seek。由调用者传绘图函数和资源 Promise；适配器不会创建播放器、请求字体、加载声音或开始 RAF。seek 每次清画布并还原上下文，绘图函数不得依赖上一帧。

逻辑坐标 W×H 与实际像素 W×H×SS² 分开；SS=2 会使像素数四倍。ctx.setTransform(SS,0,0,SS,0,0) 缩放几何，shadowBlur/shadowOffset 与 filter 内 px 需按实际绘制策略另核，不能误以为 transform 自动覆盖一切。离屏文本缓存键至少含文本、字体文件版本、字号、行宽、字距、方向和 SS。字体就绪后才测量；中文不能用 split(' ') 换行，按模块里的语义切分和实测宽度处理。完整汉字轮廓不等于笔画顺序。

## 5. 返修与证据

为每个接缝记 C±4/fps、C、运动峰值和结果稳态；检查底层漏黑、内容跳位、速度反向、透明度误叠、字幕阅读被吃掉。相同数值曲线不保证纹理和光照一致。机器验证导数/时间和边界；真实观看确认感知连续；作者决定是否采用。

来源判断：原位置（不在本包内）Hyperframes 仓的 `cut-the-curve` 技能与 `gsap-implementation.md` 示例的机制经重新推导；原文中不成立的速度匹配、总时长和平均速度描述不沿用。Opus `assets/film-template.html` 的 seek/ready/缓存契约用于接口比较；未复制其英文换行、Google Fonts、audio.js、自动播放器或固定调色示例。
