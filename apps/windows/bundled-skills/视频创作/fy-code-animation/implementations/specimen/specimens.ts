import type { Draw } from "./SpecimenCanvas";
import {
  BASE_H,
  BASE_W,
  clamp01,
  easeBack,
  easeInOut,
  easeOut,
  luma,
  mix,
  mixHex,
  noise1,
  rand,
  rgba,
  type SpecimenTheme,
} from "./theme";

const fillBg = (g: CanvasRenderingContext2D, bg: string | null | undefined, fallback: string) => {
  if (bg === null) return;
  g.fillStyle = bg ?? fallback;
  g.fillRect(-4, -4, BASE_W + 8, BASE_H + 8);
};

/* ── 01 POINT: halftone dot grid with a radial wave ──────────────────────────── */

export type HalftoneOpts = {
  cols?: number;
  rows?: number;
  ox?: number; // wave origin (where the ball landed)
  oy?: number;
  spawn?: number; // radius in px that has appeared so far (grow from the origin)
  collapse?: number; // 0..1, every dot converges on (tx, ty)
  tx?: number;
  ty?: number;
  bg?: string | null;
  diverse?: number; // 0..1 share of dots that get their own colour + shape (inclusion)
};

export const HALFTONE_GRID = { cols: 48, rows: 27 };

export const drawHalftone =
  (th: SpecimenTheme, o: HalftoneOpts = {}): Draw =>
  (g, t) => {
    const cols = o.cols ?? HALFTONE_GRID.cols;
    const rows = o.rows ?? HALFTONE_GRID.rows;
    const sx = BASE_W / cols;
    const sy = BASE_H / rows;
    const ox = o.ox ?? 960;
    const oy = o.oy ?? 540;
    const tx = o.tx ?? 960;
    const ty = o.ty ?? 540;
    const spawn = o.spawn ?? 1e9;
    const collapse = o.collapse ?? 0;
    const diverse = o.diverse ?? 0;
    const cols7 = [th.cream, ...th.sprinkle];
    fillBg(g, o.bg, th.ink);
    const dmax = 2300;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x = (i + 0.5) * sx;
        const y = (j + 0.5) * sy;
        const d = Math.hypot(x - ox, y - oy);
        const appear = clamp01((spawn - d) / 110);
        if (appear <= 0) continue;
        const ph = d * 0.0165 - t * 0.19;
        const w = 0.5 + 0.5 * Math.sin(ph);
        const ring = Math.floor((ph + Math.PI / 2) / (Math.PI * 2));
        let r = (1.8 + 12 * w * w) * easeOut(appear) * Math.min(sx, sy) / 40;
        let px = x;
        let py = y;
        if (collapse > 0) {
          const k = easeInOut(clamp01(collapse * 1.6 - (1 - d / dmax) * 0.6));
          px = mix(x, tx, k);
          py = mix(y, ty, k);
          r *= 1 - 0.7 * k;
        }
        const crest = w > 0.64;
        const idx = j * cols + i;
        if (diverse > 0 && rand(idx, 61) < diverse) {
          const c = cols7[Math.floor(rand(idx, 62) * cols7.length)];
          const rr = Math.max(0.5, r * (0.8 + rand(idx, 64) * 0.5));
          g.globalAlpha = 0.55 + 0.45 * w;
          g.fillStyle = c;
          g.strokeStyle = c;
          const shape = Math.floor(rand(idx, 63) * 4);
          g.beginPath();
          if (shape === 0) g.arc(px, py, rr, 0, Math.PI * 2);
          else if (shape === 1) g.rect(px - rr * 0.88, py - rr * 0.88, rr * 1.76, rr * 1.76);
          else if (shape === 2) {
            g.moveTo(px, py - rr * 1.15);
            g.lineTo(px + rr * 1.15, py);
            g.lineTo(px, py + rr * 1.15);
            g.lineTo(px - rr * 1.15, py);
            g.closePath();
          } else {
            g.lineWidth = Math.max(1, rr * 0.38);
            g.arc(px, py, rr * 0.8, 0, Math.PI * 2);
            g.stroke();
            continue;
          }
          g.fill();
          continue;
        }
        g.globalAlpha = crest ? 1 : 0.8;
        g.fillStyle = crest ? (((ring % 2) + 2) % 2 === 0 ? th.accent : th.accent2) : th.cream;
        g.beginPath();
        g.arc(px, py, Math.max(0.4, r), 0, Math.PI * 2);
        g.fill();
      }
    }
    g.globalAlpha = 1;
    if (collapse > 0.8) {
      g.fillStyle = th.cream;
      g.beginPath();
      g.arc(tx, ty, 12 * clamp01((collapse - 0.8) / 0.2), 0, Math.PI * 2);
      g.fill();
    }
  };

