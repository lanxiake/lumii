"""Validate task structure, timing, phase boundaries and measured-evidence claims. Never renders."""
import argparse, hashlib, json, math
from pathlib import Path

def validate(d):
    errors=[]
    def require(ok,msg):
        if not ok: errors.append(msg)
    def number(x): return type(x) in (int,float) and math.isfinite(x)
    if not isinstance(d,dict): return ['task must be object']
    phase=d.get('phase')
    if not isinstance(phase,str): return ['invalid phase']
    require(phase in {'card','still','audition','final'},'invalid phase')
    allowed={'card':{'read','write_plan','logic_check'},'still':{'read','write_plan','logic_check','render_still'},'audition':{'read','write_plan','logic_check','generate_local_music','analyze_audio'},'final':{'read','write_plan','logic_check','render_still','render_video','generate_local_music','analyze_audio'}}
    actions=d.get('actions',[])
    require(isinstance(actions,list) and all(isinstance(a,str) for a in actions),'actions must be list of strings')
    if isinstance(actions,list) and all(isinstance(a,str) for a in actions):
        require(set(actions)<=allowed.get(phase,set()),'action outside phase')
    require(isinstance(d.get('task_id'),str) and bool(d.get('task_id')),'task_id required')
    fps=d.get('fps'); require(number(fps) and fps>0,'fps must be positive finite')
    scenes=d.get('scenes'); require(isinstance(scenes,list) and len(scenes)>0,'scenes required')
    if not isinstance(scenes,list): return errors
    ids=[]; intervals=[]
    for i,s in enumerate(scenes):
        prefix=f'scene[{i}]'
        if not isinstance(s,dict): errors.append(prefix+' must be object'); continue
        ident=s.get('id'); require(isinstance(ident,str) and bool(ident),prefix+' id required'); ids.append(ident)
        a,b=s.get('start'),s.get('end'); valid=number(a) and number(b) and 0<=a<b
        require(valid,prefix+' invalid time window')
        require(s.get('time_basis') in ('planned','measured'),prefix+' time_basis required')
        if valid:
            intervals.append((a,b,s))
            landed=s.get('last_text_at',a); hold=s.get('read_seconds',0)
            require(number(landed) and number(hold) and hold>=0 and a<=landed<=b and landed+hold<=b+1e-8,prefix+' reading window exceeds scene')
        require(bool(s.get('meaning')),prefix+' meaning required')
        require(bool(s.get('operation')),prefix+' visual operation required')
        if s.get('time_basis')=='measured': require(bool(s.get('evidence')),prefix+' measured window lacks evidence')
    require(len([x for x in ids if isinstance(x,str)])==len(set(x for x in ids if isinstance(x,str))),'duplicate scene ID')
    for i,(a,b,s) in enumerate(intervals):
        for c,e,prev in intervals[:i]:
            if max(a,c)<min(b,e)-1e-8:
                require(s.get('overlap_with')==prev.get('id') or prev.get('overlap_with')==s.get('id'),'unexplained scene overlap')
    events=d.get('events',[]); require(isinstance(events,list),'events must be list')
    event_ids=[]
    for ev in events if isinstance(events,list) else []:
        if not isinstance(ev,dict): errors.append('event must be object'); continue
        event_ids.append(ev.get('id')); require(isinstance(ev.get('id'),str) and bool(ev.get('id')),'event ID required')
        require(ev.get('scene_id') in ids,'event references unknown scene')
        require(ev.get('time_basis') in ('planned','measured'),'event time_basis required')
        matches=[s for s in scenes if isinstance(s,dict) and s.get('id')==ev.get('scene_id')]
        at=ev.get('at')
        if matches and number(matches[0].get('start')) and number(matches[0].get('end')):
            require(number(at) and matches[0]['start']<=at<matches[0]['end'],'event outside half-open scene')
        if ev.get('time_basis')=='measured':
            h=ev.get('source_sha256','')
            require(isinstance(h,str) and len(h)==64 and all(c in '0123456789abcdef' for c in h),'measured event needs source SHA256')
            require(bool(ev.get('evidence')),'measured event needs evidence')
    require(len([x for x in event_ids if isinstance(x,str)])==len(set(x for x in event_ids if isinstance(x,str))),'duplicate event ID')
    music=d.get('music',{})
    if isinstance(music,dict):
        if music.get('actual_sync'):
            h=music.get('source_sha256','')
            valid_hash=isinstance(h,str) and len(h)==64 and all(c in '0123456789abcdef' for c in h)
            require(music.get('status')=='selected' and isinstance(music.get('file'),str) and bool(music.get('file')) and valid_hash,'actual sync requires selected audio and source hash')
            require(isinstance(events,list) and any(isinstance(e,dict) and e.get('time_basis')=='measured' and e.get('source_sha256')==h for e in events),'actual sync requires measured events linked to selected audio')
    else: require(False,'music must be object')
    return errors

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('task');p.add_argument('--out');a=p.parse_args()
    path=Path(a.task);raw=path.read_bytes();d=json.loads(raw.decode('utf-8-sig'))
    errors=validate(d);result={'task':path.name,'sha256':hashlib.sha256(raw).hexdigest(),'passed':not errors,'errors':errors,'media_verified':False,'author_accepted':False}
    text=json.dumps(result,ensure_ascii=False,indent=2)
    if a.out: Path(a.out).write_text(text+'\n',encoding='utf-8')
    print(text);raise SystemExit(bool(errors))
if __name__=='__main__': main()
