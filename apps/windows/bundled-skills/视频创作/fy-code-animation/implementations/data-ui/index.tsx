import React from 'react';
import {AbsoluteFill,Img,staticFile} from 'remotion';
import {coverCrop,pointAlongPolyline,keyedRandom} from '../motion-core.mjs';
import {clamp01,positive,smooth,unit} from '../remotion-kit/time';
export type Datum={id:string;label:string;from:number;to:number;color?:string};
export const dataValue=(datum:Datum,p:number)=>datum.from+(datum.to-datum.from)*clamp01(p);
export function numberText(value:number,decimals=0,suffix='',locale='zh-CN'){
  if(!Number.isFinite(value)||!Number.isInteger(decimals)||decimals<0||decimals>12)throw new Error('invalid number format');
  return new Intl.NumberFormat(locale,{minimumFractionDigits:decimals,maximumFractionDigits:decimals}).format(value)+suffix;
}
export const CountUp:React.FC<{value:number;decimals?:number;suffix?:string;style?:React.CSSProperties}>=({value,decimals=0,suffix='',style})=><span style={{fontVariantNumeric:'tabular-nums',...style}}>{numberText(value,decimals,suffix)}</span>;
export const AnimatedBars:React.FC<{data:Datum[];progress:number;width:number;height:number;family:string;domain:[number,number];rank?:boolean;sourceLabel:string;suffix?:string;decimals?:number}>=({data,progress,width,height,family,domain,rank=false,sourceLabel,suffix='',decimals=0})=>{
  if(!data.length||!sourceLabel||domain[0]>0||domain[1]<0||domain[1]<=domain[0])throw new Error('bars require data, source, and a domain containing zero');
  if(new Set(data.map(d=>d.id)).size!==data.length)throw new Error('bar IDs must be unique');
  if(data.some(d=>![d.from,d.to].every(n=>Number.isFinite(n)&&n>=domain[0]&&n<=domain[1])))throw new Error('data outside fixed domain');
  const left=width*.25,right=width*.17,plot=width-left-right,step=(height-80)/data.length,p=clamp01(progress),x=(v:number)=>left+(v-domain[0])/(domain[1]-domain[0])*plot;
  const order=(key:'from'|'to')=>[...data].sort((a,b)=>b[key]-a[key]||a.id.localeCompare(b.id)).map(d=>d.id);
  const before=order('from'),after=order('to');
  const positions=data.map((d,i)=>({d,y:30+((rank?before.indexOf(d.id):i)*(1-p)+(rank?after.indexOf(d.id):i)*p)*step}));
  return <svg width={width} height={height} style={{fontFamily:family,fontSize:28,overflow:'visible'}}><line x1={x(0)} x2={x(0)} y1={0} y2={height-50} stroke="#aaa"/>{positions.map(({d,y},i)=>{
    const v=dataValue(d,p),zero=x(0),end=x(v),overlap=positions.some((other,j)=>j<i&&Math.abs(other.y-y)<28);
    return <g key={d.id}><rect x={Math.min(zero,end)} y={y} width={Math.abs(end-zero)} height={step*.55} fill={d.color??'#7ca8be'}/><g opacity={overlap?0:1}><text x={left-14} y={y+step*.4} textAnchor="end" fill="currentColor">{d.label}</text><text x={v>=0?end+10:end-10} y={y+step*.4} textAnchor={v>=0?'start':'end'} fill="currentColor" style={{fontVariantNumeric:'tabular-nums'}}>{numberText(v,decimals,suffix)}</text></g></g>;
  })}<text x={left} y={height-12} fontSize={22} fill="currentColor">{sourceLabel} · {domain[0]}—{domain[1]}{suffix}</text></svg>;
};
export const LineReveal:React.FC<{points:([number,number]|null)[];progress:number;width:number;height:number;color?:string;strokeWidth?:number}>=({points,progress,width,height,color='#8ac',strokeWidth=5})=>{
  const groups:[number,number][][]=[];let group:[number,number][]=[];
  for(const point of points){if(point)group.push(point);else{if(group.length)groups.push(group);group=[];}}if(group.length)groups.push(group);
  const lengths=groups.map(g=>g.slice(1).reduce((sum,b,i)=>sum+Math.hypot(b[0]-g[i][0],b[1]-g[i][1]),0)),total=lengths.reduce((a,b)=>a+b,0);let passed=0;
  return <svg width={width} height={height}>{groups.map((g,i)=>{const len=lengths[i],p=len?clamp01((clamp01(progress)*total-passed)/len):0;passed+=len;return g.length>1?<polyline key={i} points={g.map(pt=>pt.join(',')).join(' ')} fill="none" stroke={color} strokeWidth={strokeWidth} pathLength={1} strokeDasharray="1" strokeDashoffset={1-p}/>:<circle key={i} cx={g[0][0]} cy={g[0][1]} r={strokeWidth/2} fill={color} opacity={progress>0?1:0}/>;})}</svg>;
};
export type CursorKey={at:number;point:[number,number];controlIn?:[number,number];controlOut?:[number,number]};
export function cursorPoint(t:number,keys:CursorKey[]):[number,number]{
  if(!keys.length)throw new Error('empty cursor path');keys.forEach((k,i)=>{if(i&&k.at<=keys[i-1].at)throw new Error('cursor keys must increase');});
  if(t<=keys[0].at)return keys[0].point;if(t>=keys[keys.length-1].at)return keys[keys.length-1].point;
  const b=keys.findIndex(k=>k.at>t),a=b-1,p=smooth(unit(t,keys[a].at,keys[b].at)),q=1-p,A=keys[a].point,B=keys[a].controlOut??A,C=keys[b].controlIn??keys[b].point,D=keys[b].point;
  return [0,1].map(axis=>q**3*A[axis]+3*q*q*p*B[axis]+3*q*p*p*C[axis]+p**3*D[axis]) as [number,number];
}
export const Cursor:React.FC<{t:number;keys:CursorKey[];presses?:{down:number;up:number}[];size?:number;ripple?:boolean}>=({t,keys,presses=[],size=44,ripple=false})=>{
  const [x,y]=cursorPoint(t,keys),down=presses.some(p=>t>=p.down&&t<p.up);
  return <AbsoluteFill style={{pointerEvents:'none'}}><svg width={size} height={size*1.3} viewBox="0 0 32 42" style={{position:'absolute',left:x,top:y,overflow:'visible',transformOrigin:'0 0',transform:`scale(${down ? .85 : 1})`}}><path d="M0 0 L0 31 L8 24 L15 39 L22 35 L15 21 L27 21 Z" fill="white" stroke="#222" strokeWidth="1.5"/></svg>{ripple&&presses.map((p,i)=>{const u=(t-p.down)/.35;if(u<0||u>=1)return null;const [px,py]=cursorPoint(p.down,keys);return <div key={i} style={{position:'absolute',left:px-30,top:py-30,width:60,height:60,border:'2px solid white',borderRadius:'50%',transform:`scale(${u})`,opacity:1-u}}/>;})}</AbsoluteFill>;
};
export function typingTimes(text:string,{at=0,cps=15,seed='typing',punctuationPause=.18}={}){
  positive(cps);let time=at;return Array.from(text).map((ch,i)=>{time+=(.65+keyedRandom(seed,i)*.7)/cps;const entry={at:time,text:ch};if(/[，。！？；,.;!?]/u.test(ch))time+=punctuationPause;return entry;});
}
export const TypeIn:React.FC<{t:number;events:{at:number;text:string}[];caret?:boolean;style?:React.CSSProperties}>=({t,events,caret=true,style})=> <span style={{whiteSpace:'pre-wrap',...style}}>{events.filter(e=>e.at<=t).map(e=>e.text).join('')}{caret&&t<(events[events.length-1]?.at??0)&&<span>▌</span>}</span>;
export const DeviceFrame:React.FC<{children:React.ReactNode;label:string;radius?:number;style?:React.CSSProperties}>=({children,label,radius=28,style})=><div style={{position:'relative',border:'10px solid #202124',borderRadius:radius,overflow:'hidden',background:'#eee',...style}}>{children}<div style={{position:'absolute',bottom:8,right:12,fontSize:18,color:'#fff',background:'#111b',padding:'2px 5px'}}>{label}</div></div>;
export const KenBurns:React.FC<{src:string;imageWidth:number;imageHeight:number;width:number;height:number;progress:number;focus?:[number,number];fromZoom?:number;toZoom?:number}>=({src,imageWidth,imageHeight,width,height,progress,focus=[.5,.5],fromZoom=1,toZoom=1.08})=>{
  if(fromZoom<1||toZoom<1)throw new Error('cover zoom must be >=1');const p=smooth(progress),zoom=Math.exp(Math.log(fromZoom)+(Math.log(toZoom)-Math.log(fromZoom))*p),crop=coverCrop(imageWidth,imageHeight,width,height,focus,zoom);
  return <div style={{position:'relative',width,height,overflow:'hidden'}}><Img src={staticFile(src)} style={{position:'absolute',width:imageWidth*crop.scale,height:imageHeight*crop.scale,left:-crop.x*crop.scale,top:-crop.y*crop.scale,maxWidth:'none'}}/></div>;
};
export type PhotoSlot={id:string;start:number;end:number;file:string;width:number;height:number;focus:[number,number];fromZoom?:number;toZoom?:number};
export const PhotoMontage:React.FC<{t:number;width:number;height:number;slots:PhotoSlot[];background?:string}>=({t,width,height,slots,background='#111'})=>{
  const active=slots.filter(s=>t>=s.start&&t<s.end);if(active.length>1)throw new Error('photo slots overlap: use TransitionOverlap explicitly');const s=active[0];
  return <AbsoluteFill style={{background}}>{s&&<KenBurns key={s.id} src={s.file} imageWidth={s.width} imageHeight={s.height} width={width} height={height} focus={s.focus} progress={unit(t,s.start,s.end)} fromZoom={s.fromZoom??1} toZoom={s.toZoom??1}/>}</AbsoluteFill>;
};
export type LatLon=[number,number]; // latitude, longitude in degrees
export function greatCircle(a:LatLon,b:LatLon,steps=96):LatLon[]{
  if(!Number.isInteger(steps)||steps<2||steps>10000)throw new Error('invalid route sampling');
  const vector=([lat,lon]:LatLon)=>{if(!Number.isFinite(lat)||Math.abs(lat)>90||!Number.isFinite(lon)||Math.abs(lon)>180)throw new Error('invalid coordinates');const p=lat*Math.PI/180,l=lon*Math.PI/180;return [Math.cos(p)*Math.cos(l),Math.cos(p)*Math.sin(l),Math.sin(p)];};
  const A=vector(a),B=vector(b),dot=Math.max(-1,Math.min(1,A.reduce((v,x,i)=>v+x*B[i],0))),angle=Math.acos(dot);
  if(Math.PI-angle<1e-6)throw new Error('antipodal route needs an explicit waypoint');
  return Array.from({length:steps+1},(_,i)=>{const p=i/steps,s=angle<1e-7?1-p:Math.sin((1-p)*angle)/Math.sin(angle),r=angle<1e-7?p:Math.sin(p*angle)/Math.sin(angle),v=A.map((x,j)=>s*x+r*B[j]);return [Math.atan2(v[2],Math.hypot(v[0],v[1]))*180/Math.PI,Math.atan2(v[1],v[0])*180/Math.PI];});
}
export function project([lat,lon]:LatLon,width:number,height:number,projection:'equirectangular'|'mercator'='equirectangular'):[number,number]{
  const x=(lon+180)/360*width,p=Math.max(-85.0511,Math.min(85.0511,lat))*Math.PI/180;
  return [x,projection==='mercator'?(1-Math.log(Math.tan(Math.PI/4+p/2))/Math.PI)/2*height:(90-lat)/180*height];
}
/** Route only, no political borders or authoritative basemap. */
export const GeoRoute:React.FC<{from:LatLon;to:LatLon;progress:number;width:number;height:number;projection?:'equirectangular'|'mercator';label?:string}>=({from,to,progress,width,height,projection='equirectangular',label='路线示意'})=>{
  const points=greatCircle(from,to).map(p=>project(p,width,height,projection)),parts:[number,number][][]=[[]];
  points.forEach((p,i)=>{if(i&&Math.abs(p[0]-points[i-1][0])>width/2){const a=points[i-1],goingRight=a[0]>p[0],unwrapped=p[0]+(goingRight?width:-width),edge=goingRight?width:0,u=(edge-a[0])/(unwrapped-a[0]),y=a[1]+(p[1]-a[1])*u;parts[parts.length-1].push([edge,y]);parts.push([[goingRight?0:width,y]]);}parts[parts.length-1].push(p);});
  const lengths=parts.map(part=>part.slice(1).reduce((n,p,i)=>n+Math.hypot(p[0]-part[i][0],p[1]-part[i][1]),0)),total=lengths.reduce((a,b)=>a+b,0);let used=0;
  return <svg width={width} height={height}>{parts.map((part,i)=>{const p=lengths[i]?clamp01((clamp01(progress)*total-used)/lengths[i]):0;used+=lengths[i];const head=part.length>1?pointAlongPolyline(part,p):part[0];return <g key={i}><polyline points={part.map(pt=>pt.join(',')).join(' ')} pathLength={1} strokeDasharray="1" strokeDashoffset={1-p} stroke="#8bd" strokeWidth={4} fill="none"/>{p>0&&p<1&&<circle cx={head[0]} cy={head[1]} r={6} fill="#fff"/>}</g>;})}<text x={20} y={height-20} fill="currentColor" fontSize={24}>{label}</text></svg>;
};