/* ── 02 LINE: ridge lines (Unknown Pleasures) that can flatten into circle chords ── */

export type RidgeOpts = {
  n?: number;
  x0?: number;
  x1?: number;
  y0?: number;
  y1?: number;
  amp?: number; // 0..1 peak height
  reveal?: number; // 0..1 lines drawn left → right
  spread?: number; // 0..1 lines fan out from the centre line
  chord?: number; // 0..1 flatten into horizontal chords of a circle (hand-off to StringArt)
  R?: number;
  cx?: number;
  cy?: number;
  highlight?: number;
  bg?: string | null;
};

export const RIDGE_LINES = 48;

/** y of chord j when `n` horizontal chords fill a circle of radius R (shared with drawStrings). */
export const chordY = (j: number, n: number, R: number, cy: number) => cy - R * 0.94 + (j / (n - 1)) * R * 1.88;

export const drawRidges =
  (th: SpecimenTheme, o: RidgeOpts = {}): Draw =>
  (g, t) => {
    const n = o.n ?? RIDGE_LINES;
    const x0 = o.x0 ?? 540;
    const x1 = o.x1 ?? 1380;
    const y0 = o.y0 ?? 250;
    const y1 = o.y1 ?? 830;
    const cx = o.cx ?? 960;
    const cy = o.cy ?? 540;
    const R = o.R ?? 300;
    const amp = o.amp ?? 1;
    const reveal = o.reveal ?? 1;
    const spread = o.spread ?? 1;
    const chord = o.chord ?? 0;
    const hi = o.highlight ?? Math.floor(n / 2);
    const bg = o.bg === undefined ? th.ink : o.bg;
    fillBg(g, bg, th.ink);
    const M = 150;
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      const base = mix(cy, mix(y0, y1, u), easeInOut(spread));
      const yc = chordY(i, n, R, cy);
      const hl = Math.sqrt(Math.max(0, R * R - (yc - cy) * (yc - cy)));
      const yb = mix(base, yc, chord);
      const xa = mix(x0, cx - hl, chord);
      const xb = mix(x1, cx + hl, chord);
      const xr = mix(xa, xb, clamp01(reveal * 1.25 - u * 0.25));
      if (xr <= xa + 1) continue;
      const rowAmp = (0.3 + 0.7 * Math.sin(Math.PI * u)) * amp * (1 - chord);
      const ys: number[] = [];
      for (let k = 0; k <= M; k++) {
        const x = mix(xa, xr, k / M);
        const env = Math.exp(-Math.pow((x - cx) / 175, 2));
        let bumps = 0;
        for (let b = 0; b < 4; b++) {
          const c = cx + (rand(i, b) - 0.5) * 290;
          const wd = 18 + rand(i, b + 7) * 40;
          const a = rand(i, b + 13) * (0.55 + 0.45 * Math.sin(t * 0.075 + rand(i, b + 3) * 6.28));
          bumps += a * Math.exp(-Math.pow((x - c) / wd, 2));
        }
        const h = env * (bumps * 105 + 7 * noise1(x * 0.045 + i * 1.7 + t * 0.035, i)) + 1.2 * noise1(x * 0.2 + i, 3);
        ys.push(yb - h * rowAmp);
      }
      g.beginPath();
      for (let k = 0; k <= M; k++) {
        const x = mix(xa, xr, k / M);
        if (k === 0) g.moveTo(x, ys[k]);
        else g.lineTo(x, ys[k]);
      }
      if (bg) {
        g.lineTo(xr, yb + 60);
        g.lineTo(xa, yb + 60);
        g.closePath();
        g.fillStyle = bg;
        g.fill();
        g.beginPath();
        for (let k = 0; k <= M; k++) {
          const x = mix(xa, xr, k / M);
          if (k === 0) g.moveTo(x, ys[k]);
          else g.lineTo(x, ys[k]);
        }
      }
      g.strokeStyle = i === hi ? th.accent : rgba(th.cream, 0.88);
      g.lineWidth = i === hi ? 2.6 : 1.6;
      g.stroke();
    }
  };

/* ── 02 LINE: modular multiplication string art ─────────────────────────────── */

export type StringOpts = {
  n?: number;
  R?: number;
  cx?: number;
  cy?: number;
  k?: number; // multiplier: line i joins point i and point k·i (mod n)
  rot?: number;
  enter?: number; // 0..1 the 48 ridge chords swing into place
  extra?: number; // 0..1 the remaining lines fade in
  squash?: number; // 0..1 collapse into one horizontal line
  bg?: string | null;
};

