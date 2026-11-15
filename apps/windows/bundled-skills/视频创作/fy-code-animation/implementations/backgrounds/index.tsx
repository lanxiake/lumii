import React,{useLayoutEffect,useRef} from 'react';
import {AbsoluteFill,cancelRender} from 'remotion';
import {keyedRandom,loopPhase} from '../motion-core.mjs';
import {clamp01,positive,smooth,unit} from '../remotion-kit/time';
export type ReadingZone={x:number;y:number;width:number;height:number;padding?:number;feather?:number;floor?:number};
/** Pixel coordinates. 0 means suppressed, 1 means unrestricted. */
export function readingAttenuation(x:number,y:number,zones:ReadingZone[]=[]){
  return zones.reduce((weight,z)=>{
    const p=z.padding??24,f=Math.max(1,z.feather??80),floor=clamp01(z.floor??.08);
    const dx=Math.max(z.x-p-x,0,x-z.x-z.width-p),dy=Math.max(z.y-p-y,0,y-z.y-z.height-p);
    return Math.min(weight,floor+(1-floor)*smooth(Math.hypot(dx,dy)/f));
  },1);
}
export const ReadingZoneMask=readingAttenuation;
export type Draw=(g:CanvasRenderingContext2D,t:number,width:number,height:number)=>void;
export const BackgroundCanvas:React.FC<{t:number;width:number;height:number;draw:Draw;dpr?:number;style?:React.CSSProperties}>=({t,width,height,draw,dpr=1,style})=>{
  positive(width);positive(height);if(dpr<=0||dpr>3)throw new Error('explicit DPR must be 0..3');
  const ref=useRef<HTMLCanvasElement>(null);
  useLayoutEffect(()=>{
    try{
      const canvas=ref.current;if(!canvas)throw new Error('Canvas not mounted');
      canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
      const g=canvas.getContext('2d');if(!g)throw new Error('Canvas 2D unavailable');
      g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,width,height);g.save();draw(g,t,width,height);g.restore();
    }catch(error){cancelRender(error instanceof Error?error:new Error(String(error)));}
  },[t,width,height,draw,dpr]); // Synchronous draw before paint; no asynchronous assets here.
  return <canvas ref={ref} style={{position:'absolute',width,height,...style}}/>;
};
type FieldProps={t:number;width:number;height:number;seed?:string;zones?:ReadingZone[];color?:string;period?:number};
export const FlowField:React.FC<FieldProps & {lines?:number;steps?:number;stepLength?:number}>=({t,width,height,seed='flow',zones=[],color='#7899aa',period=12,lines=100,steps=35,stepLength=6})=>{
  if(lines<1||lines>2000||steps<1||steps>200)throw new Error('invalid flow budget');positive(stepLength);
  return <BackgroundCanvas t={t} width={width} height={height} draw={(g,time,w,h)=>{
    const phase=loopPhase(time,period)*Math.PI*2;g.strokeStyle=color;g.lineWidth=1.2;
    for(let i=0;i<lines;i++){
      let x=keyedRandom(seed,`${i}:x`)*w,y=keyedRandom(seed,`${i}:y`)*h;
      for(let j=0;j<steps;j++){
        const angle=1.8*Math.sin(x/w*5+Math.sin(phase))+1.3*Math.cos(y/h*4+Math.cos(phase));
        const nx=x+Math.cos(angle)*stepLength,ny=y+Math.sin(angle)*stepLength;
        g.globalAlpha=.23*readingAttenuation((x+nx)/2,(y+ny)/2,zones);g.beginPath();g.moveTo(x,y);g.lineTo(nx,ny);g.stroke();x=nx;y=ny;
      }
    }
  }}/>;
};
export const ParticleAtmosphere:React.FC<FieldProps & {count?:number;mode?:'drift'|'orbit'|'gather';targets?:[number,number][];gatherAt?:number;gatherDuration?:number;radius?:number}>=({t,width,height,seed='particles',zones=[],color='#aacadd',period=14,count=240,mode='drift',targets,gatherAt=0,gatherDuration=1.2,radius=2})=>{
  if(count<1||count>20000||!Number.isInteger(count))throw new Error('particle count must be integer 1..20000');positive(radius);
  if(mode==='gather'&&(!targets||targets.length<count))throw new Error('gather requires one explicit target per particle');
  return <BackgroundCanvas t={t} width={width} height={height} draw={(g,time,w,h)=>{
    const phase=loopPhase(time,period)*Math.PI*2;g.fillStyle=color;
    for(let i=0;i<count;i++){
      const rx=keyedRandom(seed,`${i}:x`),ry=keyedRandom(seed,`${i}:y`),a=keyedRandom(seed,`${i}:phase`)*Math.PI*2;
      let x=rx*w+Math.sin(phase+a)*24,y=ry*h+Math.cos(phase+a)*18;
      if(mode==='orbit'){const r=Math.sqrt(rx)*Math.min(w,h)*.6;x=w/2+Math.cos(phase+a)*r;y=h/2+Math.sin(phase+a)*r*.55;}
      if(mode==='gather'){const delay=keyedRandom(seed,`${i}:delay`)*.25,p=smooth(unit(time,gatherAt+delay,gatherAt+delay+gatherDuration));x+= (targets![i][0]-x)*p;y+=(targets![i][1]-y)*p;}
      g.globalAlpha=(.15+.5*ry)*readingAttenuation(x,y,zones);g.beginPath();g.arc(x,y,radius*(.4+ry),0,Math.PI*2);g.fill();
    }
  }}/>;
};
export const DotGrid:React.FC<FieldProps & {spacing?:number;focus?:[number,number];eventAt?:number;amplitude?:number}>=({t,width,height,zones=[],color='#91a2b2',spacing=42,focus=[width/2,height/2],eventAt=0,amplitude=6})=>{
  positive(spacing);if(width*height/(spacing*spacing)>40000)throw new Error('dot grid budget exceeded');
  return <BackgroundCanvas t={t} width={width} height={height} draw={(g,time,w,h)=>{
    g.fillStyle=color;const tau=time-eventAt;
    for(let y=spacing/2;y<h;y+=spacing)for(let x=spacing/2;x<w;x+=spacing){
      const dx=x-focus[0],dy=y-focus[1],r=Math.hypot(dx,dy),u=tau-r/500;
      const wave=u<0?0:Math.sin(u*14)*Math.exp(-u*4)*amplitude;
      const px=x+wave*dx/Math.max(1,r),py=y+wave*dy/Math.max(1,r);
      g.globalAlpha=.45*readingAttenuation(px,py,zones);g.beginPath();g.arc(px,py,1.5,0,Math.PI*2);g.fill();
    }
  }}/>;
};
function noise(x:number,y:number,seed:string){
  const ix=Math.floor(x),iy=Math.floor(y),u=smooth(x-ix),v=smooth(y-iy);
  const a=keyedRandom(seed,`${ix},${iy}`),b=keyedRandom(seed,`${ix+1},${iy}`),c=keyedRandom(seed,`${ix},${iy+1}`),d=keyedRandom(seed,`${ix+1},${iy+1}`);
  return (a+(b-a)*u)*(1-v)+(c+(d-c)*u)*v;
}
export const NoiseGradient:React.FC<FieldProps & {colors?:[[number,number,number],[number,number,number]];cell?:number;octaves?:number}>=({t,width,height,seed='noise',zones=[],period=20,colors=[[15,24,37],[61,92,113]],cell=24,octaves=3})=>{
  if(cell<4||octaves<1||octaves>6)throw new Error('invalid noise resolution');
  return <BackgroundCanvas t={t} width={width} height={height} draw={(g,time,w,h)=>{
    const phase=loopPhase(time,period)*Math.PI*2,cols=Math.ceil(w/cell),rows=Math.ceil(h/cell),c=document.createElement('canvas');c.width=cols;c.height=rows;const small=c.getContext('2d');if(!small)throw new Error('noise canvas unavailable');
    const pixels=small.createImageData(cols,rows);
    for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){
      let n=0,total=0;for(let k=0;k<octaves;k++){const a=.5**k;n+=a*noise(x/cols*3*2**k+Math.cos(phase),y/rows*3*2**k+Math.sin(phase),seed+':'+k);total+=a;}
      const p=n/total*readingAttenuation(x*cell,y*cell,zones),i=(y*cols+x)*4;
      for(let j=0;j<3;j++)pixels.data[i+j]=Math.round(colors[0][j]+(colors[1][j]-colors[0][j])*p);pixels.data[i+3]=255;
    }small.putImageData(pixels,0,0);g.imageSmoothingEnabled=true;g.drawImage(c,0,0,w,h);
  }}/>;
};
export const LightSweep:React.FC<{progress:number;opacity?:number;angle?:number;color?:string}>=({progress,opacity=.2,angle=-20,color='#ffffff'})=><AbsoluteFill style={{overflow:'hidden',pointerEvents:'none'}}><AbsoluteFill style={{left:`${-80+180*clamp01(progress)}%`,width:'60%',transform:`rotate(${angle}deg)`,opacity,background:`linear-gradient(to right,transparent,${color},transparent)`}}/></AbsoluteFill>;
export const Vignette:React.FC<{strength?:number}>=({strength=.4})=><AbsoluteFill style={{pointerEvents:'none',background:`radial-gradient(ellipse at center,transparent 35%,rgba(0,0,0,${clamp01(strength)}) 100%)`}}/>;
export const Grain:React.FC<FieldProps & {count?:number;opacity?:number;drawingsPerSecond?:number}>=({t,width,height,seed='grain',zones=[],count=1800,opacity=.06,drawingsPerSecond=12})=>{
  if(count<0||count>50000)throw new Error('grain budget exceeded');positive(drawingsPerSecond);
  return <BackgroundCanvas t={t} width={width} height={height} draw={(g,time,w,h)=>{const pose=Math.floor(time*drawingsPerSecond);for(let i=0;i<count;i++){const x=keyedRandom(seed,`${pose}:${i}:x`)*w,y=keyedRandom(seed,`${pose}:${i}:y`)*h;g.globalAlpha=opacity*readingAttenuation(x,y,zones);g.fillStyle=i%2?'#fff':'#000';g.fillRect(x,y,1.5,1.5);}}}/>;
};
