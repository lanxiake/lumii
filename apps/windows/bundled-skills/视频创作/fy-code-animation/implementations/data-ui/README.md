# 数据、UI、图片与路线

React/Remotion、`motion-core.mjs`；独立候选实现，未编译/运行/渲染。所有t/start/end为同一坐标系的秒，宽高/控制点px，progress0…1。数据必须真实或明确标“示例”。

| API | 输入与边界 |
|---|---|
| dataValue / numberText | 单一数值插值与格式化；decimals0…12、suffix、locale |
| CountUp | 接收已算好的value，不拥有第二条时间轴；tnum |
| AnimatedBars | data `{id,label,from,to,color?}[]`、progress、固定domain含0、rank、family、sourceLabel；简化标签避让会暂隐碰撞项 |
| LineReveal | points `[x,y]或null`、progress；按总弧长揭示，null保留缺口；坐标映射由调用方提供 |
| cursorPoint / Cursor | keys `{at,point,controlIn?,controlOut?}[]`、presses `{down,up}[]`；尖端hotspot为0,0；ripple可选 |
| typingTimes / TypeIn | text+at/cps/seed生成显式输入事件；TypeIn接收events，时间固定；不是语义断词/真实键录 |
| DeviceFrame | children、label必填、radius/style；只提供边框，示意UI须标明 |
| KenBurns | public相对src、真实原宽高、目标宽高、focus归一化、fromZoom/toZoom≥1、progress |
| PhotoMontage | slots `{id,start,end,file,width,height,focus,fromZoom?,toZoom?}[]`；间隙显示底色，重叠报错 |
| greatCircle / project / GeoRoute | `[纬度,经度]`度；大圆采样、等距或墨卡托；近对跖需人工途经点；只画示意路线 |

```tsx
const rows=[{id:'a',label:'示例A',from:20,to:35}];
<AnimatedBars data={rows} progress={p} width={1000} height={400}
 domain={[0,100]} family="ProjectSans" sourceLabel="教学示例，非实测"/>
```

图片使用Remotion Img等待加载，路径相对public；不可传F盘绝对路径给staticFile。焦点边缘钳位、分辨率预算和保护区需调用方设计。图表组件不是自动图形语法库：轴刻度、复杂标签布局、多个时间快照、地理底图都需具体项目补充。GeoRoute跨180°分段，不能用于边界/面积或真实行程结论。细节见 [图表地图UI](../../recipes/charts-maps-ui.md) 与 [图片](../../recipes/photo-and-montage.md)。