export const STRING_POINTS = 200;

export const drawStrings =
  (th: SpecimenTheme, o: StringOpts = {}): Draw =>
  (g, t) => {
    const n = o.n ?? STRING_POINTS;
    const R = o.R ?? 300;
    const cx = o.cx ?? 960;
    const cy = o.cy ?? 540;
    const k = o.k ?? 2;
    const rot = o.rot ?? -Math.PI / 2 + t * 0.002;
    const enter = o.enter ?? 1;
    const extra = o.extra ?? 1;
    const squash = o.squash ?? 0;
    fillBg(g, o.bg, th.ink);
    const sq = (y: number) => cy + (y - cy) * (1 - 0.992 * easeInOut(squash));
    const cols = th.sprinkle.length >= 3 ? th.sprinkle.slice(0, 3) : [th.accent, th.accent2, th.cream];
    g.globalCompositeOperation = "lighter";
    for (let i = 0; i < n; i++) {
      const a1 = (Math.PI * 2 * i) / n + rot;
      const a2 = (Math.PI * 2 * k * i) / n + rot;
      let p1x = cx + R * Math.cos(a1);
      let p1y = cy + R * Math.sin(a1);
      let p2x = cx + R * Math.cos(a2);
      let p2y = cy + R * Math.sin(a2);
      const jf = (i * RIDGE_LINES) / n;
      const j = Math.round(jf);
      const isChord = Math.abs(jf - j) < (RIDGE_LINES / n) * 0.5 && j < RIDGE_LINES;
      let alpha = 0.5;
      if (isChord) {
        const yc = chordY(j, RIDGE_LINES, R, cy);
        const hl = Math.sqrt(Math.max(0, R * R - (yc - cy) * (yc - cy)));
        const e = easeInOut(clamp01(enter * 1.5 - rand(j, 5) * 0.5));
        p1x = mix(cx - hl, p1x, e);
        p1y = mix(yc, p1y, e);
        p2x = mix(cx + hl, p2x, e);
        p2y = mix(yc, p2y, e);
        alpha = mix(0.9, 0.5, e);
      } else {
        alpha *= clamp01(extra * 1.4 - rand(i, 9) * 0.4);
        if (alpha <= 0.01) continue;
      }
      const u = i / n;
      const c = u < 0.5 ? mixHex(cols[0], cols[1], u * 2, alpha) : mixHex(cols[1], cols[2], (u - 0.5) * 2, alpha);
      g.strokeStyle = c;
      g.lineWidth = 1.15;
      g.beginPath();
      g.moveTo(p1x, sq(p1y));
      g.lineTo(p2x, sq(p2y));
      g.stroke();
    }
    g.globalCompositeOperation = "source-over";
    g.strokeStyle = rgba(th.cream, 0.28 * (1 - squash));
    g.lineWidth = 1;
    g.beginPath();
    g.ellipse(cx, cy, R, Math.max(0.5, R * (1 - 0.992 * easeInOut(squash))), 0, 0, Math.PI * 2);
    g.stroke();
    if (squash > 0.6) {
      const e = clamp01((squash - 0.6) / 0.4);
      g.strokeStyle = rgba(th.cream, e);
      g.lineWidth = 2.2;
      g.beginPath();
      g.moveTo(cx - R, cy);
      g.lineTo(cx + R, cy);
      g.stroke();
    }
  };

/* ── 03 PLANE: a line becomes a plane becomes the brand palette ─────────────── */

export type PaletteOpts = {
  grow?: number; // 0..1 line widens, then thickens into a full-screen plane
  split?: number; // 0..1 the plane splits into swatch columns
  labels?: number; // 0..1 swatch labels type on
  exit?: number; // 0..1 columns slide away, revealing the plane again
  lineW?: number; // width of the starting line (the collapsed string art)
  under?: string; // colour revealed when the columns slide away (default: the hero plane); "none" = transparent
};

