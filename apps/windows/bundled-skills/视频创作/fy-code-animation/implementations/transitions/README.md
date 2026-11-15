# 转场实现

本目录为本次独立编写的候选源码。依赖 React、Remotion；不依赖 `@remotion/transitions`。目标本机版本4.0.537，仅核读声明，未编译/运行/渲染。方法见 [transitions](../../recipes/transitions.md)。

`Presentation = (progress:0..1) => {outStyle,inStyle}`。样式各施加在一层全画幅包装上，incoming在outgoing之上，根层必须不透明。场景内部的相机/对象transform使用更内层，避免互相覆盖。

| 导出 | 参数/单位 | 机制与限制 |
|---|---|---|
| crossfade / fadeThrough | p | 前者旧场不透明、新场渐显；后者经根底色，需要明确底色 |
| directionalWipe | direction、softness=0.08（轴长比例） | CSS mask软边；方向表示渐变朝向，视觉方向按所选内容确认 |
| iris | width/height px、center归一化 | 圆半径覆盖最远角 |
| push | direction、moveOutgoing | 位移百分比；false时旧场固定 |
| sharedAxis | x/y/z、distance px | 平移或缩放并淡入淡出，有意露根底色 |
| zoomThrough | origin CSS、factor | 对数缩放，光学接力，不是真空间穿越 |
| pageFlip | perspective px | 单面CSS3D、背面隐藏；90°附近依赖根底色，不模拟弯纸 |
| gridMask | columns/rows/seed/order | SVG mask不复制整场；不是像素滤镜 |
| whipPan | width px、direction ±1、maxBlur px | 相邻整场同向移动+CSS各向同性blur；非真实方向模糊 |
| matchAnchor | source/target px、scale、rotation rad | 返回translate/scale/rotation，transformOrigin须0 0 |
| OccluderCut | progress、outgoing/incoming、color、width以画宽计 | 整高不透明挡板，width≥1；中点切换 |

```tsx
<TransitionOverlap t={globalSeconds} start={3.5} end={4}
  outgoing={<SceneA/>} incoming={<SceneB/>}
  presentation={directionalWipe('right',.06)} background="#18232c"/>
```

`TransitionOverlap` 不改变子场时间，也不决定卸载。需在父层显式定义每场的局部时间；普通多镜使用 [SceneStack](../remotion-kit/README.md)。A4 s、B4.5 s、重叠0.5 s，总长8 s；已有绝对start/end时取max(end)，不能再次减重叠。最终帧的半开区间不会包含数学终点，frame边界需要以实际量化后为准。

所有效果只读显式progress/seed；网格seed变化代表换效果，不能每帧变。强blur/大量mask会增加成本；手机可读、GPU合成和接缝仍待目标工程实际确认。
