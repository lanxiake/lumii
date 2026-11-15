const finite=(x,label)=>{if(!Number.isFinite(x))throw new Error(`${label} must be finite`);return x;};
const positive=(x,label)=>{finite(x,label);if(x<=0)throw new Error(`${label} must be positive`);return x;};
export const secondsToFrame=(seconds,fps)=>Math.round(finite(seconds,'seconds')*positive(fps,'fps'));
export const frameToSeconds=(frame,fps)=>finite(frame,'frame')/positive(fps,'fps');
export const secondsToSample=(seconds,sampleRate)=>Math.round(finite(seconds,'seconds')*positive(sampleRate,'sampleRate'));
export const sampleToSeconds=(sample,sampleRate)=>finite(sample,'sample')/positive(sampleRate,'sampleRate');
/** Planned grid, not measurement. n is absolute, so rounded step lengths never accumulate. */
export function beatGrid({bpm,offset=0,start=0,end,fps}){
  positive(bpm,'bpm');finite(offset,'offset');finite(start,'start');finite(end,'end');if(end<=start)throw new Error('empty interval');
  const first=Math.ceil((start-offset)*bpm/60),last=Math.ceil((end-offset)*bpm/60)-1;
  if(last-first>1000000)throw new Error('beat grid too large');
  return Array.from({length:Math.max(0,last-first+1)},(_,i)=>{const index=first+i,at=offset+index*60/bpm;return {index,at,time_basis:'planned',...(fps?{frame:secondsToFrame(at,fps)}:{})};});
}
export const tempoCandidates=bpm=>{positive(bpm,'bpm');return [bpm/2,bpm,bpm*2];};
/** Explicit measured beat records only. Fixed events are always kept unchanged. */
export function snapEvents(events,beats,{tolerance=.06,sourceHash}={}){
  finite(tolerance,'tolerance');if(tolerance<0||!sourceHash)throw new Error('need non-negative tolerance and source hash');
  if(beats.some((b,i)=>!Number.isFinite(b.at)||b.at<0||b.time_basis!=='measured'||b.source_hash!==sourceHash||!b.evidence||(i&&b.at<=beats[i-1].at)))throw new Error('beats must be ordered, measured, and tied to the current source');
  return events.map(e=>{
    finite(e.at,'event.at');if(!e.allow_snap||!beats.length)return {...e,snap_status:'kept'};
    const nearest=beats.reduce((a,b)=>Math.abs(b.at-e.at)<Math.abs(a.at-e.at)?b:a),delta=nearest.at-e.at,allowed=e.tolerance??tolerance;
    if(!Number.isFinite(allowed)||allowed<0)throw new Error('bad event tolerance');
    if(Math.abs(delta)>allowed|| (e.min_at!==undefined&&nearest.at<e.min_at)||(e.max_at!==undefined&&nearest.at>e.max_at))return {...e,snap_status:'outside_tolerance'};
    return {...e,planned_at:e.at,at:nearest.at,time_basis:'measured',source_hash:sourceHash,evidence:nearest.evidence,beat_id:nearest.id,delta,snap_status:'snapped'};
  });
}
export function sfxStart(contactAt,peakOffset){finite(contactAt,'contact');finite(peakOffset,'peakOffset');if(peakOffset<0)throw new Error('negative peak offset');const at=contactAt-peakOffset;return {at,preRoll:Math.max(0,-at),needsPreRoll:at<0};}
