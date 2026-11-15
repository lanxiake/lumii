import React from 'react';
import {AbsoluteFill,useCurrentFrame,useVideoConfig} from 'remotion';
import type {Presentation} from '../transitions';
import {unit} from './time';
export type Boundary={start:number;end:number;presentation:Presentation};
/** Must be mounted inside the scene's Sequence. Each transform has its own wrapper. */
export const Scene:React.FC<{fromFrame:number;incoming?:Boundary;outgoing?:Boundary;children:React.ReactNode}>=({fromFrame,incoming,outgoing,children})=>{
  const frame=useCurrentFrame(),{fps}=useVideoConfig();const t=(frame+fromFrame)/fps;
  const entrance=incoming?incoming.presentation(unit(t,incoming.start,incoming.end)).inStyle:{};
  const exit=outgoing?outgoing.presentation(unit(t,outgoing.start,outgoing.end)).outStyle:{};
  return <AbsoluteFill style={exit}><AbsoluteFill style={entrance}>{children}</AbsoluteFill></AbsoluteFill>;
};
