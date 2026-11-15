import React from 'react';
import {AbsoluteFill,useCurrentFrame,useVideoConfig} from 'remotion';
export type CaptionCue={id:string;start:number;end:number;lines:string[]};
export type CaptionLike={text:string;startMs:number;endMs:number;timestampMs:number|null;confidence:number|null};
export function cueFromCaption(c:CaptionLike,id:string,lines:string[]):CaptionCue{return {id,start:c.startMs/1000,end:c.endMs/1000,lines};}
/** Explicit semantic lines; no automatic Chinese whitespace segmentation. */
export const Captions:React.FC<{cues:CaptionCue[];family:string;size?:number;globalFromFrame?:number;bottom?:number;color?:string}>=({cues,family,size=48,globalFromFrame=0,bottom=86,color='#fff'})=>{
  const f=useCurrentFrame(),{fps}=useVideoConfig(),t=(f+globalFromFrame)/fps;
  const active=cues.filter(c=>t>=c.start&&t<c.end);
  if(active.length>1)throw new Error('Overlapping caption cues: merge or resolve explicitly');
  const c=active[0];if(!c)return null;
  if(c.lines.length<1||c.lines.length>2)throw new Error('Caption requires one or two explicit lines');
  return <AbsoluteFill style={{justifyContent:'flex-end',alignItems:'center',padding:`0 5% ${bottom}px`,pointerEvents:'none'}}><div style={{maxWidth:'100%',fontFamily:family,fontSize:size,lineHeight:1.4,fontSynthesis:'none',textAlign:'center',color,background:'rgba(0,0,0,.7)',padding:'.15em .45em',boxSizing:'border-box'}}>{c.lines.map((line,i)=><div key={i} style={{whiteSpace:'pre'}}>{line}</div>)}</div></AbsoluteFill>;
};
