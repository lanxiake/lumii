# 相机与空间

独立编写；React/Remotion + 相对引用 `motion-core.mjs`，无新增3D依赖。目标4.0.537，未运行。完整语法见 `index.tsx`，方法见 [camera-moves](../../recipes/camera-moves.md)。

`CameraState={center:[x,y],zoom,rotation,tiltX?,tiltY?}`：坐标px、角度rad、zoom>0。`CameraRig` 接收 t秒、camera(t)、width/height、children世界层、screen屏幕层、perspective像素。screen放字幕/固定HUD；不要再把同一相机变换施加到children。

```tsx
const camera=cameraPath([
 {at:0,center:[960,540],zoom:1,rotation:0,stop:true},
 {at:2,center:[1200,500],zoom:1.15,rotation:0,stop:true},
 {at:4,center:[1200,500],zoom:1.15,rotation:0,stop:true},
]);
<CameraRig t={t} camera={camera} width={1920} height={1080} screen={<Subtitles/>}>
  <World/>
</CameraRig>
```

`cameraPath` 对center/rotation/tilt做共享切线Hermite，对zoom先log再插值。中间stop=true为零速度；停留段两端相同姿态且stop=true。Hermite可能过冲，不提供自动障碍/构图约束；角度要预先unwrap，避免179°到−179°绕远路。

`ParallaxLayer` 接收camera、depth≥0、画幅；depth=0固定、1跟主相机、远层可.2。它自行变换，别套在已同样移动的CameraRig里；仅近似2.5D，不解真实深度遮挡。`RackFocus({focus,depth,maxBlur,breathing})` 以归一化深度差控制CSS blur和轻缩放，非光学景深。

`shake(t,{start,duration,amplitude,frequency,seed})` 返回[x,y]像素扰动；frequency是噪声采样频率Hz，不是帧率，包络起止为0。`dollyZoomFov(distance,referenceDistance,referenceFovRadians)` 返回rad，距离单位须一致；实际3D相机在调用方更新。`orbit` 返回平面x/y和heading rad。`camera2D`/`cameraCenterForAnchor`复用核心，不重写坐标约定。

CSS perspective带tilt时，2D锚点反解不再是完整3D投影求逆；精确空间锁定请使用真实3D投影。镜头移动、读窗、保护区都要写进分镜，不能以组件存在代替构图判断。
