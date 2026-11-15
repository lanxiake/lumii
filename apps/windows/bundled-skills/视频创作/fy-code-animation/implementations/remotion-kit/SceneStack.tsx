import React from 'react';
import {AbsoluteFill,Sequence} from 'remotion';
import {Scene} from './Scene';
import {layoutScenes,type SceneSpec} from './timeline';
import {crossfade,type Presentation} from '../transitions';
export const SceneStack:React.FC<{scenes:SceneSpec[];fps:number;renderScene:(scene:SceneSpec)=>React.ReactNode;presentations?:Record<string,Presentation>;background?:string}>=({scenes,fps,renderScene,presentations={},background='#111'})=>{
  const rows=layoutScenes(scenes,fps);
  // Frame-quantized overlap uses the SAME boundaries as Sequence mounting.
  const boundaries=rows.slice(1).map((s,i)=>s.from<rows[i].to?{start:s.from/fps,end:rows[i].to/fps,presentation:presentations[`${rows[i].id}->${s.id}`]??crossfade}:undefined);
  return <AbsoluteFill style={{background,overflow:'hidden'}}>{rows.map((s,i)=><Sequence key={s.id} from={s.from} durationInFrames={s.durationInFrames} name={s.id}><Scene fromFrame={s.from} incoming={boundaries[i-1]} outgoing={boundaries[i]}>{renderScene(s)}</Scene></Sequence>)}</AbsoluteFill>;
};
