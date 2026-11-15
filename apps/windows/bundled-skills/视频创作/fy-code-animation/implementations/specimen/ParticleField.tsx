import React, { useEffect, useMemo, useState } from "react";
import { useThree } from "@react-three/fiber";
import { ThreeCanvas } from "@remotion/three";
import { cancelRender, continueRender, delayRender } from "remotion";
import * as THREE from "three";
import { rand, type SpecimenTheme } from "./theme";

/**
 * 05 FIELD: 60,000 GPU particles in one ShaderMaterial. Every particle carries five target positions
 * (sphere shell, galaxy, text, image/logo, line) and the shader blends between them — all a pure function
 * of the uniforms, so frames render independently. World units are pixels at z = 0.
 */
export const PARTICLES = 60000;

export type FieldState = {
  stage: number; // 0 sphere · 1 galaxy · 2 text · 3 image · 4 line (fractional = morphing)
  burst: number; // outward explosion
  noise: number; // curl-ish drift amplitude (px)
  spin: number; // galaxy rotation (rad)
  point: number; // 0..1 collapse to a single point
  t: number; // time in frames
  alpha?: number;
  tiltX?: number;
  rotY?: number;
};

const VERT = /* glsl */ `
uniform float uStage, uBurst, uNoise, uSpin, uPoint, uT, uSize, uPx;
attribute vec3 aA; attribute vec3 aB; attribute vec3 aC; attribute vec3 aD; attribute vec3 aE;
attribute vec4 aRnd; attribute vec3 aCol;
varying vec3 vCol; varying float vA;
vec3 hash3(vec3 p){ p = fract(p * vec3(.1031,.1030,.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx) * 2.0 - 1.0; }
float vnoise(vec3 p){ vec3 i = floor(p); vec3 f = fract(p); f = f*f*(3.0-2.0*f);
  float n = mix(mix(mix(dot(hash3(i), f), dot(hash3(i+vec3(1,0,0)), f-vec3(1,0,0)), f.x),
                    mix(dot(hash3(i+vec3(0,1,0)), f-vec3(0,1,0)), dot(hash3(i+vec3(1,1,0)), f-vec3(1,1,0)), f.x), f.y),
                mix(mix(dot(hash3(i+vec3(0,0,1)), f-vec3(0,0,1)), dot(hash3(i+vec3(1,0,1)), f-vec3(1,0,1)), f.x),
                    mix(dot(hash3(i+vec3(0,1,1)), f-vec3(0,1,1)), dot(hash3(i+vec3(1,1,1)), f-vec3(1,1,1)), f.x), f.y), f.z);
  return n; }
vec3 galaxy(vec3 p){ float r = length(p.xz); float a = uSpin * (0.6 + 260.0 / (r + 90.0));
  float c = cos(a), s = sin(a); return vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c); }
vec3 target(float i){
  if (i < 0.5) return aA;
  if (i < 1.5) { vec3 g = galaxy(aB); float tx = 1.05; return vec3(g.x, g.y * cos(tx) - g.z * sin(tx), g.y * sin(tx) + g.z * cos(tx)); }
  if (i < 2.5) return aC;
  if (i < 3.5) return aD;
  return aE; }
void main(){
  float s0 = floor(uStage); float f = uStage - s0;
  float k = smoothstep(0.0, 1.0, clamp(f * 1.7 - aRnd.x * 0.7, 0.0, 1.0));
  vec3 p = mix(target(s0), target(min(s0 + 1.0, 4.0)), k);
  p *= 1.0 + uBurst * (0.35 + aRnd.y * 1.2);
  vec3 q = p * 0.0032 + vec3(0.0, 0.0, uT * 0.012) + aRnd.yzw * 3.0;
  p += uNoise * vec3(vnoise(q), vnoise(q + 17.3), vnoise(q + 41.9));
  float pk = smoothstep(0.0, 1.0, clamp(uPoint * 1.5 - aRnd.z * 0.5, 0.0, 1.0));
  p = mix(p, vec3(0.0), pk);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * (0.55 + aRnd.w * 0.9) * (uPx / -mv.z);
  vCol = aCol; vA = 0.55 + 0.45 * aRnd.y;
}`;

