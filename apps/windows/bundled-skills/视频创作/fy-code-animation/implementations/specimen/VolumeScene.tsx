import React, { useLayoutEffect, useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import { ThreeCanvas } from "@remotion/three";
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { StudioEnv } from "./StudioEnv";
import { clamp01, mix, rand, type SpecimenTheme } from "./theme";

/**
 * 04 VOLUME (three.js): a voxel height field with a radial wave, then an icosahedron that rises out of it,
 * subdivides step by step, swells into a glossy clay blob and relaxes into a sphere; finally the room goes
 * dark and only a rim light remains (hand-off to the particle sphere).
 */
export type VolumeState = {
  wave: number; // wave time in frames
  drop: number; // 0..1 voxels rain into place
  sink: number; // 0..1 centre voxels sink to make room
  field: number; // 0..1 voxel field + floor visibility
  flat?: number; // 0..1 voxels settle into a flat tiled floor (under the blob)
  rise: number; // 0..1 blob rises out of the floor
  detail: number; // icosahedron subdivision level (0 = 20 faces)
  wire: number; // 0..1 edge overlay on the faceted stages
  amp: number; // clay noise displacement
  dark: number; // 0..1 room goes dark, rim light only
  cam: { ang: number; dist: number; height: number; target: [number, number, number] };
};

export const icoFaces = (detail: number) => 20 * (detail + 1) * (detail + 1);

const N = 24;
const GAP = 1.04;
export const VOXELS = N * N;

/* 3D value noise, deterministic. */
const h3 = (x: number, y: number, z: number) => rand(x * 73.1 + y * 19.7 + z * 151.3, 4);
const n3 = (x: number, y: number, z: number) => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const s = (v: number) => v * v * (3 - 2 * v);
  const u = s(x - xi);
  const v = s(y - yi);
  const w = s(z - zi);
  const L = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => h3(xi + dx, yi + dy, zi + dz);
  return (
    L(L(L(c(0, 0, 0), c(1, 0, 0), u), L(c(0, 1, 0), c(1, 1, 0), u), v), L(L(c(0, 0, 1), c(1, 0, 1), u), L(c(0, 1, 1), c(1, 1, 1), u), v), w) * 2 - 1
  );
};

const Voxels: React.FC<{ th: SpecimenTheme; s: VolumeState }> = ({ th, s }) => {
  const ref = useRef<THREE.InstancedMesh>(null);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);
  const c0 = useMemo(() => new THREE.Color(th.paper2).multiplyScalar(0.94), [th.paper2]);
  const c1 = useMemo(() => new THREE.Color(th.accent), [th.accent]);
  const c2 = useMemo(() => new THREE.Color(th.palette.find((p) => p.name === "MOSS")?.hex ?? th.accent), [th]);
  const ink = useMemo(() => new THREE.Color(th.ink), [th.ink]);
  const warm = useMemo(() => new THREE.Color(th.accent2), [th.accent2]);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    let k = 0;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const x = (i - (N - 1) / 2) * GAP;
        const z = (j - (N - 1) / 2) * GAP;
        const d = Math.hypot(x, z);
        const w = 0.5 + 0.5 * Math.sin(d * 0.72 - s.wave * 0.16);
        const id = i * N + j;
        const r = rand(id, 17);
        const fall = clamp01(s.drop * 1.5 - r * 0.5);
        const sink = clamp01(s.sink * 1.6 - d / 5) * (d < 4.2 ? 1 : 0);
        const h = mix(Math.max(0.04, (0.25 + 1.7 * w * w) * (1 - sink)), 0.08, s.flat ?? 0);
        const gone = 1 - s.field;
        const y = h / 2 + (1 - fall) * (1 - fall) * 9 - sink * 0.2 - gone * (h + 0.1);
        tmp.position.set(x, y, z);
        tmp.rotation.set((1 - fall) * (r - 0.5) * 3, (1 - fall) * r * 2, 0);
        tmp.scale.set(0.9, h, 0.9);
        tmp.updateMatrix();
        m.setMatrixAt(k, tmp.matrix);
        if (r < 0.045) col.copy(ink);
        else if (r < 0.06) col.copy(warm);
        else if (w > 0.82) col.copy(c1).lerp(c2, (w - 0.82) / 0.18);
        else col.copy(c0).lerp(c1, Math.min(1, (w * w) / 0.67));
        m.setColorAt(k, col);
        k++;
      }
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, VOXELS]} castShadow receiveShadow visible={s.field > 0.01}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial roughness={0.62} metalness={0} />
    </instancedMesh>
  );
};

