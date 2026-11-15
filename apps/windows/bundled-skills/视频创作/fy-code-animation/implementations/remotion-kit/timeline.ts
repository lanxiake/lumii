import {finite,frameRange,unit} from './time';
export type Basis='planned'|'measured';
export type Event={id:string;at:number;time_basis:Basis;scene_id?:string;role?:string;source_hash?:string;evidence?:string;word?:string;occurrence?:number;source_span?:string};
export type SceneSpec={id:string;start:number;end:number;time_basis?:Basis;meaning?:string;operation?:string};
export type Task={fps:number;width:number;height:number;phase:'card'|'still'|'audition'|'final';scenes:SceneSpec[];events:Event[];duration?:number};
export function layoutScenes(scenes:SceneSpec[],fps:number){
  const ids=new Set<string>();
  return scenes.map((s,i)=>{
    if(ids.has(s.id))throw new Error(`duplicate scene ${s.id}`);ids.add(s.id);
    if(i&&s.start<scenes[i-1].start)throw new Error('scenes must be ordered by start');
    if(i&&s.end<=scenes[i-1].end)throw new Error('scene ends must increase; nested scenes use their own Sequence');
    if(i>1&&s.start<scenes[i-2].end)throw new Error('three simultaneous scenes are unsupported');
    return {...s,...frameRange(s.start,s.end,fps)};
  });
}
/** A selected time basis is strict: changing a track must invalidate its measured set. */
export function eventTimeline(events:Event[],basis:Basis,sourceHash?:string){
  const map=new Map<string,Event>();
  for(const e of events.filter(e=>e.time_basis===basis)){
    finite(e.at,'event time');if(e.at<0)throw new Error(`negative event ${e.id}`);
    if(map.has(e.id))throw new Error(`duplicate event ${e.id}`);
    if(basis==='measured'&&(!e.source_hash||!e.evidence|| (sourceHash&&e.source_hash!==sourceHash)))throw new Error(`stale or undocumented measurement ${e.id}`);
    if(e.word&&(!e.occurrence||e.occurrence<1||!Number.isInteger(e.occurrence)||!e.source_span))throw new Error(`ambiguous word anchor ${e.id}`);
    map.set(e.id,e);
  }
  const eventAt=(id:string)=>{const e=map.get(id);if(!e)throw new Error(`missing ${basis} event: ${id}`);return e.at;};
  return {eventAt,event:(id:string)=>{eventAt(id);return map.get(id)!;},since:(id:string,t:number)=>t-eventAt(id),progressBetween:(a:string,b:string,t:number,ease:(p:number)=>number=p=>p)=>ease(unit(t,eventAt(a),eventAt(b)))};
}
export function taskDuration(task:Task){
  if(!task.scenes.length)throw new Error('empty scenes');
  const end=Math.max(...task.scenes.map(s=>s.end));
  if(task.duration!==undefined&&task.duration<end)throw new Error('duration clips scene tail');
  return task.duration??end; // Include audible tails explicitly in duration.
}
