// Independent small easing adapter; does not require GSAP.
export const clamp01=(x:number)=>Math.min(1,Math.max(0,x));
export const mix=(a:number,b:number,p:number)=>a+(b-a)*p;
// Expo out and power3.inOut (fourth-power curve), evaluated without a timeline.
export const E={out:(p:number)=>p===1?1:1-Math.pow(2,-10*p),inOut:(p:number)=>p<.5?8*p**4:1-8*(1-p)**4};
