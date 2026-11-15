import React, { useLayoutEffect, useRef } from "react";
import { BASE_H, BASE_W } from "./theme";

/** A drawer paints one frame of a specimen in 1920×1080 base space. */
export type Draw = (g: CanvasRenderingContext2D, t: number) => void;
export type Region = { x: number; y: number; w: number; h: number };

/** The square of base space that a square face shows when cover-fitted. */
export const SQUARE: Region = { x: (BASE_W - BASE_H) / 2, y: 0, w: BASE_H, h: BASE_H };

/**
 * Renders a drawer into a canvas of any size. `region` picks the part of base space to show
 * (cover-fitted), so the same specimen can fill the screen, a grid panel, a cube face or one Rubik sticker.
 */
export const SpecimenCanvas: React.FC<{
  draw: Draw;
  t: number;
  w?: number;
  h?: number;
  region?: Region;
  res?: number;
  style?: React.CSSProperties;
}> = ({ draw, t, w = BASE_W, h = BASE_H, region = { x: 0, y: 0, w: BASE_W, h: BASE_H }, res = 1, style }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  // follow the render scale (`--scale=2` for 4K) so canvases stay sharp
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const pw = Math.max(1, Math.round(w * res * dpr));
  const ph = Math.max(1, Math.round(h * res * dpr));
  useLayoutEffect(() => {
    const g = ref.current?.getContext("2d");
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, pw, ph);
    const s = Math.max(pw / region.w, ph / region.h);
    g.setTransform(s, 0, 0, s, (pw - region.w * s) / 2 - region.x * s, (ph - region.h * s) / 2 - region.y * s);
    g.save();
    draw(g, t);
    g.restore();
  });
  return <canvas ref={ref} width={pw} height={ph} style={{ width: w, height: h, display: "block", ...style }} />;
};
