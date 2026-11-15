# 标本册引擎 · 完整选定子模块

已保留draw方法、主题、绘制容器、BounceGraph、GlyphAnatomy、StrokeDraw、CubeStage（含 rubik 子块状态）、VolumeScene、ParticleField等实现；MIT见 [许可](../../LICENSES/renoise-MIT.txt)。未带YouWare/Renoise品牌标志、字体、音乐或演示成片。

## 接口与参数

- `SpecimenCanvas`承载`draw(ctx,t,theme)`，绘制以1920×1080参考坐标组织；具体尺寸参数读源码。大图到网格/立方面裁切时不能剪掉必要文字。
- `specimens.ts`包含网点48×27、48山脊线、Truchet120px格、200采样弦线、6行168px走马灯等完整画法；数字是来源样例参数。走马灯6.5px/frame按原30fps参考，换fps需转换。
- `BounceGraph`根据contacts/height画弹跳与冲击图，接触序列必须递增；约1.3帧冲击核来自样例。不得把装饰波形称真实音频。
- `GlyphAnatomy`依赖glyph_outline.py输出，处理字形轮廓/手柄/测量。修了重复clip ID与零长度归一化。
- `StrokeDraw`按路径长度绘制，已移除特定品牌路径常量；调用者提供自己的d与相应许可。
- `CubeStage` 的 rubik 子块状态让同一 draw 投到面/子块，检查面朝向、镜像、边缘裁切和连续扭转；各次扭转不能无意重叠。
- `VolumeScene`24×24实例体素，wave单位帧，drop/sink/field/flat/rise/wire/dark等0..1，detail控制多面体细分、amp控制噪声，cam含ang/dist/height/target。detail高值进入平滑体时不再创建无用高细分lowGeo；几何/PMREM生命周期已加清理。
- `ParticleField`默认60000个GPU点，sphere/galaxy/text/image/line等stage插值；count不是通用推荐。加载图片取alpha>140步长2px，空点/图片失败报错，增加 CORS；delayRender 现在成功 continue、失败或卸载 cancel 恰好一次；颜色空数组回退cream；修反向smoothstep。着色器噪声不是严格curl场，不承诺不可压缩流体。

## 依赖与局限

React、remotion、three、@react-three/fiber、@remotion/three；部分组件还用@remotion/paths。本机缺R3F和@remotion/three，未运行WebGL。应按目标包版本做types/build后再验证帧。不要直接import index强制拉入所有3D依赖，纯Canvas只引所需文件。

主题luma是加权sRGB近似，不是线性化WCAG对比；timecode是整数fps普通显示，不是drop-frame。drawVoice是示意。移植时字体须先加载再采样，图像/字体/分辨率变化使缓存失效。

## 来源案例与返修

style-pack-03的概念阶梯用于点→线→面→体→场，每章绑定人的价值。Film60/YouWareChain源码显示了由通用字形/引语到产品细节变形链的迭代；源用户反感突兀AI人物、密集鼓点，这是那个项目反馈，不能冒充当前作者偏好。

复核路径：单个draw→放入全屏→网格→立方面→魔方→体素/粒子交接；分别检查尺寸、纹理方向、接触帧和明暗接缝。原作者已验证不等于本次修补版通过。当前仅静态/数值/语法证据，实际渲染与审美采用待后续授权阶段验证。