const Blob: React.FC<{ th: SpecimenTheme; s: VolumeState; clay: string }> = ({ th, s, clay }) => {
  const R = 2.2;
  const faceted = s.amp <= 0 && s.detail < 8;
  const lowDetail = faceted ? Math.min(7, Math.max(0, Math.round(s.detail))) : 0;
  const lowGeo = useMemo(() => new THREE.IcosahedronGeometry(R, lowDetail), [lowDetail]);
  const edges = useMemo(() => new THREE.EdgesGeometry(lowGeo, 1), [lowGeo]);
  const smooth = useMemo(() => {
    const source = new THREE.IcosahedronGeometry(R, 40);
    const g = mergeVertices(source);
    source.dispose();
    g.computeVertexNormals();
    return { g, base: Float32Array.from(g.attributes.position.array as Float32Array) };
  }, []);
  useLayoutEffect(() => {
    if (faceted) return;
    const pos = smooth.g.attributes.position.array as Float32Array;
    const b = smooth.base;
    const t = s.wave * 0.02;
    for (let i = 0; i < pos.length; i += 3) {
      const x = b[i] / R;
      const y = b[i + 1] / R;
      const z = b[i + 2] / R;
      const n = n3(x * 1.7 + t, y * 1.7 + 3.1, z * 1.7 - t) * 0.7 + n3(x * 3.6 - t, y * 3.6, z * 3.6 + 7.7) * 0.3;
      const k = 1 + s.amp * n;
      pos[i] = b[i] * k;
      pos[i + 1] = b[i + 1] * k;
      pos[i + 2] = b[i + 2] * k;
    }
    smooth.g.attributes.position.needsUpdate = true;
    smooth.g.computeVertexNormals();
  });
  useLayoutEffect(() => () => { lowGeo.dispose(); edges.dispose(); }, [lowGeo, edges]);
  useLayoutEffect(() => () => smooth.g.dispose(), [smooth]);
  const y = mix(-2.6, R + 0.55, s.rise);
  return (
    <group position={[0, y, 0]} rotation={[0.3, s.wave * 0.012, 0]} visible={s.rise > 0.001}>
      <mesh geometry={faceted ? lowGeo : smooth.g} castShadow>
        <meshPhysicalMaterial color={clay} roughness={0.42} clearcoat={1} clearcoatRoughness={0.18} flatShading={faceted} envMapIntensity={1.4} />
      </mesh>
      {faceted && s.wire > 0.01 && (
        <lineSegments geometry={edges}>
          <lineBasicMaterial color={th.ink} transparent opacity={0.4 * s.wire} />
        </lineSegments>
      )}
    </group>
  );
};

const Rig: React.FC<{ s: VolumeState; bg: THREE.Color }> = ({ s, bg }) => {
  const { camera, scene } = useThree();
  const { ang, dist, height, target } = s.cam;
  camera.position.set(target[0] + Math.sin(ang) * dist, target[1] + height, target[2] + Math.cos(ang) * dist);
  camera.lookAt(target[0], target[1], target[2]);
  scene.background = bg;
  scene.environmentIntensity = mix(0.32, 0, s.dark);
  if (!scene.fog) scene.fog = new THREE.Fog(bg.getHex(), 34, 70);
  (scene.fog as THREE.Fog).color.copy(bg);
  return null;
};

export const VolumeScene: React.FC<{ th: SpecimenTheme; s: VolumeState; clay?: string; width?: number; height?: number }> = ({ th, s, clay, width = 1920, height = 1080 }) => {
  const bg = useMemo(() => new THREE.Color(), []);
  bg.set(th.paper2).lerp(new THREE.Color(th.ink), s.dark);
  const lit = 1 - s.dark;
  const floorCol = useMemo(() => new THREE.Color(th.paper2), [th.paper2]);
  // lights for the dark stage are placed relative to the camera: a hard side key (half-moon) and a rim from behind
  const { ang, target } = s.cam;
  const d = new THREE.Vector3(Math.sin(ang), 0, Math.cos(ang));
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), d).normalize();
  const tv = new THREE.Vector3(...target);
  const side = tv.clone().addScaledVector(right, -8).addScaledVector(d, -6).add(new THREE.Vector3(0, 3.5, 0));
  const rim = tv.clone().addScaledVector(d, -10).addScaledVector(right, 3).add(new THREE.Vector3(0, 3, 0));
  return (
    <ThreeCanvas resize={{ offsetSize: true, scroll: false }} width={width} height={height} shadows="soft" flat camera={{ fov: 32, near: 0.1, far: 200, position: [0, 20, 20] }} style={{ position: "absolute", inset: 0 }}>
      <StudioEnv />
      <Rig s={s} bg={bg} />
      <hemisphereLight args={["#ffffff", th.paper2, 0.5 * lit]} />
      <ambientLight intensity={0.06 * lit} />
      <directionalLight
        castShadow
        position={[9, 18, 7]}
        intensity={2.2 * lit + 0.03}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-16}
        shadow-camera-right={16}
        shadow-camera-top={16}
        shadow-camera-bottom={-16}
        shadow-bias={-0.0006}
        shadow-radius={6}
      />
      <directionalLight position={side.toArray()} intensity={3.2 * s.dark} color={th.cream} />
      <directionalLight position={rim.toArray()} intensity={2.4 * s.dark} color={th.accent2} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow visible={s.field > 0.01}>
        <planeGeometry args={[200, 200]} />
        <meshStandardMaterial color={floorCol} roughness={1} transparent opacity={s.field} />
      </mesh>
      <Voxels th={th} s={s} />
      <Blob th={th} s={s} clay={clay ?? th.accent} />
    </ThreeCanvas>
  );
};
