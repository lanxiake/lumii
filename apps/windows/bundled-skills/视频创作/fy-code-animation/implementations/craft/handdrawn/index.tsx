// Adapted from renoise-ai/renoise-skills; see LICENSES/renoise-MIT.txt and implementations/craft/README.md.
import React from "react";
import { random } from "remotion";
import { pathLen } from "../lineart";

/*
 * Frame-by-frame hand-drawn kit (逐帧手绘).
 * - `onTwos(t)`: quantise time so everything moves on twos, like drawn animation (hold = 2 frames).
 * - `BoilDefs`: two turbulence filters (reseeded every hold) so each line is drawn twice, slightly differently —
 *   the double-pencil look — and the whole drawing "boils".
 * - `Rough`: a path drawn as that double pencil line; `u` (0→1) writes it on.
 * - `Hatch`: crayon hatching clipped to a shape, written on stroke by stroke.
 * - `Sparkle` / `Smear`: hand-drawn accents (4-point stars, speed lines) that pop on twos.
 * Pitfall: the filters use a user-space region (the frame), so never put a filtered element inside a transformed
 * group whose local coordinates go negative — warp the path into world space (@remotion/paths warpPath) instead.
 * Keep poses as data (key drawings) and switch them on twos rather than tweening smoothly; that's what reads as
 * "drawn frame by frame".
 */

export const onTwos = (t: number, hold = 2) => Math.floor(t / hold) * hold;

export const BoilDefs: React.FC<{ t: number; hold?: number; scale?: number; region?: [number, number, number, number] }> = ({ t, hold = 2, scale = 3, region = [0, 0, 1920, 1080] }) => {
  const s = Math.floor(t / hold) % 12;
  const r = { filterUnits: "userSpaceOnUse" as const, x: region[0], y: region[1], width: region[2], height: region[3] };
  return (
    <svg width={0} height={0} style={{ position: "absolute" }}>
      <defs>
        <filter id="boil-a" {...r}>
          <feTurbulence type="fractalNoise" baseFrequency={0.028} numOctaves={2} seed={s} result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale={scale} xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="boil-b" {...r}>
          <feTurbulence type="fractalNoise" baseFrequency={0.04} numOctaves={2} seed={s + 40} result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale={scale * 1.6} xChannelSelector="G" yChannelSelector="R" />
        </filter>
        <filter id="crayon" {...r}>
          <feTurbulence type="fractalNoise" baseFrequency={0.9} numOctaves={1} seed={s + 80} result="g" />
          <feColorMatrix in="g" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.8 1.5" result="holes" />
          <feComposite in="SourceGraphic" in2="holes" operator="in" result="grain" />
          <feTurbulence type="fractalNoise" baseFrequency={0.03} numOctaves={2} seed={s + 90} result="n" />
          <feDisplacementMap in="grain" in2="n" scale={scale * 1.4} xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>
  );
};

export const Rough: React.FC<{ d: string; u?: number; color?: string; width?: number; transform?: string }> = ({ d, u = 1, color = "#2A2140", width = 5, transform }) => {
  if (u <= 0) return null;
  const L = pathLen(d);
  const dash = { strokeDasharray: `${L} ${L + 1}`, strokeDashoffset: L * (1 - Math.min(1, u)) };
  return (
    <g transform={transform}>
      <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" filter="url(#boil-a)" {...dash} />
      <path d={d} fill="none" stroke={color} strokeWidth={width * 0.45} strokeLinecap="round" strokeLinejoin="round" opacity={0.55} filter="url(#boil-b)" {...dash} transform="translate(2.5 -1.5)" />
    </g>
  );
};

/** Crayon hatching inside `clip` (a path d), written on from left to right as `u` goes 0→1. */
export const Hatch: React.FC<{ clip: string; box: [number, number, number, number]; u: number; color: string; gap?: number; angle?: number; id: string; width?: number }> = ({ clip, box, u, color, gap = 13, angle = -35, id, width = 9 }) => {
  if (u <= 0) return null;
  const [x, y, w, h] = box;
  const diag = Math.hypot(w, h);
  const n = Math.ceil((diag * 2) / gap);
  const lines = Array.from({ length: n }, (_, i) => i).filter((i) => i / n <= u);
  return (
    <g>
      <defs>
        <clipPath id={id}>
          <path d={clip} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id})`} filter="url(#crayon)">
        <g transform={`translate(${x + w / 2} ${y + h / 2}) rotate(${angle})`}>
          {lines.map((i) => {
            const off = -diag + i * gap + (random(`${id}${i}`) - 0.5) * 4;
            return <line key={i} x1={off} y1={-diag} x2={off + (random(`${id}w${i}`) - 0.5) * 10} y2={diag} stroke={color} strokeWidth={width + random(`${id}s${i}`) * 4} strokeLinecap="round" opacity={0.85} />;
          })}
        </g>
      </g>
    </g>
  );
};

export const Sparkle: React.FC<{ x: number; y: number; r: number; t: number; at: number; color?: string }> = ({ x, y, r, t, at, color = "#FFB23F" }) => {
  const lt = onTwos(t) - at;
  if (lt < 0 || lt > 16) return null;
  const k = [0.4, 1.1, 1, 0.8, 0.9, 0.6, 0.7, 0.4, 0.2][Math.floor(lt / 2)] ?? 0;
  if (k <= 0) return null;
  const R = r * k;
  const d = `M ${x} ${y - R} Q ${x} ${y} ${x + R} ${y} Q ${x} ${y} ${x} ${y + R} Q ${x} ${y} ${x - R} ${y} Q ${x} ${y} ${x} ${y - R} Z`;
  return <path d={d} fill={color} stroke="#2A2140" strokeWidth={3} filter="url(#boil-a)" />;
};

/** Speed lines behind a moving drawing (angle in degrees, pointing where it came from). */
export const Smear: React.FC<{ x: number; y: number; angle: number; len: number; n?: number; seed: string }> = ({ x, y, angle, len, n = 4, seed }) => (
  <g filter="url(#boil-a)">
    <g transform={`translate(${x} ${y}) rotate(${angle})`}>
      {Array.from({ length: n }, (_, i) => {
        const off = (i - (n - 1) / 2) * 22;
        const l = len * (0.6 + random(`${seed}${i}`) * 0.5);
        return <line key={i} x1={20} y1={off} x2={20 + l} y2={off} stroke="#2A2140" strokeWidth={4} strokeLinecap="round" opacity={0.7} />;
      })}
    </g>
  </g>
);
