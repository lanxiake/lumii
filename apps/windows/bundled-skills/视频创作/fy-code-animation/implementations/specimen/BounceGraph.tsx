import React from "react";
import { clamp01, mix, rgba, type SpecimenTheme } from "./theme";

export type BounceSpec = {
  x0: number; // launch x (e.g. where the period sat)
  x1: number; // resting x
  floor: number; // floor y (the word's baseline)
  contacts: number[]; // local frames at which the ball touches the floor
  heights: number[]; // apex height of each arc (arc k ends at contacts[k])
  r?: number;
};

/** Ball centre, squash (0..1) and stretch (0..1) at local frame t. */
export const bounceAt = (b: BounceSpec, t: number) => {
  const r = b.r ?? 16;
  const end = b.contacts[b.contacts.length - 1];
  const x = mix(b.x0, b.x1, 1 - Math.pow(1 - clamp01(t / end), 1.6));
  let y = b.floor;
  let vy = 0;
  let a = 0;
  for (let k = 0; k < b.contacts.length; k++) {
    const c = b.contacts[k];
    if (t < c) {
      const len = c - a;
      const u = (t - a) / len;
      y = b.floor - 4 * b.heights[k] * u * (1 - u);
      vy = (-4 * b.heights[k] * (1 - 2 * u)) / len;
      break;
    }
    a = c;
  }
  const squash = b.contacts.reduce((s, c, k) => s + Math.exp(-Math.abs(t - c) / 1.3) * [1, 0.7, 0.45, 0.3][Math.min(k, 3)], 0);
  const stretch = Math.min(1, Math.abs(vy) / 45);
  return { x, y, r, squash: Math.min(1, squash), stretch };
};

/**
 * Animation-principles specimen: a bouncing ball with squash & stretch, its onion-skin trail,
 * contact frame markers on the floor and a playhead tag — the look of a graph editor.
 */
export const BounceGraph: React.FC<{ th: SpecimenTheme; b: BounceSpec; t: number; frameOffset?: number; guides?: number; ballAlpha?: number }> = ({
  th,
  b,
  t,
  frameOffset = 0,
  guides = 1,
  ballAlpha = 1,
}) => {
  const s = bounceAt(b, t);
  const sx = 1 + 0.55 * s.squash - 0.22 * s.stretch;
  const sy = 1 - 0.45 * s.squash + 0.32 * s.stretch;
  const trail: [number, number][] = [];
  for (let k = 0; k <= Math.min(t, b.contacts[b.contacts.length - 1]); k += 2) {
    const p = bounceAt(b, k);
    trail.push([p.x, p.y - p.r]);
  }
  const mono: React.CSSProperties = { fontFamily: th.mono, fontSize: 14, letterSpacing: "0.12em" };
  const xs = Math.min(b.x0, b.x1) - 160;
  const xe = Math.max(b.x0, b.x1) + 160;
  return (
    <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
      <g opacity={guides}>
        <line x1={xs} x2={xe} y1={b.floor + 0.5} y2={b.floor + 0.5} stroke={rgba(th.cream, 0.22)} strokeWidth={1} />
        {trail.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={2.4} fill={rgba(th.cream, 0.5)} />
        ))}
        {b.contacts
          .filter((c) => t >= c)
          .map((c) => {
            const p = bounceAt(b, c);
            return (
              <g key={c}>
                <line x1={p.x} x2={p.x} y1={b.floor} y2={b.floor + 10} stroke={rgba(th.cream, 0.5)} />
                <text x={p.x} y={b.floor + 32} textAnchor="middle" fill={rgba(th.cream, 0.55)} style={mono}>
                  F{c + frameOffset}
                </text>
              </g>
            );
          })}
        <line x1={s.x} x2={s.x} y1={b.floor - 330} y2={b.floor} stroke={rgba(th.cream, 0.25)} />
        <rect x={s.x - 34} y={b.floor - 362} width={68} height={24} rx={3} fill={th.accent} />
        <text x={s.x} y={b.floor - 345} textAnchor="middle" fill={th.ink} style={{ ...mono, fontWeight: 600 }}>
          F{Math.round(t) + frameOffset}
        </text>
      </g>
      <ellipse cx={s.x} cy={s.y - s.r * sy} rx={s.r * sx} ry={s.r * sy} fill={th.cream} opacity={ballAlpha} />
    </svg>
  );
};
