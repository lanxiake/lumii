import React from 'react';
import {AbsoluteFill} from 'remotion';
import {keyedRandom} from '../motion-core.mjs';
import {clamp01,positive,smooth,unit} from '../remotion-kit/time';
export type Presentation=(progress:number)=>{outStyle:React.CSSProperties;inStyle:React.CSSProperties};
// Incoming is composited OVER an opaque outgoing scene. Fading both to .5 leaks ground.
export const crossfade:Presentation=p=>({outStyle:{opacity:1},inStyle:{opacity:clamp01(p)}});
export const fadeThrough:Presentation=p=>({outStyle:{opacity:1-clamp01(p*2)},inStyle:{opacity:clamp01(p*2-1)}});
export function directionalWipe(direction:'left'|'right'|'up'|'down'='left',softness=.08):Presentation{
  if(softness<0||softness>.5)throw new Error('softness must be 0..0.5');
  return raw=>{
    const p=clamp01(raw);if(p===0)return {outStyle:{},inStyle:{opacity:0}};if(p===1)return {outStyle:{},inStyle:{}};
    const axis={left:'to left',right:'to right',up:'to top',down:'to bottom'}[direction];
    const edge=p*(1+2*softness)-softness;
    const mask=`linear-gradient(${axis},#000 ${(edge-softness)*100}%,transparent ${(edge+softness)*100}%)`;
    return {outStyle:{},inStyle:{maskImage:mask,WebkitMaskImage:mask}};
  };
}
export function iris(width:number,height:number,center:[number,number]=[.5,.5]):Presentation{
  positive(width);positive(height);const [x,y]=[center[0]*width,center[1]*height];
  const radius=Math.max(...[[0,0],[width,0],[0,height],[width,height]].map(([a,b])=>Math.hypot(a-x,b-y)))+1;
  return raw=>{const p=clamp01(raw);return {outStyle:{},inStyle:p===0?{opacity:0}:p===1?{}:{clipPath:`circle(${radius*p}px at ${x}px ${y}px)`}};};
}
export function push(direction:'left'|'right'|'up'|'down'='left',moveOutgoing=true):Presentation{
  const [x,y]=({left:[-1,0],right:[1,0],up:[0,-1],down:[0,1]})[direction];
  return raw=>{const p=smooth(raw);return {outStyle:{transform:moveOutgoing?`translate(${x*p*100}%,${y*p*100}%)`:undefined},inStyle:{transform:`translate(${-x*(1-p)*100}%,${-y*(1-p)*100}%)`}};};
}
export function sharedAxis(axis:'x'|'y'|'z'='y',distance=80):Presentation{
  return raw=>{const p=smooth(raw),a=axis==='z'?`scale(${1+.12*p})`:`translate${axis.toUpperCase()}(${-distance*p}px)`,b=axis==='z'?`scale(${.88+.12*p})`:`translate${axis.toUpperCase()}(${distance*(1-p)}px)`;
    return {outStyle:{transform:a,opacity:1-p},inStyle:{transform:b,opacity:p}};};
}
export function zoomThrough(origin='50% 50%',factor=3):Presentation{
  positive(factor);return raw=>{const p=smooth(raw);return {outStyle:{transformOrigin:origin,transform:`scale(${Math.exp(Math.log(factor)*p)})`,opacity:1-clamp01(p*2)},inStyle:{transformOrigin:origin,transform:`scale(${Math.exp(Math.log(1/factor)*(1-p))})`,opacity:clamp01(p*2-1)}};};
}
export function pageFlip(perspective=1400):Presentation{
  positive(perspective);return raw=>{const p=smooth(raw),common:React.CSSProperties={transformOrigin:'50% 50%',backfaceVisibility:'hidden'};
    return {outStyle:{...common,transform:`perspective(${perspective}px) rotateY(${-180*p}deg)`},inStyle:{...common,transform:`perspective(${perspective}px) rotateY(${180*(1-p)}deg)`}};};
}
/** SVG mask is generated deterministically; no duplicate scene DOM per cell. */
export function gridMask(columns=12,rows=7,seed='grid',order:'random'|'diagonal'|'columns'='diagonal'):Presentation{
  if(!Number.isInteger(columns)||!Number.isInteger(rows)||columns<1||rows<1||columns*rows>4096)throw new Error('grid dimensions must total <=4096');
  const count=columns*rows;
  const cells=Array.from({length:count},(_,id)=>({id,x:id%columns,y:Math.floor(id/columns)}));
  const rank=[...cells].sort((a,b)=>{
    const score=(c:typeof a)=>order==='random'?keyedRandom(seed,c.id):order==='columns'?c.x:(c.x+c.y);
    return score(a)-score(b)||a.id-b.id;
  });
  return raw=>{const p=clamp01(raw);if(p===0)return {outStyle:{},inStyle:{opacity:0}};if(p===1)return {outStyle:{},inStyle:{}};
    const n=Math.floor(p*count),rects=rank.slice(0,n).map(c=>`<rect x="${c.x}" y="${c.y}" width="1.002" height="1.002" fill="white"/>`).join('');
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${columns} ${rows}" preserveAspectRatio="none">${rects}</svg>`;
    const mask=`url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    return {outStyle:{},inStyle:{maskImage:mask,WebkitMaskImage:mask,maskSize:'100% 100%',WebkitMaskSize:'100% 100%'}};
  };
}
export function whipPan(width:number,direction:1|-1=-1,maxBlur=16):Presentation{
  positive(width);return raw=>{const p=clamp01(raw),blur=Math.sin(Math.PI*p)*Math.max(0,maxBlur);
    const travel=smooth(p);
    return {outStyle:{transform:`translateX(${direction*width*travel}px)`,filter:`blur(${blur}px)`},inStyle:{transform:`translateX(${-direction*width*(1-travel)}px)`,filter:`blur(${blur}px)`}};};
}
export function matchAnchor(source:[number,number],target:[number,number],scale=1,rotation=0){
  positive(scale);const [x,y]=source,c=Math.cos(rotation),s=Math.sin(rotation);
  return {translate:[target[0]-scale*(c*x-s*y),target[1]-scale*(s*x+c*y)] as [number,number],scale,rotation};
}
export const TransitionOverlap:React.FC<{t:number;start:number;end:number;outgoing:React.ReactNode;incoming:React.ReactNode;presentation?:Presentation;background?:string}>=({t,start,end,outgoing,incoming,presentation=crossfade,background='#111'})=>{
  const {outStyle,inStyle}=presentation(unit(t,start,end));
  return <AbsoluteFill style={{background,overflow:'hidden'}}><AbsoluteFill style={outStyle}>{outgoing}</AbsoluteFill><AbsoluteFill style={inStyle}>{incoming}</AbsoluteFill></AbsoluteFill>;
};
/** A full-height opaque block is wider than the viewport and completely covers the cut. */
export const OccluderCut:React.FC<{progress:number;outgoing:React.ReactNode;incoming:React.ReactNode;color:string;width?:number}>=({progress,outgoing,incoming,color,width=1.3})=>{
  if(width<1)throw new Error('occluder must cover the viewport at cut');const p=clamp01(progress),x=-width+(1+width)*p;
  return <AbsoluteFill style={{overflow:'hidden'}}>{p<.5?outgoing:incoming}<AbsoluteFill style={{background:color,width:`${width*100}%`,left:`${x*100}%`}}/></AbsoluteFill>;
};
