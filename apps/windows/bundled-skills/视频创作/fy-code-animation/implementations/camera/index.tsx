import React from 'react';
import {AbsoluteFill} from 'remotion';
import {camera2D,cameraCenterForAnchor,keyedRandom} from '../motion-core.mjs';
import {clamp01,finite,positive,smooth} from '../remotion-kit/time';
export {camera2D,cameraCenterForAnchor};
export type CameraState={center:[number,number];zoom:number;rotation:number;tiltX?:number;tiltY?:number};
export type CameraKey=CameraState & {at:number;stop?:boolean};
export const CameraRig:React.FC<{t:number;camera:(t:number)=>CameraState;width:number;height:number;children:React.ReactNode;screen?:React.ReactNode;perspective?:number}>=({t,camera,width,height,children,screen,perspective=1400})=>{
  const c=camera(t);positive(c.zoom);positive(perspective);
  return <AbsoluteFill style={{overflow:'hidden'}}><AbsoluteFill style={{perspective,transformStyle:'preserve-3d'}}><AbsoluteFill style={{transformOrigin:'0 0',transform:`translate(${width/2}px,${height/2}px) scale(${c.zoom}) rotate(${c.rotation}rad) rotateX(${c.tiltX??0}rad) rotateY(${c.tiltY??0}rad) translate(${-c.center[0]}px,${-c.center[1]}px)`}}>{children}</AbsoluteFill></AbsoluteFill><AbsoluteFill style={{pointerEvents:'none'}}>{screen}</AbsoluteFill></AbsoluteFill>;
};
const hermite=(a:number,b:number,va:number,vb:number,span:number,u:number)=>(2*u**3-3*u*u+1)*a+(u**3-2*u*u+u)*span*va+(-2*u**3+3*u*u)*b+(u**3-u*u)*span*vb;
/** Shared tangents at intermediate stations; duplicate a pose at a later time to hold. */
export function cameraPath(keys:CameraKey[]){
  if(!keys.length)throw new Error('empty camera path');
  keys.forEach((k,i)=>{finite(k.at);positive(k.zoom);[...k.center,k.rotation].forEach(n=>finite(n));if(i&&k.at<=keys[i-1].at)throw new Error('camera keys must increase');});
  const value=(k:CameraKey)=>[...k.center,Math.log(k.zoom),k.rotation,k.tiltX??0,k.tiltY??0];
  const values=keys.map(value);
  const tangents=keys.map((k,i)=>values[i].map((_,axis)=>{
    if(k.stop||i===0||i===keys.length-1)return 0;
    return (values[i+1][axis]-values[i-1][axis])/(keys[i+1].at-keys[i-1].at);
  }));
  return (t:number):CameraState=>{
    if(t<=keys[0].at)return keys[0];if(t>=keys[keys.length-1].at)return keys[keys.length-1];
    const b=keys.findIndex(k=>k.at>t),a=b-1,span=keys[b].at-keys[a].at,u=(t-keys[a].at)/span;
    const v=values[a].map((x,j)=>hermite(x,values[b][j],tangents[a][j],tangents[b][j],span,u));
    return {center:[v[0],v[1]],zoom:Math.exp(v[2]),rotation:v[3],tiltX:v[4],tiltY:v[5]};
  };
}
export const ParallaxLayer:React.FC<{camera:CameraState;depth:number;width:number;height:number;children:React.ReactNode}>=({camera,depth,width,height,children})=>{
  if(depth<0||!Number.isFinite(depth))throw new Error('depth must be non-negative');positive(camera.zoom);
  return <AbsoluteFill style={{transformOrigin:'50% 50%',transform:`translate(${(width/2-camera.center[0])*depth}px,${(height/2-camera.center[1])*depth}px) rotate(${camera.rotation*depth}rad) scale(${camera.zoom**depth})`}}>{children}</AbsoluteFill>;
};
export function shake(t:number,{start=0,duration=.5,amplitude=8,frequency=18,seed='shake'}={}){
  positive(duration);positive(frequency);const elapsed=t-start;
  if(elapsed<0||elapsed>=duration)return [0,0] as [number,number];
  const n=elapsed*frequency,i=Math.floor(n),p=smooth(n-i),envelope=smooth(elapsed/.04)*(1-elapsed/duration)**2;
  const sample=(axis:string)=>{const a=keyedRandom(seed,`${axis}:${i}`)*2-1,b=keyedRandom(seed,`${axis}:${i+1}`)*2-1;return (a+(b-a)*p)*amplitude*envelope;};
  return [sample('x'),sample('y')] as [number,number];
}
export const RackFocus:React.FC<{focus:number;depth:number;maxBlur?:number;breathing?:number;children:React.ReactNode}>=({focus,depth,maxBlur=14,breathing=.015,children})=>{
  const distance=clamp01(Math.abs(focus-depth));
  return <AbsoluteFill style={{filter:`blur(${distance*Math.max(0,maxBlur)}px)`,transform:`scale(${1+distance*breathing})`}}>{children}</AbsoluteFill>;
};
export function dollyZoomFov(distance:number,referenceDistance:number,referenceFovRadians:number){
  positive(distance);positive(referenceDistance);
  if(referenceFovRadians<=0||referenceFovRadians>=Math.PI)throw new Error('fov must be between 0 and pi');
  return 2*Math.atan(referenceDistance*Math.tan(referenceFovRadians/2)/distance);
}
export function orbit(t:number,{center=[0,0] as [number,number],radius=300,speed=.25,phase=0}={}){
  const angle=phase+t*speed;return {x:center[0]+radius*Math.cos(angle),y:center[1]+radius*Math.sin(angle),heading:angle+Math.PI/2};
}