const FRAG = /* glsl */ `
uniform float uAlpha; varying vec3 vCol; varying float vA;
void main(){ vec2 c = gl_PointCoord - 0.5; float d = length(c); if (d > 0.5) discard;
  float a = (1.0 - smoothstep(0.08, 0.5, d)) * uAlpha * vA; gl_FragColor = vec4(vCol, a); }`;

type Targets = { text: Float32Array; image: Float32Array };

const samplePoints = (paint: (g: CanvasRenderingContext2D) => void, step = 2) => {
  const c = document.createElement("canvas");
  c.width = 1920;
  c.height = 1080;
  const g = c.getContext("2d")!;
  paint(g);
  const d = g.getImageData(0, 0, 1920, 1080).data;
  const pts: number[] = [];
  for (let y = 0; y < 1080; y += step) for (let x = 0; x < 1920; x += step) if (d[(y * 1920 + x) * 4 + 3] > 140) pts.push(x - 960, 540 - y);
  return pts;
};

const fill = (pts: number[], n: number, seed: number, depth: number) => {
  const out = new Float32Array(n * 3);
  if (!pts.length) throw new Error("Particle target is empty: verify font coverage, image alpha and dimensions");
  const m = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = Math.floor(rand(i, seed) * m) * 2;
    out[i * 3] = (pts[j] ?? 0) + (rand(i, seed + 1) - 0.5) * 1.6;
    out[i * 3 + 1] = (pts[j + 1] ?? 0) + (rand(i, seed + 2) - 0.5) * 1.6;
    out[i * 3 + 2] = (rand(i, seed + 3) - 0.5) * depth;
  }
  return out;
};

/** Loads fonts/images and samples the text and image targets once (delayRender until ready). */
export const useFieldTargets = (text: { value: string; font: string }, imageSrc: string, imageSize: number): Targets | null => {
  const [targets, setTargets] = useState<Targets | null>(null);
  const [handle] = useState(() => delayRender("particle targets"));
  useEffect(() => {
    let alive = true;
    const img = new Image();
    const imgReady = new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error(`image ${imageSrc}`));
    });
    img.crossOrigin = "anonymous";
    img.src = imageSrc;
    let settled = false;
    // delayRender 必须恰好 settle 一次：成功 continue，失败或提前卸载 cancel。
    // 漏掉任何一条，资源 404 / 字体缺字 / 中途卸载都会让 Remotion 一直等到超时。
    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) cancelRender(error instanceof Error ? error : new Error(String(error)));
      else continueRender(handle);
    };
    Promise.all([document.fonts.load(text.font, text.value), imgReady]).then(() => {
      if (!alive) { settle(new Error("particle targets unmounted before ready")); return; }
      const tp = samplePoints((g) => {
        g.fillStyle = "#fff";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.font = text.font;
        g.fillText(text.value, 960, 540);
      });
      const ip = samplePoints((g) => g.drawImage(img, 960 - imageSize / 2, 540 - imageSize / 2, imageSize, imageSize));
      setTargets({ text: fill(tp, PARTICLES, 31, 10), image: fill(ip, PARTICLES, 47, 14) });
      settle();
    }).catch((error) => {
      settle(error);
    });
    return () => {
      alive = false;
      settle(new Error("particle targets unmounted"));
    };
  }, [handle, imageSrc, imageSize, text.font, text.value]);
  return targets;
};

