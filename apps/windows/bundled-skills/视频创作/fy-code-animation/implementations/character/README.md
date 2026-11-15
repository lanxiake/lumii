# 角色表演基础

React/Remotion环境的SVG部件与纯函数；独立编写，未运行。素材、完整角色、真实口型/跑跳控制器不包含在本目录。方法见 [character-performance](../../recipes/character-performance.md)。

`Rig2D({t,parts,width,height,origin})` 中parts为 `{id,parent?,offset:[x,y],pivot?,angle?:(t)=>rad,drawing}`。drawing需SVG节点（path/g等），不是任意HTML。部件offset相对父节点、pivot在部件局部；变换层级保持。重复id、循环parent、缺parent会报错。

```tsx
<Rig2D t={t} width={800} height={600} origin={[300,400]} parts={[
 {id:'body',offset:[0,0],drawing:<rect x={-20} y={-80} width={40} height={80}/>},
 {id:'arm',parent:'body',offset:[20,-65],angle:()=>-.3,
  drawing:<path d="M0 0 L35 40" stroke="currentColor" strokeWidth={10}/>},
]}/>
```

| API | 单位/用途 |
|---|---|
| poseTimeline(keys,drawingsPerSecond?) | keys `{at,values,mode?}`；每key字段一致。mode作用于该key到下一key，hold/linear/ease；返回f(t) |
| blinkAt / Blink | t秒、固定seed；Blink用SVG g scaleY，需置于svg内部 |
| lookAt / LookAt | eye/target在同一局部px坐标，椭圆瞳孔位移；不是世界目标自动投影 |
| walkPose | t秒，speed px/s、period s、ground/lift px、stance0…1；返回bodyX/bob与左右脚世界点 |
| WalkCycle | 必须放svg内；originX、ground、speed、period、legLength总腿长px；腿不可达时报错 |
| pendulum / Pendulum | length米、gravity m/s²、amplitude/phase rad、damping1/s；返回角度 |
| throwSnap / ThrowSnap | from/to px、start/flight秒、height/ring px；返回位置，不是React组件 |

步进采样由drawingsPerSecond决定：24fps on-twos为12，30fps每两帧为15。像素分支再统一整数坐标/nearest，手绘分支轮廓可受控换形但接触点保持。根运动和脚点不能分别随意调速；新比例需重新满足IK可达范围。抛掷吸附是闭式示意，真实接触冲量/布料/软体未实现。
