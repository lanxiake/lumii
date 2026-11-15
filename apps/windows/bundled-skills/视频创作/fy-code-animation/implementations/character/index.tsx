import React from 'react';
import {keyedRandom,springAt,steppedTime} from '../motion-core.mjs';
import {clamp01,positive,smooth,unit} from '../remotion-kit/time';
export type RigPart={id:string;parent?:string;offset:[number,number];pivot?:[number,number];angle?:(t:number)=>number;drawing:React.ReactNode};
/** SVG local coordinates; angles in radians. Pass SVG paths/groups as drawing. */
export const Rig2D:React.FC<{t:number;parts:RigPart[];width:number;height:number;origin?:[number,number]}>=({t,parts,width,height,origin=[0,0]})=>{
  const map=new Map(parts.map(p=>[p.id,p]));if(map.size!==parts.length)throw new Error('duplicate rig part');
  for(const part of parts){const seen=new Set<string>();let p:RigPart|undefined=part;while(p){if(seen.has(p.id))throw new Error('cyclic rig');seen.add(p.id);if(p.parent&&!map.has(p.parent))throw new Error('missing parent '+p.parent);p=p.parent?map.get(p.parent):undefined;}}
  const render=(p:RigPart):React.ReactNode=><g key={p.id} transform={`translate(${p.offset.join(' ')}) rotate(${(p.angle?.(t)??0)*180/Math.PI} ${(p.pivot??[0,0]).join(' ')})`}>{p.drawing}{parts.filter(c=>c.parent===p.id).map(render)}</g>;
  return <svg width={width} height={height}><g transform={`translate(${origin.join(' ')})`}>{parts.filter(p=>!p.parent).map(render)}</g></svg>;
};
export type PoseKey={at:number;values:Record<string,number>;mode?:'hold'|'linear'|'ease'};
export function poseTimeline(keys:PoseKey[],drawingsPerSecond?:number){
  if(!keys.length)throw new Error('empty poses');const fields=Object.keys(keys[0].values);
  keys.forEach((key,i)=>{if(i&&key.at<=keys[i-1].at)throw new Error('pose times must increase');if(Object.keys(key.values).length!==fields.length||fields.some(f=>!Number.isFinite(key.values[f])))throw new Error('pose fields must match');});
  return (time:number)=>{const t=drawingsPerSecond?steppedTime(time,drawingsPerSecond):time;
    if(t<=keys[0].at)return {...keys[0].values};if(t>=keys[keys.length-1].at)return {...keys[keys.length-1].values};
    const b=keys.findIndex(k=>k.at>t),a=keys[b-1],z=keys[b],raw=unit(t,a.at,z.at),p=a.mode==='hold'?0:a.mode==='linear'?raw:smooth(raw);
    return Object.fromEntries(fields.map(f=>[f,a.values[f]+(z.values[f]-a.values[f])*p]));
  };
}
export function blinkAt(t:number,seed='blink',interval=4,duration=.14){
  positive(interval);positive(duration);if(duration*3>=interval)throw new Error('blink duration exceeds interval');
  const bucket=Math.floor(t/interval),start=bucket*interval+.2+(interval-duration*3-.2)*keyedRandom(seed,bucket);
  const blink=(a:number)=>{const p=(t-a)/duration;return p<0||p>1?1:1-Math.sin(Math.PI*p)**2;};
  return Math.min(blink(start),keyedRandom(seed,`${bucket}:double`)>.88?blink(start+duration*1.5):1);
}
export const Blink:React.FC<{t:number;seed?:string;children:React.ReactNode;origin?:string}>=({t,seed='blink',children,origin='50% 50%'})=><g style={{transformBox:'fill-box',transformOrigin:origin,transform:`scaleY(${Math.max(.03,blinkAt(t,seed))})`}}>{children}</g>;
export function lookAt(eye:[number,number],target:[number,number],radiusX=4,radiusY=3):[number,number]{
  positive(radiusX);positive(radiusY);const dx=target[0]-eye[0],dy=target[1]-eye[1],length=Math.hypot(dx,dy);return length<1e-6?[0,0]:[dx/length*radiusX,dy/length*radiusY];
}
export const LookAt:React.FC<{eye:[number,number];target:[number,number];radius?:number;color?:string}>=({eye,target,radius=3,color='#111'})=>{const [x,y]=lookAt(eye,target);return <circle cx={eye[0]+x} cy={eye[1]+y} r={radius} fill={color}/>;};
export function walkPose(t:number,{speed=110,period=.8,ground=600,lift=36,stance=.6}={}){
  positive(period);if(speed<0||stance<=0||stance>=1)throw new Error('invalid gait');const stride=speed*period,bodyX=t*speed;
  const foot=(offset:number)=>{const phase=t/period+offset,cycle=Math.floor(phase),p=phase-cycle,contact=p<stance,u=clamp01((p-stance)/(1-stance));return {x:(cycle-offset)*stride+(contact?0:stride*smooth(u)),y:ground-(contact?0:lift*Math.sin(Math.PI*u)),contact,phase:p};};
  return {bodyX,bob:Math.sin(t/period*Math.PI*4)*6,left:foot(0),right:foot(.5)};
}
function knee(hip:[number,number],foot:[number,number],upper:number,lower:number):[number,number]{
  positive(upper);positive(lower);const dx=foot[0]-hip[0],dy=foot[1]-hip[1],d=Math.hypot(dx,dy);
  if(d>upper+lower||d<Math.abs(upper-lower)||d<1e-6)throw new Error('unreachable foot: shorten stride or lower hip');
  const a=(upper*upper-lower*lower+d*d)/(2*d),h=Math.sqrt(Math.max(0,upper*upper-a*a));return [hip[0]+dx/d*a+dy/d*h,hip[1]+dy/d*a-dx/d*h];
}
export const WalkCycle:React.FC<{t:number;originX?:number;ground?:number;speed?:number;period?:number;legLength?:number;color?:string}>=({t,originX=0,ground=600,speed=110,period=.8,legLength=160,color='#6fa6b6'})=>{
  const pose=walkPose(t,{speed,period,ground}),hip:[number,number]=[originX+pose.bodyX,ground-legLength*.78+pose.bob];
  return <g>{[pose.right,pose.left].map((f,i)=>{const foot:[number,number]=[originX+f.x,f.y],k=knee(hip,foot,legLength/2,legLength/2);return <polyline key={i} points={[hip,k,foot].map(p=>p.join(',')).join(' ')} fill="none" stroke={color} strokeWidth={i?12:9} opacity={i?1:.65} strokeLinecap="round"/>;})}<rect x={hip[0]-24} y={hip[1]-90} width={48} height={90} rx={18} fill={color}/><circle cx={hip[0]} cy={hip[1]-112} r={25} fill={color}/></g>;
};
export function pendulum(t:number,{length=1,gravity=9.81,amplitude=.25,damping=.3,phase=0}={}){positive(length);if(gravity<0||damping<0)throw new Error('invalid pendulum parameters');return amplitude*Math.exp(-damping*Math.max(0,t))*Math.cos(Math.sqrt(gravity/length)*Math.max(0,t)+phase);}
/** Ballistic arc reaches the target exactly, then a continuous damped displacement settles. */
export function throwSnap(t:number,from:[number,number],to:[number,number],{start=0,flight=.7,height=100,ring=0}={}){
  positive(flight);const p=clamp01((t-start)/flight),x=from[0]+(to[0]-from[0])*p,y=from[1]+(to[1]-from[1])*p-4*height*p*(1-p),elapsed=t-start-flight;
  return [x,y+(elapsed>0?ring*(springAt(elapsed,{stiffness:180,damping:16})-1)*smooth(elapsed/.04):0)] as [number,number];
}
export const Pendulum=pendulum;
export const ThrowSnap=throwSnap;
