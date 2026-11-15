# 中文文字组件

独立编写包装与新增组件；OutlineFill/HandReveal/Decode沿用包内craft，保留其来源许可。React/Remotion，默认不下载字体。尚未编译/运行。

除了明确说明的旧craft接口，公共时间为秒，位置为px。父层先用 `useFonts` 等待真实字体；CSS由浏览器排版，手工测量用 `measureCN`，它不证明cmap或可变轴覆盖。中文始终显式语义分组，不能用split空格。

| 组件 | 主要参数 |
|---|---|
| SemanticMaskReveal | t、parts `{id,text,at,duration}[]`、family、size、gap、rise（字高比例） |
| EmphasisWord | t/at/duration、level1/2/3、accent、weight、scale默认1、shift px、underline；三级可带marker |
| WeightAxisPulse | axis、verifiedRange、from/peak、t/at/duration；调用方提供真实轴范围，值往返 |
| MarkerHighlight / StrikeReplace | t/at/duration，children或before/after；替换预留两文字宽度 |
| KaraokeCaption | t、words `{id,text,start,end}[]`、family/size、active/completed颜色；整句在场，仅改高亮 |
| ScrambleDecode | text、at秒、perCharacter秒、settle秒、alphabet、seed；内部转成旧Decode帧单位 |
| TextMorphSwap | before/after节点、t/at/duration、travel px；光学交接，非轮廓morph |
| SlamIn | t/at、startScale、overshootLimit(0…0.25)、shakePixels默认0 |
| ExtrudeText | family/size/text、depth整数0…64、direction像素向量、side；CSS影层非真实3D |

```tsx
<SemanticMaskReveal t={t} family="ProjectSans" size={72} rise={.4}
 parts={[{id:'a',text:'先看见关系',at:.2,duration:.35}]}/>
```

`ScrambleDecode` 读取最近Sequence的本地帧；其他组件多数显式t。全局事件使用前必须统一到同一局部坐标，不能一个组件传全局秒另一个用局部帧。过长parts不会自动理解语义并拆词；字幕两行限制由专用Captions处理。层级标签只是表达意图，色、重、位移、缩放都按分镜选，不自动为全部重点加冲击。

字体统一、否定范围、读窗和手法选择见 [配方](../../recipes/kinetic-type-and-emphasis.md)。旧OutlineFill/HandReveal仍使用其原有参数/帧单位，按源码接口调用，不把本目录秒制说明套过去。
