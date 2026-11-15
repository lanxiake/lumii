import React, { useId } from "react";
import { clamp01, easeOut, mix, rgba, type SpecimenTheme } from "./theme";

/** Output of scripts/glyph_outline.py (font units, y up). */
export type GlyphData = {
  char: string;
  font: string;
  upm: number;
  ascender: number;
  descender: number;
  xHeight: number;
  capHeight: number;
  advance: number;
  d: string;
  contours: [number, number, number][][];
};

export const glyphPoints = (g: GlyphData) => g.contours.reduce((s, c) => s + c.length, 0);

/**
 * Type-design specimen ("details make the design"): a glyph's metric lines, its outline drawing on,
 * on-curve anchors (squares), off-curve controls (circles) with handles, the fill, and a loupe that
 * magnifies one point and prints its real font coordinates.
 */
export const GlyphAnatomy: React.FC<{
  th: SpecimenTheme;
  glyph: GlyphData;
  x: number; // left edge of the advance box (px)
  baseline: number; // px
  size: number; // em size in px
  metrics?: number;
  outline?: number;
  points?: number;
  fill?: number;
  loupe?: number;
  loupeAt?: { x: number; y: number; r: number; point: [number, number]; zoom?: number };
}> = ({ th, glyph, x, baseline, size, metrics = 0, outline = 0, points = 0, fill = 0, loupe = 0, loupeAt }) => {
  const clipId = `glyph-loupe-${useId().replace(/:/g, "")}`;
  const k = size / glyph.upm;
  const px = (u: number) => x + u * k;
  const py = (v: number) => baseline - v * k;
  const w = glyph.advance * k;
  const lines: [string, number][] = [
    ["ASCENDER", glyph.ascender],
    ["X-HEIGHT", glyph.xHeight],
    ["BASELINE", 0],
    ["DESCENDER", glyph.descender],
  ];
  const mono: React.CSSProperties = { fontFamily: th.mono, fontSize: 13, letterSpacing: "0.16em" };
  const all = glyph.contours.flatMap((c, ci) => c.map((p, i) => ({ p, ci, i, n: c.length })));
  const total = all.length;

  const drawing = (stroke: number, dot: number) => (
    <>
      <g transform={`translate(${x} ${baseline}) scale(${k} ${-k})`}>
        {fill > 0 && <path d={glyph.d} fill={rgba(th.ink, 0.92 * fill)} />}
        <path d={glyph.d} fill="none" stroke={th.ink} strokeWidth={stroke / k} pathLength={1} strokeDasharray={`${outline} 1`} />
      </g>
      {all.map(({ p, ci, i, n }, idx) => {
        const a = clamp01(points * 1.4 - (idx / total) * 0.4);
        if (a <= 0) return null;
        const c = glyph.contours[ci];
        const nxt = c[(i + 1) % n];
        const handle = (p[2] === 0 || nxt[2] === 0) && (
          <line x1={px(p[0])} y1={py(p[1])} x2={px(nxt[0])} y2={py(nxt[1])} stroke={rgba(th.accent2, 0.9)} strokeWidth={stroke * 0.7} opacity={a} />
        );
        const s = dot * easeOut(a);
        return (
          <g key={idx}>
            {handle}
            {p[2] ? (
              <rect x={px(p[0]) - s} y={py(p[1]) - s} width={s * 2} height={s * 2} fill={th.paper} stroke={th.ink} strokeWidth={stroke} />
            ) : (
              <circle cx={px(p[0])} cy={py(p[1])} r={s} fill={th.paper} stroke={th.accent2} strokeWidth={stroke} />
            )}
          </g>
        );
      })}
    </>
  );

  const L = loupeAt;
  const zoom = L?.zoom ?? 4;
  const lp = L ? { x: px(L.point[0]), y: py(L.point[1]) } : { x: 0, y: 0 };
  const la = easeOut(loupe);
  return (
    <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
      {lines.filter(([, v]) => py(v) > 110 && py(v) < 1000).map(([name, v], i) => {
        const m = clamp01(metrics * 1.4 - i * 0.12);
        if (m <= 0) return null;
        const x0 = x - 120;
        const x1 = mix(x0, x + w + 120, easeOut(m));
        return (
          <g key={name}>
            <line x1={x0} x2={x1} y1={py(v)} y2={py(v)} stroke={rgba(th.ink, name === "BASELINE" ? 0.55 : 0.28)} strokeWidth={1} strokeDasharray={name === "BASELINE" ? undefined : "4 5"} />
            <text x={x0} y={py(v) - 8} fill={rgba(th.ink, 0.55 * m)} style={mono}>
              {name} {v}
            </text>
          </g>
        );
      })}
      {metrics > 0 && (
        <g opacity={clamp01(metrics * 2 - 1)}>
          <line x1={x} x2={x} y1={py(glyph.ascender) - 20} y2={py(glyph.descender) + 20} stroke={rgba(th.ink, 0.18)} />
          <line x1={x + w} x2={x + w} y1={py(glyph.ascender) - 20} y2={py(glyph.descender) + 20} stroke={rgba(th.ink, 0.18)} />
          <text x={x + w / 2} y={py(glyph.descender) + 48} textAnchor="middle" fill={rgba(th.ink, 0.5)} style={mono}>
            ADVANCE {glyph.advance}
          </text>
        </g>
      )}
      {drawing(1.6, 5)}
      {L && la > 0 && (
        <g opacity={la}>
          <defs>
            <clipPath id={clipId}>
              <circle cx={L.x} cy={L.y} r={L.r * la} />
            </clipPath>
          </defs>
          <line x1={lp.x} y1={lp.y} x2={L.x - (L.x - lp.x) * (L.r / Math.max(1e-6, Math.hypot(L.x - lp.x, L.y - lp.y)))} y2={L.y - (L.y - lp.y) * (L.r / Math.max(1e-6, Math.hypot(L.x - lp.x, L.y - lp.y)))} stroke={rgba(th.ink, 0.35)} />
          <circle cx={L.x} cy={L.y} r={L.r * la} fill={th.paper} />
          <g clipPath={`url(#${clipId})`}>
            <g transform={`translate(${L.x} ${L.y}) scale(${zoom}) translate(${-lp.x} ${-lp.y})`}>{drawing(1.6 / zoom, 5 / zoom)}</g>
          </g>
          <circle cx={L.x} cy={L.y} r={L.r * la} fill="none" stroke={th.ink} strokeWidth={1.5} />
          <text x={L.x} y={L.y + L.r + 32} textAnchor="middle" fill={rgba(th.ink, 0.6)} style={mono}>
            X {L.point[0]}  ·  Y {L.point[1]}
          </text>
          <text x={L.x} y={L.y + L.r + 54} textAnchor="middle" fill={rgba(th.ink, 0.45)} style={mono}>
            1 UNIT = {k.toFixed(2)} PX
          </text>
        </g>
      )}
    </svg>
  );
};
