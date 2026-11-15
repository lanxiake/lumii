import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { clamp01, mixHex, rand, timecode, type SpecimenTheme } from "./theme";

export type Chapter = { at: number; no: string; name: string; dim: string };
export type Caption = { from: number; to: number; text: string | ((f: number) => string) };

const GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789×·→";

/** Type-on with a short scramble for not-yet-settled characters. */
const scramble = (text: string, f: number, from: number, seed: number) => {
  const p = (f - from) / 10;
  return Array.from(text)
    .map((ch, i) => {
      if (ch === " ") return ch;
      const k = p * text.length - i;
      if (k >= 1.2) return ch;
      if (k <= 0) return " ";
      return GLYPHS[Math.floor(rand(i + Math.floor(f) * 7, seed) * GLYPHS.length)];
    })
    .join("");
};

/**
 * Spec-sheet chrome: corner marks, film title, format line, chapter number + name + dimension,
 * timecode, a progress rule with chapter ticks, and one technical caption at top centre.
 * `light` lists frame ranges with a light background (the HUD turns ink there).
 */
export const SpecimenHud: React.FC<{
  th: SpecimenTheme;
  title: string;
  spec: string | ((scale: number) => string); // a function receives the render scale (2 for 4K)
  chapters: Chapter[];
  total: number;
  fps: number;
  light?: [number, number][];
  captions?: Caption[];
  hideAt?: number;
}> = ({ th, title, spec, chapters, total, fps, light = [], captions = [], hideAt = Infinity }) => {
  const f = useCurrentFrame();
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const l = light.reduce((acc, [a, b]) => Math.max(acc, clamp01((f - a + 1) / 4) * clamp01((b - f + 1) / 4)), 0);
  const col = mixHex(th.cream, th.ink, l, 0.78);
  const dim = mixHex(th.cream, th.ink, l, 0.36);
  const halo = mixHex(th.ink, th.paper, l, 0.9);
  const vis = clamp01((f - 4) / 10) * (1 - clamp01((f - hideAt) / 10));
  if (vis <= 0) return null;
  const ci = Math.max(0, chapters.filter((c) => f >= c.at).length - 1);
  const ch = chapters[ci];
  const roll = clamp01((f - ch.at) / 8);
  const prev = ci > 0 ? chapters[ci - 1] : null;
  const font: React.CSSProperties = { fontFamily: th.mono, fontSize: 15, letterSpacing: "0.2em", textTransform: "uppercase", color: col, whiteSpace: "pre", textShadow: `0 0 6px ${halo}, 0 0 14px ${halo}, 0 0 22px ${halo}` };
  const mark = (s: React.CSSProperties) => <div style={{ position: "absolute", width: 22, height: 22, borderColor: col, borderStyle: "solid", borderWidth: 0, ...s }} />;
  const cap = captions.find((c) => f >= c.from && f < c.to);
  const capText = cap ? (typeof cap.text === "function" ? cap.text(f) : cap.text) : "";
  const capAlpha = cap ? clamp01((cap.to - f) / 6) : 0;
  const label = (c: Chapter) => (
    <span>
      {c.no}  {c.name}  <span style={{ color: dim }}>·  {c.dim}</span>
    </span>
  );
  const W = 1920 - 160;
  return (
    <AbsoluteFill style={{ opacity: vis, pointerEvents: "none" }}>
      {mark({ left: 44, top: 44, borderLeftWidth: 1.5, borderTopWidth: 1.5 })}
      {mark({ right: 44, top: 44, borderRightWidth: 1.5, borderTopWidth: 1.5 })}
      {mark({ left: 44, bottom: 44, borderLeftWidth: 1.5, borderBottomWidth: 1.5 })}
      {mark({ right: 44, bottom: 44, borderRightWidth: 1.5, borderBottomWidth: 1.5 })}
      <div style={{ ...font, position: "absolute", left: 80, top: 58 }}>{title}</div>
      <div style={{ ...font, position: "absolute", right: 80, top: 58 }}>{typeof spec === "function" ? spec(dpr) : spec}</div>
      <div style={{ ...font, position: "absolute", left: 80, bottom: 52, height: 20, overflow: "hidden", width: 600 }}>
        {prev && roll < 1 && <div style={{ position: "absolute", top: -20 * roll }}>{label(prev)}</div>}
        <div style={{ position: "absolute", top: prev ? 20 * (1 - roll) : 0 }}>{label(ch)}</div>
      </div>
      <div style={{ ...font, position: "absolute", right: 80, bottom: 52 }}>TC {timecode(f, fps)}</div>
      <div style={{ position: "absolute", left: 80, bottom: 40, width: W, height: 1, background: dim }} />
      <div style={{ position: "absolute", left: 80, bottom: 40, width: W * clamp01(f / total), height: 1, background: col }} />
      {chapters.map((c) => (
        <div key={c.no} style={{ position: "absolute", left: 80 + W * (c.at / total), bottom: 37, width: 1, height: 7, background: f >= c.at ? col : dim }} />
      ))}
      {cap && (
        <div style={{ ...font, textTransform: "none", position: "absolute", left: 0, right: 0, top: 118, textAlign: "center", opacity: capAlpha, color: col }}>
          {scramble(capText, f, cap.from, cap.from)}
        </div>
      )}
    </AbsoluteFill>
  );
};
