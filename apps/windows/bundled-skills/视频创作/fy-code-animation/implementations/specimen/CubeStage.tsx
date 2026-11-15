import React from "react";
import { AbsoluteFill } from "remotion";
import { SpecimenCanvas, SQUARE, type Draw, type Region } from "./SpecimenCanvas";
import { clamp01, easeInOut, mix, rand, rgba, type SpecimenTheme } from "./theme";

/**
 * "Six planes → one volume" (style-pack-03, the collect beat).
 * Live specimens gather from full screen into a 3×2 grid, re-arrange into a cube net, fold into a cube
 * (CSS 3D, the same DOM elements, so the hand-off is seamless), become a 3×3×3 Rubik's cube, twist and explode.
 * Face order everywhere: 0 front, 1 right, 2 back, 3 left, 4 top, 5 bottom.
 */
export type CubeFace = { draw: Draw; t: number };
export type CubeState = {
  grid: number; // 0..1 hero panel (full screen) → 3×2 grid
  net: number; // 0..1 grid → cross-shaped net
  fold: number; // 0..1 net folds into a cube
  rx: number; // deg
  ry: number; // deg
  lift: number; // px
  scale: number;
  rubik: number; // 0..1 gaps open between 27 cubelets
  twists: number[]; // progress 0..1 of each twist in TWISTS
  explode: number; // 0..1
};

type V3 = [number, number, number];
type M3 = [V3, V3, V3]; // rows

const NET: [number, number][] = [
  [1, 1], // front
  [2, 1], // right
  [3, 1], // back
  [0, 1], // left
  [1, 0], // top
  [1, 2], // bottom
];
const NORMALS: V3[] = [
  [0, 0, 1],
  [1, 0, 0],
  [0, 0, -1],
  [-1, 0, 0],
  [0, -1, 0],
  [0, 1, 0],
];
const FACE_T = (s: number) => [
  `translateZ(${s / 2}px)`,
  `rotateY(90deg) translateZ(${s / 2}px)`,
  `rotateY(180deg) translateZ(${s / 2}px)`,
  `rotateY(-90deg) translateZ(${s / 2}px)`,
  `rotateX(90deg) translateZ(${s / 2}px)`,
  `rotateX(-90deg) translateZ(${s / 2}px)`,
];
/** Top layer turns about y, then the right layer about x. */
export const TWISTS: { axis: 0 | 1 | 2; layer: number; dir: number }[] = [
  { axis: 1, layer: -1, dir: 1 },
  { axis: 0, layer: 1, dir: -1 },
];

const LIGHT: V3 = (() => {
  const v: V3 = [-0.35, -0.8, 0.5];
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
})();

const rotX = (a: number): M3 => [
  [1, 0, 0],
  [0, Math.cos(a), -Math.sin(a)],
  [0, Math.sin(a), Math.cos(a)],
];
const rotY = (a: number): M3 => [
  [Math.cos(a), 0, Math.sin(a)],
  [0, 1, 0],
  [-Math.sin(a), 0, Math.cos(a)],
];
const rotZ = (a: number): M3 => [
  [Math.cos(a), -Math.sin(a), 0],
  [Math.sin(a), Math.cos(a), 0],
  [0, 0, 1],
];
const ROT = [rotX, rotY, rotZ];
const mulMV = (m: M3, v: V3): V3 => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];
const mulMM = (a: M3, b: M3): M3 => [0, 1, 2].map((r) => [0, 1, 2].map((c) => a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c])) as M3;
const I3: M3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const norm = (v: V3): V3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const deg = (d: number) => (d * Math.PI) / 180;

/** Screen-space view rotation that matches CSS `rotateX(rx) rotateY(ry)`. */
const viewM = (rx: number, ry: number) => mulMM(rotX(deg(rx)), rotY(deg(ry)));
const shadeOf = (n: V3) => {
  const d = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
  return 1 - (0.5 + 0.5 * d);
};

/** Which sticker (face, row, col) sits on cubelet (i, j, k) facing `face`. */
const stickerOf = (face: number, i: number, j: number, k: number): [number, number] => {
  switch (face) {
    case 0:
      return [j + 1, i + 1];
    case 1:
      return [j + 1, 1 - k];
    case 2:
      return [j + 1, 1 - i];
    case 3:
      return [j + 1, k + 1];
    case 4:
      return [k + 1, i + 1];
    default:
      return [1 - k, i + 1];
  }
};
const isOuter = (face: number, i: number, j: number, k: number) =>
  (face === 0 && k === 1) || (face === 1 && i === 1) || (face === 2 && k === -1) || (face === 3 && i === -1) || (face === 4 && j === -1) || (face === 5 && j === 1);

