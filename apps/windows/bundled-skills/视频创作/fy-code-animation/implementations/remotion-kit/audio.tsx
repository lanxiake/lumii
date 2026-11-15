import React from 'react';
import {Audio,Sequence,staticFile,cancelRender} from 'remotion';
import {frameAt,positive,smooth} from './time';
export type VoiceWindow={start:number;end:number};
export type Track={id:string;file:string;start:number;end:number;gain:number;trimSeconds?:number;role:'voice'|'music'|'sfx'|'ambience'};
export function duckGain(t:number,voices:VoiceWindow[],floor=.25,attack=.12,release=.3){
  if(floor<0||floor>1)throw new Error('duck floor must be 0..1');positive(attack);positive(release);
  let activity=0;
  for(const v of voices){if(v.end<=v.start)throw new Error('empty voice window');
    const a=t<v.start?smooth((t-v.start+attack)/attack):t<=v.end?1:1-smooth((t-v.end)/release);
    activity=Math.max(activity,a);
  }return 1-(1-floor)*activity;
}
export function sfxTrack(eventAt:number,peakOffset:number,duration:number,track:Omit<Track,'start'|'end'|'role'>):Track{
  if(!Number.isFinite(peakOffset)||peakOffset<0||!Number.isFinite(eventAt))throw new Error('invalid SFX event or peak offset');
  const start=eventAt-peakOffset;
  if(start<0)throw new Error('SFX begins before zero: design pre-roll or choose another source');
  positive(duration);return {...track,start,end:start+duration,role:'sfx'};
}
/** All times are global seconds; use at composition root, not inside a scene Sequence. */
export const AudioTracks:React.FC<{tracks:Track[];fps:number;voices?:VoiceWindow[];duckFloor?:number}>=({tracks,fps,voices=[],duckFloor=.25})=><>{tracks.map(track=>{
  const from=frameAt(track.start,fps),to=frameAt(track.end,fps),trim=frameAt(track.trimSeconds??0,fps);
  if(from<0||to<=from||trim<0||!Number.isFinite(track.gain)||track.gain<0)throw new Error(`invalid audio track ${track.id}`);
  return <Sequence key={track.id} from={from} durationInFrames={to-from} name={track.id}><Audio src={staticFile(track.file)} trimBefore={trim} volume={localFrame=>track.gain*(track.role==='music'?duckGain((localFrame+from)/fps,voices,duckFloor):1)} onError={error=>cancelRender(error)}/></Sequence>;
})}</>;
