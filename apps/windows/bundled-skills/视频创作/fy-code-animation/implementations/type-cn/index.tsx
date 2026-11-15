import React from 'react';
import {useVideoConfig} from 'remotion';
import {springAt} from '../motion-core.mjs';
import {Decode} from '../craft/type/Decode';
import {clamp01,positive,smooth,unit} from '../remotion-kit/time';
export {OutlineFill} from '../craft/type/OutlineFill';
export {HandReveal} from '../craft/type/HandReveal';
type TextStyle={family:string;size:number;color?:string;style?:React.CSSProperties};
export type SemanticPart={id:string;text:string;at:number;duration:number};
/** Layout is browser-measured only after the parent's useFonts gate resolves. */
export const SemanticMaskReveal:React.FC<TextStyle & {t:number;parts:SemanticPart[];gap?:number;rise?:number}>=({t,parts,family,size,color='currentColor',style,gap=0,rise=1})=> <div style={{fontFamily:family,fontSize:size,lineHeight:1.4,fontSynthesis:'none',color,display:'flex',flexWrap:'wrap',gap,...style}}>{parts.map(part=><span key={part.id} style={{overflow:'hidden',display:'inline-block',padding:'.12em .04em'}}><span style={{display:'inline-block',whiteSpace:'pre',transform:`translateY(${rise*(1-smooth(unit(t,part.at,part.at+part.duration)))*110}%)`}}>{part.text}</span></span>)}</div>;
export const MarkerHighlight:React.FC<{t:number;at:number;duration:number;color?:string;children:React.ReactNode}>=({t,at,duration,color='#e9b94a66',children})=>{
  const p=smooth(unit(t,at,at+duration));return <span style={{display:'inline-block',position:'relative',isolation:'isolate'}}><span style={{position:'absolute',inset:'30% -.05em 0',background:color,transformOrigin:'left',transform:`scaleX(${p})`,zIndex:-1}}/>{children}</span>;
};
export const EmphasisWord:React.FC<{t:number;at:number;duration:number;level:1|2|3;children:React.ReactNode;accent?:string;weight?:number;scale?:number;shift?:number;underline?:boolean;marker?:boolean}>=({t,at,duration,level,children,accent='#e8a33d',weight=600,scale=1,shift=0,underline=false,marker=level===3})=>{
  const p=smooth(unit(t,at,at+duration));
  return <span style={{display:'inline-block',position:'relative',fontWeight:t<at?undefined:weight,color:t<at?undefined:accent,transform:`translateY(${-shift*p}px) scale(${1+(scale-1)*p})`}}>{marker?<MarkerHighlight t={t} at={at} duration={duration}>{children}</MarkerHighlight>:children}{underline&&<span style={{position:'absolute',height:'.06em',background:accent,left:0,right:0,bottom:0,transformOrigin:'left',transform:`scaleX(${p})`}}/>}</span>;
};
export const WeightAxisPulse:React.FC<{t:number;at:number;duration:number;axis:'wght'|'wdth'|'opsz'|string;verifiedRange:[number,number];from:number;peak:number;children:React.ReactNode}>=({t,at,duration,axis,verifiedRange,from,peak,children})=>{
  if(from<verifiedRange[0]||from>verifiedRange[1]||peak<verifiedRange[0]||peak>verifiedRange[1])throw new Error('font axis outside supplied verified range');
  const p=unit(t,at,at+duration),value=from+(peak-from)*Math.sin(Math.PI*p)**2;
  return <span style={{fontVariationSettings:`"${axis}" ${value}`,fontSynthesis:'none'}}>{children}</span>;
};
export const StrikeReplace:React.FC<{t:number;at:number;duration:number;before:string;after:string;color?:string}>=({t,at,duration,before,after,color='#d66'})=>{
  positive(duration);const p=unit(t,at,at+duration),strike=clamp01(p*2),swap=smooth(clamp01((p-.5)*2));
  return <span style={{display:'inline-grid'}}><span style={{gridArea:'1/1',opacity:1-swap,position:'relative'}}>{before}<span style={{position:'absolute',left:0,right:0,top:'50%',height:'.06em',background:color,transformOrigin:'left',transform:`scaleX(${strike})`}}/></span><span style={{gridArea:'1/1',opacity:swap}}>{after}</span></span>;
};
export type TimedWord={id:string;text:string;start:number;end:number};
export const KaraokeCaption:React.FC<TextStyle & {t:number;words:TimedWord[];active?:string;completed?:string}>=({t,words,family,size,color='#ddd',active='#ffda75',completed='#fff',style})=><div style={{fontFamily:family,fontSize:size,lineHeight:1.4,fontSynthesis:'none',...style}}>{words.map(w=>{if(w.end<=w.start)throw new Error(`empty word ${w.id}`);return <span key={w.id} style={{color:t>=w.end?completed:t>=w.start?active:color,whiteSpace:'pre'}}>{w.text}</span>;})}</div>;
/** Extends the existing deterministic decoder; not a second decoder implementation. */
export const ScrambleDecode:React.FC<TextStyle & {text:string;at:number;perCharacter?:number;settle?:number;alphabet:string;seed?:number}>=({text,at,perCharacter=.025,settle=.25,alphabet,seed=0,...style})=>{const {fps}=useVideoConfig();return <Decode {...style} text={text} at={at*fps} perChar={perCharacter*fps} settle={settle*fps} alphabet={alphabet} seed={seed}/>;};
/** Optical hand-off, not contour morphing. The shared grid reserves both text widths. */
export const TextMorphSwap:React.FC<{t:number;at:number;duration:number;before:React.ReactNode;after:React.ReactNode;travel?:number}>=({t,at,duration,before,after,travel=12})=>{
  const p=smooth(unit(t,at,at+duration));return <span style={{display:'inline-grid'}}><span style={{gridArea:'1/1',opacity:1-p,transform:`translateY(${-travel*p}px)`}}>{before}</span><span style={{gridArea:'1/1',opacity:p,transform:`translateY(${travel*(1-p)}px)`}}>{after}</span></span>;
};
export const SlamIn:React.FC<{t:number;at:number;children:React.ReactNode;overshootLimit?:number;startScale?:number;shakePixels?:number}>=({t,at,children,overshootLimit=.06,startScale=1.7,shakePixels=0})=>{
  if(overshootLimit<0||overshootLimit>.25||startScale<1)throw new Error('invalid slam range');
  const elapsed=Math.max(0,t-at),response=springAt(elapsed,{stiffness:210,damping:24}),p=Math.min(1+overshootLimit,response);
  const scale=Math.max(1-overshootLimit,startScale+(1-startScale)*p),shake=shakePixels*Math.sin(elapsed*70)*Math.exp(-elapsed*14);
  return <span style={{display:'inline-block',opacity:t<at?0:1,transform:`translateX(${shake}px) scale(${scale})`}}>{children}</span>;
};
export const ExtrudeText:React.FC<TextStyle & {text:string;depth?:number;direction?:[number,number];side?:string}>=({text,family,size,depth=8,direction=[.7,1],side='#666',color='#fff',style})=>{
  if(depth<0||depth>64||!Number.isInteger(depth))throw new Error('depth must be integer 0..64');
  const shadow=Array.from({length:depth},(_,i)=>`${direction[0]*(i+1)}px ${direction[1]*(i+1)}px 0 ${side}`).join(',');
  return <span style={{fontFamily:family,fontSize:size,lineHeight:1.4,color,textShadow:shadow||undefined,fontSynthesis:'none',...style}}>{text}</span>;
};
