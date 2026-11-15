import assert from 'node:assert/strict';
import * as m from '../implementations/motion-core.mjs';
let checks=0;
function test(name,fn){try{fn();checks++;console.log('PASS',name);}catch(e){console.error('FAIL',name);throw e;}}
const near=(a,b,eps=1e-8)=>assert.ok(Math.abs(a-b)<eps,`${a} != ${b}`);
test('time conversion explicit rounding and invalid units',()=>{assert.equal(m.secondsToFrame(.051,30,'start'),1);assert.equal(m.secondsToFrame(.051,30,'end'),2);near(m.frameToSeconds(90,30),3);assert.throws(()=>m.secondsToFrame(1,0));assert.throws(()=>m.progress(1,2,2));});
test('12 drawings per second held for five frames at 60fps',()=>{for(let f=0;f<5;f++)near(m.steppedTime(f/60),0);near(m.steppedTime(5/60),1/12);});
test('periodic phase supports negative time',()=>{near(m.loopPhase(-.5,2),.75);near(m.loopPhase(2,2),0);assert.throws(()=>m.loopPhase(0,0));});
test('spring solves initial conditions and asymptote in three damping regimes',()=>{for(const damping of [12,20,30]){const cfg={stiffness:100,mass:1,damping,velocity:2};near(m.springAt(0,cfg),0);near(m.springAt(1e-7,cfg)/1e-7,2,1e-4);near(m.springAt(10,cfg),1,1e-6);}assert.ok(m.springAt(.4,{stiffness:100,damping:5})>1);assert.throws(()=>m.springAt(1,{damping:-1}));});
test('critical spring matches closed independent known solution',()=>{near(m.springAt(.2,{stiffness:100,damping:20}),1-3*Math.exp(-2));});
test('Bezier evaluates x mapping instead of treating parameter as progress',()=>{const linear=m.cubicBezier(.2,.2,.8,.8);near(linear(.37),.37);const ease=m.cubicBezier(0,0,1,1);near(ease(.5),.5);assert.throws(()=>m.cubicBezier(-1,0,1,1));});
test('keyed randomness and arbitrary seek remain identical',()=>{const times=[0,1,.2,5,.2,0];const out=times.map(t=>m.springAt(t)+m.keyedRandom(7,'particle-32'));assert.equal(out[0],out[5]);assert.equal(out[2],out[4]);assert.notEqual(m.keyedRandom(7,'a'),m.keyedRandom(7,'b'));});
test('camera anchor inverse across rotation/zoom',()=>{for(const z of [.25,1,3])for(const r of [-1,0,.8]){const spec={screen:[960,540],zoom:z,rotation:r};const center=m.cameraCenterForAnchor([80,120],[400,300],spec);const got=m.camera2D([80,120],{...spec,center});near(got[0],400);near(got[1],300);}});
test('cover crop bounds and visible subject area',()=>{const c=m.coverCrop(4000,2000,1000,1000,[1,1]);near(c.x,2000);near(c.width,2000);near(c.y,0);near(m.visibleBoxFraction({x:1000,y:0,width:2000,height:1000},c),.5);assert.throws(()=>m.coverCrop(0,2000,1000,1000));});
test('path moves by length, handles zero-length segment',()=>{const p=m.pointAlongPolyline([[0,0],[0,0],[2,0],[2,8]],.5);near(p[0],2);near(p[1],3);assert.throws(()=>m.pointAlongPolyline([[0,0]],.2));});
test('contact response is continuous at impact',()=>{near(m.contactRing(1,1),0);near(m.contactRing(.999,1),0);assert.ok(Math.abs(m.contactRing(1+1e-9,1))<1e-5);});
test('log zoom and key validation',()=>{near(m.keyed(.5,[[0,1],[1,9]],{log:true}),3);assert.throws(()=>m.keyed(0,[[1,1],[1,2]]));assert.throws(()=>m.keyed(0,[[0,0]],{log:true}));});
console.log(JSON.stringify({passed:checks,media_generated:false}));
