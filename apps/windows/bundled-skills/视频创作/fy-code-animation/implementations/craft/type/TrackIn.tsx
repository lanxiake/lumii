// Adapted from renoise-ai/renoise-skills; see LICENSES/renoise-MIT.txt and implementations/craft/README.md.
import React from "react";
import { useCurrentFrame } from "remotion";
import { E, clamp01, mix } from "../motion";

/** Luxury reveal: letters arrive wide apart and breathe in to their final tracking. */
export const TrackIn: React.FC<{ text: string; family: string; size: number; weight?: number; at?: number; dur?: number; from?: number; to?: number; color?: string; style?: React.CSSProperties }> = ({ text, family, size, weight = 400, at = 0, dur = 40, from = 0.5, to = 0.02, color = "currentColor", style }) => {
  const f = useCurrentFrame();
  const p = E.out(clamp01((f - at) / dur));
  return <div style={{ fontFamily: family, fontSize: size, fontWeight: weight, color, letterSpacing: `${mix(from, to, p)}em`, opacity: clamp01(p * 1.6), filter: p < 1 ? `blur(${(1 - p) * 4}px)` : undefined, whiteSpace: "pre", fontSynthesis: "none", ...style }}>{text}</div>;
};