export const drawPalette =
  (th: SpecimenTheme, o: PaletteOpts = {}): Draw =>
  (g) => {
    const grow = o.grow ?? 1;
    const split = o.split ?? 0;
    const labels = o.labels ?? 0;
    const exit = o.exit ?? 0;
    // under: "none" leaves the canvas transparent behind the sliding columns (reveal a video / layer below)
    const reveal = exit > 0 && o.under === "none";
    if (!reveal) {
      g.fillStyle = th.ink;
      g.fillRect(-4, -4, BASE_W + 8, BASE_H + 8);
      const gw = mix(o.lineW ?? 600, BASE_W + 8, easeInOut(clamp01(grow / 0.45)));
      const gh = mix(2.2, BASE_H + 8, easeInOut(clamp01((grow - 0.38) / 0.62)));
      g.fillStyle = exit > 0 && o.under ? o.under : grow < 0.3 ? mixHex(th.cream, th.accent, grow / 0.3) : th.accent;
      g.fillRect(960 - gw / 2, 540 - gh / 2, gw, gh);
    }
    if (split <= 0) return;
    const sw = th.palette;
    const cw = BASE_W / sw.length;
    sw.forEach((s, i) => {
      const p = easeInOut(clamp01(split * 1.7 - i * 0.1));
      const out = easeInOut(clamp01(exit * 1.6 - i * 0.08));
      const dir = i % 2 === 0 ? -1 : 1;
      const h = p * BASE_H;
      const y = BASE_H - h + out * dir * (BASE_H + 40);
      g.fillStyle = s.hex;
      g.fillRect(i * cw - 0.5, y, cw + 1, h);
      const la = clamp01(labels * 2 - i * 0.14) * (1 - out);
      if (la <= 0) return;
      const tc = luma(s.hex) > 0.55 ? th.ink : th.cream;
      g.globalAlpha = la;
      g.fillStyle = tc;
      g.font = `500 17px ${th.mono}`;
      g.fillText(String(i + 1).padStart(2, "0"), i * cw + 26, y + BASE_H - 164);
      g.font = `600 30px ${th.sans}`;
      g.fillText(s.name, i * cw + 26, y + BASE_H - 118);
      g.font = `400 17px ${th.mono}`;
      g.fillText(s.hex.toUpperCase(), i * cw + 26, y + BASE_H - 84);
      g.globalAlpha = 1;
    });
  };

/* ── 03 PLANE: filled / outlined marquee rows ───────────────────────────────── */

export type MarqueeOpts = {
  words: string[];
  enter?: number;
  exit?: number;
  rows?: number;
  size?: number;
  bg?: string;
  ink?: string;
};

export const drawMarquee =
  (th: SpecimenTheme, o: MarqueeOpts): Draw =>
  (g, t) => {
    const rows = o.rows ?? 6;
    const size = o.size ?? 168;
    const ink = o.ink ?? th.ink;
    const enter = o.enter ?? 1;
    const exit = o.exit ?? 0;
    g.fillStyle = o.bg ?? th.accent;
    g.fillRect(-4, -4, BASE_W + 8, BASE_H + 8);
    const rh = BASE_H / rows;
    g.font = `900 ${size}px ${th.sans}`;
    g.textBaseline = "middle";
    const text = o.words.join("  •  ") + "  •  ";
    const tw = Math.max(200, g.measureText(text).width);
    for (let r = 0; r < rows; r++) {
      const dir = r % 2 === 0 ? 1 : -1;
      const ein = easeOut(clamp01(enter * 1.5 - r * 0.1));
      const eout = clamp01(exit * 1.5 - r * 0.1);
      const slide = (1 - ein) * -dir * 2400 + eout * eout * dir * 2400;
      const moving = (1 - ein) * 1.2 + (eout > 0 && eout < 1 ? 1 : 0);
      const drift = dir * t * 6.5 + r * 311;
      const x0 = (((drift % tw) + tw) % tw) - tw + slide;
      const y = r * rh + rh / 2 + size * 0.04;
      const samples = moving > 0.05 ? 6 : 1;
      for (let s = 0; s < samples; s++) {
        const off = samples > 1 ? (s / (samples - 1) - 0.5) * 140 * Math.min(1, moving) * dir : 0;
        g.globalAlpha = samples > 1 ? 1.6 / samples : 1;
        for (let x = x0; x < BASE_W + tw; x += tw) {
          if (r % 2 === 1) {
            // stroke, then fill with the background: variable fonts have overlapping contours that a bare stroke shows
            g.strokeStyle = ink;
            g.lineWidth = 6;
            g.strokeText(text, x + off, y);
            g.fillStyle = o.bg ?? th.accent;
            g.fillText(text, x + off, y);
          } else {
            g.fillStyle = ink;
            g.fillText(text, x + off, y);
          }
        }
      }
      g.globalAlpha = 1;
    }
    g.textBaseline = "alphabetic";
  };

/* ── 03 PLANE: Truchet tiles whose arcs rejoin into continuous paths ─────────── */

export type TruchetOpts = {
  size?: number;
  assemble?: number; // 0..1 tiles pop in from the centre
  hole?: number; // half-height in px of a cleared ellipse for copy
  bg?: string;
  stroke?: number;
};