const Points: React.FC<{ th: SpecimenTheme; s: FieldState; targets: Targets; R: number }> = ({ th, s, targets, R }) => {
  const { gl } = useThree();
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const n = PARTICLES;
    const A = new Float32Array(n * 3);
    const B = new Float32Array(n * 3);
    const E = new Float32Array(n * 3);
    const rnd = new Float32Array(n * 4);
    const col = new Float32Array(n * 3);
    const cream = new THREE.Color(th.cream);
    const extra = (th.sprinkle.length ? th.sprinkle : [th.cream]).map((c) => new THREE.Color(c));
    const golden = Math.PI * (3 - Math.sqrt(5));
    const srgb = { r: 0, g: 0, b: 0 };
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / (n - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th0 = golden * i;
      const rr = R * (1 + (rand(i, 2) - 0.5) * 0.015);
      A[i * 3] = Math.cos(th0) * r * rr;
      A[i * 3 + 1] = y * rr;
      A[i * 3 + 2] = Math.sin(th0) * r * rr;
      const arm = i % 3;
      const gr = 30 + Math.pow(rand(i, 3), 0.75) * 760;
      const ga = (arm * Math.PI * 2) / 3 + gr * 0.0065 + (rand(i, 4) - 0.5) * 0.5 * (1 - gr / 900);
      B[i * 3] = Math.cos(ga) * gr + (rand(i, 5) - 0.5) * 40;
      B[i * 3 + 1] = (rand(i, 6) - 0.5) * 60 * (1 - gr / 900);
      B[i * 3 + 2] = Math.sin(ga) * gr + (rand(i, 7) - 0.5) * 40;
      E[i * 3] = (rand(i, 8) - 0.5) * 1500;
      E[i * 3 + 1] = (rand(i, 9) + rand(i, 10) - 1) * 4;
      E[i * 3 + 2] = (rand(i, 11) - 0.5) * 30;
      rnd.set([rand(i, 12), rand(i, 13), rand(i, 14), rand(i, 15)], i * 4);
      const c = rand(i, 16) < 0.8 ? cream : extra[Math.floor(rand(i, 17) * extra.length)];
      c.getRGB(srgb, THREE.SRGBColorSpace);
      col.set([srgb.r, srgb.g, srgb.b], i * 3);
    }
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("aA", new THREE.BufferAttribute(A, 3));
    g.setAttribute("aB", new THREE.BufferAttribute(B, 3));
    g.setAttribute("aC", new THREE.BufferAttribute(targets.text, 3));
    g.setAttribute("aD", new THREE.BufferAttribute(targets.image, 3));
    g.setAttribute("aE", new THREE.BufferAttribute(E, 3));
    g.setAttribute("aRnd", new THREE.BufferAttribute(rnd, 4));
    g.setAttribute("aCol", new THREE.BufferAttribute(col, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    return g;
  }, [th, targets, R]);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uStage: { value: 0 },
          uBurst: { value: 0 },
          uNoise: { value: 0 },
          uSpin: { value: 0 },
          uPoint: { value: 0 },
          uT: { value: 0 },
          uSize: { value: 2.6 },
          uPx: { value: 2015 },
          uAlpha: { value: 1 },
        },
      }),
    [],
  );
  const u = mat.uniforms;
  u.uStage.value = s.stage;
  u.uBurst.value = s.burst;
  u.uNoise.value = s.noise;
  u.uSpin.value = s.spin;
  u.uPoint.value = s.point;
  u.uT.value = s.t;
  u.uAlpha.value = s.alpha ?? 1;
  u.uPx.value = 2015 * gl.getPixelRatio();
  return <points geometry={geo} material={mat} rotation={[s.tiltX ?? 0, s.rotY ?? 0, 0]} frustumCulled={false} />;
};

const Cam: React.FC = () => {
  const { camera } = useThree();
  const D = 540 / Math.tan((15 * Math.PI) / 180);
  camera.position.set(0, 0, D);
  camera.lookAt(0, 0, 0);
  return null;
};

export const ParticleField: React.FC<{
  th: SpecimenTheme;
  s: FieldState;
  text: { value: string; font: string };
  image: string;
  imageSize?: number;
  R?: number;
  bg?: string;
}> = ({ th, s, text, image, imageSize = 620, R = 330, bg }) => {
  const targets = useFieldTargets(text, image, imageSize);
  return (
    <ThreeCanvas resize={{ offsetSize: true, scroll: false }} width={1920} height={1080} flat camera={{ fov: 30, near: 1, far: 20000, position: [0, 0, 2015] }} style={{ position: "absolute", inset: 0 }}>
      <color attach="background" args={[bg ?? th.ink]} />
      <Cam />
      {targets && <Points th={th} s={s} targets={targets} R={R} />}
    </ThreeCanvas>
  );
};
