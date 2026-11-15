# Remotion 时间轴与分层骨架

独立编写的接入源码，目标本机Remotion4.0.537。已核读声明/相关源码，不等于编译、运行或媒体验收；本次只修改，未执行这些动作。不含运行依赖、字体、图片或音频。

## 接入

复制所需implementations及相对依赖，保持目录关系，沿用目标工程React/Remotion设置。Task含fps、width、height、phase、scenes、events、可选duration。场景 `{id,start,end}` 为绝对秒，start排序、end严格递增；最多两场重叠。根层处理字体、屏幕字幕与音轨，世界内容交给SceneStack。

```tsx
const Shot:React.FC<{scene:SceneSpec}>=({scene})=>{
 const {local,global}=useTime(frameAt(scene.start,task.fps));
 const events=eventTimeline(task.events,'planned');
 const p=events.progressBetween('E_BEGIN','E_END',global,smooth);
 return <World t={local} progress={p}/>;
};
// task、World、fontManifest、cues、tracks由实际项目提供。
const Film=()=>{
 const ready=useFonts(fontManifest);
 if(!ready)return null;
 return <>
  <SceneStack scenes={task.scenes} fps={task.fps} renderScene={scene=><Shot scene={scene}/>}/>
  <Captions cues={cues} family="ProjectSans"/>
  <AudioTracks tracks={tracks} fps={task.fps} voices={voiceWindows}/>
 </>;
};
```

renderScene回调本身不要调用Hook；返回组件，让Hook在Sequence内执行。Root.example.tsx是两块色板的接线入口，调用registerRoot有副作用，只在指定入口使用；不是已完成动画。

| 文件 | 职责 |
|---|---|
| time.ts | frameAt/secondsAt、半开区间inRange、局部全局换算、unit/smooth、frameRange、schedule、useTime |
| timeline.ts | Task/Event/SceneSpec、layoutScenes、taskDuration、eventTimeline |
| Scene.tsx | Sequence内局部帧加绝对fromFrame一次；入/出transform独立包装 |
| SceneStack.tsx | 场景绝对边界转Sequence，presentations键如S01->S02；默认crossfade及不透明底色 |
| fonts.ts | FontFace、共享promise和一次性render等待；measureCN |
| random.ts | 核心keyedRandom(seed,key)，对象id固定 |
| audio.tsx | AudioTracks、duckGain、sfxTrack；根时间轴分轨 |
| captions.tsx | Captions、cueFromCaption；显式一/两行，毫秒转秒 |
| Root.example.tsx | Composition、calculateMetadata、registerRoot接线 |

schedule([4,4.5],[.5])为8秒；已有绝对0–4、3.5–8则直接取最大end，不再减重叠。frameRange分别round(start×fps)、round(end×fps)，禁止round每段时长再累计。duration可延长保留音尾，不能截短场景。

eventTimeline(events,basis,sourceHash?)严格选择planned或measured；返回eventAt(id)、event(id)、since(id,t)、progressBetween(a,b,t,ease)。实测需要source_hash/evidence，传当前hash可拒绝旧测量。词锚需word、occurrence、source_span。不自动测量或在时间基准之间悄悄兜底。

字体清单 `{family,file,weight?,style?,stretch?}` 的file相对public；可变字体weight范围必须真实。挂载期间清单不可改，换清单用新key。共享promise等待完成才continueRender，StrictMode清理不提前释放；失败cancelRender。document.fonts和measureCN不证明cmap、真实轴或无回退。

Track `{id,file,start,end,gain,trimSeconds?,role}` 全局秒，仅根层放一次。role为voice/music/sfx/ambience。volume回调局部帧加该轨from一次算duck；trimSeconds是源文件起点，不是时间轴偏移。sfxTrack按接触−峰值偏移放置，负起点报错。总duration覆盖尾音。

CaptionCue `{id,start,end,lines:string[]}` 显式语义断行；CaptionLike兼容text/startMs/endMs/timestampMs/confidence，可选pageBreakAfter未用于自动分页。重叠cue报错，过长单行不会自动缩字。根层globalFromFrame=0；放Sequence内就传绝对from一次。

## API核读与限制（2026-10-30）

本机声明核到：AbsoluteFill、Sequence的from/durationInFrames、useCurrentFrame、useVideoConfig、Composition、CalculateMetadataFunction、registerRoot、Audio的trimBefore/volume/onError、staticFile、Img、delayRender、continueRender、cancelRender。Caption基本结构来自本地@remotion/captions/dist/caption.d.ts。FontFace是浏览器API。没有复制官方技能文字/代码。

本机remotion/media/captions/media-utils4.0.537、three0.170.0、TypeScript5.9.3。新骨架不要求media/media-utils；包存在不代表其全部API逐一核读。未找到@remotion/transitions、@remotion/three、@react-three/fiber、@remotion/layout-utils；旧specimen的额外3D依赖仍需目标工程处理。

常见错：Sequence局部帧加offset两次；spring混用秒/帧；staticFile传F盘绝对路径；字体等待失衡超时；旧OffthreadVideo与新media接口混用；Root被当普通库import。Canvas同步绘制在layout effect完成，异步资源另外等待，不能靠固定setTimeout。