export const drawTruchet =
  (th: SpecimenTheme, o: TruchetOpts = {}): Draw =>
  (g, t) => {
    const s = o.size ?? 120;
    const cols = Math.ceil(BASE_W / s);
    const rows = Math.ceil(BASE_H / s);
    const assemble = o.assemble ?? 1;
    const hole = o.hole ?? 0;
    g.fillStyle = o.bg ?? th.paper;
    g.fillRect(-4, -4, BASE_W + 8, BASE_H + 8);
    g.lineCap = "round";
    g.lineWidth = o.stroke ?? 17;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const cx = (i + 0.5) * s;
        const cy = (j + 0.5) * s;
        const d = Math.hypot(cx - 960, cy - 540);
        const a = easeBack(clamp01(assemble * 1.8 - d / 1150), 1.4);
        if (a <= 0.001) continue;
        let alpha = 1;
        if (hole > 0) {
          const e = Math.pow((cx - 960) / (hole * 2.3), 2) + Math.pow((cy - 540) / hole, 2);
          alpha = clamp01((e - 0.8) / 0.2);
          if (alpha <= 0) continue;
        }
        const idx = j * cols + i;
        const o0 = rand(idx, 21) > 0.5 ? 1 : 0;
        const phase = (t - d / 13) / 30;
        let turns = o0;
        if (phase > 0) {
          const fr = phase - Math.floor(phase);
          turns += Math.floor(phase) + easeInOut(clamp01((fr - 0.55) / 0.45));
        }
        const pick = rand(idx, 33);
        g.strokeStyle = pick > 0.9 ? th.sprinkle[Math.floor(rand(idx, 44) * th.sprinkle.length)] : th.ink;
        g.globalAlpha = alpha;
        g.save();
        g.translate(cx, cy);
        g.rotate((turns * Math.PI) / 2);
        g.scale(a, a);
        g.beginPath();
        g.arc(-s / 2, -s / 2, s / 2, 0, Math.PI / 2);
        g.stroke();
        g.beginPath();
        g.arc(s / 2, s / 2, s / 2, Math.PI, Math.PI * 1.5);
        g.stroke();
        g.restore();
      }
    }
    g.globalAlpha = 1;
  };

/* ── 02 LINE: one line that trembles into a voice (listening) ───────────────── */

export type VoiceOpts = {
  grow?: number; // 0..1 a dot stretches into the line
  amp?: number; // 0..1 the line starts to speak
  x0?: number;
  x1?: number;
  cy?: number;
  bg?: string | null;
};

/** A speech-like waveform: syllable bursts on a carrier, two softer echo voices behind the main one. */
export const drawVoice =
  (th: SpecimenTheme, o: VoiceOpts = {}): Draw =>
  (g, t) => {
    const x0 = o.x0 ?? 540;
    const x1 = o.x1 ?? 1380;
    const cy = o.cy ?? 540;
    const grow = easeInOut(o.grow ?? 1);
    const amp = o.amp ?? 1;
    fillBg(g, o.bg, th.ink);
    const L = (x1 - x0) * grow;
    const xa = 960 - L / 2;
    const xb = 960 + L / 2;
    if (L < 3) {
      g.fillStyle = th.cream;
      g.beginPath();
      g.arc(960, cy, 12, 0, Math.PI * 2);
      g.fill();
      return;
    }
    const y = (x: number, layer: number) => {
      const u = clamp01((x - x0) / (x1 - x0));
      const env = Math.sin(Math.PI * u);
      const syl = Math.pow(0.5 + 0.5 * Math.sin(x * 0.011 - t * 0.2 + layer * 1.3), 2) * (0.65 + 0.35 * noise1(x * 0.004 + t * 0.02, 5 + layer));
      const car = Math.sin(x * 0.09 - t * 0.85 + layer * 1.7) * 0.6 + Math.sin(x * 0.23 - t * 1.6 + layer) * 0.3 + Math.sin(x * 0.041 + t * 0.45) * 0.4;
      return cy - env * syl * car * 120 * amp * (layer === 0 ? 1 : 0.55);
    };
    const M = 300;
    const stroke = (layer: number, color: string, width: number) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      for (let k = 0; k <= M; k++) {
        const x = mix(xa, xb, k / M);
        if (k === 0) g.moveTo(x, y(x, layer));
        else g.lineTo(x, y(x, layer));
      }
      g.stroke();
    };
    stroke(2, rgba(th.sprinkle[0] ?? th.accent2, 0.5 * amp), 1.4);
    stroke(1, rgba(th.accent, 0.55 * amp), 1.4);
    g.shadowColor = rgba(th.cream, 0.7);
    g.shadowBlur = 14;
    stroke(0, th.cream, 2.2);
    g.shadowBlur = 0;
  };
