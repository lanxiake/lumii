import React from 'react';
import {AbsoluteFill,Composition,registerRoot,type CalculateMetadataFunction} from 'remotion';
import {SceneStack} from './SceneStack';
import {frameAt} from './time';
import {taskDuration,type Task} from './timeline';
type Props={task:Task};
// Wiring example only. Replace the scene renderer with the actual designed components.
const example:Task={phase:'card',fps:30,width:1920,height:1080,scenes:[{id:'S01',start:0,end:4},{id:'S02',start:3.5,end:8}],events:[]};
const Film:React.FC<Props>=({task})=><SceneStack scenes={task.scenes} fps={task.fps} renderScene={s=><AbsoluteFill style={{background:s.id==='S01'?'#202f3c':'#443a30',justifyContent:'center',alignItems:'center',color:'white',fontSize:72}}>{s.id}</AbsoluteFill>}/>;
const metadata:CalculateMetadataFunction<Props>=({props})=>({fps:props.task.fps,width:props.task.width,height:props.task.height,durationInFrames:Math.max(1,frameAt(taskDuration(props.task),props.task.fps))});
export const Root=()=> <Composition id="Film" component={Film} defaultProps={{task:example}} fps={30} width={1920} height={1080} durationInFrames={240} calculateMetadata={metadata}/>;
// This file is an opt-in entrypoint; do not import it from library components.
registerRoot(Root);
