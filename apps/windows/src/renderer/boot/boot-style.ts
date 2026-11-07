/**
 * 开机动画样式表。
 *
 * 由 DEMO 生成，作用域全部限定在 #lumii-boot 下，不会漏到主界面。
 * 注意：@keyframes 内部的关键帧不是选择器，不能加前缀。
 */
export const BOOT_STYLE = `#lumii-boot, #lumii-boot * { box-sizing: border-box; }

  #lumii-boot .mono{ font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }

  
  #lumii-boot {
    --cy: #4fd8ff;
    --cy-dim: rgba(79, 216, 255, .35);
    --amber: #ff9d4d;
    --amber-hot: #ffd08a;
    --void: #020408;
  }

  
  
  #lumii-boot .app-under{
    position: fixed; inset: 0; display: flex;
    background: linear-gradient(168deg, #080d16 0%, #060a12 55%, #04070c 100%);
    color: #8fb6c9; font-size: 12px;
  }
  #lumii-boot .app-side{
    width: 208px; flex: none; padding: 16px 14px;
    display: flex; flex-direction: column; gap: 14px;
    border-right: 1px solid rgba(79,216,255,.07);
    background: rgba(6,11,18,.6);
  }
  #lumii-boot .app-logo{ width: 26px; height: 26px; object-fit: contain; opacity: .9; }
  #lumii-boot .app-nav{
    padding: 7px 10px; border-radius: 5px;
    color: rgba(150,195,220,.5); letter-spacing: .06em;
  }
  #lumii-boot .app-nav.on{ background: rgba(79,216,255,.09); color: #bfe9ff; }
  #lumii-boot .app-main{ flex: 1; padding: 46px 52px; }
  #lumii-boot .app-line{ height: 10px; margin-bottom: 16px; border-radius: 5px;
    background: rgba(120,180,220,.09); }
  #lumii-boot .w40{ width: 40%; }  #lumii-boot .w55{ width: 55%; }  #lumii-boot .w70{ width: 70%; }

  #lumii-boot{
    position: fixed; inset: 0; overflow: hidden;
    background: var(--void); color: var(--cy);
    opacity: 1;
    
    transition:
      opacity 900ms cubic-bezier(.4,0,.35,1),
      transform 900ms cubic-bezier(.4,0,.35,1),
      -webkit-mask-size 900ms cubic-bezier(.4,0,.35,1),
      mask-size 900ms cubic-bezier(.4,0,.35,1);
    -webkit-mask-image: radial-gradient(ellipse 100% 100% at 50% 50%, #000 100%, #000 100%);
    mask-image: radial-gradient(ellipse 100% 100% at 50% 50%, #000 100%, #000 100%);
    -webkit-mask-size: 300% 300%; mask-size: 300% 300%;
    -webkit-mask-position: center; mask-position: center;
    -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
  }
  #lumii-boot.fading{
    opacity: 0;
    transform: scale(1.035);
    
    -webkit-mask-image: radial-gradient(ellipse 0% 0% at 50% 50%, #000 0%, transparent 72%);
    mask-image: radial-gradient(ellipse 0% 0% at 50% 50%, #000 0%, transparent 72%);
    pointer-events: none;
  }

  
  
  
  
  #lumii-boot .void-bg{
    position: absolute; inset: 0;
    background: linear-gradient(178deg, #010204 0%, #03060d 34%, #04080f 58%, #010306 100%);
    transition: opacity 1s ease;
  }
  
  #lumii-boot .void-bg::after{
    content: ''; position: absolute; inset: 0; opacity: .05;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E");
    mix-blend-mode: screen;
  }

  
  #lumii-boot .floor{
    position: absolute; left: -50%; right: -50%; bottom: -18%; height: 62%;
    opacity: 0; transform-origin: 50% 100%;
    background-image:
      linear-gradient(rgba(79,216,255,.22) 1px, transparent 1px),
      linear-gradient(90deg, rgba(79,216,255,.22) 1px, transparent 1px);
    background-size: 64px 64px;
    transform: perspective(420px) rotateX(72deg);
    -webkit-mask-image: linear-gradient(to top, rgba(0,0,0,.95) 0%, transparent 72%);
    mask-image: linear-gradient(to top, rgba(0,0,0,.95) 0%, transparent 72%);
    animation: floorRun 1.8s linear infinite;
    transition: opacity 1.1s ease;
  }
  @keyframes floorRun { to { background-position: 0 64px, 0 64px; } }
  #lumii-boot[data-act="neural"]   .floor{ opacity: .35; }
  #lumii-boot[data-act="energize"] .floor{ opacity: .75; animation-duration: .65s; }
  #lumii-boot[data-act="cognition"] .floor{ opacity: .5; animation-duration: 1.2s; }
  #lumii-boot[data-act="gate"]     .floor{ opacity: .28; }

  
  
  #lumii-boot canvas#bk-fx{
    position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none;
    will-change: transform;
  }

  
  #lumii-boot .hud-layer{ position: absolute; inset: 0; pointer-events: none; }

  
  #lumii-boot .armor{
    position: absolute; width: 92px; height: 92px; opacity: 0;
    transition: opacity .7s ease, transform .8s cubic-bezier(.2,.9,.25,1);
  }
  #lumii-boot .armor::before{
    content: ''; position: absolute; inset: 0;
    border-left: 2.5px solid rgba(120,232,255,.85);
    border-top: 2.5px solid rgba(120,232,255,.85);
    filter: drop-shadow(0 0 6px rgba(79,216,255,.55));
  }
  #lumii-boot .armor::after{
    content: ''; position: absolute; left: 0; top: 0;
    width: 34px; height: 3px; background: #bff2ff;
    box-shadow: 0 0 14px rgba(120,232,255,.95);
  }
  #lumii-boot .armor.tl{ left: 26px; top: 26px; transform: translate(-14px,-14px); }
  #lumii-boot .armor.tr{ right: 26px; top: 26px; transform: translate(14px,-14px) scaleX(-1); }
  #lumii-boot .armor.bl{ left: 26px; bottom: 26px; transform: translate(-14px,14px) scaleY(-1); }
  #lumii-boot .armor.br{ right: 26px; bottom: 26px; transform: translate(14px,14px) scale(-1); }
  #lumii-boot[data-act="neural"] .armor, #lumii-boot[data-act="energize"] .armor, #lumii-boot[data-act="cognition"] .armor, #lumii-boot[data-act="gate"] .armor{ opacity: 1; transform: none; }

  
  
  #lumii-boot .frame-line{
    position: absolute; opacity: 0; transition: opacity .9s ease;
    pointer-events: none;
  }
  #lumii-boot .fl-top, #lumii-boot .fl-bottom{
    left: 62px; right: 62px; height: 3px;
    border-top: 1px solid rgba(140,240,255,.85);
    border-bottom: 1px solid rgba(140,240,255,.3);
    filter: drop-shadow(0 0 5px rgba(79,216,255,.4));
  }
  #lumii-boot .fl-top{ top: 62px; }
  #lumii-boot .fl-bottom{ bottom: 62px; transform: scaleY(-1); }
  #lumii-boot .fl-left, #lumii-boot .fl-right{
    top: 62px; bottom: 62px; width: 3px;
    border-left: 1px solid rgba(140,240,255,.85);
    border-right: 1px solid rgba(140,240,255,.3);
    filter: drop-shadow(0 0 5px rgba(79,216,255,.4));
  }
  #lumii-boot .fl-left{ left: 62px; }
  #lumii-boot .fl-right{ right: 62px; transform: scaleX(-1); }

  
  #lumii-boot .compass{
    position: absolute; width: 104px; height: 104px;
    opacity: 0; transition: opacity .9s ease;
    border-radius: 50%;
    background:
      repeating-conic-gradient(
        from 0deg,
        rgba(140,240,255,.85) 0deg .7deg,
        transparent .7deg 9deg
      );
    -webkit-mask-image: radial-gradient(circle, transparent 0 40px, #000 41px 52px, transparent 52.5px);
    mask-image: radial-gradient(circle, transparent 0 40px, #000 41px 52px, transparent 52.5px);
  }
  
  #lumii-boot .cx-tl{
    left: 54px; top: 54px;
    clip-path: polygon(0 0, 100% 0, 100% 100%);
    -webkit-clip-path: polygon(0 0, 100% 0, 100% 100%);
  }
  #lumii-boot .cx-tr{
    right: 54px; top: 54px;
    clip-path: polygon(0 0, 100% 0, 0 100%);
    -webkit-clip-path: polygon(0 0, 100% 0, 0 100%);
  }
  #lumii-boot .cx-bl{
    left: 54px; bottom: 54px;
    clip-path: polygon(0 0, 100% 100%, 0 100%);
    -webkit-clip-path: polygon(0 0, 100% 100%, 0 100%);
  }
  #lumii-boot .cx-br{
    right: 54px; bottom: 54px;
    clip-path: polygon(100% 0, 100% 100%, 0 100%);
    -webkit-clip-path: polygon(100% 0, 100% 100%, 0 100%);
  }

  
  #lumii-boot[data-act="neural"] .frame-line, #lumii-boot[data-act="energize"] .frame-line, #lumii-boot[data-act="cognition"] .frame-line, #lumii-boot[data-act="gate"] .frame-line{ opacity: 1 !important; }
  #lumii-boot[data-act="neural"] .compass, #lumii-boot[data-act="energize"] .compass, #lumii-boot[data-act="cognition"] .compass, #lumii-boot[data-act="gate"] .compass{ opacity: .9 !important; }
  

  
  #lumii-boot .topbar{
    position: absolute; left: 46px; right: 46px; top: 46px;
    display: flex; justify-content: space-between; align-items: center;
    font-size: 10.5px; letter-spacing: .26em; opacity: 0;
    color: rgba(165,225,250,.9);
    text-shadow: 0 0 9px rgba(50,150,220,.5);
    transition: opacity .6s ease;
  }
  #lumii-boot[data-act="neural"] .topbar, #lumii-boot[data-act="energize"] .topbar, #lumii-boot[data-act="cognition"] .topbar, #lumii-boot[data-act="gate"] .topbar{ opacity: .95; }

  #lumii-boot .led{ display: inline-block; width: 6px; height: 6px; margin-right: 8px;
    background: var(--cy); box-shadow: 0 0 8px var(--cy);
    animation: ledPulse 1.4s ease-in-out infinite; }
  @keyframes ledPulse { 0%,100% { opacity: .25; } 50% { opacity: 1; } }
  #actName{ color: var(--amber); opacity: .85; }

  
  
  #lumii-boot .telemetry{
    position: absolute; left: 46px; bottom: 74px;
    font-size: 11px; letter-spacing: .1em; line-height: 1.95; opacity: 0;
    transition: opacity .6s ease;
  }
  #lumii-boot[data-act="neural"] .telemetry, #lumii-boot[data-act="energize"] .telemetry, #lumii-boot[data-act="cognition"] .telemetry, #lumii-boot[data-act="gate"] .telemetry{ opacity: .92; }
  #lumii-boot .telemetry .k{
    color: rgba(150,215,245,.85);
    text-shadow: 0 0 8px rgba(60,150,220,.5);
  }
  #lumii-boot .telemetry .v{
    color: #ffd9a8; font-variant-numeric: tabular-nums;
    text-shadow: 0 0 10px rgba(255,157,77,.55);
  }

  
  #lumii-boot .checks{
    position: absolute; right: 46px; top: 84px;
    font-size: 11px; letter-spacing: .1em; line-height: 2.15;
    text-align: right; opacity: 0; transition: opacity .6s ease;
  }
  #lumii-boot[data-act="neural"] .checks, #lumii-boot[data-act="energize"] .checks, #lumii-boot[data-act="cognition"] .checks, #lumii-boot[data-act="gate"] .checks{ opacity: .92; }
  #lumii-boot .checks div{
    color: rgba(160,220,250,.78);
    text-shadow: 0 0 8px rgba(50,140,210,.45);
    transition: color .45s ease;
  }
  #lumii-boot .checks div.on{
    color: #ffe0b8;
    text-shadow: 0 0 12px rgba(255,157,77,.6);
  }
  #lumii-boot .checks div.enter{ animation: checkIn .42s cubic-bezier(.2,.9,.25,1) both; }
  @keyframes checkIn {
    from { opacity: 0; transform: translateX(10px); }
    to   { opacity: 1; transform: none; }
  }
  
  #lumii-boot .checks div:not(.on) i{ animation: checkBlink 1.1s ease-in-out infinite; }
  @keyframes checkBlink { 0%,100% { opacity: .45; } 50% { opacity: 1; } }
  #lumii-boot .checks i{ font-style: normal; display: inline-block; width: 14px; opacity: .8; }
  #lumii-boot .checks div.on i{ opacity: 1; color: var(--amber); }

  
  #lumii-boot .bar-wrap{
    position: absolute; left: 50%; bottom: 12%; transform: translateX(-50%);
    width: min(640px, 76vw); opacity: 0; transition: opacity .7s ease;
  }
  #lumii-boot[data-act="neural"] .bar-wrap, #lumii-boot[data-act="energize"] .bar-wrap, #lumii-boot[data-act="cognition"] .bar-wrap, #lumii-boot[data-act="gate"] .bar-wrap{ opacity: 1; }

  #lumii-boot .bar{ position: relative; height: 3px; background: rgba(79,216,255,.10); overflow: hidden; }
  #lumii-boot .bar-fill{
    position: absolute; inset: 0 auto 0 0; width: 0%;
    background: linear-gradient(90deg, rgba(79,216,255,.5), var(--cy) 62%, #e8ffff);
    box-shadow: 0 0 16px rgba(110,225,255,.9);
    transition: width .28s ease-out;
  }
  #lumii-boot .bar-fill::after{
    content: ''; position: absolute; right: -3px; top: -4px;
    width: 26px; height: 11px;
    background: radial-gradient(ellipse, rgba(230,255,255,.95), transparent 72%);
  }
  #lumii-boot .bar-ticks{
    position: absolute; inset: 0;
    background-image: repeating-linear-gradient(90deg,
      transparent 0 30px, rgba(2,4,8,.85) 30px 32px);
    pointer-events: none;
  }

  #lumii-boot .bar-row{
    display: flex; justify-content: space-between; align-items: baseline;
    margin-top: 11px; font-size: 11.5px; letter-spacing: .2em;
  }
  #phaseText{
    color: rgba(175,230,250,.9);
    text-shadow: 0 0 9px rgba(50,150,220,.5);
  }
  #pctText{
    color: #ffe0b8; font-variant-numeric: tabular-nums; letter-spacing: .08em;
    text-shadow: 0 0 10px rgba(255,157,77,.55);
  }

  
  #lumii-boot .gate{
    position: absolute; left: 50%; top: 46%;
    width: 66vw; height: 62vh; border-radius: 50%;
    transform: translate(-50%,-50%) scaleX(.006) scaleY(0);
    background:
      radial-gradient(ellipse 50% 50% at 50% 50%,
        #ffffff 0%, #dff7ff 12%, #8fe4ff 30%, rgba(60,170,255,.55) 52%, rgba(20,80,160,.15) 70%, transparent 82%);
    opacity: 0; pointer-events: none;
    filter: blur(1px);
  }
  #lumii-boot .gate.open{ animation: gateOpen 1.9s cubic-bezier(.16,.86,.3,1) forwards; }
  @keyframes gateOpen {
    0%   { opacity: 0; transform: translate(-50%,-50%) scaleX(.006) scaleY(0); }
    16%  { opacity: 1; transform: translate(-50%,-50%) scaleX(.010) scaleY(1); }
    52%  { opacity: 1; transform: translate(-50%,-50%) scaleX(.62) scaleY(1); }
    78%  { opacity: 1; transform: translate(-50%,-50%) scaleX(1) scaleY(1.02); }
    100% { opacity: 1; transform: translate(-50%,-50%) scaleX(1.25) scaleY(1.12); }
  }
  
  #lumii-boot .gate-seam{
    position: absolute; left: 50%; top: 46%; width: 3px; height: 0;
    transform: translate(-50%,-50%);
    background: linear-gradient(to bottom, transparent, #ffffff 22%, #ffffff 78%, transparent);
    box-shadow: 0 0 30px 8px rgba(150,235,255,.9);
    opacity: 0;
  }
  #lumii-boot .gate-seam.open{ animation: seamOpen 1.1s cubic-bezier(.2,.9,.3,1) forwards; }
  @keyframes seamOpen {
    0%   { height: 0; opacity: 0; }
    28%  { height: 62vh; opacity: 1; }
    100% { height: 62vh; opacity: 0; }
  }

  
  #lumii-boot .signature{
    position: absolute; left: 0; top: 0;
    width: 26px; height: 26px;
    border-radius: 5px; opacity: 0;
    filter: brightness(1.45) saturate(.75)
      drop-shadow(0 0 14px rgba(190,240,255,.95));
    pointer-events: none;
    will-change: transform, opacity;
  }

  
  #lumii-boot .scanlines{
    position: absolute; inset: 0; pointer-events: none; opacity: .38;
    background: repeating-linear-gradient(to bottom,
      rgba(140,230,255,.045) 0 1px, transparent 1px 3px);
  }
  #lumii-boot .vignette{
    position: absolute; inset: 0; pointer-events: none;
    
    background:
      radial-gradient(ellipse 66% 58% at 50% 47%, transparent 26%, rgba(0,2,6,.55) 74%, rgba(0,1,4,.95) 100%),
      linear-gradient(to top, rgba(0,10,26,.5) 0%, transparent 34%);
  }
  #lumii-boot .noise{
    position: absolute; inset: 0; pointer-events: none; opacity: .028;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E");
  }

  
  #lumii-boot .flash{
    position: absolute; inset: 0; pointer-events: none; opacity: 0;
    background: radial-gradient(circle at 50% 46%, rgba(235,255,255,.98) 0%, rgba(150,230,255,.5) 30%, transparent 62%);
  }
  #lumii-boot .flash.fire{ animation: flashOut .9s ease-out forwards; }
  @keyframes flashOut { 0% { opacity: 1; } 100% { opacity: 0; } }

  #lumii-boot .glitch{
    position: absolute; inset: 0; pointer-events: none; opacity: 0;
    background: repeating-linear-gradient(to bottom,
      rgba(140,240,255,.22) 0 2px, transparent 2px 7px,
      rgba(255,160,80,.16) 7px 9px, transparent 9px 16px);
    mix-blend-mode: screen;
  }
  #lumii-boot .glitch.fire{ animation: glitchFlash .26s steps(2, end) forwards; }
  @keyframes glitchFlash {
    0% { opacity: .9; transform: translateX(-8px) scaleY(1.004); }
    50% { opacity: .6; transform: translateX(6px); }
    100% { opacity: 0; transform: none; }
  }

  #lumii-boot .shock{
    position: absolute; left: 50%; top: 46%; width: 120px; height: 120px;
    margin: -60px 0 0 -60px; border-radius: 50%;
    border: 2px solid rgba(200,250,255,.9); opacity: 0; pointer-events: none;
  }
  #lumii-boot .shock.fire{ animation: shockwave .95s cubic-bezier(.15,.7,.3,1) forwards; }
  @keyframes shockwave {
    0% { opacity: 1; transform: scale(.4); border-width: 5px; }
    100% { opacity: 0; transform: scale(7); border-width: 1px; }
  }

  
  #lumii-boot .barTop, #lumii-boot .barBot{
    position: absolute; left: 0; right: 0; height: 0; background: #000;
    z-index: 30; pointer-events: none;
    transition: height .9s cubic-bezier(.2,.9,.25,1);
  }
  #lumii-boot .barTop{ top: 0; }  #lumii-boot .barBot{ bottom: 0; }
  #lumii-boot .barTop.on, #lumii-boot .barBot.on{ height: 7.5vh; }

  
  `
