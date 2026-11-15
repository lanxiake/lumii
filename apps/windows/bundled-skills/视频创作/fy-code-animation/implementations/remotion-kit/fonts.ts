import {useEffect,useState} from 'react';
import {cancelRender,continueRender,delayRender,staticFile} from 'remotion';
export type FontSpec={family:string;file:string;weight?:string;style?:string;stretch?:string};
const loads=new Map<string,Promise<void>>();
const gates=new Map<string,{promise:Promise<void>;ready:boolean}>();
function load(spec:FontSpec){
  const key=JSON.stringify(spec);let promise=loads.get(key);
  if(!promise){promise=(async()=>{
    const face=new FontFace(spec.family,`url(${JSON.stringify(staticFile(spec.file))})`,{weight:spec.weight??'400',style:spec.style??'normal',...(spec.stretch?{stretch:spec.stretch}:{})});
    document.fonts.add(await face.load());await document.fonts.ready;
  })();loads.set(key,promise);promise.catch(()=>loads.delete(key));}
  return promise;
}
/** Mount once above SceneStack with a stable manifest. Change its key to replace fonts. */
export function useFonts(specs:FontSpec[]){
  const signature=JSON.stringify(specs);
  const [initial]=useState(()=>signature);
  if(initial!==signature)throw new Error('Font manifest changed: remount the font gate with a new key');
  let entry=gates.get(signature);
  if(!entry){
    const handle=delayRender('local font files');
    const gate={ready:false,promise:Promise.resolve()};
    gate.promise=Promise.all(specs.map(load)).then(()=>{gate.ready=true;continueRender(handle);}).catch(error=>{cancelRender(error instanceof Error?error:new Error(String(error)));});
    gates.set(signature,gate);entry=gate;
  }
  const gate=entry;
  const [ready,setReady]=useState(gate.ready);
  useEffect(()=>{
    let active=true;
    gate.promise.then(()=>{if(active&&gate.ready)setReady(true);});
    // A StrictMode cleanup must not release an unfinished shared font load.
    return ()=>{active=false;};
  },[gate]);
  return ready;
}
/** This measures layout; it does NOT verify cmap coverage or true variable axes. */
export function measureCN(text:string,font:string){
  if(typeof document==='undefined')throw new Error('font measurement requires browser');
  if(!document.fonts.check(font,text))throw new Error('font is not ready');
  const g=document.createElement('canvas').getContext('2d');if(!g)throw new Error('Canvas 2D unavailable');
  g.font=font;return g.measureText(text);
}