type Rect = { x: number; y: number; w: number; h: number };
const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({ x: mix(a.x, b.x, t), y: mix(a.y, b.y, t), w: mix(a.w, b.w, t), h: mix(a.h, b.h, t) });

export const CubeStage: React.FC<{
  th: SpecimenTheme;
  faces: CubeFace[];
  st: CubeState;
  gridOrder: number[]; // face index shown in each 3×2 grid cell (row-major)
  heroCell: number; // grid cell that starts full screen
  S?: number;
  bg?: string;
  res?: number;
}> = ({ th, faces, st, gridOrder, heroCell, S = 300, bg, res = 1.5 }) => {
  const shift = (-S / 2) * (1 - st.fold);
  const netRect = (f: number): Rect => ({ x: 960 - S / 2 + (NET[f][0] - 1) * S - S / 2, y: 540 - S / 2 + (NET[f][1] - 1) * S, w: S, h: S });
  const gw = 560;
  const gh = 315;
  const gridRect = (k: number): Rect => ({ x: 96 + (k % 3) * (gw + 24), y: 213 + Math.floor(k / 3) * (gh + 24), w: gw, h: gh });
  const V = viewM(st.rx, st.ry);
  const floorY = 540 + S * 0.95;

  const face2d = (k: number) => {
    const f = gridOrder[k];
    const e1 = easeInOut(clamp01(st.grid * 1.5 - (k === heroCell ? 0 : 0.1 + k * 0.06)));
    const e2 = easeInOut(clamp01(st.net * 1.5 - k * 0.08));
    const start = k === heroCell ? { x: 0, y: 0, w: 1920, h: 1080 } : { ...gridRect(k), y: gridRect(k).y + 1100 };
    const r = lerpRect(lerpRect(start, gridRect(k), e1), netRect(f), e2);
    return (
      <div key={k} style={{ position: "absolute", left: r.x, top: r.y, width: r.w, height: r.h, overflow: "hidden", boxShadow: `0 ${10 * e1}px ${40 * e1}px ${rgba(th.ink, 0.12 * e1)}` }}>
        <SpecimenCanvas draw={faces[f].draw} t={faces[f].t} w={r.w} h={r.h} res={k === heroCell && e1 < 0.2 ? 1 : res} />
      </div>
    );
  };

  const content = (f: number, region: Region, size: number, dark: number) => (
    <>
      <SpecimenCanvas draw={faces[f].draw} t={faces[f].t} w={size} h={size} region={region} res={res} />
      {dark > 0.01 && <div style={{ position: "absolute", inset: 0, background: rgba("#2A2418", dark * 0.8) }} />}
    </>
  );

  const foldCube = () => {
    const node = (f: number, style: React.CSSProperties, kids?: React.ReactNode) => {
      const n = norm([mix(0, NORMALS[f][0], st.fold), mix(0, NORMALS[f][1], st.fold), mix(1, NORMALS[f][2], st.fold)]);
      const dark = shadeOf(mulMV(V, n)) * clamp01(st.fold * 1.4);
      return (
        <div style={{ position: "absolute", width: S, height: S, transformStyle: "preserve-3d", ...style }}>
          <div style={{ position: "absolute", inset: 0, backfaceVisibility: "hidden", overflow: "hidden" }}>{content(f, SQUARE, S, dark)}</div>
          {kids}
        </div>
      );
    };
    const a = st.fold * 90;
    return node(
      0,
      { left: -S / 2, top: -S / 2 },
      <>
        {node(3, { left: -S, top: 0, transformOrigin: "100% 50%", transform: `rotateY(${-a}deg)` })}
        {node(1, { left: S, top: 0, transformOrigin: "0% 50%", transform: `rotateY(${a}deg)` }, node(2, { left: S, top: 0, transformOrigin: "0% 50%", transform: `rotateY(${a}deg)` }))}
        {node(4, { left: 0, top: -S, transformOrigin: "50% 100%", transform: `rotateX(${a}deg)` })}
        {node(5, { left: 0, top: S, transformOrigin: "50% 0%", transform: `rotateX(${-a}deg)` })}
      </>,
    );
  };

  const rubik = () => {
    const s = S / 3;
    const gap = st.rubik * S * 0.07;
    const out: React.ReactNode[] = [];
    const ft = FACE_T(s);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (let k = -1; k <= 1; k++) {
          let P: V3 = [i, j, k];
          let M: M3 = I3;
          TWISTS.forEach((tw, q) => {
            const p = easeInOut(clamp01(st.twists[q] ?? 0));
            if (p <= 0 || Math.round(P[tw.axis]) !== tw.layer) return;
            const R = ROT[tw.axis]((tw.dir * Math.PI * p) / 2);
            P = mulMV(R, P);
            M = mulMM(R, M);
          });
          const id = (i + 1) * 9 + (j + 1) * 3 + (k + 1);
          let pos: V3 = [P[0] * (s + gap), P[1] * (s + gap), P[2] * (s + gap)];
          let op = 1;
          if (st.explode > 0) {
            const e = st.explode;
            const dir = norm([P[0] + (rand(id, 1) - 0.5) * 0.8, P[1] - 0.6 + (rand(id, 2) - 0.5) * 0.8, P[2] + (rand(id, 3) - 0.5) * 0.8]);
            const dist = Math.pow(e, 1.1) * (700 + rand(id, 4) * 600);
            pos = [pos[0] + dir[0] * dist, pos[1] + dir[1] * dist + e * e * 900, pos[2] + dir[2] * dist];
            M = mulMM(mulMM(rotX(e * (rand(id, 5) - 0.5) * 9), rotY(e * (rand(id, 6) - 0.5) * 9)), M);
            op = 1 - clamp01((e - 0.7) / 0.3);
          }
          const m3d = `matrix3d(${M[0][0]},${M[1][0]},${M[2][0]},0,${M[0][1]},${M[1][1]},${M[2][1]},0,${M[0][2]},${M[1][2]},${M[2][2]},0,${pos[0]},${pos[1]},${pos[2]},1)`;
          for (let f = 0; f < 6; f++) {
            const outer = isOuter(f, i, j, k);
            const n = mulMV(V, mulMV(M, NORMALS[f]));
            const style: React.CSSProperties = {
              position: "absolute",
              left: 0,
              top: 0,
              width: s,
              height: s,
              transformOrigin: "0 0",
              transform: `${m3d} ${ft[f]} translate3d(${-s / 2}px, ${-s / 2}px, 0)`,
              backfaceVisibility: "hidden",
              overflow: "hidden",
              opacity: op,
            };
            if (!outer) {
              if (gap < 0.5 && st.explode <= 0) continue;
              out.push(<div key={`${id}-${f}`} style={{ ...style, background: th.ink }} />);
              continue;
            }
            const [row, col] = stickerOf(f, i, j, k);
            const region: Region = { x: SQUARE.x + col * (SQUARE.w / 3), y: row * (SQUARE.h / 3), w: SQUARE.w / 3, h: SQUARE.h / 3 };
            out.push(
              <div key={`${id}-${f}`} style={{ ...style, outline: gap > 0.5 ? `1.5px solid ${rgba(th.ink, 0.5)}` : undefined }}>
                {content(f, region, s, shadeOf(n))}
              </div>,
            );
          }
        }
    return out;
  };

  const threeD = st.fold > 0 || st.rubik > 0;
  const worldT = `translate3d(${960 + shift}px, ${540 - st.lift}px, ${(-S / 2) * st.fold}px) rotateX(${st.rx}deg) rotateY(${st.ry}deg) scale3d(${st.scale},${st.scale},${st.scale})${
    st.rubik > 0 ? "" : ` translate3d(0, 0, ${(S / 2) * st.fold}px)`
  }`;
  const shadowA = 0.3 * clamp01(st.fold * 1.5) * (1 - clamp01(st.explode * 2));
  return (
    <AbsoluteFill style={{ background: bg ?? th.paper2 }}>
      <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 45%, transparent 40%, ${rgba(th.ink, 0.1)} 100%)` }} />
      {threeD && shadowA > 0 && (
        <div
          style={{
            position: "absolute",
            left: 960 - S * 0.8 * st.scale + st.lift * 0.3,
            top: floorY - S * 0.16,
            width: S * 1.6 * st.scale,
            height: S * 0.32,
            borderRadius: "50%",
            background: rgba("#3A3020", shadowA * (1 - st.lift / 700)),
            filter: `blur(${22 + st.lift * 0.08}px)`,
          }}
        />
      )}
      {!threeD && gridOrder.map((_, k) => face2d(k))}
      {threeD && (
        <AbsoluteFill style={{ perspective: 2600, perspectiveOrigin: "960px 540px" }}>
          <div style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0, transformStyle: "preserve-3d", transform: worldT }}>{st.rubik > 0 ? rubik() : foldCube()}</div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
